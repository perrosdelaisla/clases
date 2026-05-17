// =====================================================================
// perro.js — pantalla de detalle de perro (Fase 2, Paso 3)
//
// Trae datos del perro + datos del cliente dueño (para botón Volver).
// Tab Ejercicios: lista de activos + bottom sheet con catálogo (34 ítems)
// y toggles ON/OFF que escriben directo a Supabase. Resto de tabs son
// placeholders "Próximamente".
// =====================================================================

import { supabase, getSessionConTimeout } from '../js/supabase.js';
import { CATEGORIA_LABEL } from './catalogo-labels.js';
import { initSwipeTabs } from '../js/swipe-tabs.js';

const SCREENS = {
    loading: document.getElementById('screen-loading'),
    error: document.getElementById('screen-error'),
    perro: document.getElementById('screen-perro'),
};

const TABS = ['plan', 'ejercicios', 'herramientas', 'salud', 'historico', 'notas'];
const DEFAULT_TAB = 'ejercicios';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SUBTAB_LABELS = {
    ejercicio: 'ejercicios',
    cambio_rutina: 'cambios de rutina',
    tarea: 'tareas',
};
const DEFAULT_SUBTAB = 'ejercicio';

const state = {
    perroId: null,
    perro: null,
    catalogo: null,                 // 34 ejercicios (cache, lazy)
    asignados: new Map(),            // ejercicio_id → { activo, posicion_rutina }
    modalCatFilter: 'todos',
    modalSearch: '',
    subtabActiva: DEFAULT_SUBTAB,
};

document.addEventListener('DOMContentLoaded', bootstrap);

async function bootstrap() {
    // Back físico siempre vuelve a index.html — reescribimos la entrada
    // anterior con index.html y pusheamos la actual; así, el primer back
    // consume perro y queda index.html en la pila (sin recorrer el
    // historial entre páginas del admin). Va antes que el replaceState
    // de tabs (~línea 235) — opera sobre la entrada anterior, no la actual.
    if (!window.__backFixApplied) {
        window.__backFixApplied = true;
        const indexUrl = new URL('./index.html', window.location.href).href;
        const currentUrl = window.location.href;
        history.replaceState({ pdli: 'index-fallback' }, '', indexUrl);
        history.pushState({ pdli: 'perro' }, '', currentUrl);
    }

    showScreen('loading');
    bindTabs();
    bindSubtabs();
    bindModal();
    bindCasoComplejo();
    bindProtocolo();

    const params = new URLSearchParams(window.location.search);
    const id = params.get('id');

    if (!id) {
        window.location.replace('./index.html');
        return;
    }
    if (!UUID_RE.test(id)) {
        mostrarError('ID de perro inválido.');
        return;
    }

    state.perroId = id;

    try {
        const { data: { session } } = await getSessionConTimeout();
        if (!session) {
            window.location.replace('./index.html');
            return;
        }
        const esAdmin = await verificarAdmin(session.user.id);
        if (!esAdmin) {
            await supabase.auth.signOut();
            window.location.replace('./index.html');
            return;
        }

        await cargarYRenderPerro(id);
        activarTab(params.get('tab'), { updateUrl: false });

        // La carga de la lista de ejercicios activos no bloquea la UI:
        // el panel ya está visible con su loading propio.
        renderEjerciciosActivos();
    } catch (err) {
        console.error('[perro] bootstrap error:', err);
        mostrarError('Error inesperado al cargar el perro.');
    }
}

async function verificarAdmin(authUserId) {
    const { data, error } = await supabase
        .from('admins')
        .select('auth_user_id')
        .eq('auth_user_id', authUserId)
        .maybeSingle();
    if (error) {
        console.error('[perro] verificación admin falló:', error);
        return false;
    }
    return !!data;
}

async function cargarYRenderPerro(perroId) {
    const { data, error } = await supabase
        .from('perros')
        .select('*, clientes (id, nombre)')
        .eq('id', perroId)
        .maybeSingle();

    if (error) {
        console.error('[perro] error cargando perro:', error);
        mostrarError('No se pudo cargar el perro.');
        return;
    }
    if (!data) {
        mostrarError('Este perro no existe o no tenés acceso.');
        return;
    }

    state.perro = data;
    renderPerro(data);
    showScreen('perro');
}

