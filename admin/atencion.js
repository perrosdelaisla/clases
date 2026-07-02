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
