// =====================================================================
// asistente-admin — edge function (proyecto sydzfwwiruxqaxojymdz).
// Cerebro del asistente interno "Jaime" del admin de Clases.
// v4: además de las NOTAS de caso de Charly (eventos nota_caso) y los
// MENSAJES del cliente (tabla mensajes), ahora también lee las NOTAS QUE EL
// CLIENTE DEJA AL REPORTAR CADA ENTRENO (registros_ejercicio.nota), que es por
// donde entran las notas desde que se unificó el canal. Arma un payload de
// presentación: números EXACTOS de la base + texto de la IA + sugerencias
// VALIDADAS contra el catálogo. NO escribe nada: solo lee y sugiere.
// =====================================================================

import { createClient } from '@supabase/supabase-js';

const MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 1500;
const ALLOWED_ORIGINS = ['https://perrosdelaisla.github.io', 'https://app.perrosdelaisla.es', 'http://localhost:5500'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SYSTEM_PROMPT = `Sos el asistente interno de Charly, adiestrador de Perros de la Isla, dentro de su panel de administración. Te llamás Jaime. Le hablás SOLO a él, en español rioplatense informal (vos, tenés, mirá). Nunca te ve un cliente.

En cada consulta recibís el contexto de UN perro:
- Datos del perro (nombre, raza, edad, peso) y estado del cliente.
- Su HISTÓRICO de evaluaciones de Bienestar y felicidad, ordenado de la más antigua a la más reciente. Cada una tiene scores de 0 a 100 en cuatro dimensiones (física, emocional, social, cognitiva), score total y si tiene bandera roja.
- Los ejercicios que ya tiene asignados.
- Su cumplimiento reciente (sesiones de práctica registradas por el cliente).
- NOTAS QUE EL CLIENTE DEJÓ AL REPORTAR SUS ENTRENOS (lo que escribió sobre cómo le fue con cada ejercicio). Es la voz directa del tutor sobre el día a día: tenélas muy en cuenta.
- TUS NOTAS de caso anteriores sobre este perro (tu propia mirada profesional de clases pasadas). Son muy valiosas.
- MENSAJES sueltos del cliente sobre este perro, si los hay.
- SEGUIMIENTOS DE CONDUCTA que el tutor registra día a día con un semáforo (verde=bien, amarillo=regular, rojo=mal) por conducta (ej. paseos, quedarse solo). De cada conducta recibís los conteos del mes actual y del mes anterior, una tendencia (mejora/empeora/estable) y las notas del tutor explicando los días puntuales. Es el termómetro más directo de cómo evoluciona cada conducta en el día a día.
- El CATÁLOGO COMPLETO de ejercicios disponibles, cada uno con código, nombre, categoría y descripción.

Tu trabajo, cruzando TODOS esos datos antes de responder:
1. Escribir una intro breve (1-2 frases) que abra el caso: con qué viene el perro y por dónde proponés arrancar. Si hay 2 o más evaluaciones, mencioná la evolución. Si las notas de los entrenos o tus notas previas aportan algo clave, reflejálo.
2. Resumir el estado del caso en EXACTAMENTE 3 líneas cortas.
3. Sugerir 2 o 3 ejercicios para trabajar, priorizando la dimensión SC más baja, teniendo en cuenta lo que ya tiene asignado, si viene cumpliendo, las notas de los entrenos y tus notas. Cruzá además la evolución de los SEGUIMIENTOS DE CONDUCTA con los ejercicios asignados y las prácticas: mirá qué conductas mejoran y cuáles empeoran o se estancan, deducí qué parece estar funcionando y qué no, y proponé ejercicios o cambios de rutina en consecuencia. Si una conducta viene empeorando, dale prioridad; si una mejora, no la rompas.

REGLAS QUE NUNCA ROMPÉS:
- Solo sugerís ejercicios que estén en el CATÁLOGO que te paso, referenciados por su código EXACTO. JAMÁS inventás un ejercicio que no esté en la lista.
- No sugerís algo que el perro ya tiene asignado.
- Hablás en posibilidad, nunca diagnosticás: "podría ayudar con", "parece que", nunca "el perro tiene" o "sufre de".
- No nombrás protocolos ni metodologías de formación. Hablás del trabajo, no de etiquetas.
- El criterio final es de Charly. Vos proponés, él decide.
- NO menciones los números de los scores en tu texto; de los números se encarga la interfaz. Vos narrás.

Respondés SIEMPRE y SOLO con este JSON, sin texto antes ni después, sin markdown:
{
  "intro": "string, 1-2 frases",
  "estado": ["línea 1", "línea 2", "línea 3"],
  "sugerencias": [
    { "codigo": "código exacto del catálogo", "por_que": "una línea, en argentino" }
  ]
}`;

// ─────────────────────────────────────────────────────────────
// MODO CONVERSACIÓN (Entrega 1) — Jaime como asistente de chat interno del
// admin, con HERRAMIENTAS de SOLO LECTURA (tool-calling acotado, máx 5
// iteraciones). El modelo NUNCA genera SQL: cada herramienta es una consulta
// predefinida contra tablas reales. Reusa el mismo proveedor/modelo/API key.
// ─────────────────────────────────────────────────────────────
const CHAT_MAX_TOKENS = 1536;
// El parte del día encadena agenda + detalle por cliente + atención: sube el
// tope de iteraciones de tool-calling para que quepa la cadena completa.
const MAX_TOOL_ITERS = 10;

const SYSTEM_PROMPT_CHAT = `Eres Jaime, el asistente interno del panel de administración de Perros de la Isla (escuela de adiestramiento canino en Mallorca). Hablas SOLO con el equipo interno, nunca con clientes. Idioma: castellano peninsular, profesional y directo. Respuestas concisas y al grano.

Dispones de HERRAMIENTAS de SOLO LECTURA para consultar la base de datos. Úsalas siempre que necesites un dato concreto; no respondas de memoria.

REGLAS INNEGOCIABLES:
- Responde ÚNICAMENTE con datos que devuelvan las herramientas. Si un dato no aparece, o la herramienta no lo trae, dilo con claridad ("no tengo ese dato", "no consta").
- PROHIBIDO inventar nombres, fechas, teléfonos, direcciones, cifras o resultados. Nada de suposiciones ni de rellenar huecos.
- Para identificar a un cliente por nombre usa buscar_cliente. Si hay varias coincidencias, enuméralas y pide que se aclare cuál.
- No generas SQL ni describes la estructura interna de la base de datos.
- Si el contexto de la pantalla trae cliente_id o perro_id, "este cliente" / "este perro" se refieren a esos identificadores: úsalos directamente sin volver a buscar.
- Antes de decir que no puedes o de pedir un dato al equipo, INTENTA encadenar herramientas. Ejemplos: para "¿qué clases tengo hoy/mañana?" usa agenda_del_dia (sin fecha = hoy; con fecha YYYY-MM-DD para otro día). Para "¿con quién es la clase siguiente?" usa agenda_del_dia de hoy, localiza la próxima cita por hora respecto a la hora actual y, si necesitas más detalle del cliente o su perro, encadena con perros_de_cliente o citas_de_cliente usando el cliente_id (y perro_id) que devuelve la agenda. Pedir información al equipo es el ÚLTIMO recurso, nunca el primero.
- Para la agenda de salud física del perro (citas veterinarias, vacunas, medicación, desparasitaciones, peluquería, paseos) usa salud_de_perro: recúrrela cuando pregunten por la salud, los tratamientos, las vacunas, la medicación o las próximas citas veterinarias de un perro.
- Si una herramienta no devuelve datos (por ejemplo, la agenda del día viene vacía), dilo tal cual ("no hay clases ese día", "no consta"); JAMÁS rellenes con citas, horas, clientes o perros inventados.
- Ante una pregunta que no puedas responder con las herramientas, dilo; no rellenes con conjeturas.

EL PARTE DEL DÍA: cuando el equipo te lo pida ("el parte", "el parte del día") o al recibir el mensaje "Dame el parte del día", compón un briefing CONCISO del día de HOY, SIEMPRE con datos de las herramientas:
1. Llama a agenda_del_dia (sin fecha = hoy).
2. Por cada cita, si aporta, encadena: citas_de_cliente(cliente_id) para saber qué se trabajó en la última clase de ese cliente (su último resumen), y la actividad del perro con entrenos_de_perro o rutina_de_perro cuando ayude a ver la constancia.
3. Cierra con atencion_pendiente() para las alertas de seguimiento.
Formato (TEXTO PLANO, sin markdown, sin viñetas de asterisco): una línea de saludo; luego una entrada por clase con la hora, cliente·perro, qué se trabajó la última vez, la constancia si hay datos, y la zona/ubicación; y al final un bloque "Atención:" SOLO si atencion_pendiente devuelve ítems. Si no hay clases hoy, dilo en una línea y muestra igualmente "Atención" si hay ítems. Todo con datos de herramientas: si un dato no está, se omite; nada inventado.

MEMORIA DEL EQUIPO (notas privadas por perro):
- Guarda una nota con guardar_nota_perro SOLO cuando el equipo lo pida claramente ("anotá que…", "guardate que…", "recordá que…"). NUNCA por iniciativa propia.
- Si el perro se nombra por su nombre, resuélvelo antes con buscar_perro. Si hay varios perros con ese nombre o cualquier ambigüedad, PREGUNTA cuál antes de guardar; no adivines el perro_id.
- Tras guardar, confirma citando el texto guardado (por ejemplo: "Anotado para Hermes: le asusta el ascensor.").
- Las notas son PRIVADAS del equipo interno: nunca las trates como información para el tutor ni las mezcles con datos del cliente.
- Cuando te pregunten qué se sabe de un perro o algo sobre él ("¿qué le asustaba a Hermes?", "¿qué sabemos de X?"), consulta también notas_de_perro además del resto de herramientas.`;

const TOOLS = [
  { name: 'agenda_del_dia', description: 'Agenda de un día concreto: TODAS las citas (clases) de ese día ordenadas por hora, con hora, estado, modalidad, zona, cliente (nombre) y su perro si el cliente tiene uno solo (si tiene varios, vienen todos en "perros"). Incluye cliente_id y perro_id para encadenar con las otras herramientas. Sin el parámetro fecha, usa HOY en Mallorca (Europe/Madrid). Úsala para "¿qué clases hay hoy/mañana?", "¿cuál es la clase siguiente?", "¿con quién es la próxima?", etc.', input_schema: { type: 'object', properties: { fecha: { type: 'string', description: 'Día a consultar en formato YYYY-MM-DD. Si se omite, HOY en Mallorca.' } } } },
  { name: 'buscar_cliente', description: 'Busca clientes por coincidencia parcial de nombre. Devuelve id, nombre, teléfono, email, dirección, zona, enlace de ubicación en Google Maps, estado y pack actual.', input_schema: { type: 'object', properties: { nombre_parcial: { type: 'string', description: 'Parte del nombre del cliente a buscar' } }, required: ['nombre_parcial'] } },
  { name: 'perros_de_cliente', description: 'Lista los perros de un cliente con sus datos básicos (nombre, raza, edad en meses, peso, si es PPP, problemática, protocolo).', input_schema: { type: 'object', properties: { cliente_id: { type: 'string' } }, required: ['cliente_id'] } },
  { name: 'citas_de_cliente', description: 'Últimas citas de un cliente: fecha, hora, modalidad, estado, número de clase y resumen.', input_schema: { type: 'object', properties: { cliente_id: { type: 'string' }, limite: { type: 'integer', description: 'Máximo de citas a devolver (por defecto 10)' } }, required: ['cliente_id'] } },
  { name: 'entrenos_de_perro', description: 'Últimos entrenos registrados de un perro (fecha, ejercicio, tranquilidad, nota del cliente). Para responder "¿cuándo hizo X por última vez?", pasa el nombre del ejercicio en el parámetro ejercicio.', input_schema: { type: 'object', properties: { perro_id: { type: 'string' }, ejercicio: { type: 'string', description: 'Filtra por nombre de ejercicio (opcional)' }, limite: { type: 'integer', description: 'Máximo de entrenos (por defecto 15)' } }, required: ['perro_id'] } },
  { name: 'rutina_de_perro', description: 'Ejercicios activos en la rutina de un perro, con código, nombre, categoría, posición y progresión (progresa_de). No incluye rachas: se calculan en la app, no en la base.', input_schema: { type: 'object', properties: { perro_id: { type: 'string' } }, required: ['perro_id'] } },
  { name: 'bienestar_de_perro', description: 'Última evaluación de bienestar y felicidad (salud comportamental) de un perro: scores por dimensión (física, emocional, social, cognitiva), score total, bandera roja y fecha.', input_schema: { type: 'object', properties: { perro_id: { type: 'string' } }, required: ['perro_id'] } },
  { name: 'resumenes_de_clase', description: 'Resúmenes de clase de un cliente (o del cliente dueño de un perro, si pasas perro_id). Devuelve fecha, número de clase y el texto del resumen.', input_schema: { type: 'object', properties: { cliente_id: { type: 'string' }, perro_id: { type: 'string' }, limite: { type: 'integer' } } } },
  { name: 'atencion_pendiente', description: 'Alertas de seguimiento del equipo: perros activos que nunca empezaron la rutina, que se enfriaron (varios días sin entrenar) o con una tarea abandonada. Devuelve total y una lista de ítems (motivo, perro, perro_id, cliente, cliente_id, dias, tarea). Solo lectura. Úsala para cerrar el parte del día o cuando pregunten qué requiere atención.', input_schema: { type: 'object', properties: {} } },
  { name: 'buscar_perro', description: 'Busca perros por coincidencia parcial de nombre. Devuelve perro_id, nombre, raza y su cliente (nombre, cliente_id). Úsala para resolver un perro nombrado por su nombre (por ejemplo antes de guardar o leer una nota); si hay varias coincidencias, hay que desambiguar.', input_schema: { type: 'object', properties: { nombre_parcial: { type: 'string', description: 'Parte del nombre del perro a buscar' } }, required: ['nombre_parcial'] } },
  { name: 'notas_de_perro', description: 'Notas privadas del equipo sobre un perro, de la más reciente a la más antigua (fecha y texto). Solo lectura. Consúltala cuando pregunten qué se sabe de un perro o para recordar algo anotado.', input_schema: { type: 'object', properties: { perro_id: { type: 'string' }, limite: { type: 'integer', description: 'Máximo de notas (por defecto 10)' } }, required: ['perro_id'] } },
  { name: 'salud_de_perro', description: 'Agenda de salud física de un perro: próximas citas del veterinario, vacunas, desparasitaciones, medicación, peluquería y paseos, con su fecha y si ya se realizaron. Úsala cuando pregunten por la salud, los tratamientos, las vacunas, la medicación o las próximas citas veterinarias de un perro.', input_schema: { type: 'object', properties: { perro_id: { type: 'string' }, limite: { type: 'integer', description: 'Máximo de eventos (por defecto 20)' } }, required: ['perro_id'] } },
  { name: 'guardar_nota_perro', description: 'Guarda una nota privada del equipo sobre un perro (memoria interna). ÚNICA herramienta de escritura. Úsala SOLO cuando el equipo lo pida explícitamente ("anotá que…", "guardate que…"). El texto se guarda tal cual, máximo 1000 caracteres. Requiere el perro_id exacto (resuélvelo antes con buscar_perro si te dan un nombre).', input_schema: { type: 'object', properties: { perro_id: { type: 'string' }, texto: { type: 'string', description: 'La nota a guardar, hasta 1000 caracteres' } }, required: ['perro_id', 'texto'] } },
];

function clampLimite(v: unknown, def: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(Math.floor(n), max);
}

// Fecha y hora actuales en Mallorca (Europe/Madrid), resueltas con la zona
// horaria real (incluye horario de verano). fecha en 'YYYY-MM-DD', hora en
// 'HH:MM' 24h, y el día de la semana en castellano. Es la única fuente de
// "hoy/ahora" del asistente: nunca dependemos de la hora UTC del servidor.
function fechaHoraMadrid(d: Date = new Date()): { fecha: string; hora: string; diaSemana: string } {
  const fmt = new Intl.DateTimeFormat('es-ES', {
    timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'long',
  });
  const p: Record<string, string> = {};
  for (const part of fmt.formatToParts(d)) p[part.type] = part.value;
  return {
    fecha: `${p.year}-${p.month}-${p.day}`,
    hora: `${p.hour === '24' ? '00' : p.hour}:${p.minute}`,
    diaSemana: p.weekday ?? '',
  };
}

function nombreEjercicioTool(row: any): string {
  const ea = row?.ejercicios_asignados;
  const e = Array.isArray(ea) ? ea[0]?.ejercicios : ea?.ejercicios;
  const ej = Array.isArray(e) ? e[0] : e;
  return ej?.nombre ?? '';
}

// Ejecuta UNA herramienta del set cerrado. Devuelve siempre un objeto
// JSON-serializable; nunca lanza (los errores van dentro del objeto).
// `admin` = service role (lecturas + la única escritura, notas_perro).
// `userClient` = cliente con el JWT del admin (para RPCs con es_admin()).
async function ejecutarHerramienta(admin: any, userClient: any, nombre: string, input: any): Promise<any> {
  try {
    switch (nombre) {
      case 'agenda_del_dia': {
        // Sin fecha (o fecha inválida) → HOY en Mallorca. Las citas son a nivel
        // CLIENTE (no hay perro_id en citas): el perro se deriva de los perros
        // del cliente. Si tiene uno solo, lo exponemos como perro/perro_id;
        // si tiene varios, van todos en "perros" para que el modelo elija.
        let fecha = String(input?.fecha ?? '').trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) fecha = fechaHoraMadrid().fecha;
        const { data, error } = await admin.from('citas')
          .select('id, hora, estado, modalidad, zona, cliente_id, clientes(nombre, perros(id, nombre))')
          .eq('fecha', fecha)
          .order('hora', { ascending: true });
        if (error) return { error: error.message };
        const citas = (data ?? []).map((c: any) => {
          const cli = Array.isArray(c.clientes) ? c.clientes[0] : c.clientes;
          const perros = Array.isArray(cli?.perros) ? cli.perros.map((p: any) => ({ id: p.id, nombre: p.nombre })) : [];
          const uno = perros.length === 1 ? perros[0] : null;
          return {
            hora: String(c.hora ?? '').slice(0, 5),
            estado: c.estado ?? null,
            modalidad: c.modalidad ?? null,
            zona: c.zona ?? null,
            cliente: cli?.nombre ?? null,
            cliente_id: c.cliente_id ?? null,
            perro: uno?.nombre ?? null,
            perro_id: uno?.id ?? null,
            perros,
          };
        });
        return { fecha, citas };
      }
      case 'buscar_cliente': {
        const q = String(input?.nombre_parcial ?? '').trim();
        if (!q) return { error: 'Falta nombre_parcial' };
        const { data, error } = await admin.from('clientes')
          .select('id, nombre, telefono, email, direccion, zona, ubicacion_maps, estado, pack_actual')
          .ilike('nombre', `%${q}%`).order('nombre', { ascending: true }).limit(10);
        if (error) return { error: error.message };
        return { clientes: data ?? [] };
      }
      case 'perros_de_cliente': {
        const cid = String(input?.cliente_id ?? '');
        if (!UUID_RE.test(cid)) return { error: 'cliente_id inválido' };
        const { data, error } = await admin.from('perros')
          .select('id, nombre, raza, edad_meses, peso_kg, es_ppp, problematica, descripcion, protocolo_principal, caso_complejo')
          .eq('cliente_id', cid).order('created_at', { ascending: true });
        if (error) return { error: error.message };
        return { perros: data ?? [] };
      }
      case 'citas_de_cliente': {
        const cid = String(input?.cliente_id ?? '');
        if (!UUID_RE.test(cid)) return { error: 'cliente_id inválido' };
        const limite = clampLimite(input?.limite, 10, 50);
        const { data, error } = await admin.from('citas')
          .select('fecha, hora, modalidad, estado, numero_clase, resumen_cliente')
          .eq('cliente_id', cid).order('fecha', { ascending: false }).limit(limite);
        if (error) return { error: error.message };
        return { citas: data ?? [] };
      }
      case 'entrenos_de_perro': {
        const pid = String(input?.perro_id ?? '');
        if (!UUID_RE.test(pid)) return { error: 'perro_id inválido' };
        const limite = clampLimite(input?.limite, 15, 50);
        // Traemos un lote amplio y filtramos por nombre de ejercicio en memoria
        // (el filtro opcional es por texto, no por id).
        const { data, error } = await admin.from('registros_ejercicio')
          .select('registrado_en, tranquilidad, nota, ejercicios_asignados!inner(perro_id, ejercicios(nombre, codigo))')
          .eq('ejercicios_asignados.perro_id', pid)
          .order('registrado_en', { ascending: false }).limit(200);
        if (error) return { error: error.message };
        let filas = (data ?? []).map((r: any) => ({ fecha: r.registrado_en, tranquilidad: r.tranquilidad ?? null, nota: r.nota ?? null, ejercicio: nombreEjercicioTool(r) }));
        const filtro = String(input?.ejercicio ?? '').trim().toLowerCase();
        if (filtro) filas = filas.filter((r: any) => (r.ejercicio ?? '').toLowerCase().includes(filtro));
        return { entrenos: filas.slice(0, limite) };
      }
      case 'rutina_de_perro': {
        const pid = String(input?.perro_id ?? '');
        if (!UUID_RE.test(pid)) return { error: 'perro_id inválido' };
        const { data, error } = await admin.from('ejercicios_asignados')
          .select('id, posicion_rutina, progresa_de, min_semanal, estado_cliente, ejercicios:ejercicio_id(codigo, nombre, categoria)')
          .eq('perro_id', pid).eq('activo', true).order('posicion_rutina', { ascending: true });
        if (error) return { error: error.message };
        const rutina = (data ?? []).map((a: any) => ({
          asignado_id: a.id,
          codigo: a.ejercicios?.codigo ?? null,
          nombre: a.ejercicios?.nombre ?? null,
          categoria: a.ejercicios?.categoria ?? null,
          posicion: a.posicion_rutina ?? null,
          progresa_de: a.progresa_de ?? null,
          min_semanal: a.min_semanal ?? null,
          estado_cliente: a.estado_cliente ?? null,
        }));
        return { rutina, nota: 'Las rachas no están incluidas: se calculan en la app, no en la base.' };
      }
      case 'bienestar_de_perro': {
        const pid = String(input?.perro_id ?? '');
        if (!UUID_RE.test(pid)) return { error: 'perro_id inválido' };
        const { data, error } = await admin.from('evaluaciones_isla')
          .select('score_fisica, score_emocional, score_social, score_cognitiva, score_total, bandera_roja, created_at')
          .eq('perro_id', pid).eq('completada', true)
          .order('created_at', { ascending: false }).limit(1);
        if (error) return { error: error.message };
        const ev = (data ?? [])[0];
        return { evaluacion: ev ?? null };
      }
      case 'resumenes_de_clase': {
        let cid = String(input?.cliente_id ?? '');
        const pid = String(input?.perro_id ?? '');
        // Los resúmenes viven en citas (a nivel cliente); si dan perro_id,
        // resolvemos su cliente_id.
        if (!UUID_RE.test(cid) && UUID_RE.test(pid)) {
          const { data: p } = await admin.from('perros').select('cliente_id').eq('id', pid).maybeSingle();
          cid = p?.cliente_id ?? '';
        }
        if (!UUID_RE.test(cid)) return { error: 'Falta cliente_id o perro_id válido' };
        const limite = clampLimite(input?.limite, 10, 30);
        const { data, error } = await admin.from('citas')
          .select('fecha, numero_clase, resumen_cliente')
          .eq('cliente_id', cid).not('resumen_cliente', 'is', null)
          .order('fecha', { ascending: false }).limit(limite);
        if (error) return { error: error.message };
        return { resumenes: data ?? [] };
      }
      case 'atencion_pendiente': {
        // El RPC es SECURITY DEFINER y valida es_admin() con auth.uid(): hay
        // que llamarlo con el cliente autenticado del admin, no con service role.
        const { data, error } = await userClient.rpc('get_atencion_admin');
        if (error) return { error: error.message };
        const atencion = Array.isArray(data?.atencion) ? data.atencion.map((a: any) => ({
          motivo: a.motivo ?? null,
          perro: a.perro ?? null,
          perro_id: a.perro_id ?? null,
          cliente: a.cliente ?? null,
          cliente_id: a.cliente_id ?? null,
          dias: a.dias ?? null,
          tarea: a.tarea ?? null,
        })) : [];
        return { total: data?.total ?? atencion.length, atencion };
      }
      case 'buscar_perro': {
        const q = String(input?.nombre_parcial ?? '').trim();
        if (!q) return { error: 'Falta nombre_parcial' };
        const { data, error } = await admin.from('perros')
          .select('id, nombre, raza, cliente_id, clientes:cliente_id(nombre)')
          .ilike('nombre', `%${q}%`).order('nombre', { ascending: true }).limit(10);
        if (error) return { error: error.message };
        const perros = (data ?? []).map((p: any) => {
          const cli = Array.isArray(p.clientes) ? p.clientes[0] : p.clientes;
          return { perro_id: p.id, nombre: p.nombre, raza: p.raza ?? null, cliente: cli?.nombre ?? null, cliente_id: p.cliente_id ?? null };
        });
        return { perros };
      }
      case 'notas_de_perro': {
        const pid = String(input?.perro_id ?? '');
        if (!UUID_RE.test(pid)) return { error: 'perro_id inválido' };
        const limite = clampLimite(input?.limite, 10, 50);
        const { data, error } = await admin.from('notas_perro')
          .select('texto, creado_en').eq('perro_id', pid)
          .order('creado_en', { ascending: false }).limit(limite);
        if (error) return { error: error.message };
        return { notas: (data ?? []).map((n: any) => ({ fecha: n.creado_en, texto: n.texto })) };
      }
      case 'salud_de_perro': {
        const pid = String(input?.perro_id ?? '');
        if (!UUID_RE.test(pid)) return { error: 'perro_id inválido' };
        const limite = clampLimite(input?.limite, 20, 50);
        const { data, error } = await admin.from('salud_eventos')
          .select('tipo, titulo, detalle, fecha, realizado, recordatorio_dias_antes')
          .eq('perro_id', pid)
          .order('fecha', { ascending: true })
          .limit(limite);
        if (error) return { error: error.message };
        const eventos = (data ?? []).map((e) => ({
          tipo: e.tipo,
          titulo: e.titulo,
          detalle: e.detalle ?? null,
          fecha: e.fecha,
          realizado: e.realizado,
        }));
        return { eventos };
      }
      case 'guardar_nota_perro': {
        // ÚNICA escritura del asistente: acotada a notas_perro y nada más.
        const pid = String(input?.perro_id ?? '');
        if (!UUID_RE.test(pid)) return { error: 'perro_id inválido' };
        let texto = String(input?.texto ?? '').trim();
        if (!texto) return { error: 'La nota está vacía' };
        if (texto.length > 1000) texto = texto.slice(0, 1000);
        // Validar que el perro existe antes de insertar.
        const { data: perro, error: pErr } = await admin.from('perros').select('id, nombre').eq('id', pid).maybeSingle();
        if (pErr) return { error: pErr.message };
        if (!perro) return { error: 'No existe un perro con ese perro_id' };
        const { data, error } = await admin.from('notas_perro')
          .insert({ perro_id: pid, texto }).select('id, creado_en').single();
        if (error) return { error: error.message };
        return { ok: true, guardada: { id: data.id, perro_id: pid, perro: perro.nombre, texto, creado_en: data.creado_en } };
      }
      default:
        return { error: `Herramienta desconocida: ${nombre}` };
    }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

async function handleConversacion(admin: any, userClient: any, body: any, apiKey: string, json: (p: unknown, s?: number) => Response): Promise<Response> {
  const contexto = body?.contexto ?? {};
  const messages: any[] = (Array.isArray(body?.mensajes) ? body.mensajes : [])
    .filter((m: any) => (m?.role === 'user' || m?.role === 'assistant') && typeof m?.content === 'string' && m.content.trim())
    .map((m: any) => ({ role: m.role, content: m.content }))
    .slice(-24);
  if (!messages.length || messages[messages.length - 1].role !== 'user') {
    return json({ ok: false, error: 'No hay un mensaje del usuario' }, 400);
  }

  const ahora = fechaHoraMadrid();
  const sys = SYSTEM_PROMPT_CHAT
    + `\n\nCONTEXTO TEMPORAL (Mallorca, Europe/Madrid): hoy es ${ahora.diaSemana} ${ahora.fecha} y son las ${ahora.hora}. Resuelve "hoy", "mañana", "esta tarde", "la siguiente/próxima", etc. respecto a este momento. "Mañana" es el día siguiente a ${ahora.fecha}.`
    + '\n\nCONTEXTO DE LA PANTALLA ACTUAL: ' + JSON.stringify({
    pantalla: contexto?.pantalla ?? null,
    cliente_id: UUID_RE.test(String(contexto?.cliente_id ?? '')) ? contexto.cliente_id : null,
    perro_id: UUID_RE.test(String(contexto?.perro_id ?? '')) ? contexto.perro_id : null,
  });

  for (let iter = 0; iter < MAX_TOOL_ITERS; iter++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: CHAT_MAX_TOKENS, system: sys, tools: TOOLS, messages }),
    });
    if (!res.ok) {
      const detalle = (await res.text().catch(() => '')).slice(0, 300);
      return json({ ok: false, error: `Error de la IA (${res.status})`, detalle }, 502);
    }
    const data = await res.json();
    const content = Array.isArray(data?.content) ? data.content : [];
    const toolUses = content.filter((b: any) => b.type === 'tool_use');

    if (data?.stop_reason === 'tool_use' && toolUses.length) {
      messages.push({ role: 'assistant', content });
      const results: any[] = [];
      for (const tu of toolUses) {
        const out = await ejecutarHerramienta(admin, userClient, tu.name, tu.input);
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(out) });
      }
      messages.push({ role: 'user', content: results });
      continue;
    }

    const reply = content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('').trim();
    return json({ ok: true, reply: reply || 'No tengo una respuesta para eso ahora mismo.' });
  }
  return json({ ok: true, reply: 'He hecho varias consultas y no consigo cerrar la respuesta. Prueba a reformular la pregunta.' });
}