function renderPerro(p) {
    const nombre = p.nombre || 'Sin nombre';
    setText('perro-nombre', nombre);
    setText('perro-nombre-header', nombre);
    setText('empty-perro-nombre', nombre);
    document.title = `${nombre} — Admin PDLI`;

    setText('perro-raza', p.raza || '—');
    setText('perro-edad', formatearEdadMeses(p.edad_meses) || '—');
    setText('perro-peso', formatearPesoKg(p.peso_kg) || '—');

    const ppp = document.getElementById('perro-ppp');
    if (p.es_ppp === true) ppp.removeAttribute('hidden');
    else ppp.setAttribute('hidden', '');

    const casoChk = document.getElementById('perro-caso-complejo');
    if (casoChk) casoChk.checked = p.caso_complejo === true;

    const back = document.getElementById('back-link');
    const clienteEmbed = p.clientes;
    if (clienteEmbed?.id) {
        back.href = `./cliente.html?id=${encodeURIComponent(clienteEmbed.id)}`;
        back.setAttribute('aria-label', `Volver a ${clienteEmbed.nombre || 'cliente'}`);
    } else if (p.cliente_id) {
        back.href = `./cliente.html?id=${encodeURIComponent(p.cliente_id)}`;
    }
    renderProtocoloUI();
}

// ===================== Formato edad / peso =====================

function formatearEdadMeses(meses) {
    if (meses == null) return null;
    const n = Number(meses);
    if (!Number.isFinite(n) || n < 0) return null;
    if (n < 24) return `${n} ${n === 1 ? 'mes' : 'meses'}`;
    const anios = n / 12;
    if (Number.isInteger(anios)) return `${anios} ${anios === 1 ? 'año' : 'años'}`;
    return `${anios.toFixed(1).replace('.', ',')} años`;
}

function formatearPesoKg(kg) {
    if (kg == null) return null;
    const n = typeof kg === 'string' ? parseFloat(kg.replace(',', '.')) : Number(kg);
    if (!Number.isFinite(n) || n < 0) return null;
    if (Number.isInteger(n)) return `${n} kg`;
    const txt = n.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
    return `${txt.replace('.', ',')} kg`;
}

// ===================== Toggle caso_complejo =====================

function bindCasoComplejo() {
    const chk = document.getElementById('perro-caso-complejo');
    if (chk) chk.addEventListener('change', guardarCasoComplejo);
}

async function guardarCasoComplejo(e) {
    const chk = e.target;
    if (!state.perroId) return;
    const target = chk.checked;
    chk.disabled = true;

    try {
        const { error } = await supabase
            .from('perros')
            .update({ caso_complejo: target })
            .eq('id', state.perroId);
        if (error) throw error;
        if (state.perro) state.perro.caso_complejo = target;
        toast('Caso complejo actualizado');
    } catch (err) {
        console.error('[perro] error guardando caso_complejo:', err);
        chk.checked = !target;
        toast('No se pudo guardar', 'error');
    } finally {
        chk.disabled = false;
    }
}

// ===================== Protocolo =====================

function renderProtocoloUI() {
    const p = state.perro || {};
    const principal = p.protocolo_principal || '';
    const comp = Array.isArray(p.protocolos_complementarios) ? p.protocolos_complementarios : [];
    const sel = document.getElementById('protocolo-principal');
    if (sel) sel.value = principal;
    document.querySelectorAll('.protocolo-comp').forEach((chk) => {
        const slug = chk.dataset.protocolo;
        const esPrincipal = slug === principal;
        chk.checked = !esPrincipal && comp.includes(slug);
        chk.disabled = esPrincipal;
        const item = chk.closest('.protocolo-comp-item');
        if (item) item.classList.toggle('is-disabled', esPrincipal);
    });
}

function bindProtocolo() {
    const sel = document.getElementById('protocolo-principal');
    if (sel) sel.addEventListener('change', guardarProtocolo);
    document.querySelectorAll('.protocolo-comp').forEach((chk) => {
        chk.addEventListener('change', guardarProtocolo);
    });
}

