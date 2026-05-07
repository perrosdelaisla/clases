// =====================================================================
// admin.js — panel admin del universo Perros de la Isla (Fase 1)
//
// Reusa el cliente Supabase configurado en /js/supabase.js (apunta al
// proyecto Victoria, sydzfwwiruxqaxojymdz). Todas las queries pasan por
// la publishable key + RLS — la función SQL es_admin() reconoce al
// usuario logueado y deja pasar el SELECT a clientes/perros/admins.
// =====================================================================

import { supabase } from '../js/supabase.js';
import * as agenda from './agenda/api.js?v=2';
import * as stats from './stats/api.js';
import Chart from 'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/+esm';

// Estado en memoria del admin actual y la lista cargada de clientes.
const state = {
    admin: null,            // { auth_user_id, email, nombre }
    clientes: [],           // resultado crudo del SELECT con perros anidados
    filtroEstado: 'todos',  // 'todos' | 'consulta' | 'activo' | 'mantenimiento' | 'inactivo'
    busqueda: '',
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
    const tabGuardada = localStorage.getItem('pdli_admin_tab') || 'clientes';
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
        case 'mantenimiento': return 'badge-mantenimiento';
        case 'inactivo': return 'badge-inactivo';
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
            await poblarDropdownHorasCita();
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

            const cliente = {
                nombre: (document.getElementById('cm-nombre')?.value || '').trim(),
                telefono: (document.getElementById('cm-telefono')?.value || '').trim(),
            };

            const perro = {
                nombre: (document.getElementById('cm-perro')?.value || '').trim(),
                raza: (document.getElementById('cm-raza')?.value || '').trim(),
                edad_meses: parseIntOrNull(document.getElementById('cm-edad')?.value),
                peso_kg: parseFloatOrNull(document.getElementById('cm-peso')?.value),
                es_ppp: !!document.getElementById('cm-ppp')?.checked,
            };

            const horaInput = document.getElementById('cm-hora')?.value || '';
            const cita = {
                fecha: document.getElementById('cm-fecha')?.value || '',
                hora: horaInput.length === 5 ? `${horaInput}:00` : horaInput,
                modalidad: (document.getElementById('cm-modalidad')?.value || '').trim(),
                zona: (document.getElementById('cm-zona')?.value || '').trim(),
                notas: (document.getElementById('cm-notas')?.value || '').trim(),
            };

            if (!cliente.nombre)  { showCmError('Falta el nombre del cliente.'); return; }
            if (!cliente.telefono) { showCmError('Falta el teléfono del cliente.'); return; }
            if (!perro.nombre)    { showCmError('Falta el nombre del perro.'); return; }
            if (!cita.fecha)      { showCmError('Falta la fecha de la cita.'); return; }
            if (!cita.hora)       { showCmError('Falta la hora de la cita.'); return; }

            cmSave.disabled = true;
            cmSave.textContent = 'Creando…';
            try {
                const res = await agenda.crearCitaManual({ cliente, perro, cita });
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
}

function openModal(id) {
    const m = document.getElementById(id);
    if (m) m.hidden = false;
}

function closeModal(id) {
    const m = document.getElementById(id);
    if (m) m.hidden = true;
    if (id === 'modal-cita-manual') {
        resetCmForm();
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
    window.__agendaBound = true;
    // Cargar plantilla por default (es la sub-pestaña activa al entrar)
    cargarPlantilla();
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
        'cm-nombre', 'cm-telefono',
        'cm-perro', 'cm-raza', 'cm-edad', 'cm-peso',
        'cm-fecha', 'cm-hora', 'cm-modalidad', 'cm-zona', 'cm-notas',
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
    list.innerHTML = '<p class="agenda-empty">Cargando citas…</p>';
    try {
        const citas = await agenda.obtenerCitasAdminConReportado();
        renderCitas(citas);
        bindCitasActions();
    } catch (err) {
        console.error('Error cargando citas:', err);
        list.innerHTML = '<p class="agenda-empty">Error al cargar citas.</p>';
    }
}

function bindCitasActions() {
    const list = document.getElementById('citas-list');
    if (!list || list.__bound) return;
    list.addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-action]');
        if (!btn) return;
        const card = btn.closest('[data-cita-id]');
        if (!card) return;
        const citaId = card.dataset.citaId;
        const action = btn.dataset.action;

        try {
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
            } else {
                return;
            }
            await cargarCitas();
        } catch (err) {
            console.error(`Error en acción ${action}:`, err);
            alert(`No se pudo completar la acción "${action}".`);
        }
    });
    list.__bound = true;
}