function buildCors(req: Request): Record<string, string> {
  const origin = req.headers.get('Origin') ?? '';
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}

function armarSC(evals: any[]): any {
  if (!evals || evals.length === 0) return { tiene: false };
  const u = evals[evals.length - 1];
  const dims = [
    { k: 'Física', v: u.score_fisica ?? 0, low: false },
    { k: 'Emocional', v: u.score_emocional ?? 0, low: false },
    { k: 'Social', v: u.score_social ?? 0, low: false },
    { k: 'Cognitiva', v: u.score_cognitiva ?? 0, low: false },
  ];
  let lowIdx = 0;
  dims.forEach((d, i) => { if (d.v < dims[lowIdx].v) lowIdx = i; });
  dims[lowIdx].low = true;
  dims.sort((a, b) => a.v - b.v);
  const f = new Date(u.created_at);
  const fecha = `${String(f.getUTCDate()).padStart(2, '0')}/${String(f.getUTCMonth() + 1).padStart(2, '0')}`;
  return { tiene: true, fecha, total: u.score_total ?? 0, bandera: !!u.bandera_roja, dims };
}

function nombreEjercicio(row: any): string {
  const ea = row?.ejercicios_asignados;
  const e = Array.isArray(ea) ? ea[0]?.ejercicios : ea?.ejercicios;
  const ej = Array.isArray(e) ? e[0] : e;
  return ej?.nombre ?? '';
}

