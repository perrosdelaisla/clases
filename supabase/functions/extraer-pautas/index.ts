// =====================================================================
// extraer-pautas — edge function (proyecto sydzfwwiruxqaxojymdz).
//
// Charly dicta las pautas en voz alta durante la clase: "objetivo de cuatro
// pasos", "la comida a diez centímetros de la nariz", "con salchichas",
// "tres veces por semana". Hasta ahora eso había que volver a cargarlo a
// mano en la ficha de cada ejercicio. Esta función lo baja solo.
//
// Y antes de poner pautas nuevas repasa cómo fue la semana. Eso también se
// dice en voz alta, así que también se registra: `revisiones_ejercicio`
// guarda, clase a clase, cuál era el objetivo y hasta dónde llegaron.
//
// REGLA DE SEGURIDAD (decidida con Charly el 19/09/2026):
//   - Lo que sale de un tramo LIMPIO se aplica solo.
//   - Lo dudoso NO se aplica: queda señalado junto al resumen, en la
//     revisión que él ya hace en cada clase.
// La transcripción es ruidosa (ASR sobre una clase al aire libre), así que
// todo lo que el modelo propone pasa además por un filtro del servidor:
//   1. el ejercicio tiene que ser uno REAL de la rutina de ese perro,
//   2. el valor tiene que caer dentro del rango de su columna,
//   3. la frase citada tiene que existir DE VERDAD en la transcripción,
//   4. y en la revisión, los números no pueden contradecir al veredicto.
// Cualquiera de las cuatro que falle degrada la entrada a 'dudosa'.
//
// CÓMO SE DISPARA: desde el admin (botón de generar borrador) con el JWT de
// Charly, o sola — el cron lanzar-pautas barre cada 5 minutos las escuchas
// transcritas que aún no pasaron por aquí y llama con un token de un uso.
//
// Nunca borra nada: si una pauta no se entiende, el campo se queda como
// estaba. Todo lo propuesto queda registrado en `pautas_extraidas`.
// =====================================================================

import { createClient } from '@supabase/supabase-js';

const MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 4000;
const ALLOWED_ORIGINS = ['https://perrosdelaisla.github.io', 'https://app.perrosdelaisla.es', 'http://localhost:5500'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RANKING_CODIGO = 'RANKING_DE_COMIDAS';

// Rango admitido por cada campo. Coincide con los CHECK de la tabla: si algo
// se sale de aquí, el UPDATE fallaría, así que lo paramos antes.
const RANGOS: Record<string, { min: number; max: number; entero: boolean }> = {
  objetivo_seg: { min: 1, max: 3600, entero: true },
  objetivo_distancia: { min: 1, max: 200, entero: true },
  dificultad: { min: 1, max: 5, entero: true },
  reps_sugeridas_min: { min: 1, max: 99, entero: true },
  reps_sugeridas_max: { min: 1, max: 99, entero: true },
  min_semanal: { min: 0, max: 21, entero: true },
  max_diario: { min: 0, max: 20, entero: true },
};
const CAMPOS_TEXTO = new Set(['valor_comida', 'nota_cliente']);
const NOTA_MAX = 240;
// Lo que se puede medir en la revisión de la semana. Menos que RANGOS: de la
// comida o la dificultad no tiene sentido decir "llegó" o "no llegó".
const CAMPOS_REVISION = new Set(['objetivo_seg', 'objetivo_distancia', 'reps_sugeridas_min', 'min_semanal']);
const LOGROS = new Set(['conseguido', 'parcial', 'no_llego', 'no_practicado', 'sin_dato']);

// ───────────────────────────────────────────────────────────
// Utilidades de texto
// ───────────────────────────────────────────────────────────

// Normaliza para comparar: sin tildes, sin puntuación, minúsculas, espacios
// colapsados. Se usa tanto para verificar la cita textual como para casar el
// nombre de la comida con el ranking del perro.
function norm(t: string): string {
  return String(t ?? '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Verifica que la frase citada existe de verdad en alguna transcripción.
// Es la red anti-invención: si el modelo se inventa la pauta, no puede
// inventar también un tramo que esté literalmente en el audio. Quitamos la
// marca de tiempo del principio y pedimos al menos 12 caracteres útiles.
function citaExiste(cita: string, transcripcionesNorm: string[]): boolean {
  const limpia = String(cita ?? '').replace(/\[\d{1,2}:\d{2}(:\d{2})?\]/g, ' ');
  const n = norm(limpia);
  if (n.length < 12) return false;
  return transcripcionesNorm.some((t) => t.includes(n));
}

function intOrNull(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
}

// ───────────────────────────────────────────────────────────
// Prompt
// ───────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `Eres el ayudante de un adiestrador canino (Perros de la Isla, Mallorca). Recibes la TRANSCRIPCIÓN automática de lo que el adiestrador dijo en voz alta durante una clase, y la lista de ejercicios que ese perro tiene asignados ahora mismo.

Tu única tarea es detectar las PAUTAS CONCRETAS que el adiestrador dio para esos ejercicios y devolverlas en JSON. No resumes la clase, no opinas, no propones nada que él no haya dicho.

MATERIAL DIFÍCIL: la transcripción es automática, hecha al aire libre, con dos personas hablando y un perro de por medio. Tiene errores, cortes, palabras mal reconocidas y frases sin sentido. Ante la duda, marca la pauta como dudosa. Es mucho peor colar un dato falso en la ficha de un cliente que dejar una pauta sin detectar: el adiestrador revisa lo dudoso en dos segundos, pero un dato falso no lo ve nadie.

CAMPOS QUE PUEDES DEVOLVER (ninguno más):
- objetivo_seg: duración objetivo, EN SEGUNDOS. "dos minutos" = 120.
- objetivo_distancia: distancia objetivo, EN PASOS. Si la dice en metros o centímetros y NO en pasos, no uses este campo: ponlo en la nota.
- dificultad: 1 a 5, solo si dice explícitamente un nivel de dificultad.
- reps_sugeridas_min / reps_sugeridas_max: repeticiones. "cinco repeticiones" = min 5. "entre cinco y diez" = min 5, max 10.
- min_semanal: cuántos días por semana hay que entrenarlo. "a diario" = 7. "tres veces por semana" = 3.
- max_diario: tope de veces al día, solo si pone un tope explícito.
- valor_comida: la comida con la que hay que hacer ESE ejercicio. En valor_texto va el NOMBRE tal como él lo dice (salchicha, chuches, pienso, jamón, queso, paté). Si en vez del nombre dice un nivel del ranking ("el nivel uno en comidas", "ponle la dos"), deja valor_texto en null y pon ese número en valor_num. Nunca inventes una comida que no nombró.
- nota_cliente: UNA frase corta (máximo 200 caracteres) con lo que el tutor necesita saber para hacer ese ejercicio en casa: la parte práctica que él explicó y que no cabe en los campos de arriba (por ejemplo la distancia en centímetros, la posición de la mano, qué hacer si el perro se adelanta). Dirigida al tutor, en español de España, de tú. Sin saludos, sin firma, sin "recuerda que". No la inventes: si él no explicó nada práctico de ese ejercicio, no devuelvas nota.

CUÁNDO ES confianza "alta" (se aplicará sola, sin que nadie la mire):
Las cuatro cosas a la vez:
1. El ejercicio está identificado sin ninguna duda: él lo nombra y solo encaja con UNO de la lista.
2. El valor está DICHO, no deducido. "objetivo de cuatro pasos" es dicho. "parece que va por cuatro pasos" no.
3. El tramo se entiende bien: la frase está completa y tiene sentido, no es un trozo roto ni una palabra suelta.
4. No hay ninguna otra frase en la clase que diga otra cosa distinta sobre ese mismo campo y ejercicio.
Si falla cualquiera de las cuatro, confianza "dudosa" y explica en motivo_duda, en una línea, qué es lo que no está claro.

TRAMPAS REALES DE ESTAS CLASES (comprobadas sobre sus transcripciones; en todas ellas NO hay pauta que aplicar):
- "el no en tres pasos" / "en tres pasos": es el nombre de una técnica, los pasos de un procedimiento. NO es una distancia. Nunca lo conviertas en objetivo_distancia.
- "refuerzos cada 10 segundos", "le das cada 15 segundos": eso es cada cuánto premia, no la duración objetivo del ejercicio. No es objetivo_seg: si acaso va en la nota.
- Lo que MIDIÓ en clase no es una pauta: "hoy estuvo sentado 15 segundos", "aguanta unos 4 o 5 segundos" describen lo que pasó. Solo cuenta el valor que él marca como objetivo para casa: "el objetivo es…", "para la próxima…", "vamos a poner…", "tiene que llegar a…". (Esas cifras de lo que pasó sí valen para la revisión de abajo.)
- Cuando describe una progresión ("subiendo de a 30 segundos hasta 3 minutos"), el objetivo es la cifra FINAL; la progresión va en la nota.
- Listas de comidas como ideas o ejemplos ("rellena el Kong con paté, chuches o queso", "pienso contra chuches, después chuches contra salchichas") no son la comida de un ejercicio: son opciones o el ranking. No devuelvas valor_comida por ellas.
- Si en la misma frase se corrige o duda ("cuatro pasos, tres, cuatro"), confianza "dudosa".

Si el perro es uno de varios de la misma casa, y la clase no deja claro para cuál es la pauta, confianza "dudosa" siempre.

cita_textual: copia LITERAL del tramo de la transcripción donde él lo dice, con su marca de tiempo si la tiene. Cópiala tal cual aparece, sin arreglar las palabras. Es lo que le permite volver al audio. Una pauta sin cita literal exacta se descarta.

SEGUNDA TAREA — LA REVISIÓN DE LA SEMANA:
Antes de poner pautas nuevas, el adiestrador repasa en voz alta cómo fue cada ejercicio de la semana ("el espera se quedó en cuatro segundos", "la permanencia la clavó", "esto no lo habéis practicado"). Devuelve también ese repaso, una entrada por ejercicio repasado. Reglas:
- "logro" es el veredicto que da ÉL, con sus palabras, nunca tu cálculo: "conseguido" | "parcial" | "no_llego" | "no_practicado" | "sin_dato" (usa sin_dato cuando comenta el ejercicio pero no dice si llegó).
- "alcanzado": solo si dice una cifra concreta de hasta dónde llegaron, en la misma unidad que "campo" (segundos, pasos, repeticiones). Si no da cifra, null.
- "campo": qué se estaba midiendo — "objetivo_seg", "objetivo_distancia", "reps_sugeridas_min" o "min_semanal". Si el repaso es solo de palabra, sin números, deja campo y alcanzado en null.
- "objetivo_anterior": el objetivo que él recuerda que tenían. Puede ir en null; el servidor ya lo sabe y solo lo usa para comprobarte.
- "comentario": UNA frase corta, dirigida al tutor, de tú, en español de España, contando qué pasó con ese ejercicio. Sin juicio, sin reproche, sin felicitar de más: el hecho. La va a leer el tutor.
- Si un ejercicio no se repasa en esta clase, NO devuelvas entrada. Mejor ninguna que inventada.
- La misma exigencia de confianza y la misma cita literal que en las pautas.

Responde SOLO con un objeto JSON, sin texto alrededor y sin markdown, con los dos arrays y las revisiones primero:
{"revisiones":[{"ref":"E2","campo":"objetivo_seg","objetivo_anterior":10,"alcanzado":4,"logro":"no_llego","comentario":"El espera se ha quedado en cuatro segundos.","cita_textual":"[00:03:12] el espera se quedó en cuatro segundos, no llegamos a los diez","confianza":"alta","motivo_duda":null}],"pautas":[{"ref":"E3","campo":"objetivo_distancia","valor_num":4,"valor_texto":null,"cita_textual":"[00:12:31] vamos a ponerle objetivo de cuatro pasos","confianza":"alta","motivo_duda":null}]}
Para campos de texto (valor_comida, nota_cliente) usa valor_texto y deja valor_num en null. Si no detectas nada, devuelve los arrays vacíos.`;

// ───────────────────────────────────────────────────────────

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
    const body = await req.json().catch(() => null);
    const citaId = String(body?.cita_id ?? '').trim();
    if (!UUID_RE.test(citaId)) return json({ ok: false, error: 'Falta la cita' }, 400);
    // dryRun: calcula y devuelve, pero NO escribe nada (ni pautas ni marcas).
    const dryRun = body?.dryRun === true;
    // reprocesar: vuelve a mirar TODAS las escuchas de la cita, no solo las
    // que aún no pasaron por aquí.
    const reprocesar = body?.reprocesar === true;

    // ── Auth: el admin desde la app, o el cron con un token de un solo uso ──
    // El barrido lanzar_pautas_pendientes() guarda un token por cita en
    // pautas_auto_cola y lo manda en x-pautas-token. Aquí se canjea: la RPC
    // devuelve la cita a la que pertenece y lo invalida en el mismo golpe, así
    // que no vale para una segunda llamada ni para otra clase.
    const tokenInterno = (req.headers.get('x-pautas-token') ?? '').trim();
    let esInterna = false;
    if (tokenInterno) {
      const { data: citaDelToken, error: tokErr } = await admin.rpc('consumir_token_pautas', { p_token: tokenInterno });
      if (!tokErr && citaDelToken && String(citaDelToken) === citaId) esInterna = true;
    }

    if (!esInterna) {
      // ── Auth: solo admin (mismo patrón que resumir-clase) ──
      const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
      if (!token) return json({ ok: false, error: 'Falta autenticación' }, 401);
      const { data: userData, error: userErr } = await admin.auth.getUser(token);
      if (userErr || !userData?.user) return json({ ok: false, error: 'No autorizado' }, 401);
      const { data: adminRow, error: adminErr } = await admin
        .from('admins').select('auth_user_id').eq('auth_user_id', userData.user.id).maybeSingle();
      if (adminErr) return json({ ok: false, error: 'No se pudo verificar el rol de admin' }, 500);
      if (!adminRow) return json({ ok: false, error: 'Solo un administrador puede extraer pautas' }, 403);
    }

    // ── Cita y perros de la casa ──
    const { data: cita, error: citaErr } = await admin
      .from('citas').select('id, cliente_id, numero_clase, modalidad, fecha').eq('id', citaId).maybeSingle();
    if (citaErr || !cita) return json({ ok: false, error: 'No se encontró la cita' }, 404);

    const { data: perros, error: perrosErr } = await admin
      .from('perros').select('id, nombre').eq('cliente_id', cita.cliente_id);
    if (perrosErr) return json({ ok: false, error: 'No se pudieron leer los perros' }, 500);
    if (!perros?.length) return json({ ok: false, error: 'Este cliente no tiene ningún perro dado de alta.' }, 400);
    const variosPerros = perros.length > 1;
    const perroNombre = new Map<string, string>(perros.map((p: any) => [p.id, p.nombre]));

    // ── Rutina activa de esos perros ──
    const perroIds = perros.map((p: any) => p.id);
    const { data: asignados, error: asigErr } = await admin
      .from('ejercicios_asignados')
      .select('id, perro_id, parametros, valor_comida, valor_comida_nombre, dificultad, objetivo_seg, objetivo_distancia, reps_sugeridas_min, reps_sugeridas_max, min_semanal, max_diario, nota_cliente, ejercicios (codigo, nombre, categoria)')
      .in('perro_id', perroIds).eq('activo', true)
      .order('posicion_rutina', { ascending: true });
    if (asigErr) return json({ ok: false, error: 'No se pudo leer la rutina' }, 500);
    const filas = (asignados ?? []) as any[];
    if (!filas.length) {
      return json({ ok: false, error: 'Este perro no tiene ejercicios asignados todavía, así que no hay dónde bajar las pautas.' }, 400);
    }

    // Ranking de comidas por perro: la lista ordenada de menos a más apetitosa
    // que hizo el tutor. La posición en esa lista ES el valor_comida (1-5).
    const rankingPorPerro = new Map<string, string[]>();
    for (const f of filas) {
      if (f?.ejercicios?.codigo !== RANKING_CODIGO) continue;
      const items = Array.isArray(f?.parametros?.items) ? f.parametros.items : [];
      const limpios = items.map((s: any) => String(s ?? '').trim()).filter(Boolean);
      if (limpios.length) rankingPorPerro.set(f.perro_id, limpios);
    }

    // ── Escuchas de esta clase ──
    let q = admin.from('escuchas_clase')
      .select('id, transcripcion, creado_en')
      .eq('cita_id', citaId).eq('estado', 'transcrita')
      .order('creado_en', { ascending: true });
    if (!reprocesar) q = q.is('pautas_en', null);
    const { data: escuchas, error: escErr } = await q;
    if (escErr) return json({ ok: false, error: 'No se pudieron leer las escuchas' }, 500);

    const usables = (escuchas ?? []).filter((e: any) => String(e?.transcripcion ?? '').trim());
    if (!usables.length) {
      return json({ ok: false, error: reprocesar
        ? 'No hay escuchas transcritas de esta clase.'
        : 'No hay escuchas nuevas: las pautas de todas ya se miraron.' }, 400);
    }
    const escuchaIds = usables.map((e: any) => e.id);
    const transcripcionesNorm = usables.map((e: any) => norm(String(e.transcripcion)));

    // ── Catálogo que ve el modelo: refs cortas, nunca UUIDs ──
    // Le damos E1, E2… y el mapeo lo resolvemos aquí. Así no puede apuntar a
    // una asignación que no existe ni a la rutina de otro perro.
    const refDe = new Map<string, any>();
    const lineasCat = filas
      .filter((f: any) => f?.ejercicios?.codigo !== RANKING_CODIGO)
      .map((f: any, i: number) => {
        const ref = `E${i + 1}`;
        refDe.set(ref, f);
        const actuales: string[] = [];
        if (f.objetivo_seg != null) actuales.push(`objetivo_seg=${f.objetivo_seg}`);
        if (f.objetivo_distancia != null) actuales.push(`objetivo_distancia=${f.objetivo_distancia}`);
        if (f.dificultad != null) actuales.push(`dificultad=${f.dificultad}`);
        if (f.reps_sugeridas_min != null) actuales.push(`reps_min=${f.reps_sugeridas_min}`);
        if (f.min_semanal != null) actuales.push(`min_semanal=${f.min_semanal}`);
        if (f.valor_comida_nombre) actuales.push(`comida=${f.valor_comida_nombre}`);
        const quien = variosPerros ? ` [perro: ${perroNombre.get(f.perro_id) ?? '?'}]` : '';
        const ya = actuales.length ? ` (ahora mismo: ${actuales.join(', ')})` : '';
        return `${ref}. ${f?.ejercicios?.nombre ?? 'sin nombre'}${quien}${ya}`;
      });

    const bloques = usables
      .map((e: any, i: number) => `--- Escucha ${i + 1} ---\n${String(e.transcripcion).trim()}`)
      .join('\n\n');

    const lineas: string[] = [];
    if (variosPerros) {
      lineas.push(`ATENCIÓN: esta casa tiene ${perros.length} perros (${perros.map((p: any) => p.nombre).join(', ')}). Cada ejercicio de la lista dice de qué perro es. Si la clase no deja claro para cuál es una pauta, marcala dudosa.`);
    } else {
      lineas.push(`Perro: ${perros[0].nombre}`);
    }
    if (cita.numero_clase != null) lineas.push(`Nº de clase: ${cita.numero_clase}`);
    lineas.push(`EJERCICIOS ASIGNADOS AHORA MISMO A ESTE PERRO (usa estas referencias):\n${lineasCat.join('\n')}`);
    lineas.push(`TRANSCRIPCIÓN DE LA CLASE:\n${bloques}`);

    // ── Llamada al modelo ──
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL, max_tokens: MAX_TOKENS, system: SYSTEM_PROMPT,
        messages: [
          { role: 'user', content: lineas.join('\n\n') },
        ],
      }),
    });
    if (!claudeRes.ok) {
      const detalle = (await claudeRes.text().catch(() => '')).slice(0, 300);
      return json({ ok: false, error: `Error de la IA (${claudeRes.status})`, detalle }, 502);
    }
    const data = await claudeRes.json();
    const salida = (Array.isArray(data?.content)
      ? data.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('')
      : '').trim();

    // El modelo devuelve el objeto entero: claude-sonnet-4-6 no admite que le
    // dejemos empezada la respuesta, así que se lo pedimos completo y lo que
    // venga de más (una valla de markdown, un "aquí tienes") se limpia aquí.
    const limpio = salida.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    let parsed: any = null;
    try {
      parsed = JSON.parse(limpio);
    } catch (_e) {
      // Segundo intento: quedarnos con lo que va de la primera llave a la última.
      const a = limpio.indexOf('{');
      const b = limpio.lastIndexOf('}');
      if (a >= 0 && b > a) { try { parsed = JSON.parse(limpio.slice(a, b + 1)); } catch (_e2) { /* noop */ } }
    }
    if (!parsed || (!Array.isArray(parsed.pautas) && !Array.isArray(parsed.revisiones))) {
      return json({ ok: false, error: 'La IA no devolvió nada legible.' }, 502);
    }
    if (!Array.isArray(parsed.pautas)) parsed.pautas = [];

    // ── Filtro del servidor ──
    // Cada pauta tiene que sobrevivir a tres comprobaciones. Lo que no las
    // pasa no se descarta: se degrada a dudosa con el motivo, para que Charly
    // vea también lo que el filtro frenó.
    const registros: any[] = [];
    // Para no aplicar dos veces el mismo campo del mismo ejercicio si el
    // modelo lo repite: gana el primero y el resto queda para revisar.
    const yaAplicado = new Set<string>();

    for (const p of parsed.pautas) {
      const campo = String(p?.campo ?? '').trim();
      const fila = refDe.get(String(p?.ref ?? '').trim());
      const citaTxt = String(p?.cita_textual ?? '').trim();
      let confianza = (p?.confianza === 'alta') ? 'alta' : 'dudosa';
      let motivo: string | null = p?.motivo_duda ? String(p.motivo_duda).slice(0, 300) : null;

      const degradar = (m: string) => { confianza = 'dudosa'; motivo = motivo ? `${m} · ${motivo}` : m; };

      if (!fila) {
        // Sin ejercicio real no hay nada que escribir: se registra para que
        // quede constancia, pero sin asignación no se puede ni revisar.
        registros.push({
          cita_id: citaId, perro_id: null, asignado_id: null, escucha_id: escuchaIds[0],
          ejercicio_texto: String(p?.ref ?? '') || null, campo: CAMPOS_TEXTO.has(campo) || RANGOS[campo] ? campo : 'nota_cliente',
          valor_num: null, valor_texto: p?.valor_texto ? String(p.valor_texto).slice(0, NOTA_MAX) : null,
          cita_textual: citaTxt.slice(0, 600) || null, confianza: 'dudosa',
          motivo_duda: 'La IA apuntó a un ejercicio que no está en la rutina de este perro.',
          estado: 'revisar', valor_anterior: null,
        });
        continue;
      }
      if (!RANGOS[campo] && !CAMPOS_TEXTO.has(campo)) continue;  // campo inventado: se ignora

      // 1) La frase citada tiene que estar de verdad en el audio transcrito.
      if (!citaExiste(citaTxt, transcripcionesNorm)) {
        degradar('La frase citada no aparece literalmente en la transcripción.');
      }

      let valorNum: number | null = null;
      let valorTexto: string | null = null;
      let valorAnterior: string | null = null;

      if (campo === 'nota_cliente') {
        valorTexto = String(p?.valor_texto ?? '').trim().slice(0, NOTA_MAX) || null;
        if (!valorTexto) continue;
        valorAnterior = fila.nota_cliente ?? null;
      } else if (campo === 'valor_comida') {
        // El modelo devuelve el NOMBRE. El número sale del ranking del perro,
        // no del modelo: si el tutor no hizo el ranking, se queda el nombre
        // solo, que es exactamente lo que pidió Charly.
        valorTexto = String(p?.valor_texto ?? '').trim().slice(0, 60) || null;
        const ranking = rankingPorPerro.get(fila.perro_id) ?? [];
        if (!valorTexto) {
          // Charly a veces no nombra la comida sino su nivel ("el nivel uno en
          // comidas"). Ese número ES la posición del ranking: si el tutor lo
          // hizo, sacamos el nombre de ahí; si no, se queda el número solo.
          const nivel = intOrNull(p?.valor_num);
          if (nivel == null || nivel < 1 || nivel > 5) continue;
          valorNum = nivel;
          if (ranking.length >= nivel) valorTexto = ranking[nivel - 1].slice(0, 60);
          else degradar('Dijo el nivel ' + nivel + ' de comida y este perro todavía no tiene el ranking hecho.');
        } else {
          const objetivo = norm(valorTexto);
          let pos = -1;
          for (let i = 0; i < ranking.length; i++) {
            const item = norm(ranking[i]);
            if (!item) continue;
            if (item === objetivo || item.includes(objetivo) || objetivo.includes(item)) { pos = i + 1; break; }
          }
          if (pos >= 1 && pos <= 5) {
            valorNum = pos;
          } else if (pos > 5) {
            // El ranking admite 6 ítems pero la columna llega a 5. Nombre solo.
            degradar('Esa comida es la nº ' + pos + ' de su ranking y la escala solo llega a 5.');
          } else if (ranking.length) {
            degradar(`"${valorTexto}" no está en el ranking de comidas de este perro.`);
          }
        }
        valorAnterior = fila.valor_comida_nombre
          ? `${fila.valor_comida_nombre}${fila.valor_comida != null ? ` (${fila.valor_comida})` : ''}`
          : (fila.valor_comida != null ? String(fila.valor_comida) : null);
      } else {
        // 2) Campo numérico: tiene que caer dentro del rango de su columna.
        const r = RANGOS[campo];
        valorNum = intOrNull(p?.valor_num);
        if (valorNum == null) continue;
        if (valorNum < r.min || valorNum > r.max) {
          degradar(`El valor ${valorNum} se sale de lo admitido para ese campo (${r.min}-${r.max}).`);
          valorNum = null;
        }
        const previo = fila[campo];
        valorAnterior = previo == null ? null : String(previo);
      }

      // 3) Dos pautas para el mismo campo del mismo ejercicio: la segunda a
      //    revisar, porque puede ser una corrección o puede ser ruido.
      const clave = `${fila.id}|${campo}`;
      if (confianza === 'alta' && yaAplicado.has(clave)) {
        degradar('Ya había otra pauta para este mismo campo en esta clase.');
      }
      const aplicable = confianza === 'alta' && (valorNum != null || valorTexto != null);
      if (aplicable) yaAplicado.add(clave);

      registros.push({
        cita_id: citaId, perro_id: fila.perro_id, asignado_id: fila.id, escucha_id: escuchaIds[0],
        ejercicio_texto: fila?.ejercicios?.nombre ?? null,
        campo, valor_num: valorNum, valor_texto: valorTexto,
        cita_textual: citaTxt.slice(0, 600) || null,
        confianza, motivo_duda: motivo,
        estado: aplicable ? 'aplicada' : 'revisar',
        valor_anterior: valorAnterior,
      });
    }

    // ── La revisión de la semana ──
    // Ojo al orden: `filas` se leyó ANTES de aplicar nada de esta clase, así
    // que los objetivos que tiene en memoria son los de la semana pasada. Eso
    // es justo lo que hay que guardar como `objetivo_anterior`, y por eso lo
    // pone el servidor y no el modelo: la base ya lo sabe con certeza.
    const revisiones: any[] = [];
    const fechaClase = String(cita.fecha ?? new Date().toISOString().slice(0, 10));

    // Charly graba por rondas: explica un ejercicio, genera, explica el
    // siguiente, vuelve a generar. En la segunda ronda la ficha ya lleva los
    // objetivos nuevos de la primera, así que leerla daría el objetivo de HOY
    // y no el de la semana pasada. Por eso, si en esta misma clase ya se tocó
    // ese campo, el objetivo anterior lo sacamos de lo que se guardó entonces.
    const previoEnEstaClase = new Map<string, number>();
    {
      const { data: yaTocado } = await admin.from('pautas_extraidas')
        .select('asignado_id, campo, valor_anterior, creado_en')
        .eq('cita_id', citaId).in('estado', ['aplicada', 'confirmada'])
        .order('creado_en', { ascending: true });
      for (const t of (yaTocado ?? [])) {
        const n = Number(t?.valor_anterior);
        if (!t?.asignado_id || !Number.isFinite(n)) continue;
        const k = `${t.asignado_id}|${t.campo}`;
        if (!previoEnEstaClase.has(k)) previoEnEstaClase.set(k, n);  // gana la primera ronda
      }
    }

    for (const r of (Array.isArray(parsed.revisiones) ? parsed.revisiones : [])) {
      const fila = refDe.get(String(r?.ref ?? '').trim());
      if (!fila) continue;  // sin ejercicio real no hay historia que escribir
      const citaTxt = String(r?.cita_textual ?? '').trim();
      let confianza = (r?.confianza === 'alta') ? 'alta' : 'dudosa';
      let motivo: string | null = r?.motivo_duda ? String(r.motivo_duda).slice(0, 300) : null;
      const degradar = (m: string) => { confianza = 'dudosa'; motivo = motivo ? `${m} · ${motivo}` : m; };

      if (!citaExiste(citaTxt, transcripcionesNorm)) {
        degradar('La frase citada no aparece literalmente en la transcripción.');
      }

      const campoRaw = String(r?.campo ?? '').trim();
      const campo = CAMPOS_REVISION.has(campoRaw) ? campoRaw : null;
      const objetivoAnterior = !campo ? null
        : (previoEnEstaClase.has(`${fila.id}|${campo}`)
            ? previoEnEstaClase.get(`${fila.id}|${campo}`)!
            : (fila[campo] != null ? Number(fila[campo]) : null));

      let alcanzado = (r?.alcanzado == null) ? null : intOrNull(r.alcanzado);
      if (alcanzado != null && campo) {
        const rango = RANGOS[campo];
        if (rango && (alcanzado < 0 || alcanzado > rango.max)) {
          degradar(`La cifra ${alcanzado} no es posible en ese campo.`);
          alcanzado = null;
        }
      }
      const logro = LOGROS.has(String(r?.logro ?? '')) ? String(r.logro) : 'sin_dato';

      // Cuarta red, solo para la revisión: si los números contradicen el
      // veredicto, algo se entendió mal. No decidimos nosotros cuál de los dos
      // tiene razón — lo mandamos a revisar y que lo mire Charly.
      if (objetivoAnterior != null && alcanzado != null) {
        if (alcanzado >= objetivoAnterior && logro === 'no_llego') {
          degradar('Dice que no llegó, pero la cifra alcanza el objetivo que tenía puesto.');
        }
        if (alcanzado < objetivoAnterior && logro === 'conseguido') {
          degradar('Dice conseguido, pero la cifra se queda por debajo del objetivo que tenía puesto.');
        }
      }
      // Y si la IA recordaba otro objetivo que el que hay en la ficha, tampoco
      // nos fiamos del resto de esa entrada.
      const objModelo = (r?.objetivo_anterior == null) ? null : intOrNull(r.objetivo_anterior);
      if (objetivoAnterior != null && objModelo != null && objModelo !== objetivoAnterior) {
        degradar(`En la ficha el objetivo era ${objetivoAnterior} y la IA entendió ${objModelo}.`);
      }

      revisiones.push({
        cita_id: citaId, perro_id: fila.perro_id, asignado_id: fila.id, escucha_id: escuchaIds[0],
        fecha: fechaClase, numero_clase: cita.numero_clase ?? null,
        campo, objetivo_anterior: objetivoAnterior, alcanzado, logro,
        comentario: String(r?.comentario ?? '').trim().slice(0, NOTA_MAX) || null,
        cita_textual: citaTxt.slice(0, 600) || null,
        confianza, motivo_duda: motivo,
        estado: (confianza === 'alta') ? 'registrada' : 'revisar',
      });
    }

    // ── Escritura ──
    // Primero los UPDATE de la rutina (agrupados por asignación, un UPDATE por
    // ejercicio), después el registro de auditoría, y al final la marca en las
    // escuchas. Si algo falla por el camino, lo que ya se escribió es
    // coherente: nunca queda un campo aplicado sin su registro.
    const porAsignado = new Map<string, Record<string, unknown>>();
    for (const r of registros) {
      if (r.estado !== 'aplicada' || !r.asignado_id) continue;
      const patch = porAsignado.get(r.asignado_id) ?? {};
      if (r.campo === 'valor_comida') {
        patch.valor_comida_nombre = r.valor_texto;
        if (r.valor_num != null) patch.valor_comida = r.valor_num;
      } else if (r.campo === 'nota_cliente') {
        patch.nota_cliente = r.valor_texto;
      } else {
        patch[r.campo] = r.valor_num;
      }
      porAsignado.set(r.asignado_id, patch);
    }

    if (!dryRun) {
      // Al reprocesar una clase, lo de la pasada anterior no se borra: se marca
      // como descartada, con su motivo. Así no se duplica y no se pierde nada.
      if (reprocesar) {
        const ahora = new Date().toISOString();
        const fuera = { estado: 'descartada', motivo_duda: 'Reemplazada al reprocesar la clase.', resuelto_en: ahora };
        await admin.from('pautas_extraidas').update(fuera).eq('cita_id', citaId).in('estado', ['aplicada', 'revisar']);
        await admin.from('revisiones_ejercicio').update(fuera).eq('cita_id', citaId).in('estado', ['registrada', 'revisar']);
      }
      for (const [asignadoId, patch] of porAsignado) {
        patch.actualizado_en = new Date().toISOString();
        const { error: upErr } = await admin.from('ejercicios_asignados').update(patch).eq('id', asignadoId);
        if (upErr) {
          // No abortamos la clase entera por un ejercicio: lo marcamos para
          // revisar y seguimos con el resto.
          for (const r of registros) {
            if (r.asignado_id === asignadoId && r.estado === 'aplicada') {
              r.estado = 'revisar';
              r.motivo_duda = `No se pudo guardar en la ficha: ${upErr.message}`.slice(0, 300);
            }
          }
        }
      }
      if (registros.length) {
        const { error: insErr } = await admin.from('pautas_extraidas').insert(registros);
        if (insErr) console.warn('[pautas] no se pudo registrar la auditoría:', insErr);
      }
      if (revisiones.length) {
        const { error: revErr } = await admin.from('revisiones_ejercicio').insert(revisiones);
        if (revErr) console.warn('[pautas] no se pudo registrar la revisión:', revErr);
      }
      const { error: marcaErr } = await admin.from('escuchas_clase')
        .update({ pautas_en: new Date().toISOString() }).in('id', escuchaIds);
      if (marcaErr) console.warn('[pautas] no se pudieron marcar las escuchas:', marcaErr);
    }

    const aplicadas = registros.filter((r) => r.estado === 'aplicada');
    const revisar = registros.filter((r) => r.estado === 'revisar');
    return json({
      ok: true, dryRun,
      escuchas_usadas: escuchaIds,
      ejercicios_tocados: porAsignado.size,
      aplicadas, revisar,
      revisiones,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return json({ ok: false, error: `Error inesperado: ${msg}` }, 500);
  }
});
