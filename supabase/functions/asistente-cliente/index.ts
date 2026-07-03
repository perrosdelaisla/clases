// =====================================================================
// asistente-cliente — edge function (proyecto sydzfwwiruxqaxojymdz).
// Chat conversacional de "Jaime" para el CLIENTE de la app Clases.
// Multi-turno: el tutor pregunta y Jaime responde en texto plano.
// Solo accede a los datos del PERRO DEL PROPIO CLIENTE (verificado por JWT).
// Guarda cada turno (mensaje del tutor + respuesta) en mensajes_jaime.
// v4: incluye 'como_se_hace' de cada ejercicio de la rutina, para que Jaime
// explique cómo se hace un ejercicio con el texto real (sin inventar).
// =====================================================================

import { createClient } from '@supabase/supabase-js';

const MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 800;
const MAX_TURNS = 12;
const ALLOWED_ORIGINS = ['https://perrosdelaisla.github.io', 'http://localhost:5500'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SYSTEM_PROMPT = `Eres Jaime, el asistente virtual de Perros de la Isla dentro de la app del tutor. Hablas en espanol de Espana, cercano y motivador, en plural editorial (somos un equipo). Tu trabajo es ayudar al tutor a usar la app y a mantener la constancia con su perro, y animarle. NO eres veterinario ni adiestrador: no diagnosticas ni das tratamientos.

PUEDES:
- Explicar como se usa CUALQUIER funcion de la app (mira la GUIA DE LA APP mas abajo): registrar un entreno (una "clase"), ver el progreso, reservar y ver clases, hacer la evaluacion de salud comportamental, marcar tareas, los mensajes, etc.
- Explicar en palabras sencillas que pide cada ejercicio de SU rutina (solo los que tiene asignados), sin tecnicismos.
- Explicar COMO SE HACE un ejercicio de su rutina usando el texto "como_se_hace" de ese ejercicio (viene en los datos de su rutina, mas abajo). Puedes resumirlo o adaptarlo a la conversacion, pero NO inventes ni agregues pasos que no esten en ese texto. Si el tutor pregunta como se hace un ejercicio y ese ejercicio NO tiene "como_se_hace" cargado (viene vacio o null), no improvises: dile con calidez que para el detalle de como hacerlo es mejor que le escriba a su adiestrador desde la pestana Mensajes.
- Contarle como viene su perro segun sus datos reales: si entrena con constancia, cuando fue su ultimo entreno, si va al dia con las metas de la semana. Animale con eso.
- Recordarle que puede escribir a su adiestrador desde la pestana Mensajes para cualquier duda concreta.

NUNCA:
- Diagnosticar ni decir que el perro "tiene" o "sufre" algo. Hablas en posibilidad y derivas.
- Nombrar protocolos, metodologias ni marcas de formacion.
- Dar consejos de conducta, adiestramiento clinico o de salud que correspondan al criterio del adiestrador.
- Inventar o recomendar ejercicios que no esten en SU rutina asignada, ni inventar funciones de la app que no esten en la guia, ni inventar pasos de como se hace un ejercicio que no esten en su "como_se_hace".
- Contradecir a su adiestrador.
- Hablar de precios, pagos ni temas medicos.

Si te preguntan algo fuera de lo que puedes (un problema de conducta, de salud, una decision sobre el plan, algo del caso): NO improvises. Responde con calidez y deriva: "Eso mejor lo ves con tu adiestrador; escribele desde la pestana Mensajes y te ayudara."

GUIA DE LA APP (conoces todas sus funciones; explicalas con estos pasos, sin inventar funciones que no esten aqui):
La app tiene una barra inferior con cinco secciones:
- Rutina (inicio): la rutina del perro. Arriba estan su foto y el anillo de cumplimiento de la semana (la constancia). Debajo, los ejercicios, tareas y herramientas por categoria. Aqui el tutor registra cada clase: entra al ejercicio y reporta lo que hizo (repeticiones, tiempo o pasos, segun el ejercicio) y como estuvo el perro. En el inicio tambien esta la tarjeta "Evalua la salud comportamental".
- Reservar: un calendario para reservar la proxima clase; el tutor elige el dia y el horario.
- Mis citas: las clases que ya tiene reservadas.
- Salud Comportamental: la evaluacion de salud comportamental del perro; ahi ve sus evaluaciones, los scores, el historico y material recomendado.
- Mensajes: para escribirle al adiestrador (se puede dictar por voz).

COMO HACER LA EVALUACION DE SALUD COMPORTAMENTAL: desde el inicio, tocar la tarjeta "Evalua la salud comportamental de [perro]"; o ir a la seccion "Salud Comportamental" en la barra de abajo y tocar "Iniciar evaluacion" (o "Nueva evaluacion" si ya hizo alguna). Se abre la herramienta de evaluacion, lleva unos 5 minutos y los resultados nos ayudan a ajustar la rutina.

DENTRO DE RUTINA:
- Ejercicios: cada uno tiene una meta semanal; el tutor lo registra cada vez que lo practica y el anillo muestra como va la semana.
- Tareas: habitos del dia a dia; el tutor marca cuantos dias de la semana la uso (los numeros del 0 al 7).
- Herramientas: cosas que el tutor confirma que ya tiene.
- Algunos ejercicios tienen progresiones (pasos); los pasos anteriores se ven en un carrusel.
- El tutor puede subir un video corto de un entreno para que el adiestrador lo vea.

Si te preguntan como hacer algo de la app, explica los pasos con estas palabras. Si no sabes un detalle puntual, di que pueden escribir al adiestrador desde Mensajes.

Vocabulario obligatorio: "clase" (nunca "sesion"), "tutor", "perro" (nunca "peludito"). No hablas de precios.

Responde SIEMPRE en texto plano, breve y claro (2-5 frases normalmente), sin markdown ni listas largas. Usa el nombre del perro cuando ayude. Si el tutor solo saluda, presentate en una frase y ofrece ayuda con la app o con la rutina.

A continuacion van los DATOS reales de este perro y su actividad reciente. Usalos solo para informar y motivar, nunca para diagnosticar.`;

function buildCors(req: Request): Record<string, string> {
  const origin = req.headers.get('Origin') ?? '';
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}

function fmtSeg(s: number | null): string | null {
  if (s == null) return null;
  const m = Math.floor(s / 60), ss = s % 60;
  return `${m}:${String(ss).padStart(2, '0')}`;
}

Deno.serve(async (req: Request): Promise<Response> => {
  const cors = buildCors(req);
  const json = (payload: unknown, status = 200): Response =>
    new Response(JSON.stringify(payload), { status, headers: { ...cors, 'content-type': 'application/json' } });

  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ ok: false, error: 'Metodo no permitido' }, 405);

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
  const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY') ?? '';
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) return json({ ok: false, error: 'Funcion mal configurada (Supabase)' }, 500);
  if (!ANTHROPIC_API_KEY) return json({ ok: false, error: 'Funcion mal configurada (Anthropic)' }, 500);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    // --- Auth: el que llama tiene que ser un usuario_cliente valido ---
    const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
    if (!token) return json({ ok: false, error: 'Falta autenticacion' }, 401);
    const { data: userData, error: userErr } = await admin.auth.getUser(token);
    if (userErr || !userData?.user) return json({ ok: false, error: 'No autorizado' }, 401);

    const { data: uc } = await admin
      .from('usuarios_cliente').select('cliente_id, nombre').eq('auth_user_id', userData.user.id).maybeSingle();
    if (!uc?.cliente_id) return json({ ok: false, error: 'Solo un cliente puede usar el asistente' }, 403);

    const body = await req.json().catch(() => null);
    const perroId = String(body?.perro_id ?? '').trim();
    if (!UUID_RE.test(perroId)) return json({ ok: false, error: 'Falta el perro' }, 400);

    // --- El perro tiene que ser de ESTE cliente ---
    const { data: perro } = await admin
      .from('perros').select('nombre, raza, edad, cliente_id').eq('id', perroId).maybeSingle();
    if (!perro || perro.cliente_id !== uc.cliente_id) {
      return json({ ok: false, error: 'Perro no encontrado' }, 404);
    }

    // --- Conversacion ---
    const rawMsgs = Array.isArray(body?.mensajes) ? body.mensajes : [];
    const mensajes = rawMsgs
      .filter((m: any) => (m?.role === 'user' || m?.role === 'assistant') && typeof m?.content === 'string' && m.content.trim())
      .slice(-MAX_TURNS)
      .map((m: any) => ({ role: m.role, content: String(m.content).slice(0, 2000) }));
    if (!mensajes.length || mensajes[mensajes.length - 1].role !== 'user') {
      return json({ ok: false, error: 'Falta el mensaje del tutor' }, 400);
    }

    // --- Contexto real del perro (solo su rutina y actividad) ---
    const { data: asignados } = await admin
      .from('ejercicios_asignados')
      .select('min_semanal, objetivo_seg, objetivo_distancia, reps_sugeridas_min, reps_sugeridas_max, ejercicios:ejercicio_id(nombre, categoria, como_se_hace)')
      .eq('perro_id', perroId).eq('activo', true);

    const { data: regs } = await admin
      .from('registros_ejercicio')
      .select('registrado_en, ejercicios_asignados!inner(perro_id, ejercicios:ejercicio_id(nombre))')
      .eq('ejercicios_asignados.perro_id', perroId)
      .gte('registrado_en', new Date(Date.now() - 14 * 86400000).toISOString())
      .order('registrado_en', { ascending: false });

    const ahora = Date.now();
    let ultimoEntreno: string | null = null;
    const conteo7d = new Map<string, number>();
    for (const r of (regs ?? [])) {
      const t = new Date(r.registrado_en).getTime();
      if (ultimoEntreno === null) ultimoEntreno = r.registrado_en;
      if (ahora - t <= 7 * 86400000) {
        const ea: any = r.ejercicios_asignados;
        const ej = Array.isArray(ea) ? ea[0]?.ejercicios : ea?.ejercicios;
        const nom = (Array.isArray(ej) ? ej[0]?.nombre : ej?.nombre) ?? '';
        if (nom) conteo7d.set(nom, (conteo7d.get(nom) ?? 0) + 1);
      }
    }
    const diasSinEntrenar = ultimoEntreno == null ? null : Math.floor((ahora - new Date(ultimoEntreno).getTime()) / 86400000);

    const rutina = (asignados ?? []).map((a: any) => {
      const ej = Array.isArray(a.ejercicios) ? a.ejercicios[0] : a.ejercicios;
      const nombre = ej?.nombre ?? '';
      return {
        ejercicio: nombre,
        categoria: ej?.categoria ?? '',
        como_se_hace: (ej?.como_se_hace ?? '').toString().trim() || null,
        veces_por_semana_minimo: a.min_semanal ?? null,
        hechos_ultimos_7_dias: conteo7d.get(nombre) ?? 0,
        objetivo_tiempo: fmtSeg(a.objetivo_seg ?? null),
        objetivo_pasos: a.objetivo_distancia ?? null,
        repeticiones_sugeridas: a.reps_sugeridas_min == null ? null
          : (a.reps_sugeridas_max && a.reps_sugeridas_max !== a.reps_sugeridas_min
              ? `${a.reps_sugeridas_min}-${a.reps_sugeridas_max}` : `${a.reps_sugeridas_min}`),
      };
    });

    const contexto = {
      perro: { nombre: perro.nombre, raza: perro.raza ?? null, edad: perro.edad ?? null },
      tutor: uc.nombre ?? null,
      actividad: {
        ultimo_entreno: ultimoEntreno,
        dias_desde_ultimo_entreno: diasSinEntrenar,
        nunca_entreno: ultimoEntreno == null,
      },
      rutina_asignada: rutina,
      nota: 'hechos_ultimos_7_dias vs veces_por_semana_minimo indica si va al dia con cada ejercicio esta semana. como_se_hace es el instructivo de ese ejercicio (como realizarlo): usalo textualmente si el tutor pregunta como se hace; si es null, no inventes y deriva a Mensajes.',
    };

    const system = `${SYSTEM_PROMPT}\n\nDATOS DEL PERRO Y SU ACTIVIDAD (JSON):\n${JSON.stringify(contexto)}`;

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: MAX_TOKENS, system, messages: mensajes }),
    });
    if (!claudeRes.ok) {
      const detalle = (await claudeRes.text().catch(() => '')).slice(0, 300);
      return json({ ok: false, error: `Error de la IA (${claudeRes.status})`, detalle }, 502);
    }
    const data = await claudeRes.json();
    const reply = Array.isArray(data?.content)
      ? data.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('').trim()
      : '';
    if (!reply) return json({ ok: false, error: 'La IA no devolvio texto' }, 502);

    // --- Persistir el turno (ultimo mensaje del tutor + respuesta de Jaime).
    //     El guardado NUNCA debe romper la respuesta al cliente.
    try {
      const ultimoUser = mensajes[mensajes.length - 1]?.content ?? '';
      const filas: Array<{ perro_id: string; rol: string; contenido: string }> = [];
      if (ultimoUser) filas.push({ perro_id: perroId, rol: 'user', contenido: ultimoUser });
      filas.push({ perro_id: perroId, rol: 'assistant', contenido: reply });
      await admin.from('mensajes_jaime').insert(filas);
    } catch (_e) { /* noop: no romper por un fallo de guardado */ }

    return json({ ok: true, reply });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return json({ ok: false, error: `Error inesperado: ${msg}` }, 500);
  }
});
