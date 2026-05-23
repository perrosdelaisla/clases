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
    progresionContext: null,         // { vigenteId, posicion } cuando el modal se abre en modo progresión
    modoReordenar: false,            // true mientras se reordenan los renglones de la sub-pestaña
    reordenInicial: null,            // orden de vigente-ids al entrar al modo reordenar (para detectar cambios)
    frecuenciaContext: null,         // { asignadoId, ejercicioNombre } cuando #modal-frecuencia está abierto
};

document.addEventListener('DOMContentLoaded', bootstrap);

async function bootstrap() {
    showScreen('loading');
    bindTabs();
    bindSubtabs();
    bindModal();
    bindReordenar();
    bindPausados();
    bindFrecuencia();
    bindHerramientas();
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
        bindBackNavigation();

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
    if (tab === 'herramientas') renderHerramientas();
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
    // Mientras se reordena, las sub-pestañas quedan bloqueadas (también las
    // que dispararía el swipe horizontal).
    if (state.modoReordenar) return;
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
    // El botón "Reordenar" se vuelve a mostrar al final si corresponde.
    document.getElementById('abrir-reordenar')?.setAttribute('hidden', '');

    const { data, error } = await supabase
        .from('ejercicios_asignados')
        .select('id, ejercicio_id, activo, posicion_rutina, progresa_de, min_semanal, max_semanal, ejercicios (id, codigo, nombre, categoria)')
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

    // Cada renglón de la rutina es una cadena de filas (progresiones). Lo que
    // se muestra es la punta de cada cadena (el "vigente"); las filas previas
    // son historia. El filtro por sub-pestaña se aplica sobre la categoría del
    // vigente, no sobre cada fila. El modal sigue ofreciendo todas.
    const cadenas = construirCadenas(data || [])
        .filter((c) => c.vigente.ejercicios?.categoria === state.subtabActiva)
        .sort((a, b) => (a.vigente.posicion_rutina ?? 0) - (b.vigente.posicion_rutina ?? 0));

    if (!cadenas.length) {
        emptyEl.removeAttribute('hidden');
        return;
    }

    listaEl.removeAttribute('hidden');
    listaEl.innerHTML = cadenas
        .map((c) => renderEjercicioActivoCard(c.vigente, c.history))
        .join('');

    // Wire toggle inline de pausa (solo renglones simples) + acciones de progresión.
    listaEl.querySelectorAll('.toggle').forEach((btn) => {
        btn.addEventListener('click', () => onTogglePrincipal(btn));
    });
    listaEl.querySelectorAll('[data-accion="progresar"]').forEach((btn) => {
        btn.addEventListener('click', () => abrirModalProgresion(btn));
    });
    listaEl.querySelectorAll('[data-accion="ver"]').forEach((btn) => {
        btn.addEventListener('click', () => toggleHistoria(btn));
    });
    listaEl.querySelectorAll('[data-accion="borrar"]').forEach((btn) => {
        btn.addEventListener('click', () => borrarUltimoPaso(btn));
    });
    listaEl.querySelectorAll('[data-mover]').forEach((btn) => {
        btn.addEventListener('click', () => moverRenglon(btn, btn.dataset.mover));
    });
    listaEl.querySelectorAll('[data-accion="frecuencia"]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const card = btn.closest('.ejercicio-activo-card');
            const nombre = card?.querySelector('.ejercicio-activo-nombre')?.textContent || '';
            abrirModalFrecuencia({
                asignadoId: btn.dataset.asignadoId,
                ejercicioNombre: nombre,
                min: btn.dataset.min ? Number(btn.dataset.min) : null,
                max: btn.dataset.max ? Number(btn.dataset.max) : null,
            });
        });
    });

    // "Reordenar" solo tiene sentido con ≥2 renglones en la sub-pestaña.
    const btnReordenar = document.getElementById('abrir-reordenar');
    if (btnReordenar && cadenas.length >= 2 && !state.modoReordenar) {
        btnReordenar.removeAttribute('hidden');
    }
}

// Arma las cadenas de progresión a partir de las filas activas.
// vigente = fila cuyo id no aparece en progresa_de de ninguna otra fila.
// history = filas superadas, del paso más reciente (padre directo) al más viejo.
function construirCadenas(rows) {
    const byId = new Map();
    rows.forEach((r) => byId.set(r.id, r));

    const referenced = new Set();
    rows.forEach((r) => {
        if (r.progresa_de) referenced.add(r.progresa_de);
    });

    return rows
        .filter((r) => !referenced.has(r.id))
        .map((vigente) => {
            const history = [];
            const guard = new Set();   // corta loops si los datos vinieran corruptos
            let cur = vigente.progresa_de ? byId.get(vigente.progresa_de) : null;
            while (cur && !guard.has(cur.id)) {
                guard.add(cur.id);
                history.push(cur);
                cur = cur.progresa_de ? byId.get(cur.progresa_de) : null;
            }
            return { vigente, history };
        });
}

