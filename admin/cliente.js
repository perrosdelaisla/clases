// =====================================================================
// cliente.js — pantalla de detalle de cliente (Fase 2, Paso 1)
//
// Carga datos del cliente identificado por ?id=<uuid> y la lista de
// perros vinculados. Si no hay sesión o el usuario no es admin,
// redirige al login. RLS de Victoria deja pasar todo si es_admin().
// =====================================================================

import { supabase } from '../js/supabase.js';

const SCREENS = {
    loading: document.getElementById('screen-loading'),
    error: document.getElementById('screen-error'),
    cliente: document.getElementById('screen-cliente'),
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

document.addEventListener('DOMContentLoaded', bootstrap);

async function bootstrap() {
    showScreen('loading');

    const id = new URLSearchParams(window.location.search).get('id');
    if (!id) {
        // Sin ID en la URL no hay nada que mostrar — vuelvo a la lista.
        window.location.replace('./index.html');
        return;
    }

    if (!UUID_RE.test(id)) {
        mostrarError('ID de cliente inválido.');
        return;
    }

    try {
        const { data: { session } } = await supabase.auth.getSession();
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
    setText('cliente-nombre', c.nombre || 'Sin nombre');
    setText('cliente-telefono', c.telefono || '—');
    setText('cliente-zona', c.zona || '—');
    setText('cliente-desde', formatearClienteDesde(c.cliente_desde));

    const estadoEl = document.getElementById('cliente-estado');
    const estado = (c.estado || '').toLowerCase();
    estadoEl.className = `cliente-badge ${badgeClassFor(estado)}`;
    estadoEl.textContent = estado
        ? estado.charAt(0).toUpperCase() + estado.slice(1)
        : 'Sin estado';

    document.title = `${c.nombre || 'Cliente'} — Admin PDLI`;
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
    const edad = formatearEdad(p);
    const meta = [raza, edad].filter(Boolean).join(' · ') || 'Sin datos';

    return `
        <li>
            <article class="perro-card">
                <span class="perro-nombre">${nombre}</span>
                <span class="perro-meta">${meta}</span>
            </article>
        </li>
    `;
}

function formatearEdad(p) {
    // Cubro tres formas posibles según cómo estén las columnas en Victoria:
    // edad_anios (int), edad (int|text) o fecha_nacimiento (date).
    if (typeof p.edad_anios === 'number') return formatoAnios(p.edad_anios);
    if (typeof p.edad === 'number') return formatoAnios(p.edad);
    if (typeof p.edad === 'string' && p.edad.trim()) return p.edad.trim();
    if (p.fecha_nacimiento) {
        const anios = aniosDesde(p.fecha_nacimiento);
        if (anios !== null) return formatoAnios(anios);
    }
    return null;
}

function formatoAnios(n) {
    if (n === 0) return 'menos de 1 año';
    if (n === 1) return '1 año';
    return `${n} años`;
}

function aniosDesde(fechaIso) {
    const d = new Date(fechaIso);
    if (isNaN(d.getTime())) return null;
    const ahora = new Date();
    let anios = ahora.getFullYear() - d.getFullYear();
    const m = ahora.getMonth() - d.getMonth();
    if (m < 0 || (m === 0 && ahora.getDate() < d.getDate())) anios--;
    return Math.max(0, anios);
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
