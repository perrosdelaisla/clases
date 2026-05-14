// =====================================================================
// admin.js — panel admin del universo Perros de la Isla (Fase 1)
//
// Reusa el cliente Supabase configurado en /js/supabase.js (apunta al
// proyecto Victoria, sydzfwwiruxqaxojymdz). Todas las queries pasan por
// la publishable key + RLS — la función SQL es_admin() reconoce al
// usuario logueado y deja pasar el SELECT a clientes/perros/admins.
// =====================================================================

import { supabase } from '../js/supabase.js';
import * as agenda from './agenda/api.js?v=8';
import * as stats from './stats/api.js';
import * as catalogo from './catalogo/api.js';
import { CATEGORIA_LABEL, ORDEN_CATEGORIAS } from './catalogo-labels.js';
// Chart.js cargado vía <script> UMD en index.html (window.Chart)
const Chart = window.Chart;

// Estado en memoria del admin actual y la lista cargada de clientes.
const state = {
    admin: null,            // { auth_user_id, email, nombre }
    clientes: [],           // resultado crudo del SELECT con perros anidados
    filtroEstado: 'todos',  // 'todos' | 'consulta' | 'activo' | 'veterano' | 'ex_cliente'
    busqueda: '',
    citas: [],              // citas vigentes cacheadas para el modal editar
    clientesCache: [],      // lista plana de clientes para el autocomplete (crear+editar)
    perrosClienteCache: [], // perros del cliente actualmente elegido en modal crear
};

// ---------- Navegación entre pantallas ----------

function showScreen(name) {
    ['loading', 'login', 'app'].forEach((s) => {
        const el = document.getElementById('screen-' + s);
        if (el) el.hidden = (s !== name);
    });
}

// ---------- Bootstrap ----------

document.addEventListener('DOMContentLoaded', () => {
    bindEvents();
    bootstrap();
});

async function bootstrap() {
    showScreen('loading');
    try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) {
            showScreen('login');
            return;
        }
        await afterLogin(session);
    } catch (err) {
        console.error('[admin] bootstrap error:', err);
        showScreen('login');
    }
}

// ---------- Eventos UI ----------

function bindEvents() {
    document.getElementById('login-form')
        .addEventListener('submit', handleLoginSubmit);

    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) logoutBtn.addEventListener('click', handleLogout);

    document.getElementById('estado-filtros').addEventListener('click', (e) => {
        const chip = e.target.closest('.chip');
        if (!chip) return;
        const filtro = chip.getAttribute('data-filter');
        if (!filtro || filtro === state.filtroEstado) return;
        state.filtroEstado = filtro;
        document.querySelectorAll('#estado-filtros .chip').forEach((c) => {
            const isActive = c === chip;
            c.classList.toggle('is-active', isActive);
            c.setAttribute('aria-selected', isActive ? 'true' : 'false');
        });
        renderClientes();
    });

    document.getElementById('cliente-search').addEventListener('input', (e) => {
        state.busqueda = e.target.value.trim().toLowerCase();
        renderClientes();
    });
}

// ---------- Login ----------

async function handleLoginSubmit(e) {
    e.preventDefault();
    const emailEl = document.getElementById('login-email');
    const passEl = document.getElementById('login-password');
    const errEl = document.getElementById('login-error');
    const submitBtn = document.getElementById('login-submit');

    errEl.hidden = true;
    errEl.textContent = '';
    submitBtn.disabled = true;
    submitBtn.textContent = 'Entrando…';

    try {
        const { data, error } = await supabase.auth.signInWithPassword({
            email: emailEl.value.trim(),
            password: passEl.value,
        });
        if (error) {
            mostrarErrorLogin('Email o contraseña incorrectos.');
            return;
        }
        await afterLogin(data.session);
    } catch (err) {
        console.error('[admin] login error:', err);
        mostrarErrorLogin('Error inesperado. Probá de nuevo.');
    } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Entrar';
    }
}

function mostrarErrorLogin(msg) {
    const errEl = document.getElementById('login-error');
    errEl.textContent = msg;
    errEl.hidden = false;
}

// ---------- Verificación de admin tras login ----------

async function afterLogin(session) {
    if (!session?.user) {
        showScreen('login');
        return;
    }

    // Buscamos al admin por auth_user_id. Si el SELECT falla o no
    // devuelve fila, asumimos que la cuenta no es admin y cerramos sesión.
    const { data, error } = await supabase
        .from('admins')
        .select('auth_user_id, nombre')
        .eq('auth_user_id', session.user.id)
        .maybeSingle();

    if (error) {
        console.error('[admin] error consultando admins:', error);
        await supabase.auth.signOut();
        showScreen('login');
        mostrarErrorLogin('No se pudo verificar tu cuenta. Probá de nuevo.');
        return;
    }

    if (!data) {
        await supabase.auth.signOut();
        showScreen('login');
        mostrarErrorLogin('No tenés permisos de admin.');
        return;
    }

    state.admin = data;
    const nombre = (data.nombre || 'Admin').trim() || 'Admin';
    const nameEl = document.getElementById('home-admin-name');
    if (nameEl) nameEl.textContent = nombre;
    showScreen('app');
    bindTabs();
    bindBackNavigation();
    // Default 'agenda'. Guard: si tab guardada es 'inicio' (oculto), fallback al default.
    let tabGuardada = localStorage.getItem('pdli_admin_tab') || 'agenda';
    if (tabGuardada === 'inicio') tabGuardada = 'agenda';
    activarTab(tabGuardada);
}

// ---------- Pestañas (SPA) ----------

function bindTabs() {
    document.querySelectorAll('[data-tab]').forEach((btn) => {
        btn.addEventListener('click', () => activarTab(btn.dataset.tab));
    });
}

function activarTab(tab) {
    document.querySelectorAll('[data-tab]').forEach((b) => {
        b.classList.toggle('active', b.dataset.tab === tab);
    });
    document.querySelectorAll('[data-panel]').forEach((p) => {
        p.hidden = p.dataset.panel !== tab;
    });
    try { localStorage.setItem('pdli_admin_tab', tab); } catch (e) {}
    if (tab === 'agenda' && !window.__agendaBound) {
        initAgenda();
    }
    if (tab === 'clientes' && !window.__clientesLoaded) {
        cargarClientes();
        window.__clientesLoaded = true;
    }
    if (tab === 'stats') {
        initStats();
    }
    if (tab === 'catalogo' && !window.__catalogoLoaded) {
        cargarCatalogoAdmin();
        window.__catalogoLoaded = true;
    }
}

// ---------- Logout ----------

async function handleLogout() {
    try {
        await supabase.auth.signOut();
    } catch (err) {
        console.error('[admin] logout error:', err);
    }
    state.admin = null;
    state.clientes = [];
    state.filtroEstado = 'todos';
    state.busqueda = '';
    document.getElementById('login-form').reset();
    document.getElementById('cliente-search').value = '';
    window.__clientesLoaded = false;
    window.__catalogoLoaded = false;
    try { localStorage.removeItem('pdli_admin_tab'); } catch (e) {}
    showScreen('login');
}

// ---------- Lista de clientes ----------

async function cargarClientes() {
    const lista = document.getElementById('clientes-lista');
    const feedback = document.getElementById('clientes-feedback');
    lista.innerHTML = '';
    feedback.hidden = false;
    feedback.innerHTML = '<span>Cargando clientes…</span>';

    // SELECT clientes con perros anidados (FK perros.cliente_id).
    // Asumimos columnas: clientes(id, nombre, telefono, estado, created_at)
    // y perros(id, nombre, cliente_id). Si los nombres difieren en Victoria,
    // ajustar acá.
    const { data, error } = await supabase
        .from('clientes')
        .select('id, nombre, telefono, estado, created_at, perros (id, nombre)')
        .order('created_at', { ascending: false });

    if (error) {
        console.error('[admin] error cargando clientes:', error);
        feedback.hidden = false;
        feedback.innerHTML = `
            <span>Error cargando clientes</span>
            <button type="button" id="retry-clientes">Reintentar</button>
        `;
        document.getElementById('retry-clientes')
            .addEventListener('click', cargarClientes);
        return;
    }

    state.clientes = data || [];
    renderClientes();
}

function renderClientes() {
    const lista = document.getElementById('clientes-lista');
    const feedback = document.getElementById('clientes-feedback');
    const filtrados = filtrarClientes(state.clientes);

    if (filtrados.length === 0) {
        lista.innerHTML = '';
        feedback.hidden = false;
        feedback.innerHTML = '<span>No hay clientes en este filtro.</span>';
        return;
    }

    feedback.hidden = true;
    feedback.innerHTML = '';
    lista.innerHTML = filtrados.map(renderClienteCard).join('');
}

function filtrarClientes(clientes) {
    return clientes.filter((c) => {
        if (state.filtroEstado !== 'todos') {
            const estado = (c.estado || '').toLowerCase();
            if (estado !== state.filtroEstado) return false;
        }
        if (state.busqueda) {
            const haystack = `${c.nombre || ''} ${c.telefono || ''}`.toLowerCase();
            if (!haystack.includes(state.busqueda)) return false;
        }
        return true;
    });
}

