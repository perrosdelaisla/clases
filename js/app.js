// =====================================================================
// app.js — App del cliente Perros de la Isla.
//
// Pantallas externas (selector por id):
//   loading → login → (login-sent) → app
//   loading → app                                  (sesión activa)
//   loading → error-vinculo                        (sin usuarios_cliente)
//
// Dentro de #screen-app hay 3 tabs:
//   rutina (default) — perro + ejercicios asignados
//   reservar         — calendario de slots libres + RPC puede_cliente_reservar
//   mis-citas        — próxima clase, próximas, historial
//
// Las RLS de Supabase filtran por mi_cliente_id() — el cliente solo ve
// lo suyo en perros, planes_caso, ejercicios_asignados, citas, etc.
// =====================================================================

import { supabase } from './supabase.js';

const SCREENS = {
    loading: document.getElementById('screen-loading'),
    login: document.getElementById('screen-login'),
    'login-sent': document.getElementById('screen-login-sent'),
    'error-vinculo': document.getElementById('screen-error-vinculo'),
    welcome: document.getElementById('screen-welcome'),
    app: document.getElementById('screen-app'),
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const STORAGE_PERRO_KEY = 'pdli.perroSeleccionadoId';
const TELEFONO_PUBLICO = '622 922 173';

// Paleta determinística para fallback de foto (cuando el perro no tiene foto)
const PERRO_COLOR_PALETTE = [
    '#C8102E', '#6B7A3A', '#1f6f8b', '#a05a2c', '#8e3b8e',
    '#3a7d3e', '#b8732a', '#3f5fa3',
];

const state = {
    session: null,
    usuarioCliente: null,    // { id, auth_user_id, cliente_id, nombre, ... }
    cliente: null,           // { id, pack_actual, ... } — datos del cliente dueño
    perros: [],              // ordenados por created_at asc
    perroSeleccionadoId: null,
    citas: [],               // todas las citas del cliente (cualquier estado)
    currentTab: 'rutina',
    rutinaCategoriaActiva: 'ejercicio',  // sub-pestaña activa dentro de Rutina
    reservandoSlot: null,    // { fecha, hora, label } cuando se abre modal
    citaACancelar: null,     // cita object cuando se abre modal
    fotoSeleccionada: null,  // { file, dataUrl } cuando hay preview en modal foto
};

// Mapeo de citas.protocolo (técnico) a label cliente
const PROTOCOLO_LABEL_CLIENTE = {
    cachorros:    'Educación del cachorro',
    basica:       'Educación básica',
    separacion:   'Modificación de conducta',
    generalizada: 'Modificación de conducta',
    miedos:       'Modificación de conducta',
    reactividad:  'Modificación de conducta',
    posesion:     'Modificación de conducta',
};

document.addEventListener('DOMContentLoaded', () => {
    bindEventos();
    registrarServiceWorker();
    bootstrapPwaBanner();
    bootstrap();

    supabase.auth.onAuthStateChange((event, session) => {
        if (event === 'SIGNED_IN' || event === 'INITIAL_SESSION') {
            if (session) onSesionLista(session);
        } else if (event === 'SIGNED_OUT') {
            state.session = null;
            state.usuarioCliente = null;
            state.cliente = null;
            state.perros = [];
            state.perroSeleccionadoId = null;
            state.citas = [];
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

        // Datos en paralelo: cliente + perros + citas
        const [cliente, perros, citas] = await Promise.all([
            cargarCliente(usuarioCliente.cliente_id),
            cargarPerros(),
            cargarCitasCliente(),
        ]);
        state.cliente = cliente;
        state.perros = perros;
        state.citas = citas;

        // Recuperar perro seleccionado de sesión previa si sigue siendo válido
        const guardado = sessionStorage.getItem(STORAGE_PERRO_KEY);
        if (guardado && perros.some((p) => p.id === guardado)) {
            state.perroSeleccionadoId = guardado;
        } else {
            state.perroSeleccionadoId = perros[0]?.id || null;
        }

        renderHeader();
        renderSelectorPerros();
        await renderRutinaPerroSeleccionado();

        // Primer login: si el cliente nunca vio el welcome, mostrarlo
        // antes de la app principal. UPDATE de welcome_visto_en al
        // confirmar con el botón "Empezar".
        if (!state.usuarioCliente.welcome_visto_en) {
            mostrarWelcomeEditorial();
            return;
        }

        showScreen('app');
        showTab(state.currentTab);
    } catch (err) {
        console.error('[app] error cargando datos:', err);
        showScreen('error-vinculo');
    }
}

function mostrarWelcomeEditorial() {
    const nombrePerro = state.perros[0]?.nombre || 'tu perro';
    setText('welcome-perro-nombre', nombrePerro);
    showScreen('welcome');
}

async function confirmarWelcomeVisto() {
    const btn = document.getElementById('welcome-empezar');
    if (btn) btn.disabled = true;

    try {
        const ahora = new Date().toISOString();
        const { error } = await supabase
            .from('usuarios_cliente')
            .update({ welcome_visto_en: ahora })
            .eq('id', state.usuarioCliente.id);
        if (error) throw error;
        state.usuarioCliente.welcome_visto_en = ahora;
    } catch (err) {
        console.error('[app] no se pudo marcar welcome_visto_en:', err);
        // Aunque falle el UPDATE, dejamos pasar al usuario — la próxima
        // vez le volverá a aparecer, pero al menos no se queda trabado.
    } finally {
        if (btn) btn.disabled = false;
    }

    showScreen('app');
    showTab(state.currentTab);

    // Una vez cerrado el welcome, el banner PWA puede volver a evaluarse.
    if (puedeMostrarseBanner()) intentarMostrarBanner();
}

// ===================== Bindings =====================

function bindEventos() {
    // Login
    const form = document.getElementById('login-form');
    if (form) form.addEventListener('submit', enviarMagicLink);

    const otraVez = document.getElementById('login-otra-vez');
    if (otraVez) otraVez.addEventListener('click', () => {
        document.getElementById('login-email').value = '';
        showScreen('login');
    });

    const errorLogout = document.getElementById('error-logout');
    if (errorLogout) errorLogout.addEventListener('click', cerrarSesion);

    // Welcome editorial (primer login)
    const welcomeBtn = document.getElementById('welcome-empezar');
    if (welcomeBtn) welcomeBtn.addEventListener('click', confirmarWelcomeVisto);

    // Avatar / logout
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

    // Bottom nav
    document.querySelectorAll('.bottom-nav__btn').forEach((btn) => {
        btn.addEventListener('click', () => showTab(btn.dataset.tabTarget));
    });

    // CTA "Reservar próxima clase" en tab Rutina
    const ctaReservar = document.getElementById('btn-ir-reservar');
    if (ctaReservar) ctaReservar.addEventListener('click', () => showTab('reservar'));

    // CTA "Empezar →" de la card de evaluación de salud comportamental.
    // Abre La Isla en pestaña nueva con perro_id, cliente_id y origen.
    document.getElementById('btn-iniciar-evaluacion')?.addEventListener('click', abrirLaIsla);
    document.getElementById('btn-iniciar-evaluacion-empty')?.addEventListener('click', abrirLaIsla);
    document.getElementById('btn-nueva-evaluacion')?.addEventListener('click', abrirLaIsla);

    // Foto del perro
    const fotoBtn = document.getElementById('perro-foto-btn');
    if (fotoBtn) fotoBtn.addEventListener('click', abrirModalFoto);

    const fotoInput = document.getElementById('foto-input');
    if (fotoInput) fotoInput.addEventListener('change', onFotoSeleccionada);

    const fotoGuardar = document.getElementById('foto-guardar');
    if (fotoGuardar) fotoGuardar.addEventListener('click', guardarFotoPerro);

    // Modales: cierres genéricos por data-close
    document.querySelectorAll('.modal-pdli').forEach((modal) => {
        modal.addEventListener('click', (e) => {
            if (e.target.closest('[data-close]')) cerrarModal(modal.id);
        });
    });
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        document.querySelectorAll('.modal-pdli:not([hidden])').forEach((m) => cerrarModal(m.id));
    });

    // Reservar cita (botón confirmar dentro del modal)
    const btnReservarConfirmar = document.getElementById('modal-reservar-confirmar');
    if (btnReservarConfirmar) btnReservarConfirmar.addEventListener('click', confirmarReserva);

    // Cancelar cita (botón confirmar dentro del modal)
    const btnCancelarConfirmar = document.getElementById('modal-cancelar-confirmar');
    if (btnCancelarConfirmar) btnCancelarConfirmar.addEventListener('click', confirmarCancelacion);

    // Sub-pestañas dentro de Rutina
    document.querySelectorAll('.rutina-subtab').forEach((btn) => {
        btn.addEventListener('click', () => {
            const cat = btn.dataset.cat;
            if (!cat || cat === state.rutinaCategoriaActiva) return;

            // Actualizar estado visual
            document.querySelectorAll('.rutina-subtab').forEach((b) => {
                const isActive = b.dataset.cat === cat;
                b.classList.toggle('is-active', isActive);
                b.setAttribute('aria-selected', isActive ? 'true' : 'false');
            });

            // Re-render con nueva categoría
            state.rutinaCategoriaActiva = cat;
            renderRutinaPerroSeleccionado();
        });
    });
}

// ===================== Login =====================

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
            : 'No se pudo enviar el email. Inténtalo de nuevo.';
        errEl.hidden = false;
    } finally {
        btn.disabled = false;
        btn.textContent = 'Enviar enlace';
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

async function cargarCliente(clienteId) {
    if (!clienteId) return null;
    const { data, error } = await supabase
        .from('clientes')
        .select('id, pack_actual')
        .eq('id', clienteId)
        .maybeSingle();
    if (error) {
        console.error('[app] error cargando cliente:', error);
        return null;
    }
    return data || null;
}

async function cargarCitasCliente() {
    if (!state.usuarioCliente?.cliente_id) return [];
    // RLS filtra a citas del cliente propio.
    const { data, error } = await supabase
        .from('citas')
        .select('*')
        .order('fecha', { ascending: true })
        .order('hora', { ascending: true });
    if (error) {
        console.error('[app] error cargando citas:', error);
        return [];
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

async function cargarSlotsDisponibles(desdeIso, hastaIso) {
    // Llamada a la RPC compartida con Victoria.
    // p_min_dias_antelacion = 0 porque la regla de antelación entre clases
    // la maneja puede_cliente_reservar() vía puede_reservar_desde.
    const { data, error } = await supabase.rpc('get_available_slots', {
        p_desde: desdeIso,
        p_hasta: hastaIso,
        p_min_dias_antelacion: 0,
    });
    if (error) {
        console.error('[app] error cargando slots disponibles:', error);
        return [];
    }
    return data || [];
}

async function llamarPuedeReservar() {
    const clienteId = state.usuarioCliente?.cliente_id;
    if (!clienteId) return { razon: 'sin_primera_clase' };
    try {
        const { data, error } = await supabase.rpc('puede_cliente_reservar', { cliente_id: clienteId });
        if (error) throw error;
        return data || { razon: 'sin_primera_clase' };
    } catch (err) {
        console.error('[app] RPC puede_cliente_reservar falló:', err);
        return { razon: 'sin_primera_clase' };
    }
}

// ===================== Tabs =====================

function showTab(name) {
    if (!name) return;
    state.currentTab = name;

    document.querySelectorAll('.tab-panel').forEach((panel) => {
        const match = panel.dataset.tab === name;
        if (match) panel.removeAttribute('hidden');
        else panel.setAttribute('hidden', '');
        panel.classList.toggle('is-active', match);
    });

    document.querySelectorAll('.bottom-nav__btn').forEach((btn) => {
        btn.classList.toggle('is-active', btn.dataset.tabTarget === name);
    });

    // Render de cada tab al cambiarse (data fresca)
    if (name === 'reservar') renderTabReservar();
    if (name === 'mis-citas') renderTabMisCitas();
    if (name === 'salud') cargarTabSalud();

    // Scroll al inicio del panel para que la transición se sienta limpia
    window.scrollTo({ top: 0, behavior: 'instant' });
}

// ===================== Salud comportamental → La Isla =====================

function abrirLaIsla() {
    const perro = state.perros.find((p) => p.id === state.perroSeleccionadoId);
    if (!perro || !state.cliente) return;
    const url = new URL('https://perrosdelaisla.github.io/isla/');
    url.searchParams.set('perro_id', perro.id);
    url.searchParams.set('cliente_id', state.cliente.id);
    url.searchParams.set('origen', 'cliente_activo');
    window.open(url.toString(), '_blank', 'noopener');
}

async function cargarTabSalud() {
    const loadingEl = document.getElementById('salud-loading');
    const emptyEl = document.getElementById('salud-empty');
    const contentEl = document.getElementById('salud-content');
    if (!loadingEl || !emptyEl || !contentEl) return;

    const perro = state.perros.find((p) => p.id === state.perroSeleccionadoId);

    loadingEl.removeAttribute('hidden');
    emptyEl.setAttribute('hidden', '');
    contentEl.setAttribute('hidden', '');

    if (!perro) {
        loadingEl.setAttribute('hidden', '');
        document.getElementById('salud-empty-perro').textContent = 'tu perro';
        emptyEl.removeAttribute('hidden');
        return;
    }

    const { data, error } = await supabase.rpc('listar_evaluaciones_perro', {
        p_perro_id: perro.id,
    });

    loadingEl.setAttribute('hidden', '');

    if (error) {
        console.error('[salud] error cargando:', error);
        document.getElementById('salud-empty-perro').textContent = perro.nombre || 'tu perro';
        emptyEl.removeAttribute('hidden');
        return;
    }

    if (!data || data.length === 0) {
        document.getElementById('salud-empty-perro').textContent = perro.nombre || 'tu perro';
        emptyEl.removeAttribute('hidden');
        return;
    }

    const ultima = data[0];
    document.getElementById('salud-ultima-fecha').textContent = formatearFechaSalud(ultima.created_at);
    document.getElementById('salud-ultima-total').textContent = ultima.score_total + '/100';
    document.getElementById('salud-ultima-scores').innerHTML = `
        <div class="salud-score-item"><span class="salud-score-num">${ultima.score_fisica}</span><span class="salud-score-label">Física</span></div>
        <div class="salud-score-item"><span class="salud-score-num">${ultima.score_emocional}</span><span class="salud-score-label">Emocional</span></div>
        <div class="salud-score-item"><span class="salud-score-num">${ultima.score_social}</span><span class="salud-score-label">Social</span></div>
        <div class="salud-score-item"><span class="salud-score-num">${ultima.score_cognitiva}</span><span class="salud-score-label">Cognitiva</span></div>
    `;

    document.getElementById('salud-historico-lista').innerHTML = data.map((ev) => `
        <li class="salud-historico-item">
            <span class="salud-historico-fecha">${formatearFechaSalud(ev.created_at)}</span>
            <span class="salud-historico-total">${ev.score_total}/100</span>
        </li>
    `).join('');

    contentEl.removeAttribute('hidden');
}

function formatearFechaSalud(iso) {
    const d = new Date(iso);
    return d.toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' });
}

// ===================== Tab Rutina =====================

function renderHeader() {
    const u = state.usuarioCliente;
    const nombreCompleto = (u?.nombre || u?.nombre_visible || '').trim();

    // Saltear palabras genéricas / de prueba al elegir el "nombre de pila"
    // visible. Evita saludos tipo "Hola, Cliente" cuando el alta vino
    // con un nombre tipo "Cliente Prueba Charly".
    const PALABRAS_GENERICAS = ['cliente', 'prueba', 'test', 'usuario', 'demo'];
    const palabras = nombreCompleto.split(/\s+/).filter(Boolean);
    const primeraReal = palabras.find((p) => !PALABRAS_GENERICAS.includes(p.toLowerCase()));
    const nombrePila = primeraReal || palabras[0] || 'amigo';

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
    const heroMeta = document.getElementById('perro-hero-meta');
    const protoBox = document.getElementById('perro-protocolo');
    const protoNombre = document.getElementById('perro-protocolo-nombre');
    const protoDuracion = document.getElementById('perro-protocolo-duracion');
    const saldoBox = document.getElementById('perro-saldo');
    const saldoPack = document.getElementById('perro-saldo-pack');
    const saldoDetalle = document.getElementById('perro-saldo-detalle');
    const fotoImg = document.getElementById('perro-foto-img');
    const fotoFallback = document.getElementById('perro-foto-fallback');
    const fotoBtn = document.getElementById('perro-foto-btn');
    const lista = document.getElementById('rutina-lista');
    const loading = document.getElementById('rutina-loading');
    const empty = document.getElementById('rutina-empty');
    const sinPerro = document.getElementById('rutina-sin-perro');
    const cardSalud = document.getElementById('card-salud');
    const cardSaludNombre = document.getElementById('card-salud-perro');

    // Reset
    lista.innerHTML = '';
    lista.setAttribute('hidden', '');
    empty.setAttribute('hidden', '');
    sinPerro.setAttribute('hidden', '');
    loading.removeAttribute('hidden');
    protoBox.setAttribute('hidden', '');
    saldoBox.setAttribute('hidden', '');
    cardSalud?.setAttribute('hidden', '');

    const perro = state.perros.find((p) => p.id === state.perroSeleccionadoId);

    if (!perro) {
        loading.setAttribute('hidden', '');
        hero.setAttribute('hidden', '');
        sinPerro.removeAttribute('hidden');
        return;
    }

    // Hero
    hero.removeAttribute('hidden');
    heroNombre.textContent = perro.nombre || 'Tu perro';
    const partesMeta = [perro.raza, formatearEdadPerro(perro)].filter(Boolean);
    heroMeta.textContent = partesMeta.join(' · ');

    // Card "Evalúa la salud comportamental"
    if (cardSalud) {
        if (cardSaludNombre) cardSaludNombre.textContent = perro.nombre || 'tu perro';
        cardSalud.removeAttribute('hidden');
    }

    // Foto
    if (perro.foto_url) {
        fotoImg.src = perro.foto_url;
        fotoImg.removeAttribute('hidden');
        fotoFallback.setAttribute('hidden', '');
    } else {
        fotoImg.removeAttribute('src');
        fotoImg.setAttribute('hidden', '');
        fotoFallback.removeAttribute('hidden');
        fotoFallback.textContent = (perro.nombre?.[0] || 'P').toUpperCase();
        fotoBtn.style.setProperty('--perro-color', colorParaPerro(perro.id));
    }

    // Protocolo (label cliente + duración estimada)
    const proto = formatearProtocolo(perro, state.citas);
    if (proto && proto.nombre) {
        protoNombre.textContent = proto.nombre;
        protoDuracion.textContent = proto.duracion;
        protoBox.removeAttribute('hidden');
    }

    // Saldo del pack
    const pack = calcularEstadoPack(state.cliente, state.citas);
    if (pack.pack_actual != null) {
        saldoPack.textContent = pack.pack_actual;
        saldoDetalle.textContent = formatearDetallePack(pack);
        saldoBox.removeAttribute('hidden');
    }

    // Ejercicios
    try {
        const filas = await cargarRutinaDelPerro(perro.id);

        if (filas.length === 0) {
            empty.removeAttribute('hidden');
            return;
        }

        const filasFiltradas = filas.filter((row) => {
            const cat = row.ejercicios?.categoria || 'ejercicio';
            return cat === state.rutinaCategoriaActiva;
        });

        if (filasFiltradas.length === 0) {
            lista.setAttribute('hidden', '');
            empty.removeAttribute('hidden');
        } else {
            lista.innerHTML = filasFiltradas.map(renderRutinaCard).join('');
            lista.removeAttribute('hidden');
            empty.setAttribute('hidden', '');
        }
    } catch (err) {
        empty.removeAttribute('hidden');
        toast('No pudimos cargar la rutina. Inténtalo de nuevo.', 'error');
    } finally {
        // Garantizar que el spinner siempre se oculta — evita "Cargando…"
        // colgado si la función se invoca varias veces seguidas o si hay
        // un return temprano en una rama futura.
        loading.setAttribute('hidden', '');
    }
}

function renderRutinaCard(row) {
    const ej = row.ejercicios;
    if (!ej) return '';
    const nombre = escapeHTML(ej.nombre || 'Ejercicio');
    return `
        <li class="rutina-card">
            <div class="rutina-card__head">
                <h3 class="rutina-card__nombre">${nombre}</h3>
            </div>
        </li>
    `;
}

// ===================== Pack y protocolo (hero) =====================

// Devuelve el estado del pack del cliente:
//   { pack_actual, realizadas_del_pack, confirmadas_futuras_del_pack,
//     por_reservar, proximo_numero }
// Si el cliente no tiene pack_actual cargado, devuelve {pack_actual: null}.
function calcularEstadoPack(cliente, citasCliente) {
    const pack = cliente?.pack_actual;
    if (pack == null) return { pack_actual: null };

    const hoyIso = new Date().toISOString().slice(0, 10);

    // Citas con numero_clase NOT NULL, orden desc por numero_clase
    const numeradas = (citasCliente || [])
        .filter((c) => c.numero_clase != null)
        .slice()
        .sort((a, b) => b.numero_clase - a.numero_clase);

    // Las N más recientes son "el pack actual"
    const enPack = numeradas.slice(0, pack);
    const nums = enPack.map((c) => c.numero_clase);
    const rangoMin = nums.length ? Math.min(...nums) : null;
    const rangoMax = nums.length ? Math.max(...nums) : null;

    let realizadas = 0;
    let confirmadasFuturas = 0;
    enPack.forEach((c) => {
        if (c.estado === 'realizada') realizadas++;
        else if (c.estado === 'confirmada' && c.fecha >= hoyIso) confirmadasFuturas++;
    });

    const porReservar = Math.max(0, pack - realizadas - confirmadasFuturas);

    // proximo_numero: max(numero_clase) sobre todas las citas confirmadas o
    // realizadas (cualquier pack), + 1. Si no hay ninguna, 1.
    let maxGlobal = 0;
    (citasCliente || []).forEach((c) => {
        if (c.numero_clase == null) return;
        if (c.estado !== 'confirmada' && c.estado !== 'realizada') return;
        if (c.numero_clase > maxGlobal) maxGlobal = c.numero_clase;
    });
    const proximoNumero = maxGlobal + 1;

    return {
        pack_actual: pack,
        realizadas_del_pack: realizadas,
        confirmadas_futuras_del_pack: confirmadasFuturas,
        por_reservar: porReservar,
        proximo_numero: proximoNumero,
        rango_min: rangoMin,
        rango_max: rangoMax,
    };
}

// Devuelve { nombre, duracion } o null si no hay protocolo conocido.
// Toma el protocolo de la última cita con numero_clase del cliente.
function formatearProtocolo(perro, citasCliente) {
    if (!perro) return null;
    const numeradas = (citasCliente || [])
        .filter((c) => c.numero_clase != null)
        .slice()
        .sort((a, b) => b.numero_clase - a.numero_clase);
    const ultima = numeradas[0];
    if (!ultima || !ultima.protocolo) return null;

    const nombre = PROTOCOLO_LABEL_CLIENTE[ultima.protocolo];
    if (!nombre) return null;

    let duracion;
    if (nombre === 'Educación del cachorro' || nombre === 'Educación básica') {
        duracion = 'Suele llevar 4 clases.';
    } else if (nombre === 'Modificación de conducta') {
        duracion = perro.caso_complejo
            ? 'Suele llevar entre 4 y 12 clases, hasta 14 en casos como el suyo.'
            : 'Suele llevar entre 4 y 12 clases.';
    } else {
        duracion = '';
    }

    return { nombre, duracion };
}

// Formatea "{realizadas} realizada(s) · {futuras} reservada(s) · {por_reservar} por reservar"
// Elimina los segmentos en cero. Cierra con frase distinta si pack ya está
// reservado entero o si aún no hay clases agendadas.
function formatearDetallePack(pack) {
    const partes = [];
    const r = pack.realizadas_del_pack;
    const f = pack.confirmadas_futuras_del_pack;
    const x = pack.por_reservar;

    if (r > 0) partes.push(`${r} realizada${r === 1 ? '' : 's'}`);
    if (f > 0) partes.push(`${f} reservada${f === 1 ? '' : 's'}`);
    if (x > 0) partes.push(`${x} por reservar`);

    if (!partes.length) return 'Aún no hay clases agendadas.';

    let out = partes.join(' · ');
    if (x === 0 && f > 0) out += ' · Pack completo, todas reservadas.';
    return out;
}

// ===================== Tab Reservar =====================

async function renderTabReservar() {
    const cont = document.getElementById('reservar-content');
    const sub = document.getElementById('reservar-subtitulo');
    if (!cont) return;

    const perro = state.perros.find((p) => p.id === state.perroSeleccionadoId);
    const nombrePerro = perro?.nombre || 'tu perro';
    sub.textContent = `Elige cuándo quieres tu próxima clase con ${nombrePerro}`;

    cont.innerHTML = '<div class="placeholder placeholder--soft"><p>Cargando…</p></div>';

    const estado = await llamarPuedeReservar();

    if (estado.razon === 'sin_primera_clase') {
        cont.innerHTML = `
            <div class="reservar-msg">
                <h3>Aún no tienes tu primera clase reservada</h3>
                <p>La primera clase la coordina el adiestrador contigo. Si tienes dudas, escríbenos al ${TELEFONO_PUBLICO}.</p>
            </div>
        `;
        return;
    }

    if (estado.razon === 'muy_pronto') {
        const desde = estado.puede_reservar_desde
            ? formatearFechaLarga(estado.puede_reservar_desde)
            : 'pronto';
        cont.innerHTML = `
            <div class="reservar-msg">
                <h3>Tu próxima clase estará disponible para reservar el ${desde}</h3>
                <p>Dejamos al menos 5 días entre clase y clase para que ${escapeHTML(nombrePerro)} practique lo aprendido.</p>
            </div>
        `;
        return;
    }

    if (estado.razon === 'limite_alcanzado') {
        const reservas = estado.reservas_actuales ?? '';
        cont.innerHTML = `
            <div class="reservar-msg">
                <h3>Ya has reservado ${reservas} clase${reservas === 1 ? '' : 's'} por adelantado</h3>
                <p>Si quieres reservar más, hablalo con el adiestrador en la próxima clase.</p>
            </div>
        `;
        return;
    }

    // razon === 'ok' → decidir copy y calendario según estado del pack
    const pack = calcularEstadoPack(state.cliente, state.citas);

    // 1) Sin pack registrado → no se renderiza calendario
    if (pack.pack_actual == null) {
        cont.innerHTML = `
            <div class="reservar-aviso reservar-aviso--cuidado">
                <h3>Tu adiestrador está coordinando tu pack</h3>
                <p>Te avisaremos cuando puedas reservar.</p>
            </div>
        `;
        return;
    }

    // 2) Pack completo, todas las clases ya reservadas/realizadas
    if (pack.por_reservar === 0) {
        cont.innerHTML = `
            <div class="reservar-aviso reservar-aviso--cuidado">
                <h3>Tu pack actual está completo</h3>
                <p>Cuando quieras continuar, hablalo con el adiestrador en la próxima clase.</p>
            </div>
        `;
        return;
    }

    // 3) Hay clases por reservar → mostramos copy editorial + calendario
    const desdeIso = new Date().toISOString().slice(0, 10);
    const hastaIso = sumarDiasIso(desdeIso, 8 * 7); // 8 semanas

    const minIso = estado.puede_reservar_desde && estado.puede_reservar_desde > desdeIso
        ? estado.puede_reservar_desde
        : desdeIso;

    const slotsDisponibles = await cargarSlotsDisponibles(minIso, hastaIso);
    const grid = construirGridDeSlots(slotsDisponibles);

    const x = pack.por_reservar;
    const sPlural = x === 1 ? '' : 's';
    const verbo = x === 1 ? 'Te queda' : 'Te quedan';

    cont.innerHTML = `
        <div class="reservar-aviso">
            <h3>${verbo} ${x} clase${sPlural} por reservar del pack</h3>
            <p class="reservar-aviso__sub">Cuando agendes, será la clase ${pack.proximo_numero} de ${escapeHTML(nombrePerro)}.</p>
            <p class="reservar-aviso__nota">Cada clase tiene un para qué dentro del proceso. No son sesiones sueltas.</p>
        </div>
        <div class="reservar-calendario">
            ${grid}
        </div>
    `;

    // Wire up los slots disponibles
    cont.querySelectorAll('.slot-card.is-libre').forEach((el) => {
        el.addEventListener('click', () => {
            const fecha = el.dataset.fecha;
            const hora = el.dataset.hora;
            const label = el.dataset.label;
            abrirModalReservar({ fecha, hora, label });
        });
    });
}

function construirGridDeSlots(slotsDisponibles) {
    if (!slotsDisponibles.length) {
        return '<div class="reservar-msg"><p>No hay horarios disponibles en este momento. Vuelve a probar más tarde.</p></div>';
    }

    // Agrupar por fecha respetando el orden que devuelve la RPC.
    const porFecha = {};
    const ordenFechas = [];
    slotsDisponibles.forEach((s) => {
        const fechaIso = s.fecha;
        const hora = typeof s.hora === 'string' ? s.hora.substring(0, 5) : s.hora;
        if (!porFecha[fechaIso]) {
            porFecha[fechaIso] = [];
            ordenFechas.push(fechaIso);
        }
        porFecha[fechaIso].push(hora);
    });

    const html = [];
    ordenFechas.forEach((isoDia) => {
        const horasDelDia = porFecha[isoDia];
        const labelDia = formatearFechaLarga(isoDia);
        html.push(`<div class="reservar-dia">`);
        html.push(`<h4 class="reservar-dia__label">${labelDia}</h4>`);
        html.push(`<div class="reservar-dia__slots">`);
        horasDelDia.forEach((hora) => {
            const label = `${labelDia} · ${hora}`;
            html.push(`
                <button type="button" class="slot-card is-libre"
                        data-fecha="${isoDia}" data-hora="${hora}"
                        data-label="${escapeHTML(label)}">
                    <span class="slot-card__hora">${hora}</span>
                </button>
            `);
        });
        html.push(`</div></div>`);
    });

    return html.join('');
}

function abrirModalReservar({ fecha, hora, label }) {
    state.reservandoSlot = { fecha, hora, label };
    const perro = state.perros.find((p) => p.id === state.perroSeleccionadoId);
    setText('modal-reservar-slot', label || `${formatearFechaLarga(fecha)} · ${hora}`);
    setText('modal-reservar-perro', perro?.nombre || 'tu perro');
    const err = document.getElementById('modal-reservar-error');
    err.textContent = '';
    err.hidden = true;
    abrirModal('modal-reservar');
}

async function confirmarReserva() {
    const slot = state.reservandoSlot;
    if (!slot) return;
    const btn = document.getElementById('modal-reservar-confirmar');
    const err = document.getElementById('modal-reservar-error');
    btn.disabled = true;
    btn.textContent = 'Reservando…';
    err.hidden = true;

    const clienteId = state.usuarioCliente?.cliente_id;
    const horaCompleta = slot.hora.length === 5 ? `${slot.hora}:00` : slot.hora;

    try {
        // 1) Crear cita
        const { data: citaData, error: citaErr } = await supabase
            .from('citas')
            .insert({
                cliente_id:    clienteId,
                fecha:         slot.fecha,
                hora:          horaCompleta,
                estado:        'confirmada',
                confirmada:    true,
                modalidad:     'presencial',
                tipo_reserva:  'siguiente',
            })
            .select()
            .single();
        if (citaErr) throw citaErr;

        // 2) Crear bloqueo "Auto: cita {id}" — sigue el patrón del admin
        const { error: bloqErr } = await supabase
            .from('bloqueos')
            .insert({
                fecha:  slot.fecha,
                hora:   horaCompleta,
                motivo: `Auto: cita ${citaData.id}`,
            });
        if (bloqErr) {
            // No revertimos — la cita quedó válida. Solo loggeamos.
            console.warn('[app] Cita creada pero falló crear bloqueo:', bloqErr);
        }

        cerrarModal('modal-reservar');
        toast('Reserva confirmada');
        state.reservandoSlot = null;

        // Recargar citas y saltar a Mis citas
        state.citas = await cargarCitasCliente();
        showTab('mis-citas');
    } catch (e) {
        console.error('[app] error reservando cita:', e);
        err.textContent = 'No se pudo reservar. Inténtalo de nuevo.';
        err.hidden = false;
    } finally {
        btn.disabled = false;
        btn.textContent = 'Sí, reservar';
    }
}

// ===================== Tab Mis citas =====================

function renderTabMisCitas() {
    const cont = document.getElementById('mis-citas-content');
    if (!cont) return;

    const ahora = new Date();
    const todayIso = ahora.toISOString().slice(0, 10);

    // Próximas (futuras o de hoy con hora futura) confirmadas, ordenadas asc
    const proximas = state.citas
        .filter((c) => c.estado === 'confirmada')
        .filter((c) => {
            if (c.fecha > todayIso) return true;
            if (c.fecha < todayIso) return false;
            // mismo día: comparar hora
            return _datetimeCita(c) >= ahora;
        })
        .sort(_compararCitasAsc);

    // Pasadas o realizadas (historial)
    const historial = state.citas
        .filter((c) => {
            if (c.estado === 'realizada') return true;
            if (c.estado === 'cancelada') return false;
            // confirmada en el pasado
            return _datetimeCita(c) < ahora;
        })
        .sort((a, b) => _compararCitasAsc(b, a));

    if (!proximas.length && !historial.length) {
        cont.innerHTML = `
            <div class="reservar-msg">
                <p>No tienes clases reservadas todavía.</p>
                <button type="button" class="btn-cta" id="ir-reservar-empty">Reservar próxima clase</button>
            </div>
        `;
        const btn = document.getElementById('ir-reservar-empty');
        if (btn) btn.addEventListener('click', () => showTab('reservar'));
        return;
    }

    const [destacada, ...resto] = proximas;
    const html = [];

    if (destacada) {
        html.push(`<h3 class="seccion-titulo">Próxima clase</h3>`);
        html.push(renderCitaDestacada(destacada, ahora));
    }
    if (resto.length) {
        html.push(`<h3 class="seccion-titulo">Próximas clases</h3>`);
        html.push(`<div class="cita-lista">${resto.map((c) => renderCitaItem(c, ahora)).join('')}</div>`);
    }
    if (historial.length) {
        html.push(`
            <details class="historial">
                <summary class="historial__summary">Historial (${historial.length})</summary>
                <div class="cita-lista cita-lista--hist">
                    ${historial.map((c) => renderCitaHistorial(c)).join('')}
                </div>
            </details>
        `);
    }

    cont.innerHTML = html.join('');

    // Wire up botones cancelar
    cont.querySelectorAll('[data-cancelar-cita]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const id = btn.dataset.cancelarCita;
            const cita = state.citas.find((c) => c.id === id);
            if (cita) abrirModalCancelar(cita);
        });
    });
}

function renderCitaDestacada(cita, ahora) {
    const dt = _datetimeCita(cita);
    const fecha = formatearFechaLarga(cita.fecha).toUpperCase();
    const hora = (cita.hora || '').substring(0, 5);
    const cuanto = cuantoFalta(dt, ahora);
    const horasFaltan = (dt - ahora) / 36e5;
    const cancelable = horasFaltan > 24;
    return `
        <article class="cita-destacada">
            ${cita.numero_clase != null ? `<span class="cita-numero">Clase ${cita.numero_clase}</span>` : ''}
            <p class="cita-destacada__fecha">${escapeHTML(fecha)}</p>
            <p class="cita-destacada__hora">${escapeHTML(hora)}</p>
            <p class="cita-destacada__cuanto">${escapeHTML(cuanto)}</p>
            <span class="badge badge--ok">Confirmada</span>
            ${cancelable
                ? `<button type="button" class="cita-cancelar-btn" data-cancelar-cita="${escapeHTML(cita.id)}">Cancelar</button>`
                : `<p class="cita-destacada__nota">Para cancelar, escribe al ${TELEFONO_PUBLICO}</p>`}
        </article>
    `;
}

function renderCitaItem(cita, ahora) {
    const dt = _datetimeCita(cita);
    const fecha = formatearFechaLarga(cita.fecha).toUpperCase();
    const hora = (cita.hora || '').substring(0, 5);
    const cuanto = cuantoFalta(dt, ahora);
    const horasFaltan = (dt - ahora) / 36e5;
    const cancelable = horasFaltan > 24;
    return `
        <article class="cita-item">
            <div class="cita-item__main">
                <p class="cita-item__fecha">${cita.numero_clase != null ? `<span class="cita-numero cita-numero--inline">Clase ${cita.numero_clase}</span> · ` : ''}${escapeHTML(fecha)} · ${escapeHTML(hora)}</p>
                <p class="cita-item__cuanto">${escapeHTML(cuanto)}</p>
            </div>
            ${cancelable
                ? `<button type="button" class="cita-cancelar-btn cita-cancelar-btn--small" data-cancelar-cita="${escapeHTML(cita.id)}">Cancelar</button>`
                : ''}
        </article>
    `;
}

function renderCitaHistorial(cita) {
    const fecha = formatearFechaLarga(cita.fecha).toUpperCase();
    const hora = (cita.hora || '').substring(0, 5);
    const icono = cita.estado === 'realizada' ? '✅' : cita.estado === 'cancelada' ? '❌' : '·';
    return `
        <article class="cita-item cita-item--hist">
            <span class="cita-item__icono">${icono}</span>
            <p class="cita-item__fecha">${cita.numero_clase != null ? `<span class="cita-numero cita-numero--hist">Clase ${cita.numero_clase}</span> ` : ''}${escapeHTML(fecha)} · ${escapeHTML(hora)}</p>
        </article>
    `;
}

function abrirModalCancelar(cita) {
    state.citaACancelar = cita;
    const fecha = formatearFechaLarga(cita.fecha).toUpperCase();
    const hora = (cita.hora || '').substring(0, 5);
    setText('modal-cancelar-slot', `${fecha} · ${hora}`);
    const err = document.getElementById('modal-cancelar-error');
    err.textContent = '';
    err.hidden = true;
    abrirModal('modal-cancelar');
}

async function confirmarCancelacion() {
    const cita = state.citaACancelar;
    if (!cita) return;
    const btn = document.getElementById('modal-cancelar-confirmar');
    const err = document.getElementById('modal-cancelar-error');
    btn.disabled = true;
    btn.textContent = 'Cancelando…';
    err.hidden = true;

    try {
        // 1) UPDATE cita estado='cancelada'
        const { error: upErr } = await supabase
            .from('citas')
            .update({ estado: 'cancelada' })
            .eq('id', cita.id);
        if (upErr) throw upErr;

        // 2) DELETE bloqueo "Auto: cita {id}"
        const { error: delErr } = await supabase
            .from('bloqueos')
            .delete()
            .eq('motivo', `Auto: cita ${cita.id}`);
        if (delErr) {
            console.warn('[app] No se pudo borrar el bloqueo Auto: cita ' + cita.id, delErr);
        }

        cerrarModal('modal-cancelar');
        toast('Cita cancelada');
        state.citaACancelar = null;
        state.citas = await cargarCitasCliente();
        renderTabMisCitas();
    } catch (e) {
        console.error('[app] error cancelando cita:', e);
        err.textContent = 'No se pudo cancelar. Inténtalo de nuevo.';
        err.hidden = false;
    } finally {
        btn.disabled = false;
        btn.textContent = 'Sí, cancelar';
    }
}

// ===================== Foto del perro =====================

function abrirModalFoto() {
    const perro = state.perros.find((p) => p.id === state.perroSeleccionadoId);
    if (!perro) return;
    setText('modal-foto-nombre', perro.nombre || 'tu perro');
    state.fotoSeleccionada = null;
    const preview = document.getElementById('foto-preview');
    const previewImg = document.getElementById('foto-preview-img');
    const guardar = document.getElementById('foto-guardar');
    const err = document.getElementById('foto-error');
    const input = document.getElementById('foto-input');
    preview.setAttribute('hidden', '');
    previewImg.removeAttribute('src');
    guardar.disabled = true;
    err.hidden = true;
    err.textContent = '';
    input.value = '';
    abrirModal('modal-foto');
}

function onFotoSeleccionada(e) {
    const input = e.target;
    const file = input.files?.[0];
    const err = document.getElementById('foto-error');
    err.hidden = true;
    err.textContent = '';

    if (!file) return;

    if (file.size > 5 * 1024 * 1024) {
        err.textContent = 'La foto pesa más de 5MB. Elige una más pequeña.';
        err.hidden = false;
        input.value = '';
        return;
    }
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) {
        err.textContent = 'Formato no soportado. Usa JPG, PNG o WebP.';
        err.hidden = false;
        input.value = '';
        return;
    }

    const reader = new FileReader();
    reader.onload = (ev) => {
        state.fotoSeleccionada = { file, dataUrl: ev.target.result };
        const previewImg = document.getElementById('foto-preview-img');
        previewImg.src = ev.target.result;
        document.getElementById('foto-preview').removeAttribute('hidden');
        document.getElementById('foto-guardar').disabled = false;
    };
    reader.readAsDataURL(file);
}