// Arma un resumen ANALÍTICO de los seguimientos de conducta del perro (no
// vuelca marca por marca). Por cada conducta: conteos del mes actual y el
// anterior (verde/amarillo/rojo/total), una tendencia simple comparando el %
// de "verde" entre ambos meses, desde cuándo se registra, y las notas del
// tutor más recientes (que es donde está el "por qué" de cada día).
function armarSeguimientos(seguimientos: any[], regs: any[], now: Date): any[] {
  if (!seguimientos || seguimientos.length === 0) return [];
  const pad = (n: number) => String(n).padStart(2, '0');
  const curKey = `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}`;
  const pm = now.getUTCMonth() === 0
    ? { y: now.getUTCFullYear() - 1, m: 12 }
    : { y: now.getUTCFullYear(), m: now.getUTCMonth() };
  const prevKey = `${pm.y}-${pad(pm.m)}`;

  const bySeg = new Map<string, any[]>();
  for (const r of regs ?? []) {
    if (!bySeg.has(r.seguimiento_id)) bySeg.set(r.seguimiento_id, []);
    bySeg.get(r.seguimiento_id)!.push(r);
  }
  const emptyCount = () => ({ verde: 0, amarillo: 0, rojo: 0, total: 0 });

  return seguimientos.map((s) => {
    const rs = bySeg.get(s.id) ?? [];
    const cur: any = emptyCount();
    const prev: any = emptyCount();
    let desde: string | null = null;
    for (const r of rs) {
      const f = String(r.fecha ?? '');
      if (f && (desde === null || f < desde)) desde = f;
      const bucket = f.slice(0, 7) === curKey ? cur : f.slice(0, 7) === prevKey ? prev : null;
      if (bucket && (r.color === 'verde' || r.color === 'amarillo' || r.color === 'rojo')) {
        bucket[r.color]++;
        bucket.total++;
      }
    }
    const pctVerde = (c: any) => (c.total ? c.verde / c.total : null);
    const pc = pctVerde(cur), pp = pctVerde(prev);
    let tendencia: string;
    if (pc === null) tendencia = 'sin registros este mes';
    else if (pp === null) tendencia = 'sin comparación (mes anterior sin registros)';
    else if (pc > pp + 0.1) tendencia = 'mejora';
    else if (pc < pp - 0.1) tendencia = 'empeora';
    else tendencia = 'estable';

    const notas = rs
      .filter((r) => (r.nota ?? '').trim())
      .sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)))
      .slice(0, 8)
      .map((r) => ({ fecha: r.fecha, color: r.color, nota: r.nota }));

    return {
      conducta: s.nombre,
      descripcion: (s.descripcion ?? '').trim() || null,
      desde,
      mes_actual: cur,
      mes_anterior: prev,
      tendencia,
      notas_recientes: notas,
    };
  });
}

