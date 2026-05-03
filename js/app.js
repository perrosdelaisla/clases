// =====================================================================
// app.js — app del cliente Perros de la Isla.
//
// Single-page con switch de pantallas según el estado de auth y datos:
//   loading → login → (mail enviado) → rutina
//   loading → rutina (con sesión preexistente)
//   loading → error-vinculo (sesión sin usuarios_cliente vinculado)
//
// Las RLS de Victoria filtran solas: SELECT en perros y ejercicios_*
// solo devuelve lo del cliente del usuario logueado, vía mi_cliente_id().
// =====================================================================

import { supabase } from './supabase.js';

const SCREENS = {
    loading: document.getElementById('screen-loading'),
    login: document.getElementById('screen-login'),
    'login-sent': document.getElementById('screen-login-sent'),
    'error-vinculo': document.getElementById('screen-error-vinculo'),
    rutina: document.getElementById('screen-rutina'),
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const STORAGE_PERRO_KEY = 'pdli.perroSeleccionadoId';

const CATEGORIA_LABEL = {
    ejercicio: 'Ejercicios',
    cambio_rutina: 'Cambios de rutina',
    tarea: 'Tareas',
    herramienta: 'Herramientas',
};

const state = {
    session: null,
    usuarioCliente: null,    // { id, auth_user_id, cliente_id, nombre, ... }
    perros: [],              // ordenados por created_at asc
    perroSeleccionadoId: null,
};

document.addEventListener('DOMContentLoaded', () => {
    bindEventos();
    registrarServiceWorker();
    bootstrap();

    // Reaccionamos a cambios de sesión en vivo (incluido el caso de
    // entrar al sitio desde el magic link y que Supabase complete el flujo).
    supabase.auth.onAuthStateChange((event, session) => {
        if (event === 'SIGNED_IN' || event === 'INITIAL_SESSION') {
            if (session) onSesionLista(session);
        } else if (event === 'SIGNED_OUT') {
            state.session = null;
            state.usuarioCliente = null;
            state.perros = [];
            state.perroSeleccionadoId = null;
            showScreen('login');
        }
    });
});

async function bootstrap() {
    showScreen('loading');
    try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) {
            showScreen('login');
            return;
        }
        await onSesionLista(session);
    } catch (err) {
        console.error('[app] bootstrap error:', err);
        showScreen('login');
    }
}

async function onSesionLista(session) {
    state.session = session;
    showScreen('loading');

    try {
        const usuarioCliente = await cargarUsuarioCliente(session.user.id);
        if (!usuarioCliente) {
            showScreen('error-vinculo');
            return;
        }
        state.usuarioCliente = usuarioCliente;

        const perros = await cargarPerros();
        state.perros = perros;

        // Recuperamos el perro elegido en sesión previa, si sigue siendo válido.
        const guardado = sessionStorage.getItem(STORAGE_PERRO_KEY);
        if (guardado && perros.some((p) => p.id === guardado)) {
            state.perroSeleccionadoId = guardado;
        } else {
            state.perroSeleccionadoId = perros[0]?.id || null;
        }

        renderHeader();
        renderSelectorPerros();
        await renderRutinaPerroSeleccionado();
        showScreen('rutina');
    } catch (err) {
        console.error('[app] error cargando datos:', err);
        showScreen('error-vinculo');
    }
}

// ===================== Login =====================

function bindEventos() {
    const form = document.getElementById('login-form');
    if (form) form.addEventListener('submit', enviarMagicLink);

    const otraVez = document.getElementById('login-otra-vez');
    if (otraVez) otraVez.addEventListener('click', () => {
        document.getElementById('login-email').value = '';
        showScreen('login');
    });

    const errorLogout = document.getElementById('error-logout');
    if (errorLogout) errorLogout.addEventListener('click', cerrarSesion);

    const avatarBtn = document.getElementById('avatar-btn');
    if (avatarBtn) avatarBtn.addEventListener('click', toggleMenuAvatar);

    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) logoutBtn.addEventListener('click', cerrarSesion);

    document.addEventListener('click', (e) => {
        const menu = document.getElementById('avatar-menu');
        const btn = document.getElementById('avatar-btn');
        if (!menu || menu.hasAttribute('hidden')) return;
        if (e.target === btn || btn?.contains(e.target)) return;
        if (menu.contains(e.target)) return;
        cerrarMenuAvatar();
    });
}