async function guardarFotoPerro() {
    const perro = state.perros.find((p) => p.id === state.perroSeleccionadoId);
    if (!perro || !state.fotoSeleccionada) return;
    const { file } = state.fotoSeleccionada;
    const btn = document.getElementById('foto-guardar');
    const err = document.getElementById('foto-error');
    btn.disabled = true;
    btn.textContent = 'Subiendo…';
    err.hidden = true;

    try {
        const ext = file.type === 'image/png' ? 'png'
                  : file.type === 'image/webp' ? 'webp'
                  : 'jpg';
        const path = `${perro.id}/foto.${ext}`;
        const { error: upErr } = await supabase.storage
            .from('perros-fotos')
            .upload(path, file, { upsert: true, contentType: file.type });
        if (upErr) throw upErr;

        const { data: urlData } = supabase.storage
            .from('perros-fotos')
            .getPublicUrl(path);
        const publicUrl = urlData?.publicUrl;
        if (!publicUrl) throw new Error('No se pudo obtener la URL pública');

        // Cache-bust con timestamp para refrescar la foto si era la misma path
        const finalUrl = `${publicUrl}?t=${Date.now()}`;

        const { error: updErr } = await supabase
            .from('perros')
            .update({ foto_url: finalUrl })
            .eq('id', perro.id);
        if (updErr) throw updErr;

        // Actualizar estado local
        perro.foto_url = finalUrl;
        cerrarModal('modal-foto');
        toast('Foto actualizada');
        await renderRutinaPerroSeleccionado();
    } catch (e) {
        console.error('[app] error subiendo foto:', e);
        err.textContent = e?.message ? `No se pudo subir: ${e.message}` : 'No se pudo subir la foto.';
        err.hidden = false;
    } finally {
        btn.disabled = false;
        btn.textContent = 'Guardar foto';
    }
}