function renderClienteCard(c) {
    const nombre = escapeHTML(c.nombre || 'Sin nombre');
    const telefono = escapeHTML(c.telefono || 'sin teléfono');
    const primerPerro = Array.isArray(c.perros) && c.perros.length > 0
        ? c.perros[0]?.nombre
        : null;
    const perroLine = primerPerro
        ? `<span class="cliente-perro">Perro: ${escapeHTML(primerPerro)}</span>`
        : '';

    const estadoRaw = (c.estado || '').toLowerCase();
    const badgeClass = badgeClassFor(estadoRaw);
    const badgeLabel = estadoRaw
        ? estadoRaw.charAt(0).toUpperCase() + estadoRaw.slice(1)
        : 'Sin estado';

    return `
        <li>
            <a class="cliente-card" href="./cliente.html?id=${escapeHTML(c.id)}">
                <div class="cliente-info">
                    <span class="cliente-nombre">${nombre}</span>
                    <span class="cliente-telefono">${telefono}</span>
                    ${perroLine}
                </div>
                <span class="cliente-badge ${badgeClass}">${escapeHTML(badgeLabel)}</span>
            </a>
        </li>
    `;
}

function badgeClassFor(estado) {
    switch (estado) {
        case 'consulta': return 'badge-consulta';
        case 'activo': return 'badge-activo';
        case 'veterano': return 'badge-veterano';
        case 'ex_cliente': return 'badge-ex-cliente';
        default: return 'badge-desconocido';
    }
}

function escapeHTML(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/* ═══════════════════════════════════════════
   AGENDA — Bloque 3.A (skeleton)
   Handlers vacíos. Conexión a agenda/api.js en Bloque 3.B.
   ═══════════════════════════════════════════ */

function bindAgendaSubtabs() {
    document.querySelectorAll('.agenda-subtab').forEach((btn) => {
        btn.addEventListener('click', () => activarAgendaSubtab(btn.dataset.subtab));
    });
}

function activarAgendaSubtab(sub) {
    document.querySelectorAll('.agenda-subtab').forEach((b) => {
        b.classList.toggle('active', b.dataset.subtab === sub);
    });
    document.querySelectorAll('[data-subpanel]').forEach((p) => {
        p.hidden = p.dataset.subpanel !== sub;
    });
    if (sub === 'plantilla')      cargarPlantilla();
    else if (sub === 'bloqueos')  cargarBloqueos();
    else if (sub === 'citas')     cargarCitas();
}

function bindAgendaModals() {
    const btnAddHora = document.getElementById('btn-add-hora');
    if (btnAddHora) {
        btnAddHora.addEventListener('click', () => openModal('modal-add-hora'));
    }

    const btnCitaManual = document.getElementById('btn-abrir-cita-manual');
    if (btnCitaManual) {
        btnCitaManual.addEventListener('click', async () => {
            await Promise.all([poblarDropdownHorasCita(), cargarClientesCache()]);
            setupAutocompleteCmCliente();
            openModal('modal-cita-manual');
        });
    }

    document.querySelectorAll('[data-modal-close]').forEach((el) => {
        el.addEventListener('click', (e) => {
            const modal = e.target.closest('.modal');
            if (modal) closeModal(modal.id);
        });
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            document.querySelectorAll('.modal:not([hidden])').forEach((m) => closeModal(m.id));
        }
    });

    const modalSave = document.getElementById('modal-save');
    if (modalSave) {
        modalSave.addEventListener('click', async () => {
            const dia = parseInt(document.getElementById('modal-dia').value, 10);
            const horaInput = document.getElementById('modal-hora').value;
            if (!horaInput) {
                alert('Indicá una hora.');
                return;
            }
            const hora = horaInput.length === 5 ? `${horaInput}:00` : horaInput;
            try {
                await agenda.añadirSlotPlantilla(dia, hora);
                closeModal('modal-add-hora');
                document.getElementById('modal-hora').value = '';
                await cargarPlantilla();
            } catch (err) {
                console.error('Error añadir slot:', err);
                alert('No se pudo añadir el slot.');
            }
        });
    }

    const cmSave = document.getElementById('cm-save');
    if (cmSave) {
        cmSave.addEventListener('click', async () => {
            const errBox = document.getElementById('cm-error');
            if (errBox) {
                errBox.textContent = '';
                errBox.hidden = true;
            }

            const clienteIdSel = (document.getElementById('cm-cliente-id')?.value || '').trim();
            const cliente = {
                nombre: (document.getElementById('cm-nombre')?.value || '').trim(),
                telefono: (document.getElementById('cm-telefono')?.value || '').trim(),
                direccion: (document.getElementById('cm-direccion')?.value || '').trim(),
                email: (document.getElementById('cm-email')?.value || '').trim(),
            };

            const perroIdSel = (document.getElementById('cm-perro-id')?.value || '').trim();
            const perro = {
                nombre: (document.getElementById('cm-perro')?.value || '').trim(),
                raza: (document.getElementById('cm-raza')?.value || '').trim(),
                edad_meses: parseIntOrNull(document.getElementById('cm-edad')?.value),
                peso_kg: parseFloatOrNull(document.getElementById('cm-peso')?.value),
                es_ppp: !!document.getElementById('cm-ppp')?.checked,
            };
            if (perroIdSel) perro.id = perroIdSel;

            const horaInput = document.getElementById('cm-hora')?.value || '';
            const cita = {
                fecha: document.getElementById('cm-fecha')?.value || '',
                hora: horaInput.length === 5 ? `${horaInput}:00` : horaInput,
                modalidad: (document.getElementById('cm-modalidad')?.value || '').trim(),
                zona: (document.getElementById('cm-zona')?.value || '').trim(),
                notas: (document.getElementById('cm-notas')?.value || '').trim(),
                numero_clase: parseIntOrNull(document.getElementById('cm-numero-clase')?.value),
            };

            // "presencial-palma" se persiste como modalidad="presencial" para
            // que las stats coincidan con Victoria; el marcador en notas
            // permite distinguirlo de un presencial en zona del cliente.
            if (cita.modalidad === 'presencial-palma') {
                cita.modalidad = 'presencial';
                const marcador = '[Parque céntrico de Palma]';
                cita.notas = cita.notas ? `${marcador} ${cita.notas}` : marcador;
            }

            // Validaciones: nombre/teléfono SOLO si NO hay cliente_id seleccionado
            // (cuando elegís cliente existente, no requerimos retipear sus datos).
            if (!clienteIdSel) {
                if (!cliente.nombre)   { showCmError('Falta el nombre del cliente.'); return; }
                if (!cliente.telefono) { showCmError('Falta el teléfono del cliente.'); return; }
            }
            if (!perro.nombre)    { showCmError('Falta el nombre del perro.'); return; }
            if (!cita.fecha)      { showCmError('Falta la fecha de la cita.'); return; }
            if (!cita.hora)       { showCmError('Falta la hora de la cita.'); return; }

            cmSave.disabled = true;
            cmSave.textContent = 'Creando…';
            try {
                const payload = { cliente, perro, cita };
                if (clienteIdSel) payload.cliente_id = clienteIdSel;
                const res = await agenda.crearCitaManual(payload);
                if (res && res.ok === false) {
                    showCmError(res.error || 'No se pudo crear la cita.');
                    return;
                }
                closeModal('modal-cita-manual');
                resetCmForm();
                await cargarCitas();
            } catch (err) {
                console.error('Error crearCitaManual:', err);
                showCmError(err?.message || 'No se pudo crear la cita.');
            } finally {
                cmSave.disabled = false;
                cmSave.textContent = 'Crear cita';
            }
        });
    }

    // Si Charly edita el nombre del perro y diverge del perro cargado,
    // limpiamos cm-perro-id para que crearCitaManual haga INSERT en lugar
    // de UPDATE — señal explícita: "es un perro distinto al cargado".
    const cmPerroInput = document.getElementById('cm-perro');
    if (cmPerroInput && !cmPerroInput.__perroNombreBound) {
        cmPerroInput.addEventListener('input', () => {
            const elId = document.getElementById('cm-perro-id');
            if (!elId || !elId.value) return;
            const cache = state.perrosClienteCache || [];
            const p = cache.find((x) => x.id === elId.value);
            const tecleado = (cmPerroInput.value || '').trim().toLowerCase();
            const cargado  = (p?.nombre || '').trim().toLowerCase();
            if (!p || tecleado !== cargado) elId.value = '';
        });
        cmPerroInput.__perroNombreBound = true;
    }
}

/* ═══════════════════════════════════════════
   BACK NAVIGATION — botón atrás Android estilo Instagram
   Patrón: history.pushState + popstate. Mantenemos un "anchor" siempre
   en la historia; cualquier cambio de UI (modal) suma otra entrada. El
   handler de popstate decide qué hacer según la UI visible.
   Prioridades:
     1) Modal abierto → cerrar
     2) Subtab Agenda ≠ citas → volver a citas
     3) Tab ≠ agenda → volver a agenda
     4) Agenda > Citas sin nada → toast + 2s para confirmar salida
   Flag navegandoPorPopstate evita doble pushState cuando el handler llama
   a closeModal/activarTab/activarAgendaSubtab durante el procesamiento.
   Flag cierreUiPendiente captura el caso "cerré modal con X" donde el
   history.back() programático dispara popstate sin querer toast.
   ═══════════════════════════════════════════ */

let navegandoPorPopstate = false;
let cierreUiPendiente = false;
let readyToExit = false;
let exitTimer = null;
let bloquearSalida = true;

let toastTimer = null;
function toast(msg) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.remove('toast--error');
    el.classList.add('toast--info');
    el.removeAttribute('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.setAttribute('hidden', ''), 2200);
}

