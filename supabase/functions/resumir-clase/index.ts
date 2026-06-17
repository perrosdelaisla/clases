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
const ALLOWED_ORIGINS = ['https://perrosdelaisla.github.io', 'http://localhost:5500'];

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

Estructura orientativa (solo con lo que el dictado contenga): qué hemos trabajado hoy, cómo ha respondido el perro, qué conviene practicar en casa, y el siguiente paso. Devuelve solo el texto del resumen, sin comillas ni preámbulos.`;

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
    const textoCrudo = String(body?.textoCrudo ?? '').trim();
    if (!textoCrudo) return json({ ok: false, error: 'Falta el dictado' }, 400);

    const ctx = body?.contexto ?? {};
    const lineas: string[] = [`Dictado:\n${textoCrudo}`];
    if (ctx?.numeroClase != null && ctx.numeroClase !== '') lineas.push(`Nº de clase: ${ctx.numeroClase}`);
    if (ctx?.modalidad) lineas.push(`Modalidad: ${ctx.modalidad}`);
    if (ctx?.nombrePerro) lineas.push(`Nombre del perro: ${ctx.nombrePerro}`);
    const userMessage = lineas.join('\n');

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: MAX_TOKENS, system: SYSTEM_PROMPT, messages: [{ role: 'user', content: userMessage }] }),
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

    return json({ resumen });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return json({ ok: false, error: `Error inesperado: ${msg}` }, 500);
  }
});
