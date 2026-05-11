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
// Estado: Bloque 1.B completado. Las 15 funciones están implementadas
// con el SDK supabase-js + sesión Auth real. La validación end-to-end
// se documenta en TESTING_BLOQUE_1B.md.
//
// Las firmas son IDÉNTICAS a las de hola/supabase.js para que el port
// haya sido mecánico (no requiere cambios en quien llame). La
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
    const { data, error } = await supabase
        .from('slots')
        .select('*')
        .order('dia_semana', { ascending: true })
        .order('hora', { ascending: true });
    if (error) throw error;
    return data || [];
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
    const { data: existentes, error: errSel } = await supabase
        .from('slots')
        .select('*')
        .eq('dia_semana', dia_semana)
        .eq('hora', hora);
    if (errSel) throw errSel;
    if (existentes && existentes.length > 0) return existentes[0];

    const { data: creado, error: errIns } = await supabase
        .from('slots')
        .insert({ dia_semana, hora, activo: true })
        .select()
        .single();
    if (errIns) throw errIns;
    return creado;
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
    const { error } = await supabase
        .from('slots')
        .delete()
        .eq('id', id);
    if (error) throw error;
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
    const { error } = await supabase
        .from('slots')
        .update({ activo })
        .eq('id', id);
    if (error) throw error;
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
    const hoy = new Date().toISOString().split('T')[0];
    const { data, error } = await supabase
        .from('bloqueos')
        .select('*')
        .gte('fecha', hoy)
        .order('fecha', { ascending: true });
    if (error) throw error;
    return data || [];
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
    const body = { fecha, motivo };
    if (hora) {
        body.hora = hora.length === 5 ? `${hora}:00` : hora;
    }
    const { error } = await supabase
        .from('bloqueos')
        .insert(body);
    if (error) throw error;
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
    const { error } = await supabase
        .from('bloqueos')
        .delete()
        .eq('id', id);
    if (error) throw error;
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
    const hoy = new Date().toISOString().split('T')[0];

    // 1) Citas futuras con clientes y sus perros
    const { data: citas, error: errCitas } = await supabase
        .from('citas')
        .select('*, clientes(nombre, telefono, zona, perros(nombre, raza, edad_meses, problematica))')
        .gte('fecha', hoy)
        .order('fecha', { ascending: true })
        .order('hora', { ascending: true });
    if (errCitas) throw errCitas;
    if (!citas || citas.length === 0) return [];

    // 2) Conversaciones de esas citas (para extraer "reportado")
    const ids = citas.map(c => c.id);
    const { data: conversaciones, error: errConv } = await supabase
        .from('conversaciones')
        .select('cita_id, turnos')
        .in('cita_id', ids);
    if (errConv) throw errConv;

    // 3) Construir mapa cita_id -> reportado (mismo algoritmo que hola/supabase.js:188)
    const reportadoPorCita = {};
    (conversaciones || []).forEach(conv => {
        const turnos = Array.isArray(conv.turnos) ? conv.turnos : [];
        const mensajesCliente = turnos
            .filter(t => t.rol === 'cliente')
            .slice(0, 4)
            .map(t => t.texto);
        const ordenadosPorLongitud = mensajesCliente
            .slice()
            .sort((a, b) => (b?.length || 0) - (a?.length || 0));
        reportadoPorCita[conv.cita_id] = ordenadosPorLongitud
            .slice(0, 2)
            .join(' · ')
            .slice(0, 400) || null;
    });

    // 4) Mergear: cada cita lleva su reportado (o null)
    return citas.map(cita => ({
        ...cita,
        reportado: reportadoPorCita[cita.id] || null,
    }));
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
    const { error } = await supabase
        .from('citas')
        .update({ estado: 'confirmada' })
        .eq('id', citaId);
    if (error) throw error;
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
    const { error } = await supabase
        .from('citas')
        .update({ estado: 'cancelada' })
        .eq('id', citaId);
    if (error) throw error;
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
    const { error } = await supabase
        .from('citas')
        .update({ estado: 'realizada' })
        .eq('id', citaId);
    if (error) throw error;
}