function bindBackNavigation() {
    if (window.__backNavBound) return;
    window.__backNavBound = true;

    // Anchor inicial: garantiza que el primer back físico dispare popstate
    // en lugar de cerrar la PWA directamente.
    history.pushState({ pdli: 'anchor' }, '');

    window.addEventListener('popstate', () => {
        if (!bloquearSalida) return; // ya estamos saliendo, dejar pasar

        // Caso especial: el back lo originó closeModal() desde UI (X / backdrop
        // / Esc / botón Guardar). Solo consumimos la entrada y re-armamos guard.
        if (cierreUiPendiente) {
            cierreUiPendiente = false;
            history.pushState({ pdli: 'anchor' }, '');
            return;
        }

        // Prioridad 1: modal abierto → cerrar
        const modal = document.querySelector('.modal:not([hidden])');
        if (modal) {
            history.pushState({ pdli: 'anchor' }, '');
            navegandoPorPopstate = true;
            try { closeModal(modal.id); } finally { navegandoPorPopstate = false; }
            return;
        }

        // Prioridad 2: subtab Agenda ≠ citas
        const tabActual = document.querySelector('.admin-tab.active')?.dataset.tab;
        const subActual = document.querySelector('.agenda-subtab.active')?.dataset.subtab;
        if (tabActual === 'agenda' && subActual && subActual !== 'citas') {
            history.pushState({ pdli: 'anchor' }, '');
            navegandoPorPopstate = true;
            try { activarAgendaSubtab('citas'); } finally { navegandoPorPopstate = false; }
            return;
        }

        // Prioridad 3: tab ≠ agenda → volver a agenda (siempre arranca en citas)
        if (tabActual && tabActual !== 'agenda') {
            history.pushState({ pdli: 'anchor' }, '');
            navegandoPorPopstate = true;
            try { activarTab('agenda'); } finally { navegandoPorPopstate = false; }
            return;
        }

        // Prioridad 4: Agenda > Citas sin nada → doble-tap para salir
        if (readyToExit) {
            // Segundo back dentro de los 2s: dejar salir. No re-pushear.
            clearTimeout(exitTimer);
            readyToExit = false;
            bloquearSalida = false;
            history.back(); // si era la última entrada del PWA, browser cierra
            return;
        }
        history.pushState({ pdli: 'anchor' }, '');
        toast('Pulsá atrás otra vez para salir');
        readyToExit = true;
        exitTimer = setTimeout(() => { readyToExit = false; }, 2000);
    });
}

function openModal(id) {
    const m = document.getElementById(id);
    if (!m) return;
    const yaAbierto = !m.hidden;
    m.hidden = false;
    // Back navigation: empujar una entrada en la historia si el modal
    // recién se abre, así el botón atrás físico la consume y el handler
    // de popstate cierra el modal. Si ya estaba abierto, no doble-pushear.
    if (!yaAbierto && !navegandoPorPopstate) {
        history.pushState({ pdli: 'modal', id }, '');
    }
}

function closeModal(id) {
    const m = document.getElementById(id);
    if (!m) return;
    const estabaAbierto = !m.hidden;
    m.hidden = true;
    if (id === 'modal-cita-manual') {
        resetCmForm();
    }
    // Si el cierre vino de la UI (X, backdrop, Esc, botón Guardar/Eliminar),
    // consumimos la entrada que pusheamos al abrir. El handler de popstate
    // detecta cierreUiPendiente y no dispara la lógica de toast.
    if (estabaAbierto && !navegandoPorPopstate) {
        cierreUiPendiente = true;
        history.back();
    }
}

async function poblarDropdownHorasCita() {
    const select = document.getElementById('cm-hora');
    if (!select) return;
    try {
        const slots = await agenda.obtenerPlantilla();
        const horasUnicas = [...new Set(slots.map((s) => s.hora))].sort();
        select.innerHTML = '<option value="">Elegí una hora…</option>' +
            horasUnicas.map((h) => `<option value="${escapeHTML(h.substring(0, 5))}">${escapeHTML(h.substring(0, 5))}</option>`).join('');
    } catch (err) {
        console.error('Error cargando horas para dropdown cita:', err);
    }
}

function bindFormBloqueo() {
    const form = document.getElementById('form-bloqueo');
    if (!form) return;

    poblarDropdownHorasBloqueo();

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const fecha = document.getElementById('bloq-fecha').value;
        const hora = document.getElementById('bloq-hora').value;
        const motivo = document.getElementById('bloq-motivo').value.trim();
        if (!fecha) {
            alert('Indicá una fecha.');
            return;
        }
        try {
            await agenda.bloquearDia(fecha, motivo, hora || null);
            document.getElementById('bloq-fecha').value = '';
            document.getElementById('bloq-hora').value = '';
            document.getElementById('bloq-motivo').value = '';
            await cargarBloqueos();
        } catch (err) {
            console.error('Error crear bloqueo:', err);
            alert('No se pudo crear el bloqueo.');
        }
    });
}

async function poblarDropdownHorasBloqueo() {
    const select = document.getElementById('bloq-hora');
    if (!select) return;
    try {
        const slots = await agenda.obtenerPlantilla();
        const horasUnicas = [...new Set(slots.map((s) => s.hora))].sort();
        select.innerHTML = '<option value="">Día completo</option>' +
            horasUnicas.map((h) => `<option value="${escapeHTML(h.substring(0, 5))}">${escapeHTML(h.substring(0, 5))}</option>`).join('');
    } catch (err) {
        console.error('Error cargando horas para dropdown:', err);
    }
}

function initAgenda() {
    if (window.__agendaBound) return;
    bindAgendaSubtabs();
    bindAgendaModals();
    bindFormBloqueo();
    bindModalCitaEdit();
    window.__agendaBound = true;
    // Cargar citas por default (es la sub-pestaña activa al entrar)
    cargarCitas();
}

// ---------- Agenda — Lecturas (Lote 3.B.1) ----------

const DIAS_SEMANA = [
    { id: 1, nombre: 'Lunes' },
    { id: 2, nombre: 'Martes' },
    { id: 3, nombre: 'Miércoles' },
    { id: 4, nombre: 'Jueves' },
    { id: 5, nombre: 'Viernes' },
    { id: 6, nombre: 'Sábado' },
    { id: 0, nombre: 'Domingo' },
];

// Helpers de fecha (formato local zona Madrid, mismo que admin viejo)
function hoyStr() {
    return new Date().toLocaleDateString('en-CA'); // 'YYYY-MM-DD'
}

function esCitaPasada(fechaISO) {
    return fechaISO < hoyStr();
}

function esCitaHoy(fechaISO) {
    return fechaISO === hoyStr();
}

function esCitaFutura(fechaISO) {
    return fechaISO > hoyStr();
}

// Helpers de parsing y feedback del modal cita manual
function parseIntOrNull(v) {
    if (v == null || v === '') return null;
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : null;
}

function parseFloatOrNull(v) {
    if (v == null || v === '') return null;
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
}

function showCmError(msg) {
    const errBox = document.getElementById('cm-error');
    if (errBox) {
        errBox.textContent = msg;
        errBox.hidden = false;
    } else {
        alert(msg);
    }
}

function resetCmForm() {
    const ids = [
        'cm-nombre', 'cm-telefono', 'cm-direccion', 'cm-email', 'cm-cliente-id',
        'cm-perro', 'cm-perro-id', 'cm-raza', 'cm-edad', 'cm-peso',
        'cm-fecha', 'cm-hora', 'cm-modalidad', 'cm-zona', 'cm-notas',
        'cm-numero-clase',
    ];
    ids.forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
    const ppp = document.getElementById('cm-ppp');
    if (ppp) ppp.checked = false;
    const errBox = document.getElementById('cm-error');
    if (errBox) {
        errBox.textContent = '';
        errBox.hidden = true;
    }
    const hint = document.getElementById('cm-cliente-hint');
    if (hint) {
        hint.textContent = '';
        hint.hidden = true;
    }
    const drop = document.getElementById('cm-cliente-dropdown');
    if (drop) drop.hidden = true;
    // Selector de perros: ocultar y vaciar opciones
    configurarSelectorPerro([]);
    state.perrosClienteCache = [];
}

// Aplica los datos de un perro (o null para limpiar) a los inputs del
// fieldset "Perro" del modal crear. Compartido entre el autollenado al
// elegir cliente y el cambio de opción del selector cuando hay 2+ perros.
// Sincroniza cm-perro-id (hidden) para que el guardado sepa si está
// trabajando sobre un perro existente (UPDATE) o uno nuevo (INSERT).
function aplicarDatosPerroAlForm(perro) {
    const elNombre = document.getElementById('cm-perro');
    const elRaza   = document.getElementById('cm-raza');
    const elEdad   = document.getElementById('cm-edad');
    const elPeso   = document.getElementById('cm-peso');
    const elPpp    = document.getElementById('cm-ppp');
    const elId     = document.getElementById('cm-perro-id');
    if (elNombre) elNombre.value = perro?.nombre || '';
    if (elRaza)   elRaza.value   = perro?.raza   || '';
    if (elEdad)   elEdad.value   = perro?.edad_meses != null ? String(perro.edad_meses) : '';
    if (elPeso)   elPeso.value   = perro?.peso_kg    != null ? String(perro.peso_kg)    : '';
    if (elPpp)    elPpp.checked  = !!perro?.es_ppp;
    if (elId)     elId.value     = perro?.id || '';
}

// Configura el <select id="cm-perro-selector">: visible sólo si hay 2+
// perros; las opciones se ordenan por created_at ASC (más antiguo primero,
// que queda preseleccionado). Bindea el change handler una sola vez para
// que cambiar de opción autollene los campos del perro elegido.
function configurarSelectorPerro(perros) {
    const wrap = document.getElementById('cm-perro-selector-wrap');
    const sel  = document.getElementById('cm-perro-selector');
    if (!wrap || !sel) return;

    if (!perros || perros.length < 2) {
        wrap.hidden = true;
        sel.innerHTML = '';
        return;
    }

    sel.innerHTML = perros.map((p, i) =>
        `<option value="${escapeHTML(p.id)}"${i === 0 ? ' selected' : ''}>${escapeHTML(p.nombre || '(sin nombre)')}</option>`
    ).join('');
    wrap.hidden = false;

    if (!sel.__perroSelBound) {
        sel.addEventListener('change', () => {
            const id = sel.value;
            const cache = state.perrosClienteCache || [];
            const p = cache.find((x) => x.id === id);
            if (p) aplicarDatosPerroAlForm(p);
        });
        sel.__perroSelBound = true;
    }
}

