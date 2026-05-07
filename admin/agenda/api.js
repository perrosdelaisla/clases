// =====================================================================
// admin/agenda/api.js — módulo de la pestaña Agenda del admin unificado.
//
// Propósito: port de hola/supabase.js al SDK supabase-js con sesión Auth
// real (la de clases/admin/). Reemplaza el wrapper REST + anon key
// embebida del repo viejo por queries autenticadas que pasan por las
// policies RLS del proyecto Victoria (sydzfwwiruxqaxojymdz), donde la
// función SQL es_admin() habilita lectura/escritura sobre las tablas
// de agenda al usuario logueado.
//
// Fecha de creación: 2026-05-07
// Branch: feat/admin-unificado
//
// ⚠️ AVISO IMPORTANTE
// ─────────────────────
// Este es el ESQUELETO del Bloque 1.A. TODAS las funciones lanzan
// NOT_IMPLEMENTED hasta que el Bloque 1.B llene el cuerpo con queries
// SDK reales. NO consumir desde la UI todavía — cualquier `await` a
// estas funciones tirará una excepción explícita en runtime.
//
// Las firmas son IDÉNTICAS a las de hola/supabase.js para que el port
// del cuerpo sea mecánico (no requiere cambios en quien llame). La
// equivalencia de cada función con su línea original en hola/supabase.js
// está anotada en su JSDoc.
// =====================================================================

import { supabase } from '../../js/supabase.js';

// ────────────────────────────────────────────────────────────────────
// PLANTILLA SEMANAL DE SLOTS
// ────────────────────────────────────────────────────────────────────

/**
 * Obtiene la plantilla semanal de slots, ordenada por día y hora.
 *
 * @returns {Promise<Array<{id:string, dia_semana:number, hora:string, activo:boolean}>>}
 *   Array de slots; vacío si no hay plantilla cargada.
 *   - dia_semana: 0=domingo … 6=sábado (convención Date.getDay()).
 *   - hora: formato 'HH:MM:SS' (string, no Date).
 *   - activo: true si el slot se ofrece a clientes; false si está
 *     pausado pero conservado para no perder histórico.
 *
 * @throws {Error} Si la query falla (red, RLS, etc.). El llamador
 *   debe envolver en try/catch para mostrar feedback al admin.
 *
 * @example
 *   const slots = await obtenerPlantilla();
 *   console.log(`${slots.length} slots configurados`);
 *
 * Tabla(s) Supabase: slots (SELECT)
 * RLS requerido: es_admin() = true (admin logueado en clases/admin/)
 * Equivalencia hola/supabase.js: línea 116
 */
export async function obtenerPlantilla() {
    throw new Error('NOT_IMPLEMENTED — Bloque 1.B pendiente: SELECT id, dia_semana, hora, activo FROM slots ORDER BY dia_semana, hora');
}

/**
 * Añade un slot nuevo a la plantilla semanal. Idempotente: si ya
 * existe un slot con ese (dia_semana, hora), devuelve el existente
 * sin crear duplicado.
 *
 * @param {number} dia_semana - 0=domingo … 6=sábado.
 *   Ejemplo: 1 (lunes).
 * @param {string} hora - Hora en formato 'HH:MM:SS' o 'HH:MM'.
 *   El original acepta ambos; el cuerpo del Bloque 1.B normaliza.
 *   Ejemplo: '18:30:00' o '18:30'.
 *
 * @returns {Promise<{id:string, dia_semana:number, hora:string, activo:boolean}>}
 *   Slot creado o el preexistente. Siempre con activo=true por default
 *   en caso de creación nueva.
 *
 * @throws {Error} Si el INSERT falla por RLS o constraint.
 *
 * @example
 *   const slot = await añadirSlotPlantilla(1, '18:30');
 *
 * Tabla(s) Supabase: slots (SELECT preflight, INSERT si no existe)
 * RLS requerido: es_admin() = true
 * Equivalencia hola/supabase.js: línea 120
 */
export async function añadirSlotPlantilla(dia_semana, hora) {
    throw new Error('NOT_IMPLEMENTED — Bloque 1.B pendiente: SELECT eq dia_semana,hora; si vacío INSERT con activo=true');
}