// Label compacto para el chip de frecuencia semanal. Reglas exactas
// definidas en la spec del Paso 4 (ambos NULL = pendiente, etc).
function labelFrecuencia(min, max) {
    if (min == null && max == null) return '+ Frecuencia';
    if (min != null && max != null && min === max) return `${min} / sem`;
    if (min != null && max != null) return `${min}–${max} / sem`;
    if (min != null) return `≥${min} / sem`;
    return `≤${max} / sem`;
}

function renderEjercicioActivoCard(row, history = []) {
    const ej = row.ejercicios;
    if (!ej) return '';
    const nombre = escapeHTML(ej.nombre || 'Sin nombre');
    const categoria = ej.categoria || 'ejercicio';
    const tieneHistoria = history.length > 0;
    const catChip = `<span class="cat-chip cat-chip--${escapeHTML(categoria)}">${escapeHTML(CATEGORIA_LABEL[categoria] || categoria)}</span>`;

    const min = row.min_semanal ?? null;
    const max = row.max_semanal ?? null;
    const vacio = (min == null && max == null);
    const freqLabel = escapeHTML(labelFrecuencia(min, max));
    const freqChip = `
        <button type="button"
                class="frecuencia-chip${vacio ? ' frecuencia-chip--vacio' : ''}"
                data-accion="frecuencia"
                data-asignado-id="${escapeHTML(row.id)}"
                data-min="${escapeHTML(min == null ? '' : String(min))}"
                data-max="${escapeHTML(max == null ? '' : String(max))}"
                aria-label="Configurar frecuencia semanal">
            ${freqLabel}
        </button>`;

    // El toggle de pausa solo va en renglones simples (sin historia). Los
    // renglones con progresiones se retroceden con "Borrar último paso".
    const toggle = tieneHistoria ? '' : `
                <button type="button" class="toggle toggle--small" role="switch" aria-checked="true" aria-label="Pausar ${nombre}" data-ejercicio-id="${escapeHTML(ej.id)}">
                    <span class="toggle-thumb"></span>
                </button>`;

    let historiaHtml = '';
    if (tieneHistoria) {
        const pasos = history.map((h) => {
            const hnombre = escapeHTML(h.ejercicios?.nombre || 'Sin nombre');
            return `<li class="progresion-paso">${hnombre}</li>`;
        }).join('');
        historiaHtml = `<ul class="progresion-historia" hidden>${pasos}</ul>`;
    }

    const accVer = tieneHistoria
        ? `<button type="button" class="progresion-link" data-accion="ver" aria-expanded="false">Ver pasos anteriores</button>`
        : '';
    const accBorrar = tieneHistoria
        ? `<button type="button" class="progresion-link progresion-link--danger" data-accion="borrar">Borrar último paso</button>`
        : '';

    return `
        <li class="ejercicio-activo-card" data-vigente-id="${escapeHTML(row.id)}" data-ejercicio-id="${escapeHTML(ej.id)}" data-posicion="${escapeHTML(String(row.posicion_rutina ?? ''))}">
            <div class="ejercicio-activo-top">
                <div class="ejercicio-activo-info">
                    <span class="ejercicio-activo-nombre">${nombre}</span>
                    <div class="ejercicio-activo-chips">
                        ${catChip}
                        ${freqChip}
                    </div>
                </div>${toggle}
            </div>
            ${historiaHtml}
            <div class="ejercicio-activo-acciones">
                ${accVer}
                <button type="button" class="progresion-link" data-accion="progresar">+ Agregar progresión</button>
                ${accBorrar}
            </div>
            <div class="reordenar-controles">
                <button type="button" class="reordenar-btn" data-mover="subir" aria-label="Subir renglón">▲</button>
                <button type="button" class="reordenar-btn" data-mover="bajar" aria-label="Bajar renglón">▼</button>
            </div>
        </li>
    `;
}

function toggleHistoria(btn) {
    const card = btn.closest('.ejercicio-activo-card');
    const hist = card?.querySelector('.progresion-historia');
    if (!hist) return;
    if (hist.hasAttribute('hidden')) {
        hist.removeAttribute('hidden');
        btn.textContent = 'Ocultar pasos anteriores';
        btn.setAttribute('aria-expanded', 'true');
    } else {
        hist.setAttribute('hidden', '');
        btn.textContent = 'Ver pasos anteriores';
        btn.setAttribute('aria-expanded', 'false');
    }
}

