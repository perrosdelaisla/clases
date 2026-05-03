// =====================================================================
// cliente.js — pantalla de detalle de cliente (Fase 2, Paso 1 + invitar)
//
// Carga datos del cliente identificado por ?id=<uuid> y la lista de
// perros vinculados. Si no hay sesión o el usuario no es admin,
// redirige al login. RLS de Victoria deja pasar todo si es_admin().
// Botón "Invitar a la app": UPSERT en invitaciones_pendientes + magic
// link via supabase.auth.signInWithOtp + opción de compartir por WhatsApp.
// =====================================================================

import { supabase } from '../js/supabase.js';

const SCREENS = {
    loading: document.getElementById('screen-loading'),
    error: document.getElementById('screen-error'),
    cliente: document.getElementById('screen-cliente'),
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const APP_CLIENTE_URL = 'https://perrosdelaisla.github.io/clases/';

const state = {
    clienteId: null,
    cliente: null,
    adminAuthId: null,
};

document.addEventListener('DOMContentLoaded', bootstrap);

async function bootstrap() {
    showScreen('loading');
    bindInvitarUI();

    const id = new URLSearchParams(window.location.search).get('id');
    if (!id) {
        window.location.replace('./index.html');
        return;
    }

    if (!UUID_RE.test(id)) {
        mostrarError('ID de cliente inválido.');
        return;
    }

    state.clienteId = id;

    try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) {
            window.location.replace('./index.html');
            return;
        }

        state.adminAuthId = session.user.id;

        const esAdmin = await verificarAdmin(session.user.id);
        if (!esAdmin) {
            await supabase.auth.signOut();
            window.location.replace('./index.html');
            return;
        }

        await cargarYRender(id);
    } catch (err) {
        console.error('[cliente] bootstrap error:', err);
        mostrarError('Error inesperado al cargar el cliente.');
    }
}

async function verificarAdmin(authUserId) {
    const { data, error } = await supabase
        .from('admins')
        .select('auth_user_id')
        .eq('auth_user_id', authUserId)
        .maybeSingle();
    if (error) {
        console.error('[cliente] verificación admin falló:', error);
        return false;
    }
    return !!data;
}

async function cargarYRender(clienteId) {
    // SELECT * para no asumir nombres de columna más allá de los necesarios.
    const [clienteRes, perrosRes] = await Promise.all([
        supabase.from('clientes').select('*').eq('id', clienteId).maybeSingle(),
        supabase.from('perros').select('*').eq('cliente_id', clienteId).order('created_at', { ascending: true }),
    ]);

    if (clienteRes.error) {
        console.error('[cliente] error cargando cliente:', clienteRes.error);
        mostrarError('No se pudo cargar el cliente.');
        return;
    }

    if (!clienteRes.data) {
        mostrarError('Este cliente no existe o no tenés acceso.');
        return;
    }

    if (perrosRes.error) {
        console.error('[cliente] error cargando perros:', perrosRes.error);
        // Mostramos al cliente igual; los perros caen al estado vacío con aviso.
    }

    renderCliente(clienteRes.data);
    renderPerros(perrosRes.data || []);
    showScreen('cliente');
}

function renderCliente(c) {
    state.cliente = c;
    setText('cliente-nombre', c.nombre || 'Sin nombre');
    setText('cliente-telefono', c.telefono || '—');
    setText('cliente-email', c.email || '—');
    setText('cliente-zona', c.zona || '—');
    setText('cliente-desde', formatearClienteDesde(c.cliente_desde));

    const estadoEl = document.getElementById('cliente-estado');
    const estado = (c.estado || '').toLowerCase();
    estadoEl.className = `cliente-badge ${badgeClassFor(estado)}`;
    estadoEl.textContent = estado
        ? estado.charAt(0).toUpperCase() + estado.slice(1)
        : 'Sin estado';

    actualizarBotonInvitar(c);

    document.title = `${c.nombre || 'Cliente'} — Admin PDLI`;
}

function actualizarBotonInvitar(c) {
    const btn = document.getElementById('btn-invitar');
    if (!btn) return;
    btn.textContent = c?.email ? 'Reenviar invitación' : 'Invitar a la app';
}

function renderPerros(perros) {
    const lista = document.getElementById('perros-lista');
    const empty = document.getElementById('perros-empty');

    if (!perros.length) {
        lista.innerHTML = '';
        empty.hidden = false;
        return;
    }

    empty.hidden = true;
    lista.innerHTML = perros.map(renderPerroCard).join('');
}

function renderPerroCard(p) {
    const nombre = escapeHTML(p.nombre || 'Sin nombre');
    const raza = p.raza ? escapeHTML(p.raza) : null;
    const edad = formatearEdadMeses(p.edad_meses);
    const meta = [raza, edad].filter(Boolean).join(' · ') || 'Sin datos';

    return `
        <li>
            <a class="perro-card" href="./perro.html?id=${escapeHTML(p.id)}">
                <span class="perro-nombre">${nombre}</span>
                <span class="perro-meta">${meta}</span>
            </a>
        </li>
    `;
}

function formatearEdadMeses(meses) {
    if (meses == null) return null;
    const n = Number(meses);
    if (!Number.isFinite(n) || n < 0) return null;
    if (n < 24) return `${n} ${n === 1 ? 'mes' : 'meses'}`;
    const anios = n / 12;
    if (Number.isInteger(anios)) return `${anios} ${anios === 1 ? 'año' : 'años'}`;
    return `${anios.toFixed(1).replace('.', ',')} años`;
}