// Conecta el autocomplete del modal "Crear cita". Reusa la cache global
// state.clientesCache. Al elegir un cliente existente, autollena los
// campos visibles y muestra un hint informativo; si Charly tipea de
// nuevo, el wiring del componente limpia cm-cliente-id automáticamente.
function setupAutocompleteCmCliente() {
    const inputEl = document.getElementById('cm-nombre');
    const dropdownEl = document.getElementById('cm-cliente-dropdown');
    const hiddenEl = document.getElementById('cm-cliente-id');
    const hintEl = document.getElementById('cm-cliente-hint');
    if (!inputEl || !dropdownEl || !hiddenEl) return;

    setupAutocompleteCliente({
        inputEl, dropdownEl, hiddenEl,
        onSelect: async (c) => {
            // Datos del cliente
            const tel  = document.getElementById('cm-telefono');
            const dir  = document.getElementById('cm-direccion');
            const mail = document.getElementById('cm-email');
            const zona = document.getElementById('cm-zona');
            if (tel)  tel.value  = c.telefono  || '';
            if (dir)  dir.value  = c.direccion || '';
            if (mail) mail.value = c.email     || '';
            if (zona) zona.value = c.zona      || '';

            // Limpiar perro antes de cargar — evita arrastrar datos de un cliente previo
            aplicarDatosPerroAlForm(null);
            state.perrosClienteCache = [];

            let perros = [];
            try {
                perros = await agenda.obtenerPerrosDeCliente(c.id);
                state.perrosClienteCache = perros;
                if (perros.length >= 1) {
                    // El primero (más antiguo) queda seleccionado por defecto
                    aplicarDatosPerroAlForm(perros[0]);
                }
                configurarSelectorPerro(perros);
            } catch (err) {
                console.error('Error obteniendo perros del cliente:', err);
                configurarSelectorPerro([]);
            }

            // Hint contextual según cantidad de perros del cliente
            if (hintEl) {
                let msg = 'Vinculado a cliente existente: los datos del cliente no se modificarán al guardar.';
                if (perros.length === 1) {
                    msg += ' Perro pre-rellenado con los datos del perro registrado: si es para un perro distinto, modificá los campos antes de guardar — si no, se creará un duplicado en la tabla perros.';
                } else if (perros.length >= 2) {
                    msg += ` El cliente tiene ${perros.length} perros — elegí uno arriba del fieldset Perro. Si es para un perro nuevo, modificá los campos antes de guardar — si no, se creará un duplicado.`;
                } else {
                    msg += ' (Sin perros registrados — se creará uno nuevo al guardar.)';
                }
                hintEl.textContent = msg;
                hintEl.hidden = false;
            }
        },
        onClear: () => {
            // Charly tipeó tras elegir: rompemos vínculo + ocultamos selector,
            // pero NO limpiamos los campos del perro (Charly puede estar sólo
            // corrigiendo un typo del nombre del cliente). Sí limpiamos
            // cm-perro-id: si el cliente cambió, el perro cargado deja de
            // ser válido — un re-pick del cliente lo repondrá; si en
            // cambio Charly crea cliente nuevo, evitamos UPDATE cross-cliente.
            if (hintEl) {
                hintEl.textContent = '';
                hintEl.hidden = true;
            }
            configurarSelectorPerro([]);
            state.perrosClienteCache = [];
            const elPerroId = document.getElementById('cm-perro-id');
            if (elPerroId) elPerroId.value = '';
        },
    });
}

async function cargarPlantilla() {
    const grid = document.getElementById('plantilla-grid');
    if (!grid) return;
    grid.innerHTML = '<p class="agenda-empty">Cargando plantilla…</p>';
    try {
        const slots = await agenda.obtenerPlantilla();
        renderPlantilla(slots);
        bindPlantillaActions();
    } catch (err) {
        console.error('Error cargando plantilla:', err);
        grid.innerHTML = '<p class="agenda-empty">Error al cargar plantilla.</p>';
    }
}

function bindPlantillaActions() {
    const grid = document.getElementById('plantilla-grid');
    if (!grid || grid.__bound) return;
    grid.addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-action]');
        if (!btn) return;
        const slotEl = btn.closest('[data-slot-id]');
        if (!slotEl) return;
        const slotId = slotEl.dataset.slotId;
        const action = btn.dataset.action;

        if (action === 'toggle') {
            const activoActual = btn.dataset.active === 'true';
            try {
                await agenda.toggleSlotActivo(slotId, !activoActual);
                await cargarPlantilla();
            } catch (err) {
                console.error('Error toggle slot:', err);
                alert('No se pudo cambiar el slot.');
            }
        } else if (action === 'delete') {
            if (!confirm('¿Eliminar este slot de la plantilla?')) return;
            try {
                await agenda.eliminarSlotPlantilla(slotId);
                await cargarPlantilla();
            } catch (err) {
                console.error('Error eliminar slot:', err);
                alert('No se pudo eliminar el slot.');
            }
        }
    });
    grid.__bound = true;
}

function renderPlantilla(slots) {
    const grid = document.getElementById('plantilla-grid');
    if (!grid) return;
    if (!slots || slots.length === 0) {
        grid.innerHTML = '<p class="agenda-empty">No hay slots configurados. Pulsá "+ Añadir hora" para crear el primero.</p>';
        return;
    }
    const porDia = {};
    DIAS_SEMANA.forEach((d) => { porDia[d.id] = []; });
    slots.forEach((s) => {
        if (porDia[s.dia_semana]) porDia[s.dia_semana].push(s);
    });
    grid.innerHTML = DIAS_SEMANA.map((d) => {
        const slotsDia = porDia[d.id];
        const slotsHTML = slotsDia.length === 0
            ? '<p class="plantilla-empty">—</p>'
            : slotsDia.map((s) => `
                <div class="plantilla-slot ${s.activo ? '' : 'inactivo'}" data-slot-id="${escapeHTML(s.id)}">
                    <span>${formatearHora(s.hora)}</span>
                    <div class="plantilla-slot-actions">
                        <button class="plantilla-slot-btn" data-action="toggle" data-active="${s.activo}" title="${s.activo ? 'Desactivar' : 'Activar'}">${s.activo ? '◉' : '○'}</button>
                        <button class="plantilla-slot-btn" data-action="delete" title="Eliminar">✕</button>
                    </div>
                </div>
            `).join('');
        return `
            <div class="plantilla-day">
                <h3 class="plantilla-day-title">${d.nombre}</h3>
                ${slotsHTML}
            </div>
        `;
    }).join('');
}

function formatearHora(hora) {
    if (!hora) return '—';
    return hora.substring(0, 5);
}

async function cargarBloqueos() {
    const list = document.getElementById('bloqueos-list');
    if (!list) return;
    list.innerHTML = '<p class="agenda-empty">Cargando bloqueos…</p>';
    try {
        const bloqueos = await agenda.obtenerBloqueos();
        renderBloqueos(bloqueos);
        bindBloqueosActions();
    } catch (err) {
        console.error('Error cargando bloqueos:', err);
        list.innerHTML = '<p class="agenda-empty">Error al cargar bloqueos.</p>';
    }
}

function bindBloqueosActions() {
    const list = document.getElementById('bloqueos-list');
    if (!list || list.__bound) return;
    list.addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-action="eliminar-bloqueo"]');
        if (!btn) return;
        const card = btn.closest('[data-bloqueo-id]');
        if (!card) return;
        const bloqueoId = card.dataset.bloqueoId;
        if (!confirm('¿Eliminar este bloqueo?')) return;
        try {
            await agenda.eliminarBloqueo(bloqueoId);
            await cargarBloqueos();
        } catch (err) {
            console.error('Error eliminar bloqueo:', err);
            alert('No se pudo eliminar el bloqueo.');
        }
    });
    list.__bound = true;
}

function renderBloqueos(bloqueos) {
    const list = document.getElementById('bloqueos-list');
    if (!list) return;
    if (!bloqueos || bloqueos.length === 0) {
        list.innerHTML = '<p class="agenda-empty">No hay bloqueos futuros configurados.</p>';
        return;
    }
    list.innerHTML = bloqueos.map((b) => `
        <div class="bloqueo-card" data-bloqueo-id="${escapeHTML(b.id)}">
            <div class="bloqueo-info">
                <span class="bloqueo-fecha">${formatearFechaCorta(b.fecha)}${b.hora ? ' · ' + formatearHora(b.hora) : ' · día completo'}</span>
                <span class="bloqueo-motivo">${escapeHTML(b.motivo || '(sin motivo)')}</span>
            </div>
            <button class="bloqueo-eliminar" data-action="eliminar-bloqueo" type="button">Eliminar</button>
        </div>
    `).join('');
}

function formatearFechaCorta(fechaISO) {
    if (!fechaISO) return '—';
    const [y, m, d] = fechaISO.split('-');
    const meses = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
    return `${parseInt(d, 10)} ${meses[parseInt(m, 10) - 1]} ${y}`;
}