async function enviarMagicLink(e) {
    e.preventDefault();
    const input = document.getElementById('login-email');
    const errEl = document.getElementById('login-error');
    const btn = document.getElementById('login-submit');

    const email = input.value.trim().toLowerCase();
    errEl.hidden = true;
    errEl.textContent = '';

    if (!EMAIL_RE.test(email)) {
        errEl.textContent = 'Email inválido.';
        errEl.hidden = false;
        return;
    }

    btn.disabled = true;
    btn.textContent = 'Enviando…';

    try {
        const { error } = await supabase.auth.signInWithOtp({
            email,
            options: { emailRedirectTo: window.location.origin + window.location.pathname },
        });
        if (error) throw error;

        document.getElementById('email-enviado').textContent = email;
        showScreen('login-sent');
    } catch (err) {
        console.error('[app] magic link error:', err);
        errEl.textContent = err?.message
            ? `No se pudo enviar: ${err.message}`
            : 'No se pudo enviar el mail. Probá de nuevo.';
        errEl.hidden = false;
    } finally {
        btn.disabled = false;
        btn.textContent = 'Enviar link';
    }
}

async function cerrarSesion() {
    try {
        await supabase.auth.signOut();
    } catch (err) {
        console.error('[app] signOut error:', err);
    }
    cerrarMenuAvatar();
    showScreen('login');
}

// ===================== Avatar menú =====================

function toggleMenuAvatar() {
    const menu = document.getElementById('avatar-menu');
    const btn = document.getElementById('avatar-btn');
    const open = menu.hasAttribute('hidden');
    if (open) {
        menu.removeAttribute('hidden');
        btn.setAttribute('aria-expanded', 'true');
    } else {
        cerrarMenuAvatar();
    }
}

function cerrarMenuAvatar() {
    const menu = document.getElementById('avatar-menu');
    const btn = document.getElementById('avatar-btn');
    menu?.setAttribute('hidden', '');
    btn?.setAttribute('aria-expanded', 'false');
}

// ===================== Datos =====================

async function cargarUsuarioCliente(authUserId) {
    const { data, error } = await supabase
        .from('usuarios_cliente')
        .select('*')
        .eq('auth_user_id', authUserId)
        .maybeSingle();
    if (error) {
        console.error('[app] error cargando usuario_cliente:', error);
        throw error;
    }
    return data || null;
}

async function cargarPerros() {
    // RLS filtra al cliente_id propio del usuario logueado.
    const { data, error } = await supabase
        .from('perros')
        .select('*')
        .order('created_at', { ascending: true });
    if (error) {
        console.error('[app] error cargando perros:', error);
        throw error;
    }
    return data || [];
}

async function cargarRutinaDelPerro(perroId) {
    const { data, error } = await supabase
        .from('ejercicios_asignados')
        .select('ejercicio_id, posicion_rutina, ejercicios (id, codigo, nombre, descripcion, categoria)')
        .eq('perro_id', perroId)
        .eq('activo', true)
        .order('posicion_rutina', { ascending: true });
    if (error) {
        console.error('[app] error cargando rutina:', error);
        throw error;
    }
    return data || [];
}

// ===================== Render =====================

function renderHeader() {
    const u = state.usuarioCliente;
    const nombrePila = (u?.nombre || u?.nombre_visible || '').split(/\s+/)[0] || 'amig@';
    setText('usuario-nombre', nombrePila);
    document.getElementById('avatar-letter').textContent = (nombrePila[0] || 'U').toUpperCase();
}

