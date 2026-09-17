// =====================================================================
// avisos.js — Tab "Avisos" del admin de Perros de la Isla.
//
// Lee public.avisos (poblada por triggers SQL en mensajes / registros_
// ejercicio / citas). Renderiza cronológico, filtros, marcar leído,
// badge de no-leídos, polling 25s + refresh on focus, y para avisos de
// cita arma dos bloques copiables (WhatsApp + interno) con click→copy.
//
// Es un módulo ES importado por admin.js. NO toca push.js ni el flujo
// existente; en caso de fallo silencioso, el panel muestra un toast y
// el resto del admin sigue intacto.
//
// RLS: las policies de avisos exigen es_admin(). Si el SELECT/UPDATE
// devuelve [] sin error, asumir que el usuario no es admin.
// =====================================================================

import { getSupabase } from '../js/supabase.js';
const supabase = getSupabase('admin');

// ---- Estado interno del módulo ----
const state = {
    items: [],
    filtro: 'todos',     // 'todos' | 'no_leidos' | 'cita' | 'mensaje' | 'ejercicio'
    pollHandle: null,
    bound: false,
    cargando: false,
    detallesCita: {},    // entidad_id (cita uuid) -> { fecha, hora, modalidad, zona, protocolo, cliente:{id,nombre,telefono} }
};

const LIMIT = 100;
const POLL_MS = 25_000;

// ---- Helpers de UI ----

function iconoPara(tipo) {
    switch (tipo) {
        case 'cita_nueva':       return '📅';
        case 'cita_estado':      return '✅';
        case 'cita_reagendada':  return '🔁';
        case 'cita_pago':        return '💶';
        case 'mensaje_nuevo':    return '💬';
        case 'ejercicio_nuevo':  return '🏃';
        default:                 return '📌';
    }
}

function tipoCategoria(tipo) {
    if (!tipo) return 'otro';
    if (tipo.startsWith('cita')) return 'cita';
    if (tipo.startsWith('mensaje')) return 'mensaje';
    if (tipo.startsWith('ejercicio')) return 'ejercicio';
    return 'otro';
}

function fechaRelativa(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 60) return 'ahora';
    if (diff < 3600) return `hace ${Math.floor(diff / 60)} min`;
    if (diff < 86400) return `hace ${Math.floor(diff / 3600)} h`;
    if (diff < 86400 * 2) return 'ayer';
    return d.toLocaleDateString('es-ES', { day: '2-digit', month: 'short' });
}

function esc(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

// Sin uso desde el 17/09 (se fueron con los bloques copiables). Se quedan por
// si vuelven a hacer falta; no molestan a nadie.
function fmtFechaCita(fechaIso) {
    if (!fechaIso) return '';
    const [y, m, d] = String(fechaIso).split('-');
    if (!y || !m || !d) return fechaIso;
    return `${d}/${m}`;
}

function fmtHora(h) {
    if (!h) return '';
    const s = String(h);
    // "HH:MM:SS" → "HH:MM"
    return s.length >= 5 ? s.slice(0, 5) : s;
}

function toast(msg) {
    const t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%) translateY(20px);background:#6B7A3A;color:#F5EFE0;font-family:Inter,sans-serif;font-weight:600;font-size:14px;padding:10px 18px;border-radius:999px;box-shadow:0 8px 20px rgba(26,26,26,.18);opacity:0;transition:opacity .2s,transform .2s;z-index:9999;pointer-events:none';
    document.body.appendChild(t);
    requestAnimationFrame(() => { t.style.opacity = '1'; t.style.transform = 'translateX(-50%) translateY(0)'; });
    setTimeout(() => { t.style.opacity = '0'; t.style.transform = 'translateX(-50%) translateY(20px)'; setTimeout(() => t.remove(), 260); }, 2200);
}

// ---- Data layer ----

async function fetchAvisos() {
    const { data, error } = await supabase
        .from('avisos')
        .select('id, tipo, titulo, cuerpo, url, entidad_tipo, entidad_id, leido, creado_en')
        .order('creado_en', { ascending: false })
        .limit(LIMIT);
    if (error) {
        console.error('[avisos] error select:', error);
        return [];
    }
    return data || [];
}