/**
 * Borra físicamente un slot de la plantilla. Operación destructiva:
 * si querés conservar histórico, usar toggleSlotActivo(id, false).
 *
 * @param {string} id - UUID del slot.
 *   Ejemplo: '7c2e1f3a-…'.
 *
 * @returns {Promise<void>} Sin valor de retorno — fail-silent vía throw.
 *
 * @throws {Error} Si el DELETE falla por RLS o si el id no existe
 *   (Supabase no falla por id inexistente — devuelve 0 filas; el
 *   Bloque 1.B definirá si tratamos eso como error o como no-op).
 *
 * @example
 *   await eliminarSlotPlantilla(slot.id);
 *
 * Tabla(s) Supabase: slots (DELETE)
 * RLS requerido: es_admin() = true
 * Equivalencia hola/supabase.js: línea 135
 */
export async function eliminarSlotPlantilla(id) {
    throw new Error('NOT_IMPLEMENTED — Bloque 1.B pendiente: DELETE FROM slots WHERE id = $1');
}

/**
 * Cambia el flag activo de un slot sin borrarlo. Permite pausar y
 * reanudar sin perder el histórico de citas asociadas.
 *
 * @param {string} id - UUID del slot.
 *   Ejemplo: '7c2e1f3a-…'.
 * @param {boolean} activo - true para activar, false para pausar.
 *
 * @returns {Promise<void>} Sin valor de retorno.
 *
 * @throws {Error} Si el UPDATE falla por RLS.
 *
 * @example
 *   await toggleSlotActivo(slot.id, false);
 *
 * Tabla(s) Supabase: slots (UPDATE)
 * RLS requerido: es_admin() = true
 * Equivalencia hola/supabase.js: línea 139
 */
export async function toggleSlotActivo(id, activo) {
    throw new Error('NOT_IMPLEMENTED — Bloque 1.B pendiente: UPDATE slots SET activo = $2 WHERE id = $1');
}

// ────────────────────────────────────────────────────────────────────
// BLOQUEOS PUNTUALES
// ────────────────────────────────────────────────────────────────────

/**
 * Lista los bloqueos vigentes de hoy en adelante, ordenados por fecha
 * ascendente. NO trae bloqueos pasados (filtrar lado servidor).
 *
 * @returns {Promise<Array<{id:string, fecha:string, hora:string|null, motivo:string}>>}
 *   - fecha: 'YYYY-MM-DD'.
 *   - hora: 'HH:MM:SS' si es bloqueo de slot puntual; null si es día
 *     completo bloqueado.
 *   - motivo: string libre. Convención: prefijo 'Auto:' indica bloqueo
 *     auto-generado por crearCitaManual; el resto son manuales.
 *
 * @throws {Error} Si la query falla.
 *
 * @example
 *   const bloqueos = await obtenerBloqueos();
 *
 * Tabla(s) Supabase: bloqueos (SELECT con filtro fecha >= hoy)
 * RLS requerido: es_admin() = true
 * Equivalencia hola/supabase.js: línea 163
 */
export async function obtenerBloqueos() {
    throw new Error('NOT_IMPLEMENTED — Bloque 1.B pendiente: SELECT * FROM bloqueos WHERE fecha >= hoy ORDER BY fecha');
}

/**
 * Crea un bloqueo nuevo. Si se pasa hora, el bloqueo es de un slot
 * puntual; si no, es de día completo.
 *
 * @param {string} fecha - 'YYYY-MM-DD'.
 *   Ejemplo: '2026-05-12'.
 * @param {string} [motivo=''] - Texto libre. Default: string vacío
 *   (NO null — el original mete '' en el INSERT).
 *   Ejemplo: 'Vacaciones', 'Cita médica'.
 * @param {string|null} [hora=null] - 'HH:MM' o 'HH:MM:SS'. Si es null
 *   (default), el bloqueo aplica a todo el día. El cuerpo del Bloque
 *   1.B normaliza 'HH:MM' → 'HH:MM:00'.
 *
 * @returns {Promise<void>} Sin valor de retorno.
 *
 * @throws {Error} Si el INSERT falla por RLS o constraint.
 *
 * @example
 *   await bloquearDia('2026-05-12', 'Vacaciones');
 *   await bloquearDia('2026-05-15', 'Médico', '10:00');
 *
 * Tabla(s) Supabase: bloqueos (INSERT)
 * RLS requerido: es_admin() = true
 * Equivalencia hola/supabase.js: línea 147
 */