// ===================== Modales genéricos =====================

function abrirModal(id) {
    const modal = document.getElementById(id);
    if (!modal) return;
    modal.removeAttribute('hidden');
    modal.setAttribute('aria-hidden', 'false');
    requestAnimationFrame(() => modal.classList.add('is-open'));
    document.body.style.overflow = 'hidden';
}

function cerrarModal(id) {
    const modal = document.getElementById(id);
    if (!modal || modal.hasAttribute('hidden')) return;
    modal.classList.remove('is-open');
    document.body.style.overflow = '';
    setTimeout(() => {
        modal.setAttribute('hidden', '');
        modal.setAttribute('aria-hidden', 'true');
    }, 200);
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
    return String(str ?? '')
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

function colorParaPerro(perroId) {
    if (!perroId) return PERRO_COLOR_PALETTE[0];
    let hash = 0;
    for (let i = 0; i < perroId.length; i++) hash = (hash * 31 + perroId.charCodeAt(i)) >>> 0;
    return PERRO_COLOR_PALETTE[hash % PERRO_COLOR_PALETTE.length];
}

function formatearEdadPerro(perro) {
    if (perro.edad_meses != null) {
        const m = perro.edad_meses;
        if (m < 12) return `${m} ${m === 1 ? 'mes' : 'meses'}`;
        const años = Math.floor(m / 12);
        return `${años} ${años === 1 ? 'año' : 'años'}`;
    }
    return perro.edad || '';
}

const DIAS_NOMBRE = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
const MESES_CORTO = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

function formatearFechaLarga(iso) {
    // 'YYYY-MM-DD' → 'lunes 13 may'
    const [y, m, d] = iso.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    return `${DIAS_NOMBRE[dt.getDay()].toLowerCase()} ${dt.getDate()} ${MESES_CORTO[dt.getMonth()]}`;
}

function sumarDiasIso(iso, n) {
    const [y, m, d] = iso.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    dt.setDate(dt.getDate() + n);
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

function cuantoFalta(dt, ahora) {
    const ms = dt - ahora;
    if (ms < 0) return 'Ya pasó';
    const horas = ms / 36e5;
    if (horas < 1) {
        const mins = Math.round(ms / 60000);
        return `En ${mins} min`;
    }
    if (horas < 24) {
        const h = Math.round(horas);
        return `En ${h} ${h === 1 ? 'hora' : 'horas'}`;
    }
    const dias = Math.floor(horas / 24);
    if (dias === 1) return 'Mañana';
    if (dias < 7) return `En ${dias} días`;
    const semanas = Math.floor(dias / 7);
    if (semanas === 1) return 'En 1 semana';
    return `En ${semanas} semanas`;
}

function _datetimeCita(cita) {
    const [y, m, d] = cita.fecha.split('-').map(Number);
    const [hh, mm] = (cita.hora || '00:00').split(':').map(Number);
    return new Date(y, m - 1, d, hh, mm, 0);
}

function _compararCitasAsc(a, b) {
    if (a.fecha !== b.fecha) return a.fecha < b.fecha ? -1 : 1;
    return (a.hora || '') < (b.hora || '') ? -1 : 1;
}

// ===================== Service Worker =====================

function registrarServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    window.addEventListener('load', () => {
        navigator.serviceWorker
            .register('/clases/service-worker.js', { scope: '/clases/' })
            .then((reg) => console.log('[app] SW Clases registrado, scope:', reg.scope))
            .catch((err) => console.error('[app] SW Clases error:', err));
    });
}

// ===================== Banner instalación PWA =====================

const PWA_DISMISSED_KEY = 'pdli_install_dismissed_until';
const PWA_INSTALLED_KEY = 'pdli_installed';
const PWA_DELAY_MS = 2000;
const PWA_DISMISS_DAYS = 7;

let deferredInstallPrompt = null;
let pwaTimer = null;

function isStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches
        || window.navigator.standalone === true;
}