async function enrichDetallesCita(items) {
    // Para los avisos de tipo cita, traemos info de la cita + cliente.
    const ids = [...new Set(
        items
            .filter((a) => a.entidad_tipo === 'cita' && a.entidad_id)
            .map((a) => a.entidad_id)
    )];
    if (ids.length === 0) return;
    // Filtramos los que ya tenemos en cache.
    const faltan = ids.filter((id) => !state.detallesCita[id]);
    if (faltan.length === 0) return;
    try {
        const { data, error } = await supabase
            .from('citas')
            .select('id, fecha, hora, modalidad, zona, protocolo, estado, sena_pagada, clientes(id, nombre, telefono)')
            .in('id', faltan);
        if (error) {
            console.warn('[avisos] no se pudieron enriquecer citas:', error.message);
            return;
        }
        (data || []).forEach((c) => {
            state.detallesCita[c.id] = {
                fecha: c.fecha,
                hora: c.hora,
                modalidad: c.modalidad,
                zona: c.zona,
                protocolo: c.protocolo,
                estado: c.estado,
                sena_pagada: c.sena_pagada,
                cliente: c.clientes || null,
            };
        });
    } catch (e) {
        console.warn('[avisos] enrich crash:', e);
    }
}

async function marcarLeido(id, leido = true) {
    const { error } = await supabase
        .from('avisos')
        .update({ leido })
        .eq('id', id);
    if (error) {
        console.error('[avisos] error update leido:', error);
        toast('Error marcando leído');
        return false;
    }
    return true;
}

async function marcarTodosLeidos() {
    const ids = state.items.filter((a) => !a.leido).map((a) => a.id);
    if (ids.length === 0) return true;
    const { error } = await supabase
        .from('avisos')
        .update({ leido: true })
        .in('id', ids);
    if (error) {
        console.error('[avisos] error update masivo:', error);
        toast('Error marcando todos');
        return false;
    }
    return true;
}

// ---- Bloques copiables para citas ----

async function copiar(texto) {
    try {
        await navigator.clipboard.writeText(texto);
        toast('Copiado ✓');
    } catch (_e) {
        // Fallback: crear textarea y exec command
        const ta = document.createElement('textarea');
        ta.value = texto;
        ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px';
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); toast('Copiado ✓'); }
        catch (__e) { toast('No se pudo copiar'); }
        finally { ta.remove(); }
    }
}

// ---- Render ----

function filtrarItems() {
    if (state.filtro === 'todos') return state.items;
    if (state.filtro === 'no_leidos') return state.items.filter((a) => !a.leido);
    return state.items.filter((a) => tipoCategoria(a.tipo) === state.filtro);
}

function abrirCliente(clienteId) {
    if (!clienteId) return;
    // El admin usa cliente.html?id=...
    // replace, no href: el admin no apila pantallas (01/09/2026).
    location.replace(`cliente.html?id=${encodeURIComponent(clienteId)}`);
}

function renderItem(a) {
    const cat = tipoCategoria(a.tipo);
    const det = (cat === 'cita' && a.entidad_id) ? state.detallesCita[a.entidad_id] : null;

    const partes = [];
    partes.push(`<li class="aviso-item${a.leido ? '' : ' aviso-item--unread'}" data-id="${esc(a.id)}" data-cat="${esc(cat)}" data-url="${esc(a.url || '')}">`);
    partes.push(`<div class="aviso-row">`);
    partes.push(`<span class="aviso-icon" aria-hidden="true">${iconoPara(a.tipo)}</span>`);
    partes.push(`<div class="aviso-body">`);
    partes.push(`<div class="aviso-titulo">${esc(a.titulo)}</div>`);
    if (a.cuerpo) partes.push(`<div class="aviso-cuerpo">${esc(a.cuerpo)}</div>`);
    partes.push(`<div class="aviso-meta">${esc(fechaRelativa(a.creado_en))}</div>`);
    partes.push(`</div>`);
    partes.push(`<div class="aviso-acciones">`);
    if (cat === 'cita' && det && det.cliente) {
        partes.push(`<button type="button" class="aviso-btn aviso-btn--ghost" data-action="abrir-cliente" data-cli="${esc(det.cliente.id)}">Abrir cliente</button>`);
    }
    partes.push(`</div>`);
    partes.push(`</div>`);

    // 17/09/2026 — aqui iban dos bloques mas por cada aviso de cita: "Mensaje
    // WhatsApp" y "Resumen interno", cada uno con su boton de Copiar. Charly:
    // "los dos que dicen whatsapp y resumen interno no son necesarios... asi
    // queda mas escueto, porque sino son 3 mensajes juntos por una cita".
    // El de WhatsApp ademas salia roto ("Recibimos tu solicitud para el a las
    // .") porque `det` viene null muy a menudo: state.detallesCita solo se
    // rellena para las citas que la consulta logra cruzar. El resumen interno
    // era una copia literal del titulo y el cuerpo que ya se ven arriba.
    partes.push(`</li>`);
    return partes.join('');
}