async function guardarProtocolo() {
    if (!state.perroId) return;
    const principal = document.getElementById('protocolo-principal').value || null;
    const comp = [...document.querySelectorAll('.protocolo-comp:checked')]
        .map((c) => c.dataset.protocolo)
        .filter((slug) => slug && slug !== principal);
    try {
        const { error } = await supabase
            .from('perros')
            .update({
                protocolo_principal: principal,
                protocolos_complementarios: comp,
            })
            .eq('id', state.perroId);
        if (error) throw error;
        if (state.perro) {
            state.perro.protocolo_principal = principal;
            state.perro.protocolos_complementarios = comp;
        }
        renderProtocoloUI();
        toast('Protocolo actualizado');
    } catch (err) {
        console.error('[perro] error guardando protocolo:', err);
        toast('No se pudo guardar', 'error');
        renderProtocoloUI();
    }
}

// ===================== Tabs =====================

function bindTabs() {
    document.getElementById('tabs').addEventListener('click', (e) => {
        const btn = e.target.closest('.tab');
        if (!btn) return;
        const tab = btn.dataset.tab;
        if (!tab) return;
        activarTab(tab, { updateUrl: true });
    });

    // Swipe horizontal entre tabs principales de la ficha perro.
    // Orden HTML: plan, ejercicios, herramientas, salud, historico, notas.
    initSwipeTabs({
        container: document.querySelector('.tab-content'),
        tabs: ['plan', 'ejercicios', 'herramientas', 'salud', 'historico', 'notas'],
        getCurrent: () => document.querySelector('.tab-panel:not([hidden])')?.dataset.panel,
        onChange: (tab) => activarTab(tab, { updateUrl: true }),
    });
}

function activarTab(tabRaw, { updateUrl } = {}) {
    const tab = TABS.includes(tabRaw) ? tabRaw : DEFAULT_TAB;

    document.querySelectorAll('.tab').forEach((b) => {
        const active = b.dataset.tab === tab;
        b.classList.toggle('is-active', active);
        b.setAttribute('aria-selected', active ? 'true' : 'false');
    });

    document.querySelectorAll('.tab-panel').forEach((p) => {
        if (p.dataset.panel === tab) p.removeAttribute('hidden');
        else p.setAttribute('hidden', '');
    });

    const activeBtn = document.querySelector(`.tab[data-tab="${tab}"]`);
    activeBtn?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });

    if (updateUrl) {
        const url = new URL(window.location);
        if (tab === DEFAULT_TAB) url.searchParams.delete('tab');
        else url.searchParams.set('tab', tab);
        window.history.replaceState({}, '', url);
    }

    if (tab === 'salud') renderSaludPerro();
}

// ===================== Sub-pestañas (Ejercicios / Cambios / Tareas) =====================

function bindSubtabs() {
    document.querySelectorAll('.subtab').forEach((btn) => {
        btn.addEventListener('click', () => {
            const subtab = btn.dataset.subtab;
            if (!subtab || subtab === state.subtabActiva) return;
            activarSubtab(subtab);
        });
    });

    // Swipe horizontal entre sub-tabs (Ejercicios / Cambios / Tareas).
    initSwipeTabs({
        container: document.querySelector('.tab-panel--ejercicios'),
        tabs: ['ejercicio', 'cambio_rutina', 'tarea'],
        getCurrent: () => state.subtabActiva,
        onChange: (subtab) => activarSubtab(subtab),
    });
}

