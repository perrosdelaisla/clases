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

// Orden y etiqueta de cada motivo de atención.
const GRUPOS = [
    { motivo: 'nunca_empezo',     titulo: 'Nunca empezó',     icono: '🚦' },
    { motivo: 'inactivo',         titulo: 'Se enfrió',        icono: '❄️' },
    { motivo: 'tarea_abandonada', titulo: 'Tarea abandonada', icono: '📋' },
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
        case 'tarea_abandonada':
            return `${perro} · ${cliente} — dejó de registrar '${esc(it.tarea)}' esta semana.`;
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

function renderUsoTareas(rows) {
    const partes = [];
    partes.push(`<h2 class="atencion-grupo-titulo">📊 Uso de tareas</h2>`);
    if (!rows || rows.length === 0) {
        partes.push(`<p class="avisos-empty">Aún no hay registros de tareas.</p>`);
        return partes.join('');
    }
    partes.push(`<div class="atencion-tabla-wrap"><table class="atencion-tabla">`);
    partes.push(`<thead><tr><th>Cliente</th><th>Perro</th><th>Tarea</th><th>Esta semana</th><th>Semana pasada</th></tr></thead>`);
    partes.push(`<tbody>`);
    rows.forEach((r) => {
        partes.push(
            `<tr>` +
            `<td>${esc(r.cliente)}</td>` +
            `<td>${esc(r.perro)}</td>` +
            `<td>${esc(r.tarea)}</td>` +
            `<td>${esc(r.dias_esta_semana)}</td>` +
            `<td>${esc(r.dias_semana_pasada)}</td>` +
            `</tr>`
        );
    });
    partes.push(`</tbody></table></div>`);
    return partes.join('');
}

function render(data) {
    const cont = document.getElementById('atencion-contenido');
    if (!cont) return;

    const items = Array.isArray(data.atencion) ? data.atencion : [];
    const partes = [];

    if (items.length === 0) {
        partes.push(`<p class="avisos-empty">Todo en orden, no hay perros que necesiten atención ahora mismo. 🎉</p>`);
    } else {
        GRUPOS.forEach((g) => {
            const delGrupo = items.filter((it) => it.motivo === g.motivo);
            if (delGrupo.length === 0) return;
            partes.push(`<h2 class="atencion-grupo-titulo">${g.icono} ${esc(g.titulo)} <span class="atencion-grupo-count">${delGrupo.length}</span></h2>`);
            partes.push(`<ul class="avisos-list" role="list">`);
            delGrupo.forEach((it) => partes.push(renderItem(it, g.icono)));
            partes.push(`</ul>`);
        });
    }

    // Uso de tareas, debajo de la atención.
    partes.push(renderUsoTareas(Array.isArray(data.uso_tareas) ? data.uso_tareas : []));

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
        render(d);
        renderBadge(Number(d.total) || 0);
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
        renderBadge(Number(data && data.total) || 0);
    } catch (e) {
        console.warn('[atencion] precarga crash:', e);
    }
}