function isIOS() {
    return /iPhone|iPad|iPod/i.test(navigator.userAgent);
}

function dismissedActivo() {
    const until = parseInt(localStorage.getItem(PWA_DISMISSED_KEY) || '0', 10);
    return Number.isFinite(until) && Date.now() < until;
}

function bootstrapPwaBanner() {
    window.addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();
        deferredInstallPrompt = e;
        if (!pwaTimer && puedeMostrarseBanner()) intentarMostrarBanner();
    });

    window.addEventListener('appinstalled', () => {
        localStorage.setItem(PWA_INSTALLED_KEY, 'true');
        ocultarBannerInstall();
        deferredInstallPrompt = null;
    });

    bindBannerHandlers();

    if (puedeMostrarseBanner()) {
        pwaTimer = setTimeout(() => {
            pwaTimer = null;
            if (puedeMostrarseBanner()) intentarMostrarBanner();
        }, PWA_DELAY_MS);
    }
}

function puedeMostrarseBanner() {
    if (isStandalone()) return false;
    if (localStorage.getItem(PWA_INSTALLED_KEY) === 'true') return false;
    if (dismissedActivo()) return false;
    // Mientras el welcome editorial esté visible no asomamos el banner —
    // primero el cliente lee el mensaje y aprieta "Empezar", luego decidimos.
    const welcome = document.getElementById('screen-welcome');
    if (welcome && !welcome.hasAttribute('hidden')) return false;
    if (isIOS()) return true;
    return !!deferredInstallPrompt;
}