async function cargarCitas() {
    const list = document.getElementById('citas-list');
    if (!list) return;
    list.innerHTML = '<p class="agenda-empty">Cargando…</p>';
    try {
        // Fase 4: traemos citas + llamadas en paralelo y las mezclamos
        // ordenadas por (fecha, hora). Cada item lleva un discriminador
        // `kind` para que renderUnificado sepa qué renderer usar.
        const [citas, llamadas] = await Promise.all([
            agenda.obtenerCitasAdminConReportado(),
            agenda.obtenerLlamadasAdmin(),
        ]);
        state.citas = citas;
        state.llamadas = llamadas;

        const items = [
            ...citas.map(c    => ({ kind: 'cita',    fecha: c.fecha, hora: c.hora, cita:    c })),
            ...llamadas.map(l => ({ kind: 'llamada', fecha: l.fecha, hora: l.hora, llamada: l })),
        ].sort((a, b) => {
            if (a.fecha !== b.fecha) return a.fecha < b.fecha ? -1 : 1;
            return a.hora < b.hora ? -1 : 1;
        });

        renderUnificado(items);
        bindCitasActions();
    } catch (err) {
        console.error('Error cargando citas/llamadas:', err);
        list.innerHTML = '<p class="agenda-empty">Error al cargar.</p>';
    }
}

function bindCitasActions() {
    const list = document.getElementById('citas-list');
    if (!list || list.__bound) return;
    list.addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-action]');
        if (!btn) return;
        const action = btn.dataset.action;

        // Detectamos tipo de card por el atributo data-*-id presente
        const cardCita    = btn.closest('[data-cita-id]');
        const cardLlamada = btn.closest('[data-llamada-id]');

        try {
            if (cardCita) {
                const citaId = cardCita.dataset.citaId;
                if (action === 'confirmar') {
                    await agenda.confirmarCita(citaId);
                } else if (action === 'cancelar') {
                    if (!confirm('¿Cancelar esta cita? Se mantendrá en la lista hasta que la elimines.')) return;
                    await agenda.cancelarCita(citaId);
                } else if (action === 'realizada') {
                    await agenda.marcarCitaRealizada(citaId);
                } else if (action === 'eliminar-cita') {
                    if (!confirm('¿Eliminar esta cita definitivamente? Esta acción no se puede deshacer.')) return;
                    await agenda.eliminarCita(citaId);
                } else if (action === 'editar') {
                    await abrirModalEditarCita(citaId);
                    return; // no refrescar — el modal se ocupa al guardar/eliminar
                } else {
                    return;
                }
                await cargarCitas();
            } else if (cardLlamada) {
                const llamadaId = cardLlamada.dataset.llamadaId;
                if (action === 'ver-detalle-llamada') {
                    abrirModalLlamada(llamadaId);
                    return; // modal de solo lectura, no refrescar
                } else if (action === 'marcar-realizada-llamada') {
                    await agenda.marcarLlamadaRealizada(llamadaId);
                } else if (action === 'marcar-no-show-llamada') {
                    await agenda.marcarLlamadaNoShow(llamadaId);
                } else if (action === 'cancelar-llamada') {
                    if (!confirm('¿Cancelar esta llamada? La fila se mantiene en DB pero deja de aparecer en el feed activo.')) return;
                    await agenda.cancelarLlamada(llamadaId);
                } else {
                    return;
                }
                await cargarCitas();
            }
        } catch (err) {
            console.error(`Error en acción ${action}:`, err);
            alert(`No se pudo completar la acción "${action}".`);
        }
    });
    list.__bound = true;
}

/* ═══════════════════════════════════════════
   AGENDA — Feed unificado citas + llamadas (Fase 4)
   renderUnificado renderiza items kind='cita' inline (lógica
   heredada del antiguo renderCitas, eliminado por dead code el
   12/05/2026) y delega a renderItemLlamada para kind='llamada'.
   ═══════════════════════════════════════════ */

function renderUnificado(items) {
    const list = document.getElementById('citas-list');
    if (!list) return;
    if (!items || items.length === 0) {
        list.innerHTML = '<p class="agenda-empty">No hay citas ni llamadas futuras.</p>';
        return;
    }

    // Filtrar canceladas pasadas (regla heredada de renderCitas)
    const visibles = items.filter((it) => {
        if (it.kind === 'cita' && it.cita.estado === 'cancelada' && esCitaPasada(it.cita.fecha)) return false;
        return true;
    });

    if (visibles.length === 0) {
        list.innerHTML = '<p class="agenda-empty">No hay citas ni llamadas futuras.</p>';
        return;
    }

    list.innerHTML = visibles.map((it) => {
        if (it.kind === 'llamada') return renderItemLlamada(it.llamada);

        // ── Cita: lógica calcada de renderCitas (no refactor) ──
        const c = it.cita;
        const cliente = c.clientes?.nombre || '(sin nombre)';
        const telefono = c.clientes?.telefono || '';
        const zona = c.clientes?.zona || '';
        const perros = c.clientes?.perros || [];
        const perrosTexto = perros.length === 0
            ? '(sin perro asociado)'
            : perros.map((p) => {
                const partes = [p.nombre];
                if (p.raza) partes.push(p.raza);
                if (p.edad_meses != null) partes.push(`${p.edad_meses} m`);
                if (p.problematica) partes.push(`— ${p.problematica}`);
                return partes.join(' · ');
            }).join(' / ');

        const reportado = c.reportado;
        const estado = c.estado || 'pendiente';
        const protocolo = c.protocolo;
        const cuadros = Array.isArray(c.cuadros_detectados) ? c.cuadros_detectados : [];

        const botones = [];
        botones.push('<button class="btn-editar" data-action="editar" type="button" aria-label="Editar" title="Editar">✎</button>');
        if (estado === 'pendiente') {
            botones.push('<button data-action="confirmar" type="button">Confirmar</button>');
        }
        if ((estado === 'pendiente' || estado === 'confirmada') && !esCitaPasada(c.fecha)) {
            botones.push('<button data-action="cancelar" type="button">Cancelar</button>');
        }
        if (estado === 'confirmada' && (esCitaHoy(c.fecha) || esCitaPasada(c.fecha))) {
            botones.push('<button data-action="realizada" type="button">Marcar realizada</button>');
        }
        if (estado === 'realizada' || estado === 'cancelada' || estado === 'confirmada') {
            botones.push('<button class="btn-eliminar" data-action="eliminar-cita" type="button">Eliminar</button>');
        }
        if (estado === 'pendiente' && botones.length === 2) {
            botones.push('<button class="btn-eliminar" data-action="eliminar-cita" type="button">Eliminar</button>');
        }

        let bloqueReportado = '';
        if (reportado) {
            bloqueReportado = `<div class="cita-reportado"><strong>Reportado por el cliente:</strong> ${escapeHTML(reportado)}</div>`;
        } else if (c.notas) {
            bloqueReportado = `<div class="cita-reportado"><strong>Notas:</strong> ${escapeHTML(c.notas)}</div>`;
        }

        let bloqueProtocolo = '';
        if (protocolo) {
            bloqueProtocolo = `<div class="cita-protocolo"><strong>Protocolo:</strong> ${escapeHTML(protocolo)}</div>`;
        } else if (cuadros.length > 0) {
            bloqueProtocolo = `<div class="cita-protocolo"><strong>Cuadros:</strong> ${escapeHTML(cuadros.join(', '))}</div>`;
        }

        const numeroClaseBadge = (c.numero_clase != null)
            ? `<span class="cita-numero">Clase ${escapeHTML(String(c.numero_clase))}</span>`
            : '';

        return `
            <div class="cita-card" data-cita-id="${escapeHTML(c.id)}">
                <div class="cita-header">
                    <span class="cita-fecha">${formatearFechaCorta(c.fecha)} · ${formatearHora(c.hora)}</span>
                    ${numeroClaseBadge}
                    <span class="cita-estado ${escapeHTML(estado)}">${escapeHTML(estado)}</span>
                </div>
                <div class="cita-cliente">
                    <strong>${escapeHTML(cliente)}</strong>${telefono ? ' · ' + escapeHTML(telefono) : ''}${zona ? ' · ' + escapeHTML(zona) : ''}${c.modalidad ? ' · ' + escapeHTML(c.modalidad) : ''}
                </div>
                <div class="cita-perro">${escapeHTML(perrosTexto)}</div>
                ${bloqueProtocolo}
                ${bloqueReportado}
                <div class="cita-acciones">${botones.join('')}</div>
            </div>
        `;
    }).join('');
}

/**
 * Renderiza una card de llamada (variante visual: borde izquierdo
 * azul cobalto + badge "📞 LLAMADA" en el header). Datos directos
 * desde campos snapshot de llamadas_solicitadas — NO join a clientes.
 *
 * Botones condicionales:
 *   - Siempre: "Ver detalle"
 *   - Solo si estado='pendiente': "Marcar realizada", "Marcar ausente", "Cancelar"
 *   - Estados 'realizada' / 'no_show' → solo "Ver detalle" (consulta)
 */
