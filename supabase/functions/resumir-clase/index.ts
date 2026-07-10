// =====================================================================
// resumir-clase — edge function (proyecto sydzfwwiruxqaxojymdz).
// Convierte el DICTADO crudo del adiestrador (lo que habló por voz sobre
// una clase, en rioplatense con sus propias palabras) en un resumen
// ESCRITO, sobrio y dirigido al tutor del perro, en español de España.
// No escribe en la base: recibe el texto crudo + contexto opcional y
// devuelve { resumen }. El UPDATE de citas.resumen_cliente lo hace el
// admin desde el front. Auth: mismo verify admin que asistente-admin.
// =====================================================================

import { createClient } from '@supabase/supabase-js';

const MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 1500;
const ALLOWED_ORIGINS = ['https://perrosdelaisla.github.io', 'https://app.perrosdelaisla.es', 'http://localhost:5500'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Addendum de sistema solo para el modo "borrador desde escuchas": el material
// de origen son transcripciones de lo que el adiestrador dijo en voz alta
// durante la clase, no un dictado pensado como resumen.
const ADDENDUM_ESCUCHAS = `

MODO ESCUCHAS: el material de origen son TRANSCRIPCIONES automáticas de lo que el adiestrador dijo en voz alta durante la clase (pueden incluir instrucciones que le dio al tutor, cortes, repeticiones y muletillas). Redacta igualmente un resumen dirigido al tutor. Reglas extra para este modo:
- Ignora muletillas, titubeos, cortes y ruido irrelevante de la transcripción; quédate con lo que se trabajó y lo que hay que practicar.
- Todo lo que en la escucha sea una instrucción del adiestrador al tutor conviértelo en una PAUTA clara y accionable (por ejemplo: "practicad la llamada a diario, 5 repeticiones de 2 minutos"). Concreta repeticiones, duración y frecuencia cuando el adiestrador las haya dicho; no las inventes si no constan.`;

// Addendum adicional para el modo INCREMENTAL (flujo por rondas): hay un
// resumen ya redactado y llegan transcripciones nuevas de la siguiente ronda.
const ADDENDUM_INCREMENTAL = `

MODO INCREMENTAL: te paso un RESUMEN ACTUAL ya redactado y NUEVAS transcripciones de la siguiente ronda de la MISMA clase. Devuelve el resumen COMPLETO y actualizado como un ÚNICO texto fluido:
- Conserva el contenido del RESUMEN ACTUAL tal cual, respetando cualquier corrección o cambio de redacción que ya se haya hecho: no lo reescribas ni cambies su estilo, solo enlaza con naturalidad la parte nueva.
- Integra lo trabajado en las nuevas transcripciones en el punto que corresponda, sin repetir lo que ya estaba dicho.
- No dupliques saludos, introducciones ni cierres: una sola apertura y una sola firma final ('El equipo de Perros de la Isla').`;

const SYSTEM_PROMPT = `Eres el redactor de Perros de la Isla, empresa de adiestramiento canino en Mallorca (método cognitivo-emocional: vínculo y comunicación, no obediencia). Recibes el dictado del adiestrador, que habla en español rioplatense con sus propias palabras sobre lo trabajado en una clase. Tu tarea es convertir ese dictado en un resumen ESCRITO dirigido al tutor del perro.

Reglas obligatorias:
- Español neutro de España: tú, puedes, avísame. Nunca vos, podés, avisame.
- Vocabulario de marca: di 'valor' o 'inversión', nunca 'precio'. Di 'perro', nunca 'peludito', 'mascota' ni diminutivos. Di 'clase', no 'sesión'. Di 'tutor', no 'dueño' ni 'amo'.
- Lenguaje en posibilidad: 'puede tener dificultades en…', 'es posible que…'. Nunca diagnostiques en cerrado ('tu perro tiene ansiedad').
- Nunca nombres protocolos ni metodologías internas. Habla del trabajo, no del nombre del método.
- Habla en plural como equipo: 'hemos trabajado', 'te recomendamos'.
- Tono documental, sobrio, cálido sin ser ñoño. Sin emojis. Sin infantilizar: el tutor es un adulto con un objetivo serio.
- NO inventes nada que el adiestrador no haya dicho. Si el dictado es breve, el resumen es breve. No rellenes con frases genéricas de relleno.
- Cierra con la firma: 'El equipo de Perros de la Isla'.

Estructura orientativa (solo con lo que el dictado contenga): qué hemos trabajado hoy, cómo ha respondido el perro, qué conviene practicar en casa, y el siguiente paso. Devuelve solo el texto del resumen, sin comillas ni preámbulos.

No uses Markdown ni ningún formato: nada de asteriscos, almohadillas, guiones de separación ni viñetas. Devuelve solo texto plano en párrafos separados por saltos de línea. No incluyas una línea de título tipo 'Resumen de clase — …'; empieza directamente por el contenido.`;

function buildCors(req: Request): Record<string, string> {
  const origin = req.headers.get('Origin') ?? '';
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}

Deno.serve(async (req: Request): Promise<Response> => {
  const cors = buildCors(req);
  const json = (payload: unknown, status = 200): Response =>
    new Response(JSON.stringify(payload), { status, headers: { ...cors, 'content-type': 'application/json' } });

  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ ok: false, error: 'Método no permitido' }, 405);

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
  const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY') ?? '';
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) return json({ ok: false, error: 'Función mal configurada (Supabase)' }, 500);
  if (!ANTHROPIC_API_KEY) return json({ ok: false, error: 'Función mal configurada (Anthropic)' }, 500);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
    if (!token) return json({ ok: false, error: 'Falta autenticación' }, 401);
    const { data: userData, error: userErr } = await admin.auth.getUser(token);
    if (userErr || !userData?.user) return json({ ok: false, error: 'No autorizado' }, 401);
    const { data: adminRow, error: adminErr } = await admin
      .from('admins').select('auth_user_id').eq('auth_user_id', userData.user.id).maybeSingle();
    if (adminErr) return json({ ok: false, error: 'No se pudo verificar el rol de admin' }, 500);
    if (!adminRow) return json({ ok: false, error: 'Solo un administrador puede usar el redactor' }, 403);

    const body = await req.json().catch(() => null);
    const ctx = body?.contexto ?? {};
    const desdeEscuchas = body?.desdeEscuchas === true;

    // El mensaje de usuario y el system se arman distinto según el modo, pero
    // el resto del flujo (llamada a la IA, validación, respuesta) es común.
    let userMessage = '';
    let system = SYSTEM_PROMPT;
    // IDs de las escuchas que alimentan este borrador; el front las marca como
    // incorporadas tras generar con éxito. Vacío en el modo dictado.
    let escuchasUsadas: string[] = [];

    if (desdeEscuchas) {
      // MODO ESCUCHAS (flujo por rondas): leemos las transcripciones de la cita
      // con service role. Por defecto solo las NO incorporadas (la ronda nueva);
      // con regenerarTodo, TODAS desde cero. Si hay resumen actual, el modelo lo
      // conserva e integra la parte nueva (modo incremental).
      const citaId = String(body?.cita_id ?? '').trim();
      if (!UUID_RE.test(citaId)) return json({ ok: false, error: 'Falta la cita' }, 400);
      const regenerarTodo = body?.regenerarTodo === true;
      const resumenActual = String(body?.resumenActual ?? '').trim();

      let q = admin
        .from('escuchas_clase')
        .select('id, transcripcion, creado_en')
        .eq('cita_id', citaId).eq('estado', 'transcrita')
        .order('creado_en', { ascending: true });
      if (!regenerarTodo) q = q.eq('incorporada', false);
      const { data: escuchas, error: escErr } = await q;
      if (escErr) return json({ ok: false, error: 'No se pudieron leer las escuchas' }, 500);

      const usables = (escuchas ?? []).filter((e: any) => String(e?.transcripcion ?? '').trim());
      if (!usables.length) {
        return json({ ok: false, error: regenerarTodo
          ? 'No hay escuchas transcritas de esta clase todavía.'
          : 'No hay escuchas nuevas para incorporar (todas están ya en el resumen).' }, 400);
      }
      escuchasUsadas = usables.map((e: any) => e.id);

      const bloques = usables.map((e: any, i: number) => `Escucha ${i + 1}:\n${String(e.transcripcion).trim()}`).join('\n\n');
      // Incremental solo si NO es regenerar-todo y ya hay un resumen escrito.
      const incremental = !regenerarTodo && !!resumenActual;

      const lineas: string[] = [];
      if (incremental) {
        lineas.push(`RESUMEN ACTUAL (ya redactado, puede incluir correcciones del adiestrador; consérvalo tal cual):\n${resumenActual}`);
        lineas.push(`NUEVAS TRANSCRIPCIONES de la siguiente ronda de la clase (intégralas al resumen):\n${bloques}`);
      } else {
        lineas.push(`Transcripciones de lo que el adiestrador dijo en voz alta durante la clase (en orden):\n${bloques}`);
      }
      if (ctx?.numeroClase != null && ctx.numeroClase !== '') lineas.push(`Nº de clase: ${ctx.numeroClase}`);
      if (ctx?.modalidad) lineas.push(`Modalidad: ${ctx.modalidad}`);
      if (ctx?.nombrePerro) lineas.push(`Nombre del perro: ${ctx.nombrePerro}`);
      userMessage = lineas.join('\n');
      system = SYSTEM_PROMPT + ADDENDUM_ESCUCHAS + (incremental ? ADDENDUM_INCREMENTAL : '');
    } else {
      // MODO DICTADO (el de siempre): texto crudo hablado por el adiestrador.
      const textoCrudo = String(body?.textoCrudo ?? '').trim();
      if (!textoCrudo) return json({ ok: false, error: 'Falta el dictado' }, 400);

      const lineas: string[] = [`Dictado:\n${textoCrudo}`];
      if (ctx?.numeroClase != null && ctx.numeroClase !== '') lineas.push(`Nº de clase: ${ctx.numeroClase}`);
      if (ctx?.modalidad) lineas.push(`Modalidad: ${ctx.modalidad}`);
      if (ctx?.nombrePerro) lineas.push(`Nombre del perro: ${ctx.nombrePerro}`);
      userMessage = lineas.join('\n');
    }

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: MAX_TOKENS, system, messages: [{ role: 'user', content: userMessage }] }),
    });
    if (!claudeRes.ok) {
      const detalle = (await claudeRes.text().catch(() => '')).slice(0, 300);
      return json({ ok: false, error: `Error de la IA (${claudeRes.status})`, detalle }, 502);
    }
    const data = await claudeRes.json();
    const resumen = (Array.isArray(data?.content)
      ? data.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('')
      : '').trim();

    if (!resumen) return json({ ok: false, error: 'La IA no devolvió texto' }, 502);

    return json({ resumen, escuchas_usadas: escuchasUsadas });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return json({ ok: false, error: `Error inesperado: ${msg}` }, 500);
  }
});