export async function bloquearDia(fecha, motivo = '', hora = null) {
    throw new Error('NOT_IMPLEMENTED — Bloque 1.B pendiente: INSERT INTO bloqueos (fecha, motivo, hora?) — normalizar hora HH:MM → HH:MM:00');
}

/**
 * Borra un bloqueo por id (no por fecha). Se usa cuando el admin
 * quiere desbloquear un slot puntual que ya no aplica.
 *
 * @param {string} id - UUID del bloqueo.
 *
 * @returns {Promise<void>} Sin valor de retorno.
 *
 * @throws {Error} Si el DELETE falla por RLS.
 *
 * @example
 *   await eliminarBloqueo(bloq.id);
 *
 * Tabla(s) Supabase: bloqueos (DELETE)
 * RLS requerido: es_admin() = true
 * Equivalencia hola/supabase.js: línea 155
 */
export async function eliminarBloqueo(id) {
    throw new Error('NOT_IMPLEMENTED — Bloque 1.B pendiente: DELETE FROM bloqueos WHERE id = $1');
}

// ────────────────────────────────────────────────────────────────────
// CITAS — LISTADO + ACCIONES DE ESTADO
// ────────────────────────────────────────────────────────────────────

/**
 * Lista las citas vigentes (de hoy en adelante) con datos del cliente,
 * sus perros, y un campo derivado `reportado` con un resumen del texto
 * que el cliente escribió a Victoria al cerrar la cita (extraído de la
 * tabla conversaciones).
 *
 * Hace 2 queries en cadena:
 *   1) citas + clientes(nombre,telefono,zona,perros(...))
 *   2) conversaciones para los cita_id de la primera query
 *
 * El campo `reportado` se calcula del lado cliente tomando los 2
 * mensajes más largos del cliente (rol='cliente') entre los primeros
 * 4 turnos de la conversación, concatenados con ' · ' y truncados a
 * 400 chars.
 *
 * @returns {Promise<Array<{
 *   id: string,
 *   fecha: string,
 *   hora: string,
 *   estado: 'confirmada'|'cancelada'|'realizada'|string,
 *   modalidad?: string,
 *   zona?: string,
 *   notas?: string,
 *   confirmada?: boolean,
 *   clientes: { nombre:string, telefono:string, zona?:string,
 *               perros: Array<{nombre:string, raza?:string, edad?:string, problematica?:string}> },
 *   reportado: string|null
 * }>>}
 *   Array vacío si no hay citas. El resto de columnas de citas viaja
 *   con `select=*` — el shape exacto depende del schema actual.
 *
 * @throws {Error} Si la query principal de citas falla. Si falla la
 *   query secundaria de conversaciones, el original lo trata como
 *   campo `reportado: null` por cita; revisar comportamiento en 1.B.
 *
 * @example
 *   const citas = await obtenerCitasAdminConReportado();
 *   citas.forEach(c => console.log(c.fecha, c.clientes.nombre, c.reportado));
 *
 * Tabla(s) Supabase: citas (SELECT con join clientes(perros)),
 *                    conversaciones (SELECT cita_id, turnos)
 * RLS requerido: es_admin() = true en ambas tablas
 * Equivalencia hola/supabase.js: línea 179
 */
export async function obtenerCitasAdminConReportado() {
    throw new Error('NOT_IMPLEMENTED — Bloque 1.B pendiente: SELECT citas + join clientes(perros) + 2da query conversaciones; agregar reportado en cliente');
}

/**
 * Cambia el estado de una cita a 'confirmada'. Atajo del flujo donde
 * el admin acepta una cita pendiente.
 *
 * @param {string} citaId - UUID de la cita.
 *
 * @returns {Promise<void>} Sin valor de retorno.
 *
 * @throws {Error} Si el UPDATE falla por RLS.
 *
 * @example
 *   await confirmarCita(cita.id);
 *
 * Tabla(s) Supabase: citas (UPDATE estado='confirmada')
 * RLS requerido: es_admin() = true
 * Equivalencia hola/supabase.js: línea 212
 */
export async function confirmarCita(citaId) {
    throw new Error('NOT_IMPLEMENTED — Bloque 1.B pendiente: UPDATE citas SET estado = \'confirmada\' WHERE id = $1');
}