function activarSubtab(subtab) {
    state.subtabActiva = subtab;
    document.querySelectorAll('.subtab').forEach((b) => {
        const active = b.dataset.subtab === subtab;
        b.classList.toggle('is-active', active);
        b.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    renderEjerciciosActivos();
}

// ===================== Tab Ejercicios — vista principal =====================

// Token incremental para detectar render concurrente. Cada vez que arranca
// renderEjerciciosActivos se queda con un "myToken". Si entre el await y la
// pintada llegó otra llamada (que actualizó el token), la primera abandona
// sin tocar el DOM — así evitamos el flicker "Cargando + empty visibles
// a la vez" que pasaba cuando dos renders se pisaban.
let _renderEjerciciosToken = 0;

async function renderEjerciciosActivos() {
    const myToken = ++_renderEjerciciosToken;

    const loadingEl = document.getElementById('ejercicios-loading');
    const emptyEl = document.getElementById('ejercicios-empty');
    const listaEl = document.getElementById('ejercicios-lista');

    loadingEl.removeAttribute('hidden');
    emptyEl.setAttribute('hidden', '');
    listaEl.setAttribute('hidden', '');
    listaEl.innerHTML = '';

    const { data, error } = await supabase
        .from('ejercicios_asignados')
        .select('ejercicio_id, activo, posicion_rutina, ejercicios (id, codigo, nombre, categoria)')
        .eq('perro_id', state.perroId)
        .eq('activo', true)
        .order('posicion_rutina', { ascending: true });

    // Si otra llamada ya tomó el control, dejamos que esa pinte.
    if (myToken !== _renderEjerciciosToken) return;

    loadingEl.setAttribute('hidden', '');

    const labelEl = document.getElementById('empty-categoria-label');
    if (labelEl) labelEl.textContent = SUBTAB_LABELS[state.subtabActiva] || 'items';

    if (error) {
        console.error('[perro] error cargando ejercicios activos:', error);
        emptyEl.removeAttribute('hidden');
        return;
    }

    // Filtramos por la sub-pestaña activa en cliente. El query trae todas las
    // categorías; el filtro es solo visual — el modal sigue ofreciendo todas.
    const filtered = (data || []).filter(
        (row) => row.ejercicios?.categoria === state.subtabActiva,
    );

    if (!filtered.length) {
        emptyEl.removeAttribute('hidden');
        return;
    }

    listaEl.removeAttribute('hidden');
    listaEl.innerHTML = filtered
        .map((row) => renderEjercicioActivoCard(row))
        .join('');

    // Wire toggles inline (pausar desde la lista principal).
    listaEl.querySelectorAll('.toggle').forEach((btn) => {
        btn.addEventListener('click', () => onTogglePrincipal(btn));
    });
}

function renderEjercicioActivoCard(row) {
    const ej = row.ejercicios;
    if (!ej) return '';
    const nombre = escapeHTML(ej.nombre || 'Sin nombre');
    const categoria = ej.categoria || 'ejercicio';

    return `
        <li class="ejercicio-activo-card" data-ejercicio-id="${escapeHTML(ej.id)}">
            <div class="ejercicio-activo-info">
                <span class="ejercicio-activo-nombre">${nombre}</span>
                <span class="cat-chip cat-chip--${escapeHTML(categoria)}">${escapeHTML(CATEGORIA_LABEL[categoria] || categoria)}</span>
            </div>
            <button type="button" class="toggle toggle--small" role="switch" aria-checked="true" aria-label="Pausar ${nombre}" data-ejercicio-id="${escapeHTML(ej.id)}">
                <span class="toggle-thumb"></span>
            </button>
        </li>
    `;
}

async function onTogglePrincipal(btn) {
    const ejercicioId = btn.dataset.ejercicioId;
    if (!ejercicioId) return;

    // Está activo → lo pausamos (off). Optimistic UI.
    btn.setAttribute('aria-checked', 'false');
    btn.disabled = true;

    try {
        await toggleOff(state.perroId, ejercicioId);
        state.asignados.set(ejercicioId, { activo: false });
        toast('Ejercicio pausado');
        // El ítem desaparece de la lista de activos: refrescamos.
        await renderEjerciciosActivos();
    } catch (err) {
        console.error('[perro] toggle off principal falló:', err);
        btn.setAttribute('aria-checked', 'true');
        btn.disabled = false;
        toast('No se pudo pausar el ejercicio', 'error');
    }
}

// ===================== Bottom sheet =====================

function bindModal() {
    document.getElementById('abrir-modal-ejercicios').addEventListener('click', abrirModal);

    const modal = document.getElementById('modal-ejercicios');
    modal.addEventListener('click', (e) => {
        if (e.target.closest('[data-close]')) cerrarModal();
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !modal.hasAttribute('hidden')) cerrarModal();
    });

    document.getElementById('modal-search').addEventListener('input', (e) => {
        state.modalSearch = e.target.value.trim().toLowerCase();
        renderModalLista();
    });

    document.getElementById('modal-filtros').addEventListener('click', (e) => {
        const chip = e.target.closest('.chip');
        if (!chip) return;
        const cat = chip.dataset.cat;
        if (!cat || cat === state.modalCatFilter) return;
        state.modalCatFilter = cat;
        document.querySelectorAll('#modal-filtros .chip').forEach((c) => {
            const active = c === chip;
            c.classList.toggle('is-active', active);
            c.setAttribute('aria-selected', active ? 'true' : 'false');
        });
        renderModalLista();
    });

    bindSwipeClose();
}

async function abrirModal() {
    const modal = document.getElementById('modal-ejercicios');
    const lista = document.getElementById('modal-lista');

    // Reset de filtros y búsqueda al abrir.
    state.modalSearch = '';
    state.modalCatFilter = 'todos';
    document.getElementById('modal-search').value = '';
    document.querySelectorAll('#modal-filtros .chip').forEach((c) => {
        const active = c.dataset.cat === 'todos';
        c.classList.toggle('is-active', active);
        c.setAttribute('aria-selected', active ? 'true' : 'false');
    });

    lista.innerHTML = '<p class="muted modal-lista__empty">Cargando catálogo…</p>';

    modal.removeAttribute('hidden');
    modal.setAttribute('aria-hidden', 'false');
    // Forzar reflow antes de aplicar la clase para que la transición se vea.
    requestAnimationFrame(() => modal.classList.add('is-open'));
    document.body.style.overflow = 'hidden';

    try {
        await Promise.all([cargarCatalogo(), cargarAsignados()]);
        renderModalLista();
    } catch (err) {
        console.error('[perro] error cargando modal:', err);
        lista.innerHTML = '<p class="muted modal-lista__empty">Error cargando el catálogo. Cerrá y reintentá.</p>';
    }
}

function cerrarModal() {
    const modal = document.getElementById('modal-ejercicios');
    if (modal.hasAttribute('hidden')) return;
    const panel = modal.querySelector('.bottom-sheet__panel');

    // Limpiamos cualquier transform de drag pendiente.
    panel.style.transform = '';
    panel.style.transition = '';

    modal.classList.remove('is-open');
    document.body.style.overflow = '';

    setTimeout(() => {
        modal.setAttribute('hidden', '');
        modal.setAttribute('aria-hidden', 'true');
        // Refrescamos la vista principal con los nuevos activos.
        renderEjerciciosActivos();
    }, 300);
}

async function cargarCatalogo() {
    if (state.catalogo) return; // cache
    const { data, error } = await supabase
        .from('ejercicios')
        .select('id, codigo, nombre, descripcion, categoria, orden_catalogo')
        .eq('activo', true)
        .order('categoria', { ascending: true })
        .order('orden_catalogo', { ascending: true });

    if (error) {
        console.error('[perro] error cargando catálogo:', error);
        throw error;
    }
    state.catalogo = data || [];
}

async function cargarAsignados() {
    const { data, error } = await supabase
        .from('ejercicios_asignados')
        .select('ejercicio_id, activo, posicion_rutina')
        .eq('perro_id', state.perroId);

    if (error) {
        console.error('[perro] error cargando asignados:', error);
        throw error;
    }

    state.asignados = new Map();
    (data || []).forEach((a) => {
        state.asignados.set(a.ejercicio_id, {
            activo: !!a.activo,
            posicion_rutina: a.posicion_rutina,
        });
    });
}

function renderModalLista() {
    const lista = document.getElementById('modal-lista');
    if (!state.catalogo) return;

    const filtrados = state.catalogo.filter((ej) => {
        if (state.modalCatFilter !== 'todos' && ej.categoria !== state.modalCatFilter) return false;
        if (state.modalSearch) {
            const haystack = `${ej.nombre || ''} ${ej.descripcion || ''}`.toLowerCase();
            if (!haystack.includes(state.modalSearch)) return false;
        }
        return true;
    });

    if (filtrados.length === 0) {
        lista.innerHTML = '<p class="muted modal-lista__empty">No hay ejercicios para este filtro.</p>';
        return;
    }

    lista.innerHTML = filtrados.map((ej) => renderModalRow(ej)).join('');

    lista.querySelectorAll('.toggle').forEach((btn) => {
        btn.addEventListener('click', () => onToggleModal(btn));
    });
}

function renderModalRow(ej) {
    const id = ej.id;
    const nombre = escapeHTML(ej.nombre || 'Sin nombre');
    const desc = ej.descripcion ? escapeHTML(ej.descripcion) : '';
    const categoria = ej.categoria || 'ejercicio';
    const asignado = state.asignados.get(id);
    const isOn = !!asignado?.activo;

    return `
        <article class="modal-row" role="listitem">
            <div class="modal-row__info">
                <span class="modal-row__nombre">${nombre}</span>
                <span class="cat-chip cat-chip--${escapeHTML(categoria)} cat-chip--mini">${escapeHTML(CATEGORIA_LABEL[categoria] || categoria)}</span>
                ${desc ? `<span class="modal-row__desc">${desc}</span>` : ''}
            </div>
            <button type="button" class="toggle" role="switch" aria-checked="${isOn}" aria-label="${isOn ? 'Pausar' : 'Activar'} ${nombre}" data-ejercicio-id="${escapeHTML(id)}">
                <span class="toggle-thumb"></span>
            </button>
        </article>
    `;
}

async function onToggleModal(btn) {
    const ejercicioId = btn.dataset.ejercicioId;
    if (!ejercicioId) return;

    const wasOn = btn.getAttribute('aria-checked') === 'true';
    const target = !wasOn;

    // Optimistic UI
    btn.setAttribute('aria-checked', target ? 'true' : 'false');
    btn.disabled = true;

    try {
        if (target) {
            await toggleOn(state.perroId, ejercicioId);
            const prev = state.asignados.get(ejercicioId);
            state.asignados.set(ejercicioId, {
                activo: true,
                posicion_rutina: prev?.posicion_rutina ?? null,
            });
            toast('Ejercicio activado');
        } else {
            await toggleOff(state.perroId, ejercicioId);
            const prev = state.asignados.get(ejercicioId) || {};
            state.asignados.set(ejercicioId, { ...prev, activo: false });
            toast('Ejercicio pausado');
        }
    } catch (err) {
        console.error('[perro] toggle modal falló:', err);
        btn.setAttribute('aria-checked', wasOn ? 'true' : 'false');
        toast('No se pudo guardar el cambio', 'error');
    } finally {
        btn.disabled = false;
    }
}

// ===================== Lógica DB de toggle =====================

async function toggleOn(perroId, ejercicioId) {
    // Si ya existe la fila, UPDATE activo=true (mantiene posicion_rutina);
    // si no, INSERT con posicion_rutina = MAX(perro)+1 (o 0 si no hay).
    const { data: existing, error: e1 } = await supabase
        .from('ejercicios_asignados')
        .select('perro_id, ejercicio_id, posicion_rutina')
        .eq('perro_id', perroId)
        .eq('ejercicio_id', ejercicioId)
        .maybeSingle();

    if (e1) throw e1;

    const ahora = new Date().toISOString();

    if (existing) {
        const { error } = await supabase
            .from('ejercicios_asignados')
            .update({ activo: true, actualizado_en: ahora })
            .eq('perro_id', perroId)
            .eq('ejercicio_id', ejercicioId);
        if (error) throw error;
        return;
    }

    // Calculamos siguiente posicion_rutina entre todos los del perro
    // (incluyendo pausados, para mantener un orden estable y sin colisiones).
    const { data: maxRow, error: e2 } = await supabase
        .from('ejercicios_asignados')
        .select('posicion_rutina')
        .eq('perro_id', perroId)
        .order('posicion_rutina', { ascending: false })
        .limit(1)
        .maybeSingle();

    if (e2) throw e2;
    const nextPos = (maxRow?.posicion_rutina ?? -1) + 1;

    const { error: e3 } = await supabase
        .from('ejercicios_asignados')
        .insert({
            perro_id: perroId,
            ejercicio_id: ejercicioId,
            activo: true,
            posicion_rutina: nextPos,
            actualizado_en: ahora,
        });
    if (e3) throw e3;
}

async function toggleOff(perroId, ejercicioId) {
    const { error } = await supabase
        .from('ejercicios_asignados')
        .update({ activo: false, actualizado_en: new Date().toISOString() })
        .eq('perro_id', perroId)
        .eq('ejercicio_id', ejercicioId);
    if (error) throw error;
}

// ===================== Swipe-to-close del bottom sheet =====================

function bindSwipeClose() {
    const handle = document.getElementById('modal-handle');
    const modal = document.getElementById('modal-ejercicios');
    const panel = modal.querySelector('.bottom-sheet__panel');

    let startY = 0;
    let currentY = 0;
    let dragging = false;

    handle.addEventListener('touchstart', (e) => {
        if (modal.hasAttribute('hidden')) return;
        startY = e.touches[0].clientY;
        currentY = 0;
        dragging = true;
        panel.style.transition = 'none';
    }, { passive: true });

    handle.addEventListener('touchmove', (e) => {
        if (!dragging) return;
        const dy = e.touches[0].clientY - startY;
        currentY = dy < 0 ? 0 : dy;
        panel.style.transform = `translateY(${currentY}px)`;
    }, { passive: true });

    handle.addEventListener('touchend', () => {
        if (!dragging) return;
        dragging = false;
        panel.style.transition = '';
        if (currentY > 100) {
            cerrarModal();
        } else {
            panel.style.transform = '';
        }
        currentY = 0;
    });

    handle.addEventListener('touchcancel', () => {
        if (!dragging) return;
        dragging = false;
        panel.style.transition = '';
        panel.style.transform = '';
        currentY = 0;
    });
}

// ===================== Toast =====================

let toastTimer = null;
function toast(msg, kind = 'info') {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.remove('toast--info', 'toast--error');
    el.classList.add(kind === 'error' ? 'toast--error' : 'toast--info');
    el.removeAttribute('hidden');

    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
        el.setAttribute('hidden', '');
    }, 2200);
}