function renderItemLlamada(ll) {
    const nombre = ll.nombre_cliente || '(sin nombre)';
    const telefono = ll.telefono_cliente || '';
    const zona = ll.zona || '';

    const perroPartes = [];
    if (ll.perro_nombre)             perroPartes.push(ll.perro_nombre);
    if (ll.perro_raza)               perroPartes.push(ll.perro_raza);
    if (ll.perro_edad_meses != null) perroPartes.push(`${ll.perro_edad_meses} m`);
    if (ll.perro_peso_kg != null)    perroPartes.push(`${ll.perro_peso_kg} kg`);
    const perroTexto = perroPartes.length ? perroPartes.join(' · ') : '(sin datos de perro)';

    const estado = ll.estado || 'pendiente';
    const mensajeBloque = ll.mensaje_adicional
        ? `<div class="cita-reportado"><strong>Mensaje:</strong> ${escapeHTML(ll.mensaje_adicional)}</div>`
        : '';

    const botones = [];
    botones.push('<button data-action="ver-detalle-llamada" type="button">Ver detalle</button>');
    if (estado === 'pendiente') {
        botones.push('<button data-action="marcar-realizada-llamada" type="button">Marcar realizada</button>');
        botones.push('<button data-action="marcar-no-show-llamada" type="button">Marcar ausente</button>');
        botones.push('<button class="btn-eliminar" data-action="cancelar-llamada" type="button">Cancelar</button>');
    }

    return `
        <div class="cita-card cita-card--llamada" data-llamada-id="${escapeHTML(ll.id)}">
            <div class="cita-header">
                <span class="cita-fecha">${formatearFechaCorta(ll.fecha)} · ${formatearHora(ll.hora)}</span>
                <span class="llamada-badge">📞 LLAMADA</span>
                <span class="cita-estado llamada-estado ${escapeHTML(estado)}">${escapeHTML(estado)}</span>
            </div>
            <div class="cita-cliente">
                <strong>${escapeHTML(nombre)}</strong>${telefono ? ' · ' + escapeHTML(telefono) : ''}${zona ? ' · ' + escapeHTML(zona) : ''}
            </div>
            <div class="cita-perro">${escapeHTML(perroTexto)}</div>
            ${mensajeBloque}
            <div class="cita-acciones">${botones.join('')}</div>
        </div>
    `;
}

/**
 * Abre el modal "Detalle de llamada" rellenando todos los campos
 * de solo lectura desde state.llamadas (sin re-fetch).
 */
function abrirModalLlamada(llamadaId) {
    const ll = (state.llamadas || []).find(l => l.id === llamadaId);
    if (!ll) {
        alert('No se encontró la llamada. Refrescá el feed.');
        return;
    }

    document.getElementById('ml-fecha-hora').textContent =
        `${formatearFechaCorta(ll.fecha)} · ${formatearHora(ll.hora)}`;
    document.getElementById('ml-nombre').textContent = ll.nombre_cliente || '(sin nombre)';
    document.getElementById('ml-zona').textContent = ll.zona || '—';

    const movilEl = document.getElementById('ml-movil');
    movilEl.textContent = ll.telefono_cliente || '—';

    const btnLlamar = document.getElementById('ml-btn-llamar');
    if (ll.telefono_cliente) {
        btnLlamar.href = `tel:${ll.telefono_cliente.replace(/\s+/g, '')}`;
        btnLlamar.hidden = false;
    } else {
        btnLlamar.hidden = true;
    }

    const perroPartes = [];
    if (ll.perro_nombre)             perroPartes.push(ll.perro_nombre);
    if (ll.perro_raza)               perroPartes.push(ll.perro_raza);
    if (ll.perro_edad_meses != null) perroPartes.push(`${ll.perro_edad_meses} meses`);
    if (ll.perro_peso_kg != null)    perroPartes.push(`${ll.perro_peso_kg} kg`);
    document.getElementById('ml-perro').textContent = perroPartes.length ? perroPartes.join(' · ') : '—';

    document.getElementById('ml-mensaje').textContent = ll.mensaje_adicional || '—';

    // Mensajes de diagnóstico: defensivo ante 2 formatos posibles.
    // Hoy llega como string[] (texto plano del cliente en s4/s5).
    // Si en el futuro pasara a {rol, texto}, renderizamos "rol: texto".
    const diagEl = document.getElementById('ml-diagnostico');
    const mensajes = Array.isArray(ll.mensajes_diagnostico) ? ll.mensajes_diagnostico : [];
    if (mensajes.length === 0) {
        diagEl.innerHTML = '<li>(sin texto del cliente)</li>';
    } else {
        diagEl.innerHTML = mensajes.map(m => {
            if (m && typeof m === 'object' && (m.rol || m.texto)) {
                const rol = m.rol || '—';
                const texto = m.texto || '';
                return `<li><strong>${escapeHTML(rol)}:</strong> ${escapeHTML(texto)}</li>`;
            }
            return `<li>${escapeHTML(typeof m === 'string' ? m : JSON.stringify(m))}</li>`;
        }).join('');
    }

    openModal('modal-detalle-llamada');
}

/* ═══════════════════════════════════════════
   AGENDA — Modal "Editar cita"
   Patrón copiado del modal-cita-manual: HTML estático en index.html,
   listeners bindeados una sola vez en initAgenda → bindModalCitaEdit.
   El campo "Cliente" es un <select> simple; en el Paso C se reemplaza
   por autocomplete (la lógica de guardar solo lee ce-cliente.value).
   ═══════════════════════════════════════════ */

const PALMA_MARKER = '[Parque céntrico de Palma]';

// Estado en memoria del modal editar (id de la cita actualmente editada).
const editState = { citaId: null };

function showCeError(msg) {
    const box = document.getElementById('ce-error');
    if (!box) return;
    box.textContent = msg || '';
    box.hidden = !msg;
}

// Decide qué valor mostrar en el select de modalidad. El form de crear
// usa el marcador PALMA_MARKER en notas para distinguir presencial-palma
// de presencial-zona-cliente (ambos persisten modalidad='presencial');
// acá invertimos esa convención al cargar.
function detectarModalidadEditor(cita) {
    const notas = cita.notas || '';
    if (cita.modalidad === 'presencial' && notas.includes(PALMA_MARKER)) {
        return {
            modalidad: 'presencial-palma',
            notasLimpias: notas.replace(PALMA_MARKER, '').trim(),
        };
    }
    return {
        modalidad: cita.modalidad || 'presencial',
        notasLimpias: notas,
    };
}

// Inverso de detectarModalidadEditor: al guardar, si el admin eligió
// presencial-palma, persistimos modalidad='presencial' y re-incrustamos
// el marcador en notas. Mismo patrón que admin.js:440-444 (modal crear).
function aplicarModalidadGuardar(modSelect, notasInput) {
    if (modSelect === 'presencial-palma') {
        return {
            modalidad: 'presencial',
            notas: notasInput ? `${PALMA_MARKER} ${notasInput}` : PALMA_MARKER,
        };
    }
    return { modalidad: modSelect, notas: notasInput };
}

// Carga única de la lista de clientes para el autocomplete (compartida
// entre modal crear y modal editar). Si falla, el form sigue funcionando
// como hoy: Charly tipea libremente y se crea cliente nuevo al guardar.
async function cargarClientesCache() {
    if (state.clientesCache && state.clientesCache.length > 0) return;
    try {
        state.clientesCache = await agenda.obtenerClientesParaAutocomplete();
    } catch (err) {
        console.error('Error cargando clientes para autocomplete:', err);
        state.clientesCache = [];
    }
}

// Normalización para búsqueda fuzzy: lowercase + sin acentos.
// Permite que "maria" matchee "María", "garcía", etc.
function normalizarTexto(s) {
    // ̀-ͯ es el rango Unicode de marcas diacríticas combinables
    // (acentos, diéresis, tildes, etc.) que aparece tras .normalize('NFD').
    return (s || '')
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .trim();
}

/**
 * Componente autocomplete de clientes reusable. Conecta un <input>, un
 * <div.ac-dropdown> y un <input type="hidden"> que guarda el id del
 * cliente elegido.
 *
 * Comportamiento:
 *  - < 2 chars → dropdown cerrado, hidden vacío.
 *  - ≥ 2 chars → filtra cache por substring en nombre OR teléfono
 *    (normalizado sin acentos), top 8.
 *  - Sin matches → mensaje "se creará nuevo cliente al guardar".
 *  - Click / Enter / ↑↓ navegan; Esc / blur cierran.
 *  - Si Charly modifica el input tras elegir, hidden se limpia
 *    (rompe el vínculo automáticamente, evita inconsistencias).
 *
 * @param {{
 *   inputEl: HTMLInputElement,
 *   dropdownEl: HTMLElement,
 *   hiddenEl: HTMLInputElement,
 *   onSelect?: (cliente:Object) => void,
 *   onClear?: () => void,
 * }} cfg
 */
