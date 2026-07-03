// =====================================================================
// cliente.js — pantalla de detalle de cliente (Fase 2, Paso 1 + invitar)
//
// Carga datos del cliente identificado por ?id=<uuid> y la lista de
// perros vinculados. Si no hay sesión o el usuario no es admin,
// redirige al login. RLS de Victoria deja pasar todo si es_admin().
// Botón "Invitar a la app": llama a la edge function invitar-cliente
// (un solo correo con el código de acceso) + opción de compartir las
// instrucciones por WhatsApp.
// =====================================================================

import { getSupabase, getSessionConTimeout } from '../js/supabase.js';
import { initJaime } from './jaime.js?v=12';
const supabase = getSupabase('admin');

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
    bindWidgetPack();
    bindMapsUbicacion();
    bindEstadoSelector();
    bindBackNavigation();

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
        const { data: { session } } = await getSessionConTimeout(8000, 'admin');
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
    // El count de usuarios_cliente decide el texto del botón de invitar:
    // "ya invitado" = el cliente tiene al menos un usuario vinculado.
    const [clienteRes, perrosRes, usuariosRes, realizadasRes] = await Promise.all([
        supabase.from('clientes').select('*').eq('id', clienteId).maybeSingle(),
        supabase.from('perros').select('*').eq('cliente_id', clienteId).order('created_at', { ascending: true }),
        supabase.from('usuarios_cliente').select('id', { count: 'exact', head: true }).eq('cliente_id', clienteId),
        supabase.from('citas').select('id', { count: 'exact', head: true }).eq('cliente_id', clienteId).eq('estado', 'realizada'),
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

    if (usuariosRes.error) {
        console.error('[cliente] error contando usuarios vinculados:', usuariosRes.error);
        // No abortamos: tratamos el count como 0 → el botón cae en
        // "Invitar a la app", que es el lado seguro.
    }
    const tieneUsuario = (usuariosRes.count || 0) >= 1;

    renderCliente(clienteRes.data, tieneUsuario);
    const elRealizadas = document.getElementById('cliente-clases-realizadas');
    if (elRealizadas) elRealizadas.textContent = realizadasRes.error ? '—' : String(realizadasRes.count || 0);
    renderPerros(perrosRes.data || []);
    showScreen('cliente');
}

function renderCliente(c, tieneUsuario) {
    state.cliente = c;
    setText('cliente-nombre', c.nombre || 'Sin nombre');
    setText('cliente-telefono', c.telefono || '—');
    setText('cliente-email', c.email || '—');
    setText('cliente-zona', c.zona || '—');
    setText('cliente-desde', formatearClienteDesde(c.cliente_desde));

    renderEstadoSelector((c.estado || 'consulta').toLowerCase());

    actualizarBotonInvitar(tieneUsuario);

    // Widget pack_actual
    const packInput = document.getElementById('cliente-pack-actual');
    if (packInput) packInput.value = c.pack_actual != null ? c.pack_actual : '';

    // Checkbox "habilitar próxima clase" — refleja clase_extra_habilitada
    const extraCheck = document.getElementById('cli-clase-extra');
    if (extraCheck) extraCheck.checked = !!c.clase_extra_habilitada;

    // Ubicación (Google Maps): botones Abrir/Editar o Añadir según el valor.
    renderMapsUbicacion(c.ubicacion_maps);

    document.title = `${c.nombre || 'Cliente'} — Admin PDLI`;

    // Feed de mensajes del cliente (Bloque A.3)
    renderAdminMensajes(c.id);

    // Quién puede entrar a la app (principal + familiares) — solo lectura.
    cargarMiembros(c.id);

    // Asistente Jaime (chat) con el cliente en contexto: "este cliente" resuelve solo.
    initJaime({ pantalla: 'cliente', clienteId: c.id, nombre: c.nombre || '' });
}

// El texto del botón depende de si el cliente YA fue invitado, es decir,
// si tiene al menos un usuario vinculado en usuarios_cliente. NO se mira
// el email: una ficha puede tener email cargado sin haber sido invitada.
function actualizarBotonInvitar(tieneUsuario) {
    const btn = document.getElementById('btn-invitar');
    if (!btn) return;
    btn.textContent = tieneUsuario ? 'Reenviar invitación' : 'Invitar a la app';
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

async function cargarMiembros(clienteId) {
    const lista = document.getElementById('miembros-lista');
    const empty = document.getElementById('miembros-empty');
    if (!lista || !empty) return;
    const { data, error } = await supabase
        .from('usuarios_cliente')
        .select('id, nombre, rol')
        .eq('cliente_id', clienteId)
        .order('rol', { ascending: true })       // principal antes que secundario
        .order('creado_en', { ascending: true });
    if (error) {
        console.error('[cliente] error cargando miembros:', error);
        lista.innerHTML = '';
        empty.hidden = false;
        return;
    }
    if (!data.length) {
        lista.innerHTML = '';
        empty.hidden = false;
        return;
    }
    empty.hidden = true;
    lista.innerHTML = data.map(renderMiembro).join('');
}

function renderMiembro(m) {
    const nombre = escapeHTML(m.nombre || 'Sin nombre');
    const etiqueta = m.rol === 'principal' ? 'Principal' : 'Familiar';
    return `
        <li class="miembro-fila">
            <span class="miembro-nombre">${nombre}</span>
            <span class="miembro-rol">${etiqueta}</span>
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

// ===================== Selector de estado =====================

const ESTADO_LABELS = {
    consulta: 'Consulta',
    activo: 'Activo',
    veterano: 'Veterano',
    ex_cliente: 'Ex cliente',
};

function renderEstadoSelector(estadoActual) {
    document.querySelectorAll('.estado-pill').forEach((pill) => {
        const esActivo = pill.dataset.estado === estadoActual;
        pill.classList.toggle('is-active', esActivo);
        pill.setAttribute('aria-checked', esActivo ? 'true' : 'false');
    });
}

function bindEstadoSelector() {
    document.querySelectorAll('.estado-pill').forEach((pill) => {
        pill.addEventListener('click', async () => {
            const nuevoEstado = pill.dataset.estado;
            if (!nuevoEstado || pill.classList.contains('is-active')) return;

            const estadoAnterior = state.cliente?.estado;
            renderEstadoSelector(nuevoEstado);

            document.querySelectorAll('.estado-pill').forEach((p) => { p.disabled = true; });

            const { error } = await supabase
                .from('clientes')
                .update({ estado: nuevoEstado })
                .eq('id', state.clienteId);

            document.querySelectorAll('.estado-pill').forEach((p) => { p.disabled = false; });

            if (error) {
                console.error('[cliente] error cambiando estado:', error);
                renderEstadoSelector(estadoAnterior || 'consulta');
                toast('No se pudo actualizar el estado', 'error');
                return;
            }

            if (state.cliente) state.cliente.estado = nuevoEstado;
            toast(`Estado: ${ESTADO_LABELS[nuevoEstado] || nuevoEstado}`);
        });
    });
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

// ===================== Widget pack_actual =====================

function bindWidgetPack() {
    const btn = document.getElementById('cliente-pack-guardar');
    if (btn) btn.addEventListener('click', guardarPackActual);

    const extraCheck = document.getElementById('cli-clase-extra');
    if (extraCheck) extraCheck.addEventListener('change', guardarClaseExtra);
}

// Guardado inmediato del flag "habilitar próxima clase" — sin botón.
async function guardarClaseExtra(ev) {
    if (!state.clienteId) return;
    const check = ev.target;
    const fb = document.getElementById('cli-clase-extra-feedback');
    const valor = !!check.checked;

    check.disabled = true;
    if (fb) fb.textContent = 'Guardando…';

    try {
        const { error } = await supabase
            .from('clientes')
            .update({ clase_extra_habilitada: valor })
            .eq('id', state.clienteId);
        if (error) throw error;
        if (state.cliente) state.cliente.clase_extra_habilitada = valor;
        if (fb) fb.textContent = 'Guardado ✓';
    } catch (err) {
        console.error('[cliente] error guardando clase_extra_habilitada:', err);
        // Revertimos el check al estado real para no mentir sobre lo guardado.
        check.checked = !valor;
        if (fb) fb.textContent = '';
        toast('No se pudo guardar', 'error');
    } finally {
        check.disabled = false;
    }
}

async function guardarPackActual() {
    if (!state.clienteId) return;
    const input = document.getElementById('cliente-pack-actual');
    const btn = document.getElementById('cliente-pack-guardar');
    if (!input || !btn) return;

    const raw = input.value.trim();
    const valor = raw === '' ? null : parseInt(raw, 10);
    if (raw !== '' && (!Number.isFinite(valor) || valor < 0)) {
        toast('Valor inválido', 'error');
        return;
    }

    btn.disabled = true;
    const labelPrevio = btn.textContent;
    btn.textContent = 'Guardando…';

    try {
        const { error } = await supabase
            .from('clientes')
            .update({ pack_actual: valor })
            .eq('id', state.clienteId);
        if (error) throw error;
        if (state.cliente) state.cliente.pack_actual = valor;
        toast('Pack actualizado');
    } catch (err) {
        console.error('[cliente] error guardando pack_actual:', err);
        toast('No se pudo guardar', 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = labelPrevio;
    }
}

// ===================== Ubicación (Google Maps) =====================

// Validación suave: si el enlace no empieza por http(s), anteponer https://.
// Los links de Maps tienen mil formatos (maps.app.goo.gl, google.com/maps,
// goo.gl/maps) — solo garantizamos que sea abrible.
function normalizarUrlMaps(valor) {
    const s = (valor || '').trim();
    if (!s) return s;
    return /^https?:\/\//i.test(s) ? s : 'https://' + s;
}

// Estado de solo-vista según haya enlace o no. Oculta siempre el editor inline.
function renderMapsUbicacion(valor) {
    const tiene = !!((valor || '').trim());
    document.getElementById('cli-maps-view')?.removeAttribute('hidden');
    document.getElementById('cli-maps-edit')?.setAttribute('hidden', '');
    const abrir  = document.getElementById('cli-maps-abrir');
    const editar = document.getElementById('cli-maps-editar');
    const anadir = document.getElementById('cli-maps-anadir');
    if (abrir)  abrir.hidden  = !tiene;
    if (editar) editar.hidden = !tiene;
    if (anadir) anadir.hidden = tiene;
}

function bindMapsUbicacion() {
    const view = document.getElementById('cli-maps-view');
    const edit = document.getElementById('cli-maps-edit');
    const input = document.getElementById('cli-maps-input');

    document.getElementById('cli-maps-abrir')?.addEventListener('click', () => {
        const url = normalizarUrlMaps(state.cliente?.ubicacion_maps || '');
        if (url) window.open(url, '_blank');
    });

    // Editar / Añadir → editor inline con el valor actual.
    const mostrarEdicion = () => {
        if (input) input.value = state.cliente?.ubicacion_maps || '';
        view?.setAttribute('hidden', '');
        edit?.removeAttribute('hidden');
        input?.focus();
    };
    document.getElementById('cli-maps-editar')?.addEventListener('click', mostrarEdicion);
    document.getElementById('cli-maps-anadir')?.addEventListener('click', mostrarEdicion);

    // Cancelar → descartar cambios, volver a la vista con el valor guardado.
    document.getElementById('cli-maps-cancelar')?.addEventListener('click', () => {
        renderMapsUbicacion(state.cliente?.ubicacion_maps || '');
    });

    document.getElementById('cli-maps-guardar')?.addEventListener('click', guardarUbicacionMaps);
}

// Persiste SOLO ubicacion_maps (mismo contrato que agenda/api.js: vacío
// explícito = null). Reusa el patrón de UPDATE de este archivo.
async function guardarUbicacionMaps() {
    if (!state.clienteId) return;
    const input = document.getElementById('cli-maps-input');
    const btn = document.getElementById('cli-maps-guardar');
    const raw = input?.value || '';
    const valor = raw.trim() ? normalizarUrlMaps(raw) : null;

    if (btn) { btn.disabled = true; btn.textContent = 'Guardando…'; }
    try {
        const { error } = await supabase
            .from('clientes')
            .update({ ubicacion_maps: valor })
            .eq('id', state.clienteId);
        if (error) throw error;
        if (state.cliente) state.cliente.ubicacion_maps = valor;
        renderMapsUbicacion(valor);
        toast('Ubicación guardada');
    } catch (err) {
        console.error('[cliente] error guardando ubicacion_maps:', err);
        toast('No se pudo guardar', 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Guardar'; }
    }
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

    const yaAbierto = !modal.hasAttribute('hidden');

    input.value = state.cliente.email || '';
    errorEl.hidden = true;
    errorEl.textContent = '';

    mostrarPasoModal('form');

    modal.removeAttribute('hidden');
    modal.setAttribute('aria-hidden', 'false');
    requestAnimationFrame(() => modal.classList.add('is-open'));
    document.body.style.overflow = 'hidden';
    setTimeout(() => input.focus(), 80);

    // Back navigation: pushear entrada al abrir, así el back físico la cierra.
    if (!yaAbierto && !navegandoPorPopstate) {
        history.pushState({ pdli: 'modal-invitar' }, '');
    }
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
    // Consumir la entrada que pusheamos al abrir, si el cierre vino de UI.
    if (!navegandoPorPopstate) {
        cierreUiPendiente = true;
        history.back();
    }
}

// ═══════════════════════════════════════════════════════════
// BACK NAVIGATION — captura del botón atrás Android.
// Cliente.html tiene una sola UI modal (invitar). El handler la cierra
// si está abierta; si no, deja pasar el back natural → vuelve a la
// lista de clientes del admin (index.html). No hay doble-tap aquí
// porque cliente.html es pantalla intermedia, no home.
// ═══════════════════════════════════════════════════════════

let navegandoPorPopstate = false;
let cierreUiPendiente = false;

function bindBackNavigation() {
    if (window.__backNavBoundClienteAdmin) return;
    window.__backNavBoundClienteAdmin = true;

    // Anchor inicial: garantiza que el primer back físico dispare popstate.
    history.pushState({ pdli: 'anchor' }, '');

    window.addEventListener('popstate', () => {
        // Caso especial: cierre desde UI (X/Esc/backdrop). Solo consumir.
        if (cierreUiPendiente) {
            cierreUiPendiente = false;
            history.pushState({ pdli: 'anchor' }, '');
            return;
        }

        // Prioridad 1: modal abierto → cerrar.
        const m = document.getElementById('modal-invitar');
        if (m && !m.hasAttribute('hidden')) {
            history.pushState({ pdli: 'anchor' }, '');
            navegandoPorPopstate = true;
            try { cerrarModalInvitar(); } finally { navegandoPorPopstate = false; }
            return;
        }

        // Sin modal: dejar pasar el back natural → vuelve a admin/index.html.
        history.back();
    });
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
        mostrarErrorInvitar('Email inválido.');
        return;
    }

    if (!state.clienteId) {
        mostrarErrorInvitar('Falta el ID del cliente. Recargá la página.');
        return;
    }

    errorEl.hidden = true;
    errorEl.textContent = '';
    btn.disabled = true;
    btn.textContent = 'Enviando…';

    // Todo el trabajo lo hace la edge function invitar-cliente, server-side:
    // verifica que seamos admin, UPSERT en invitaciones_pendientes, crea el
    // usuario sin correos de GoTrue y manda UN solo mail con el código de
    // acceso. Acá solo disparamos la llamada y leemos el resultado.
    const { data, error } = await supabase.functions.invoke('invitar-cliente', {
        body: {
            email,
            cliente_id: state.clienteId,
            nombre: state.cliente?.nombre,
        },
    });

    // functions.invoke: si la función responde 2xx, el cuerpo viene en
    // `data`. Si responde con error (4xx/5xx), supabase-js lo pone en
    // `error` y el cuerpo { ok, error } queda en error.context (la Response).
    let resultado = data;
    if (error?.context && typeof error.context.json === 'function') {
        resultado = await error.context.json().catch(() => null);
    }

    if (!resultado?.ok) {
        const detalle = resultado?.error || error?.message || 'No se pudo enviar la invitación.';
        console.error('[invitar] invitar-cliente falló:', { detalle, error });
        mostrarErrorInvitar(detalle);
        toast('Error al enviar la invitación', 'error');
        btn.disabled = false;
        btn.textContent = 'Enviar invitación';
        return;
    }

    // Éxito — reflejamos el nuevo email en pantalla y mostramos paso success.
    if (state.cliente) state.cliente.email = email;
    setText('cliente-email', email);
    // La invitación salió bien: el cliente ya tiene usuario vinculado.
    actualizarBotonInvitar(true);
    mostrarSuccessInvitacion(email);

    btn.disabled = false;
    btn.textContent = 'Enviar invitación';
}

function mostrarErrorInvitar(msg) {
    const errorEl = document.getElementById('invitar-error');
    if (!errorEl) return;
    errorEl.textContent = msg;
    errorEl.hidden = false;
}

function mostrarSuccessInvitacion(email) {
    document.getElementById('invitar-email-enviado').textContent = email;

    const wa = document.getElementById('invitar-whatsapp');
    const tel = telefonoParaWhatsapp(state.cliente?.telefono);
    if (tel) {
        const nombrePila = (state.cliente?.nombre || '').split(/\s+/)[0] || '';
        const saludo = nombrePila ? `Hola ${nombrePila}, ` : 'Hola, ';
        // Texto para el cliente: español neutro de España, tono PDLI.
        // Apunta al correo (que tiene enlace pre-cargado con el email)
        // en lugar de mandar al usuario a escribir el correo a mano en
        // la app pelada.
        const msg =
            `${saludo}acabamos de enviarte un correo a ${email} con tu código de acceso a la app de Perros de la Isla. ` +
            `Ábrelo y toca el enlace que verás dentro — la app se abrirá con tu correo ya puesto y solo tendrás que pegar el código de 6 dígitos. ` +
            `Si no encuentras el correo, revisa la carpeta de spam. ` +
            `Un saludo, el equipo de Perros de la Isla.`;
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

// ───────────────────────────────────────────────────────────
// Feed de mensajes del cliente (Bloque A.3)
// ───────────────────────────────────────────────────────────

function _adminEscapeHTML(s) {
    if (typeof s !== 'string') return '';
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function _adminFormatearFechaRelativa(dateStr) {
    const fecha = new Date(dateStr);
    const hoy = new Date();
    hoy.setHours(0, 0, 0, 0);
    const fechaSinHora = new Date(fecha);
    fechaSinHora.setHours(0, 0, 0, 0);
    const diffDias = Math.floor((hoy - fechaSinHora) / (1000 * 60 * 60 * 24));
    if (diffDias === 0) return 'HOY';
    if (diffDias === 1) return 'AYER';
    if (diffDias < 7) return `HACE ${diffDias} DÍAS`;
    const dias = ['DOMINGO','LUNES','MARTES','MIÉRCOLES','JUEVES','VIERNES','SÁBADO'];
    const meses = ['ENERO','FEBRERO','MARZO','ABRIL','MAYO','JUNIO','JULIO','AGOSTO','SEPTIEMBRE','OCTUBRE','NOVIEMBRE','DICIEMBRE'];
    return `${dias[fecha.getDay()]} ${fecha.getDate()} DE ${meses[fecha.getMonth()]}`;
}

function _adminFormatearHora(dateStr) {
    const f = new Date(dateStr);
    return f.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', hour12: false });
}

async function cargarMensajesCliente(clienteId) {
    // Solo mensajes generales (no notas por ejercicio). Las notas por
    // ejercicio se gestionan desde admin/perro, cerca del ejercicio.
    const { data, error } = await supabase
        .from('mensajes')
        .select(`
            id, cliente_id, perro_id, ejercicio_asignado_id,
            contenido, guardar, leido_por_admin, leido_en, created_at, autor_admin, leido_por_cliente,
            ejercicios_asignados (
                id,
                ejercicios ( nombre )
            )
        `)
        .eq('cliente_id', clienteId)
        .is('ejercicio_asignado_id', null)
        .order('created_at', { ascending: true });
    if (error) {
        console.error('[admin-mensajes] error:', error);
        return [];
    }
    return data || [];
}

async function marcarMensajesLeidos(clienteId) {
    // Mismo filtro: al entrar a la pantalla del cliente solo marcamos
    // como leídos los mensajes generales. Las notas por ejercicio se
    // marcan al abrir su bottom-sheet en admin/perro.
    const { error } = await supabase
        .from('mensajes')
        .update({ leido_por_admin: true, leido_en: new Date().toISOString() })
        .eq('cliente_id', clienteId)
        .eq('leido_por_admin', false)
        .eq('autor_admin', false)
        .is('ejercicio_asignado_id', null);
    if (error) console.error('[admin-marcar-leido] error:', error);
}

async function toggleGuardarMensaje(mensajeId, valor) {
    const { error } = await supabase
        .from('mensajes')
        .update({ guardar: valor })
        .eq('id', mensajeId);
    if (error) {
        console.error('[admin-toggle-guardar] error:', error);
        return false;
    }
    return true;
}

async function responderMensaje(clienteId, texto) {
    const { error } = await supabase.from('mensajes').insert({
        cliente_id: clienteId,
        contenido: texto,
        autor_admin: true,
        leido_por_admin: true,
        leido_por_cliente: false,
    });
    if (error) { console.error('[admin-responder] error:', error); return false; }
    return true;
}

async function renderAdminMensajes(clienteId) {
    if (!clienteId) return;
    const seccion = document.getElementById('admin-mensajes');
    const feed = document.getElementById('admin-mensajes-feed');
    const count = document.getElementById('admin-mensajes-count');
    if (!seccion || !feed) return;

    seccion.removeAttribute('hidden');

    const mensajes = await cargarMensajesCliente(clienteId);
    const noLeidos = mensajes.filter((m) => !m.leido_por_admin && !m.autor_admin).length;

    if (count) {
        const num = count.querySelector('.num');
        if (num) {
            num.textContent = noLeidos;
            num.classList.toggle('is-cero', noLeidos === 0);
        }
    }

    if (mensajes.length === 0) {
        feed.innerHTML = `
            <p style="color: var(--pdli-tinta-3); font-style: italic; padding: 12px 0;">Este cliente aún no ha enviado ningún mensaje.</p>
        `;
        return;
    }

    // Agrupar por fecha
    const porFecha = {};
    mensajes.forEach((m) => {
        const fecha = _adminFormatearFechaRelativa(m.created_at);
        if (!porFecha[fecha]) porFecha[fecha] = [];
        porFecha[fecha].push(m);
    });

    feed.innerHTML = Object.entries(porFecha).map(([fecha, items]) => `
        <div class="feed-date-row" style="padding-left:0;">
            <span class="feed-date-label">${_adminEscapeHTML(fecha)}</span>
            <span class="feed-date-rule"></span>
        </div>
        ${items.map((m) => {
            const esNota = !!m.ejercicio_asignado_id;
            const nombreEjercicio = m.ejercicios_asignados?.ejercicios?.nombre || 'ejercicio';
            const classes = ['admin-entry'];
            if (m.autor_admin) classes.push('admin-entry--mio');
            if (!m.leido_por_admin) classes.push('is-unread');
            else classes.push('is-read');
            if (m.guardar) classes.push('is-pinned');
            return `
                <div class="${classes.join(' ')}" data-mensaje-id="${_adminEscapeHTML(m.id)}">
                    <div class="admin-entry__head">
                        <span class="admin-entry__time">${_adminFormatearHora(m.created_at)}</span>
                        <span class="admin-entry__tag">
                            ${m.autor_admin ? 'Tu respuesta' : (esNota ? `Nota en <span class="ex-name">${_adminEscapeHTML(nombreEjercicio)}</span>` : 'Mensaje general')}
                        </span>
                    </div>
                    <div class="admin-entry__body">${_adminEscapeHTML(m.contenido)}</div>
                    ${m.autor_admin ? '' : `<button type="button" class="admin-entry__pin" data-action="toggle-pin" data-id="${_adminEscapeHTML(m.id)}">
                        <span class="pin-ico">📌</span>
                        ${m.guardar ? 'Guardado' : 'Guardar'}
                    </button>`}
                </div>
            `;
        }).join('')}
    `).join('');

    // Bind toggles de pin
    feed.querySelectorAll('[data-action="toggle-pin"]').forEach((btn) => {
        btn.addEventListener('click', async () => {
            const id = btn.dataset.id;
            const entry = btn.closest('.admin-entry');
            const yaPinned = entry?.classList.contains('is-pinned');
            const ok = await toggleGuardarMensaje(id, !yaPinned);
            if (ok && entry) {
                entry.classList.toggle('is-pinned');
                btn.lastChild.textContent = !yaPinned ? ' Guardado' : ' Guardar';
            }
        });
    });

    // Auto-marcar todos como leídos al entrar (UX: si el admin abre,
    // los lee). Esto desmarcará el badge de "X nuevos" en el próximo
    // render, pero por ahora dejamos el badge mostrando el conteo
    // que había al entrar para que vea cuántos eran nuevos.
    if (noLeidos > 0) {
        await marcarMensajesLeidos(clienteId);
        // refrescar opacidad sin recargar todo
        feed.querySelectorAll('.admin-entry.is-unread').forEach((el) => {
            el.classList.remove('is-unread');
            el.classList.add('is-read');
        });
    }

    const respBtn = document.getElementById('admin-responder-btn');
    const respTxt = document.getElementById('admin-responder-texto');
    if (respBtn && respTxt) {
        respBtn.onclick = async () => {
            const texto = respTxt.value.trim();
            if (!texto) return;
            respBtn.disabled = true;
            const ok = await responderMensaje(clienteId, texto);
            respBtn.disabled = false;
            if (ok) {
                respTxt.value = '';
                renderAdminMensajes(clienteId);
            }
        };
    }

    requestAnimationFrame(() => {
        const fEl = document.getElementById('admin-mensajes-feed');
        if (fEl) fEl.scrollTop = fEl.scrollHeight;
    });
}