// Borra la fila vigente de un renglón con historia: la fila a la que apuntaba
// pasa a ser vigente. Solo se ofrece en renglones con ≥2 pasos.
async function borrarUltimoPaso(btn) {
    const card = btn.closest('.ejercicio-activo-card');
    const vigenteId = card?.dataset.vigenteId;
    if (!vigenteId) return;
    if (!confirm('¿Borrar este paso? El renglón vuelve al ejercicio anterior.')) return;

    btn.disabled = true;
    try {
        const { error } = await supabase
            .from('ejercicios_asignados')
            .delete()
            .eq('id', vigenteId);
        if (error) throw error;
        toast('Paso borrado');
        await renderEjerciciosActivos();
    } catch (err) {
        console.error('[perro] error borrando paso:', err);
        btn.disabled = false;
        toast('No se pudo borrar el paso', 'error');
    }
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

// ===================== Reordenar renglones =====================

function bindReordenar() {
    document.getElementById('abrir-reordenar')
        ?.addEventListener('click', entrarModoReordenar);
    document.getElementById('btn-finalizar-reordenar')
        ?.addEventListener('click', finalizarReordenar);
}

// Lee el orden actual de renglones (vigente-ids) según el DOM.
function leerOrdenRenglones() {
    return [...document.querySelectorAll('#ejercicios-lista .ejercicio-activo-card')]
        .map((card) => card.dataset.vigenteId);
}

function entrarModoReordenar() {
    state.modoReordenar = true;
    state.reordenInicial = leerOrdenRenglones();

    document.getElementById('ejercicios-lista').classList.add('modo-reordenar');
    document.getElementById('abrir-reordenar').setAttribute('hidden', '');
    document.getElementById('abrir-pausados').setAttribute('hidden', '');
    document.getElementById('abrir-modal-ejercicios').setAttribute('hidden', '');
    document.getElementById('btn-finalizar-reordenar').removeAttribute('hidden');
    document.querySelectorAll('.subtab').forEach((b) => { b.disabled = true; });

    actualizarFlechasReordenar();
    pushHistoriaUI();
}

function salirModoReordenar() {
    state.modoReordenar = false;
    state.reordenInicial = null;

    document.getElementById('ejercicios-lista').classList.remove('modo-reordenar');
    document.getElementById('abrir-modal-ejercicios').removeAttribute('hidden');
    document.getElementById('abrir-pausados').removeAttribute('hidden');
    document.getElementById('btn-finalizar-reordenar').setAttribute('hidden', '');
    document.querySelectorAll('.subtab').forEach((b) => { b.disabled = false; });

    // "Reordenar" vuelve a estar disponible si el render no lo refresca después.
    const n = document.querySelectorAll('#ejercicios-lista .ejercicio-activo-card').length;
    document.getElementById('abrir-reordenar').toggleAttribute('hidden', n < 2);

    consumirHistoriaUI();
}

// Deshabilita ▲ en la primera tarjeta y ▼ en la última.
function actualizarFlechasReordenar() {
    const cards = [...document.querySelectorAll('#ejercicios-lista .ejercicio-activo-card')];
    cards.forEach((card, i) => {
        const subir = card.querySelector('[data-mover="subir"]');
        const bajar = card.querySelector('[data-mover="bajar"]');
        if (subir) subir.disabled = i === 0;
        if (bajar) bajar.disabled = i === cards.length - 1;
    });
}

// Mueve la tarjeta en el DOM. Todavía no persiste nada.
function moverRenglon(btn, dir) {
    const card = btn.closest('.ejercicio-activo-card');
    if (!card) return;
    if (dir === 'subir') {
        const prev = card.previousElementSibling;
        if (prev) card.parentNode.insertBefore(card, prev);
    } else {
        const next = card.nextElementSibling;
        if (next) card.parentNode.insertBefore(next, card);
    }
    actualizarFlechasReordenar();
}

async function finalizarReordenar() {
    const orden = leerOrdenRenglones();
    const inicial = state.reordenInicial || [];
    const sinCambios = orden.length === inicial.length
        && orden.every((id, i) => id === inicial[i]);

    if (sinCambios) {
        salirModoReordenar();
        return;
    }

    const btn = document.getElementById('btn-finalizar-reordenar');
    btn.disabled = true;
    try {
        const { error } = await supabase.rpc('reordenar_renglones', {
            p_perro_id: state.perroId,
            p_vigentes_ordenados: orden,
        });
        if (error) throw error;
        toast('Orden guardado');
        salirModoReordenar();
        await renderEjerciciosActivos();
    } catch (err) {
        console.error('[perro] error reordenando renglones:', err);
        toast('No se pudo guardar el orden', 'error');
        // Nos quedamos en modo reordenar para que se pueda reintentar.
    } finally {
        btn.disabled = false;
    }
}

// ═══════════════════════ Back navigation (botón atrás) ═══════════════════════
// Mismo patrón que admin.js: un "anchor" siempre en la historia; abrir una
// hoja/modal o entrar en modo reordenar suma una entrada. El handler de
// popstate decide, según la UI visible, qué hace el back físico.

let navegandoPorPopstate = false;
let cierreUiPendiente = false;
let saliendoDePerro = false;

function bindBackNavigation() {
    if (window.__perroBackNavBound) return;
    window.__perroBackNavBound = true;

    // Anchor inicial: el primer back físico dispara popstate en vez de salir.
    history.pushState({ pdli: 'anchor' }, '');

    window.addEventListener('popstate', () => {
        if (saliendoDePerro) return;   // ya estamos volviendo al cliente

        // Back originado por un cierre desde la UI: solo consumir y re-anclar.
        if (cierreUiPendiente) {
            cierreUiPendiente = false;
            history.pushState({ pdli: 'anchor' }, '');
            return;
        }

        // Prioridad 1: hoja/modal abierta o modo reordenar → cerrar / salir.
        if (hayUiAbierta()) {
            history.pushState({ pdli: 'anchor' }, '');
            navegandoPorPopstate = true;
            try { cerrarUiAbierta(); } finally { navegandoPorPopstate = false; }
            return;
        }

        // Prioridad 2: pestaña ≠ default → volver a la default.
        const tabActual = document.querySelector('.tab.is-active')?.dataset.tab;
        if (tabActual && tabActual !== DEFAULT_TAB) {
            history.pushState({ pdli: 'anchor' }, '');
            navegandoPorPopstate = true;
            try { activarTab(DEFAULT_TAB); } finally { navegandoPorPopstate = false; }
            return;
        }

        // Prioridad 3: nada abierto, pestaña default → back natural al cliente.
        saliendoDePerro = true;
        history.back();
    });
}

// ¿Hay una hoja/modal abierta o el modo reordenar activo?
function hayUiAbierta() {
    const cat = document.getElementById('modal-ejercicios');
    const pau = document.getElementById('modal-pausados');
    const fre = document.getElementById('modal-frecuencia');
    return (cat && !cat.hasAttribute('hidden'))
        || (pau && !pau.hasAttribute('hidden'))
        || (fre && !fre.hasAttribute('hidden'))
        || state.modoReordenar === true;
}

// Cierra la primera UI abierta que encuentre (solo hay una a la vez).
function cerrarUiAbierta() {
    const cat = document.getElementById('modal-ejercicios');
    const pau = document.getElementById('modal-pausados');
    const fre = document.getElementById('modal-frecuencia');
    if (cat && !cat.hasAttribute('hidden')) { cerrarModal(); return; }
    if (pau && !pau.hasAttribute('hidden')) { cerrarSheetPausados(); return; }
    if (fre && !fre.hasAttribute('hidden')) { cerrarModalFrecuencia(); return; }
    if (state.modoReordenar) { salirModoReordenar(); return; }
}

// Al abrir una hoja/modal o entrar en modo reordenar: sumamos una entrada al
// historial para que el back físico la consuma (salvo que el cambio venga
// de un popstate, donde el handler ya re-ancló).
function pushHistoriaUI() {
    if (!navegandoPorPopstate) {
        history.pushState({ pdli: 'perro-ui' }, '');
    }
}

// Al cerrar desde la UI (X, backdrop, swipe, botón): consumimos la entrada
// que sumamos al abrir. cierreUiPendiente evita que el handler haga de más.
function consumirHistoriaUI() {
    if (!navegandoPorPopstate) {
        cierreUiPendiente = true;
        history.back();
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

    bindSwipeClose('modal-handle', 'modal-ejercicios', cerrarModal);
}

// Apertura normal: toggles ON/OFF sobre el catálogo.
async function abrirModal() {
    state.progresionContext = null;
    await abrirSheetCatalogo('Agregar ejercicios');
}

// Apertura en modo progresión: tocar un ejercicio lo inserta como nuevo
// paso del renglón sobre el que se abrió (hereda posicion_rutina, apunta
// con progresa_de al vigente actual).
async function abrirModalProgresion(btn) {
    const card = btn.closest('.ejercicio-activo-card');
    if (!card || !card.dataset.vigenteId) return;
    state.progresionContext = {
        vigenteId: card.dataset.vigenteId,
        posicion: Number(card.dataset.posicion),
    };
    await abrirSheetCatalogo('Agregar progresión');
}

async function abrirSheetCatalogo(titulo) {
    const modal = document.getElementById('modal-ejercicios');
    const lista = document.getElementById('modal-lista');
    const tituloEl = document.getElementById('modal-titulo');
    if (tituloEl) tituloEl.textContent = titulo;

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
    pushHistoriaUI();

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
    consumirHistoriaUI();
    const panel = modal.querySelector('.bottom-sheet__panel');

    // Limpiamos cualquier transform de drag pendiente.
    panel.style.transform = '';
    panel.style.transition = '';

    modal.classList.remove('is-open');
    document.body.style.overflow = '';
    state.progresionContext = null;

    setTimeout(() => {
        modal.setAttribute('hidden', '');
        modal.setAttribute('aria-hidden', 'true');
        // Refrescamos el panel de rutina que esté activo (Ejercicios o Herramientas).
        refrescarPanelActivo();
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

    const enProgresion = !!state.progresionContext;
    lista.innerHTML = filtrados
        .map((ej) => (enProgresion ? renderModalRowProgresion(ej) : renderModalRow(ej)))
        .join('');

    if (enProgresion) {
        lista.querySelectorAll('.modal-row--progresion').forEach((btn) => {
            btn.addEventListener('click', () => onSeleccionarProgresion(btn));
        });
    } else {
        lista.querySelectorAll('.toggle').forEach((btn) => {
            btn.addEventListener('click', () => onToggleModal(btn));
        });
    }
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

// ===================== Modo progresión =====================

function renderModalRowProgresion(ej) {
    const id = ej.id;
    const nombre = escapeHTML(ej.nombre || 'Sin nombre');
    const desc = ej.descripcion ? escapeHTML(ej.descripcion) : '';
    const categoria = ej.categoria || 'ejercicio';

    // El perro ya tiene este ejercicio (activo o en pausa): no se puede volver
    // a insertar — chocaría con el UNIQUE (perro_id, ejercicio_id). Se muestra
    // apagado y no clickeable.
    const ocupado = state.asignados.has(ej.id);
    const sufijo = ocupado
        ? '<span class="modal-row__ocupada">Ya está en la rutina</span>'
        : '<span class="modal-row__add" aria-hidden="true">+</span>';

    return `
        <button type="button" class="modal-row modal-row--progresion${ocupado ? ' modal-row--ocupada' : ''}" role="listitem" data-ejercicio-id="${escapeHTML(id)}"${ocupado ? ' disabled' : ''}>
            <div class="modal-row__info">
                <span class="modal-row__nombre">${nombre}</span>
                <span class="cat-chip cat-chip--${escapeHTML(categoria)} cat-chip--mini">${escapeHTML(CATEGORIA_LABEL[categoria] || categoria)}</span>
                ${desc ? `<span class="modal-row__desc">${desc}</span>` : ''}
            </div>
            ${sufijo}
        </button>
    `;
}

// Inserta el ejercicio elegido como nuevo paso del renglón: hereda
// posicion_rutina del vigente y lo apunta con progresa_de. El que era
// vigente queda superado solo (nadie más lo necesita marcar).
async function onSeleccionarProgresion(btn) {
    const ejercicioId = btn.dataset.ejercicioId;
    const ctx = state.progresionContext;
    if (!ejercicioId || !ctx || !ctx.vigenteId) return;

    btn.disabled = true;
    try {
        const { error } = await supabase
            .from('ejercicios_asignados')
            .insert({
                perro_id: state.perroId,
                ejercicio_id: ejercicioId,
                activo: true,
                posicion_rutina: ctx.posicion,
                progresa_de: ctx.vigenteId,
                actualizado_en: new Date().toISOString(),
            });
        if (error) throw error;
        toast('Progresión agregada');
        cerrarModal();
    } catch (err) {
        console.error('[perro] error agregando progresión:', err);
        btn.disabled = false;
        toast('No se pudo agregar la progresión', 'error');
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

function bindSwipeClose(handleId, modalId, onClose) {
    const handle = document.getElementById(handleId);
    const modal = document.getElementById(modalId);
    if (!handle || !modal) return;
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
            onClose();
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

// ===================== Hoja de ejercicios pausados =====================

function bindPausados() {
    document.getElementById('abrir-pausados')
        ?.addEventListener('click', abrirSheetPausados);

    const modal = document.getElementById('modal-pausados');
    modal.addEventListener('click', (e) => {
        if (e.target.closest('[data-close]')) cerrarSheetPausados();
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !modal.hasAttribute('hidden')) cerrarSheetPausados();
    });

    bindSwipeClose('modal-pausados-handle', 'modal-pausados', cerrarSheetPausados);
}

function abrirSheetPausados() {
    const modal = document.getElementById('modal-pausados');
    modal.removeAttribute('hidden');
    modal.setAttribute('aria-hidden', 'false');
    // Forzar reflow antes de aplicar la clase para que la transición se vea.
    requestAnimationFrame(() => modal.classList.add('is-open'));
    document.body.style.overflow = 'hidden';
    pushHistoriaUI();
    cargarYRenderPausados();
}

function cerrarSheetPausados() {
    const modal = document.getElementById('modal-pausados');
    if (modal.hasAttribute('hidden')) return;
    consumirHistoriaUI();
    const panel = modal.querySelector('.bottom-sheet__panel');

    // Limpiamos cualquier transform de drag pendiente.
    panel.style.transform = '';
    panel.style.transition = '';

    modal.classList.remove('is-open');
    document.body.style.overflow = '';

    setTimeout(() => {
        modal.setAttribute('hidden', '');
        modal.setAttribute('aria-hidden', 'true');
    }, 300);
}

// ===================== Hoja de frecuencia semanal =====================

function bindFrecuencia() {
    const modal = document.getElementById('modal-frecuencia');
    if (!modal) return;

    modal.addEventListener('click', (e) => {
        if (e.target.closest('[data-close]')) cerrarModalFrecuencia();
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !modal.hasAttribute('hidden')) cerrarModalFrecuencia();
    });

    document.getElementById('frecuencia-guardar')
        ?.addEventListener('click', guardarFrecuencia);
    document.getElementById('frecuencia-quitar')
        ?.addEventListener('click', quitarFrecuencia);

    bindSwipeClose('frecuencia-handle', 'modal-frecuencia', cerrarModalFrecuencia);
}

function abrirModalFrecuencia({ asignadoId, ejercicioNombre, min, max }) {
    const modal = document.getElementById('modal-frecuencia');
    if (!modal || !asignadoId) return;

    state.frecuenciaContext = { asignadoId, ejercicioNombre };

    const tituloEj = document.getElementById('frecuencia-ejercicio');
    if (tituloEj) tituloEj.textContent = ejercicioNombre || '';

    const minEl = document.getElementById('frecuencia-min');
    const maxEl = document.getElementById('frecuencia-max');
    if (minEl) minEl.value = (min == null ? '' : String(min));
    if (maxEl) maxEl.value = (max == null ? '' : String(max));

    const err = document.getElementById('frecuencia-error');
    if (err) { err.textContent = ''; err.hidden = true; }

    const btnQuitar = document.getElementById('frecuencia-quitar');
    if (btnQuitar) {
        if (min != null || max != null) btnQuitar.removeAttribute('hidden');
        else btnQuitar.setAttribute('hidden', '');
    }

    modal.removeAttribute('hidden');
    modal.setAttribute('aria-hidden', 'false');
    requestAnimationFrame(() => modal.classList.add('is-open'));
    document.body.style.overflow = 'hidden';
    pushHistoriaUI();
}

function cerrarModalFrecuencia() {
    const modal = document.getElementById('modal-frecuencia');
    if (!modal || modal.hasAttribute('hidden')) return;
    consumirHistoriaUI();
    const panel = modal.querySelector('.bottom-sheet__panel');

    panel.style.transform = '';
    panel.style.transition = '';

    modal.classList.remove('is-open');
    document.body.style.overflow = '';
    state.frecuenciaContext = null;

    setTimeout(() => {
        modal.setAttribute('hidden', '');
        modal.setAttribute('aria-hidden', 'true');
    }, 300);
}

// Lee y normaliza los dos inputs: '' → null; el resto Number(...).
// Devuelve { ok, min, max, error } — si ok===false, error trae el msg.
function leerYValidarFrecuencia() {
    const minRaw = document.getElementById('frecuencia-min').value.trim();
    const maxRaw = document.getElementById('frecuencia-max').value.trim();

    const parse = (raw) => {
        if (raw === '') return { ok: true, value: null };
        const n = Number(raw);
        if (!Number.isFinite(n) || !Number.isInteger(n)) {
            return { ok: false, error: 'Debe ser un número entero.' };
        }
        if (n < 0) return { ok: false, error: 'No puede ser negativo.' };
        return { ok: true, value: n };
    };

    const pMin = parse(minRaw);
    if (!pMin.ok) return { ok: false, error: pMin.error };
    const pMax = parse(maxRaw);
    if (!pMax.ok) return { ok: false, error: pMax.error };

    if (pMin.value != null && pMax.value != null && pMax.value < pMin.value) {
        return { ok: false, error: 'El máximo no puede ser menor que el mínimo.' };
    }
    return { ok: true, min: pMin.value, max: pMax.value };
}

async function guardarFrecuencia() {
    const ctx = state.frecuenciaContext;
    const err = document.getElementById('frecuencia-error');
    if (!ctx?.asignadoId) return;

    const v = leerYValidarFrecuencia();
    if (!v.ok) {
        if (err) { err.textContent = v.error; err.hidden = false; }
        return;
    }

    await persistirFrecuencia(ctx.asignadoId, v.min, v.max);
}

async function quitarFrecuencia() {
    const ctx = state.frecuenciaContext;
    if (!ctx?.asignadoId) return;
    await persistirFrecuencia(ctx.asignadoId, null, null);
}

async function persistirFrecuencia(asignadoId, min, max) {
    const err = document.getElementById('frecuencia-error');
    const btnGuardar = document.getElementById('frecuencia-guardar');
    const btnQuitar = document.getElementById('frecuencia-quitar');
    if (btnGuardar) btnGuardar.disabled = true;
    if (btnQuitar) btnQuitar.disabled = true;

    try {
        const { error } = await supabase
            .from('ejercicios_asignados')
            .update({
                min_semanal: min,
                max_semanal: max,
                actualizado_en: new Date().toISOString(),
            })
            .eq('id', asignadoId);
        if (error) throw error;

        cerrarModalFrecuencia();
        await renderEjerciciosActivos();
    } catch (e) {
        console.error('[perro] error guardando frecuencia:', e);
        if (err) { err.textContent = 'No se pudo guardar. Inténtalo de nuevo.'; err.hidden = false; }
    } finally {
        if (btnGuardar) btnGuardar.disabled = false;
        if (btnQuitar) btnQuitar.disabled = false;
    }
}

async function cargarYRenderPausados() {
    const lista = document.getElementById('pausados-lista');
    lista.innerHTML = '<p class="muted modal-lista__empty">Cargando…</p>';

    const { data, error } = await supabase
        .from('ejercicios_asignados')
        .select('id, ejercicio_id, ejercicios (id, nombre, categoria)')
        .eq('perro_id', state.perroId)
        .eq('activo', false);

    if (error) {
        console.error('[perro] error cargando pausados:', error);
        lista.innerHTML = '<p class="muted modal-lista__empty">Error al cargar. Cerrá y reintentá.</p>';
        return;
    }

    const filas = data || [];
    if (!filas.length) {
        lista.innerHTML = '<p class="muted modal-lista__empty">No hay ejercicios pausados.</p>';
        return;
    }

    lista.innerHTML = filas.map(renderPausadoRow).join('');

    lista.querySelectorAll('[data-accion="reactivar"]').forEach((btn) => {
        btn.addEventListener('click', () => onReactivarPausado(btn));
    });
    lista.querySelectorAll('[data-accion="eliminar"]').forEach((btn) => {
        btn.addEventListener('click', () => onEliminarPausado(btn));
    });
}

function renderPausadoRow(row) {
    const ej = row.ejercicios;
    const nombre = escapeHTML(ej?.nombre || 'Sin nombre');
    const categoria = ej?.categoria || 'ejercicio';

    return `
        <article class="modal-row" role="listitem" data-id="${escapeHTML(row.id)}" data-ejercicio-id="${escapeHTML(row.ejercicio_id)}">
            <div class="modal-row__info">
                <span class="modal-row__nombre">${nombre}</span>
                <span class="cat-chip cat-chip--${escapeHTML(categoria)} cat-chip--mini">${escapeHTML(CATEGORIA_LABEL[categoria] || categoria)}</span>
            </div>
            <div class="pausado-acciones">
                <button type="button" class="pausado-btn" data-accion="reactivar">Reactivar</button>
                <button type="button" class="pausado-btn pausado-btn--danger" data-accion="eliminar">Eliminar</button>
            </div>
        </article>
    `;
}

// Reactiva un ejercicio pausado: vuelve a activo=true en su posición original.
async function onReactivarPausado(btn) {
    const row = btn.closest('.modal-row');
    const ejercicioId = row?.dataset.ejercicioId;
    if (!ejercicioId) return;

    btn.disabled = true;
    try {
        await toggleOn(state.perroId, ejercicioId);
        toast('Ejercicio reactivado');
        await cargarYRenderPausados();
        refrescarPanelActivo();
    } catch (err) {
        console.error('[perro] error reactivando pausado:', err);
        btn.disabled = false;
        toast('No se pudo reactivar', 'error');
    }
}

// Elimina de verdad la fila pausada (DELETE por id). Mismo patrón que
// borrarUltimoPaso. Los pausados son siempre renglones simples.
async function onEliminarPausado(btn) {
    const row = btn.closest('.modal-row');
    const id = row?.dataset.id;
    if (!id) return;
    if (!confirm('¿Eliminar este ejercicio de la rutina? No se puede deshacer.')) return;

    btn.disabled = true;
    try {
        const { error } = await supabase
            .from('ejercicios_asignados')
            .delete()
            .eq('id', id);
        if (error) throw error;
        toast('Ejercicio eliminado');
        await cargarYRenderPausados();
        refrescarPanelActivo();
    } catch (err) {
        console.error('[perro] error eliminando pausado:', err);
        btn.disabled = false;
        toast('No se pudo eliminar', 'error');
    }
}

// ===================== Tab Herramientas =====================

// Mismo patrón de token que renderEjerciciosActivos: si entre el await y la
// pintada llegó otra llamada (cambio de pestaña rápido), la primera abandona
// sin tocar el DOM.
let _renderHerramientasToken = 0;

async function renderHerramientas() {
    const myToken = ++_renderHerramientasToken;

    const loadingEl = document.getElementById('herramientas-loading');
    const emptyEl = document.getElementById('herramientas-empty');
    const listaEl = document.getElementById('herramientas-lista');
    if (!loadingEl || !emptyEl || !listaEl) return;

    loadingEl.removeAttribute('hidden');
    emptyEl.setAttribute('hidden', '');
    listaEl.setAttribute('hidden', '');
    listaEl.innerHTML = '';

    const { data, error } = await supabase
        .from('ejercicios_asignados')
        .select('id, ejercicio_id, posicion_rutina, ejercicios (id, nombre, categoria)')
        .eq('perro_id', state.perroId)
        .eq('activo', true)
        .order('posicion_rutina', { ascending: true });

    if (myToken !== _renderHerramientasToken) return;

    loadingEl.setAttribute('hidden', '');

    if (error) {
        console.error('[perro] error cargando herramientas:', error);
        emptyEl.removeAttribute('hidden');
        return;
    }

    // Las herramientas no se encadenan: una fila = una herramienta.
    const herramientas = (data || []).filter(
        (row) => row.ejercicios?.categoria === 'herramienta',
    );

    if (!herramientas.length) {
        emptyEl.removeAttribute('hidden');
        return;
    }

    listaEl.removeAttribute('hidden');
    listaEl.innerHTML = herramientas.map(renderHerramientaCard).join('');
    listaEl.querySelectorAll('.toggle').forEach((btn) => {
        btn.addEventListener('click', () => onToggleHerramienta(btn));
    });
}

function renderHerramientaCard(row) {
    const ej = row.ejercicios;
    if (!ej) return '';
    const nombre = escapeHTML(ej.nombre || 'Sin nombre');
    const categoria = ej.categoria || 'herramienta';

    return `
        <li class="ejercicio-activo-card" data-ejercicio-id="${escapeHTML(ej.id)}">
            <div class="ejercicio-activo-top">
                <div class="ejercicio-activo-info">
                    <span class="ejercicio-activo-nombre">${nombre}</span>
                    <span class="cat-chip cat-chip--${escapeHTML(categoria)}">${escapeHTML(CATEGORIA_LABEL[categoria] || categoria)}</span>
                </div>
                <button type="button" class="toggle toggle--small" role="switch" aria-checked="true" aria-label="Pausar ${nombre}" data-ejercicio-id="${escapeHTML(ej.id)}">
                    <span class="toggle-thumb"></span>
                </button>
            </div>
        </li>
    `;
}

async function onToggleHerramienta(btn) {
    const ejercicioId = btn.dataset.ejercicioId;
    if (!ejercicioId) return;

    // Está activa → la pausamos (off). Optimistic UI.
    btn.setAttribute('aria-checked', 'false');
    btn.disabled = true;

    try {
        await toggleOff(state.perroId, ejercicioId);
        toast('Herramienta pausada');
        // Desaparece de la lista de activas: refrescamos.
        await renderHerramientas();
    } catch (err) {
        console.error('[perro] toggle off herramienta falló:', err);
        btn.setAttribute('aria-checked', 'true');
        btn.disabled = false;
        toast('No se pudo pausar la herramienta', 'error');
    }
}

function bindHerramientas() {
    document.getElementById('abrir-modal-herramientas')
        ?.addEventListener('click', abrirModalHerramienta);
    document.getElementById('abrir-pausados-herr')
        ?.addEventListener('click', abrirSheetPausados);
}

// Abre el bottom-sheet de catálogo (el mismo del panel Ejercicios) y lo deja
// pre-filtrado en la categoría herramienta. No toca la lógica del modal: reusa
// su apertura normal y después ajusta el filtro.
async function abrirModalHerramienta() {
    await abrirModal();
    // abrirModal dejó el título en "Agregar ejercicios"; lo ajustamos.
    const tituloEl = document.getElementById('modal-titulo');
    if (tituloEl) tituloEl.textContent = 'Agregar herramienta';
    state.modalCatFilter = 'herramienta';
    document.querySelectorAll('#modal-filtros .chip').forEach((c) => {
        const active = c.dataset.cat === 'herramienta';
        c.classList.toggle('is-active', active);
        c.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    renderModalLista();
}

// Re-renderiza el panel de rutina que esté activo (Ejercicios o Herramientas).
function refrescarPanelActivo() {
    const panel = document.querySelector('.tab-panel:not([hidden])')?.dataset.panel;
    if (panel === 'herramientas') renderHerramientas();
    else renderEjerciciosActivos();
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
