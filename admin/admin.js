// =====================================================================
// admin.js — panel admin del universo Perros de la Isla (Fase 1)
//
// Reusa el cliente Supabase configurado en /js/supabase.js (apunta al
// proyecto Victoria, sydzfwwiruxqaxojymdz). Todas las queries pasan por
// la publishable key + RLS — la función SQL es_admin() reconoce al
// usuario logueado y deja pasar el SELECT a clientes/perros/admins.
// =====================================================================

import { supabase } from '../js/supabase.js';

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
    console.log('TODO 3.B: cargar datos de sub-pestaña', sub);
}

function bindAgendaModals() {
    const btnAddHora = document.getElementById('btn-add-hora');
    if (btnAddHora) {
        btnAddHora.addEventListener('click', () => openModal('modal-add-hora'));
    }

    const btnCitaManual = document.getElementById('btn-abrir-cita-manual');
    if (btnCitaManual) {
        btnCitaManual.addEventListener('click', () => openModal('modal-cita-manual'));
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
        modalSave.addEventListener('click', () => {
            const dia = document.getElementById('modal-dia').value;
            const hora = document.getElementById('modal-hora').value;
            console.log('TODO 3.B: añadirSlotPlantilla(', dia, ',', hora, ')');
            closeModal('modal-add-hora');
        });
    }

    const cmSave = document.getElementById('cm-save');
    if (cmSave) {
        cmSave.addEventListener('click', () => {
            console.log('TODO 3.B: crearCitaManual con datos del form');
            closeModal('modal-cita-manual');
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
}

function bindFormBloqueo() {
    const form = document.getElementById('form-bloqueo');
    if (!form) return;
    form.addEventListener('submit', (e) => {
        e.preventDefault();
        const fecha = document.getElementById('bloq-fecha').value;
        const hora = document.getElementById('bloq-hora').value;
        const motivo = document.getElementById('bloq-motivo').value;
        console.log('TODO 3.B: bloquearDia(', fecha, ',', motivo, ',', hora || null, ')');
    });
}

function initAgenda() {
    if (window.__agendaBound) return;
    bindAgendaSubtabs();
    bindAgendaModals();
    bindFormBloqueo();
    console.log('TODO 3.B: cargar datos iniciales de agenda');
    window.__agendaBound = true;
}