function setupAutocompleteCliente(cfg) {
    const { inputEl, dropdownEl, hiddenEl, onSelect, onClear } = cfg;
    if (!inputEl || !dropdownEl || !hiddenEl) return;
    if (inputEl.__acBound) return;

    let activeIdx = -1;
    let currentMatches = [];

    function cerrar() {
        dropdownEl.hidden = true;
        activeIdx = -1;
    }

    function render() {
        if (currentMatches.length === 0) {
            dropdownEl.innerHTML = '<div class="ac-empty">No hay coincidencias — se creará nuevo cliente al guardar</div>';
            return;
        }
        dropdownEl.innerHTML = currentMatches.map((c, i) => `
            <div class="ac-item ${i === activeIdx ? 'active' : ''}" data-idx="${i}" role="option">
                <span class="ac-item-nombre">${escapeHTML(c.nombre || '(sin nombre)')}</span>
                <span class="ac-item-tel">${escapeHTML(c.telefono || '')}</span>
            </div>
        `).join('');
    }

    function filtrar(qRaw) {
        const q = normalizarTexto(qRaw);
        if (q.length < 2) return null;
        const cache = state.clientesCache || [];
        return cache.filter((c) => {
            const n = normalizarTexto(c.nombre);
            const t = normalizarTexto(c.telefono);
            return n.includes(q) || t.includes(q);
        }).slice(0, 8);
    }

    function seleccionar(cliente) {
        inputEl.value = cliente.nombre || '';
        hiddenEl.value = cliente.id;
        cerrar();
        if (typeof onSelect === 'function') onSelect(cliente);
    }

    inputEl.addEventListener('input', () => {
        // Tipear desselecciona automáticamente
        if (hiddenEl.value) {
            hiddenEl.value = '';
            if (typeof onClear === 'function') onClear();
        }
        const matches = filtrar(inputEl.value);
        if (matches === null) { cerrar(); return; }
        currentMatches = matches;
        activeIdx = matches.length > 0 ? 0 : -1;
        render();
        dropdownEl.hidden = false;
    });

    inputEl.addEventListener('keydown', (e) => {
        if (dropdownEl.hidden || currentMatches.length === 0) return;
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            activeIdx = (activeIdx + 1) % currentMatches.length;
            render();
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            activeIdx = (activeIdx - 1 + currentMatches.length) % currentMatches.length;
            render();
        } else if (e.key === 'Enter') {
            if (activeIdx >= 0 && activeIdx < currentMatches.length) {
                e.preventDefault();
                seleccionar(currentMatches[activeIdx]);
            }
        } else if (e.key === 'Escape') {
            cerrar();
        }
    });

    // mousedown (no click) para no perder focus antes del select
    dropdownEl.addEventListener('mousedown', (e) => {
        const item = e.target.closest('[data-idx]');
        if (!item) return;
        e.preventDefault();
        const idx = parseInt(item.dataset.idx, 10);
        if (!isNaN(idx) && currentMatches[idx]) seleccionar(currentMatches[idx]);
    });

    inputEl.addEventListener('blur', () => {
        // delay para que mousedown del dropdown alcance a ejecutarse
        setTimeout(cerrar, 150);
    });

    inputEl.__acBound = true;
}

async function abrirModalEditarCita(citaId) {
    const cita = (state.citas || []).find((c) => c.id === citaId);
    if (!cita) {
        alert('No se encontró la cita en la lista cargada. Refrescá la pestaña.');
        return;
    }
    editState.citaId = citaId;
    showCeError('');

    // Header informativo con el cliente actual (referencia visual antes de editar)
    const hint = document.getElementById('ce-cliente-actual');
    if (hint) {
        const nombre = cita.clientes?.nombre || '(sin cliente)';
        const tel = cita.clientes?.telefono ? ` · ${cita.clientes.telefono}` : '';
        hint.textContent = `Cliente actual: ${nombre}${tel}`;
    }

    // Cache de clientes + setup del autocomplete (se bindea una sola vez
    // gracias al guard __acBound, pero igual lo invocamos para idempotencia).
    await cargarClientesCache();
    setupAutocompleteCeCliente();

    // Precarga input visible + hidden con el cliente actual de la cita
    const inputCli = document.getElementById('ce-cliente-input');
    const hiddenCli = document.getElementById('ce-cliente');
    const dropCli = document.getElementById('ce-cliente-dropdown');
    if (inputCli)  inputCli.value  = cita.clientes?.nombre || '';
    if (hiddenCli) hiddenCli.value = cita.cliente_id || '';
    if (dropCli)   dropCli.hidden  = true;

    const { modalidad, notasLimpias } = detectarModalidadEditor(cita);

    document.getElementById('ce-fecha').value = cita.fecha || '';
    document.getElementById('ce-hora').value = (cita.hora || '').substring(0, 5);
    document.getElementById('ce-modalidad').value = modalidad;
    document.getElementById('ce-zona').value = cita.zona || '';
    document.getElementById('ce-estado').value = cita.estado || 'pendiente';
    document.getElementById('ce-numero-clase').value = cita.numero_clase != null ? String(cita.numero_clase) : '';
    document.getElementById('ce-notas').value = notasLimpias;

    openModal('modal-cita-edit');
}

// Conecta el autocomplete del modal editar. A diferencia del modal crear,
// acá NO autollenamos campos del cliente (el modal solo edita datos de la
// cita); el autocomplete sólo actualiza el cliente_id seleccionado.
function setupAutocompleteCeCliente() {
    const inputEl = document.getElementById('ce-cliente-input');
    const dropdownEl = document.getElementById('ce-cliente-dropdown');
    const hiddenEl = document.getElementById('ce-cliente');
    if (!inputEl || !dropdownEl || !hiddenEl) return;

    setupAutocompleteCliente({ inputEl, dropdownEl, hiddenEl });
}

function bindModalCitaEdit() {
    if (window.__modalEditCitaBound) return;

    const ceSave = document.getElementById('ce-save');
    if (ceSave) {
        ceSave.addEventListener('click', async () => {
            const citaId = editState.citaId;
            if (!citaId) { showCeError('No hay cita seleccionada.'); return; }

            const clienteId = document.getElementById('ce-cliente')?.value || '';
            const fecha = document.getElementById('ce-fecha')?.value || '';
            const horaInput = document.getElementById('ce-hora')?.value || '';
            const modalidadSel = document.getElementById('ce-modalidad')?.value || '';
            const zona = (document.getElementById('ce-zona')?.value || '').trim();
            const estado = document.getElementById('ce-estado')?.value || '';
            const notasInput = (document.getElementById('ce-notas')?.value || '').trim();
            const numeroClase = parseIntOrNull(document.getElementById('ce-numero-clase')?.value);

            if (!clienteId) {
                const inputCli = document.getElementById('ce-cliente-input');
                const tipeado = (inputCli?.value || '').trim();
                showCeError(tipeado
                    ? `Elegí un cliente del dropdown — "${tipeado}" no está vinculado a ningún registro.`
                    : 'Falta el cliente.');
                return;
            }
            if (!fecha)     { showCeError('Falta la fecha.'); return; }
            if (!horaInput) { showCeError('Falta la hora.'); return; }

            const hora = horaInput.length === 5 ? `${horaInput}:00` : horaInput;
            const { modalidad, notas } = aplicarModalidadGuardar(modalidadSel, notasInput);

            const parches = {
                cliente_id: clienteId,
                fecha,
                hora,
                modalidad: modalidad || null,
                zona: zona || null,
                notas: notas || null,
                estado,
                numero_clase: numeroClase,
            };

            ceSave.disabled = true;
            ceSave.textContent = 'Guardando…';
            try {
                await agenda.actualizarCita(citaId, parches);
                closeModal('modal-cita-edit');
                editState.citaId = null;
                await cargarCitas();
            } catch (err) {
                console.error('Error actualizarCita:', err);
                showCeError(err?.message || 'No se pudo guardar la cita.');
            } finally {
                ceSave.disabled = false;
                ceSave.textContent = 'Guardar';
            }
        });
    }

    const ceEliminar = document.getElementById('ce-eliminar');
    if (ceEliminar) {
        ceEliminar.addEventListener('click', async () => {
            const citaId = editState.citaId;
            if (!citaId) { showCeError('No hay cita seleccionada.'); return; }
            const cita = (state.citas || []).find((c) => c.id === citaId);
            const nombre = cita?.clientes?.nombre || 'cliente';
            const fechaTxt = cita ? formatearFechaCorta(cita.fecha) : '';
            const horaTxt = cita ? formatearHora(cita.hora) : '';
            const msg = `¿Eliminar la cita de ${nombre} del ${fechaTxt} a las ${horaTxt}? Esta acción no se puede deshacer.`;
            if (!confirm(msg)) return;

            ceEliminar.disabled = true;
            ceEliminar.textContent = 'Eliminando…';
            try {
                await agenda.eliminarCita(citaId);
                closeModal('modal-cita-edit');
                editState.citaId = null;
                await cargarCitas();
            } catch (err) {
                console.error('Error eliminarCita:', err);
                showCeError(err?.message || 'No se pudo eliminar la cita.');
            } finally {
                ceEliminar.disabled = false;
                ceEliminar.textContent = 'Eliminar';
            }
        });
    }

    window.__modalEditCitaBound = true;
}

/* ═══════════════════════════════════════════
   STATS — Bloque 4
   ═══════════════════════════════════════════ */

const statsState = {
    periodo: '30d',
    charts: {},
    bound: false,
};

function calcularRango(periodo) {
    const hoy = new Date();
    const hoyStr = formatearFechaLocal(hoy);
    if (periodo === '7d') {
        const desde = new Date(hoy); desde.setDate(desde.getDate() - 6);
        return { desde: formatearFechaLocal(desde), hasta: hoyStr };
    }
    if (periodo === '30d') {
        const desde = new Date(hoy); desde.setDate(desde.getDate() - 29);
        return { desde: formatearFechaLocal(desde), hasta: hoyStr };
    }
    if (periodo === 'mes') {
        const desde = new Date(hoy.getFullYear(), hoy.getMonth(), 1);
        return { desde: formatearFechaLocal(desde), hasta: hoyStr };
    }
    if (periodo === 'ano') {
        const desde = new Date(hoy.getFullYear(), 0, 1);
        return { desde: formatearFechaLocal(desde), hasta: hoyStr };
    }
    return null;
}

function formatearFechaLocal(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

function initStats() {
    if (!statsState.bound) {
        bindStatsPeriodos();
        statsState.bound = true;
    }
    cargarTodoStats();
}

function bindStatsPeriodos() {
    document.querySelectorAll('.stats-periodo-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.stats-periodo-btn').forEach((b) => b.classList.remove('active'));
            btn.classList.add('active');
            statsState.periodo = btn.dataset.periodo;
            cargarTodoStats();
        });
    });
}