/**
 * Actualiza una cita con un parche parcial de campos editables.
 * Mismo patrón que confirmarCita/cancelarCita/marcarCitaRealizada
 * (UPDATE directo con RLS es_admin()=true), pero permite múltiples
 * columnas en un solo round-trip. Usado por el modal "editar cita"
 * del admin.
 *
 * Solo deben pasarse columnas presentes en el modal — el resto de la
 * fila no se toca. El trigger DB trg_sync_bloqueo_desde_cita se ocupa
 * de sincronizar el bloqueo asociado si cambian fecha/hora.
 *
 * @param {string} citaId - UUID de la cita.
 * @param {Object} parches - Subset de columnas de citas a actualizar.
 *   Campos esperados (todos opcionales): fecha, hora, cliente_id,
 *   modalidad, zona, notas, estado, numero_clase.
 *
 * @returns {Promise<void>} Sin valor de retorno.
 *
 * @throws {Error} Si el UPDATE falla por RLS o constraint.
 *
 * Tabla(s) Supabase: citas (UPDATE)
 * RLS requerido: es_admin() = true
 */
export async function actualizarCita(citaId, parches) {
    const { error } = await supabase
        .from('citas')
        .update(parches)
        .eq('id', citaId);
    if (error) throw error;
}

/**
 * Trae la lista completa de clientes (todos los estados) ordenada por
 * nombre, pensada para alimentar un <select> en el modal editar cita.
 * En el Paso C se reemplazará por un autocomplete con la misma forma
 * de datos, así que el llamador no debería romperse.
 *
 * @returns {Promise<Array<{id:string, nombre:string, telefono:string, estado:string}>>}
 *
 * @throws {Error} Si la query falla.
 *
 * Tabla(s) Supabase: clientes (SELECT id, nombre, telefono, estado)
 * RLS requerido: es_admin() = true
 */
export async function obtenerClientesParaSelect() {
    const { data, error } = await supabase
        .from('clientes')
        .select('id, nombre, telefono, estado')
        .order('nombre', { ascending: true });
    if (error) throw error;
    return data || [];
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
    const { error } = await supabase
        .from('citas')
        .delete()
        .eq('id', citaId);
    if (error) throw error;
}

// ────────────────────────────────────────────────────────────────────
// CITA MANUAL — CADENA CLIENTE → PERRO → CITA → BLOQUEO
// ────────────────────────────────────────────────────────────────────

/**
 * Crea cliente + perro + cita + bloqueo en una sola operación
 * coordinada. Pensado para el caso "Charly cierra una clase por fuera
 * del flujo del chatbot" (manual desde el admin).
 *
 * Hace 3 INSERT secuenciales (clientes → perros → citas) con rollback
 * DELETE manual ante fallo. Ver ítem 1 de DEUDA_TECNICA.md sobre la
 * naturaleza no-transaccional del rollback.
 *
 * El bloqueo asociado lo crea automáticamente el trigger DB
 * trg_sync_bloqueo_desde_cita al insertar la cita. NO insertarlo
 * manualmente desde aquí — duplica y dispara 409 Conflict.
 *
 * Internamente equivale a encadenar (no llama a las funciones de
 * arriba — replica la lógica para mantener el rollback):
 *   POST clientes → POST perros → POST citas.
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
 *                    citas    (INSERT, DELETE rollback)
 *                    [bloqueos lo escribe el trigger DB, no este código]
 * RLS requerido: es_admin() = true en las 3 tablas
 * Equivalencia hola/supabase.js: línea 258
 */