function intentarMostrarBanner() {
    const banner = document.getElementById('install-banner');
    if (!banner) return;
    const accept = document.getElementById('install-accept');
    if (isIOS()) accept.textContent = 'Ver cómo';
    else accept.textContent = 'Instalar';
    banner.removeAttribute('hidden');
    requestAnimationFrame(() => banner.classList.add('is-open'));
}

function ocultarBannerInstall() {
    const banner = document.getElementById('install-banner');
    if (!banner || banner.hasAttribute('hidden')) return;
    banner.classList.remove('is-open');
    setTimeout(() => banner.setAttribute('hidden', ''), 350);
}

function dismissBannerPor7Dias() {
    const until = Date.now() + PWA_DISMISS_DAYS * 24 * 60 * 60 * 1000;
    localStorage.setItem(PWA_DISMISSED_KEY, String(until));
    ocultarBannerInstall();
}

function bindBannerHandlers() {
    const accept = document.getElementById('install-accept');
    const dismiss = document.getElementById('install-dismiss');
    if (accept) accept.addEventListener('click', onAceptarInstall);
    if (dismiss) dismiss.addEventListener('click', dismissBannerPor7Dias);

    const modal = document.getElementById('ios-install-modal');
    if (modal) {
        modal.addEventListener('click', (e) => {
            if (e.target.closest('[data-close]')) cerrarModalIOS();
        });
    }

    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        const m = document.getElementById('ios-install-modal');
        if (m && !m.hasAttribute('hidden')) cerrarModalIOS();
    });
}

