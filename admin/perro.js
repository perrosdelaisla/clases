// =====================================================================
// perro.js — pantalla de detalle de perro (Fase 2, Paso 2)
//
// Trae datos del perro identificado por ?id=<uuid> + datos del cliente
// dueño (para el botón Volver). Sistema de tabs con querystring ?tab=
// para que el estado persista en refresh. Tab por defecto: ejercicios.
// =====================================================================

import { supabase } from '../js/supabase.js';

const SCREENS = {
    loading: document.getElementById('screen-loading'),
    error: document.getElementById('screen-error'),
    perro: document.getElementById('screen-perro'),
};

const TABS = ['plan', 'ejercicios', 'herramientas', 'historico', 'notas'];
const DEFAULT_TAB = 'ejercicios';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

document.addEventListener('DOMContentLoaded', bootstrap);

async function bootstrap() {
    showScreen('loading');
    bindTabs();

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
        activarTab(params.get('tab'), { updateUrl: false });
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

async function cargarYRender(perroId) {
    // Embed de cliente vía FK perros.cliente_id → clientes.id.
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

    renderPerro(data);
    showScreen('perro');
}

function renderPerro(p) {
    const nombre = p.nombre || 'Sin nombre';
    setText('perro-nombre', nombre);
    setText('perro-nombre-header', nombre);
    document.title = `${nombre} — Admin PDLI`;

    setText('perro-raza', p.raza || '—');
    setText('perro-edad', formatearEdadMeses(p.edad_meses) || '—');
    setText('perro-peso', formatearPesoKg(p.peso_kg) || '—');

    const ppp = document.getElementById('perro-ppp');
    if (p.es_ppp === true) {
        ppp.removeAttribute('hidden');
    } else {
        ppp.setAttribute('hidden', '');
    }

    // Botón Volver apunta al cliente dueño (si pude embedarlo).
    const back = document.getElementById('back-link');
    const clienteEmbed = p.clientes;
    if (clienteEmbed?.id) {
        back.href = `./cliente.html?id=${encodeURIComponent(clienteEmbed.id)}`;
        back.setAttribute('aria-label', `Volver a ${clienteEmbed.nombre || 'cliente'}`);
    } else if (p.cliente_id) {
        back.href = `./cliente.html?id=${encodeURIComponent(p.cliente_id)}`;
    }
}

// ---------- Formato edad / peso ----------

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
    // Postgres numeric viene como string en JSON.
    const n = typeof kg === 'string' ? parseFloat(kg.replace(',', '.')) : Number(kg);
    if (!Number.isFinite(n) || n < 0) return null;
    if (Number.isInteger(n)) return `${n} kg`;
    // Mostramos hasta 2 decimales y limpiamos ceros sobrantes.
    const txt = n.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
    return `${txt.replace('.', ',')} kg`;
}

// ---------- Tabs ----------

function bindTabs() {
    document.getElementById('tabs').addEventListener('click', (e) => {
        const btn = e.target.closest('.tab');
        if (!btn) return;
        const tab = btn.dataset.tab;
        if (!tab) return;
        activarTab(tab, { updateUrl: true });
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

    // Scroll horizontal: aseguramos que la tab activa quede a la vista.
    const activeBtn = document.querySelector(`.tab[data-tab="${tab}"]`);
    activeBtn?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });

    if (updateUrl) {
        const url = new URL(window.location);
        if (tab === DEFAULT_TAB) url.searchParams.delete('tab');
        else url.searchParams.set('tab', tab);
        window.history.replaceState({}, '', url);
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
