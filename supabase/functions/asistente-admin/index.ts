// =====================================================================
// asistente-admin — edge function (proyecto sydzfwwiruxqaxojymdz).
// Cerebro del asistente interno del admin de Clases.
// Verifica que quien llama sea admin (patrón copiado de invitar-cliente),
// lee el contexto completo de un perro (datos, histórico SC, ejercicios
// asignados, cumplimiento) y el catálogo, y devuelve sugerencias elegidas
// SOLO del catálogo. NO escribe nada: solo lee y sugiere. El "Asignar"
// lo hace el admin con confirmación del usuario, fuera de esta función.
// =====================================================================

import { createClient } from '@supabase/supabase-js';

const MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 1500;
const ALLOWED_ORIGINS = ['https://perrosdelaisla.github.io', 'http://localhost:5500'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SYSTEM_PROMPT = `Sos el asistente interno de Charly, adiestrador de Perros de la Isla, dentro de su panel de administración. Le hablás SOLO a él, en español rioplatense informal (vos, tenés, mirá). Nunca te ve un cliente.

En cada consulta recibís el contexto de UN perro:
- Datos del perro (nombre, raza, edad, peso) y estado del cliente.
- Su HISTÓRICO de evaluaciones de Salud Comportamental, ordenado de la más antigua a la más reciente. Cada una tiene scores de 0 a 100 en cuatro dimensiones (física, emocional, social, cognitiva), score total y si tiene bandera roja.
- Los ejercicios que ya tiene asignados.
- Su cumplimiento reciente (sesiones de práctica registradas por el cliente).
- El CATÁLOGO COMPLETO de ejercicios disponibles, cada uno con código, nombre, categoría y descripción.

Tu trabajo, cruzando TODOS esos datos antes de responder:
1. Resumir el caso en 3 líneas para que Charly no tenga que reconstruirlo.
2. Leer la evaluación: señalar la dimensión más baja y, si hay bandera roja, marcarla. Si hay 2 o más evaluaciones, comentá cómo evolucionó cada dimensión entre la primera y la última (mejoró, empeoró, se mantuvo). Si hay una sola, decílo y trabajá con esa, sin inventar evolución.
3. Sugerir 2 o 3 ejercicios para trabajar, priorizando la dimensión más baja y teniendo en cuenta lo que ya tiene asignado y si viene cumpliendo.

REGLAS QUE NUNCA ROMPÉS:
- Solo sugerís ejercicios que estén en el CATÁLOGO que te paso, referenciados por su código EXACTO. JAMÁS inventás un ejercicio que no esté en la lista. Si el catálogo no tiene nada bueno para una dimensión, lo decís en vez de forzar.
- No sugerís algo que el perro ya tiene asignado.
- Hablás en posibilidad, nunca diagnosticás: "podría ayudar con", "parece que", nunca "el perro tiene" o "sufre de".
- No nombrás protocolos ni metodologías de formación. Hablás del trabajo, no de etiquetas.
- El criterio final es de Charly. Vos proponés, él decide.

Respondés SIEMPRE y SOLO con este JSON, sin texto antes ni después, sin markdown:
{
  "estado_caso": "string, máximo 3 frases",
  "lectura_sc": "string, 1-3 frases sobre la dimensión baja, la bandera y la evolución si la hay",
  "sugerencias": [
    { "codigo": "código exacto del catálogo", "por_que": "una línea, en argentino" }
  ]
}`;

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
    // 1 — Verificar que quien llama es admin (patrón de invitar-cliente).
    const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
    if (!token) return json({ ok: false, error: 'Falta autenticación' }, 401);
    const { data: userData, error: userErr } = await admin.auth.getUser(token);
    if (userErr || !userData?.user) return json({ ok: false, error: 'No autorizado' }, 401);
    const { data: adminRow, error: adminErr } = await admin
      .from('admins').select('auth_user_id').eq('auth_user_id', userData.user.id).maybeSingle();
    if (adminErr) return json({ ok: false, error: 'No se pudo verificar el rol de admin' }, 500);
    if (!adminRow) return json({ ok: false, error: 'Solo un administrador puede usar el asistente' }, 403);

    // 2 — Body.
    const body = await req.json().catch(() => null);
    const perroId = String(body?.perro_id ?? '').trim();
    const clienteId = String(body?.cliente_id ?? '').trim();
    if (!UUID_RE.test(perroId)) return json({ ok: false, error: 'Falta el perro' }, 400);

    // 3 — Leer contexto (solo lectura).
    const { data: perro } = await admin
      .from('perros').select('nombre, raza, edad_meses, peso_kg').eq('id', perroId).maybeSingle();
    if (!perro) return json({ ok: false, error: 'Perro no encontrado' }, 404);

    let cliente: { nombre?: string; estado?: string } | null = null;
    if (UUID_RE.test(clienteId)) {
      const { data } = await admin.from('clientes').select('nombre, estado').eq('id', clienteId).maybeSingle();
      cliente = data;
    }

    const { data: evals } = await admin
      .from('evaluaciones_isla')
      .select('score_fisica, score_emocional, score_social, score_cognitiva, score_total, bandera_roja, created_at')
      .eq('perro_id', perroId).order('created_at', { ascending: true });

    const { data: asignados } = await admin
      .from('ejercicios_asignados')
      .select('ejercicios:ejercicio_id(codigo, nombre)')
      .eq('perro_id', perroId).eq('activo', true);

    const { data: practicas } = await admin
      .from('practicas_rutina')
      .select('iniciada_en, cerrada_en, estado_emocional_final, nota_cierre')
      .eq('perro_id', perroId).order('iniciada_en', { ascending: false }).limit(10);

    const { data: catalogo } = await admin
      .from('ejercicios')
      .select('codigo, nombre, categoria, descripcion')
      .eq('activo', true).order('orden_catalogo', { ascending: true });

    // 4 — Armar el contexto para el modelo.
    const contexto = [
      'PERRO:', JSON.stringify(perro),
      'CLIENTE:', JSON.stringify(cliente ?? { estado: 'desconocido' }),
      'HISTÓRICO SC (antigua → reciente):', JSON.stringify(evals ?? []),
      'YA ASIGNADOS:', JSON.stringify((asignados ?? []).map((a: any) => a.ejercicios)),
      'CUMPLIMIENTO (últimas prácticas):', JSON.stringify(practicas ?? []),
      'CATÁLOGO DISPONIBLE:', JSON.stringify(catalogo ?? []),
    ].join('\n');

    // 5 — Llamar a Claude.
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: MAX_TOKENS, system: SYSTEM_PROMPT, messages: [{ role: 'user', content: contexto }] }),
    });
    if (!claudeRes.ok) {
      const detalle = (await claudeRes.text().catch(() => '')).slice(0, 300);
      return json({ ok: false, error: `Error de la IA (${claudeRes.status})`, detalle }, 502);
    }
    const data = await claudeRes.json();
    const reply = Array.isArray(data?.content)
      ? data.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('')
      : '';

    // 6 — Parsear JSON robusto.
    let parsed: unknown;
    try {
      parsed = JSON.parse(reply.replace(/```json|```/g, '').trim());
    } catch {
      return json({ ok: false, error: 'La IA no devolvió JSON válido', raw: reply.slice(0, 500) }, 502);
    }

    return json({ ok: true, sugerencia: parsed });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return json({ ok: false, error: `Error inesperado: ${msg}` }, 500);
  }
});