function render() {
    const lista = document.getElementById('avisos-list');
    const empty = document.getElementById('avisos-empty');
    if (!lista) return;
    const items = filtrarItems();
    // Contador en la cabecera de la tarjeta (01/09/2026).
    const meta = document.getElementById('avisos-meta');
    if (meta) {
        const noLeidos = state.items.filter((a) => !a.leido).length;
        meta.textContent = noLeidos > 0 ? `${noLeidos} sin leer` : 'todo leído';
    }
    if (items.length === 0) {
        lista.innerHTML = '';
        if (empty) {
            empty.hidden = false;
            empty.textContent = state.filtro === 'no_leidos'
                ? 'No tenés avisos sin leer 🎉'
                : 'No hay avisos por ahora.';
        }
        return;
    }
    if (empty) empty.hidden = true;
    lista.innerHTML = items.map(renderItem).join('');
}

function renderBadge() {
    const noLeidos = state.items.filter((a) => !a.leido).length;
    const badge = document.getElementById('avisos-badge');
    if (badge) {
        if (noLeidos > 0) {
            badge.textContent = noLeidos > 99 ? '99+' : String(noLeidos);
            badge.hidden = false;
        } else {
            badge.hidden = true;
        }
    }
    // Botón "Marcar todos" visible solo si hay no-leídos
    const btnTodos = document.getElementById('btn-avisos-marcar-todos');
    if (btnTodos) btnTodos.hidden = noLeidos === 0;
}

// ---- Carga + polling ----

async function recargar(silencioso = false) {
    if (state.cargando) return;
    state.cargando = true;
    try {
        const items = await fetchAvisos();
        state.items = items;
        await enrichDetallesCita(items);
        render();
        renderBadge();
    } catch (e) {
        console.error('[avisos] recargar crash:', e);
        if (!silencioso) toast('Error cargando avisos');
    } finally {
        state.cargando = false;
    }
}

function startPolling() {
    stopPolling();
    state.pollHandle = setInterval(() => recargar(true), POLL_MS);
}

function stopPolling() {
    if (state.pollHandle) {
        clearInterval(state.pollHandle);
        state.pollHandle = null;
    }
}

function onVisibility() {
    if (document.visibilityState === 'visible') {
        recargar(true);
    }
}

// ---- Bind de eventos ----

function bindFiltros() {
    const cont = document.querySelector('.avisos-filtros');
    if (!cont) return;
    cont.addEventListener('click', (ev) => {
        const btn = ev.target.closest('[data-filtro]');
        if (!btn) return;
        const f = btn.dataset.filtro;
        state.filtro = f;
        cont.querySelectorAll('[data-filtro]').forEach((b) => {
            b.classList.toggle('active', b.dataset.filtro === f);
        });
        render();
    });
}

function bindMarcarTodos() {
    const btn = document.getElementById('btn-avisos-marcar-todos');
    if (!btn) return;
    btn.addEventListener('click', async () => {
        btn.disabled = true;
        const ok = await marcarTodosLeidos();
        btn.disabled = false;
        if (ok) {
            state.items = state.items.map((a) => ({ ...a, leido: true }));
            render();
            renderBadge();
            toast('Todos marcados como leídos');
        }
    });
}

function bindLista() {
    const lista = document.getElementById('avisos-list');
    if (!lista) return;
    lista.addEventListener('click', async (ev) => {
        const item = ev.target.closest('.aviso-item');
        if (!item) return;
        const id = item.dataset.id;

        const accion = ev.target.closest('[data-action]')?.dataset.action;

        if (!accion && !ev.target.closest('a')) {
            const url = item.dataset.url;
            const a = state.items.find((x) => x.id === id);
            if (a && !a.leido) {
                await marcarLeido(id, true);
                a.leido = true;
                renderBadge();
            }
            if (url) location.href = url;
            return;
        }

        if (accion === 'abrir-cliente') {
            ev.preventDefault();
            const cli = ev.target.closest('[data-cli]')?.dataset.cli;
            abrirCliente(cli);
            return;
        }

    });
}

// ---- Entry points exportados ----

export async function initAvisos() {
    if (state.bound) {
        // Re-entrada: solo refrescamos.
        recargar(true);
        return;
    }
    state.bound = true;
    bindFiltros();
    bindMarcarTodos();
    bindLista();
    document.addEventListener('visibilitychange', onVisibility);
    await recargar();
    startPolling();
}

// Carga ligera para el badge sin pintar el panel completo.
// Usada por admin.js al loguear, para tener el contador desde el inicio.
export async function precargarBadgeAvisos() {
    try {
        const { count, error } = await supabase
            .from('avisos')
            .select('id', { count: 'exact', head: true })
            .eq('leido', false);
        if (error) {
            console.warn('[avisos] precarga badge falló:', error.message);
            return;
        }
        const badge = document.getElementById('avisos-badge');
        if (!badge) return;
        if (count > 0) {
            badge.textContent = count > 99 ? '99+' : String(count);
            badge.hidden = false;
        } else {
            badge.hidden = true;
        }
    } catch (e) {
        console.warn('[avisos] precarga crash:', e);
    }
}