function formatearClienteDesde(valor) {
    if (!valor) return '—';
    const d = new Date(valor);
    if (isNaN(d.getTime())) return String(valor);
    const formatter = new Intl.DateTimeFormat('es-AR', { month: 'long', year: 'numeric' });
    return `Cliente desde ${formatter.format(d)}`;
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

// ---------- Helpers ----------

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

// ===================== Invitar a la app =====================

function bindInvitarUI() {
    const btn = document.getElementById('btn-invitar');
    if (btn) btn.addEventListener('click', abrirModalInvitar);

    const modal = document.getElementById('modal-invitar');
    if (modal) {
        modal.addEventListener('click', (e) => {
            if (e.target.closest('[data-close]')) cerrarModalInvitar();
        });
    }

    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        const m = document.getElementById('modal-invitar');
        if (m && !m.hasAttribute('hidden')) cerrarModalInvitar();
    });

    const sendBtn = document.getElementById('invitar-enviar');
    if (sendBtn) sendBtn.addEventListener('click', enviarInvitacion);
}

function abrirModalInvitar() {
    if (!state.cliente) return;
    const modal = document.getElementById('modal-invitar');
    const input = document.getElementById('invitar-email');
    const errorEl = document.getElementById('invitar-error');

    input.value = state.cliente.email || '';
    errorEl.hidden = true;
    errorEl.textContent = '';

    mostrarPasoModal('form');

    modal.removeAttribute('hidden');
    modal.setAttribute('aria-hidden', 'false');
    requestAnimationFrame(() => modal.classList.add('is-open'));
    document.body.style.overflow = 'hidden';
    setTimeout(() => input.focus(), 80);
}

function cerrarModalInvitar() {
    const modal = document.getElementById('modal-invitar');
    if (!modal || modal.hasAttribute('hidden')) return;
    modal.classList.remove('is-open');
    document.body.style.overflow = '';
    setTimeout(() => {
        modal.setAttribute('hidden', '');
        modal.setAttribute('aria-hidden', 'true');
    }, 250);
}

function mostrarPasoModal(step) {
    const modal = document.getElementById('modal-invitar');
    modal.querySelectorAll('[data-step]').forEach((el) => {
        if (el.dataset.step === step) el.removeAttribute('hidden');
        else el.setAttribute('hidden', '');
    });
}

async function enviarInvitacion() {
    const input = document.getElementById('invitar-email');
    const errorEl = document.getElementById('invitar-error');
    const btn = document.getElementById('invitar-enviar');

    const email = input.value.trim().toLowerCase();
    if (!EMAIL_RE.test(email)) {
        errorEl.textContent = 'Email inválido.';
        errorEl.hidden = false;
        return;
    }

    errorEl.hidden = true;
    btn.disabled = true;
    btn.textContent = 'Enviando…';

    try {
        // 1) UPSERT en invitaciones_pendientes (clave única: email).
        const { error: e1 } = await supabase
            .from('invitaciones_pendientes')
            .upsert({
                email,
                cliente_id: state.clienteId,
                nombre: state.cliente?.nombre || null,
                invitado_por: state.adminAuthId,
            }, { onConflict: 'email' });
        if (e1) throw e1;

        // 2) Magic link al email del cliente. emailRedirectTo apunta a la
        // app cliente; Supabase manda el mail desde su lado.
        const { error: e2 } = await supabase.auth.signInWithOtp({
            email,
            options: { emailRedirectTo: APP_CLIENTE_URL },
        });
        if (e2) throw e2;

        // Reflejamos el nuevo email en la pantalla y en el botón.
        if (state.cliente) state.cliente.email = email;
        setText('cliente-email', email);
        actualizarBotonInvitar(state.cliente);

        mostrarSuccessInvitacion(email);
    } catch (err) {
        console.error('[invitar] error:', err);
        errorEl.textContent = err?.message
            ? `No se pudo enviar: ${err.message}`
            : 'No se pudo enviar la invitación.';
        errorEl.hidden = false;
    } finally {
        btn.disabled = false;
        btn.textContent = 'Enviar invitación';
    }
}

function mostrarSuccessInvitacion(email) {
    document.getElementById('invitar-email-enviado').textContent = email;

    const wa = document.getElementById('invitar-whatsapp');
    const tel = telefonoParaWhatsapp(state.cliente?.telefono);
    if (tel) {
        const nombrePila = (state.cliente?.nombre || '').split(/\s+/)[0] || 'hola';
        const msg =
            `Hola ${nombrePila}! Te paso el acceso a tu app de Perros de la Isla, ` +
            `donde vas a ver los ejercicios para tu perro día a día. ` +
            `Revisá tu mail (${email}) para entrar. ` +
            `Si no te llegó, avisame y te lo reenvío. 🐾`;
        wa.href = `https://wa.me/${tel}?text=${encodeURIComponent(msg)}`;
        wa.removeAttribute('hidden');
    } else {
        wa.setAttribute('hidden', '');
    }

    mostrarPasoModal('success');
    toast('Invitación enviada');
}

function telefonoParaWhatsapp(raw) {
    if (!raw) return null;
    const soloDigitos = String(raw).replace(/\D/g, '');
    if (!soloDigitos) return null;
    // Si llega un móvil español sin código (9 dígitos), prepend 34.
    if (soloDigitos.length === 9) return `34${soloDigitos}`;
    return soloDigitos;
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
    toastTimer = setTimeout(() => el.setAttribute('hidden', ''), 2200);
}
