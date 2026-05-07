// =====================================================================
// admin/stats/api.js — queries de la pestaña Stats.
//
// Consume el cliente Supabase autenticado de clases/js/supabase.js.
// Filtra es_prueba IS NOT TRUE en TODA query a sesiones (Charly tiene
// 126 sesiones de prueba en DB que no deben contarse).
// =====================================================================

import { supabase } from '../../js/supabase.js';

// Filtro NULL OR FALSE — descarta es_prueba=true sin descartar NULLs.
function aplicarFiltroNoPrueba(query) {
    return query.or('es_prueba.is.null,es_prueba.eq.false');
}

function aplicarRangoSesiones(query, rango) {
    if (rango?.desde) query = query.gte('inicio', rango.desde);
    if (rango?.hasta) query = query.lte('inicio', rango.hasta + 'T23:59:59');
    return query;
}

function aplicarRangoCitas(query, rango) {
    if (rango?.desde) query = query.gte('created_at', rango.desde);
    if (rango?.hasta) query = query.lte('created_at', rango.hasta + 'T23:59:59');
    return query;
}

/** KPIs: sesiones reales / citas / conversión / clientes activos */
export async function obtenerKPIs(rango) {
    let qS = supabase.from('sesiones').select('id', { count: 'exact', head: true });
    qS = aplicarFiltroNoPrueba(qS);
    qS = aplicarRangoSesiones(qS, rango);
    const { count: sesReales, error: e1 } = await qS;
    if (e1) throw e1;

    let qC = supabase.from('citas').select('id', { count: 'exact', head: true })
        .in('estado', ['confirmada', 'realizada']);
    qC = aplicarRangoCitas(qC, rango);
    const { count: citas, error: e2 } = await qC;
    if (e2) throw e2;

    let qConv = supabase.from('sesiones').select('id', { count: 'exact', head: true })
        .eq('cita_confirmada', true);
    qConv = aplicarFiltroNoPrueba(qConv);
    qConv = aplicarRangoSesiones(qConv, rango);
    const { count: conCita, error: e3 } = await qConv;
    if (e3) throw e3;

    const conversion_pct = sesReales > 0 ? Math.round((conCita / sesReales) * 100) : 0;

    const { count: activos, error: e4 } = await supabase.from('clientes')
        .select('id', { count: 'exact', head: true }).eq('estado', 'activo');
    if (e4) throw e4;

    return {
        sesiones_reales: sesReales || 0,
        citas_confirmadas: citas || 0,
        conversion_pct,
        clientes_activos: activos || 0,
    };
}

/** Funnel Victoria — 7 etapas */
export async function obtenerFunnelVictoria(rango) {
    let q = supabase.from('sesiones')
        .select('vio_mensaje_principal, vio_precio, abrio_agenda, eligio_slot, llego_a_pago, cita_confirmada');
    q = aplicarFiltroNoPrueba(q);
    q = aplicarRangoSesiones(q, rango);
    const { data, error } = await q;
    if (error) throw error;

    const total = data.length;
    return [
        { etapa: 'Sesiones totales',      n: total },
        { etapa: 'Vio mensaje principal', n: data.filter((s) => s.vio_mensaje_principal).length },
        { etapa: 'Vio precio',            n: data.filter((s) => s.vio_precio).length },
        { etapa: 'Abrió agenda',          n: data.filter((s) => s.abrio_agenda).length },
        { etapa: 'Eligió slot',           n: data.filter((s) => s.eligio_slot).length },
        { etapa: 'Llegó a pago',          n: data.filter((s) => s.llego_a_pago).length },
        { etapa: 'Confirmó cita',         n: data.filter((s) => s.cita_confirmada).length },
    ];
}

/** Doughnut 1: Tema preseleccionado */
export async function obtenerDistribucionTema(rango) {
    let q = supabase.from('sesiones').select('tema_preseleccionado');
    q = aplicarFiltroNoPrueba(q);
    q = aplicarRangoSesiones(q, rango);
    const { data, error } = await q;
    if (error) throw error;

    const map = new Map();
    data.forEach((r) => {
        const key = r.tema_preseleccionado || '(directo / sin tema)';
        map.set(key, (map.get(key) || 0) + 1);
    });
    return [...map.entries()].map(([label, n]) => ({ label, n })).sort((a, b) => b.n - a.n);
}

/** Doughnut 2: Modalidad */
export async function obtenerDistribucionModalidad(rango) {
    let q = supabase.from('sesiones').select('modalidad');
    q = aplicarFiltroNoPrueba(q);
    q = aplicarRangoSesiones(q, rango);
    const { data, error } = await q;
    if (error) throw error;

    const map = new Map();
    data.forEach((r) => {
        const key = r.modalidad || '(sin dato)';
        map.set(key, (map.get(key) || 0) + 1);
    });
    return [...map.entries()].map(([label, n]) => ({ label, n })).sort((a, b) => b.n - a.n);
}

/** Doughnut 3: Origen del tráfico */
export async function obtenerDistribucionOrigen(rango) {
    let q = supabase.from('sesiones').select('origen');
    q = aplicarFiltroNoPrueba(q);
    q = aplicarRangoSesiones(q, rango);
    const { data, error } = await q;
    if (error) throw error;

    const map = new Map();
    data.forEach((r) => {
        const key = r.origen || '(directo)';
        map.set(key, (map.get(key) || 0) + 1);
    });
    return [...map.entries()].map(([label, n]) => ({ label, n })).sort((a, b) => b.n - a.n);
}

/** Doughnut 4: Estado actual de clientes (fotografía hoy, sin rango) */
export async function obtenerDistribucionClientes() {
    const { data, error } = await supabase.from('clientes').select('estado');
    if (error) throw error;

    const map = new Map();
    data.forEach((r) => {
        const key = r.estado || '(sin dato)';
        map.set(key, (map.get(key) || 0) + 1);
    });
    const orden = ['consulta', 'activo', 'mantenimiento', 'inactivo'];
    return [...map.entries()]
        .map(([label, n]) => ({ label, n }))
        .sort((a, b) => orden.indexOf(a.label) - orden.indexOf(b.label));
}

/** Citas por mes (últimos 12 meses, confirmadas + realizadas) */
export async function obtenerCitasPorMes() {
    const desde = new Date();
    desde.setMonth(desde.getMonth() - 11);
    desde.setDate(1);
    const desdeStr = desde.toISOString().slice(0, 10);

    const { data, error } = await supabase.from('citas')
        .select('fecha, estado')
        .gte('fecha', desdeStr)
        .in('estado', ['confirmada', 'realizada']);
    if (error) throw error;

    const map = new Map();
    data.forEach((r) => {
        const mes = r.fecha.slice(0, 7);
        map.set(mes, (map.get(mes) || 0) + 1);
    });
    return [...map.entries()]
        .map(([mes, n]) => ({ mes, n }))
        .sort((a, b) => a.mes.localeCompare(b.mes));
}

/** Derivaciones (sesiones reales en rango) */
export async function obtenerDerivaciones(rango) {
    let q = supabase.from('sesiones').select('derivado_etologo, derivado_zona');
    q = aplicarFiltroNoPrueba(q);
    q = aplicarRangoSesiones(q, rango);
    const { data, error } = await q;
    if (error) throw error;

    return {
        a_etologo: data.filter((s) => s.derivado_etologo).length,
        por_zona:  data.filter((s) => s.derivado_zona).length,
    };
}