function renderCitas(citas) {
    const list = document.getElementById('citas-list');
    if (!list) return;
    if (!citas || citas.length === 0) {
        list.innerHTML = '<p class="agenda-empty">No hay citas futuras agendadas.</p>';
        return;
    }

    // Filtrar canceladas pasadas (regla del admin viejo)
    const visibles = citas.filter((c) => {
        if (c.estado === 'cancelada' && esCitaPasada(c.fecha)) return false;
        return true;
    });

    if (visibles.length === 0) {
        list.innerHTML = '<p class="agenda-empty">No hay citas futuras agendadas.</p>';
        return;
    }

    list.innerHTML = visibles.map((c) => {
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

        // BOTONES CONDICIONALES — reglas del admin viejo (hola/admin/admin.js:444-493)
        const botones = [];

        // Confirmar: solo si pendiente
        if (estado === 'pendiente') {
            botones.push('<button data-action="confirmar" type="button">Confirmar</button>');
        }

        // Cancelar: pendiente o confirmada, hoy o futura, NO realizada/cancelada
        if ((estado === 'pendiente' || estado === 'confirmada') && !esCitaPasada(c.fecha)) {
            botones.push('<button data-action="cancelar" type="button">Cancelar</button>');
        }

        // Marcar realizada: solo confirmadas de hoy o anteriores
        if (estado === 'confirmada' && (esCitaHoy(c.fecha) || esCitaPasada(c.fecha))) {
            botones.push('<button data-action="realizada" type="button">Marcar realizada</button>');
        }

        // Eliminar: realizadas, canceladas (futuras) y confirmadas
        if (estado === 'realizada' || estado === 'cancelada' || estado === 'confirmada') {
            botones.push('<button class="btn-eliminar" data-action="eliminar-cita" type="button">Eliminar</button>');
        }

        // Si quedó pendiente sin botón Eliminar (caso raro), permitir eliminar igual
        if (estado === 'pendiente' && botones.length === 1) {
            botones.push('<button class="btn-eliminar" data-action="eliminar-cita" type="button">Eliminar</button>');
        }

        // Reportado / Notas con labels diferenciados
        let bloqueReportado = '';
        if (reportado) {
            bloqueReportado = `<div class="cita-reportado"><strong>Reportado por el cliente:</strong> ${escapeHTML(reportado)}</div>`;
        } else if (c.notas) {
            bloqueReportado = `<div class="cita-reportado"><strong>Notas:</strong> ${escapeHTML(c.notas)}</div>`;
        }

        // Protocolo + cuadros detectados (si existen)
        let bloqueProtocolo = '';
        if (protocolo) {
            bloqueProtocolo = `<div class="cita-protocolo"><strong>Protocolo:</strong> ${escapeHTML(protocolo)}</div>`;
        } else if (cuadros.length > 0) {
            bloqueProtocolo = `<div class="cita-protocolo"><strong>Cuadros:</strong> ${escapeHTML(cuadros.join(', '))}</div>`;
        }

        return `
            <div class="cita-card" data-cita-id="${escapeHTML(c.id)}">
                <div class="cita-header">
                    <span class="cita-fecha">${formatearFechaCorta(c.fecha)} · ${formatearHora(c.hora)}</span>
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
    const hoyStrIso = hoy.toISOString().slice(0, 10);
    if (periodo === '7d') {
        const desde = new Date(hoy); desde.setDate(desde.getDate() - 6);
        return { desde: desde.toISOString().slice(0, 10), hasta: hoyStrIso };
    }
    if (periodo === '30d') {
        const desde = new Date(hoy); desde.setDate(desde.getDate() - 29);
        return { desde: desde.toISOString().slice(0, 10), hasta: hoyStrIso };
    }
    if (periodo === 'mes') {
        const desde = new Date(hoy.getFullYear(), hoy.getMonth(), 1);
        return { desde: desde.toISOString().slice(0, 10), hasta: hoyStrIso };
    }
    return null;
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
        cargarDoughnut('tema',      () => stats.obtenerDistribucionTema(rango),      'chart-tema'),
        cargarDoughnut('modalidad', () => stats.obtenerDistribucionModalidad(rango), 'chart-modalidad'),
        cargarDoughnut('origen',    () => stats.obtenerDistribucionOrigen(rango),    'chart-origen'),
        cargarDoughnut('clientes',  () => stats.obtenerDistribucionClientes(),       'chart-clientes'),
        cargarBarrasCitasMes(),
    ]);
}

async function cargarKPIsStats(rango) {
    try {
        const k = await stats.obtenerKPIs(rango);
        document.getElementById('kpi-sesiones').textContent = String(k.sesiones_reales);
        document.getElementById('kpi-citas').textContent = String(k.citas_confirmadas);
        document.getElementById('kpi-conv').textContent = k.conversion_pct + '%';
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
            return `
                <div class="funnel-row">
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

async function cargarDoughnut(key, fetcher, canvasId) {
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
                    backgroundColor: ['#C8102E', '#6B7A3A', '#1A1A1A', '#F5EFE0', '#8B7355', '#A04040', '#4A5530', '#D4A05C'],
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
    } catch (err) { console.error(`Doughnut ${key}:`, err); }
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