/**
 * Cambia el estado de una cita a 'cancelada'. NO borra la fila —
 * mantiene histórico para el feed iCalendar y stats.
 *
 * @param {string} citaId - UUID de la cita.
 *
 * @returns {Promise<void>} Sin valor de retorno.
 *
 * @throws {Error} Si el UPDATE falla por RLS.
 *
 * @example
 *   await cancelarCita(cita.id);
 *
 * Tabla(s) Supabase: citas (UPDATE estado='cancelada')
 * RLS requerido: es_admin() = true
 * Equivalencia hola/supabase.js: línea 216
 */
export async function cancelarCita(citaId) {
    throw new Error('NOT_IMPLEMENTED — Bloque 1.B pendiente: UPDATE citas SET estado = \'cancelada\' WHERE id = $1');
}

/**
 * Marca la cita como 'realizada' (Charly ya dio la clase). NO borra
 * la fila. En el feed iCalendar muestra ✅ vs 🟡 (confirmada).
 *
 * @param {string} citaId - UUID de la cita.
 *
 * @returns {Promise<void>} Sin valor de retorno.
 *
 * @throws {Error} Si el UPDATE falla por RLS.
 *
 * @example
 *   await marcarCitaRealizada(cita.id);
 *
 * Tabla(s) Supabase: citas (UPDATE estado='realizada')
 * RLS requerido: es_admin() = true
 * Equivalencia hola/supabase.js: línea 226
 */
export async function marcarCitaRealizada(citaId) {
    throw new Error('NOT_IMPLEMENTED — Bloque 1.B pendiente: UPDATE citas SET estado = \'realizada\' WHERE id = $1');
}

/**
 * Borra una cita por completo. Operación destructiva — el admin la
 * usa cuando quiere quitar del calendario una cita ya realizada o
 * cancelada que no necesita seguir viendo.
 *
 * @param {string} citaId - UUID de la cita.
 *
 * @returns {Promise<void>} Sin valor de retorno.
 *
 * @throws {Error} Si el DELETE falla por RLS o constraint FK.
 *
 * @example
 *   await eliminarCita(cita.id);
 *
 * Tabla(s) Supabase: citas (DELETE)
 * RLS requerido: es_admin() = true
 * Equivalencia hola/supabase.js: línea 235
 */
export async function eliminarCita(citaId) {
    throw new Error('NOT_IMPLEMENTED — Bloque 1.B pendiente: DELETE FROM citas WHERE id = $1');
}

// ────────────────────────────────────────────────────────────────────
// CITA MANUAL — CADENA CLIENTE → PERRO → CITA → BLOQUEO
// ────────────────────────────────────────────────────────────────────

/**
 * Crea cliente + perro + cita + bloqueo en una sola operación
 * coordinada. Pensado para el caso "Charly cierra una clase por fuera
 * del flujo del chatbot" (manual desde el admin).
 *
 * Hace 4 INSERT secuenciales con rollback DELETE manual ante fallo.
 * Si falla el bloqueo (paso 4), la cita queda igual — el bloqueo se
 * puede recrear a mano. Ver ítem 1 de DEUDA_TECNICA.md sobre la
 * naturaleza no-transaccional del rollback.
 *
 * Internamente equivale a encadenar (no llama a las funciones de
 * arriba — replica la lógica para mantener el rollback):
 *   POST clientes → POST perros → POST citas → POST bloqueos.
 *
 * @param {{
 *   cliente: { nombre:string, telefono:string },
 *   perro:   { nombre:string, raza?:string, edad_meses?:number,
 *              peso_kg?:number, es_ppp?:boolean, problematica?:string },
 *   cita:    { fecha:string, hora:string, modalidad?:string,
 *              zona?:string, notas?:string }
 * }} datos - Payload completo. Campos obligatorios:
 *   cliente.nombre, cliente.telefono, perro.nombre, cita.fecha, cita.hora.
 *
 * @returns {Promise<
 *   { ok: true,  clienteId:string, perroId:string, citaId:string } |
 *   { ok: false, error: string }
 * >} Resultado defensivo: NUNCA tira excepción al llamador. Los
 *   errores se envuelven en `{ ok:false, error }` y la función
 *   intenta rollback de lo que sí se creó.
 *
 * @throws Nunca. Errores → `{ ok:false, error }`.
 *
 * @example
 *   const res = await crearCitaManual({
 *     cliente: { nombre:'Vicky', telefono:'622922173' },
 *     perro:   { nombre:'Coco', raza:'Mestizo', edad_meses:18 },
 *     cita:    { fecha:'2026-05-12', hora:'18:30', modalidad:'presencial', zona:'Palma' }
 *   });
 *   if (!res.ok) toast(res.error);
 *
 * Tabla(s) Supabase: clientes (INSERT, DELETE rollback),
 *                    perros   (INSERT, DELETE rollback),
 *                    citas    (INSERT, DELETE rollback),
 *                    bloqueos (INSERT best-effort, sin rollback)
 * RLS requerido: es_admin() = true en las 4 tablas
 * Equivalencia hola/supabase.js: línea 258
 */
