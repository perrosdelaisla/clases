// =====================================================================
// admin/stats/api.js — queries de la pestaña Stats.
//
// REGLA: queries idénticas a las del admin viejo (hola/admin/admin.js).
// El admin viejo trae UNA sola vez todas las sesiones del rango con
// es_prueba=eq.false y hace todos los filtros lado cliente. Acá las
// 8 funciones exportadas siguen ese contrato: cada una trae sus
// columnas necesarias y procesa en JS exactamente como el original.
//
// Métricas que NO existen en el admin viejo y se conservan acá por
// estar fuera del dominio Victoria (no contaminan números):
//   - obtenerKPIs.clientes_activos   → tabla clientes
//   - obtenerDistribucionClientes()  → tabla clientes
//   - obtenerCitasPorMes()           → tabla citas
//
// Filtro de sesiones de prueba: .eq('es_prueba', false) — idéntico al
// admin viejo. Excluye filas con es_prueba=NULL (decisión deliberada
// para fidelidad; si Charly quiere incluir NULLs como "reales",
// cambiar a .or('es_prueba.is.null,es_prueba.eq.false')).
// =====================================================================

import { supabase } from '../../js/supabase.js';

// Filtro de sesiones reales (sin pruebas) — idéntico al admin viejo.
function aplicarFiltroNoPrueba(query) {
    return query.eq('es_prueba', false);
}

// Acota por timestamp de inicio. Acepta rango como {desde, hasta} con
// formato 'YYYY-MM-DD'; convierte hasta a fin de día para incluirlo.
function aplicarRangoSesiones(query, rango) {
    if (rango?.desde) query = query.gte('inicio', rango.desde);
    if (rango?.hasta) query = query.lte('inicio', rango.hasta + 'T23:59:59');
    return query;
}

// ────────────────────────────────────────────────────────────────────
// Helper interno: trae sesiones reales del rango con las columnas
// pasadas. Emula `obtenerSesionesParaStats(desde, hasta)` del admin
// viejo + select selectivo de columnas.
// ────────────────────────────────────────────────────────────────────
async function traerSesionesReales(rango, columnas) {
    let q = supabase.from('sesiones').select(columnas);
    q = aplicarFiltroNoPrueba(q);
    q = aplicarRangoSesiones(q, rango);
    const { data, error } = await q;
    if (error) throw error;
    return data || [];
}

/**
 * KPIs:
 *   sesiones_reales    → total de sesiones (admin viejo: renderizarKPIs L703)
 *   vieron_precios     → sesiones.filter(vio_precio).length    (L704)
 *   citas_confirmadas  → sesiones.filter(cita_confirmada).length (L705)
 *   conversion_pct     → ((citas/total)*100).toFixed(1) + '%' o '—'
 *                        (string con % o em-dash, idéntico al viejo L706)
 *   clientes_activos   → COUNT FROM clientes WHERE estado='activo'
 *                        (NUEVO: no existe en admin viejo, métrica
 *                        independiente de Victoria)
 */
export async function obtenerKPIs(rango) {
    const sesiones = await traerSesionesReales(rango, 'vio_precio, cita_confirmada');
    const sesiones_reales = sesiones.length;
    const vieron_precios = sesiones.filter((s) => s.vio_precio).length;
    const citas_confirmadas = sesiones.filter((s) => s.cita_confirmada).length;
    const conversion_pct = sesiones_reales > 0
        ? ((citas_confirmadas / sesiones_reales) * 100).toFixed(1) + '%'
        : '—';

    const { count: activos, error: errC } = await supabase
        .from('clientes')
        .select('id', { count: 'exact', head: true })
        .eq('estado', 'activo');
    if (errC) throw errC;

    return {
        sesiones_reales,
        vieron_precios,
        citas_confirmadas,
        conversion_pct,
        clientes_activos: activos || 0,
    };
}

/**
 * Funnel Victoria — 7 etapas, composición idéntica al admin viejo
 * (hola/admin/admin.js:723-733).
 *
 * NOTA: el admin viejo NO incluye 'llego_a_pago' (mi versión anterior
 * lo había agregado por error). El paso 2 usa paso_maximo_alcanzado
 * con la lista PASOS_S4.
 */