export async function crearCitaManual(datos) {
    const { cliente, perro, cita } = datos || {};
    if (!cliente?.nombre || !cliente?.telefono) return { ok: false, error: 'Faltan datos de cliente' };
    if (!perro?.nombre)                          return { ok: false, error: 'Falta nombre del perro' };
    if (!cita?.fecha || !cita?.hora)             return { ok: false, error: 'Falta fecha u hora' };

    const horaCompleta = cita.hora.length === 5 ? `${cita.hora}:00` : cita.hora;
    let clienteId = null, perroId = null, citaId = null;

    try {
        // 1) Cliente
        const clienteBody = { nombre: cliente.nombre, telefono: cliente.telefono, estado: 'consulta' };
        if (cita.zona) clienteBody.zona = cita.zona;
        const { data: clienteData, error: errC } = await supabase
            .from('clientes')
            .insert(clienteBody)
            .select()
            .single();
        if (errC) throw errC;
        clienteId = clienteData?.id;
        if (!clienteId) throw new Error('No se pudo crear el cliente');

        // 2) Perro
        const perroBody = { cliente_id: clienteId, nombre: perro.nombre };
        if (perro.raza)               perroBody.raza = perro.raza;
        if (perro.edad_meses != null) perroBody.edad_meses = perro.edad_meses;
        if (perro.peso_kg != null)    perroBody.peso_kg = perro.peso_kg;
        if (perro.es_ppp)             perroBody.es_ppp = true;
        if (perro.problematica)       perroBody.problematica = perro.problematica;
        const { data: perroData, error: errP } = await supabase
            .from('perros')
            .insert(perroBody)
            .select()
            .single();
        if (errP) throw errP;
        perroId = perroData?.id;
        if (!perroId) throw new Error('No se pudo crear el perro');

        // 3) Cita
        // NOTA: el trigger DB trg_sync_bloqueo_desde_cita crea automáticamente
        // un bloqueo asociado a esta cita. No insertar bloqueo manualmente —
        // hacerlo aquí dispara 409 Conflict por (fecha, hora) ya ocupado.
        const citaBody = { cliente_id: clienteId, fecha: cita.fecha, hora: horaCompleta, estado: 'confirmada', confirmada: true };
        if (cita.modalidad) citaBody.modalidad = cita.modalidad;
        if (cita.zona)      citaBody.zona = cita.zona;
        if (cita.notas)     citaBody.notas = cita.notas;
        if (cita.numero_clase != null) citaBody.numero_clase = cita.numero_clase;
        const { data: citaData, error: errCi } = await supabase
            .from('citas')
            .insert(citaBody)
            .select()
            .single();
        if (errCi) throw errCi;
        citaId = citaData?.id;
        if (!citaId) throw new Error('No se pudo crear la cita');

        return { ok: true, clienteId, perroId, citaId };
    } catch (err) {
        // Rollback inverso (mismo comportamiento que original)
        try { if (citaId)    await supabase.from('citas').delete().eq('id', citaId); } catch (e) {}
        try { if (perroId)   await supabase.from('perros').delete().eq('id', perroId); } catch (e) {}
        try { if (clienteId) await supabase.from('clientes').delete().eq('id', clienteId); } catch (e) {}
        return { ok: false, error: err.message };
    }
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
    if (!citaIds || citaIds.length === 0) return {};
    const { data: citas, error } = await supabase
        .from('citas')
        .select('id, clientes(nombre)')
        .in('id', citaIds);
    if (error) throw error;
    const mapa = {};
    (citas || []).forEach(c => {
        if (c.clientes?.nombre) mapa[c.id] = c.clientes.nombre;
    });
    return mapa;
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
    try {
        const { data, error } = await supabase
            .from('sesiones')
            .select('*')
            .gte('inicio', desde)
            .lte('inicio', hasta)
            .eq('es_prueba', false)
            .order('inicio', { ascending: false });
        if (error) throw error;
        return data || [];
    } catch (err) {
        console.error('Error al obtener sesiones para stats:', err);
        return [];
    }
}