Deno.serve(async (req: Request): Promise<Response> => {
  const cors = buildCors(req);
  const json = (payload: unknown, status = 200): Response =>
    new Response(JSON.stringify(payload), { status, headers: { ...cors, 'content-type': 'application/json' } });

  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ ok: false, error: 'Método no permitido' }, 405);

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
  const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
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
    if (!adminRow) return json({ ok: false, error: 'Solo un administrador puede usar el asistente' }, 403);

    const body = await req.json().catch(() => null);

    // Modo conversación (Entrega 1): si llega historial de mensajes, Jaime
    // responde en lenguaje natural con herramientas de solo lectura (+ la
    // escritura acotada de notas_perro). Si no, cae al modo INFORME clásico
    // (perro_id sin mensajes), intacto.
    if (Array.isArray(body?.mensajes)) {
      // Cliente con el JWT del admin: para RPCs que validan es_admin() por
      // auth.uid() (get_atencion_admin). El resto usa el service role.
      const userClient = createClient(SUPABASE_URL, ANON_KEY, {
        global: { headers: { Authorization: `Bearer ${token}` } },
        auth: { persistSession: false, autoRefreshToken: false },
      });
      return await handleConversacion(admin, userClient, body, ANTHROPIC_API_KEY, json);
    }

    const perroId = String(body?.perro_id ?? '').trim();
    const clienteId = String(body?.cliente_id ?? '').trim();
    if (!UUID_RE.test(perroId)) return json({ ok: false, error: 'Falta el perro' }, 400);

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

    // v4 — NOTAS QUE EL CLIENTE DEJA AL REPORTAR CADA ENTRENO (registros_ejercicio.nota).
    const { data: notasEntreno } = await admin
      .from('registros_ejercicio')
      .select('nota, registrado_en, ejercicios_asignados!inner(perro_id, ejercicios(nombre))')
      .eq('ejercicios_asignados.perro_id', perroId)
      .not('nota', 'is', null)
      .order('registrado_en', { ascending: false }).limit(30);

    // NOTAS de caso de Charly (eventos tipo nota_caso) sobre este perro.
    const { data: notas } = await admin
      .from('eventos')
      .select('payload, created_at')
      .eq('perro_id', perroId).eq('tipo', 'nota_caso')
      .order('created_at', { ascending: false }).limit(20);

    // MENSAJES sueltos del cliente (autor cliente) sobre este perro.
    const { data: mensajes } = await admin
      .from('mensajes')
      .select('contenido, created_at')
      .eq('perro_id', perroId).not('autor_usuario_cliente_id', 'is', null)
      .order('created_at', { ascending: false }).limit(30);

    // SEGUIMIENTOS DE CONDUCTA del perro (semáforo día a día que registra el
    // tutor). Traemos los seguimientos activos y sus registros, y los
    // resumimos analíticamente más abajo (no se vuelca marca por marca).
    const { data: seguimientos } = await admin
      .from('seguimientos_conducta')
      .select('id, nombre, descripcion, creado_en')
      .eq('perro_id', perroId).eq('activo', true)
      .order('creado_en', { ascending: true });

    let regsConducta: any[] = [];
    const segIds = (seguimientos ?? []).map((s: any) => s.id);
    if (segIds.length) {
      const { data: rc } = await admin
        .from('registros_conducta')
        .select('seguimiento_id, fecha, color, nota')
        .in('seguimiento_id', segIds)
        .order('fecha', { ascending: false });
      regsConducta = rc ?? [];
    }
    const seguimientosResumen = armarSeguimientos(seguimientos ?? [], regsConducta, new Date());

    const { data: catalogo } = await admin
      .from('ejercicios')
      .select('id, codigo, nombre, categoria, descripcion')
      .eq('activo', true).order('orden_catalogo', { ascending: true });

    const contexto = [
      'PERRO:', JSON.stringify(perro),
      'CLIENTE:', JSON.stringify(cliente ?? { estado: 'desconocido' }),
      'HISTÓRICO SC (antigua → reciente):', JSON.stringify(evals ?? []),
      'YA ASIGNADOS:', JSON.stringify((asignados ?? []).map((a: any) => a.ejercicios)),
      'CUMPLIMIENTO (últimas prácticas):', JSON.stringify(practicas ?? []),
      'NOTAS DE ENTRENO DEL CLIENTE (reciente primero):', JSON.stringify((notasEntreno ?? []).filter((r: any) => (r.nota ?? '').trim()).map((r: any) => ({ fecha: r.registrado_en, ejercicio: nombreEjercicio(r), texto: r.nota }))),
      'TUS NOTAS DE CASO (reciente primero):', JSON.stringify((notas ?? []).map((n: any) => ({ fecha: n.created_at, texto: n.payload?.texto ?? '' }))),
      'MENSAJES SUELTOS DEL CLIENTE (reciente primero):', JSON.stringify((mensajes ?? []).map((m: any) => ({ fecha: m.created_at, texto: m.contenido ?? '' }))),
      'SEGUIMIENTOS DE CONDUCTA (registrados por el tutor, día a día):', JSON.stringify(seguimientosResumen.length ? seguimientosResumen : 'Sin seguimientos de conducta registrados'),
      'CATÁLOGO DISPONIBLE:', JSON.stringify((catalogo ?? []).map((e: any) => ({ codigo: e.codigo, nombre: e.nombre, categoria: e.categoria, descripcion: e.descripcion }))),
    ].join('\n');

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

    let parsed: any;
    try {
      parsed = JSON.parse(reply.replace(/```json|```/g, '').trim());
    } catch {
      return json({ ok: false, error: 'La IA no devolvió JSON válido', raw: reply.slice(0, 500) }, 502);
    }

    const catByCodigo = new Map((catalogo ?? []).map((e: any) => [e.codigo, e]));
    const sugerencias: any[] = [];
    for (const s of (Array.isArray(parsed.sugerencias) ? parsed.sugerencias : [])) {
      const ej: any = catByCodigo.get(String(s?.codigo ?? ''));
      if (!ej) continue;
      sugerencias.push({ codigo: ej.codigo, id: ej.id, nombre: ej.nombre, por_que: String(s?.por_que ?? '') });
    }

    return json({
      ok: true,
      nombre: perro.nombre,
      sc: armarSC(evals ?? []),
      intro: String(parsed.intro ?? ''),
      estado: Array.isArray(parsed.estado) ? parsed.estado.slice(0, 3).map((x: any) => String(x)) : [],
      sugerencias,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return json({ ok: false, error: `Error inesperado: ${msg}` }, 500);
  }
});