function renderSelectorPerros() {
    const sel = document.getElementById('perro-selector');
    if (!sel) return;
    if (state.perros.length < 2) {
        sel.innerHTML = '';
        sel.setAttribute('hidden', '');
        return;
    }
    sel.removeAttribute('hidden');
    sel.innerHTML = state.perros.map((p) => {
        const active = p.id === state.perroSeleccionadoId;
        return `
            <button type="button" class="perro-pill${active ? ' is-active' : ''}"
                    data-perro-id="${escapeHTML(p.id)}"
                    aria-pressed="${active ? 'true' : 'false'}">
                ${escapeHTML(p.nombre || 'Perro')}
            </button>
        `;
    }).join('');

    sel.querySelectorAll('.perro-pill').forEach((btn) => {
        btn.addEventListener('click', () => {
            const id = btn.dataset.perroId;
            if (!id || id === state.perroSeleccionadoId) return;
            state.perroSeleccionadoId = id;
            sessionStorage.setItem(STORAGE_PERRO_KEY, id);
            renderSelectorPerros();
            renderRutinaPerroSeleccionado();
        });
    });
}

async function renderRutinaPerroSeleccionado() {
    const hero = document.getElementById('perro-hero');
    const heroNombre = document.getElementById('perro-hero-nombre');
    const heroRaza = document.getElementById('perro-hero-raza');
    const lista = document.getElementById('rutina-lista');
    const loading = document.getElementById('rutina-loading');
    const empty = document.getElementById('rutina-empty');
    const sinPerro = document.getElementById('rutina-sin-perro');

    // Reset
    lista.innerHTML = '';
    lista.setAttribute('hidden', '');
    empty.setAttribute('hidden', '');
    sinPerro.setAttribute('hidden', '');
    loading.removeAttribute('hidden');

    const perro = state.perros.find((p) => p.id === state.perroSeleccionadoId);

    if (!perro) {
        loading.setAttribute('hidden', '');
        hero.setAttribute('hidden', '');
        sinPerro.removeAttribute('hidden');
        return;
    }

    hero.removeAttribute('hidden');
    heroNombre.textContent = perro.nombre || 'Tu perro';
    heroRaza.textContent = perro.raza || '';

    try {
        const filas = await cargarRutinaDelPerro(perro.id);
        loading.setAttribute('hidden', '');

        if (filas.length === 0) {
            empty.removeAttribute('hidden');
            return;
        }

        lista.innerHTML = filas.map(renderRutinaCard).join('');
        lista.removeAttribute('hidden');
    } catch (err) {
        loading.setAttribute('hidden', '');
        empty.removeAttribute('hidden');
        toast('No pudimos cargar la rutina. Probá de nuevo.', 'error');
    }
}

function renderRutinaCard(row) {
    const ej = row.ejercicios;
    if (!ej) return '';
    const nombre = escapeHTML(ej.nombre || 'Ejercicio');
    const categoria = ej.categoria || 'ejercicio';
    const desc = ej.descripcion ? escapeHTML(ej.descripcion) : '';

    return `
        <li class="rutina-card">
            <div class="rutina-card__head">
                <h3 class="rutina-card__nombre">${nombre}</h3>
                <span class="cat-chip cat-chip--${escapeHTML(categoria)}">${escapeHTML(CATEGORIA_LABEL[categoria] || categoria)}</span>
            </div>
            ${desc ? `<p class="rutina-card__desc">${desc}</p>` : ''}
        </li>
    `;
}

// ===================== Helpers =====================

function showScreen(name) {
    Object.entries(SCREENS).forEach(([key, el]) => {
        if (!el) return;
        if (key === name) el.removeAttribute('hidden');
        else el.setAttribute('hidden', '');
    });
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

let toastTimer = null;
function toast(msg, kind = 'info') {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.remove('toast--info', 'toast--error');
    el.classList.add(kind === 'error' ? 'toast--error' : 'toast--info');
    el.removeAttribute('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.setAttribute('hidden', ''), 2400);
}

// ===================== Service Worker =====================

function registrarServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    // Esperamos al evento load para no competir con el resto del bootstrap.
    window.addEventListener('load', () => {
        navigator.serviceWorker
            .register('/clases/service-worker.js', { scope: '/clases/' })
            .then((reg) => console.log('[app] SW Clases registrado, scope:', reg.scope))
            .catch((err) => console.error('[app] SW Clases error:', err));
    });
}
