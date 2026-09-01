// =====================================================================
// atencion.js — Tab "Atención" del admin de Perros de la Isla.
//
// Foto EN VIVO de qué perros de clientes activos necesitan un empujón,
// más el uso de tareas de la semana. Lee todo del RPC admin-only
// get_atencion_admin() (sin parámetros) y se recalcula al abrir la
// pestaña — no hay polling.
//
// Módulo ES importado por admin.js. Aditivo: no toca avisos.js ni el
// resto del flujo. Reusa las clases .aviso-* / .avisos-* del admin.
//
// RLS: el RPC exige es_admin(). Si falla, el panel muestra un texto
// neutro y el resto del admin sigue intacto.
// =====================================================================

import { getSupabase } from '../js/supabase.js';
const supabase = getSupabase('admin');

// ---- Estado interno del módulo ----
const state = {
    bound: false,
    cargando: false,
};

// Marca de "visto" por DISPOSITIVO (localStorage). El RPC get_atencion_admin
// NO trae fecha/created_at fiable por ítem (solo 'dias', un contador que cambia
// a diario, y 'generado_en', que es la hora de la consulta). Por eso usamos la
// estrategia de CLAVES ESTABLES: al abrir la pestaña guardamos el conjunto de
// claves de los ítems vistos; el badge cuenta los ítems cuya clave no esté en
// ese conjunto (= novedades posteriores a la última visita).
const VISTO_KEY = 'pdli_atencion_visto';

// Clave estable de un ítem: identifica "este motivo para este perro (y tarea)"
// sin incluir 'dias' (que cambia a diario y re-alertaría en falso).
function itemKey(it) {
    return `${it?.motivo ?? ''}|${it?.perro_id ?? ''}|${it?.tarea ?? ''}`;
}

// Devuelve el Set de claves vistas, o null si nunca se marcó en este dispositivo.
function leerVisto() {
    try {
        const raw = localStorage.getItem(VISTO_KEY);
        if (raw == null) return null;
        const arr = JSON.parse(raw);
        return new Set(Array.isArray(arr) ? arr : []);
    } catch (e) {
        return null;
    }
}

// Guarda como "vistas" las claves de los ítems actuales (snapshot de la visita).
function guardarVisto(items) {
    try {
        const keys = (Array.isArray(items) ? items : []).map(itemKey);
        localStorage.setItem(VISTO_KEY, JSON.stringify(keys));
    } catch (e) { /* localStorage lleno o bloqueado: el badge caerá a total */ }
}

// Cuenta las novedades: ítems cuya clave no esté en la marca. Si nunca se
// marcó (primer uso en el dispositivo), todo es novedad → cuenta el total.
function contarNuevos(items) {
    const arr = Array.isArray(items) ? items : [];
    const visto = leerVisto();
    if (visto === null) return arr.length;
    let n = 0;
    for (const it of arr) if (!visto.has(itemKey(it))) n++;
    return n;
}

// Orden y etiqueta de cada motivo de atención.
// 'tarea_abandonada' se retiró el 01/09/2026: leía registros_tarea, la tabla
// de las pastillas 0-7 que salieron de la app del cliente, así que era una
// regla muerta. La sustituye 'solo_usa', que sale del registro nuevo.
const GRUPOS = [
    { motivo: 'nunca_empezo', titulo: 'Nunca empezaron', icono: '🚦',
      pie: 'Tienen rutina asignada y cero registros. Son los que más rinde llamar.' },
    { motivo: 'inactivo',     titulo: 'Se enfriaron',    icono: '❄️',
      pie: 'Entrenaron alguna vez y llevan más de una semana parados.' },
    { motivo: 'solo_usa',     titulo: 'Usan sin entrenar', icono: '🤚',
      pie: 'Recurren al recurso cuando el perro lo necesita, pero no lo entrenan en frío. Así no acaba de funcionar.' },
];

// ---- Helpers ----