export async function obtenerFunnelVictoria(rango) {
    const sesiones = await traerSesionesReales(
        rango,
        'paso_maximo_alcanzado, vio_mensaje_principal, vio_precio, abrio_agenda, eligio_slot, cita_confirmada',
    );

    const PASOS_S4 = ['s4', 's5', 's6', 's7', 's8', 's9', 's10', 's11', 's12'];

    const etapas = [
        { etapa: 'Iniciaron conversación', n: sesiones.length },
        { etapa: 'Dieron datos del perro', n: sesiones.filter((s) => PASOS_S4.includes(s.paso_maximo_alcanzado)).length },
        { etapa: 'Vieron mensaje clave',   n: sesiones.filter((s) => s.vio_mensaje_principal).length },
        { etapa: 'Vieron precios',         n: sesiones.filter((s) => s.vio_precio).length },
        { etapa: 'Abrieron agenda',        n: sesiones.filter((s) => s.abrio_agenda).length },
        { etapa: 'Eligieron horario',      n: sesiones.filter((s) => s.eligio_slot).length },
        { etapa: 'Confirmaron cita',       n: sesiones.filter((s) => s.cita_confirmada).length },
    ];

    // Detectar mayor caída relativa — admin viejo renderizarEmbudo L749-755.
    // Recorre desde i=1 calculando retención respecto al paso anterior;
    // marca el índice con la menor retención (excluido el paso 0).
    let minRet = 101;
    let idxCaida = -1;
    for (let i = 1; i < etapas.length; i++) {
        const prev = etapas[i - 1].n;
        const ret = prev > 0 ? Math.round((etapas[i].n / prev) * 100) : 0;
        if (ret < minRet) { minRet = ret; idxCaida = i; }
    }
    const tieneDatos = etapas[0].n > 0;

    return etapas.map((e, i) => ({
        ...e,
        mayor_caida: tieneDatos && i === idxCaida,
    }));
}

// Helper: enriquece cada bucket con `citas` (== n para compatibilidad
// con el render del doughnut) y `pct` (% sobre total con 1 decimal,
// 0.0 si total === 0). Idéntico al desglose del admin viejo
// (_renderTablaDesglose).
function enriquecerBuckets(buckets, total) {
    return buckets.map((b) => ({
        ...b,
        citas: b.n,
        pct: total > 0 ? Math.round((b.n / total) * 1000) / 10 : 0,
    }));
}

/**
 * Doughnut 1 — Tema preseleccionado.
 * Mapping fijo de keys → labels, orden fijo (admin viejo:
 * renderizarDesgloseTema línea 803-822).
 */
export async function obtenerDistribucionTema(rango) {
    const sesiones = await traerSesionesReales(rango, 'tema_preseleccionado');

    const TEMAS = [
        { key: 'basica',      label: 'Educación básica' },
        { key: 'reactividad', label: 'Reactividad' },
        { key: 'cachorros',   label: 'Cachorros' },
        { key: 'ansiedad',    label: 'Ansiedad/miedos' },
        { key: null,          label: 'Sin tema' },
    ];

    const buckets = TEMAS.map((t) => ({
        label: t.label,
        n: sesiones.filter((s) =>
            t.key === null ? !s.tema_preseleccionado : s.tema_preseleccionado === t.key,
        ).length,
    }));
    return enriquecerBuckets(buckets, sesiones.length);
}

/**
 * Doughnut 2 — Modalidad.
 * Mapping fijo (admin viejo: renderizarDesgloseModalidad línea 827-845).
 * El bucket 'otro' agrupa: !modalidad OR 'derivar' OR 'desconocida'.
 */
export async function obtenerDistribucionModalidad(rango) {
    const sesiones = await traerSesionesReales(rango, 'modalidad');

    const MODALIDADES = [
        { key: 'presencial', label: 'Presencial' },
        { key: 'online',     label: 'Online' },
        { key: 'fuera',      label: 'Fuera de cobertura' },
        { key: 'otro',       label: 'Derivar/sin definir' },
    ];

    const buckets = MODALIDADES.map((m) => ({
        label: m.label,
        n: m.key === 'otro'
            ? sesiones.filter((s) => !s.modalidad || s.modalidad === 'derivar' || s.modalidad === 'desconocida').length
            : sesiones.filter((s) => s.modalidad === m.key).length,
    }));
    return enriquecerBuckets(buckets, sesiones.length);
}

