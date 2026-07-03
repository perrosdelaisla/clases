// =====================================================================
// admin.js — panel admin del universo Perros de la Isla (Fase 1)
//
// Reusa el cliente Supabase configurado en /js/supabase.js (apunta al
// proyecto Victoria, sydzfwwiruxqaxojymdz). Todas las queries pasan por
// la publishable key + RLS — la función SQL es_admin() reconoce al
// usuario logueado y deja pasar el SELECT a clientes/perros/admins.
// =====================================================================

import { getSupabase, getSessionConTimeout } from '../js/supabase.js';
import * as agenda from './agenda/api.js?v=14';
import * as stats from './stats/api.js?v=4';
import * as catalogo from './catalogo/api.js?v=4';
import { CATEGORIA_LABEL, ORDEN_CATEGORIAS } from './catalogo-labels.js';
import { initSwipeTabs } from '../js/swipe-tabs.js';
import { initAvisos, precargarBadgeAvisos } from './avisos.js?v=4';
import { initAtencion, precargarBadgeAtencion } from './atencion.js?v=2';
import { initJaime, jaimeEscuchando } from './jaime.js?v=13';
const supabase = getSupabase('admin');
// Chart.js cargado vía <script> UMD en index.html (window.Chart)
const Chart = window.Chart;

// Estado en memoria del admin actual y la lista cargada de clientes.
const state = {
    admin: null,            // { auth_user_id, email, nombre }
    clientes: [],           // resultado crudo del SELECT con perros anidados
    filtroEstado: 'activo', // 'todos' | 'consulta' | 'activo' | 'veterano' | 'ex_cliente'
    busqueda: '',
    citas: [],              // citas vigentes cacheadas para el modal editar
    clientesCache: [],      // lista plana de clientes para el autocomplete (crear+editar)
    perrosClienteCache: [], // perros del cliente actualmente elegido en modal crear
    catalogoEjercicios: [],
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
        const { data: { session } } = await getSessionConTimeout(8000, 'admin');
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

    bindCatalogoActions();
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

    // Asistente Jaime (chat global): FAB en toda la pantalla del admin, sin
    // contexto de cliente/perro (los resuelve por nombre con sus herramientas).
    initJaime({ pantalla: 'index' });

    // Swipe horizontal entre tabs principales del admin.
    // 'inicio' está oculto (decisión 08/05) — solo navegamos entre los 4 visibles.
    initSwipeTabs({
        container: document.querySelector('.admin-main'),
        tabs: ['agenda', 'seguimiento', 'clientes', 'stats', 'catalogo'],
        getCurrent: () => document.querySelector('.admin-panel:not([hidden])')?.dataset.panel,
        onChange: (tab) => activarTab(tab),
    });

    // Subtabs de Seguimiento (Avisos | Atención | Registros). Bindeadas al
    // arranque, igual que el resto de la navegación principal.
    bindSeguimientoSubtabs();

    // Compatibilidad de hash: notificaciones viejas apuntan a #avisos/#atencion/
    // #actividad, que ahora son subtabs dentro de 'seguimiento'.
    const HASH_A_SUBTAB = { avisos: 'avisos', atencion: 'atencion', actividad: 'registros' };

    // Tab inicial: prioridad al #hash (notificación, ej. #avisos), si no Agenda.
    const TABS_VALIDOS = ['agenda', 'seguimiento', 'clientes', 'stats', 'catalogo'];
    const hashTab = (location.hash || '').replace('#', '');
    let tabInicial = 'agenda';
    let subtabInicial = null;
    if (hashTab in HASH_A_SUBTAB) {
        tabInicial = 'seguimiento';
        subtabInicial = HASH_A_SUBTAB[hashTab];
    } else if (hashTab === 'seguimiento') {
        tabInicial = 'seguimiento';
        subtabInicial = 'avisos';
    } else if (TABS_VALIDOS.includes(hashTab) && hashTab !== 'inicio') {
        tabInicial = hashTab;
    }
    // Limpiar el #hash de la URL: viene de una notificación y, si no se
    // borra, queda pegado y la PWA reabre en esa pestaña en vez de Agenda.
    if (location.hash) {
        history.replaceState(history.state, '', location.pathname + location.search);
    }
    activarTab(tabInicial);
    if (subtabInicial) activarSeguimientoSubtab(subtabInicial);

    // Navegación desde notificación push (ventana ya abierta):
    // el SW manda {tipo:'pdli_navegar', url}; abrimos el tab del #hash.
    if (navigator.serviceWorker) {
        navigator.serviceWorker.addEventListener('message', (ev) => {
            const d = ev.data || {};
            if (d.tipo === 'pdli_navegar' && typeof d.url === 'string') {
                const t = (d.url.split('#')[1] || '').trim();
                if (t in HASH_A_SUBTAB) {
                    activarTab('seguimiento');
                    activarSeguimientoSubtab(HASH_A_SUBTAB[t]);
                } else if (t === 'seguimiento') {
                    activarTab('seguimiento');
                    activarSeguimientoSubtab('avisos');
                } else if (TABS_VALIDOS.includes(t)) {
                    activarTab(t);
                }
            }
        });
    }

    // Precarga del badge "Avisos" sin pintar el panel (corre en background,
    // tolera fallos para no romper el bootstrap del admin).
    precargarBadgeAvisos().catch((e) => console.warn('[admin] precarga avisos badge:', e));

    // Precarga del badge "Atención" (perros que necesitan un empujón), mismo criterio.
    precargarBadgeAtencion().catch((e) => console.warn('[admin] precarga atencion badge:', e));

    // Precarga del badge "Actividad" (registros sin ver), mismo criterio.
    precargarBadgeActividad().catch((e) => console.warn('[admin] precarga actividad badge:', e));

    // Badge madre de Seguimiento: suma los 3 sub-badges. Las precargas de arriba
    // son async; un MutationObserver sobre los 3 sub-badges mantiene el total al
    // día cuando pintan (y cuando el polling de avisos los actualiza).
    actualizarBadgeSeguimiento();
    ['avisos-badge', 'atencion-badge', 'actividad-badge'].forEach((id) => {
        const el = document.getElementById(id);
        if (!el) return;
        const obs = new MutationObserver(() => actualizarBadgeSeguimiento());
        obs.observe(el, { childList: true, attributes: true, attributeFilter: ['hidden'] });
    });
}