export async function crearCitaManual(datos) {
    throw new Error('NOT_IMPLEMENTED — Bloque 1.B pendiente: cadena INSERT clientes→perros→citas→bloqueos con rollback DELETE inverso');
}

// ────────────────────────────────────────────────────────────────────
// HELPERS DE LECTURA PARA UI
// ────────────────────────────────────────────────────────────────────

/**
 * Dado un array de UUIDs de citas, devuelve un mapa
 * { [uuid]: nombreCliente } para que el admin pueda mostrar nombres
 * en lugar de UUIDs (ej: en bloqueos auto-generados con motivo
 * 'Auto: cita {uuid}', el admin resuelve el uuid → nombre).
 *
 * @param {string[]} citaIds - Array de UUIDs. Vacío → devuelve {}.
 *
 * @returns {Promise<Object<string,string>>} Mapa cita_id → nombre.
 *   Si una cita no tiene cliente o el cliente no tiene nombre, NO
 *   aparece en el mapa (no se incluye con valor null).
 *
 * @throws {Error} Si la query falla.
 *
 * @example
 *   const mapa = await obtenerNombresCitasPorIds(['uuid1','uuid2']);
 *   console.log(mapa['uuid1']); // 'Vicky'
 *
 * Tabla(s) Supabase: citas (SELECT id, clientes(nombre))
 * RLS requerido: es_admin() = true
 * Equivalencia hola/supabase.js: línea 345
 */
export async function obtenerNombresCitasPorIds(citaIds) {
    throw new Error('NOT_IMPLEMENTED — Bloque 1.B pendiente: SELECT id, clientes(nombre) FROM citas WHERE id IN (...)');
}

// ────────────────────────────────────────────────────────────────────
// ESTADÍSTICAS
// ────────────────────────────────────────────────────────────────────

/**
 * Obtiene las sesiones del chatbot Victoria en un rango de fechas
 * para alimentar la pestaña Estadísticas. Excluye sesiones de prueba
 * (es_prueba=true). Ordenadas por inicio descendente.
 *
 * Comportamiento defensivo: si la query falla, NO tira excepción —
 * loguea el error y devuelve []. El llamador recibe array vacío y
 * decide cómo mostrarlo (típicamente "Sin datos en el rango").
 *
 * @param {string} desde - 'YYYY-MM-DD' o ISO timestamp. Inclusive.
 *   Ejemplo: '2026-05-01'.
 * @param {string} hasta - 'YYYY-MM-DD' o ISO timestamp. Inclusive.
 *   Ejemplo: '2026-05-31'.
 *
 * @returns {Promise<Array<Object>>} Array de filas de la tabla
 *   sesiones (`select=*`). Forma exacta depende del schema vigente
 *   y la consume admin.js viejo en `_cargarDatosStats`. Devuelve []
 *   en error o si no hay sesiones en el rango.
 *
 * @throws Nunca (try/catch interno → []).
 *
 * @example
 *   const sesiones = await obtenerSesionesParaStats('2026-05-01', '2026-05-31');
 *
 * Tabla(s) Supabase: sesiones (SELECT con filtro inicio gte/lte + es_prueba=false)
 * RLS requerido: es_admin() = true
 * Equivalencia hola/supabase.js: línea 364
 */
export async function obtenerSesionesParaStats(desde, hasta) {
    throw new Error('NOT_IMPLEMENTED — Bloque 1.B pendiente: SELECT * FROM sesiones WHERE inicio BETWEEN $1 AND $2 AND es_prueba=false ORDER BY inicio DESC; try/catch → []');
}