async function cargarTodoStats() {
    const rango = calcularRango(statsState.periodo);
    await Promise.all([
        cargarKPIsStats(rango),
        cargarFunnelStats(rango),
        cargarDerivacionesStats(rango),
        cargarDispositivoStats(rango),
        cargarDoughnut('tema',      () => stats.obtenerDistribucionTema(rango),      'chart-tema',      'tabla-tema'),
        cargarDoughnut('modalidad', () => stats.obtenerDistribucionModalidad(rango), 'chart-modalidad', 'tabla-modalidad'),
        cargarDoughnut('origen',    () => stats.obtenerDistribucionOrigen(rango),    'chart-origen',    'tabla-origen'),
        cargarDoughnut('clientes',  () => stats.obtenerDistribucionClientes(),       'chart-clientes'),
        cargarBarrasCitasMes(),
    ]);
}

async function cargarKPIsStats(rango) {
    try {
        const k = await stats.obtenerKPIs(rango);
        document.getElementById('kpi-sesiones').textContent = String(k.sesiones_reales);
        document.getElementById('kpi-precios').textContent = String(k.vieron_precios);
        document.getElementById('kpi-citas').textContent = String(k.citas_confirmadas);
        // conversion_pct ya viene formateado: '5.4%' o '—'
        document.getElementById('kpi-tasa').textContent = k.conversion_pct;
        document.getElementById('kpi-clientes').textContent = String(k.clientes_activos);
    } catch (err) { console.error('KPIs:', err); }
}

async function cargarFunnelStats(rango) {
    try {
        const data = await stats.obtenerFunnelVictoria(rango);
        const container = document.getElementById('stats-funnel');
        if (!container) return;
        if (!data.length || data[0].n === 0) {
            container.innerHTML = '<p class="stats-empty">Sin datos en este período.</p>';
            return;
        }
        const max = Math.max(...data.map((d) => d.n), 1);
        container.innerHTML = data.map((d) => {
            const pct = Math.round((d.n / max) * 100);
            const warnClass = d.mayor_caida ? ' funnel-row-warn' : '';
            return `
                <div class="funnel-row${warnClass}">
                    <div class="funnel-label">${escapeHTML(d.etapa)}</div>
                    <div class="funnel-bar-wrap">
                        <div class="funnel-bar" style="width: ${pct}%;"></div>
                        <span class="funnel-value">${d.n}</span>
                    </div>
                </div>
            `;
        }).join('');
    } catch (err) { console.error('Funnel:', err); }
}

async function cargarDerivacionesStats(rango) {
    try {
        const d = await stats.obtenerDerivaciones(rango);
        document.getElementById('deriv-etologo').textContent = String(d.a_etologo);
        document.getElementById('deriv-zona').textContent = String(d.por_zona);
    } catch (err) { console.error('Derivaciones:', err); }
}

const DOUGHNUT_COLORS = ['#C8102E', '#6B7A3A', '#1A1A1A', '#F5EFE0', '#8B7355', '#A04040', '#4A5530', '#D4A05C'];

async function cargarDoughnut(key, fetcher, canvasId, tablaId) {
    try {
        const data = await fetcher();
        const ctx = document.getElementById(canvasId);
        if (!ctx) return;
        if (statsState.charts[key]) statsState.charts[key].destroy();

        const wrap = ctx.closest('.canvas-wrap');
        if (!data.length) {
            ctx.style.display = 'none';
            if (wrap && !wrap.querySelector('.stats-empty')) {
                wrap.insertAdjacentHTML('beforeend', '<p class="stats-empty">Sin datos.</p>');
            }
            if (tablaId) renderTablaDesglose(tablaId, [], DOUGHNUT_COLORS);
            return;
        }
        ctx.style.display = '';
        const empty = wrap?.querySelector('.stats-empty');
        if (empty) empty.remove();

        statsState.charts[key] = new Chart(ctx, {
            type: 'doughnut',
            data: {
                labels: data.map((d) => d.label),
                datasets: [{
                    data: data.map((d) => d.n),
                    backgroundColor: DOUGHNUT_COLORS,
                    borderWidth: 0,
                }],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { position: 'bottom', labels: { color: '#F5EFE0', font: { family: 'Inter', size: 11 } } },
                },
            },
        });

        if (tablaId) renderTablaDesglose(tablaId, data, DOUGHNUT_COLORS);
    } catch (err) { console.error(`Doughnut ${key}:`, err); }
}

function renderTablaDesglose(contenedorId, datos, colores) {
    const cont = document.getElementById(contenedorId);
    if (!cont) return;

    const visibles = datos.filter((d) => d.n > 0);
    if (visibles.length === 0) {
        cont.innerHTML = '<p class="stats-empty stats-tabla-empty">Sin datos aún.</p>';
        return;
    }

    cont.innerHTML = datos.map((d, i) => {
        if (d.n === 0) return '';
        const pct = (d.pct ?? 0).toFixed(1);
        return `
            <div class="stats-tabla-fila">
                <span class="stats-tabla-dot" style="background:${colores[i % colores.length]}"></span>
                <span class="stats-tabla-label">${escapeHTML(d.label)}</span>
                <span class="stats-tabla-num">${d.n}</span>
                <span class="stats-tabla-pct">${pct}%</span>
            </div>
        `;
    }).join('');
}

async function cargarDispositivoStats(rango) {
    try {
        const d = await stats.obtenerDistribucionDispositivo(rango);
        const movilEl = document.getElementById('stats-movil-pct');
        const deskEl = document.getElementById('stats-desktop-pct');
        if (movilEl) movilEl.textContent = `${d.movil.pct}%`;
        if (deskEl) deskEl.textContent = `${d.desktop.pct}%`;
    } catch (err) { console.error('Dispositivo:', err); }
}

async function cargarBarrasCitasMes() {
    try {
        const data = await stats.obtenerCitasPorMes();
        const ctx = document.getElementById('chart-citas-mes');
        if (!ctx) return;
        if (statsState.charts.citasMes) statsState.charts.citasMes.destroy();
        if (!data.length) {
            ctx.style.display = 'none';
            return;
        }
        ctx.style.display = '';
        statsState.charts.citasMes = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: data.map((d) => d.mes),
                datasets: [{ data: data.map((d) => d.n), backgroundColor: '#C8102E', borderWidth: 0 }],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { display: false } },
                scales: {
                    x: { ticks: { color: '#F5EFE0' }, grid: { color: 'rgba(245,239,224,0.1)' } },
                    y: { ticks: { color: '#F5EFE0', precision: 0 }, grid: { color: 'rgba(245,239,224,0.1)' }, beginAtZero: true },
                },
            },
        });
    } catch (err) { console.error('CitasMes:', err); }
}

/* ═══════════════════════════════════════════
   CATÁLOGO — Bloque 5 (solo lectura)
   ═══════════════════════════════════════════ */

async function cargarCatalogoAdmin() {
    const grupos = document.getElementById('catalogo-grupos');
    const subtitle = document.getElementById('catalogo-subtitle');
    if (!grupos) return;
    grupos.innerHTML = '<p class="agenda-empty">Cargando catálogo…</p>';
    if (subtitle) subtitle.textContent = '';
    try {
        const ejercicios = await catalogo.obtenerCatalogo();
        renderCatalogoAdmin(ejercicios);
    } catch (err) {
        console.error('[admin/catalogo] error:', err);
        grupos.innerHTML = '<p class="agenda-empty">Error al cargar el catálogo.</p>';
        if (subtitle) subtitle.textContent = '—';
    }
}

function renderCatalogoAdmin(ejercicios) {
    const grupos = document.getElementById('catalogo-grupos');
    const subtitle = document.getElementById('catalogo-subtitle');
    if (!grupos) return;

    if (subtitle) {
        subtitle.textContent = `${ejercicios.length} ejercicios disponibles para asignar a perros.`;
    }

    if (ejercicios.length === 0) {
        grupos.innerHTML = '<p class="agenda-empty">No hay ejercicios activos en el catálogo.</p>';
        return;
    }

    // Agrupar por categoría según el orden definido en catalogo-labels.js
    const porCategoria = new Map();
    ORDEN_CATEGORIAS.forEach((cat) => porCategoria.set(cat, []));
    ejercicios.forEach((ej) => {
        if (porCategoria.has(ej.categoria)) porCategoria.get(ej.categoria).push(ej);
    });

    grupos.innerHTML = ORDEN_CATEGORIAS
        .filter((cat) => porCategoria.get(cat).length > 0)
        .map((cat) => {
            const items = porCategoria.get(cat);
            const label = CATEGORIA_LABEL[cat] || cat;
            const cards = items.map(renderCatalogoCard).join('');
            return `
                <section class="catalogo-grupo">
                    <h2 class="catalogo-grupo-header">
                        ${escapeHTML(label)}<span class="catalogo-grupo-count">(${items.length})</span>
                    </h2>
                    <ul class="catalogo-list">${cards}</ul>
                </section>
            `;
        })
        .join('');
}

function renderCatalogoCard(ej) {
    const nombre = escapeHTML(ej.nombre || 'Sin nombre');
    const codigo = ej.codigo ? `(${escapeHTML(ej.codigo)})` : '';
    const desc = ej.descripcion
        ? `<p class="catalogo-card-desc">${escapeHTML(ej.descripcion)}</p>`
        : '';
    const plantilla = ej.plantilla != null
        ? `<span class="catalogo-plantilla-tag">Plantilla ${escapeHTML(String(ej.plantilla))}</span>`
        : '';

    return `
        <li class="catalogo-card">
            <div class="catalogo-card-row">
                <span class="catalogo-card-nombre">${nombre}</span>
                ${plantilla}
                <span class="catalogo-card-codigo">${codigo}</span>
            </div>
            ${desc}
        </li>
    `;
}