// Suma los enteros visibles de los 3 sub-badges y los pinta en #seguimiento-badge.
function actualizarBadgeSeguimiento() {
    const madre = document.getElementById('seguimiento-badge');
    if (!madre) return;
    let total = 0;
    ['avisos-badge', 'atencion-badge', 'actividad-badge'].forEach((id) => {
        const el = document.getElementById(id);
        if (!el || el.hidden) return;
        const n = parseInt(el.textContent, 10);
        if (Number.isFinite(n)) total += n;
    });
    if (total > 0) {
        madre.textContent = total > 99 ? '99+' : String(total);
        madre.hidden = false;
    } else {
        madre.hidden = true;
    }
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
    if (tab === 'seguimiento') {
        // Reabre la subtab activa (por defecto Avisos) y dispara su carga.
        const sub = document.querySelector('.seguimiento-subtab.active')?.dataset.subtab || 'avisos';
        activarSeguimientoSubtab(sub);
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
    state.filtroEstado = 'activo';
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

    // Swipe horizontal entre sub-tabs de Agenda.
    // Orden HTML: citas, bloqueos, plantilla — respetamos el visual.
    initSwipeTabs({
        container: document.querySelector('[data-panel="agenda"]'),
        tabs: ['citas', 'bloqueos', 'plantilla'],
        getCurrent: () => document.querySelector('.agenda-subtab.active')?.dataset.subtab,
        onChange: (sub) => activarAgendaSubtab(sub),
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

// Subtabs de Seguimiento (Avisos | Atención | Registros) — mismo patrón que
// bindAgendaSubtabs / activarAgendaSubtab (clic + swipe horizontal).
function bindSeguimientoSubtabs() {
    document.querySelectorAll('.seguimiento-subtab').forEach((btn) => {
        btn.addEventListener('click', () => activarSeguimientoSubtab(btn.dataset.subtab));
    });

    initSwipeTabs({
        container: document.querySelector('[data-panel="seguimiento"]'),
        tabs: ['avisos', 'atencion', 'registros'],
        getCurrent: () => document.querySelector('.seguimiento-subtab.active')?.dataset.subtab,
        onChange: (sub) => activarSeguimientoSubtab(sub),
    });
}

function activarSeguimientoSubtab(sub) {
    document.querySelectorAll('.seguimiento-subtab').forEach((b) => {
        b.classList.toggle('active', b.dataset.subtab === sub);
    });
    document.querySelectorAll('[data-seg-subpanel]').forEach((p) => {
        p.hidden = p.dataset.segSubpanel !== sub;
    });
    // Carga idempotente de cada sección.
    if (sub === 'avisos') {
        initAvisos().catch((e) => console.error('[admin] initAvisos:', e));
    } else if (sub === 'atencion') {
        initAtencion().catch((e) => console.error('[admin] initAtencion:', e));
    } else if (sub === 'registros') {
        // cargarActividad bindea una vez (actividadState.bound) y recarga registros.
        cargarActividad();
    }
}

function bindAgendaModals() {
    const btnAddHora = document.getElementById('btn-add-hora');
    if (btnAddHora) {
        btnAddHora.addEventListener('click', () => openModal('modal-add-hora'));
    }

    const btnCitaManual = document.getElementById('btn-abrir-cita-manual');
    if (btnCitaManual) {
        btnCitaManual.addEventListener('click', async () => {
            // Dropdown de horas arranca vacío con hint: se llena al elegir
            // fecha vía click en el calendario visual.
            actualizarHorasSegunFecha('');
            await Promise.all([
                inicializarCalendarioCitaManual(),
                cargarClientesCache(),
            ]);
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
                ubicacion_maps: normalizarUrlMaps(document.getElementById('cm-ubicacion-maps')?.value || ''),
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
                if (err?.code === 'SLOT_TOMADO') {
                    showCmError('Ese horario acaba de ser tomado por otra reserva. Refresca la agenda y elige otro.');
                    await cargarCitas();
                    return;
                }
                console.error('Error crearCitaManual:', err);
                showCmError(err?.message || 'No se pudo crear la cita.');
            } finally {
                cmSave.disabled = false;
                cmSave.textContent = 'Crear cita';
            }
        });
    }

    // Botón 📍 "Abrir en Maps": abre el enlace del cliente en pestaña nueva.
    // Aparece solo cuando cm-ubicacion-maps tiene valor (ver actualizarBotonMapsCm).
    const cmMapsInput = document.getElementById('cm-ubicacion-maps');
    const cmMapsBtn = document.getElementById('cm-ubicacion-abrir');
    if (cmMapsBtn && !cmMapsBtn.__mapsBound) {
        cmMapsBtn.__mapsBound = true;
        cmMapsBtn.addEventListener('click', () => {
            const url = normalizarUrlMaps(cmMapsInput?.value || '');
            if (url) window.open(url, '_blank');
        });
    }
    if (cmMapsInput && !cmMapsInput.__mapsBound) {
        cmMapsInput.__mapsBound = true;
        cmMapsInput.addEventListener('input', actualizarBotonMapsCm);
    }

    // "Guardar enlace": persiste SOLO ubicacion_maps del cliente existente
    // seleccionado (no toca el resto de sus datos). Guardado explícito → si el
    // campo quedó vacío, limpia el enlace (null); si no, lo normaliza.
    const cmMapsSave = document.getElementById('cm-ubicacion-guardar');
    if (cmMapsSave && !cmMapsSave.__mapsBound) {
        cmMapsSave.__mapsBound = true;
        cmMapsSave.addEventListener('click', async () => {
            const clienteId = (document.getElementById('cm-cliente-id')?.value || '').trim();
            if (!clienteId) return;
            const raw = cmMapsInput?.value || '';
            const valor = raw.trim() ? normalizarUrlMaps(raw) : null;
            const labelPrevio = cmMapsSave.textContent;
            cmMapsSave.disabled = true;
            cmMapsSave.textContent = 'Guardando…';
            try {
                const res = await agenda.actualizarUbicacionMapsCliente(clienteId, valor);
                if (res && res.ok === false) throw new Error(res.error || 'update falló');
                // Reflejar el valor normalizado en el input y refrescar el 📍.
                if (cmMapsInput) cmMapsInput.value = valor || '';
                actualizarBotonMapsCm();
                toast('Enlace guardado');
            } catch (err) {
                console.error('[cm] error guardando ubicacion_maps:', err);
                alert('No se pudo guardar el enlace. Probá de nuevo.');
            } finally {
                cmMapsSave.disabled = false;
                cmMapsSave.textContent = labelPrevio;
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
    if (id === 'modal-cita-edit') {
        resetResumenClase();
    }
    // Si el cierre vino de la UI (X, backdrop, Esc, botón Guardar/Eliminar),
    // consumimos la entrada que pusheamos al abrir. El handler de popstate
    // detecta cierreUiPendiente y no dispara la lógica de toast.
    if (estabaAbierto && !navegandoPorPopstate) {
        cierreUiPendiente = true;
        history.back();
    }
}

// ────────────────────────────────────────────────────────────────────
// Calendario visual del modal cita manual
// Port del calendario del cliente (js/app.js → renderCalMes). Estado
// local del módulo, no toca state global. Rango cacheado: hoy → primer
// día de mes +2 (mismas 8 semanas que ve el cliente).
// ────────────────────────────────────────────────────────────────────

const cmCal = {
    slotsPorFecha: {},   // { 'YYYY-MM-DD': ['HH:MM', ...] }
    mesAnchor: null,     // 'YYYY-MM-01'
    diaSeleccionado: null,
    desdeIso: null,      // límite inferior (hoy)
    hastaIso: null,      // límite superior (último día del mes +2)
};

function _hoyIso() {
    return new Date().toISOString().slice(0, 10);
}

function _primerDiaMesIso(fechaIso) {
    return `${fechaIso.slice(0, 7)}-01`;
}

function _sumarMesesIso(fechaIso, n) {
    const [y, m] = fechaIso.split('-').map(Number);
    const total = (y * 12 + (m - 1)) + n;
    const ny = Math.floor(total / 12);
    const nm = (total % 12) + 1;
    return `${ny}-${String(nm).padStart(2, '0')}-01`;
}

function _ultimoDiaMesIso(fechaIso) {
    const [y, m] = fechaIso.split('-').map(Number);
    const ultimo = new Date(y, m, 0).getDate();
    return `${y}-${String(m).padStart(2, '0')}-${String(ultimo).padStart(2, '0')}`;
}

function _nombreMesAnio(fechaIso) {
    const meses = ['Enero','Febrero','Marzo','Abril','Mayo','Junio',
                   'Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
    const [y, m] = fechaIso.split('-');
    return `${meses[parseInt(m, 10) - 1]} ${y}`;
}

async function inicializarCalendarioCitaManual() {
    const hoy = _hoyIso();
    const mesHoy = _primerDiaMesIso(hoy);
    const limiteSup = _sumarMesesIso(mesHoy, 2);
    const hastaIso = _ultimoDiaMesIso(limiteSup);

    cmCal.desdeIso = hoy;
    cmCal.hastaIso = hastaIso;
    cmCal.mesAnchor = mesHoy;
    cmCal.diaSeleccionado = null;
    cmCal.slotsPorFecha = {};

    // Hidden input vuelve a vacío y dropdown queda con hint inicial.
    const hidden = document.getElementById('cm-fecha');
    if (hidden) hidden.value = '';

    try {
        cmCal.slotsPorFecha = await agenda.obtenerSlotsDisponiblesEnRango(hoy, hastaIso);
    } catch (err) {
        console.error('Error precargando slots del calendario cita manual:', err);
        cmCal.slotsPorFecha = {};
    }

    // Anchor inicial: mes del primer día con disponibilidad si existe,
    // si no, el mes actual.
    const fechasDisp = Object.keys(cmCal.slotsPorFecha).sort();
    if (fechasDisp.length > 0) {
        cmCal.mesAnchor = _primerDiaMesIso(fechasDisp[0]);
    }

    wireCalendarioCitaManualNav();
    renderCalendarioCitaManual();
}

function wireCalendarioCitaManualNav() {
    const prev = document.getElementById('cm-cal-mes-prev');
    const next = document.getElementById('cm-cal-mes-next');
    if (prev && !prev.dataset.navBound) {
        prev.addEventListener('click', () => {
            cmCal.mesAnchor = _sumarMesesIso(cmCal.mesAnchor, -1);
            renderCalendarioCitaManual();
        });
        prev.dataset.navBound = '1';
    }
    if (next && !next.dataset.navBound) {
        next.addEventListener('click', () => {
            cmCal.mesAnchor = _sumarMesesIso(cmCal.mesAnchor, 1);
            renderCalendarioCitaManual();
        });
        next.dataset.navBound = '1';
    }
}

function renderCalendarioCitaManual() {
    const grid = document.getElementById('cm-cal-mes-grid');
    const titulo = document.getElementById('cm-cal-mes-titulo');
    const prev = document.getElementById('cm-cal-mes-prev');
    const next = document.getElementById('cm-cal-mes-next');
    const anchor = cmCal.mesAnchor;
    if (!grid || !anchor) return;

    titulo.textContent = _nombreMesAnio(anchor).toUpperCase();

    // Mismo límite que el cliente: hoy → +2 meses (cubre el fetch).
    const hoyMes = _primerDiaMesIso(_hoyIso());
    const limiteSup = _sumarMesesIso(hoyMes, 2);

    if (prev) prev.disabled = anchor <= hoyMes;
    if (next) next.disabled = anchor >= limiteSup;

    const [y, m] = anchor.split('-').map(Number);
    const primero = new Date(y, m - 1, 1);
    const ultimoDia = new Date(y, m, 0).getDate();
    const diaSemanaInicio = (primero.getDay() + 6) % 7;

    const hoyIso = _hoyIso();
    const cells = [];

    for (let i = 0; i < diaSemanaInicio; i++) {
        cells.push('<button type="button" class="cal-dia is-fuera-mes" disabled></button>');
    }

    for (let d = 1; d <= ultimoDia; d++) {
        const iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        const tieneDispo = !!cmCal.slotsPorFecha[iso];
        const esSeleccionado = iso === cmCal.diaSeleccionado;
        const esPasado = iso < hoyIso;

        const clases = ['cal-dia'];
        if (esPasado || !tieneDispo) clases.push('is-deshabilitado');
        if (tieneDispo) clases.push('is-disponible');
        if (esSeleccionado) clases.push('is-seleccionado');

        const punto = tieneDispo ? '<span class="cal-dia__punto" aria-hidden="true"></span>' : '';
        const disabled = (esPasado || !tieneDispo) ? 'disabled' : '';
        cells.push(`
            <button type="button" class="${clases.join(' ')}" data-fecha="${iso}" ${disabled}>
                <span>${d}</span>
                ${punto}
            </button>
        `);
    }

    grid.innerHTML = cells.join('');

    grid.querySelectorAll('.cal-dia.is-disponible').forEach((btn) => {
        btn.addEventListener('click', () => {
            const fecha = btn.dataset.fecha;
            cmCal.diaSeleccionado = fecha;
            const hidden = document.getElementById('cm-fecha');
            if (hidden) hidden.value = fecha;
            renderCalendarioCitaManual();
            actualizarHorasSegunFecha(fecha);
        });
    });
}

function resetCalendarioCitaManual() {
    cmCal.slotsPorFecha = {};
    cmCal.mesAnchor = null;
    cmCal.diaSeleccionado = null;
    cmCal.desdeIso = null;
    cmCal.hastaIso = null;
    const grid = document.getElementById('cm-cal-mes-grid');
    if (grid) grid.innerHTML = '';
    const titulo = document.getElementById('cm-cal-mes-titulo');
    if (titulo) titulo.textContent = '—';
    const prev = document.getElementById('cm-cal-mes-prev');
    if (prev) prev.disabled = true;
    const next = document.getElementById('cm-cal-mes-next');
    if (next) next.disabled = true;
}

// Repuebla el dropdown de horas del modal cita manual según la fecha
// elegida, cruzando con citas+bloqueos vía RPC get_available_slots
// (misma fuente que Victoria y la app cliente). Estados:
//   · sin fecha           → hint "Elegí fecha primero…"
//   · con fecha sin slots → "No hay horas disponibles"
//   · con slots           → opciones HH:MM; preserva valor previo si sigue disponible.
async function actualizarHorasSegunFecha(fechaIso) {
    const select = document.getElementById('cm-hora');
    if (!select) return;

    if (!fechaIso) {
        select.innerHTML = '<option value="">Elegí fecha primero…</option>';
        select.value = '';
        return;
    }

    const valorPrevio = select.value;
    try {
        const horasUnicas = await agenda.obtenerSlotsDisponiblesPorFecha(fechaIso);
        if (horasUnicas.length === 0) {
            select.innerHTML = '<option value="">No hay horas disponibles</option>';
            select.value = '';
            return;
        }
        select.innerHTML = '<option value="">Elegí una hora…</option>' +
            horasUnicas.map((h) => `<option value="${escapeHTML(h)}">${escapeHTML(h)}</option>`).join('');
        if (valorPrevio && horasUnicas.includes(valorPrevio)) {
            select.value = valorPrevio;
        }
    } catch (err) {
        console.error('Error cargando horas para dropdown cita:', err);
        select.innerHTML = '<option value="">No hay horas disponibles</option>';
        select.value = '';
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

// ────────────────────────────────────────────────────────────────────
// Calendario visual de Bloqueos — réplica del de cita manual (cmCal),
// con estado e IDs propios (bloqCal / bloq-cal-*). Reutiliza los helpers
// de fecha (_hoyIso / _primerDiaMesIso / _sumarMesesIso / _ultimoDiaMesIso /
// _nombreMesAnio) y las clases CSS cal-dia. NO toca cita manual.
// ────────────────────────────────────────────────────────────────────

const bloqCal = {
    slotsPorFecha: {},   // { 'YYYY-MM-DD': ['HH:MM', ...] }
    mesAnchor: null,     // 'YYYY-MM-01'
    diaSeleccionado: null,
    desdeIso: null,      // límite inferior (hoy)
    hastaIso: null,      // límite superior (último día del mes +2)
};

async function initCalendarioBloqueo() {
    const hoy = _hoyIso();
    const mesHoy = _primerDiaMesIso(hoy);
    const limiteSup = _sumarMesesIso(mesHoy, 2);
    const hastaIso = _ultimoDiaMesIso(limiteSup);

    bloqCal.desdeIso = hoy;
    bloqCal.hastaIso = hastaIso;
    bloqCal.mesAnchor = mesHoy;
    bloqCal.diaSeleccionado = null;
    bloqCal.slotsPorFecha = {};

    // Hidden input vuelve a vacío al re-inicializar.
    const hidden = document.getElementById('bloq-fecha');
    if (hidden) hidden.value = '';

    try {
        bloqCal.slotsPorFecha = await agenda.obtenerSlotsDisponiblesEnRango(hoy, hastaIso);
    } catch (err) {
        console.error('Error precargando slots del calendario bloqueo:', err);
        bloqCal.slotsPorFecha = {};
    }

    // Anchor inicial: mes del primer día con disponibilidad si existe.
    const fechasDisp = Object.keys(bloqCal.slotsPorFecha).sort();
    if (fechasDisp.length > 0) {
        bloqCal.mesAnchor = _primerDiaMesIso(fechasDisp[0]);
    }

    wireCalendarioBloqueoNav();
    renderCalendarioBloqueo();
}

function wireCalendarioBloqueoNav() {
    const prev = document.getElementById('bloq-cal-mes-prev');
    const next = document.getElementById('bloq-cal-mes-next');
    if (prev && !prev.dataset.navBound) {
        prev.addEventListener('click', () => {
            bloqCal.mesAnchor = _sumarMesesIso(bloqCal.mesAnchor, -1);
            renderCalendarioBloqueo();
        });
        prev.dataset.navBound = '1';
    }
    if (next && !next.dataset.navBound) {
        next.addEventListener('click', () => {
            bloqCal.mesAnchor = _sumarMesesIso(bloqCal.mesAnchor, 1);
            renderCalendarioBloqueo();
        });
        next.dataset.navBound = '1';
    }
}

function renderCalendarioBloqueo() {
    const grid = document.getElementById('bloq-cal-mes-grid');
    const titulo = document.getElementById('bloq-cal-mes-titulo');
    const prev = document.getElementById('bloq-cal-mes-prev');
    const next = document.getElementById('bloq-cal-mes-next');
    const anchor = bloqCal.mesAnchor;
    if (!grid || !anchor) return;

    titulo.textContent = _nombreMesAnio(anchor).toUpperCase();

    // Mismo límite que cita manual: hoy → +2 meses (cubre el fetch).
    const hoyMes = _primerDiaMesIso(_hoyIso());
    const limiteSup = _sumarMesesIso(hoyMes, 2);

    if (prev) prev.disabled = anchor <= hoyMes;
    if (next) next.disabled = anchor >= limiteSup;

    const [y, m] = anchor.split('-').map(Number);
    const primero = new Date(y, m - 1, 1);
    const ultimoDia = new Date(y, m, 0).getDate();
    const diaSemanaInicio = (primero.getDay() + 6) % 7;

    const hoyIso = _hoyIso();
    const cells = [];

    for (let i = 0; i < diaSemanaInicio; i++) {
        cells.push('<button type="button" class="cal-dia is-fuera-mes" disabled></button>');
    }

    for (let d = 1; d <= ultimoDia; d++) {
        const iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        const tieneDispo = !!bloqCal.slotsPorFecha[iso];
        const esSeleccionado = iso === bloqCal.diaSeleccionado;
        const esPasado = iso < hoyIso;

        const clases = ['cal-dia'];
        if (esPasado || !tieneDispo) clases.push('is-deshabilitado');
        if (tieneDispo) clases.push('is-disponible');
        if (esSeleccionado) clases.push('is-seleccionado');

        const punto = tieneDispo ? '<span class="cal-dia__punto" aria-hidden="true"></span>' : '';
        const disabled = (esPasado || !tieneDispo) ? 'disabled' : '';
        cells.push(`
            <button type="button" class="${clases.join(' ')}" data-fecha="${iso}" ${disabled}>
                <span>${d}</span>
                ${punto}
            </button>
        `);
    }

    grid.innerHTML = cells.join('');

    grid.querySelectorAll('.cal-dia.is-disponible').forEach((btn) => {
        btn.addEventListener('click', () => {
            const fecha = btn.dataset.fecha;
            bloqCal.diaSeleccionado = fecha;
            const hidden = document.getElementById('bloq-fecha');
            if (hidden) hidden.value = fecha;
            renderCalendarioBloqueo();
            actualizarHorasBloqueoSegunFecha(fecha);
        });
    });
}

// Repuebla #bloq-hora según la fecha elegida, CONSERVANDO "Día completo"
// como primera opción y las horas disponibles debajo (misma fuente que
// cita manual: get_available_slots vía obtenerSlotsDisponiblesPorFecha).
async function actualizarHorasBloqueoSegunFecha(fechaIso) {
    const select = document.getElementById('bloq-hora');
    if (!select) return;

    const valorPrevio = select.value;

    if (!fechaIso) {
        select.innerHTML = '<option value="">Día completo</option>';
        select.value = '';
        return;
    }

    try {
        const horasUnicas = await agenda.obtenerSlotsDisponiblesPorFecha(fechaIso);
        select.innerHTML = '<option value="">Día completo</option>' +
            horasUnicas.map((h) => `<option value="${escapeHTML(h)}">${escapeHTML(h)}</option>`).join('');
        if (valorPrevio && horasUnicas.includes(valorPrevio)) {
            select.value = valorPrevio;
        }
    } catch (err) {
        console.error('Error cargando horas para dropdown bloqueo:', err);
        select.innerHTML = '<option value="">Día completo</option>';
        select.value = '';
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

// Validación suave para enlaces de Maps: si no empieza por http(s), anteponer
// https://. Los links de Maps tienen mil formatos (maps.app.goo.gl,
// google.com/maps, goo.gl/maps) — solo garantizamos que sea abrible.
function normalizarUrlMaps(valor) {
    const s = (valor || '').trim();
    if (!s) return s;
    return /^https?:\/\//i.test(s) ? s : 'https://' + s;
}

// Botones del campo de Maps en el modal de cita manual:
//  · 📍 "Abrir": visible solo si el campo tiene valor.
//  · "Guardar enlace": visible solo con un cliente EXISTENTE seleccionado
//    (cm-cliente-id). El cliente nuevo persiste su enlace al crear la cita.
function actualizarBotonMapsCm() {
    const input = document.getElementById('cm-ubicacion-maps');
    const tieneValor = !!((input?.value || '').trim());
    const clienteId = (document.getElementById('cm-cliente-id')?.value || '').trim();
    const abrir = document.getElementById('cm-ubicacion-abrir');
    const guardar = document.getElementById('cm-ubicacion-guardar');
    if (abrir) abrir.hidden = !tieneValor;
    if (guardar) guardar.hidden = !clienteId;
}

function resetCmForm() {
    const ids = [
        'cm-nombre', 'cm-telefono', 'cm-direccion', 'cm-ubicacion-maps', 'cm-email', 'cm-cliente-id',
        'cm-perro', 'cm-perro-id', 'cm-raza', 'cm-edad', 'cm-peso',
        'cm-fecha', 'cm-hora', 'cm-modalidad', 'cm-zona', 'cm-notas',
        'cm-numero-clase',
    ];
    ids.forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
    actualizarBotonMapsCm();
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
    // Calendario visual: limpiar estado y grid hasta la próxima apertura.
    resetCalendarioCitaManual();
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
            const maps = document.getElementById('cm-ubicacion-maps');
            const mail = document.getElementById('cm-email');
            const zona = document.getElementById('cm-zona');
            if (tel)  tel.value  = c.telefono  || '';
            if (dir)  dir.value  = c.direccion || '';
            if (maps) maps.value = c.ubicacion_maps || '';
            if (mail) mail.value = c.email     || '';
            if (zona) zona.value = c.zona      || '';
            actualizarBotonMapsCm();

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
            // Se rompió el vínculo con cliente existente → ocultar "Guardar enlace".
            actualizarBotonMapsCm();
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
        // Refresca el calendario visual para reflejar el estado actual
        // (cubre alta de subtab, post-submit y post-eliminación, que
        // pasan todos por acá).
        initCalendarioBloqueo();
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
                    ${c.cliente_id
                        ? `<a class="cita-cliente-link" href="./cliente.html?id=${encodeURIComponent(c.cliente_id)}"><strong>${escapeHTML(cliente)}</strong></a>`
                        : `<strong>${escapeHTML(cliente)}</strong>`}${telefono ? ' · ' + escapeHTML(telefono) : ''}${zona ? ' · ' + escapeHTML(zona) : ''}${c.modalidad ? ' · ' + escapeHTML(c.modalidad) : ''}
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

    setupResumenClase(cita);

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
                if (err?.code === 'SLOT_TOMADO') {
                    showCeError('Ese horario acaba de ser tomado por otra reserva. Refresca la agenda y elige otro.');
                    await cargarCitas();
                    return;
                }
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
   RESUMEN DE CLASE POR VOZ — modal editar cita
   Dicta → Web Speech API vuelca el crudo → edge fn
   `resumir-clase` lo redacta para el tutor → UPDATE
   citas.resumen_cliente. Todo editable a mano.
   ═══════════════════════════════════════════ */

const resumenClaseCtx = { cita:null, rec:null, grabando:false, textoBase:'' };

// Se llama en cada apertura del modal editar cita. Bindea una sola vez los
// botones (guard) y precarga el estado a partir de la cita.
function setupResumenClase(cita) {
    resumenClaseCtx.cita = cita;
    bindResumenClase();

    const crudo = document.getElementById('rc-crudo');
    const resumen = document.getElementById('rc-resumen');
    const generar = document.getElementById('rc-generar');
    const msg = document.getElementById('rc-msg');
    if (crudo) crudo.value = '';
    if (resumen) resumen.value = cita?.resumen_cliente || '';
    if (msg) msg.textContent = '';
    if (generar) generar.disabled = true;

    actualizarBotonGrabar(false);

    // Modo escucha (grabar la clase). Bindeo único + estado inicial limpio y
    // lista de escuchas de esta cita (con botones de borrador/regenerar si
    // corresponde). El dictado paso a paso arranca replegado.
    bindEscuchaClase();
    escuchaAviso('', false);
    actualizarBotonEscucha(false);
    const borrador = document.getElementById('rc-borrador');
    if (borrador) borrador.hidden = true;
    const regenerar = document.getElementById('rc-regenerar');
    if (regenerar) regenerar.hidden = true;
    const dictPanel = document.getElementById('rc-dictado-panel');
    if (dictPanel) dictPanel.hidden = true;
    const dictToggle = document.getElementById('rc-dictado-toggle');
    if (dictToggle) dictToggle.setAttribute('aria-expanded', 'false');
    refrescarEscuchas();
}

// Bindeo único de los tres botones + el input del crudo. Idempotente.
function bindResumenClase() {
    if (window.__resumenClaseBound) return;

    const grabarBtn = document.getElementById('rc-grabar');
    const generarBtn = document.getElementById('rc-generar');
    const guardarBtn = document.getElementById('rc-guardar');
    const crudo = document.getElementById('rc-crudo');

    // Web Speech API — si no existe, ocultamos el botón y el indicador y
    // dejamos que Charly tipee el crudo a mano.
    const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRec) {
        if (grabarBtn) grabarBtn.hidden = true;
        const ind = document.getElementById('rc-indicador');
        if (ind) ind.hidden = true;
    } else if (grabarBtn) {
        grabarBtn.addEventListener('click', () => {
            if (resumenClaseCtx.grabando) detenerGrabacion();
            else iniciarGrabacion(SpeechRec);
        });
    }

    // El botón Generar se habilita solo cuando hay crudo.
    if (crudo) {
        crudo.addEventListener('input', () => {
            if (generarBtn) generarBtn.disabled = !crudo.value.trim();
        });
    }

    if (generarBtn) generarBtn.addEventListener('click', generarResumenClase);
    if (guardarBtn) guardarBtn.addEventListener('click', guardarResumenClase);

    // Dictado paso a paso: enlace discreto que despliega/repliega el panel
    // fallback (la lógica del dictado sigue intacta como paracaídas).
    const dictToggle = document.getElementById('rc-dictado-toggle');
    const dictPanel = document.getElementById('rc-dictado-panel');
    if (dictToggle && dictPanel) {
        dictToggle.addEventListener('click', () => {
            const abrir = dictPanel.hidden;
            dictPanel.hidden = !abrir;
            dictToggle.setAttribute('aria-expanded', abrir ? 'true' : 'false');
        });
    }

    window.__resumenClaseBound = true;
}

function actualizarBotonGrabar(grabando) {
    const grabarBtn = document.getElementById('rc-grabar');
    const ind = document.getElementById('rc-indicador');
    if (grabarBtn && !grabarBtn.hidden) grabarBtn.textContent = grabando ? 'Detener' : '🎙 Grabar';
    if (ind) ind.hidden = !grabando;
}

function construirRec(SpeechRec){
  const rec = new SpeechRec();
  rec.lang = 'es-AR';
  rec.continuous = false;      // CLAVE: una sola pasada, SIN auto-restart
  rec.interimResults = true;

  rec.onresult = (e)=>{
    // reconstruir SOLO esta sesión desde 0; textoBase es snapshot fijo
    let txt = '';
    for(let i=0; i<e.results.length; i++) txt += e.results[i][0].transcript;
    const crudo = document.getElementById('rc-crudo');
    if(!crudo) return;
    const base = resumenClaseCtx.textoBase;
    crudo.value = (base ? base + ' ' + txt : txt).replace(/\s+/g,' ').trimStart();
    const g = document.getElementById('rc-generar');
    if(g) g.disabled = !crudo.value.trim();
  };

  rec.onerror = ()=>{};  // onend limpia igual

  rec.onend = ()=>{
    // consolidar lo dictado como nueva base. SIN reiniciar.
    const crudo = document.getElementById('rc-crudo');
    if(crudo) resumenClaseCtx.textoBase = crudo.value.trim();
    resumenClaseCtx.grabando = false;
    resumenClaseCtx.rec = null;
    actualizarBotonGrabar(false);
  };

  return rec;
}

function iniciarGrabacion(SpeechRec){
  if(resumenClaseCtx.grabando || resumenClaseCtx.rec) return;  // SEGURO: una sola instancia
  const crudo = document.getElementById('rc-crudo');
  if(!crudo) return;
  resumenClaseCtx.textoBase = crudo.value.trim();   // snapshot fijo de lo ya escrito
  const rec = construirRec(SpeechRec);
  resumenClaseCtx.rec = rec;
  resumenClaseCtx.grabando = true;
  actualizarBotonGrabar(true);
  try{ rec.start(); }
  catch(_){ resumenClaseCtx.grabando=false; resumenClaseCtx.rec=null; actualizarBotonGrabar(false); }
}

function detenerGrabacion(){
  const rec = resumenClaseCtx.rec;
  if(rec){ try{ rec.stop(); }catch(_){} }  // dispara onend que consolida
  else { resumenClaseCtx.grabando=false; actualizarBotonGrabar(false); }
}

// Confirmación efímera en un botón: muestra "… ✓" 2s (deshabilitado) y luego
// restaura la etiqueta y lo rehabilita. Anti-doble-toque + feedback de éxito.
function botonOk(btn, labelOk, labelDefault) {
    if (!btn) return;
    btn.disabled = true;
    btn.textContent = labelOk;
    setTimeout(() => { if (btn) { btn.textContent = labelDefault; btn.disabled = false; } }, 2000);
}

async function generarResumenClase() {
    const crudoEl = document.getElementById('rc-crudo');
    const resumenEl = document.getElementById('rc-resumen');
    const generarBtn = document.getElementById('rc-generar');
    const msg = document.getElementById('rc-msg');
    const textoCrudo = (crudoEl?.value || '').trim();
    if (!textoCrudo) { if (msg) msg.textContent = 'Dictá o escribí algo primero.'; return; }

    const cita = resumenClaseCtx.cita;
    const numeroClase = parseIntOrNull(document.getElementById('ce-numero-clase')?.value);
    const modalidad = document.getElementById('ce-modalidad')?.value || undefined;
    const nombrePerro = cita?.clientes?.perros?.[0]?.nombre || undefined;

    if (generarBtn) { generarBtn.disabled = true; generarBtn.textContent = 'Generando…'; }
    if (msg) msg.textContent = '';
    try {
        const { data, error } = await supabase.functions.invoke('resumir-clase', {
            body: { textoCrudo, contexto: { numeroClase, modalidad, nombrePerro } },
        });
        let res = data;
        if (error?.context && typeof error.context.json === 'function') {
            res = await error.context.json().catch(() => null);
        }
        if (res?.resumen) {
            if (resumenEl) resumenEl.value = res.resumen;
            if (msg) msg.textContent = 'Resumen generado. Revisalo y guardá.';
            botonOk(generarBtn, 'Generado ✓', 'Generar resumen');
        } else {
            if (msg) msg.textContent = res?.error || error?.message || 'No se pudo generar el resumen.';
            if (generarBtn) { generarBtn.textContent = 'Generar resumen'; generarBtn.disabled = !(crudoEl?.value || '').trim(); }
        }
    } catch (err) {
        console.error('Error generarResumenClase:', err);
        if (msg) msg.textContent = 'No se pudo generar el resumen.';
        if (generarBtn) { generarBtn.textContent = 'Generar resumen'; generarBtn.disabled = !(crudoEl?.value || '').trim(); }
    }
}

async function guardarResumenClase() {
    const cita = resumenClaseCtx.cita;
    const resumenEl = document.getElementById('rc-resumen');
    const guardarBtn = document.getElementById('rc-guardar');
    const msg = document.getElementById('rc-msg');
    if (!cita?.id) { if (msg) msg.textContent = 'No hay cita seleccionada.'; return; }

    const texto = (resumenEl?.value || '').trim();
    const ahora = new Date().toISOString();

    if (guardarBtn) { guardarBtn.disabled = true; guardarBtn.textContent = 'Guardando…'; }
    if (msg) msg.textContent = '';
    try {
        const { error } = await supabase
            .from('citas')
            .update({ resumen_cliente: texto || null, resumen_creado_en: texto ? ahora : null })
            .eq('id', cita.id);
        if (error) throw error;
        // Reflejamos en memoria para que al reabrir el modal precargue.
        cita.resumen_cliente = texto || null;
        cita.resumen_creado_en = texto ? ahora : null;
        if (msg) msg.textContent = '';
        botonOk(guardarBtn, 'Guardado ✓', 'Guardar resumen');
    } catch (err) {
        console.error('Error guardarResumenClase:', err);
        if (msg) msg.textContent = err?.message || 'No se pudo guardar el resumen.';
        if (guardarBtn) { guardarBtn.disabled = false; guardarBtn.textContent = 'Guardar resumen'; }
    }
}

// Limpieza al cerrar el modal: corta la grabación y vacía los campos.
function resetResumenClase() {
    detenerGrabacion();
    // Si había una escucha grabando, la cortamos: detenerEscucha dispara la
    // subida (la escucha se captura con su cita_id propio, así no se pierde
    // aunque se cierre el modal). Si no, liberamos recursos igual.
    if (escuchaCtx.grabando) detenerEscucha();
    else { liberarWakeLock(); if (escuchaCtx.timer) { clearInterval(escuchaCtx.timer); escuchaCtx.timer = null; } }
    resumenClaseCtx.cita = null;
    resumenClaseCtx.textoBase = '';
    resumenClaseCtx.rec = null;
    const crudo = document.getElementById('rc-crudo');
    const resumen = document.getElementById('rc-resumen');
    const msg = document.getElementById('rc-msg');
    const generar = document.getElementById('rc-generar');
    if (crudo) crudo.value = '';
    if (resumen) resumen.value = '';
    if (msg) msg.textContent = '';
    if (generar) generar.disabled = true;
    const lista = document.getElementById('rc-escucha-lista');
    if (lista) lista.innerHTML = '';
    escuchaAviso('', false);
    actualizarBotonEscucha(false);
    const borrador = document.getElementById('rc-borrador');
    if (borrador) borrador.hidden = true;
}

/* ═══════════════════════════════════════════
   JAIME ESCUCHA LA CLASE (Fase 1)
   Graba con MediaRecorder mientras el adiestrador explica → sube el audio al
   bucket privado escuchas-clase → inserta fila en escuchas_clase → invoca
   transcribir-escucha (fire-and-forget). Luego "Generar borrador con las
   escuchas" llama a resumir-clase en modo desdeEscuchas y llena el resumen.
   ═══════════════════════════════════════════ */

const ESCUCHA_BUCKET = 'escuchas-clase';
const ESCUCHA_AVISO_MIN_SEG = 600;  // límite blando: avisar a los 10 min

// citaId/clienteId se capturan al empezar a grabar, para que la subida no
// dependa de que el modal siga abierto (no perder un audio ya grabado).
const escuchaCtx = { rec: null, chunks: [], grabando: false, wakeLock: null, t0: 0, timer: null, avisado: false, mime: '', citaId: null, clienteId: null };

function bindEscuchaClase() {
    if (window.__escuchaClaseBound) return;
    const toggle = document.getElementById('rc-escucha-toggle');
    const borrador = document.getElementById('rc-borrador');
    const lista = document.getElementById('rc-escucha-lista');
    if (toggle) toggle.addEventListener('click', () => {
        if (escuchaCtx.grabando) detenerEscucha();
        else iniciarEscucha();
    });
    if (borrador) borrador.addEventListener('click', generarBorradorEscuchas);
    const regenerar = document.getElementById('rc-regenerar');
    if (regenerar) regenerar.addEventListener('click', regenerarTodoEscuchas);
    // Reintentar transcripción (delegado sobre la lista).
    if (lista) lista.addEventListener('click', (ev) => {
        const btn = ev.target.closest('.rc-escucha-reintentar');
        if (!btn) return;
        const id = btn.dataset.id;
        if (!id) return;
        btn.disabled = true;
        btn.textContent = 'Reintentando…';
        supabase.functions.invoke('transcribir-escucha', { body: { escucha_id: id } })
            .then(() => refrescarEscuchas())
            .catch(() => refrescarEscuchas());
    });
    window.__escuchaClaseBound = true;
}

function fmtMMSS(seg) {
    const s = Math.max(0, Math.floor(seg));
    return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
}

function escuchaAviso(txt, esError) {
    const el = document.getElementById('rc-escucha-aviso');
    if (!el) return;
    el.textContent = txt || '';
    el.hidden = !txt;
    el.classList.toggle('rc-escucha-aviso--error', !!esError);
}

function actualizarBotonEscucha(grabando) {
    const btn = document.getElementById('rc-escucha-toggle');
    if (btn) {
        btn.textContent = grabando ? '⏹ Cortar' : '🎙 Jaime, escucha';
        btn.classList.toggle('rc-escucha-on', grabando);
    }
    const t = document.getElementById('rc-escucha-timer');
    if (t && !grabando) t.hidden = true;
}

function pickMimeEscucha() {
    if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') return '';
    for (const c of ['audio/webm;codecs=opus', 'audio/webm']) {
        try { if (MediaRecorder.isTypeSupported(c)) return c; } catch (_e) { /* noop */ }
    }
    return '';
}

function liberarWakeLock() {
    if (escuchaCtx.wakeLock) {
        try { escuchaCtx.wakeLock.release(); } catch (_e) { /* noop */ }
        escuchaCtx.wakeLock = null;
    }
}

async function iniciarEscucha() {
    if (escuchaCtx.grabando) return;
    const cita = resumenClaseCtx.cita;
    if (!cita?.id) { escuchaAviso('Abrí una cita antes de grabar.', true); return; }
    if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
        escuchaAviso('Este navegador no permite grabar audio. Usá el dictado de abajo.', true);
        return;
    }
    let stream;
    try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    } catch (e) {
        escuchaAviso('No pudimos acceder al micrófono. Revisá los permisos del navegador y probá de nuevo.', true);
        return;
    }
    const mime = pickMimeEscucha();
    let rec;
    try {
        rec = mime
            ? new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 32000 })
            : new MediaRecorder(stream, { audioBitsPerSecond: 32000 });
    } catch (_e) {
        try { rec = new MediaRecorder(stream); } catch (_e2) {
            stream.getTracks().forEach((t) => t.stop());
            escuchaAviso('No se pudo iniciar la grabación en este navegador.', true);
            return;
        }
    }
    escuchaCtx.rec = rec;
    escuchaCtx.chunks = [];
    escuchaCtx.mime = rec.mimeType || mime || 'audio/webm';
    escuchaCtx.grabando = true;
    escuchaCtx.avisado = false;
    escuchaCtx.t0 = Date.now();
    escuchaCtx.citaId = cita.id;
    escuchaCtx.clienteId = cita.cliente_id || null;

    rec.ondataavailable = (ev) => { if (ev.data && ev.data.size) escuchaCtx.chunks.push(ev.data); };
    rec.onstop = () => { try { stream.getTracks().forEach((t) => t.stop()); } catch (_e) {} onStopEscucha(); };

    try { rec.start(); } catch (_e) {
        escuchaCtx.grabando = false;
        stream.getTracks().forEach((t) => t.stop());
        escuchaAviso('No se pudo iniciar la grabación.', true);
        return;
    }

    // WakeLock para que la pantalla no duerma la grabación (best-effort).
    try { if (navigator.wakeLock?.request) escuchaCtx.wakeLock = await navigator.wakeLock.request('screen'); } catch (_e) { /* noop */ }
    try { jaimeEscuchando(true); } catch (_e) { /* noop */ }
    actualizarBotonEscucha(true);
    escuchaAviso('', false);
    escuchaCtx.timer = setInterval(tickEscucha, 1000);
    tickEscucha();
}

function tickEscucha() {
    const seg = Math.floor((Date.now() - escuchaCtx.t0) / 1000);
    const t = document.getElementById('rc-escucha-timer');
    if (t) { t.hidden = false; t.textContent = fmtMMSS(seg); }
    if (seg >= ESCUCHA_AVISO_MIN_SEG && !escuchaCtx.avisado) {
        escuchaCtx.avisado = true;
        escuchaAviso('Llevás 10 minutos grabando. Cuando termines de explicar, tocá Cortar.', false);
    }
}

function detenerEscucha() {
    const rec = escuchaCtx.rec;
    escuchaCtx.grabando = false;
    if (escuchaCtx.timer) { clearInterval(escuchaCtx.timer); escuchaCtx.timer = null; }
    liberarWakeLock();
    try { jaimeEscuchando(false); } catch (_e) { /* noop */ }
    actualizarBotonEscucha(false);
    if (rec && rec.state !== 'inactive') { try { rec.stop(); } catch (_e) { /* noop */ } }  // dispara onstop → onStopEscucha
    else { escuchaCtx.rec = null; }
}

// Se dispara al parar el MediaRecorder: arma el blob, lo SUBE (antes de
// insertar, para no perder el audio), inserta la fila y lanza la transcripción.
async function onStopEscucha() {
    const chunks = escuchaCtx.chunks;
    escuchaCtx.chunks = [];
    escuchaCtx.rec = null;
    const citaId = escuchaCtx.citaId;
    const clienteId = escuchaCtx.clienteId;
    const dur = Math.max(1, Math.round((Date.now() - escuchaCtx.t0) / 1000));
    if (!chunks.length) { escuchaAviso('No se grabó audio. Probá de nuevo.', true); return; }
    if (!citaId) { escuchaAviso('No se pudo asociar la escucha a una cita.', true); return; }

    const blob = new Blob(chunks, { type: escuchaCtx.mime || 'audio/webm' });
    const path = `${citaId}/${Date.now()}.webm`;

    escuchaAviso('Subiendo la escucha…', false);
    // 1) SUBIR primero. Si falla, el audio no llegó a la nube: avisamos claro.
    const { error: upErr } = await supabase.storage.from(ESCUCHA_BUCKET)
        .upload(path, blob, { contentType: 'audio/webm', upsert: false });
    if (upErr) {
        console.error('[escucha] error subiendo audio:', upErr);
        escuchaAviso('No se pudo subir la escucha. Volvé a intentarlo (el audio no se guardó).', true);
        return;
    }

    // 2) INSERT de la fila (con un reintento). Si el audio subió pero el insert
    //    falla, damos la ruta para que no se pierda.
    const payload = { cita_id: citaId, cliente_id: clienteId, audio_path: path, duracion_seg: dur, estado: 'grabada' };
    let ins = await supabase.from('escuchas_clase').insert(payload).select('id').single();
    if (ins.error) ins = await supabase.from('escuchas_clase').insert(payload).select('id').single();
    if (ins.error) {
        console.error('[escucha] error insertando fila:', ins.error);
        escuchaAviso('El audio se subió pero no se registró. Guardá esta ruta para recuperarlo: ' + path, true);
        return;
    }

    const escuchaId = ins.data.id;
    escuchaAviso('Escucha subida. Jaime la está transcribiendo…', false);
    refrescarEscuchas();

    // 3) Transcribir sin bloquear la UI; refrescamos el estado al terminar.
    supabase.functions.invoke('transcribir-escucha', { body: { escucha_id: escuchaId } })
        .then(({ data, error }) => {
            const res = data;
            if (error || (res && res.ok === false)) {
                console.warn('[escucha] transcripción con error:', error || res?.error);
            }
            refrescarEscuchas();
        })
        .catch((e) => { console.warn('[escucha] fallo invocando transcripción:', e); refrescarEscuchas(); });
}

// Estado visible de cada escucha: clase CSS + etiqueta. Distingue transcritas
// pendientes (verde) de las ya incorporadas al resumen (gris).
function infoEstadoEscucha(f) {
    if (f.estado === 'error') return { clase: 'rc-escucha-estado--error', txt: '⚠ Error' };
    if (f.estado === 'transcrita') {
        return f.incorporada
            ? { clase: 'rc-escucha-estado--incorporada', txt: '✓ Incorporada' }
            : { clase: 'rc-escucha-estado--transcrita', txt: '✓ Transcrita' };
    }
    return { clase: 'rc-escucha-estado--grabada', txt: '⏳ Procesando' };
}

async function refrescarEscuchas() {
    const lista = document.getElementById('rc-escucha-lista');
    const borrador = document.getElementById('rc-borrador');
    const regenerar = document.getElementById('rc-regenerar');
    const cita = resumenClaseCtx.cita;
    if (!lista) return;
    if (!cita?.id) {
        lista.innerHTML = '';
        if (borrador) borrador.hidden = true;
        if (regenerar) regenerar.hidden = true;
        return;
    }
    const { data, error } = await supabase.from('escuchas_clase')
        .select('id, estado, duracion_seg, incorporada, creado_en')
        .eq('cita_id', cita.id)
        .order('creado_en', { ascending: true });
    if (error) { console.warn('[escucha] no se pudo leer la lista:', error); return; }
    const filas = data || [];
    if (!filas.length) {
        lista.innerHTML = '<li class="rc-escucha-vacia">Todavía no hay escuchas de esta clase.</li>';
    } else {
        lista.innerHTML = filas.map((f, i) => {
            const dur = f.duracion_seg != null ? fmtMMSS(f.duracion_seg) : '—';
            const est = infoEstadoEscucha(f);
            const reint = f.estado === 'error'
                ? `<button type="button" class="rc-escucha-reintentar btn-secondary" data-id="${f.id}">Reintentar</button>`
                : '';
            return `<li class="rc-escucha-item"><span class="rc-escucha-n">Escucha ${i + 1}</span><span class="rc-escucha-dur">${dur}</span><span class="rc-escucha-estado ${est.clase}">${est.txt}</span>${reint}</li>`;
        }).join('');
    }
    // Borrador: solo si hay transcritas NUEVAS (no incorporadas). Regenerar
    // todo: si hay al menos una transcrita (la red de seguridad).
    const pendientes = filas.some((f) => f.estado === 'transcrita' && !f.incorporada);
    const hayTranscritas = filas.some((f) => f.estado === 'transcrita');
    if (borrador) borrador.hidden = !pendientes;
    if (regenerar) regenerar.hidden = !hayTranscritas;
}

// Contexto de la cita para resumir-clase (nº de clase, modalidad, perro).
function contextoResumen(cita) {
    return {
        numeroClase: parseIntOrNull(document.getElementById('ce-numero-clase')?.value),
        modalidad: document.getElementById('ce-modalidad')?.value || undefined,
        nombrePerro: cita?.clientes?.perros?.[0]?.nombre || undefined,
    };
}

// Marca como incorporadas las escuchas que alimentaron el borrador, para que
// la próxima ronda solo sume las nuevas.
async function marcarIncorporadas(ids) {
    if (!Array.isArray(ids) || !ids.length) return;
    const { error } = await supabase.from('escuchas_clase').update({ incorporada: true }).in('id', ids);
    if (error) console.warn('[escucha] no se pudieron marcar incorporadas:', error);
}

// Generación INCREMENTAL: toma el resumen actual + las escuchas nuevas (no
// incorporadas) y devuelve el resumen completo actualizado. Primera ronda
// (resumen vacío) = comportamiento normal.
async function generarBorradorEscuchas() {
    const cita = resumenClaseCtx.cita;
    const resumenEl = document.getElementById('rc-resumen');
    const borrador = document.getElementById('rc-borrador');
    const msg = document.getElementById('rc-msg');
    if (!cita?.id) return;
    const resumenActual = (resumenEl?.value || '').trim();

    if (borrador) { borrador.disabled = true; borrador.textContent = 'Generando borrador…'; }
    if (msg) msg.textContent = '';
    try {
        const { data, error } = await supabase.functions.invoke('resumir-clase', {
            body: { cita_id: cita.id, desdeEscuchas: true, resumenActual, contexto: contextoResumen(cita) },
        });
        let res = data;
        if (error?.context && typeof error.context.json === 'function') {
            res = await error.context.json().catch(() => null);
        }
        if (res?.resumen) {
            if (resumenEl) resumenEl.value = res.resumen;
            await marcarIncorporadas(res.escuchas_usadas);
            if (msg) msg.textContent = 'Borrador actualizado con las escuchas nuevas. Revisalo y guardá.';
            botonOk(borrador, 'Generado ✓', 'Generar borrador con las escuchas');
            await refrescarEscuchas();
        } else {
            if (msg) msg.textContent = res?.error || error?.message || 'No se pudo generar el borrador.';
            if (borrador) { borrador.disabled = false; borrador.textContent = 'Generar borrador con las escuchas'; }
        }
    } catch (err) {
        console.error('Error generarBorradorEscuchas:', err);
        if (msg) msg.textContent = 'No se pudo generar el borrador.';
        if (borrador) { borrador.disabled = false; borrador.textContent = 'Generar borrador con las escuchas'; }
    }
}

// Red de seguridad: reconstruye el resumen desde cero con TODAS las
// transcripciones, pisando el texto actual (con confirmación).
async function regenerarTodoEscuchas() {
    const cita = resumenClaseCtx.cita;
    const resumenEl = document.getElementById('rc-resumen');
    const btn = document.getElementById('rc-regenerar');
    const msg = document.getElementById('rc-msg');
    if (!cita?.id) return;
    if (!window.confirm('Esto reescribe el resumen desde cero con TODAS las escuchas y pisa el texto actual. ¿Seguir?')) return;

    if (btn) { btn.disabled = true; btn.textContent = 'Regenerando…'; }
    if (msg) msg.textContent = '';
    try {
        const { data, error } = await supabase.functions.invoke('resumir-clase', {
            body: { cita_id: cita.id, desdeEscuchas: true, regenerarTodo: true, contexto: contextoResumen(cita) },
        });
        let res = data;
        if (error?.context && typeof error.context.json === 'function') {
            res = await error.context.json().catch(() => null);
        }
        if (res?.resumen) {
            if (resumenEl) resumenEl.value = res.resumen;
            await marcarIncorporadas(res.escuchas_usadas);
            if (msg) msg.textContent = 'Resumen regenerado con todas las escuchas. Revisalo y guardá.';
            botonOk(btn, 'Regenerado ✓', 'Regenerar todo');
            await refrescarEscuchas();
        } else {
            if (msg) msg.textContent = res?.error || error?.message || 'No se pudo regenerar el resumen.';
            if (btn) { btn.disabled = false; btn.textContent = 'Regenerar todo'; }
        }
    } catch (err) {
        console.error('Error regenerarTodoEscuchas:', err);
        if (msg) msg.textContent = 'No se pudo regenerar el resumen.';
        if (btn) { btn.disabled = false; btn.textContent = 'Regenerar todo'; }
    }
}

/* ═══════════════════════════════════════════
   STATS — Bloque 4
   ═══════════════════════════════════════════ */

const statsState = {
    periodo: 'mes',
    mesOffset: 0,  // 0 = mes actual, -1 = mes anterior, etc. Solo aplica cuando periodo==='mes'.
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
        const offset = statsState.mesOffset || 0;
        const base = new Date(hoy.getFullYear(), hoy.getMonth() + offset, 1);
        const desde = new Date(base.getFullYear(), base.getMonth(), 1);
        // Si es el mes actual, hasta hoy. Si es un mes pasado, hasta el último día del mes.
        const ultimoDiaMes = new Date(base.getFullYear(), base.getMonth() + 1, 0);
        const hasta = offset === 0 ? hoy : ultimoDiaMes;
        return { desde: formatearFechaLocal(desde), hasta: formatearFechaLocal(hasta) };
    }
    if (periodo === 'ano') {
        const desde = new Date(hoy.getFullYear(), 0, 1);
        return { desde: formatearFechaLocal(desde), hasta: hoyStr };
    }
    return null;
}

function formatearLabelMes(offset) {
    const hoy = new Date();
    const base = new Date(hoy.getFullYear(), hoy.getMonth() + offset, 1);
    const meses = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
                   'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
    return `${meses[base.getMonth()]} ${base.getFullYear()}`;
}

function actualizarLabelMes() {
    const labelEl = document.getElementById('stats-mes-label');
    if (labelEl) labelEl.textContent = formatearLabelMes(statsState.mesOffset || 0);
    // Deshabilitar "siguiente" si estamos en el mes actual: no se puede ir al futuro.
    const nextBtn = document.getElementById('stats-mes-next');
    if (nextBtn) nextBtn.disabled = (statsState.mesOffset || 0) >= 0;
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
    actualizarLabelMes();
    cargarTodoStats();
}

function bindStatsPeriodos() {
    document.querySelectorAll('.stats-periodo-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.stats-periodo-btn').forEach((b) => b.classList.remove('active'));
            btn.classList.add('active');
            const nuevoPeriodo = btn.dataset.periodo;
            // Al volver a 'mes' desde otro período, resetear al mes actual.
            if (nuevoPeriodo === 'mes' && statsState.periodo !== 'mes') {
                statsState.mesOffset = 0;
                actualizarLabelMes();
            }
            statsState.periodo = nuevoPeriodo;
            cargarTodoStats();
        });
    });

    // Flechas de navegación mensual
    const prevBtn = document.getElementById('stats-mes-prev');
    const nextBtn = document.getElementById('stats-mes-next');
    if (prevBtn) {
        prevBtn.addEventListener('click', () => {
            // Si no estamos en período 'mes', cambiar primero y marcar la pill como activa.
            if (statsState.periodo !== 'mes') {
                statsState.periodo = 'mes';
                document.querySelectorAll('.stats-periodo-btn').forEach((b) => b.classList.remove('active'));
                document.getElementById('stats-mes-label')?.classList.add('active');
            }
            statsState.mesOffset = (statsState.mesOffset || 0) - 1;
            actualizarLabelMes();
            cargarTodoStats();
        });
    }
    if (nextBtn) {
        nextBtn.addEventListener('click', () => {
            const offset = statsState.mesOffset || 0;
            if (offset >= 0) return;  // no ir al futuro
            statsState.mesOffset = offset + 1;
            actualizarLabelMes();
            cargarTodoStats();
        });
    }
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
        cargarLlamadasStats(rango),
        cargarVickyStats(rango),
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

async function cargarLlamadasStats(rango) {
    try {
        const data = await stats.obtenerLlamadasReservadas(rango);
        document.getElementById('kpi-llamadas').textContent = String(data.total);
        document.getElementById('llamada-pendiente').textContent = String(data.por_estado.pendiente);
        document.getElementById('llamada-realizada').textContent = String(data.por_estado.realizada);
        document.getElementById('llamada-cancelada').textContent = String(data.por_estado.cancelada);
        document.getElementById('llamada-no-show').textContent = String(data.por_estado.no_show);
    } catch (err) { console.error('Llamadas:', err); }
}

async function cargarVickyStats(rango) {
    try {
        const v = await stats.obtenerStatsVicky(rango);
        document.getElementById('vicky-generados').textContent  = String(v.links_generados);
        document.getElementById('vicky-abiertos').textContent   = String(v.links_abiertos);
        document.getElementById('vicky-citas').textContent      = String(v.citas_confirmadas);
        document.getElementById('vicky-expirados').textContent  = String(v.links_expirados);
        // conversion_pct ya viene formateado: '12.5%' o '—'
        document.getElementById('vicky-conversion').textContent = v.conversion_pct;
    } catch (err) { console.error('Vicky:', err); }
}

/* ═══════════════════════════════════════════
   CATÁLOGO — Bloque 5 (solo lectura)
   ═══════════════════════════════════════════ */

function bindCatalogoActions() {
    const grupos = document.getElementById('catalogo-grupos');
    if (grupos) {
        grupos.addEventListener('click', (e) => {
            // "+ Nuevo": abre modal de creación con categoría preseleccionada.
            const btnNuevo = e.target.closest('[data-nuevo-ejercicio]');
            if (btnNuevo) {
                abrirModalCrearEjercicio(btnNuevo.dataset.categoria || 'ejercicio');
                return;
            }
            // Click en card → modal de edición.
            const card = e.target.closest('.catalogo-card');
            if (!card) return;
            const ej = state.catalogoEjercicios.find((x) => x.id === card.dataset.ejercicioId);
            if (ej) abrirModalEditarEjercicio(ej);
        });
    }
    // El bind global de [data-modal-close] vive en bindAgendaModals(),
    // que solo corre si se abrió la pestaña Agenda. Lo garantizamos acá
    // para los modales del catálogo.
    document.querySelectorAll('#modal-editar-ejercicio [data-modal-close]')
        .forEach((el) => el.addEventListener('click', () => closeModal('modal-editar-ejercicio')));
    document.querySelectorAll('#modal-crear-ejercicio [data-modal-close]')
        .forEach((el) => el.addEventListener('click', () => closeModal('modal-crear-ejercicio')));

    const btnGuardar = document.getElementById('ee-guardar');
    if (btnGuardar) btnGuardar.addEventListener('click', guardarEdicionEjercicio);

    const btnCrear = document.getElementById('nc-guardar');
    if (btnCrear) btnCrear.addEventListener('click', guardarNuevoEjercicio);

    // Autocompletar código a partir del nombre, solo si el código está vacío.
    const ncNombre = document.getElementById('nc-nombre');
    if (ncNombre) {
        ncNombre.addEventListener('blur', () => {
            const codigoEl = document.getElementById('nc-codigo');
            if (!codigoEl) return;
            if (codigoEl.value.trim() !== '') return;
            const slug = slugCodigoDesdeNombre(ncNombre.value);
            if (slug) codigoEl.value = slug;
        });
    }
}

// Normaliza un nombre humano a un código tipo PERM_FORMAL.
// NFD → quita combining marks (U+0300–U+036F), separadores → "_",
// solo [A-Z0-9_], max 32 chars. Sin underscores al inicio/fin.
function slugCodigoDesdeNombre(nombre) {
    if (!nombre) return '';
    return nombre
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 32);
}

function abrirModalEditarEjercicio(ej) {
    document.getElementById('ee-nombre').value = ej.nombre || '';
    document.getElementById('ee-categoria').value = ej.categoria || 'ejercicio';
    document.getElementById('ee-descripcion').value = ej.descripcion || '';
    document.getElementById('ee-como-se-hace').value = ej.como_se_hace || '';
    document.getElementById('ee-instrucciones').value = ej.instrucciones || '';
    document.getElementById('ee-video').value = ej.video_url || '';
    const err = document.getElementById('ee-error');
    if (err) err.hidden = true;
    document.getElementById('modal-editar-ejercicio').dataset.ejercicioId = ej.id;
    openModal('modal-editar-ejercicio');
}

async function guardarEdicionEjercicio() {
    const modal = document.getElementById('modal-editar-ejercicio');
    const id = modal.dataset.ejercicioId;
    const err = document.getElementById('ee-error');
    const nombre = document.getElementById('ee-nombre').value.trim();
    const categoria = document.getElementById('ee-categoria').value;
    const descripcion = document.getElementById('ee-descripcion').value.trim();
    const comoSeHace = document.getElementById('ee-como-se-hace').value.trim();
    const instrucciones = document.getElementById('ee-instrucciones').value.trim();
    const videoUrl = document.getElementById('ee-video').value.trim();
    if (!nombre) {
        if (err) { err.textContent = 'El nombre no puede quedar vacío.'; err.hidden = false; }
        return;
    }
    const btn = document.getElementById('ee-guardar');
    btn.disabled = true;
    try {
        await catalogo.actualizarEjercicio(id, {
            nombre,
            categoria,
            descripcion: descripcion || null,
            como_se_hace: comoSeHace || null,
            instrucciones: instrucciones || null,
            video_url: videoUrl || null,
        });
        closeModal('modal-editar-ejercicio');
        await cargarCatalogoAdmin();
    } catch (e) {
        console.error('[admin/catalogo] error al guardar:', e);
        if (err) { err.textContent = 'No se pudo guardar. Inténtalo de nuevo.'; err.hidden = false; }
    } finally {
        btn.disabled = false;
    }
}

function abrirModalCrearEjercicio(categoria) {
    document.getElementById('nc-nombre').value = '';
    document.getElementById('nc-codigo').value = '';
    document.getElementById('nc-plantilla').value = '';
    document.getElementById('nc-descripcion').value = '';
    document.getElementById('nc-como-se-hace').value = '';
    document.getElementById('nc-instrucciones').value = '';
    document.getElementById('nc-video').value = '';
    const sel = document.getElementById('nc-categoria');
    if (sel) sel.value = categoria || 'ejercicio';
    const err = document.getElementById('nc-error');
    if (err) { err.textContent = ''; err.hidden = true; }
    openModal('modal-crear-ejercicio');
}

async function guardarNuevoEjercicio() {
    const err = document.getElementById('nc-error');
    const showErr = (msg) => { if (err) { err.textContent = msg; err.hidden = false; } };

    const nombre = document.getElementById('nc-nombre').value.trim();
    let codigo = document.getElementById('nc-codigo').value.trim();
    const plantillaRaw = document.getElementById('nc-plantilla').value;
    const categoria = document.getElementById('nc-categoria').value;
    const descripcion = document.getElementById('nc-descripcion').value.trim();
    const comoSeHace = document.getElementById('nc-como-se-hace').value.trim();
    const instrucciones = document.getElementById('nc-instrucciones').value.trim();
    const videoUrl = document.getElementById('nc-video').value.trim();

    if (!nombre) { showErr('El nombre es obligatorio.'); return; }
    if (!plantillaRaw) { showErr('Elige una plantilla.'); return; }
    if (!codigo) {
        // Por si el usuario nunca disparó el blur sobre nc-nombre.
        codigo = slugCodigoDesdeNombre(nombre);
        if (codigo) document.getElementById('nc-codigo').value = codigo;
    }
    if (!codigo) { showErr('No se pudo generar el código desde el nombre. Escribe uno.'); return; }

    const btn = document.getElementById('nc-guardar');
    btn.disabled = true;
    try {
        await catalogo.crearEjercicio({
            codigo,
            nombre,
            plantilla: parseInt(plantillaRaw, 10),
            categoria,
            descripcion: descripcion || null,
            como_se_hace: comoSeHace || null,
            instrucciones: instrucciones || null,
            video_url: videoUrl || null,
        });
        closeModal('modal-crear-ejercicio');
        await cargarCatalogoAdmin();
    } catch (e) {
        console.error('[admin/catalogo] error al crear:', e);
        if (e?.code === 'codigo_duplicado') {
            showErr('Ya existe un ejercicio con ese código. Elige otro.');
        } else {
            showErr('No se pudo crear el ejercicio. Inténtalo de nuevo.');
        }
    } finally {
        btn.disabled = false;
    }
}

async function cargarCatalogoAdmin() {
    const grupos = document.getElementById('catalogo-grupos');
    const subtitle = document.getElementById('catalogo-subtitle');
    if (!grupos) return;
    grupos.innerHTML = '<p class="agenda-empty">Cargando catálogo…</p>';
    if (subtitle) subtitle.textContent = '';
    try {
        const ejercicios = await catalogo.obtenerCatalogo();
        state.catalogoEjercicios = ejercicios;
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
                        <span class="catalogo-grupo-titulo">${escapeHTML(label)}<span class="catalogo-grupo-count">(${items.length})</span></span>
                        <button type="button" class="btn-secondary catalogo-grupo-add" data-nuevo-ejercicio data-categoria="${escapeHTML(cat)}">+ Nuevo</button>
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
        <li class="catalogo-card catalogo-card--editable" data-ejercicio-id="${escapeHTML(ej.id)}">
            <div class="catalogo-card-row">
                <span class="catalogo-card-nombre">${nombre}</span>
                ${plantilla}
                <span class="catalogo-card-codigo">${codigo}</span>
            </div>
            ${desc}
        </li>
    `;
}

/* ═══════════════════════════════════════════
   ACTIVIDAD (subtab "Registros" de Seguimiento) — Registros de ejercicio
   reportados por clientes. Lee la vista actividad_registros_admin (RLS es_admin).
   El admin marca "visto" / comenta sobre registros_ejercicio (UPDATE).
   ═══════════════════════════════════════════ */

const actividadState = {
    registros: [],
    bound: false,
    comentarRegistroId: null,
    filtro: 'pendientes', // 'pendientes' (visto_por_admin=false) | 'todos'
};

// Fecha relativa: Hoy / Ayer / "12 Jun 2026" (reusa helpers de stats/agenda).
function fechaRelativaActividad(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
    const ayer = new Date(hoy); ayer.setDate(ayer.getDate() - 1);
    const dDia = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    if (dDia.getTime() === hoy.getTime()) return 'Hoy';
    if (dDia.getTime() === ayer.getTime()) return 'Ayer';
    return formatearFechaCorta(formatearFechaLocal(d));
}

function cargarActividad() {
    if (!actividadState.bound) {
        bindActividad();
        actividadState.bound = true;
    }
    cargarRegistrosActividad();
}

async function cargarRegistrosActividad() {
    const lista = document.getElementById('actividad-registros-lista');
    const empty = document.getElementById('actividad-registros-empty');
    if (!lista) return;
    lista.innerHTML = '';
    if (empty) { empty.hidden = false; empty.textContent = 'Cargando registros…'; }
    try {
        const { data, error } = await supabase
            .from('actividad_registros_admin')
            .select('registro_id, registrado_en, tranquilidad, nota, nota_cierre, visto_por_admin, comentario_admin, visto_en, cliente_nombre, perro_nombre, ejercicio_nombre, ejercicio_categoria, video_path')
            .order('registrado_en', { ascending: false })
            .limit(50);
        if (error) throw error;
        actividadState.registros = data || [];
        renderRegistrosActividad();
        renderBadgeActividad();
    } catch (err) {
        console.error('[actividad] error cargando registros:', err);
        if (empty) { empty.hidden = false; empty.textContent = 'Error al cargar los registros.'; }
    }
}

function renderRegistrosActividad() {
    const lista = document.getElementById('actividad-registros-lista');
    const empty = document.getElementById('actividad-registros-empty');
    if (!lista) return;
    const todos = actividadState.registros;
    const items = actividadState.filtro === 'pendientes'
        ? todos.filter((r) => !r.visto_por_admin)
        : todos;
    if (!items.length) {
        lista.innerHTML = '';
        if (empty) {
            empty.hidden = false;
            empty.textContent = actividadState.filtro === 'pendientes'
                ? 'Todo al día ✓ — no hay registros pendientes.'
                : 'Todavía no hay registros de entrenos.';
        }
        return;
    }
    if (empty) empty.hidden = true;
    lista.innerHTML = items.map(renderRegistroActividad).join('');
}

function renderRegistroActividad(r) {
    const fecha = fechaRelativaActividad(r.registrado_en);
    const tq = (r.tranquilidad != null) ? Number(r.tranquilidad) : null;
    const tqClass = (tq != null && tq <= 2) ? ' actividad-tq--alerta' : '';
    const tqHTML = (tq != null)
        ? `<span class="actividad-tq${tqClass}">${tq}/5</span>`
        : '';
    const nota = r.nota
        ? `<p class="actividad-nota">${escapeHTML(r.nota)}</p>`
        : '';
    const notaCierre = r.nota_cierre
        ? `<p class="actividad-nota actividad-nota--cierre"><strong>Cierre:</strong> ${escapeHTML(r.nota_cierre)}</p>`
        : '';
    const videoHTML = r.video_path
        ? `<div class="actividad-video-wrap">
                <button type="button" class="btn-secondary actividad-video-btn" data-action="ver-video" data-video-path="${escapeHTML(r.video_path)}">Ver video del entreno</button>
                <div class="actividad-video" hidden></div>
            </div>`
        : '';

    let pie;
    if (r.visto_por_admin) {
        const coment = r.comentario_admin
            ? `<div class="actividad-comentario"><strong>Tu comentario:</strong> ${escapeHTML(r.comentario_admin)}</div>`
            : '';
        pie = `<div class="actividad-visto">✓ Visto</div>${coment}`;
    } else {
        pie = `
            <div class="actividad-acciones">
                <button type="button" class="btn-secondary" data-action="visto" data-registro-id="${escapeHTML(r.registro_id)}">Visto ✓</button>
                <button type="button" class="btn-secondary" data-action="comentar" data-registro-id="${escapeHTML(r.registro_id)}">Comentar</button>
            </div>`;
    }

    return `
        <li class="actividad-item${r.visto_por_admin ? '' : ' actividad-item--nuevo'}" data-registro-id="${escapeHTML(r.registro_id)}">
            <div class="actividad-item-head">
                <span class="actividad-fecha">${escapeHTML(fecha)}</span>
                ${tqHTML}
            </div>
            <div class="actividad-quien">${escapeHTML(r.cliente_nombre || '—')} · ${escapeHTML(r.perro_nombre || '—')}</div>
            <div class="actividad-ejercicio">${escapeHTML(r.ejercicio_nombre || '—')}</div>
            ${nota}
            ${notaCierre}
            ${videoHTML}
            ${pie}
        </li>
    `;
}

// Badge: cuenta registros no vistos. Usa la vista (RLS es_admin) con count
// exact head para no traer filas — mismo patrón que precargarBadgeAvisos.
async function precargarBadgeActividad() {
    try {
        const { count, error } = await supabase
            .from('actividad_registros_admin')
            .select('registro_id', { count: 'exact', head: true })
            .eq('visto_por_admin', false);
        if (error) {
            console.warn('[actividad] precarga badge falló:', error.message);
            return;
        }
        pintarBadgeActividad(count || 0);
    } catch (e) {
        console.warn('[actividad] precarga badge crash:', e);
    }
}

// Badge derivado de los registros ya cargados en memoria (tras visto/comentar).
function renderBadgeActividad() {
    const noVistos = actividadState.registros.filter((r) => !r.visto_por_admin).length;
    pintarBadgeActividad(noVistos);
}

function pintarBadgeActividad(n) {
    const badge = document.getElementById('actividad-badge');
    if (!badge) return;
    if (n > 0) {
        badge.textContent = n > 99 ? '99+' : String(n);
        badge.hidden = false;
    } else {
        badge.hidden = true;
    }
}

// UPDATE sobre registros_ejercicio (no la vista): el admin tiene permiso de
// escritura ahí. extra permite sumar comentario_admin en la misma operación.
async function marcarVistoRegistro(registroId, extra = {}) {
    const patch = { visto_por_admin: true, visto_en: new Date().toISOString(), ...extra };
    const { error } = await supabase
        .from('registros_ejercicio')
        .update(patch)
        .eq('id', registroId);
    if (error) {
        console.error('[actividad] error update visto:', error);
        alert('No se pudo guardar. Probá de nuevo.');
        return false;
    }
    // Reflejar en memoria + re-render local (sin refetch completo).
    const reg = actividadState.registros.find((r) => r.registro_id === registroId);
    if (reg) {
        reg.visto_por_admin = true;
        reg.visto_en = patch.visto_en;
        if ('comentario_admin' in extra) reg.comentario_admin = extra.comentario_admin;
    }
    renderRegistrosActividad();
    renderBadgeActividad();
    return true;
}

// Click en "Ver video del entreno" del feed: firma el URL on-demand (no al
// cargar la lista) y reproduce inline. Segundo click oculta.
async function onActividadVideoClick(btn) {
    const path = btn.dataset.videoPath;
    if (!path) return;
    const cont = btn.nextElementSibling; // .actividad-video

    if (cont && !cont.hidden && cont.querySelector('video')) {
        cont.hidden = true;
        cont.innerHTML = '';
        btn.textContent = 'Ver video del entreno';
        return;
    }

    btn.disabled = true;
    const txtPrev = btn.textContent;
    btn.textContent = 'Cargando video…';
    try {
        const { data, error } = await supabase.storage
            .from('entrenos-videos')
            .createSignedUrl(path, 3600);
        if (error) throw error;
        if (cont) {
            cont.innerHTML = `<video class="actividad-video-player" controls playsinline preload="metadata" src="${escapeHTML(data.signedUrl)}"></video>`;
            cont.hidden = false;
        }
        btn.textContent = 'Ocultar video';
    } catch (err) {
        console.error('[actividad] error firmando video:', err);
        toast('No se pudo cargar el video', 'error');
        btn.textContent = txtPrev;
    } finally {
        btn.disabled = false;
    }
}

function bindActividad() {
    // Filtro Pendientes / Todos sobre los registros ya cargados en memoria.
    document.querySelectorAll('.actividad-filtro').forEach((btn) => {
        btn.addEventListener('click', () => {
            const f = btn.dataset.filtro;
            if (f === actividadState.filtro) return;
            actividadState.filtro = f;
            document.querySelectorAll('.actividad-filtro').forEach((b) => {
                b.classList.toggle('active', b.dataset.filtro === f);
            });
            renderRegistrosActividad();
        });
    });

    const lista = document.getElementById('actividad-registros-lista');
    if (lista) {
        lista.addEventListener('click', async (e) => {
            const btn = e.target.closest('[data-action]');
            if (!btn) return;
            // "Ver video" no depende de un registroId: se resuelve por path.
            if (btn.dataset.action === 'ver-video') {
                await onActividadVideoClick(btn);
                return;
            }
            const registroId = btn.dataset.registroId;
            if (!registroId) return;
            if (btn.dataset.action === 'visto') {
                btn.disabled = true;
                await marcarVistoRegistro(registroId);
            } else if (btn.dataset.action === 'comentar') {
                abrirModalComentarActividad(registroId);
            }
        });
    }

    // Cierre del modal de comentar (el bind global de [data-modal-close] vive
    // en bindAgendaModals, que solo corre al abrir Agenda — lo garantizamos acá).
    document.querySelectorAll('#modal-comentar-actividad [data-modal-close]')
        .forEach((el) => el.addEventListener('click', () => closeModal('modal-comentar-actividad')));

    const guardar = document.getElementById('comentar-actividad-guardar');
    if (guardar) guardar.addEventListener('click', guardarComentarioActividad);
}

function abrirModalComentarActividad(registroId) {
    actividadState.comentarRegistroId = registroId;
    const reg = actividadState.registros.find((r) => r.registro_id === registroId);
    const ta = document.getElementById('comentar-actividad-texto');
    if (ta) ta.value = reg?.comentario_admin || '';
    const err = document.getElementById('comentar-actividad-error');
    if (err) { err.textContent = ''; err.hidden = true; }
    openModal('modal-comentar-actividad');
}

async function guardarComentarioActividad() {
    const registroId = actividadState.comentarRegistroId;
    if (!registroId) { closeModal('modal-comentar-actividad'); return; }
    const ta = document.getElementById('comentar-actividad-texto');
    const err = document.getElementById('comentar-actividad-error');
    const comentario = (ta?.value || '').trim();
    if (!comentario) {
        if (err) { err.textContent = 'Escribí un comentario o usá "Visto ✓".'; err.hidden = false; }
        return;
    }
    const btn = document.getElementById('comentar-actividad-guardar');
    if (btn) { btn.disabled = true; btn.textContent = 'Guardando…'; }
    const ok = await marcarVistoRegistro(registroId, { comentario_admin: comentario });
    if (btn) { btn.disabled = false; btn.textContent = 'Guardar'; }
    if (ok) {
        actividadState.comentarRegistroId = null;
        closeModal('modal-comentar-actividad');
    }
}