// ===================== Helpers =====================

function showScreen(name) {
    Object.entries(SCREENS).forEach(([key, el]) => {
        if (!el) return;
        if (key === name) el.removeAttribute('hidden');
        else el.setAttribute('hidden', '');
    });
}

function mostrarError(msg) {
    const el = document.getElementById('error-message');
    if (el) el.textContent = msg;
    showScreen('error');
}

function setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
}

function escapeHTML(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// ===================== Tab Salud Comportamental =====================

// Token incremental — mismo patrón que _renderEjerciciosToken: si entre el
// await del RPC y la pintada llegó otra llamada (cambio de tab rápido,
// rebote), la primera abandona sin tocar el DOM y evita el flicker
// "Cargando + empty + content visibles a la vez".
let _renderSaludToken = 0;

async function renderSaludPerro() {
    const myToken = ++_renderSaludToken;

    const loadingEl = document.getElementById('admin-salud-loading');
    const emptyEl = document.getElementById('admin-salud-empty');
    const contentEl = document.getElementById('admin-salud-content');
    if (!loadingEl || !emptyEl || !contentEl) return;

    loadingEl.removeAttribute('hidden');
    emptyEl.setAttribute('hidden', '');
    contentEl.setAttribute('hidden', '');

    if (!state.perroId) {
        loadingEl.setAttribute('hidden', '');
        emptyEl.removeAttribute('hidden');
        return;
    }

    const { data, error } = await supabase.rpc('listar_evaluaciones_perro', {
        p_perro_id: state.perroId,
    });

    // Si otra llamada ya tomó el control, dejamos que esa pinte.
    if (myToken !== _renderSaludToken) return;

    loadingEl.setAttribute('hidden', '');

    if (error) {
        console.error('[admin/perro] error cargando salud:', error);
        emptyEl.removeAttribute('hidden');
        return;
    }

    if (!data || data.length === 0) {
        emptyEl.removeAttribute('hidden');
        return;
    }

    const ultima = data[0];
    setText('admin-salud-fisica', ultima.score_fisica);
    setText('admin-salud-emocional', ultima.score_emocional);
    setText('admin-salud-social', ultima.score_social);
    setText('admin-salud-cognitiva', ultima.score_cognitiva);
    setText('admin-salud-total', ultima.score_total + '/100');
    setText('admin-salud-fecha', new Date(ultima.created_at).toLocaleString('es-ES'));

    document.getElementById('admin-salud-historico').innerHTML = data.map((ev) => `
        <li class="admin-salud-historico-item">
            <span class="admin-salud-historico-fecha">${new Date(ev.created_at).toLocaleDateString('es-ES')}</span>
            <span class="admin-salud-historico-scores">
                F:${ev.score_fisica} · E:${ev.score_emocional} · S:${ev.score_social} · C:${ev.score_cognitiva}
            </span>
            <span class="admin-salud-historico-total">${ev.score_total}/100</span>
            ${ev.bandera_roja ? '<span class="bandera-roja" title="Bandera roja">🚩</span>' : ''}
        </li>
    `).join('');

    contentEl.removeAttribute('hidden');
}