/**
 * Doughnut 3 — Origen del tráfico (canal).
 * Mapping fijo (admin viejo: renderizarDesgloseCanal línea 850-869).
 */
export async function obtenerDistribucionOrigen(rango) {
    const sesiones = await traerSesionesReales(rango, 'origen');

    const CANALES = [
        { key: 'whatsapp',  label: 'WhatsApp' },
        { key: 'instagram', label: 'Instagram' },
        { key: 'mail',      label: 'Mail' },
        { key: 'paseos',    label: 'App de Paseos' },
        { key: null,        label: 'Directo' },
    ];

    const buckets = CANALES.map((c) => ({
        label: c.label,
        n: sesiones.filter((s) =>
            c.key === null ? !s.origen : s.origen === c.key,
        ).length,
    }));
    return enriquecerBuckets(buckets, sesiones.length);
}

/**
 * Doughnut 4 — Estado actual de clientes.
 * NUEVO (no existe en admin viejo). Independiente de Victoria — viene
 * de la tabla clientes, no toca sesiones. Fotografía actual, sin rango.
 */
export async function obtenerDistribucionClientes() {
    const { data, error } = await supabase.from('clientes').select('estado');
    if (error) throw error;

    const map = new Map();
    (data || []).forEach((r) => {
        const key = r.estado || '(sin dato)';
        map.set(key, (map.get(key) || 0) + 1);
    });
    const orden = ['consulta', 'activo', 'mantenimiento', 'inactivo'];
    return [...map.entries()]
        .map(([label, n]) => ({ label, n }))
        .sort((a, b) => orden.indexOf(a.label) - orden.indexOf(b.label));
}

/**
 * Citas por mes — últimos 12 meses, confirmadas + realizadas.
 * NUEVO (no existe en admin viejo). Independiente de Victoria — viene
 * de la tabla citas.
 */
export async function obtenerCitasPorMes() {
    const desde = new Date();
    desde.setMonth(desde.getMonth() - 11);
    desde.setDate(1);
    const desdeStr = desde.toISOString().slice(0, 10);

    const { data, error } = await supabase
        .from('citas')
        .select('fecha, estado')
        .gte('fecha', desdeStr)
        .in('estado', ['confirmada', 'realizada']);
    if (error) throw error;

    const map = new Map();
    (data || []).forEach((r) => {
        const mes = r.fecha.slice(0, 7);
        map.set(mes, (map.get(mes) || 0) + 1);
    });
    return [...map.entries()]
        .map(([mes, n]) => ({ mes, n }))
        .sort((a, b) => a.mes.localeCompare(b.mes));
}

/**
 * Derivaciones — etólogo + zona.
 * Idéntico al admin viejo (renderizarMetricasFinales línea 945-946).
 */
export async function obtenerDerivaciones(rango) {
    const sesiones = await traerSesionesReales(rango, 'derivado_etologo, derivado_zona');

    return {
        a_etologo: sesiones.filter((s) => s.derivado_etologo).length,
        por_zona:  sesiones.filter((s) => s.derivado_zona).length,
    };
}

/**
 * Distribución móvil/desktop — admin viejo renderizarMetricasFinales L947-949.
 * Total = todas las sesiones reales del rango. Móvil = dispositivo === 'movil'.
 * Desktop = total - movil (igual que el viejo: pctDesk = 100 - pctMov).
 *
 * Devuelve { movil: {n, pct}, desktop: {n, pct} } con pct entero (0-100).
 */
export async function obtenerDistribucionDispositivo(rango) {
    const sesiones = await traerSesionesReales(rango, 'dispositivo');
    const total = sesiones.length;
    const movilN = sesiones.filter((s) => s.dispositivo === 'movil').length;
    const desktopN = total - movilN;
    const pctMovil = total > 0 ? Math.round((movilN / total) * 100) : 0;
    const pctDesktop = total > 0 ? 100 - pctMovil : 0;

    return {
        movil:   { n: movilN,   pct: pctMovil },
        desktop: { n: desktopN, pct: pctDesktop },
    };
}