async function onAceptarInstall() {
    if (isIOS()) {
        abrirModalIOS();
        return;
    }
    if (!deferredInstallPrompt) {
        dismissBannerPor7Dias();
        return;
    }
    try {
        deferredInstallPrompt.prompt();
        const { outcome } = await deferredInstallPrompt.userChoice;
        if (outcome === 'accepted') {
            localStorage.setItem(PWA_INSTALLED_KEY, 'true');
            ocultarBannerInstall();
        } else {
            dismissBannerPor7Dias();
        }
    } catch (err) {
        console.error('[pwa] error en prompt:', err);
        dismissBannerPor7Dias();
    } finally {
        deferredInstallPrompt = null;
    }
}

function abrirModalIOS() {
    const modal = document.getElementById('ios-install-modal');
    if (!modal) return;
    modal.removeAttribute('hidden');
    modal.setAttribute('aria-hidden', 'false');
    requestAnimationFrame(() => modal.classList.add('is-open'));
    document.body.style.overflow = 'hidden';
}

function cerrarModalIOS() {
    const modal = document.getElementById('ios-install-modal');
    if (!modal || modal.hasAttribute('hidden')) return;
    modal.classList.remove('is-open');
    document.body.style.overflow = '';
    setTimeout(() => {
        modal.setAttribute('hidden', '');
        modal.setAttribute('aria-hidden', 'true');
    }, 250);
}