function esc(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

function normalizarTelefonoWa(tel) {
    if (!tel) return '';
    return String(tel).replace(/[^\d+]/g, '');
}

// Misma navegación que usa avisos.js para abrir un cliente.
function abrirCliente(clienteId) {
    if (!clienteId) return;
    location.href = `cliente.html?id=${encodeURIComponent(clienteId)}`;
}

// ---- Render ----

function textoItem(it) {
    const perro = esc(it.perro || 'Perro');
    const cliente = esc(it.cliente || 'Cliente');
    switch (it.motivo) {
        case 'nunca_empezo':
            return `${perro} · ${cliente} — tiene rutina pero aún no registró ningún entreno.`;
        case 'inactivo':
            return `${perro} · ${cliente} — ${esc(it.dias)} días sin entrenar.`;
        case 'solo_usa':
            return `${perro} · ${cliente} — usa '${esc(it.tarea)}' pero no lo entrena.`;
        default:
            return `${perro} · ${cliente}`;
    }
}

function renderItem(it, icono) {
    const tel = normalizarTelefonoWa(it.cliente_tel);
    const partes = [];
    partes.push(`<li class="aviso-item">`);
    partes.push(`<div class="aviso-row">`);
    partes.push(`<span class="aviso-icon" aria-hidden="true">${icono}</span>`);
    partes.push(`<div class="aviso-body"><div class="aviso-titulo">${textoItem(it)}</div></div>`);
    partes.push(`<div class="aviso-acciones">`);
    if (it.cliente_id) {
        partes.push(`<button type="button" class="aviso-btn aviso-btn--ghost" data-action="abrir-cliente" data-cli="${esc(it.cliente_id)}">Abrir cliente</button>`);
    }
    if (tel) {
        partes.push(`<a class="aviso-btn aviso-btn--ghost" href="https://wa.me/${esc(tel)}" target="_blank" rel="noopener">WhatsApp</a>`);
    }
    partes.push(`</div>`);
    partes.push(`</div>`);
    partes.push(`</li>`);
    return partes.join('');
}

// (renderUsoTareas se eliminó el 01/09/2026: pintaba la tabla de "uso de
// tareas" a partir de registros_tarea, que ya no se alimenta desde el cliente.
// El RPC devuelve uso_tareas vacío por compatibilidad.)

function render(data) {
    const cont = document.getElementById('atencion-contenido');
    if (!cont) return;

    const items = Array.isArray(data.atencion) ? data.atencion : [];
    const r = data.resumen || null;
    const partes = [];

    // Cabecera con las tres cifras. Es el dato más importante del admin y
    // hasta ahora había que deducirlo contando la lista a ojo. (01/09/2026)
    if (r && Number(r.con_rutina) > 0) {
        const pendientes = Number(r.nunca_empezo || 0) + Number(r.inactivos || 0);
        const pie = pendientes > 0
            ? `${pendientes} de ${r.con_rutina} perros con rutina activa necesitan que hagas algo.`
            : `Los ${r.con_rutina} perros con rutina activa están al día.`;
        partes.push(`
            <section class="a-card">
                <div class="a-sec">
                    <h3 class="a-sec__t">Cómo va la cosa</h3>
                    <em class="a-sec__meta">${esc(r.con_rutina)} perros con rutina</em>
                </div>
                <div class="a-kpi">
                    <div class="a-kpi__i a-kpi__i--rojo"><b>${esc(r.nunca_empezo)}</b><small>Sin empezar</small></div>
                    <div class="a-kpi__i a-kpi__i--ambar"><b>${esc(r.inactivos)}</b><small>Enfriados</small></div>
                    <div class="a-kpi__i a-kpi__i--ok"><b>${esc(r.al_dia)}</b><small>Al día</small></div>
                </div>
                <p class="a-hint">${esc(pie)}</p>
            </section>`);
    }

    if (items.length === 0) {
        partes.push(`<p class="avisos-empty">Todo en orden, no hay perros que necesiten atención ahora mismo. 🎉</p>`);
    } else {
        GRUPOS.forEach((g) => {
            const delGrupo = items.filter((it) => it.motivo === g.motivo);
            if (delGrupo.length === 0) return;
            partes.push(`<section class="a-card">`);
            partes.push(`<div class="a-sec"><h3 class="a-sec__t">${g.icono} ${esc(g.titulo)}</h3><em class="a-sec__meta">${delGrupo.length}</em></div>`);
            partes.push(`<ul class="avisos-list" role="list">`);
            delGrupo.forEach((it) => partes.push(renderItem(it, g.icono)));
            partes.push(`</ul>`);
            if (g.pie) partes.push(`<p class="a-hint">${esc(g.pie)}</p>`);
            partes.push(`</section>`);
        });
    }

    cont.innerHTML = partes.join('');
}

function renderBadge(total) {
    const badge = document.getElementById('atencion-badge');
    if (!badge) return;
    if (total > 0) {
        badge.textContent = total > 99 ? '99+' : String(total);
        badge.hidden = false;
    } else {
        badge.hidden = true;
    }
}

// ---- Carga ----

async function recargar() {
    if (state.cargando) return;
    state.cargando = true;
    const cont = document.getElementById('atencion-contenido');
    try {
        const { data, error } = await supabase.rpc('get_atencion_admin');
        if (error) throw error;
        const d = data || {};
        const items = Array.isArray(d.atencion) ? d.atencion : [];
        render(d);
        // Abrir la pestaña = ver todo: registramos lo visto y apagamos el badge.
        guardarVisto(items);
        renderBadge(0);
    } catch (e) {
        console.error('[atencion] error rpc:', e);
        if (cont) cont.innerHTML = `<p class="avisos-empty">No se pudo cargar ahora mismo.</p>`;
    } finally {
        state.cargando = false;
    }
}

// ---- Bind ----

function bindContenido() {
    const cont = document.getElementById('atencion-contenido');
    if (!cont) return;
    cont.addEventListener('click', (ev) => {
        const btn = ev.target.closest('[data-action="abrir-cliente"]');
        if (!btn) return;
        ev.preventDefault();
        abrirCliente(btn.dataset.cli);
    });
}

// ---- Entry points exportados ----

export async function initAtencion() {
    if (!state.bound) {
        bindContenido();
        state.bound = true;
    }
    // El badge se apaga de inmediato al abrir; recargar() confirma la marca
    // con los ítems frescos una vez que responde el RPC.
    renderBadge(0);
    await recargar();
}

// Carga ligera para el badge sin pintar el panel completo.
// Usada por admin.js al loguear, para tener el contador desde el inicio.
export async function precargarBadgeAtencion() {
    try {
        const { data, error } = await supabase.rpc('get_atencion_admin');
        if (error) {
            console.warn('[atencion] precarga badge falló:', error.message);
            return;
        }
        // Solo novedades desde la última visita (no el total).
        const items = Array.isArray(data && data.atencion) ? data.atencion : [];
        renderBadge(contarNuevos(items));
    } catch (e) {
        console.warn('[atencion] precarga crash:', e);
    }
}
