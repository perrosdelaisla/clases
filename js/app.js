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

import { supabase, getSessionConTimeout, recuperarSesionDeStorage } from './supabase.js';
import { initSwipeTabs } from './swipe-tabs.js';
import {
    estadoChipFrecuencia,
    COLOR_CHIP_FRECUENCIA,
    textoChipFrecuencia,
    textoObjetivoBajoNombre,
} from './frecuencia.js?v=1';

// Intro UCM: duración mínima del telón de arranque para que la animación se
// vea entera aunque los datos carguen rápido.
const APP_ARRANQUE = Date.now();
const INTRO_MIN_MS = 4500;
function esperarIntro() {
    const falta = INTRO_MIN_MS - (Date.now() - APP_ARRANQUE);
    return falta > 0 ? new Promise((r) => setTimeout(r, falta)) : Promise.resolve();
}

const SCREENS = {
    loading: document.getElementById('screen-loading'),
    login: document.getElementById('screen-login'),
    'login-sent': document.getElementById('screen-login-sent'),
    'error-vinculo': document.getElementById('screen-error-vinculo'),
    welcome: document.getElementById('screen-welcome'),
    'ex-cliente': document.getElementById('screen-ex-cliente'),
    app: document.getElementById('screen-app'),
};

// Nivel del cliente (clientes.estado). La app solo cambia de verdad para el
// veterano (pantalla Manada) y el ex cliente (bloqueo). Consulta e inactivo ven
// la app igual que un activo, salvo el acceso al modal de categorías.
function esVeterano() { return state.cliente?.estado === 'veterano'; }
function esExCliente() { return state.cliente?.estado === 'ex_cliente'; }

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
    rutinaFilas: [],
    reservandoSlot: null,    // { fecha, hora, label } cuando se abre modal
    citaACancelar: null,     // cita object cuando se abre modal
    fotoSeleccionada: null,  // { file, dataUrl } cuando hay preview en modal foto
    calMes: {
        anchorIso: null,           // 1er día del mes mostrado (ISO)
        diaSeleccionadoIso: null,  // día seleccionado, ISO
        slotsPorFecha: {},         // { '2026-05-26': ['10:00','11:00'] }
        sugerencia: null,          // { fecha, hora, label } o null
        numeroProxima: null,       // número de clase de la próxima reserva
    },
    sugerenciaActiva: null,  // sugerencia activa en el modo sugerencia del modal
    modificando: null,       // cita en proceso de modificación: { id, fecha_vieja, hora_vieja, numero_clase }
    rutinaModo: 'rutina',    // 'rutina' | 'progreso' — toggle dentro del tab Rutina
};

// Token incremental para detectar renders concurrentes de la rutina.
// Cada llamada incrementa el token y, después del await de Supabase, vuelve
// a chequear que sigue siendo el render activo antes de pintar el DOM —
// así evitamos "Cargando…" + lista + empty visibles a la vez cuando dos
// renders se pisan (cambio rápido de sub-pestañas, foco/blur, etc.).
let _renderRutinaToken = 0;

// Email en proceso de verificación por código OTP. Lo fija enviarCodigo()
// y lo usan verificarCodigo() y reenviarCodigo(): el código de 6 dígitos se
// confirma con verifyOtp({ email, token }), así que hay que recordar a qué
// email pertenece el código que la persona está escribiendo.
let emailEnVerificacion = null;

// Mapeo de citas.protocolo (técnico) a label cliente
const PROTOCOLOS_LABEL = {
    educacion_basica:         'Educación básica',
    educacion_cachorro:       'Educación del cachorro',
    gestion_ansiedad:         'Gestión de ansiedad',
    reactividad_impulsividad: 'Reactividad e impulsividad',
    proteccion_recursos:      'Protección de recursos',
    depresion:                'Depresión y estados depresivos',
    celos:                    'Celos y competiciones afectivas',
    conflictividad_peleas:    'Conflictividad y peleas entre perros que conviven',
    miedos_fobias:            'Miedos y fobias',
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

    // ¿La URL trae ?invite=<email>? Es el enlace del correo de invitación.
    // Lo leemos una vez y lo limpiamos de la URL para que no quede pegado.
    const inviteEmail = leerYlimpiarInvite();

    // Timeout tolerante (25s): en iOS, con red lenta, getSession() puede
    // tardar mientras renueva el token. No queremos mandar al login por
    // impaciencia y descartar una sesión que sí existe.
    let session = null;
    try {
        const { data } = await getSessionConTimeout(25000);
        session = data?.session || null;
    } catch (err) {
        // getSession() venció: NO descartamos la sesión. La rescatamos
        // leyéndola directamente del storage resistente.
        console.warn('[app] getSession lento, recuperando del storage:', err);
        try {
            session = await recuperarSesionDeStorage();
        } catch (_e) {
            session = null;
        }
    }

    if (!session) {
        // Cliente invitado: el código ya se lo mandó la edge function.
        // Lo llevamos directo a la pantalla de código con el email cargado,
        // sin pedir otro código (eso invalidaría el de la invitación).
        if (inviteEmail) {
            mostrarPantallaCodigoInvitacion(inviteEmail);
        } else {
            await esperarIntro();
            showScreen('login');
        }
        return;
    }

    await onSesionLista(session);
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

        // Primero el cliente: necesitamos su ESTADO antes de decidir qué cargar.
        state.cliente = await cargarCliente(usuarioCliente.cliente_id);

        // EX CLIENTE: portada mínima de bloqueo. No se carga la app ni se hace
        // ninguna consulta de datos más allá del estado.
        if (esExCliente()) {
            await esperarIntro();
            showScreen('ex-cliente');
            return;
        }

        // Resto de datos en paralelo: perros + citas
        const [perros, citas] = await Promise.all([
            cargarPerros(),
            cargarCitasCliente(),
        ]);
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
        renderCategoriaAcceso();
        await renderRutinaPerroSeleccionado();
        aplicarModoManada();
        actualizarBadgeMensajes();

        // Tras la intro, el cliente entra directo al perfil. El mensaje
        // editorial ("No buscamos trucos") ya vive dentro del perfil, en
        // la sección "Nuestro enfoque", así que ya no desviamos al welcome.
        await esperarIntro();
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

const PDLI_THEME_KEY = 'pdli-home-theme';
function aplicarTemaHome(t) {
    const home = document.getElementById('screen-app');
    if (!home) return;
    home.setAttribute('data-theme', t);
    const tg = document.getElementById('theme-toggle');
    if (tg) {
        const moon = tg.querySelector('.theme-toggle__moon');
        const sun = tg.querySelector('.theme-toggle__sun');
        if (moon) moon.hidden = (t === 'oscuro');
        if (sun) sun.hidden = (t !== 'oscuro');
    }
    try { localStorage.setItem(PDLI_THEME_KEY, t); } catch (e) {}
}
function initTemaHome() {
    let t = 'claro';
    try { t = localStorage.getItem(PDLI_THEME_KEY) || 'claro'; } catch (e) {}
    aplicarTemaHome(t);
    const tg = document.getElementById('theme-toggle');
    if (tg && !tg.dataset.bound) {
        tg.dataset.bound = '1';
        tg.addEventListener('click', () => {
            const cur = document.getElementById('screen-app').getAttribute('data-theme');
            aplicarTemaHome(cur === 'oscuro' ? 'claro' : 'oscuro');
        });
    }
    const wd = document.getElementById('work-day');
    if (wd) {
        let s = new Date().toLocaleDateString('es-ES', { weekday: 'short', day: 'numeric', month: 'short' });
        wd.textContent = s.charAt(0).toUpperCase() + s.slice(1);
    }
}

function bindEventos() {
    // Login
    const form = document.getElementById('login-form');
    if (form) form.addEventListener('submit', enviarCodigo);

    const codigoForm = document.getElementById('codigo-form');
    if (codigoForm) codigoForm.addEventListener('submit', verificarCodigo);

    const reenviar = document.getElementById('codigo-reenviar');
    if (reenviar) reenviar.addEventListener('click', reenviarCodigo);

    const pegar = document.getElementById('codigo-pegar');
    if (pegar) pegar.addEventListener('click', pegarCodigo);

    // Si la app corre como PWA instalada, mostramos el aviso de iniciar
    // sesión aquí dentro: en iOS el storage de Safari y el de la PWA están
    // separados, la sesión no pasa de uno al otro.
    if (isStandalone()) {
        const pwaHint = document.getElementById('login-pwa-hint');
        if (pwaHint) pwaHint.hidden = false;
    }

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

    // Ítems del menú del avatar (Mi familia / Cerrar sesión): se resuelven en
    // POINTERDOWN con handler delegado — mismo endurecimiento que los chips de
    // perro (518ce26) contra la carrera táctil (pointerdown/up en distinto
    // elemento → click re-dirigido al ancestro). El flag deja el click en no-op.
    const avatarMenu = document.getElementById('avatar-menu');
    let avatarItemPointer = false;
    if (avatarMenu) {
        avatarMenu.addEventListener('pointerdown', (e) => {
            const item = e.target.closest('.avatar-menu__item');
            if (!item) return;
            e.preventDefault();
            avatarItemPointer = true;
            ejecutarItemAvatar(item.id);
        });
        avatarMenu.addEventListener('click', (e) => {
            if (avatarItemPointer) { avatarItemPointer = false; return; }
            const item = e.target.closest('.avatar-menu__item');
            if (item) ejecutarItemAvatar(item.id);
        });
    }

    const familiaInvitar = document.getElementById('familia-invitar');
    if (familiaInvitar) familiaInvitar.addEventListener('click', enviarInvitacionFamiliar);

    const familiaLista = document.getElementById('familia-lista');
    if (familiaLista) familiaLista.addEventListener('click', (e) => {
        const btn = e.target.closest('.familia-fila__quitar');
        if (btn) quitarFamiliar(btn.dataset.id, btn.dataset.nombre);
    });

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

    // (El CTA "Reservar próxima clase" se eliminó porque ya está la tab
    // "Reservar" en el bottom-nav — quitado en este PR.)

    // CTA "Empezar →" de la card de evaluación de salud comportamental.
    // Abre La Isla en pestaña nueva con perro_id, cliente_id y origen.
    document.getElementById('btn-iniciar-evaluacion')?.addEventListener('click', abrirLaIsla);
    document.getElementById('btn-iniciar-evaluacion-empty')?.addEventListener('click', abrirLaIsla);
    document.getElementById('btn-nueva-evaluacion')?.addEventListener('click', abrirLaIsla);

    // Foto del perro
    const fotoBtn = document.getElementById('perro-foto-btn');
    if (fotoBtn) fotoBtn.addEventListener('click', abrirModalFoto);

    const vermasBtn = document.getElementById('perro-protocolo-vermas');
    if (vermasBtn) vermasBtn.addEventListener('click', abrirModalFichaProtocolo);

    // Manada: acceso al modal de categorías (chip del hero para no-veteranos y
    // badge VETERANO en la barra Manada), edición de mis datos discreta en esa
    // barra, y vuelta a la Manada desde la rutina clásica del veterano.
    document.getElementById('hero-categoria-chip')?.addEventListener('click', abrirModalCategoria);
    document.getElementById('hero-badge-veterano')?.addEventListener('click', abrirModalCategoria);
    document.getElementById('hero-editar-manada')?.addEventListener('click', abrirModalEditarMisDatos);
    document.getElementById('rutina-volver-manada')?.addEventListener('click', volverAManada);

    // Manada: un ÚNICO handler DELEGADO para tarjetas, chips de perro y sus
    // desplegables (bound una sola vez; sobrevive a los re-render de renderManada
    // sin acumular listeners). El cierre al tocar fuera va aparte, calcando el
    // menú del avatar: ignora el toggle (el chip) y el propio menú, así el mismo
    // toque que abre no lo cierra.
    const manadaHome = document.getElementById('manada-home');
    // La SELECCIÓN de un ítem se resuelve en POINTERDOWN, no en click: el
    // pointerdown se dispara ANTES del scale:active de la tarjeta y de cualquier
    // re-render, así que es inmune al re-targeting que redirigía el click al
    // ancestro común (por eso antes "no seleccionaba"). El flag evita el doble
    // proceso con el click sintético posterior.
    let itemSelPointer = false;
    if (manadaHome) manadaHome.addEventListener('pointerdown', (e) => {
        const item = e.target.closest('.mn-chip-menu__it');
        if (!item) return;
        e.preventDefault();
        itemSelPointer = true;
        seleccionarPerroManada(item.dataset.perroId);
    });
    if (manadaHome) manadaHome.addEventListener('click', (e) => {
        // Ítem del desplegable: ya procesado en pointerdown → no-op.
        if (itemSelPointer) { itemSelPointer = false; return; }
        if (e.target.closest('.mn-chip-menu__it')) return;
        // Guard anti-navegación fantasma: un click re-dirigido u originado dentro
        // del menú jamás debe disparar la acción de la tarjeta que lo contiene.
        if (e.target.closest('.mn-chip-menu')) return;
        const chip = e.target.closest('[data-mn-chip]');
        if (chip) {
            if (chip.dataset.single) return;   // un solo perro: chip sin desplegable
            const abierto = chip.parentElement.querySelector('.mn-chip-menu');
            cerrarMenusManada();
            if (!abierto) abrirDropdownPerroManada(chip);
            return;
        }
        const card = e.target.closest('[data-mn-card]');
        if (card) onManadaCard(card.dataset.mnCard);
    });
    // Cierre al tocar fuera (patrón del menú avatar): ignora el toggle y el menú.
    document.addEventListener('click', (e) => {
        if (!document.querySelector('.mn-chip-menu')) return;
        if (e.target.closest('.mn-chip-menu') || e.target.closest('[data-mn-chip]')) return;
        cerrarMenusManada();
    });

    const fotoInput = document.getElementById('foto-input');
    if (fotoInput) fotoInput.addEventListener('change', onFotoSeleccionada);

    const fotoGuardar = document.getElementById('foto-guardar');
    if (fotoGuardar) fotoGuardar.addEventListener('click', guardarFotoPerro);

    // Form "añadir perro" (Bloque 4: solo UI)
    bindFormAgregarPerro();
    bindFormEditarMisDatos();
    bindFormEditarPerro();

    // Mensajes y notas (Bloque A.2)
    bindComposerMensaje();
    bindNotasEjercicio();
    bindTareaLista();
    bindJaimeChat();

    // Back navigation Android — atrapar el botón atrás físico para cerrar
    // modales / volver a Rutina antes de salir. Idempotente.
    bindBackNavigation();

    // Dictado por voz en notas y reporte (Web Speech API).
    bindBotonesDictado();

    // Toggle Rutina / Mi progreso dentro del tab Rutina.
    bindRutinaModo();

    // Seguimiento de conductas (calendario-semáforo dentro del perfil).
    bindSeguimiento();

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

    // Tarjeta de rutina → abre el detalle del ejercicio
    const rutinaLista = document.getElementById('rutina-lista');
    if (rutinaLista) {
        const abrirDesdeCard = (card) => {
            if (!card) return;
            const fila = (state.rutinaFilas || [])
                .find((r) => r.ejercicios && r.ejercicios.id === card.dataset.ejercicioId);
            if (fila) abrirModalEjercicio(fila.ejercicios, fila.id);
        };
        rutinaLista.addEventListener('click', (e) => {
            // Las pills de días de tarea son su propio control: no abren el detalle.
            const pill = e.target.closest('.tarea-dias__pill');
            if (pill) { onTareaDiaPill(pill); return; }
            abrirDesdeCard(e.target.closest('.rutina-card'));
        });
        rutinaLista.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            // El botón de la pill maneja su propia activación; no abrir el detalle.
            if (e.target.closest('.tarea-dias__pill')) return;
            e.preventDefault();
            abrirDesdeCard(e.target.closest('.rutina-card'));
        });
    }

    // Swipe horizontal entre tabs principales (bottom-nav)
    initSwipeTabs({
        container: document.querySelector('.app-main'),
        tabs: ['rutina', 'reservar', 'mis-citas', 'salud'],
        getCurrent: () => state.currentTab,
        onChange: (newTab) => showTab(newTab),
    });

    // Swipe horizontal entre sub-tabs de Rutina
    initSwipeTabs({
        container: document.getElementById('tab-rutina'),
        tabs: ['ejercicio', 'cambio_rutina', 'tarea', 'herramienta'],
        getCurrent: () => state.rutinaCategoriaActiva,
        onChange: (cat) => {
            state.rutinaCategoriaActiva = cat;
            document.querySelectorAll('.rutina-subtab').forEach((b) => {
                const isActive = b.dataset.cat === cat;
                b.classList.toggle('is-active', isActive);
                b.setAttribute('aria-selected', isActive ? 'true' : 'false');
            });
            renderRutinaPerroSeleccionado();
        },
    });

    initTemaHome();
}

// ===================== Login =====================
//
// Acceso por código de 6 dígitos (OTP por email), NO por enlace mágico.
//
// En iOS el enlace mágico abre siempre en Safari, mientras la clienta
// usa la PWA instalada — son almacenamientos separados y la sesión queda
// en el contexto equivocado. Con el código, la persona lo escribe DENTRO
// de la app: la sesión nace en el contexto correcto.
//
// Flujo: login (email) → signInWithOtp → login-sent (código) →
// verifyOtp → onAuthStateChange(SIGNED_IN) → onSesionLista.

/**
 * Paso 1: la clienta escribe su email. Pedimos el código a Supabase
 * (signInWithOtp manda el código de 6 dígitos según la plantilla de
 * email) y pasamos a la pantalla de ingreso de código.
 */
async function enviarCodigo(e) {
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
        const { error } = await supabase.auth.signInWithOtp({ email });
        if (error) throw error;

        emailEnVerificacion = email;
        document.getElementById('email-enviado').textContent = email;

        // Dejamos la pantalla de código limpia antes de mostrarla.
        const codigoInput = document.getElementById('codigo-input');
        if (codigoInput) codigoInput.value = '';
        ocultarMensaje('codigo-error');
        ocultarMensaje('codigo-aviso');

        showScreen('login-sent');
        if (codigoInput) codigoInput.focus();
        // Acabamos de mandar un código: el botón "Reenviar" arranca en
        // cooldown para que nadie pida otro antes de que llegue el primero.
        iniciarCooldownReenvio();
    } catch (err) {
        console.error('[app] envío de código error:', err);
        errEl.textContent = mensajeErrorEnvio(err);
        errEl.hidden = false;
    } finally {
        btn.disabled = false;
        btn.textContent = 'Enviar código';
    }
}

/**
 * Paso 2: la clienta escribe el código de 6 dígitos. Lo verificamos con
 * verifyOtp. Si crea sesión, onAuthStateChange (SIGNED_IN) toma el control
 * y arranca onSesionLista() — no tocamos la pantalla acá. Si el código es
 * incorrecto o caducó, mostramos el error y dejamos reintentar sin recargar.
 */
async function verificarCodigo(e) {
    e.preventDefault();
    const input = document.getElementById('codigo-input');
    const errEl = document.getElementById('codigo-error');
    const btn = document.getElementById('codigo-submit');

    const token = (input.value || '').replace(/\D/g, '');
    ocultarMensaje('codigo-error');
    ocultarMensaje('codigo-aviso');

    if (token.length !== 6) {
        errEl.textContent = 'El código tiene 6 dígitos.';
        errEl.hidden = false;
        return;
    }
    if (!emailEnVerificacion) {
        errEl.textContent = 'Vuelve a introducir tu email para pedir un código nuevo.';
        errEl.hidden = false;
        return;
    }

    btn.disabled = true;
    btn.textContent = 'Entrando…';

    try {
        const { error } = await supabase.auth.verifyOtp({
            email: emailEnVerificacion,
            token,
            type: 'email',
        });
        if (error) throw error;
        // Sesión creada: onAuthStateChange (SIGNED_IN) → onSesionLista().
        // No reseteamos el botón: la pantalla cambia sola.
    } catch (err) {
        console.error('[app] verificación de código error:', err);
        errEl.textContent = mensajeErrorCodigo(err);
        errEl.hidden = false;
        btn.disabled = false;
        btn.textContent = 'Entrar';
        input.focus();
        input.select();
    }
}

/**
 * Botón "Pegar código": lee el portapapeles y, si encuentra un código de
 * 6 dígitos, lo carga en el campo. navigator.clipboard puede fallar (el
 * navegador lo bloquea, iOS pide permiso, etc.) — si pasa, no rompe nada:
 * el cliente escribe el código a mano como siempre. El pegado normal del
 * teclado sobre el input sigue funcionando aparte de este botón.
 */
async function pegarCodigo() {
    const input = document.getElementById('codigo-input');
    if (!input) return;
    ocultarMensaje('codigo-aviso');
    try {
        const texto = await navigator.clipboard.readText();
        const digitos = (texto || '').replace(/\D/g, '');
        if (digitos.length === 6) {
            input.value = digitos;
            input.focus();
            ocultarMensaje('codigo-error');
        } else {
            avisarCodigo('No encontramos un código de 6 dígitos. Escríbelo a mano.');
        }
    } catch (_e) {
        avisarCodigo('Pega el código en la casilla o escríbelo a mano.');
    }
}

// Muestra un aviso suave en la pantalla de código (no es un error).
function avisarCodigo(mensaje) {
    const avisoEl = document.getElementById('codigo-aviso');
    if (avisoEl) { avisoEl.textContent = mensaje; avisoEl.hidden = false; }
}

/**
 * "Reenviar código": vuelve a pedir un código a Supabase. Esto dispara un
 * correo y el SMTP tiene rate-limit — si responde 429, avisamos que espere.
 */
async function reenviarCodigo() {
    const errEl = document.getElementById('codigo-error');
    const avisoEl = document.getElementById('codigo-aviso');
    const btn = document.getElementById('codigo-reenviar');

    ocultarMensaje('codigo-error');
    ocultarMensaje('codigo-aviso');

    if (!emailEnVerificacion) {
        showScreen('login');
        return;
    }

    btn.disabled = true;
    btn.textContent = 'Enviando…';

    try {
        const { error } = await supabase.auth.signInWithOtp({ email: emailEnVerificacion });
        if (error) throw error;

        avisoEl.textContent = 'Te hemos enviado un código nuevo. Revisa tu correo.';
        avisoEl.hidden = false;
        const input = document.getElementById('codigo-input');
        if (input) { input.value = ''; input.focus(); }
        // Código nuevo en camino: el botón vuelve a quedar en cooldown.
        iniciarCooldownReenvio();
    } catch (err) {
        console.error('[app] reenvío de código error:', err);
        errEl.textContent = mensajeErrorEnvio(err);
        errEl.hidden = false;
        // El envío falló: dejamos reintentar de inmediato, sin cooldown.
        btn.disabled = false;
        btn.textContent = 'Reenviar código';
    }
}

// Cooldown del botón "Reenviar código". Cada reenvío dispara un correo y
// el SMTP tiene rate-limit; 30s da tiempo a que llegue el primer código
// antes de tentar otro. El botón queda deshabilitado mostrando la cuenta
// regresiva ("Reenviar código (30s)") hasta volver a su estado normal.
const REENVIO_COOLDOWN_S = 30;
let _reenvioTimer = null;

function iniciarCooldownReenvio() {
    const btn = document.getElementById('codigo-reenviar');
    if (!btn) return;
    if (_reenvioTimer) clearInterval(_reenvioTimer);

    let restante = REENVIO_COOLDOWN_S;
    btn.disabled = true;
    btn.textContent = `Reenviar código (${restante}s)`;

    _reenvioTimer = setInterval(() => {
        restante -= 1;
        if (restante <= 0) {
            clearInterval(_reenvioTimer);
            _reenvioTimer = null;
            btn.disabled = false;
            btn.textContent = 'Reenviar código';
        } else {
            btn.textContent = `Reenviar código (${restante}s)`;
        }
    }, 1000);
}

// Lee ?invite=<email> de la URL (el enlace del correo de invitación) y lo
// borra de la barra de direcciones para que no quede pegado. Devuelve el
// email validado, o null si no viene o no parece un email.
function leerYlimpiarInvite() {
    let email = null;
    try {
        const params = new URLSearchParams(window.location.search);
        const raw = params.get('invite');
        if (raw) {
            email = raw.trim().toLowerCase();
            params.delete('invite');
            const qs = params.toString();
            const nuevaUrl = window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash;
            history.replaceState(null, '', nuevaUrl);
        }
    } catch (_e) { /* URL rara: seguimos sin invite */ }
    return (email && EMAIL_RE.test(email)) ? email : null;
}

// Flujo de invitación: el cliente llega con el código YA enviado por la
// edge function. Lo dejamos directo en la pantalla de código con el email
// cargado, sin llamar a signInWithOtp. El cooldown del botón "Reenviar"
// arranca igual que en enviarCodigo: evita que un toque por reflejo pida
// otro código y, con eso, invalide el de la invitación.
function mostrarPantallaCodigoInvitacion(email) {
    emailEnVerificacion = email;
    const emailEl = document.getElementById('email-enviado');
    if (emailEl) emailEl.textContent = email;

    const codigoInput = document.getElementById('codigo-input');
    if (codigoInput) codigoInput.value = '';
    ocultarMensaje('codigo-error');
    ocultarMensaje('codigo-aviso');

    showScreen('login-sent');
    if (codigoInput) codigoInput.focus();
    iniciarCooldownReenvio();
}

// ¿El error de Supabase es un rate-limit de envío de emails? El SMTP tiene
// cupo limitado; cuando se agota, signInWithOtp responde 429.
function esRateLimit(err) {
    if (!err) return false;
    if (err.status === 429) return true;
    const txt = `${err.code || ''} ${err.message || ''}`.toLowerCase();
    return /rate.?limit|too many|429/.test(txt);
}

function mensajeErrorEnvio(err) {
    if (esRateLimit(err)) {
        return 'Has pedido varios códigos seguidos. Espera un minuto antes de volver a intentarlo.';
    }
    return err?.message
        ? `No se pudo enviar el código: ${err.message}`
        : 'No se pudo enviar el código. Inténtalo de nuevo.';
}

function mensajeErrorCodigo(err) {
    const txt = `${err?.code || ''} ${err?.message || ''}`.toLowerCase();
    if (txt.includes('expired') || txt.includes('invalid') || txt.includes('token')) {
        return 'El código no es correcto o ha caducado. Pide uno nuevo.';
    }
    return err?.message
        ? `No se pudo verificar el código: ${err.message}`
        : 'No se pudo verificar el código. Inténtalo de nuevo.';
}

function ocultarMensaje(id) {
    const el = document.getElementById(id);
    if (el) { el.hidden = true; el.textContent = ''; }
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

// Acción de un ítem del menú del avatar por id (la invocan los handlers
// delegados de pointerdown/click). abrirModalFamilia ya cierra el menú.
function ejecutarItemAvatar(id) {
    if (id === 'familia-btn') abrirModalFamilia();
    else if (id === 'logout-btn') cerrarSesion();
}

// ===================== Mi familia (cliente principal) =====================

function esPrincipal() {
    return state.usuarioCliente?.rol === 'principal';
}

async function abrirModalFamilia() {
    cerrarMenuAvatar();
    await cargarYRenderMiembros();
    abrirModal('modal-familia');
}

async function cargarYRenderMiembros() {
    const cont = document.getElementById('familia-lista');
    if (!cont) return;
    const { data, error } = await supabase
        .from('usuarios_cliente')
        .select('id, nombre, rol')
        .eq('cliente_id', state.usuarioCliente.cliente_id)
        .order('rol', { ascending: true })   // 'principal' antes que 'secundario'
        .order('creado_en', { ascending: true });
    if (error) {
        console.error('[familia] error cargando miembros:', error);
        cont.innerHTML = '<p class="error-message">No se pudieron cargar los familiares.</p>';
        return;
    }
    cont.innerHTML = (data || []).map((m) => {
        const esPrincipal = m.rol === 'principal';
        const etiqueta = esPrincipal ? 'Principal' : 'Familiar';
        const quitar = esPrincipal ? '' :
            `<button type="button" class="familia-fila__quitar" data-id="${escapeHTML(m.id)}" data-nombre="${escapeHTML(m.nombre)}">Quitar</button>`;
        return `<div class="familia-fila">
            <div class="familia-fila__info">
                <span class="familia-fila__nombre">${escapeHTML(m.nombre)}</span>
                <span class="familia-fila__rol">${etiqueta}</span>
            </div>
            ${quitar}
        </div>`;
    }).join('');
}

async function enviarInvitacionFamiliar() {
    const nombreEl = document.getElementById('familia-inv-nombre');
    const emailEl = document.getElementById('familia-inv-email');
    const errEl = document.getElementById('familia-inv-error');
    const btn = document.getElementById('familia-invitar');

    const nombre = (nombreEl.value || '').trim();
    const email = (emailEl.value || '').trim().toLowerCase();
    errEl.hidden = true;
    errEl.textContent = '';

    if (!nombre) { errEl.textContent = 'Escribe el nombre del familiar.'; errEl.hidden = false; return; }
    if (!EMAIL_RE.test(email)) { errEl.textContent = 'Email inválido.'; errEl.hidden = false; return; }

    btn.disabled = true;
    btn.textContent = 'Enviando…';

    const { data, error } = await supabase.functions.invoke('invitar-familiar', {
        body: { email, nombre },
    });

    // Mismo manejo que admin/cliente.js: si la función responde 4xx/5xx,
    // el cuerpo { ok, error } viene en error.context.
    let resultado = data;
    if (error?.context && typeof error.context.json === 'function') {
        resultado = await error.context.json().catch(() => null);
    }

    if (!resultado?.ok) {
        const detalle = resultado?.error || error?.message || 'No se pudo enviar la invitación.';
        console.error('[familia] invitar-familiar falló:', { detalle, error });
        errEl.textContent = detalle;
        errEl.hidden = false;
        btn.disabled = false;
        btn.textContent = 'Invitar familiar';
        return;
    }

    nombreEl.value = '';
    emailEl.value = '';
    toast(`Invitación enviada a ${nombre}`, 'info');
    await cargarYRenderMiembros();

    btn.disabled = false;
    btn.textContent = 'Invitar familiar';
}

async function quitarFamiliar(id, nombre) {
    if (!id) return;
    if (!confirm(`¿Quitar a ${nombre} de tu familia? Perderá el acceso a la app.`)) return;
    const { error } = await supabase
        .from('usuarios_cliente')
        .delete()
        .eq('id', id);
    if (error) {
        console.error('[familia] error al quitar familiar:', error);
        toast('No se pudo quitar al familiar', 'error');
        return;
    }
    toast(`${nombre} ya no tiene acceso`, 'info');
    await cargarYRenderMiembros();
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
        .order('prioridad', { ascending: true })
        .order('created_at', { ascending: true });
    if (error) {
        console.error('[app] error cargando perros:', error);
        throw error;
    }
    return data || [];
}

async function cargarCliente(clienteId) {
    if (!clienteId) return null;
    // Campos editables (modal "Mis datos") + pack_actual (para el hero).
    const { data, error } = await supabase
        .from('clientes')
        .select('id, nombre, telefono, email, direccion, ubicacion_maps, zona, pack_actual, clase_extra_habilitada, estado')
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
        .select('id, ejercicio_id, posicion_rutina, progresa_de, min_semanal, max_diario, valor_comida, dificultad, objetivo_seg, objetivo_distancia, reps_sugeridas_min, reps_sugeridas_max, ejercicios (id, codigo, nombre, descripcion, categoria, como_se_hace, instrucciones, video_url)')
        .eq('perro_id', perroId)
        .eq('activo', true)
        .order('posicion_rutina', { ascending: true });
    if (error) {
        console.error('[app] error cargando rutina:', error);
        throw error;
    }
    return data || [];
}

// ───────────────────────────────────────────────────────────
// Cumplimiento de targets (Paso 6 — parte 1)
// ───────────────────────────────────────────────────────────

// Cache de la RPC get_progreso_perro: { ejercicio_asignado_id → row }
const _progresoCache = new Map();

// Cache de la RPC get_racha_perro: { ejercicio_asignado_id → racha_semanas }
const _rachaCache = new Map();

// Cache del historial semanal por ejercicio, calculado 100% en el frontend
// (sin RPC nueva): { ejercicio_asignado_id → [{ idx, count, estado, actual }] }.
// Semana 0 = la de asignación; cada semana es una ventana de 7 días desde
// asignado_en. El color de cada semana usa la MISMA lógica que el chip.
const _historialCache = new Map();

// Lunes 00:00:00 local en ISO (UTC). Si hoy es domingo, retrocede 6 días.
function inicioSemanaLocalIso() {
    const d = new Date();
    const dia = d.getDay();                  // 0=domingo, 1=lunes, ..., 6=sábado
    const offset = (dia === 0) ? 6 : (dia - 1);
    const lunes = new Date(d.getFullYear(), d.getMonth(), d.getDate() - offset, 0, 0, 0, 0);
    return lunes.toISOString();
}

// 'YYYY-MM-DD' del lunes local de esta semana (para registros_tarea.semana_inicio).
// Usa formatearFechaLocal (NO toISOString) para no correr el día en Madrid UTC+2.
function inicioSemanaLocalFecha() {
    const d = new Date();
    const dia = d.getDay();
    const offset = (dia === 0) ? 6 : (dia - 1);
    const lunes = new Date(d.getFullYear(), d.getMonth(), d.getDate() - offset, 0, 0, 0, 0);
    return formatearFechaLocal(lunes);
}

// 00:00:00 local de hoy en ISO (UTC).
function inicioDiaLocalIso() {
    const d = new Date();
    const inicio = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
    return inicio.toISOString();
}

// 'YYYY-MM-DD' del día LOCAL (sin toISOString, que correría el día en
// Madrid UTC+2). Mismo criterio que el formatearFechaLocal del admin.
function formatearFechaLocal(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

// ───────────────────────────────────────────────────────────
// Asistente Jaime (Fase 1, sin IA). Botón flotante + burbuja con UN aviso
// calculado por la RPC get_avisos_jaime. El botón vive siempre en la app;
// la burbuja se abre sola con el aviso (salvo 'al_dia' o descartado hoy) y se
// puede abrir/cerrar tocando el botón. Aditivo: si no hay aviso, error o no
// hay perro, la burbuja no se abre sola.
// ───────────────────────────────────────────────────────────
const JAIME_AVISO_OCULTO_KEY = 'jaime_aviso_oculto';
const JAIME_BIENVENIDA_KEY = 'jaime_bienvenida_vista';
let _jaimeAvisoActual = null;   // { texto, ctaLabel, ctaAccion } o null

function jaimeBienvenidaVista() {
    try { return localStorage.getItem(JAIME_BIENVENIDA_KEY) === '1'; } catch (_e) { return false; }
}
function marcarBienvenidaJaimeVista() {
    try { localStorage.setItem(JAIME_BIENVENIDA_KEY, '1'); } catch (_e) {}
}
// Primer nombre del tutor (la primera palabra de usuarioCliente.nombre).
function primerNombreTutor() {
    const n = state.usuarioCliente?.nombre;
    if (!n) return '';
    return String(n).trim().split(/\s+/)[0] || '';
}

// Burbuja de bienvenida (primera vez). Auto-abierta, con prioridad sobre el
// aviso normal. Botones: "Hablar con Jaime" (existente) y "Ver el tutorial".
function mostrarBienvenidaJaime(perro) {
    const nom = primerNombreTutor();
    const nombrePerro = perro?.nombre || 'tu perro';
    const saludo = nom ? `¡Hola, ${nom}!` : '¡Hola!';
    const texto = `${saludo} Soy Jaime, el asistente de Perros de la Isla. Estoy aquí para ayudarte con la app y con la rutina de ${nombrePerro}: pregúntame lo que necesites, como registrar una clase o ver el progreso. ¿Te enseño cómo funciona la app?`;
    // En bienvenida no usamos el CTA normal; mostramos chat + "Ver el tutorial".
    _jaimeAvisoActual = { texto, ctaLabel: '', ctaAccion: null };
    document.getElementById('jaime-burbuja__tutorial')?.removeAttribute('hidden');
    abrirBurbujaJaime();
}

function pintarBurbujaJaime() {
    const textoEl = document.getElementById('jaime-burbuja__texto');
    const ctaEl = document.getElementById('jaime-burbuja__cta');
    const a = _jaimeAvisoActual;
    if (textoEl) textoEl.textContent = a ? a.texto : 'Por hoy no hay novedades. ¡Seguimos!';
    if (ctaEl) {
        if (a && a.ctaLabel && a.ctaAccion) {
            ctaEl.textContent = a.ctaLabel;
            ctaEl.onclick = a.ctaAccion;
            ctaEl.hidden = false;
        } else {
            ctaEl.onclick = null;
            ctaEl.hidden = true;
        }
    }
}

function abrirBurbujaJaime() {
    pintarBurbujaJaime();
    document.getElementById('jaime-burbuja')?.removeAttribute('hidden');
}

function cerrarBurbujaJaime() {
    document.getElementById('jaime-burbuja')?.setAttribute('hidden', '');
}

// Deep-link desde un aviso de Jaime: lleva a Rutina, activa el subtab de la
// categoría y abre la card puntual del item (por su ejercicio_asignado_id).
// Si no se encuentra la card, se queda en Rutina (comportamiento neutro).
function irAItemRutina(asignadoId, categoria) {
    showTab('rutina');

    // Activar el subtab de la categoría (mismo mecanismo que el handler de
    // .rutina-subtab y el swipe de sub-pestañas).
    if (categoria && categoria !== state.rutinaCategoriaActiva) {
        state.rutinaCategoriaActiva = categoria;
        document.querySelectorAll('.rutina-subtab').forEach((b) => {
            const isActive = b.dataset.cat === categoria;
            b.classList.toggle('is-active', isActive);
            b.setAttribute('aria-selected', isActive ? 'true' : 'false');
        });
        renderRutinaPerroSeleccionado();
    }

    if (!asignadoId) return;

    // Doble rAF: esperar a que el re-render de la rutina haya pintado el DOM.
    requestAnimationFrame(() => requestAnimationFrame(() => {
        const card = document.querySelector(
            `.rutina-card[data-asignado-id="${CSS.escape(String(asignadoId))}"]`
        );
        if (!card) return; // caso borde: nos quedamos en Rutina.
        card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        // Mismo efecto que tocar la card (cf. abrirDesdeCard, clausura local):
        // buscar la fila por su ejercicio-id y abrir el modal.
        const fila = (state.rutinaFilas || [])
            .find((r) => r.ejercicios && r.ejercicios.id === card.dataset.ejercicioId);
        if (fila) abrirModalEjercicio(fila.ejercicios, fila.id);
    }));
}

async function cargarAvisoJaime() {
    const fab = document.getElementById('jaime-fab');
    if (!fab) return;

    // Bind del FAB (toggle) y del ✕ — idempotente (onclick reasignado).
    fab.onclick = () => {
        const b = document.getElementById('jaime-burbuja');
        if (!b) return;
        if (b.hasAttribute('hidden')) abrirBurbujaJaime();
        else cerrarBurbujaJaime();
    };
    const cerrarEl = document.getElementById('jaime-burbuja__cerrar');
    if (cerrarEl) cerrarEl.onclick = () => {
        try { localStorage.setItem(JAIME_AVISO_OCULTO_KEY, formatearFechaLocal(new Date())); } catch (_e) {}
        // Cerrar la burbuja también da por vista la bienvenida (no vuelve a salir).
        marcarBienvenidaJaimeVista();
        cerrarBurbujaJaime();
    };

    const perro = state.perros.find((p) => p.id === state.perroSeleccionadoId);

    // Bienvenida de Jaime (primera vez): prioridad sobre el aviso normal.
    if (perro && state.usuarioCliente && !jaimeBienvenidaVista()) {
        mostrarBienvenidaJaime(perro);
        return;
    }
    // Fuera de la bienvenida, el botón "Ver el tutorial" nunca se muestra.
    document.getElementById('jaime-burbuja__tutorial')?.setAttribute('hidden', '');

    if (!perro) { _jaimeAvisoActual = null; cerrarBurbujaJaime(); return; }

    let data = null;
    try {
        // Estado del pack para el aviso 'agendar_clase' (reusa la función ya
        // existente; si pack_actual es null devuelve {pack_actual:null} y el
        // ?? 0 deja los params en 0 → el aviso no salta).
        const _packJaime = calcularEstadoPack(state.cliente, state.citas);
        const { data: d, error } = await supabase.rpc('get_avisos_jaime', {
            p_perro_id: perro.id,
            p_inicio_semana: inicioSemanaLocalIso(),
            p_inicio_dia: inicioDiaLocalIso(),
            p_por_reservar: _packJaime?.por_reservar ?? 0,
            p_confirmadas_futuras: _packJaime?.confirmadas_futuras_del_pack ?? 0,
        });
        if (error) throw error;
        data = d;
    } catch (e) {
        console.error('[jaime] no se pudo cargar el aviso:', e);
        _jaimeAvisoActual = null; cerrarBurbujaJaime(); return;
    }
    if (!data || !data.tipo) { _jaimeAvisoActual = null; cerrarBurbujaJaime(); return; }

    const nombre = data.perro || perro.nombre || 'tu perro';
    let texto = '';
    let ctaLabel = '';
    let ctaAccion = null;

    switch (data.tipo) {
        case 'informe':
            texto = `Te hemos dejado el resumen de la semana de ${nombre}. ¡Échale un ojo!`;
            ctaLabel = 'Ver resumen';
            ctaAccion = () => showTab('mensajes');
            break;
        case 'mensaje': {
            const n = Number(data.n) || 1;
            texto = n > 1
                ? `Tienes ${n} mensajes nuestros sin leer.`
                : 'Tienes un mensaje nuestro sin leer.';
            ctaLabel = 'Abrir mensajes';
            ctaAccion = () => showTab('mensajes');
            break;
        }
        case 'checkin':
        case 'sin_entrenar':    // compat RPC viejo → tratar como silencio
        case 'agendar_clase': { // compat RPC viejo → tratar como sin agendar
            const silencio   = data.tipo === 'sin_entrenar' ? true : !!data.silencio;
            const sinAgendar = data.tipo === 'agendar_clase' ? true : !!data.sin_agendar;
            if (silencio && sinAgendar) {
                texto = `Hace unos días que no tenemos noticias de ${nombre}. ¿Va todo bien? Os queda además una clase por reservar. Si queréis que os echemos una mano con lo que sea, escribidnos. 🐾`;
                ctaLabel = 'Escríbenos';
                ctaAccion = () => showTab('mensajes');
            } else if (sinAgendar) {
                texto = `¿Va todo bien? Os queda una clase por reservar y aún no tenéis fecha. Cuando queráis elegís el día desde aquí, y si necesitáis algo, nos escribís. 🐾`;
                ctaLabel = 'Reservar clase';
                ctaAccion = () => showTab('reservar');
            } else {
                texto = `Hace unos días que no tenemos noticias de ${nombre}. ¿Va todo bien? Si os cuesta registrar los entrenos, tenéis dudas o necesitáis cualquier cosa, escribidnos: estamos aquí. 🐾`;
                ctaLabel = 'Escríbenos';
                ctaAccion = () => showTab('mensajes');
            }
            break;
        }
        case 'flojo':
            texto = `Esta semana '${data.ejercicio}' va con menos práctica de lo habitual. ¿Todo bien con él? Si se os complica o tenéis dudas, escribidnos y lo vemos juntos.`;
            ctaLabel = 'Ir al ejercicio';
            ctaAccion = () => irAItemRutina(data.ejercicio_asignado_id, 'ejercicio');
            break;
        case 'tarea_floja': {
            const tNom = (data.tarea || '').trim();
            texto = tNom
                ? `Esta semana no hemos visto registros de '${tNom}' para ${nombre}. ¿Va todo bien? Si necesitáis una mano con ella, aquí estamos.`
                : `Esta semana no hemos visto registros de esta tarea para ${nombre}. ¿Va todo bien? Si necesitáis una mano, aquí estamos.`;
            ctaLabel = 'Ir a la tarea';
            ctaAccion = () => irAItemRutina(data.ejercicio_asignado_id, 'tarea');
            break;
        }
        case 'al_dia':
            texto = `¡${nombre} viene constante! Seguid así. Cualquier duda, escríbenos.`;
            ctaLabel = '';
            ctaAccion = null;
            break;
        case 'racha': {
            // Felicitación: sin CTA (como 'al_dia'). Si no viene el número, texto neutro.
            const n = Number(data.n) || 0;
            texto = n > 0
                ? `¡${nombre} lleva ${n} semanas seguidas entrenando! Qué constancia, así da gusto.`
                : `¡${nombre} lleva varias semanas seguidas entrenando! Qué constancia, así da gusto.`;
            ctaLabel = '';
            ctaAccion = null;
            break;
        }
        case 'regreso':
            texto = `¡Qué bueno volver a verte con ${nombre}! Retomar es lo más difícil y ya está hecho.`;
            ctaLabel = '';
            ctaAccion = null;
            break;
        case 'semana_redonda':
            texto = `¡${nombre} ya cumplió todas sus metas de esta semana! Genial.`;
            ctaLabel = '';
            ctaAccion = null;
            break;
        default:
            _jaimeAvisoActual = null; cerrarBurbujaJaime(); return;
    }

    _jaimeAvisoActual = { texto, ctaLabel, ctaAccion };
    pintarBurbujaJaime();

    // Apertura automática.
    // · Felicitaciones (racha/regreso/semana_redonda): auto-abren UNA VEZ POR
    //   SEMANA por tipo (flag semanal en localStorage). Si ya saltaron esta
    //   semana, no vuelven a saltar solas (siguen visibles tocando la carita).
    // · al_dia: nunca auto-abre.
    // · Resto (informe/mensaje/sin_entrenar/flojo/tarea_floja): gate diario
    //   descartadoHoy, exactamente como antes.
    const TIPOS_FELICITACION = ['racha', 'regreso', 'semana_redonda'];
    if (data.tipo === 'checkin' || data.tipo === 'sin_entrenar' || data.tipo === 'agendar_clase') {
        // Check-in "¿va todo bien?": reaparece cada 3 días (no machaca a diario).
        const KEY = 'jaime_checkin_visto';
        const hoyIso = formatearFechaLocal(new Date());
        const ultimo = localStorage.getItem(KEY);
        let diasDesde = Infinity;
        if (ultimo) {
            diasDesde = Math.floor((new Date(hoyIso) - new Date(ultimo)) / 86400000);
        }
        if (diasDesde >= 3) {
            localStorage.setItem(KEY, hoyIso);
            abrirBurbujaJaime();
        } else {
            cerrarBurbujaJaime();
        }
    } else if (TIPOS_FELICITACION.includes(data.tipo)) {
        const claveFelic = 'jaime_felic_' + data.tipo + '_' + inicioSemanaLocalFecha();
        if (!localStorage.getItem(claveFelic)) {
            localStorage.setItem(claveFelic, '1');
            abrirBurbujaJaime();
        } else {
            cerrarBurbujaJaime();
        }
    } else {
        const descartadoHoy = (localStorage.getItem(JAIME_AVISO_OCULTO_KEY) === formatearFechaLocal(new Date()));
        if (data.tipo !== 'al_dia' && !descartadoHoy) {
            abrirBurbujaJaime();
        } else {
            cerrarBurbujaJaime();
        }
    }
}

// ───────────────────────────────────────────────────────────
// Jaime Fase 2 — chat conversacional con IA (edge function asistente-cliente).
// Historial en memoria de sesión (no se persiste). Aditivo sobre la Fase 1.
// ───────────────────────────────────────────────────────────
let _jaimeChatHist = [];   // [{ role:'user'|'assistant', content:string }]
const JAIME_CHAT_ERROR = 'Uy, ahora mismo no puedo responder. Prueba de nuevo en un momento, o escríbele a tu adiestrador desde Mensajes.';

// Estados de la carita de Jaime (solo front: swap del src de la imagen).
const JAIME_CARAS = {
    normal: 'img/jaime.png',
    durmiendo: 'img/jaime-durmiendo.png',
    pensando: 'img/jaime-pensando.png',
};
let _jaimeEstado = 'normal';
let _jaimeInactivTimer = null;

// Cambia la carita del FAB y, si el chat está abierto, la de su cabecera.
// Sin parpadeos: solo reescribe el src si cambió. No toca las caritas por
// mensaje del chat (esas son fijas).
function setJaimeCara(estado) {
    if (!JAIME_CARAS[estado]) estado = 'normal';
    _jaimeEstado = estado;
    const src = JAIME_CARAS[estado];
    const fabImg = document.querySelector('#jaime-fab img');
    if (fabImg && fabImg.getAttribute('src') !== src) fabImg.setAttribute('src', src);
    // El "zzz" flotante solo se ve en estado dormido.
    document.getElementById('jaime-fab')?.classList.toggle('is-durmiendo', estado === 'durmiendo');
    const chat = document.getElementById('jaime-chat');
    if (chat && !chat.hasAttribute('hidden')) {
        const cabImg = chat.querySelector('.jaime-chat__cara');
        if (cabImg && cabImg.getAttribute('src') !== src) cabImg.setAttribute('src', src);
    }
}

// Inactividad: 45s sin interacción → 'durmiendo'. Cualquier interacción
// despierta. No duerme con el chat abierto ni mientras está 'pensando'.
function jaimeReiniciarInactividad() {
    if (_jaimeInactivTimer) clearTimeout(_jaimeInactivTimer);
    if (_jaimeEstado === 'durmiendo') setJaimeCara('normal');
    _jaimeInactivTimer = setTimeout(() => {
        const chat = document.getElementById('jaime-chat');
        const chatAbierto = chat && !chat.hasAttribute('hidden');
        if (_jaimeEstado === 'pensando' || chatAbierto) return;
        setJaimeCara('durmiendo');
    }, 45000);
}

function bindJaimeInactividad() {
    ['pointerdown', 'keydown', 'scroll'].forEach((ev) => {
        document.addEventListener(ev, jaimeReiniciarInactividad, { passive: true });
    });
    jaimeReiniciarInactividad();   // arranca el conteo
}

function bindJaimeChat() {
    const abrirBtn = document.getElementById('jaime-burbuja__chat');
    if (abrirBtn) abrirBtn.onclick = () => { marcarBienvenidaJaimeVista(); cerrarBurbujaJaime(); abrirChatJaime(); };

    // "Ver el tutorial" (solo visible en la bienvenida): lanza el tour.
    const tutBtn = document.getElementById('jaime-burbuja__tutorial');
    if (tutBtn) tutBtn.onclick = () => {
        marcarBienvenidaJaimeVista();
        cerrarBurbujaJaime();
        try { window.PdliTour?.abrir(); } catch (_e) { console.error('[jaime] no se pudo abrir el tour:', _e); }
    };

    const cerrarBtn = document.getElementById('jaime-chat__cerrar');
    if (cerrarBtn) cerrarBtn.onclick = cerrarChatJaime;

    const enviarBtn = document.getElementById('jaime-chat__enviar');
    if (enviarBtn) enviarBtn.onclick = enviarChatJaime;

    const input = document.getElementById('jaime-chat__input');
    if (input) {
        // Enter envía; Shift+Enter = salto de línea. Auto-crece la altura.
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); enviarChatJaime(); }
        });
        input.addEventListener('input', () => {
            input.style.height = 'auto';
            input.style.height = Math.min(input.scrollHeight, 96) + 'px';
        });
    }

    // Timer de inactividad de la carita (durmiendo). Una sola vez.
    bindJaimeInactividad();
}

function abrirChatJaime() {
    const panel = document.getElementById('jaime-chat');
    if (!panel) return;
    panel.removeAttribute('hidden');
    // Primera apertura de la sesión (historial vacío) → cargar la conversación
    // guardada del perro. Reapertura (ya hay mensajes) → mostrar lo que hay.
    if (_jaimeChatHist.length === 0) {
        cargarHistorialJaime();
    }
    document.getElementById('jaime-chat__input')?.focus();
}

// Siembra el saludo/aviso como primer mensaje (comportamiento original).
// Se usa como fallback cuando no hay historial guardado o falla la carga.
function sembrarSaludoJaime() {
    if (_jaimeChatHist.length > 0) return;
    const perro = state.perros.find((p) => p.id === state.perroSeleccionadoId);
    const nombre = perro?.nombre || 'tu perro';
    const nomTutor = primerNombreTutor();
    const hola = nomTutor ? `¡Hola, ${nomTutor}!` : '¡Hola!';
    const primer = (_jaimeAvisoActual && _jaimeAvisoActual.texto)
        ? _jaimeAvisoActual.texto
        : `${hola} ¿Te ayudo con la app o con la rutina de ${nombre}?`;
    _jaimeChatHist.push({ role: 'assistant', content: primer });
    pintarMsgJaime('assistant', primer);
    // Chat fresco (saludo, sin historial): ofrecemos chips de preguntas frecuentes.
    mostrarChipsJaime();
}

// Chips de preguntas frecuentes debajo del saludo (solo en chat fresco).
// Tocar uno escribe la pregunta en el input y reusa enviarChatJaime().
function mostrarChipsJaime() {
    const cont = document.getElementById('jaime-chat__msgs');
    if (!cont || document.getElementById('jaime-chat__chips')) return;
    const perro = state.perros.find((p) => p.id === state.perroSeleccionadoId);
    const nombre = perro?.nombre || 'mi perro';
    const preguntas = [
        '¿Cómo registro una clase?',
        `¿Cómo viene ${nombre}?`,
        '¿Qué hago esta semana?',
    ];
    const fila = document.createElement('div');
    fila.id = 'jaime-chat__chips';
    fila.className = 'jaime-chat__chips';
    preguntas.forEach((q) => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'jaime-chat__chip';
        chip.textContent = q;
        chip.addEventListener('click', () => {
            const input = document.getElementById('jaime-chat__input');
            if (input) input.value = q;
            enviarChatJaime();
        });
        fila.appendChild(chip);
    });
    cont.appendChild(fila);
    cont.scrollTop = cont.scrollHeight;
}

// Carga los últimos 20 mensajes guardados del perro (tabla mensajes_jaime,
// RLS limita a los perros del cliente) y los pinta en orden cronológico.
// Si no hay nada guardado o falla, cae al saludo/aviso de siempre.
let _jaimeHistCargando = false;
async function cargarHistorialJaime() {
    if (_jaimeChatHist.length > 0 || _jaimeHistCargando) return;
    _jaimeHistCargando = true;
    try {
        const perro = state.perros.find((p) => p.id === state.perroSeleccionadoId);
        let filas = [];
        if (perro) {
            const { data, error } = await supabase
                .from('mensajes_jaime')
                .select('rol, contenido')
                .eq('perro_id', perro.id)
                .order('created_at', { ascending: false })
                .limit(20);
            if (!error && Array.isArray(data)) filas = data;
        }
        // Si entre medio ya se sembró/cargó algo, no duplicar.
        if (_jaimeChatHist.length > 0) return;

        if (filas.length > 0) {
            // La query trae de más reciente a más viejo: invertimos a orden
            // cronológico (el más viejo arriba) antes de pintar.
            filas.reverse();
            filas.forEach((f) => {
                const role = (f.rol === 'user') ? 'user' : 'assistant';
                _jaimeChatHist.push({ role, content: f.contenido });
                pintarMsgJaime(role, f.contenido);
            });
        } else {
            // Sin historial guardado → saludo/aviso como hoy.
            sembrarSaludoJaime();
        }
    } catch (e) {
        console.error('[jaime-chat] error cargando historial:', e);
        sembrarSaludoJaime();
    } finally {
        _jaimeHistCargando = false;
    }
}

function cerrarChatJaime() {
    // No borra el historial: al reabrir sigue la charla de la sesión.
    document.getElementById('jaime-chat')?.setAttribute('hidden', '');
}

function pintarMsgJaime(role, texto) {
    const cont = document.getElementById('jaime-chat__msgs');
    if (!cont) return;
    const esJaime = (role !== 'user');
    const fila = document.createElement('div');
    fila.className = 'jaime-chat__fila jaime-chat__fila--' + (esJaime ? 'jaime' : 'user');
    if (esJaime) {
        const cara = document.createElement('img');
        cara.className = 'jaime-chat__msgcara';
        cara.src = 'img/jaime.png';
        cara.alt = 'Jaime';
        fila.appendChild(cara);
    }
    const burb = document.createElement('div');
    burb.className = 'jaime-chat__burb';
    burb.textContent = texto;   // textContent: sin inyección de HTML
    fila.appendChild(burb);
    cont.appendChild(fila);
    cont.scrollTop = cont.scrollHeight;
}

function mostrarEscribiendoJaime() {
    const cont = document.getElementById('jaime-chat__msgs');
    if (!cont || document.getElementById('jaime-chat__typing')) return;
    const fila = document.createElement('div');
    fila.id = 'jaime-chat__typing';
    fila.className = 'jaime-chat__fila jaime-chat__fila--jaime';
    fila.innerHTML = '<img class="jaime-chat__msgcara" src="img/jaime.png" alt="Jaime">'
        + '<div class="jaime-chat__burb jaime-chat__burb--typing"><span></span><span></span><span></span></div>';
    cont.appendChild(fila);
    cont.scrollTop = cont.scrollHeight;
}

function quitarEscribiendoJaime() {
    document.getElementById('jaime-chat__typing')?.remove();
}

async function enviarChatJaime() {
    const input = document.getElementById('jaime-chat__input');
    const enviarBtn = document.getElementById('jaime-chat__enviar');
    if (!input) return;
    const texto = input.value.trim();
    if (!texto) return;

    // Al primer envío (por chip o escribiendo) quitamos los chips de sugerencias.
    document.getElementById('jaime-chat__chips')?.remove();

    // Mensaje del tutor → UI + historial. Limpiamos input.
    pintarMsgJaime('user', texto);
    _jaimeChatHist.push({ role: 'user', content: texto });
    input.value = '';
    input.style.height = 'auto';

    if (enviarBtn) enviarBtn.disabled = true;
    mostrarEscribiendoJaime();
    setJaimeCara('pensando');

    const perro = state.perros.find((p) => p.id === state.perroSeleccionadoId);
    try {
        if (!perro) throw new Error('sin perro seleccionado');
        const { data, error } = await supabase.functions.invoke('asistente-cliente', {
            body: { perro_id: perro.id, mensajes: _jaimeChatHist.slice(-20) },
        });
        if (error) throw error;
        if (data && data.ok && data.reply) {
            _jaimeChatHist.push({ role: 'assistant', content: data.reply });
            pintarMsgJaime('assistant', data.reply);
        } else {
            // Error de la función: mensaje neutro (NO se agrega al historial).
            pintarMsgJaime('assistant', JAIME_CHAT_ERROR);
        }
    } catch (e) {
        console.error('[jaime-chat] error invocando asistente-cliente:', e);
        pintarMsgJaime('assistant', JAIME_CHAT_ERROR);
    } finally {
        quitarEscribiendoJaime();
        setJaimeCara('normal');
        if (enviarBtn) enviarBtn.disabled = false;
        input.focus();
    }
}

// Evalúa el progreso de un ejercicio asignado usando el helper compartido
// frecuencia.js (mismo lugar que el admin). Devuelve un objeto con la
// forma legacy para no romper consumidores:
//   { tieneTarget, estado, chipTexto, superoTopeDiario }
function evaluarProgresoEjercicio(row) {
    const out = {
        tieneTarget: false,
        estado: 'sin',
        chipTexto: '',
        superoTopeDiario: false,
    };
    if (!row) return out;

    const estado = estadoChipFrecuencia(row.min_semanal, row.max_diario, row.count_7d);
    if (estado === 'sin') return out;

    out.tieneTarget = true;
    out.estado = estado;
    out.chipTexto = textoChipFrecuencia(row.min_semanal, row.max_diario, row.count_7d);
    // Útil para el cartel post-guardar cuando el cliente reporta y pasa
    // el tope diario.
    out.superoTopeDiario = (row.max_diario != null && row.max_diario > 0
                            && Number(row.count_dia ?? 0) > row.max_diario);
    return out;
}

async function cargarProgresoPerro(perroId) {
    if (!perroId) {
        _progresoCache.clear();
        return [];
    }
    const { data, error } = await supabase.rpc('get_progreso_perro', {
        p_perro_id: perroId,
        p_inicio_semana: inicioSemanaLocalIso(),
        p_inicio_dia: inicioDiaLocalIso(),
    });
    if (error) {
        console.error('[progreso] error RPC:', error);
        throw error;
    }
    _progresoCache.clear();
    (data || []).forEach((row) => _progresoCache.set(row.ejercicio_asignado_id, row));
    return data || [];
}

// Historial semanal por ejercicio, 100% frontend. Lee los registros que el
// RLS ya le permite al cliente (sus propios ejercicios_asignados + registros)
// y los agrupa en ventanas de 7 días ancladas a asignado_en (la "primera
// clase"). El color de cada semana sale de estadoChipFrecuencia, igual que el
// chip — misma metodología, sin inventar nada ni tocar la base.
async function cargarHistorialSemanal(perroId) {
    _historialCache.clear();
    if (!perroId) return;

    const { data: asignados, error: errA } = await supabase
        .from('ejercicios_asignados')
        .select('id, asignado_en, min_semanal, max_diario')
        .eq('perro_id', perroId)
        .eq('activo', true);
    if (errA) throw errA;
    if (!asignados || asignados.length === 0) return;

    const ids = asignados.map((a) => a.id);

    const { data: registros, error: errR } = await supabase
        .from('registros_ejercicio')
        .select('ejercicio_asignado_id, registrado_en')
        .in('ejercicio_asignado_id', ids);
    if (errR) throw errR;

    // Agrupo los timestamps de registro por ejercicio asignado.
    const tsPorAsignado = new Map();
    (registros || []).forEach((r) => {
        const t = new Date(r.registrado_en).getTime();
        if (!Number.isFinite(t)) return;
        if (!tsPorAsignado.has(r.ejercicio_asignado_id)) tsPorAsignado.set(r.ejercicio_asignado_id, []);
        tsPorAsignado.get(r.ejercicio_asignado_id).push(t);
    });

    const SEMANA_MS = 7 * 24 * 60 * 60 * 1000;
    const ahora = Date.now();

    asignados.forEach((a) => {
        const inicio = new Date(a.asignado_en).getTime();
        if (!Number.isFinite(inicio)) return;
        const totalSemanas = Math.max(1, Math.ceil((ahora - inicio) / SEMANA_MS));
        const counts = new Array(totalSemanas).fill(0);

        (tsPorAsignado.get(a.id) || []).forEach((t) => {
            if (t < inicio) return;
            const idx = Math.floor((t - inicio) / SEMANA_MS);
            if (idx >= 0 && idx < totalSemanas) counts[idx] += 1;
        });

        // Referencia para la altura de la barra: el objetivo de la semana.
        const referencia = (a.min_semanal && a.min_semanal > 0) ? a.min_semanal
                         : (a.max_diario && a.max_diario > 0) ? a.max_diario * 7
                         : 1;
        const semanas = counts.map((count, idx) => {
            // Altura 0 si no hizo nada; si hizo algo, mínimo 14% para que se vea.
            const pct = count === 0 ? 0
                      : Math.max(14, Math.min(100, Math.round((count / referencia) * 100)));
            return {
                idx,
                count,
                estado: estadoChipFrecuencia(a.min_semanal, a.max_diario, count),
                actual: (idx === totalSemanas - 1),
                pct,
            };
        });
        _historialCache.set(a.id, semanas);
    });
}

// Arma las cadenas de progresión a partir de las filas activas (copiada de
// admin/perro.js). vigente = fila cuyo id no aparece en progresa_de de ninguna
// otra fila. history = filas superadas, del paso más reciente al más viejo.
// En P3.1 el cliente solo usa el vigente; la historia es para P3.2.
function construirCadenas(rows) {
    const byId = new Map();
    rows.forEach((r) => byId.set(r.id, r));

    const referenced = new Set();
    rows.forEach((r) => {
        if (r.progresa_de) referenced.add(r.progresa_de);
    });

    return rows
        .filter((r) => !referenced.has(r.id))
        .map((vigente) => {
            const history = [];
            const guard = new Set();   // corta loops si los datos vinieran corruptos
            let cur = vigente.progresa_de ? byId.get(vigente.progresa_de) : null;
            while (cur && !guard.has(cur.id)) {
                guard.add(cur.id);
                history.push(cur);
                cur = cur.progresa_de ? byId.get(cur.progresa_de) : null;
            }
            return { vigente, history };
        });
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
        const { data, error } = await supabase.rpc('puede_cliente_reservar', { p_cliente_id: clienteId });
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
    if (name === 'reservar' && !esPrincipal()) name = 'rutina';
    const prev = state.currentTab;
    state.currentTab = name;

    // Si el usuario sale de Reservar sin completar una modificación,
    // descartamos el estado de modificación.
    if (name !== 'reservar' && state.modificando) {
        state.modificando = null;
    }

    document.querySelectorAll('.tab-panel').forEach((panel) => {
        const match = panel.dataset.tab === name;
        if (match) panel.removeAttribute('hidden');
        else panel.setAttribute('hidden', '');
        panel.classList.toggle('is-active', match);
    });

    // Animación de entrada direccional sobre el panel ya visible: entra desde
    // la derecha (tab posterior) o la izquierda (tab anterior). No anima en el
    // primer load, en la misma tab, ni si la tab está fuera del orden.
    const orden = ['rutina', 'reservar', 'mis-citas', 'salud', 'mensajes'];
    document.querySelectorAll('.tab-panel').forEach((p) =>
        p.classList.remove('tab-enter-right', 'tab-enter-left'));
    const oldIdx = orden.indexOf(prev);
    const newIdx = orden.indexOf(name);
    if (prev && prev !== name && oldIdx !== -1 && newIdx !== -1) {
        const dir = newIdx > oldIdx ? 'right' : 'left';
        const panelNuevo = document.querySelector('.tab-panel[data-tab="' + name + '"]');
        if (panelNuevo) {
            void panelNuevo.offsetWidth; // reflow para reiniciar la animación
            panelNuevo.classList.add('tab-enter-' + dir);
        }
    }

    document.querySelectorAll('.bottom-nav__btn').forEach((btn) => {
        btn.classList.toggle('is-active', btn.dataset.tabTarget === name);
    });

    // Render de cada tab al cambiarse (data fresca)
    if (name === 'reservar') renderTabReservar();
    if (name === 'mis-citas') renderTabMisCitas();
    if (name === 'salud') cargarTabSalud();
    if (name === 'mensajes') {
        // El composer debe quedar a la vista al entrar. Lo hacemos de inmediato
        // (sin esperar al fetch del feed, que en frío tarda y dejaba el scroll
        // colgado de la red) y de nuevo tras pintar el feed, por si el historial
        // crece y cambia la altura.
        scrollMensajesAlFondo();
        renderFeedMensajes().then(scrollMensajesAlFondo);
        marcarRespuestasLeidasYActualizar();
    }

    // Scroll al inicio del panel para que la transición se sienta limpia.
    // Excepción: Mensajes va al fondo, no arriba (se gestiona aparte).
    if (name !== 'mensajes') {
        window.scrollTo({ top: 0, behavior: 'instant' });
    }
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
    const fecha = d.toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' });
    const hora = d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
    return `${fecha} · ${hora}`;
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

    const familiaBtn = document.getElementById('familia-btn');
    if (familiaBtn) {
        if (state.usuarioCliente?.rol === 'principal') familiaBtn.removeAttribute('hidden');
        else familiaBtn.setAttribute('hidden', '');
    }

    document.body.classList.toggle('es-secundario', !esPrincipal());
}

function renderSelectorPerros() {
    const sel = document.getElementById('perro-selector');
    if (!sel) return;
    sel.removeAttribute('hidden');

    const pillsPerros = state.perros.map((p) => {
        const active = p.id === state.perroSeleccionadoId;
        const nombre = p.nombre || 'Perro';
        const ini = escapeHTML(nombre.trim().charAt(0).toUpperCase() || 'P');
        return `
            <button type="button" class="av${active ? ' is-active' : ''}"
                    data-perro-id="${escapeHTML(p.id)}"
                    aria-pressed="${active ? 'true' : 'false'}"
                    aria-label="${escapeHTML(nombre)}" title="${escapeHTML(nombre)}">
                <span class="ini" aria-hidden="true">${ini}</span>
            </button>
        `;
    }).join('');

    const pillAgregar = `
        <button type="button" class="add" id="perro-pill-add" aria-label="Añadir un perro" title="Añadir un perro">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>
        </button>
    `;

    sel.innerHTML = pillsPerros + pillAgregar;

    sel.querySelectorAll('.av').forEach((btn) => {
        btn.addEventListener('click', () => {
            const id = btn.dataset.perroId;
            if (!id || id === state.perroSeleccionadoId) return;
            state.perroSeleccionadoId = id;
            sessionStorage.setItem(STORAGE_PERRO_KEY, id);
            renderSelectorPerros();
            renderRutinaPerroSeleccionado();
            if (esVeterano()) renderManada();
        });
    });

    const btnAdd = document.getElementById('perro-pill-add');
    if (btnAdd) {
        btnAdd.addEventListener('click', abrirModalAgregarPerro);
    }
}

// ═══════════════════════════════════════════════════════════════════
// MANADA VETERANA (Fase 1) — pantalla de club que reemplaza el home del tab
// Rutina para el cliente veterano. El resto de tabs quedan intactos. Activo,
// inactivo y consulta NO ven nada de esto (solo el acceso al modal categorías).
// ═══════════════════════════════════════════════════════════════════

const IC_ARROW    = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>';
const IC_ENTRENO  = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12h2M2 12h2M6.5 6.5l0 11M17.5 6.5l0 11M6.5 12h11"/></svg>';
const IC_BIENESTAR= '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8z"/></svg>';
const IC_RESERVAR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9h18M7 3v3M17 3v3M5 5h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z"/></svg>';
const IC_GUIAS    = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>';
const IC_COMUNIDAD= '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>';
const IC_NEWS     = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"/><path d="M22 6l-10 7L2 6"/></svg>';
const IC_ONLINE   = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>';

// Alterna entre la Manada (veterano) y el home clásico (resto). En la Manada el
// hero clásico se colapsa a una barra de controles (clase is-manada): se ocultan
// foto de portada, "Hola, X", raza/edad y cámara; los controles (tema, selector,
// avatar/logout) y el badge/edición discretos siguen en esa barra. Al entrar a
// "Tu entrenamiento" el hero vuelve completo.
function aplicarModoManada() {
    const hero = document.getElementById('perro-hero');
    const manada = document.getElementById('manada-home');
    const clasica = document.getElementById('rutina-clasica');
    const backBar = document.getElementById('rutina-volver-manada');
    if (backBar) backBar.hidden = true;
    if (!manada || !clasica) return;
    if (esVeterano()) {
        renderManada();
        hero?.classList.add('is-manada');
        manada.hidden = false;
        clasica.hidden = true;      // el veterano entra por la Manada
    } else {
        hero?.classList.remove('is-manada');
        manada.hidden = true;
        clasica.hidden = false;
    }
}

// Veterano → abre la rutina clásica completa del perro elegido (hero entero de
// siempre), con vuelta a la Manada.
function entrarRutinaClasica() {
    const hero = document.getElementById('perro-hero');
    const manada = document.getElementById('manada-home');
    const clasica = document.getElementById('rutina-clasica');
    const backBar = document.getElementById('rutina-volver-manada');
    hero?.classList.remove('is-manada');
    if (manada) manada.hidden = true;
    if (clasica) clasica.hidden = false;
    if (backBar) backBar.hidden = !esVeterano();
    renderRutinaPerroSeleccionado();
    window.scrollTo({ top: 0, behavior: 'instant' });
}

function volverAManada() {
    const hero = document.getElementById('perro-hero');
    const manada = document.getElementById('manada-home');
    const clasica = document.getElementById('rutina-clasica');
    const backBar = document.getElementById('rutina-volver-manada');
    if (backBar) backBar.hidden = true;
    if (clasica) clasica.hidden = true;
    hero?.classList.add('is-manada');
    if (manada) { manada.hidden = false; renderManada(); }
    window.scrollTo({ top: 0, behavior: 'instant' });
}

function renderManada() {
    const cont = document.getElementById('manada-home');
    if (!cont) return;
    const perro = state.perros.find((p) => p.id === state.perroSeleccionadoId) || state.perros[0] || null;
    const nombrePerro = perro?.nombre || 'tu perro';
    const varios = state.perros.length > 1;

    const chip = (kind) => `
        <button type="button" class="mn-chip" data-mn-chip="${kind}"${varios ? '' : ' data-single="1"'} aria-label="Perro: ${escapeHTML(nombrePerro)}">
            <span class="mn-chip__nom">${escapeHTML(nombrePerro)}</span>${varios ? '<span class="mn-chip__car" aria-hidden="true">▾</span>' : ''}
        </button>`;

    const fotoChapa = perro?.foto_url
        ? `<img class="mn-chapa__foto" src="${escapeHTML(perro.foto_url)}" alt="">`
        : `<span class="mn-chapa__foto mn-chapa__foto--fb" style="--perro-color:${colorParaPerro(perro?.id || '')}">${escapeHTML((nombrePerro[0] || 'P').toUpperCase())}</span>`;

    cont.innerHTML = `
        <header class="mn-head">
            <div class="mn-chapa" role="img" aria-label="${escapeHTML(nombrePerro)}">
                <span class="mn-chapa__hook" aria-hidden="true"></span>
                <span class="mn-chapa__swing">
                    <span class="mn-chapa__disc">
                        ${fotoChapa}
                        <span class="mn-chapa__nombre">${escapeHTML(nombrePerro)}</span>
                    </span>
                </span>
            </div>

            <div class="mn-club">
                <div class="mn-club__t">MANADA</div>
                <div class="mn-club__s">PERROS DE LA ISLA</div>
                <span class="mn-club__u" aria-hidden="true"></span>
            </div>
        </header>

        <div class="mn-cards">
            <div class="mn-card" role="button" tabindex="0" data-mn-card="entreno">
                <span class="mn-card__ic">${IC_ENTRENO}</span>
                <span class="mn-card__tx"><span class="mn-card__t">Tu entrenamiento</span><span class="mn-card__s">Todo lo que trabajasteis juntos</span></span>
                ${chip('entreno')}
            </div>
            <div class="mn-card" role="button" tabindex="0" data-mn-card="bienestar">
                <span class="mn-card__ic">${IC_BIENESTAR}</span>
                <span class="mn-card__tx"><span class="mn-card__t">El bienestar</span><span class="mn-card__s">Cómo está hoy y su evolución</span></span>
                ${chip('bienestar')}
            </div>
            <div class="mn-card mn-card--accion" role="button" tabindex="0" data-mn-card="reservar">
                <span class="mn-card__ic mn-card__ic--rojo">${IC_RESERVAR}</span>
                <span class="mn-card__tx"><span class="mn-card__t">Reservar una clase</span><span class="mn-card__s">Vuelve a entrenar con el equipo</span></span>
                <span class="mn-card__arr" aria-hidden="true">${IC_ARROW}</span>
            </div>
            <div class="mn-card" role="button" tabindex="0" data-mn-card="guias">
                <span class="mn-card__ic">${IC_GUIAS}</span>
                <span class="mn-card__tx"><span class="mn-card__t">Guías para entender a tu perro</span><span class="mn-card__s">Las gratuitas, y ventaja de la Manada en el resto</span></span>
                <span class="mn-card__arr" aria-hidden="true">${IC_ARROW}</span>
            </div>
        </div>

        <div class="mn-sep"><span class="mn-sep__l"></span><span class="mn-sep__t">Incluido · Acceso de lanzamiento</span><span class="mn-sep__l"></span></div>

        <div class="mn-cards mn-cards--soon">
            <div class="mn-card mn-card--soon">
                <span class="mn-card__ic">${IC_COMUNIDAD}</span>
                <span class="mn-card__tx"><span class="mn-card__t">Manada de la Isla</span><span class="mn-card__s">La comunidad de tutores y perros</span></span>
                <span class="mn-badge mn-badge--soon">PRÓXIMAMENTE</span>
            </div>
            <div class="mn-card mn-card--soon">
                <span class="mn-card__ic">${IC_NEWS}</span>
                <span class="mn-card__tx"><span class="mn-card__t">Tu newsletter mensual</span><span class="mn-card__s">Personalizado para ${escapeHTML(nombrePerro)}</span></span>
                <span class="mn-badge mn-badge--soon">PRÓXIMAMENTE</span>
            </div>
            <div class="mn-card mn-card--soon">
                <span class="mn-card__ic">${IC_ONLINE}</span>
                <span class="mn-card__tx"><span class="mn-card__t">Clase online de mantenimiento</span><span class="mn-card__s">Una cada tres meses, incluida</span></span>
                <span class="mn-badge mn-badge--soon">PRÓXIMAMENTE</span>
            </div>
        </div>

        <div class="mn-foot">TU PERRO MERECE SER FELIZ <span class="mn-foot__hoy">HOY</span></div>
    `;

    // Nota: los clicks de tarjetas y de los chips de perro se gestionan con
    // handlers DELEGADOS bound una sola vez sobre #manada-home (ver bindEventos),
    // no aquí — así renderManada puede re-ejecutarse sin acumular listeners ni
    // romper el desplegable.
    cont.querySelectorAll('[data-mn-card]').forEach((el) => {
        el.addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter' || ev.key === ' ') {
                ev.preventDefault();
                if (ev.target.closest('[data-mn-chip]') || ev.target.closest('.mn-chip-menu')) return;
                onManadaCard(el.dataset.mnCard);
            }
        });
    });
}

function onManadaCard(kind) {
    if (kind === 'entreno') return entrarRutinaClasica();
    if (kind === 'bienestar') return showTab('salud');
    if (kind === 'reservar') return showTab('reservar');
    if (kind === 'guias') return abrirModal('modal-guias');
}

// Cierra cualquier desplegable de perro abierto en la Manada.
function cerrarMenusManada() {
    document.querySelectorAll('.mn-chip-menu').forEach((m) => m.remove());
}

// Aplica la selección de perro desde el desplegable de la Manada: cierra el
// menú y, si cambió, re-renderiza selector + rutina + Manada (la chapa y los
// chips pasan al perro elegido). La lógica de selección ya estaba verificada.
function seleccionarPerroManada(id) {
    cerrarMenusManada();
    if (!id || id === state.perroSeleccionadoId) return;
    state.perroSeleccionadoId = id;
    sessionStorage.setItem(STORAGE_PERRO_KEY, id);
    renderSelectorPerros();
    renderRutinaPerroSeleccionado();
    renderManada();
}

// Abre el desplegable de perro de un chip (solo construye el menú; la selección
// y el cierre los gobiernan los handlers delegados de bindEventos, calcando el
// patrón del menú del avatar).
function abrirDropdownPerroManada(chipEl) {
    cerrarMenusManada();
    const menu = document.createElement('div');
    menu.className = 'mn-chip-menu';
    menu.innerHTML = state.perros.map((p) => `
        <button type="button" class="mn-chip-menu__it${p.id === state.perroSeleccionadoId ? ' is-active' : ''}" data-perro-id="${escapeHTML(p.id)}">${escapeHTML(p.nombre || 'Perro')}</button>
    `).join('');
    chipEl.parentElement.appendChild(menu);
}

// ── Modal "Tu categoría" (todos los niveles salvo ex cliente) ──
const CATEGORIA_PASOS = [
    { key: 'consulta', t: 'CONSULTAS', s: 'Aún sin clase asignada' },
    { key: 'activo',   t: 'ACTIVO',    s: 'En clases con el equipo' },
    { key: 'inactivo', t: 'INACTIVO',  s: 'Protocolo a medias — se puede retomar' },
    { key: 'veterano', t: 'VETERANO',  s: 'Protocolo completado. Bienvenido a la Manada' },
];
const CATEGORIA_LABEL_CLIENTE = { consulta: 'Consulta', activo: 'Activo', inactivo: 'Inactivo', veterano: 'Veterano' };

function abrirModalCategoria() {
    const actual = state.cliente?.estado || 'activo';
    const cont = document.getElementById('modal-categoria-camino');
    if (cont) {
        cont.innerHTML = CATEGORIA_PASOS.map((p) => {
            const on = p.key === actual;
            return `
                <div class="cat-step${on ? ' is-now' : ''}">
                    <span class="cat-step__dot" aria-hidden="true"></span>
                    <span class="cat-step__tx">
                        <span class="cat-step__t">${p.t}${on ? ' <span class="cat-step__now">AHORA</span>' : ''}</span>
                        <span class="cat-step__s">${p.s}</span>
                    </span>
                </div>`;
        }).join('');
    }
    abrirModal('modal-categoria');
}

// Acceso discreto al modal categorías para activo/inactivo/consulta: chip en el
// hero. El veterano lo abre desde su badge; el ex cliente ni siquiera entra.
function renderCategoriaAcceso() {
    const chip = document.getElementById('hero-categoria-chip');
    if (!chip) return;
    const est = state.cliente?.estado;
    if (esVeterano() || esExCliente() || !est) { chip.hidden = true; return; }
    chip.textContent = CATEGORIA_LABEL_CLIENTE[est] || 'Tu categoría';
    chip.hidden = false;
}

// Días de uso de cada tarea en la semana actual: { ejercicio_asignado_id -> dias }.
// Se recarga al pintar la rutina del perro (registros_tarea de esta semana).
let _diasTareaSemana = {};

async function renderRutinaPerroSeleccionado() {
    const myToken = ++_renderRutinaToken;

    const hero = document.getElementById('perro-hero');
    const heroNombre = document.getElementById('perro-hero-nombre');
    const heroMeta = document.getElementById('perro-hero-meta');
    const protoBox = document.getElementById('perro-protocolo');
    const protoNombre = document.getElementById('perro-protocolo-nombre');
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
    document.getElementById('btn-seguimiento')?.setAttribute('hidden', '');
    // Bloque de productos recomendados: solo visible en la sub-pestaña Herramientas
    const cardProductosHerr = document.getElementById('card-productos-herramienta');
    if (cardProductosHerr) cardProductosHerr.hidden = (state.rutinaCategoriaActiva !== 'herramienta');

    const perro = state.perros.find((p) => p.id === state.perroSeleccionadoId);

    // Aviso del día de Jaime: independiente de la rutina y no bloquea el
    // render. Se ocupa solo de mostrarse/ocultarse (incl. cuando no hay perro).
    cargarAvisoJaime();

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

    // Entrada "Seguimiento de conductas"
    document.getElementById('btn-seguimiento')?.removeAttribute('hidden');

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
    const proto = formatearProtocolo(perro);
    if (proto && proto.nombre) {
        protoNombre.textContent = proto.nombre;
        const protoComp = document.getElementById('perro-protocolo-comp');
        if (proto.comp.length > 0) {
            protoComp.textContent = 'También: ' + proto.comp.join(', ');
            protoComp.removeAttribute('hidden');
        } else {
            protoComp.setAttribute('hidden', '');
        }
        protoBox.removeAttribute('hidden');
    }

    // Saldo del pack
    const pack = calcularEstadoPack(state.cliente, state.citas);
    if (pack.pack_actual != null) {
        saldoPack.textContent = pack.pack_actual;
        const _kR = document.getElementById('perro-saldo-realizadas');
        const _kV = document.getElementById('perro-saldo-reservar');
        if (_kR) _kR.textContent = pack.realizadas_del_pack ?? 0;
        if (_kV) _kV.textContent = pack.por_reservar ?? 0;
        if (saldoDetalle) saldoDetalle.textContent = formatearDetallePack(pack);
        saldoBox.removeAttribute('hidden');
    }

    // Ejercicios
    try {
        const filas = await cargarRutinaDelPerro(perro.id);
        state.rutinaFilas = filas;

        // Progreso (targets vs counts). Defensivo: si la RPC falla, la app
        // sigue funcionando sin chips ni anillo — solo log a consola.
        try {
            await cargarProgresoPerro(perro.id);
        } catch (e) {
            console.error('[progreso] continuando sin chips:', e);
        }

        // Días de uso de las tareas esta semana (registros_tarea). Aditivo: si
        // falla, las tareas igual se pintan con el control en 0.
        _diasTareaSemana = {};
        try {
            const idsTareas = filas
                .filter((f) => (f.ejercicios?.categoria) === 'tarea')
                .map((f) => f.id);
            if (idsTareas.length > 0) {
                const { data: regs, error } = await supabase
                    .from('registros_tarea')
                    .select('ejercicio_asignado_id, dias')
                    .in('ejercicio_asignado_id', idsTareas)
                    .eq('semana_inicio', inicioSemanaLocalFecha());
                if (error) throw error;
                (regs || []).forEach((r) => {
                    _diasTareaSemana[r.ejercicio_asignado_id] = Number(r.dias) || 0;
                });
            }
        } catch (e) {
            console.error('[tarea-dias] no se pudieron cargar:', e);
        }

        if (filas.length === 0) {
            // Si otra llamada ya tomó el control, dejamos que esa pinte.
            if (myToken !== _renderRutinaToken) return;
            loading.setAttribute('hidden', '');
            empty.removeAttribute('hidden');
            renderAnilloSemana();
            return;
        }

        // Cada renglón es una cadena de filas (progresa_de). El filtro de
        // sub-pestaña y el orden se aplican sobre el vigente, pero la historia
        // se conserva: un renglón con pasos superados se pinta como carrusel.
        const cadenasFiltradas = construirCadenas(filas)
            .filter((c) => (c.vigente.ejercicios?.categoria || 'ejercicio') === state.rutinaCategoriaActiva)
            .sort((a, b) => (a.vigente.posicion_rutina ?? 0) - (b.vigente.posicion_rutina ?? 0));

        if (cadenasFiltradas.length === 0) {
            if (myToken !== _renderRutinaToken) return;
            const labelsVacio = {
                ejercicio: 'Aún no hay ejercicios en la rutina.',
                cambio_rutina: 'Aún no hay cambios de rutina.',
                tarea: 'Aún no hay tareas.',
                herramienta: 'Aún no hay herramientas.',
            };
            const pVacio = empty.querySelector('p');
            if (pVacio) {
                pVacio.textContent = labelsVacio[state.rutinaCategoriaActiva]
                    || 'Aún no hay nada en esta categoría.';
            }
            loading.setAttribute('hidden', '');
            lista.setAttribute('hidden', '');
            empty.removeAttribute('hidden');
        } else {
            if (myToken !== _renderRutinaToken) return;
            loading.setAttribute('hidden', '');
            lista.innerHTML = cadenasFiltradas.map(renderRutinaCard).join('');
            lista.removeAttribute('hidden');
            empty.setAttribute('hidden', '');
        }

        renderAnilloSemana();
        // Si el usuario está mirando "Mi progreso", refrescar también su vista.
        if (state.rutinaModo === 'progreso') {
            renderAnilloProgreso();
            renderListaProgreso();
        }
    } catch (err) {
        if (myToken !== _renderRutinaToken) return;
        loading.setAttribute('hidden', '');
        empty.removeAttribute('hidden');
        toast('No pudimos cargar la rutina. Inténtalo de nuevo.', 'error');
    } finally {
        // Garantizar que el spinner siempre se oculta — evita "Cargando…"
        // colgado si la función se invoca varias veces seguidas o si hay
        // un return temprano en una rama futura.
        loading.setAttribute('hidden', '');
    }
}

// Recibe la cadena {vigente, history} de un renglón.
// Sin historia: una tarjeta simple (igual que siempre).
// Con historia: un carrusel horizontal con scroll-snap nativo, tarjetas en
// orden [paso más viejo … paso más reciente, vigente].
function renderRutinaCard(cadena) {
    const { vigente, history } = cadena;
    if (!history || history.length === 0) {
        return rutinaCardHTML(vigente, { tag: 'li', superado: false });
    }
    // DOM: vigente PRIMERO, después la historia (de más reciente a más vieja).
    // El track usa flex-direction: row-reverse, así que el vigente queda
    // visualmente a la derecha y la historia a la izquierda — igual que antes.
    // Clave: con row-reverse, scrollLeft = 0 (el estado natural en que el
    // navegador SIEMPRE arranca) ya muestra el primer hijo del DOM = el
    // vigente. No hay que posicionar nada por JS.
    const tarjetas = [rutinaCardHTML(vigente, { tag: 'article', superado: false })]
        .concat(history.map((row) => rutinaCardHTML(row, { tag: 'article', superado: true })))
        .join('');
    return `
        <li class="rutina-renglon">
            <div class="rutina-track" style="flex-direction: row-reverse;">
                ${tarjetas}
            </div>
        </li>
    `;
}

// Markup de una tarjeta de rutina. tag = 'li' para el renglón simple, 'article'
// para las tarjetas dentro de un carrusel. superado = paso anterior (apagado).
let _herramientaAsignadoActual = null;
let _herramientaEstadoCargado = null;

function pintarHerramientaBotones(valor) {
    const sw = document.getElementById('btn-herramienta-switch');
    if (!sw) return;
    // Switch ON solo si la tiene; cualquier otro caso (null) = OFF.
    sw.setAttribute('aria-checked', valor === 'tiene' ? 'true' : 'false');
}

function textoHerramientaDesde(valor, fechaIso) {
    const hint = document.getElementById('herramienta-estado-hint');
    if (!hint) return;
    if (valor === 'tiene') {
        let txt = 'Marcado como que ya la tienes.';
        if (fechaIso) { const f = new Date(fechaIso); if (!isNaN(f.getTime())) txt = 'La tienes desde el ' + f.toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' }) + '.'; }
        hint.textContent = txt; hint.hidden = false;
    } else { hint.hidden = true; }
}

async function renderHerramientaEstado(asignadoId) {
    _herramientaAsignadoActual = asignadoId;
    _herramientaEstadoCargado = null;
    const sw = document.getElementById('btn-herramienta-switch');
    const hint = document.getElementById('herramienta-estado-hint');
    if (hint) hint.hidden = true;
    pintarHerramientaBotones(null);
    // Toggle: si la tiene → apagar (null); si no → encender ('tiene').
    if (sw) sw.onclick = () => {
        const nuevo = (_herramientaEstadoCargado === 'tiene') ? null : 'tiene';
        guardarEstadoHerramienta(asignadoId, nuevo);
    };
    try {
        const { data, error } = await supabase.from('ejercicios_asignados').select('estado_cliente, estado_actualizado_en').eq('id', asignadoId).single();
        if (error) throw error;
        if (_herramientaAsignadoActual !== asignadoId) return;
        _herramientaEstadoCargado = data ? data.estado_cliente : null;
        pintarHerramientaBotones(_herramientaEstadoCargado);
        textoHerramientaDesde(_herramientaEstadoCargado, data ? data.estado_actualizado_en : null);
    } catch (e) { console.error('[herramienta] no se pudo leer estado:', e); }
}

async function guardarEstadoHerramienta(asignadoId, valor) {
    // Guarda contra reescribir el mismo valor (no resetea la fecha en cada render).
    if (valor === _herramientaEstadoCargado) return;
    pintarHerramientaBotones(valor);
    // Solo 'tiene' o null. La fecha "desde cuándo" se setea al encender; al
    // apagar se limpia. Nunca se escribe el valor que el constraint rechaza.
    const fecha = (valor === 'tiene') ? new Date().toISOString() : null;
    try {
        const { error } = await supabase.from('ejercicios_asignados').update({ estado_cliente: valor, estado_actualizado_en: fecha }).eq('id', asignadoId);
        if (error) throw error;
        _herramientaEstadoCargado = valor;
        textoHerramientaDesde(valor, fecha);
    } catch (e) { console.error('[herramienta] no se pudo guardar:', e); if (typeof toast === 'function') toast('No pudimos guardar. Intentalo de nuevo.', 'error'); }
}

function rutinaCardHTML(row, { tag, superado }) {
    const ej = row.ejercicios;
    if (!ej) return '';
    const nombre = escapeHTML(ej.nombre || 'Ejercicio');
    const categoria = ej.categoria || 'ejercicio';
    const desc = ej.descripcion && ej.descripcion.trim()
        ? `<p class="rutina-card__desc">${escapeHTML(ej.descripcion)}</p>`
        : '';
    const claseSuperado = superado ? ' rutina-card--superado' : '';
    const esTarea = (categoria === 'tarea');
    // Chip de progreso y texto de objetivo: no aplican a tareas (semánticamente
    // las tareas-lista no tienen "frecuencia"). Tampoco en cards superadas.
    const chip = (superado || esTarea) ? '' : renderChipProgreso(row.id);
    const objetivo = (superado || esTarea) ? '' : renderObjetivoBajoNombre(row.id);
    // Tareas: control "días que la usé esta semana" (0-7). No en cards superadas.
    const diasControl = (esTarea && !superado) ? renderTareaDiasControl(row.id) : '';
    return `
        <${tag} class="rutina-card${claseSuperado}" data-categoria="${escapeHTML(categoria)}" data-ejercicio-id="${escapeHTML(ej.id)}" data-asignado-id="${escapeHTML(row.id)}" role="button" tabindex="0">
            <div class="rutina-card__head">
                <div class="rutina-card__nombre-wrap">
                    <h3 class="rutina-card__nombre">${nombre}</h3>
                    ${objetivo}
                </div>
                <svg class="rutina-card__chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>
            </div>
            ${desc}
            ${diasControl}
            ${chip}
        </${tag}>
    `;
}

// Control de "días que la usaste esta semana" (0-7) para una tarea. El valor
// actual (del mapa _diasTareaSemana) queda resaltado. Una pulsación lo fija.
function renderTareaDiasControl(asignadoId) {
    const sel = Number(_diasTareaSemana[asignadoId] || 0);
    let pills = '';
    for (let n = 0; n <= 7; n++) {
        const on = (n === sel);
        pills += `<button type="button" class="tarea-dias__pill${on ? ' tarea-dias__pill--sel' : ''}" data-asignado-id="${escapeHTML(asignadoId)}" data-dias="${n}" aria-pressed="${on ? 'true' : 'false'}">${n}</button>`;
    }
    return `
        <div class="tarea-dias" data-asignado-id="${escapeHTML(asignadoId)}">
            <span class="tarea-dias__label">Días que la usaste esta semana</span>
            <div class="tarea-dias__pills">${pills}</div>
        </div>`;
}

// Guarda el nº de días elegido (upsert por semana). Optimista: resalta al
// instante y revierte si la query falla.
async function onTareaDiaPill(pill) {
    const asignadoId = pill.dataset.asignadoId;
    const n = Number(pill.dataset.dias);
    if (!asignadoId || !Number.isInteger(n)) return;
    const prev = Number(_diasTareaSemana[asignadoId] || 0);
    if (n === prev) return;

    const grupo = pill.closest('.tarea-dias');
    const setSel = (valor) => {
        grupo?.querySelectorAll('.tarea-dias__pill').forEach((b) => {
            const on = Number(b.dataset.dias) === valor;
            b.classList.toggle('tarea-dias__pill--sel', on);
            b.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
    };

    // Optimista.
    _diasTareaSemana[asignadoId] = n;
    setSel(n);
    grupo?.classList.add('tarea-dias--saving');

    try {
        const { error } = await supabase
            .from('registros_tarea')
            .upsert({
                ejercicio_asignado_id: asignadoId,
                semana_inicio: inicioSemanaLocalFecha(),
                dias: n,
                actualizado_en: new Date().toISOString(),
            }, { onConflict: 'ejercicio_asignado_id,semana_inicio' });
        if (error) throw error;
        grupo?.classList.remove('tarea-dias--saving');
        if (typeof toast === 'function') toast('Guardado', 'info', 1200);
    } catch (e) {
        console.error('[tarea-dias] no se pudo guardar:', e);
        _diasTareaSemana[asignadoId] = prev;
        setSel(prev);
        grupo?.classList.remove('tarea-dias--saving');
        if (typeof toast === 'function') toast('No se pudo guardar, prueba de nuevo', 'error');
    }
}

// Texto del objetivo bajo el nombre del ejercicio.
function renderObjetivoBajoNombre(asignadoId) {
    const row = _progresoCache.get(asignadoId);
    if (!row) return '';
    const t = textoObjetivoBajoNombre(row.min_semanal, row.max_diario);
    if (!t) return '';
    return `<p class="rutina-card__objetivo">${escapeHTML(t)}</p>`;
}

function renderChipProgreso(asignadoId) {
    const row = _progresoCache.get(asignadoId);
    if (!row) return '';
    const ev = evaluarProgresoEjercicio(row);
    if (!ev.tieneTarget) return '';
    const color = COLOR_CHIP_FRECUENCIA[ev.estado] || 'verde';
    return `<span class="rutina-card__progreso rutina-card__progreso--${color}">${escapeHTML(ev.chipTexto)}</span>`;
}

// Anillo de cumplimiento de la semana, calculado solo sobre ejercicios con
// min_semanal definido (los que tienen target semanal "mínimo a cumplir").
function renderAnilloSemana() {
    const anillo = document.getElementById('anillo-semana');
    if (!anillo) return;
    const fill = anillo.querySelector('.anillo-semana__fill');

    const rows = [..._progresoCache.values()].filter((r) => r.min_semanal != null);
    const total = rows.length;
    if (total === 0) {
        anillo.setAttribute('hidden', '');
        anillo.classList.remove('anillo-semana--completo');
        aplicarAmbientalAnillo();
        return;
    }

    const cumplidos = rows.filter((r) => (r.count_semana ?? 0) >= r.min_semanal).length;
    const pct = cumplidos / total;

    anillo.removeAttribute('hidden');
    setText('anillo-semana-num', String(cumplidos));
    setText('anillo-semana-den', `/${total}`);

    const PERIMETRO = 276.46;
    if (fill) {
        fill.setAttribute('stroke-dashoffset', String(PERIMETRO * (1 - pct)));
        fill.classList.toggle('anillo-semana__fill--completo', pct >= 1);
    }
    anillo.classList.toggle('anillo-semana--completo', pct >= 1);
    aplicarAmbientalAnillo();
}

// ───────────────────────────────────────────────────────────
// Vista "Mi progreso" — toggle Rutina/Progreso, anillo grande,
// lista con chips + racha por ejercicio.
// ───────────────────────────────────────────────────────────

function bindRutinaModo() {
    document.querySelectorAll('.rutina-modo__btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            const modo = btn.dataset.modo;
            if (!modo || state.rutinaModo === modo) return;
            cambiarRutinaModo(modo);
        });
    });
}

function cambiarRutinaModo(modo) {
    state.rutinaModo = modo;

    // 1) Pre-render SYNC del panel destino desde caches existentes.
    //    Si no hay cache, cargarVistaProgreso se encarga del loading.
    if (modo === 'progreso' && _progresoCache.size > 0) {
        renderAnilloProgreso();
        renderListaProgreso();
        const loading = document.getElementById('progreso-loading');
        if (loading) loading.hidden = true;
    }

    // 2) Toggle visibilidad de paneles (panel destino ya pintado).
    const rutinaPanel = document.getElementById('rutina-vista');
    const progresoPanel = document.getElementById('progreso-vista');
    if (rutinaPanel) rutinaPanel.hidden = (modo !== 'rutina');
    if (progresoPanel) progresoPanel.hidden = (modo !== 'progreso');

    // 3) Toggle de pills al final, en el mismo frame que el contenido.
    document.querySelectorAll('.rutina-modo__btn').forEach((b) => {
        const activo = b.dataset.modo === modo;
        b.classList.toggle('is-active', activo);
        b.setAttribute('aria-selected', activo ? 'true' : 'false');
    });

    if (modo === 'progreso') cargarVistaProgreso();

    aplicarAmbientalAnillo();
}

async function cargarVistaProgreso() {
    const loading = document.getElementById('progreso-loading');
    const empty   = document.getElementById('progreso-empty');
    const lista   = document.getElementById('progreso-lista');
    if (!loading || !empty || !lista) return;

    const perroId = state.perroSeleccionadoId;
    if (!perroId) {
        loading.hidden = true;
        return;
    }

    // Si no hay nada en cache, mostramos loading. Si ya hay (entraste
    // desde Rutina), no tocamos la UI: cambiarRutinaModo ya pintó el
    // estado con el cache, y al volver de la query refrescamos en sitio.
    const teniaCache = _progresoCache.size > 0;
    if (!teniaCache) {
        loading.hidden = false;
        empty.hidden = true;
        lista.hidden = true;
    }

    try {
        if (_progresoCache.size === 0) {
            await cargarProgresoPerro(perroId);
        }

        // Rachas: RPC dedicada. Si falla, seguimos sin rachas.
        try {
            const { data: rachas, error: errR } = await supabase.rpc('get_racha_perro', {
                p_perro_id: perroId,
                p_inicio_semana_actual: inicioSemanaLocalIso(),
            });
            if (errR) throw errR;
            _rachaCache.clear();
            (rachas || []).forEach((r) =>
                _rachaCache.set(r.ejercicio_asignado_id, r.racha_semanas));
        } catch (e) {
            console.error('[progreso] error racha:', e);
            _rachaCache.clear();
        }

        // Historial semanal (frontend puro). Si falla, seguimos sin barras.
        try {
            await cargarHistorialSemanal(perroId);
        } catch (e) {
            console.error('[progreso] error historial:', e);
            _historialCache.clear();
        }

        renderAnilloProgreso();
        renderListaProgreso();
        loading.hidden = true;
    } catch (e) {
        console.error('[progreso]', e);
        if (!teniaCache) {
            loading.hidden = true;
            empty.hidden = false;
        }
        // Con cache previo: dejamos el pre-render visible y silenciamos.
    }

    aplicarAmbientalAnillo();
}

function renderAnilloProgreso() {
    const anillo = document.getElementById('anillo-progreso');
    const fill   = document.getElementById('anillo-progreso-fill');
    const numEl  = document.getElementById('anillo-progreso-num');
    const denEl  = document.getElementById('anillo-progreso-den');
    if (!anillo || !fill || !numEl || !denEl) return;

    const rows = [..._progresoCache.values()].filter((r) => r.min_semanal != null);
    const total = rows.length;
    if (total === 0) {
        anillo.hidden = true;
        anillo.classList.remove('anillo-semana--completo');
        return;
    }
    const cumplidos = rows.filter((r) => (r.count_semana ?? 0) >= r.min_semanal).length;
    const pct = cumplidos / total;

    anillo.hidden = false;
    numEl.textContent = String(cumplidos);
    denEl.textContent = `/${total}`;
    const PERIMETRO = 276.46;
    fill.setAttribute('stroke-dashoffset', String(PERIMETRO * (1 - pct)));
    anillo.classList.toggle('anillo-semana--completo', pct >= 1);
}

function renderListaProgreso() {
    const lista = document.getElementById('progreso-lista');
    const empty = document.getElementById('progreso-empty');
    if (!lista || !empty) return;

    const items = [..._progresoCache.values()].filter((r) =>
        r.min_semanal != null || r.max_diario != null);

    if (items.length === 0) {
        lista.hidden = true;
        empty.hidden = false;
        return;
    }
    empty.hidden = true;

    // Orden: incumplidos primero, después por racha desc, después por nombre.
    items.sort((a, b) => {
        const ea = evaluarProgresoEjercicio(a);
        const eb = evaluarProgresoEjercicio(b);
        const cumpleA = ea.estado === 'en_zona' ? 1 : 0;
        const cumpleB = eb.estado === 'en_zona' ? 1 : 0;
        if (cumpleA !== cumpleB) return cumpleA - cumpleB;
        const rA = _rachaCache.get(a.ejercicio_asignado_id) || 0;
        const rB = _rachaCache.get(b.ejercicio_asignado_id) || 0;
        if (rA !== rB) return rB - rA;
        return (a.nombre || '').localeCompare(b.nombre || '');
    });

    lista.innerHTML = items.map(renderProgresoItem).join('');
    // Arrancar el historial mostrando la semana más reciente (a la derecha).
    lista.querySelectorAll('.progreso-historial').forEach((el) => {
        el.scrollLeft = el.scrollWidth;
    });
    lista.hidden = false;
}

// Fila de barritas: una por semana desde la asignación, color por estado
// (mismo criterio que el chip). Scrolleable si son muchas semanas.
function renderHistorialSemanal(asignadoId) {
    const semanas = _historialCache.get(asignadoId);
    if (!semanas || semanas.length === 0) return '';
    const barras = semanas.map((s) => {
        const color = COLOR_CHIP_FRECUENCIA[s.estado] || 'sin';
        const actual = s.actual ? ' progreso-semana--actual' : '';
        const veces = s.count === 1 ? 'vez' : 'veces';
        const titulo = `Semana ${s.idx + 1}: ${s.count} ${veces}${s.actual ? ' (en curso)' : ''}`;
        return `<span class="progreso-semana progreso-semana--${color}${actual}" title="${escapeHTML(titulo)}"><span class="progreso-semana__fill" style="height:${s.pct}%"></span></span>`;
    }).join('');
    return `<div class="progreso-historial" aria-label="Historial por semana">${barras}</div>`;
}

function renderProgresoItem(row) {
    const ev = evaluarProgresoEjercicio(row);
    const color = COLOR_CHIP_FRECUENCIA[ev.estado] || 'sin';
    const chipHTML = ev.tieneTarget
        ? `<span class="progreso-item__chip progreso-item__chip--${color}">${escapeHTML(ev.chipTexto)}</span>`
        : '';
    const racha = _rachaCache.get(row.ejercicio_asignado_id) || 0;
    const rachaHTML = racha >= 2
        ? `<span class="progreso-item__racha"><strong>${racha}</strong> semanas seguidas</span>`
        : '';

    // Línea compacta de marca, solo si hay objetivo. Informativa: usa la mejor
    // marca histórica (récord) vs el objetivo. No toca constancia/racha.
    let marcaHTML = '';
    if (row.objetivo_seg != null || row.objetivo_distancia != null) {
        let mejor, objetivoTxt, mejorTxt, sufijo, objetivo;
        if (row.objetivo_seg != null) {
            objetivo = Number(row.objetivo_seg);
            mejor = (row.mejor_seg_total != null) ? Number(row.mejor_seg_total) : null;
            mejorTxt = (mejor != null) ? fmtSegToMinSeg(mejor) : '—';
            objetivoTxt = fmtSegToMinSeg(objetivo);
            sufijo = '';
        } else {
            objetivo = Number(row.objetivo_distancia);
            mejor = (row.mejor_pasos_total != null) ? Number(row.mejor_pasos_total) : null;
            mejorTxt = (mejor != null) ? String(mejor) : '—';
            objetivoTxt = String(objetivo);
            sufijo = ' pasos';
        }
        const alcanzado = (mejor != null && objetivo > 0 && mejor >= objetivo);
        const cuerpo = `${mejorTxt} / ${objetivoTxt}${sufijo}`;
        const texto = alcanzado ? `✓ ${cuerpo}` : `Marca: ${cuerpo}`;
        marcaHTML = `<span class="progreso-item__chip progreso-item__chip--sin">${escapeHTML(texto)}</span>`;
    }

    const historialHTML = renderHistorialSemanal(row.ejercicio_asignado_id);
    return `
        <li class="progreso-item">
            <div class="progreso-item__nombre">${escapeHTML(row.nombre || 'Ejercicio')}</div>
            <div class="progreso-item__meta">
                ${chipHTML}
                ${marcaHTML}
                ${rachaHTML}
            </div>
            ${historialHTML}
        </li>
    `;
}

// Ambiental editorial: degradé radial sutil sobre #tab-rutina cuando
// el anillo cerró al 100%. Es estado del logro de la semana — aplica en
// ambas sub-vistas (Rutina / Mi progreso) para no parpadear al cambiar.
function aplicarAmbientalAnillo() {
    const tab = document.getElementById('tab-rutina');
    const anillo = document.getElementById('anillo-semana');
    if (!tab || !anillo) return;
    const cerrado = anillo.classList.contains('anillo-semana--completo');
    tab.classList.toggle('ambiental-cerrado', cerrado);
}

// Mini-progreso dentro del modal de detalle del ejercicio.
//   · Línea "Esta semana": visible si hay min_semanal. Compara count_semana
//     contra el mínimo (no hay tope semanal).
//   · Línea "Hoy":         visible si hay max_diario. Compara count_dia
//     contra el tope diario (no hay mínimo diario).
function renderProgresoEnModal(asignadoId) {
    const cont = document.getElementById('ejercicio-progreso');
    if (!cont) return;
    const lineaSem = document.getElementById('ejercicio-progreso-semana');
    const lineaDia = document.getElementById('ejercicio-progreso-dia');
    const row = _progresoCache.get(asignadoId);
    const ev = evaluarProgresoEjercicio(row);
    // La barra de marca es independiente de la constancia: puede haber
    // objetivo sin min/max. Mostramos el bloque si hay constancia O objetivo.
    const tieneObjetivo = !!(row && (row.objetivo_seg != null || row.objetivo_distancia != null));

    if (!row || (!ev.tieneTarget && !tieneObjetivo)) {
        cont.setAttribute('hidden', '');
        return;
    }
    cont.removeAttribute('hidden');

    // --- línea semanal (sólo mínimo) ---
    if (row.min_semanal != null && row.min_semanal > 0) {
        lineaSem.removeAttribute('hidden');
        const c = Number(row.count_semana ?? 0);
        // Estado de la barra semanal: si todavía no llegó al mínimo, rojo;
        // si llegó o superó, verde. La barra no se pone azul (el tope es
        // diario, no semanal).
        const estadoSem = (c < row.min_semanal) ? 'debajo' : 'en_zona';
        pintarLineaProgreso({
            count: c,
            min: row.min_semanal,
            max: null,
            estado: estadoSem,
            modo: 'semana',
            valorId: 'ej-prog-semana-valor',
            fillId: 'ej-prog-semana-fill',
            marksId: 'ej-prog-semana-marks',
        });
    } else {
        lineaSem.setAttribute('hidden', '');
    }

    // --- línea diaria (sólo tope) ---
    if (row.max_diario != null && row.max_diario > 0) {
        lineaDia.removeAttribute('hidden');
        const c = Number(row.count_dia ?? 0);
        // Estado: verde si está dentro del tope, azul si lo superó.
        const estadoDia = (c > row.max_diario) ? 'encima' : 'en_zona';
        pintarLineaProgreso({
            count: c,
            min: null,
            max: row.max_diario,
            estado: estadoDia,
            modo: 'dia',
            valorId: 'ej-prog-dia-valor',
            fillId: 'ej-prog-dia-fill',
            marksId: 'ej-prog-dia-marks',
        });
    } else {
        lineaDia.setAttribute('hidden', '');
    }

    // --- línea de marca objetivo (informativa, solo si hay objetivo) ---
    const lineaMarca = document.getElementById('ejercicio-progreso-marca');
    if (lineaMarca) {
        if (row.objetivo_seg != null) {
            lineaMarca.removeAttribute('hidden');
            pintarLineaMarca(row, 'tiempo');
        } else if (row.objetivo_distancia != null) {
            lineaMarca.removeAttribute('hidden');
            pintarLineaMarca(row, 'distancia');
        } else {
            lineaMarca.setAttribute('hidden', '');
        }
    }
}

// Barra informativa de cercanía a la marca objetivo. Usa la MEJOR marca
// histórica (récord) contra el objetivo del adiestrador. No toca la
// constancia. Reutiliza las clases de barra/relleno existentes.
function pintarLineaMarca(row, tipo) {
    const valor = document.getElementById('ej-prog-marca-valor');
    const fill = document.getElementById('ej-prog-marca-fill');

    let objetivo, mejor, mejorTxt, objetivoTxt, sufijo;
    if (tipo === 'tiempo') {
        objetivo = Number(row.objetivo_seg);
        mejor = (row.mejor_seg_total != null) ? Number(row.mejor_seg_total) : null;
        mejorTxt = (mejor != null) ? fmtSegToMinSeg(mejor) : '—';
        objetivoTxt = fmtSegToMinSeg(objetivo);
        sufijo = '';
    } else {
        objetivo = Number(row.objetivo_distancia);
        mejor = (row.mejor_pasos_total != null) ? Number(row.mejor_pasos_total) : null;
        mejorTxt = (mejor != null) ? String(mejor) : '—';
        objetivoTxt = String(objetivo);
        sufijo = ' pasos';
    }

    const alcanzado = (mejor != null && objetivo > 0 && mejor >= objetivo);
    if (valor) {
        valor.textContent = alcanzado
            ? `${mejorTxt} / ${objetivoTxt}${sufijo} · ✓ ¡Objetivo alcanzado!`
            : `${mejorTxt} / ${objetivoTxt}${sufijo}`;
    }

    if (fill) {
        // Relleno = min(mejor/objetivo, 1) * 100. Sin marca todavía → 0%.
        const pct = (mejor != null && objetivo > 0)
            ? Math.min(100, Math.max(0, (mejor / objetivo) * 100))
            : 0;
        fill.style.width = `${pct}%`;
    }
}

function pintarLineaProgreso({ count, min, max, estado, modo, valorId, fillId, marksId }) {
    const valor = document.getElementById(valorId);
    const fill = document.getElementById(fillId);
    const marks = document.getElementById(marksId);

    // Texto: la línea semanal muestra "X / Y" contra el mínimo; la diaria
    // muestra "X / Y (tope)" contra el tope.
    let textoValor = '';
    if (modo === 'semana' && min != null)      textoValor = `${count} / ${min}`;
    else if (modo === 'dia' && max != null)    textoValor = `${count} / ${max} (tope)`;
    else                                       textoValor = `${count}`;
    if (valor) valor.textContent = textoValor;

    // Rango de la barra: usamos como referencia el target visible.
    const referencia = (min != null) ? min : (max != null ? max : 1);
    const rango = Math.max(referencia * 1.5, count * 1.2, 1);

    if (fill) {
        const pct = Math.min(100, Math.max(0, (count / rango) * 100));
        fill.style.width = `${pct}%`;
        fill.classList.remove(
            'ejercicio-progreso__bar-fill--rojo',
            'ejercicio-progreso__bar-fill--verde',
            'ejercicio-progreso__bar-fill--azul',
        );
        const color = COLOR_CHIP_FRECUENCIA[estado];
        if (color && color !== 'sin') fill.classList.add(`ejercicio-progreso__bar-fill--${color}`);
    }

    if (marks) {
        const positions = [];
        if (min != null) positions.push(min);
        if (max != null) positions.push(max);
        marks.innerHTML = positions
            .map((p) => {
                const left = Math.min(100, (p / rango) * 100);
                return `<span class="mark" style="left:${left}%"></span>`;
            })
            .join('');
    }
}

// Marca una card con la animación de pulso oliva tras alcanzar el mínimo.
// Espera dos rAF para que el re-render de la rutina ya haya pintado el DOM.
function marcarPulsoLogro(asignadoId) {
    requestAnimationFrame(() => requestAnimationFrame(() => {
        const card = document.querySelector(`.rutina-card[data-asignado-id="${CSS.escape(asignadoId)}"]`);
        if (!card) return;
        card.classList.add('is-pulse');
        setTimeout(() => card.classList.remove('is-pulse'), 3500);
    }));
}

// ===================== Pack y protocolo (hero) =====================

// Devuelve el estado del pack del cliente:
//   { pack_actual, realizadas_del_pack, confirmadas_futuras_del_pack,
//     por_reservar, proximo_numero }
// Si el cliente no tiene pack_actual cargado, devuelve {pack_actual: null}.
function calcularEstadoPack(cliente, citasCliente) {
    const pack = cliente?.pack_actual;
    if (pack == null) return { pack_actual: null };

    // Seña para próxima clase: con el flag habilitado, el cliente tiene 1 cupo
    // extra. Solo afecta el window y por_reservar; pack_actual sigue siendo el
    // pack REAL. Flag false → extra=0 → packEf===pack → sin cambios.
    const extra = cliente?.clase_extra_habilitada ? 1 : 0;
    const packEf = pack + extra;

    const hoyIso = new Date().toISOString().slice(0, 10);

    // Citas con numero_clase NOT NULL, orden desc por numero_clase
    const numeradas = (citasCliente || [])
        .filter((c) => c.numero_clase != null)
        .slice()
        .sort((a, b) => b.numero_clase - a.numero_clase);

    // Las N más recientes son "el pack actual"
    const enPack = numeradas.slice(0, packEf);
    const nums = enPack.map((c) => c.numero_clase);
    const rangoMin = nums.length ? Math.min(...nums) : null;
    const rangoMax = nums.length ? Math.max(...nums) : null;

    let realizadas = 0;
    let confirmadasFuturas = 0;
    enPack.forEach((c) => {
        if (c.estado === 'realizada') realizadas++;
        else if (c.estado === 'confirmada' && c.fecha >= hoyIso) confirmadasFuturas++;
    });

    const porReservar = Math.max(0, packEf - realizadas - confirmadasFuturas);

    // proximo_numero: si hay una clase CANCELADA cuyo número no fue repuesto,
    // la próxima reserva REPONE el hueco más bajo (no salta adelante). Si no
    // hay huecos, sigue en max(activos)+1. "Activo" = realizada o confirmada futura.
    const activos = new Set();
    let maxActivo = 0;
    (citasCliente || []).forEach((c) => {
        if (c.numero_clase == null) return;
        const activo = c.estado === 'realizada' || (c.estado === 'confirmada' && c.fecha >= hoyIso);
        if (!activo) return;
        activos.add(c.numero_clase);
        if (c.numero_clase > maxActivo) maxActivo = c.numero_clase;
    });
    const huecos = [];
    (citasCliente || []).forEach((c) => {
        if (c.numero_clase == null) return;
        if (c.estado === 'cancelada' && !activos.has(c.numero_clase)) huecos.push(c.numero_clase);
    });
    const proximoNumero = huecos.length ? Math.min(...huecos) : (maxActivo + 1);

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
function formatearProtocolo(perro) {
    if (!perro || !perro.protocolo_principal) return null;
    const nombre = PROTOCOLOS_LABEL[perro.protocolo_principal];
    if (!nombre) return null;

    const comp = (perro.protocolos_complementarios || [])
        .map((slug) => PROTOCOLOS_LABEL[slug])
        .filter(Boolean);

    let duracion;
    if (perro.protocolo_principal === 'educacion_basica' ||
        perro.protocolo_principal === 'educacion_cachorro') {
        duracion = 'Suele llevar 4 clases.';
    } else {
        duracion = perro.caso_complejo
            ? 'Suele llevar entre 4 y 12 clases, hasta 14 en casos como el suyo.'
            : 'Suele llevar entre 4 y 12 clases.';
    }

    return { nombre, comp, duracion };
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
    const sub = document.getElementById('reservar-subtitulo');

    // Modo modificación: si venimos de "Cambiar fecha" en Mis citas,
    // mostramos un banner y la lógica de confirmar va a UPDATE en lugar
    // de INSERT. El cliente puede cancelar y volver a Mis citas.
    const banner = document.getElementById('reservar-banner-modificar');
    const mod = state.modificando;
    if (mod && banner) {
        const fechaVieja = formatearFechaLarga(mod.fecha_vieja);
        const horaVieja = (mod.hora_vieja || '').substring(0, 5);
        document.getElementById('reservar-banner-modificar-texto').textContent =
            `Estás cambiando tu clase ${mod.numero_clase} del ${fechaVieja} · ${horaVieja}. Elige una nueva fecha y hora.`;
        banner.removeAttribute('hidden');
    } else if (banner) {
        banner.setAttribute('hidden', '');
    }

    const mensajeBox = document.getElementById('reservar-mensaje');
    const avisoBox = document.getElementById('reservar-aviso');
    const calMes = document.getElementById('reservar-calendario-mes');
    const diaPanel = document.getElementById('reservar-dia-panel');
    const diaVacio = document.getElementById('reservar-dia-vacio');

    const perro = state.perros.find((p) => p.id === state.perroSeleccionadoId);
    const nombrePerro = perro?.nombre || 'tu perro';
    sub.textContent = `Elige cuándo quieres tu próxima clase con ${nombrePerro}`;

    // Reset visual
    avisoBox.setAttribute('hidden', '');
    calMes.setAttribute('hidden', '');
    diaPanel.setAttribute('hidden', '');
    diaVacio.setAttribute('hidden', '');
    mensajeBox.removeAttribute('hidden');
    mensajeBox.innerHTML = '<p>Cargando…</p>';

    try {
    const estado = await llamarPuedeReservar();

    // Casos de bloqueo: mostrar mensaje y salir
    if (estado.razon === 'sin_primera_clase') {
        mensajeBox.innerHTML = `
            <div class="reservar-msg">
                <h3>Aún no tienes tu primera clase reservada</h3>
                <p>La primera clase la coordina el adiestrador contigo. Si tienes dudas, escríbenos al ${TELEFONO_PUBLICO}.</p>
            </div>`;
        return;
    }
    if (estado.razon === 'limite_alcanzado') {
        const reservas = estado.reservas_actuales ?? '';
        mensajeBox.innerHTML = `
            <div class="reservar-msg">
                <h3>Ya has reservado ${reservas} clase${reservas === 1 ? '' : 's'} por adelantado</h3>
                <p>Si quieres reservar más, háblalo con el adiestrador en la próxima clase.</p>
            </div>`;
        return;
    }

    const pack = calcularEstadoPack(state.cliente, state.citas);

    if (pack.pack_actual == null) {
        mensajeBox.innerHTML = `
            <div class="reservar-aviso reservar-aviso--cuidado">
                <h3>Tu adiestrador está coordinando tu pack</h3>
                <p>Te avisaremos cuando puedas reservar.</p>
            </div>`;
        return;
    }
    if (pack.por_reservar === 0) {
        // Terminó el pack y no hay seña recibida (flag false) ni clases futuras
        // pendientes del pack → cartelito para pedir la seña de la próxima clase.
        if (!state.cliente?.clase_extra_habilitada && pack.confirmadas_futuras_del_pack === 0) {
            mensajeBox.innerHTML = `
                <div class="reservar-aviso reservar-aviso--cuidado">
                    <h3>Necesitamos la seña de tu próxima clase</h3>
                    <p>Para reservar tu próxima clase necesitamos la seña. Escríbenos desde Mensajes (o por WhatsApp) y te pasamos los datos del Bizum; en cuanto la confirmemos, podrás elegir la fecha de tu próxima clase. 🐾</p>
                </div>`;
            return;
        }
        mensajeBox.innerHTML = `
            <div class="reservar-aviso reservar-aviso--cuidado">
                <h3>Tu pack actual está completo</h3>
                <p>Cuando quieras continuar, háblalo con el adiestrador en la próxima clase.</p>
            </div>`;
        return;
    }

    // Hay slots para mostrar — pintamos el calendario mes
    mensajeBox.setAttribute('hidden', '');

    // Aviso editorial arriba del calendario
    const x = pack.por_reservar;
    const sPlural = x === 1 ? '' : 's';
    const verbo = x === 1 ? 'Te queda' : 'Te quedan';
    document.getElementById('reservar-aviso-titulo').textContent =
        `${verbo} ${x} clase${sPlural} por reservar del pack`;
    document.getElementById('reservar-aviso-sub').textContent =
        `Cuando la reserves, será la clase ${pack.proximo_numero} de ${nombrePerro}.`;
    avisoBox.removeAttribute('hidden');

    // Cargar slots de la ventana 8 semanas
    const hoyIso = new Date().toISOString().slice(0, 10);
    const hastaIso = sumarDiasIso(hoyIso, 8 * 7);
    const minIso = estado.puede_reservar_desde && estado.puede_reservar_desde > hoyIso
        ? estado.puede_reservar_desde
        : hoyIso;

    const slotsRaw = await cargarSlotsDisponibles(minIso, hastaIso);

    // Filtro 5 días entre clases del cliente (en cliente — RPC global se mantiene).
    // Si estamos modificando, la cita en proceso NO cuenta para la regla
    // de 5 días (es la que estamos moviendo).
    const fechasMiasIso = state.citas
        .filter((c) => c.estado === 'confirmada' || c.estado === 'realizada')
        .filter((c) => !state.modificando || c.id !== state.modificando.id)
        .map((c) => c.fecha);
    const slotsFiltrados = slotsRaw.filter((s) => {
        for (const fMia of fechasMiasIso) {
            const diff = Math.abs(diasEntreIso(s.fecha, fMia));
            if (diff < 5) return false;
        }
        return true;
    });

    // Agrupar por fecha
    state.calMes.slotsPorFecha = {};
    slotsFiltrados.forEach((s) => {
        const hora = typeof s.hora === 'string' ? s.hora.substring(0, 5) : s.hora;
        if (!state.calMes.slotsPorFecha[s.fecha]) state.calMes.slotsPorFecha[s.fecha] = [];
        state.calMes.slotsPorFecha[s.fecha].push(hora);
    });

    state.calMes.numeroProxima = pack.proximo_numero;

    // Anchor inicial: mes del primer día con disponibilidad
    const fechasDisp = Object.keys(state.calMes.slotsPorFecha).sort();
    if (fechasDisp.length === 0) {
        state.calMes.anchorIso = primerDiaDelMes(hoyIso);
        state.calMes.diaSeleccionadoIso = null;
        calMes.removeAttribute('hidden');
        renderCalMes();
        diaVacio.removeAttribute('hidden');
        return;
    }

    const primerDisponible = fechasDisp[0];
    state.calMes.anchorIso = primerDiaDelMes(primerDisponible);
    state.calMes.diaSeleccionadoIso = primerDisponible;

    calMes.removeAttribute('hidden');
    renderCalMes();
    renderDiaPanel();

    // Wire up flechas (idempotente — sobreescribimos handlers)
    document.getElementById('cal-mes-prev').onclick = () => navegarMes(-1);
    document.getElementById('cal-mes-next').onclick = () => navegarMes(1);

    // Wire del botón "Cancelar cambio" del banner de modificación
    const btnCancelarMod = document.getElementById('reservar-banner-modificar-cancelar');
    if (btnCancelarMod) {
        btnCancelarMod.onclick = () => {
            state.modificando = null;
            showTab('mis-citas');
        };
    }
    } catch (err) {
        console.error('[app] renderTabReservar falló:', err);
        avisoBox.setAttribute('hidden', '');
        diaPanel.setAttribute('hidden', '');
        diaVacio.setAttribute('hidden', '');
        mensajeBox.removeAttribute('hidden');
        mensajeBox.innerHTML = `
            <div class="reservar-msg">
                <h3>No hemos podido cargar tu agenda</h3>
                <p>Vuelve a intentarlo en unos segundos. Si el problema persiste, escríbenos por WhatsApp y lo resolvemos.</p>
            </div>`;
    }
}

function abrirModalReservar({ fecha, hora, label }) {
    // Reset a modo confirmar (por si quedó en sugerencia de una iteración previa).
    const modal = document.getElementById('modal-reservar');
    modal.querySelector('[data-modo="confirmar"]').removeAttribute('hidden');
    modal.querySelector('[data-modo="sugerencia"]').setAttribute('hidden', '');

    state.reservandoSlot = { fecha, hora, label };

    // Ajustar copy del modal según si es reserva normal o modificación.
    const titulo = document.getElementById('modal-reservar-titulo');
    const btn = document.getElementById('modal-reservar-confirmar');
    if (state.modificando) {
        titulo.textContent = 'Confirmar cambio';
        btn.textContent = 'Sí, cambiar';
    } else {
        titulo.textContent = 'Confirmar reserva';
        btn.textContent = 'Sí, reservar';
    }

    const perro = state.perros.find((p) => p.id === state.perroSeleccionadoId);
    setText('modal-reservar-slot', label || `${formatearFechaLarga(fecha)} · ${hora}`);
    setText('modal-reservar-perro', perro?.nombre || 'tu perro');
    const err = document.getElementById('modal-reservar-error');
    err.textContent = '';
    err.hidden = true;
    btn.disabled = false;
    abrirModal('modal-reservar');
}

async function confirmarReserva() {
    const slot = state.reservandoSlot;
    if (!slot) return;
    const esModif = !!state.modificando;
    const btn = document.getElementById('modal-reservar-confirmar');
    const err = document.getElementById('modal-reservar-error');
    btn.disabled = true;
    btn.textContent = esModif ? 'Cambiando…' : 'Reservando…';
    err.hidden = true;

    const clienteId = state.usuarioCliente?.cliente_id;
    const horaCompleta = slot.hora.length === 5 ? `${slot.hora}:00` : slot.hora;

    try {
        let citaData;

        if (state.modificando) {
            // Modo MODIFICAR: UPDATE de la cita existente + ajuste de bloqueos.
            // numero_clase no se toca: la cita conserva su número.
            const mod = state.modificando;

            // 1) UPDATE cita con nueva fecha/hora
            const { data: upData, error: upErr } = await supabase
                .from('citas')
                .update({
                    fecha: slot.fecha,
                    hora:  horaCompleta,
                })
                .eq('id', mod.id)
                .select()
                .single();
            if (upErr) {
                if (esErrorSlotTomado(upErr)) {
                    toast('Acabamos de ver que ese horario ya no está disponible. Elige otro.', 'error');
                    await renderTabReservar();
                    return;
                }
                throw upErr;
            }
            citaData = upData;

            // 2) DELETE bloqueo viejo "Auto: cita {id}"
            const { error: delErr } = await supabase
                .from('bloqueos')
                .delete()
                .eq('motivo', `Auto: cita ${mod.id}`);
            if (delErr) {
                console.warn('[app] No se pudo borrar el bloqueo viejo en modificar:', delErr);
            }
        } else {
            // Modo RESERVA NORMAL: INSERT cita nueva.
            // La RLS exige numero_clase NOT NULL en INSERT de cliente.

            // Gate previo: re-verificar que el cliente puede reservar.
            // Cubre el caso raro de que el state cambie entre abrir el modal y
            // confirmar (ej: pasaron 5 min y se llegó al límite).
            const gate = await llamarPuedeReservar();
            if (gate.razon === 'limite_alcanzado' || gate.razon === 'sin_primera_clase') {
                const mensajeGate = gate.razon === 'limite_alcanzado'
                    ? `Ya tienes el máximo de reservas activas. Cuando se realice alguna, podrás reservar la siguiente.`
                    : `Tu primera clase la coordinamos directamente. Escríbenos por WhatsApp.`;
                toast(mensajeGate, 'error');
                cerrarModal('modal-reservar');
                await renderTabReservar();
                btn.disabled = false;
                return;
            }
            // muy_pronto NO bloquea — el filtro de slots (slotsFiltrados en
            // renderTabReservar) y minIso=puede_reservar_desde ya garantizan
            // que el slot elegido esté en fecha válida.

            const packPrevio = calcularEstadoPack(state.cliente, state.citas);
            const proximoNumero = packPrevio.proximo_numero || 1;

            const { data: insData, error: citaErr } = await supabase
                .from('citas')
                .insert({
                    cliente_id:    clienteId,
                    fecha:         slot.fecha,
                    hora:          horaCompleta,
                    estado:        'confirmada',
                    confirmada:    true,
                    modalidad:     'presencial',
                    tipo_reserva:  'siguiente',
                    numero_clase:  proximoNumero,
                })
                .select()
                .single();
            if (citaErr) {
                if (esErrorSlotTomado(citaErr)) {
                    toast('Acabamos de ver que ese horario ya no está disponible. Elige otro.', 'error');
                    await renderTabReservar();
                    return;
                }
                throw citaErr;
            }
            citaData = insData;
        }

        // Crear bloqueo "Auto: cita {id}" para el nuevo slot — patrón del admin.
        // Aplica tanto a INSERT como a UPDATE (en UPDATE el bloqueo viejo ya se borró arriba).
        const { error: bloqErr } = await supabase
            .from('bloqueos')
            .insert({
                fecha:  slot.fecha,
                hora:   horaCompleta,
                motivo: `Auto: cita ${citaData.id}`,
            });
        if (bloqErr) {
            // No revertimos — la cita quedó válida. Solo loggeamos.
            console.warn('[app] Cita creada/modificada pero falló crear bloqueo:', bloqErr);
        }

        const eraModificacion = !!state.modificando;
        toast(eraModificacion ? 'Cita modificada' : 'Reserva confirmada');
        const slotReservado = state.reservandoSlot;
        state.reservandoSlot = null;

        // Recargar citas (necesario para que la sugerencia y el filtro 5d
        // estén actualizados con la cita recién creada/modificada).
        state.citas = await cargarCitasCliente();

        // En modificación NO mostramos sugerencia: cerrar y volver a Mis citas.
        if (eraModificacion) {
            state.modificando = null;
            cerrarModal('modal-reservar');
            await renderTabReservar();
            showTab('mis-citas');
            return;
        }

        // Verificar si el cliente puede reservar más
        const estado2 = await llamarPuedeReservar();
        const pack2 = calcularEstadoPack(state.cliente, state.citas);
        const puedeMas = estado2.razon === 'ok' && pack2.por_reservar > 0;

        if (!puedeMas) {
            cerrarModal('modal-reservar');
            // Refrescar tab Reservar para que próxima visita parta limpia.
            await renderTabReservar();
            showTab('mis-citas');
            return;
        }

        // Calcular sugerencia: mismo día de semana, +7 días, misma hora.
        // Si no está libre, la helper busca el slot disponible más cercano.
        const sugerencia = calcularSugerencia(slotReservado);
        mostrarModoSugerencia(slotReservado, sugerencia, pack2.proximo_numero);
    } catch (e) {
        console.error('[app] error reservando/modificando cita:', e);
        err.textContent = esModif
            ? 'No se pudo modificar. Inténtalo de nuevo.'
            : 'No se pudo reservar. Inténtalo de nuevo.';
        err.hidden = false;
    } finally {
        btn.disabled = false;
        btn.textContent = esModif ? 'Sí, cambiar' : 'Sí, reservar';
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

    // Wire up botones modificar
    cont.querySelectorAll('[data-modificar-cita]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const id = btn.dataset.modificarCita;
            const cita = state.citas.find((c) => c.id === id);
            if (cita) iniciarModificarCita(cita);
        });
    });
}

function renderCitaDestacada(cita, ahora) {
    const dt = _datetimeCita(cita);
    const fecha = formatearFechaLarga(cita.fecha).toUpperCase();
    const hora = (cita.hora || '').substring(0, 5);
    const cuanto = cuantoFalta(dt, ahora);
    const horasFaltan = (dt - ahora) / 36e5;
    const cancelable = horasFaltan > 48;
    return `
        <article class="cita-destacada">
            ${cita.numero_clase != null ? `<span class="cita-numero">Clase ${cita.numero_clase}</span>` : ''}
            <p class="cita-destacada__fecha">${escapeHTML(fecha)}</p>
            <p class="cita-destacada__hora">${escapeHTML(hora)}</p>
            <p class="cita-destacada__cuanto">${escapeHTML(cuanto)}</p>
            <span class="badge badge--ok">Confirmada</span>
            ${cancelable
                ? `<div class="cita-destacada__acciones">
                       <button type="button" class="cita-modificar-btn" data-modificar-cita="${escapeHTML(cita.id)}">Cambiar fecha</button>
                       <button type="button" class="cita-cancelar-btn" data-cancelar-cita="${escapeHTML(cita.id)}">Cancelar</button>
                   </div>`
                : `<p class="cita-destacada__nota">Para cambios, escribe al ${TELEFONO_PUBLICO}</p>`}
        </article>
    `;
}

function renderCitaItem(cita, ahora) {
    const dt = _datetimeCita(cita);
    const fecha = formatearFechaLarga(cita.fecha).toUpperCase();
    const hora = (cita.hora || '').substring(0, 5);
    const cuanto = cuantoFalta(dt, ahora);
    const horasFaltan = (dt - ahora) / 36e5;
    const cancelable = horasFaltan > 48;
    return `
        <article class="cita-item">
            <div class="cita-item__main">
                <p class="cita-item__fecha">${cita.numero_clase != null ? `<span class="cita-numero cita-numero--inline">Clase ${cita.numero_clase}</span> · ` : ''}${escapeHTML(fecha)} · ${escapeHTML(hora)}</p>
                <p class="cita-item__cuanto">${escapeHTML(cuanto)}</p>
            </div>
            ${cancelable
                ? `<div class="cita-item__acciones">
                       <button type="button" class="cita-modificar-btn cita-modificar-btn--small" data-modificar-cita="${escapeHTML(cita.id)}">Cambiar</button>
                       <button type="button" class="cita-cancelar-btn cita-cancelar-btn--small" data-cancelar-cita="${escapeHTML(cita.id)}">Cancelar</button>
                   </div>`
                : ''}
        </article>
    `;
}

function renderCitaHistorial(cita) {
    const fecha = formatearFechaLarga(cita.fecha).toUpperCase();
    const hora = (cita.hora || '').substring(0, 5);
    const icono = cita.estado === 'realizada' ? '✅' : cita.estado === 'cancelada' ? '❌' : '·';
    const resumen = (cita.resumen_cliente || '').trim();
    const bloqueResumen = resumen
        ? `<div class="cita-resumen">
               <p class="cita-resumen__titulo">Resumen de la clase</p>
               <p class="cita-resumen__texto">${escapeHTML(resumen)}</p>
               ${cita.resumen_creado_en
                   ? `<p class="cita-resumen__fecha">Publicado el ${escapeHTML(formatearFechaPublicacion(cita.resumen_creado_en))}</p>`
                   : ''}
           </div>`
        : '';
    return `
        <article class="cita-item cita-item--hist${resumen ? ' cita-item--con-resumen' : ''}">
            <span class="cita-item__icono">${icono}</span>
            <p class="cita-item__fecha">${cita.numero_clase != null ? `<span class="cita-numero cita-numero--hist">Clase ${cita.numero_clase}</span> ` : ''}${escapeHTML(fecha)} · ${escapeHTML(hora)}</p>
            ${bloqueResumen}
        </article>
    `;
}

// 'YYYY-MM-DDTHH:MM:SS+00:00' → '12 de junio de 2026'. Sólo la parte de
// fecha, en español de España, para el sello "Publicado el …".
function formatearFechaPublicacion(iso) {
    if (!iso || typeof iso !== 'string') return '';
    const [y, m, d] = iso.split('T')[0].split('-').map(Number);
    if (!y || !m || !d) return '';
    return `${d} de ${SEG_MESES[m - 1].toLowerCase()} de ${y}`;
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

function extraerYouTubeId(url) {
    if (!url) return null;
    const m = String(url).trim().match(
        /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/
    );
    return m ? m[1] : null;
}

// ────────────────────────────────────────────────────────────
// Tarea-lista: el cliente escribe entre 3 y 6 ítems libres para
// tareas de categoría 'tarea'. Guarda en ejercicios_asignados.parametros
// como { items: [...] }. Autoguardado con debounce 800ms; flush al
// cerrar el modal para no perder lo escrito.
// ────────────────────────────────────────────────────────────

const TAREA_LISTA_MIN = 3;
const TAREA_LISTA_MAX = 6;
const TAREA_LISTA_DEBOUNCE_MS = 800;
const TAREA_LISTA_MAX_CHARS = 200;

const _tareaListaCtx = {
    asignadoId: null,
    items: [],
    saveTimer: null,
    saving: false,
};

function abrirTareaLista(asignadoId, parametros) {
    _tareaListaCtx.asignadoId = asignadoId;
    // Tomamos items del jsonb si vienen como array de strings.
    const raw = (parametros && Array.isArray(parametros.items)) ? parametros.items : [];
    _tareaListaCtx.items = raw.filter((x) => typeof x === 'string').slice(0, TAREA_LISTA_MAX);
    if (_tareaListaCtx.items.length === 0) {
        // Pre-llenar con 3 ítems vacíos para guiar al usuario.
        _tareaListaCtx.items = ['', '', ''];
    }
    document.getElementById('tarea-lista').hidden = false;
    renderTareaLista();
}

function cerrarTareaLista() {
    flushGuardarTareaLista();
    document.getElementById('tarea-lista').hidden = true;
    _tareaListaCtx.asignadoId = null;
    _tareaListaCtx.items = [];
}

function renderTareaLista() {
    const cont = document.getElementById('tarea-lista-items');
    const btnAdd = document.getElementById('tarea-lista-add');
    const estado = document.getElementById('tarea-lista-estado');
    if (!cont || !btnAdd || !estado) return;

    const items = _tareaListaCtx.items;
    const n = items.length;

    cont.innerHTML = items.map((texto, i) => {
        const esPrimero = i === 0;
        const esUltimo  = i === n - 1;
        return `
            <li class="tarea-item" data-index="${i}">
                <span class="tarea-item__num">${i + 1}</span>
                <input
                    class="tarea-item__input"
                    type="text"
                    maxlength="${TAREA_LISTA_MAX_CHARS}"
                    placeholder="Escribe aquí cada ítem"
                    value="${escapeAttr(texto)}"
                    data-action="edit">
                <button type="button" class="tarea-item__btn" data-action="up" aria-label="Subir ítem" ${esPrimero ? 'disabled' : ''}>↑</button>
                <button type="button" class="tarea-item__btn" data-action="down" aria-label="Bajar ítem" ${esUltimo ? 'disabled' : ''}>↓</button>
                <button type="button" class="tarea-item__btn tarea-item__btn--del" data-action="del" aria-label="Borrar ítem">✕</button>
            </li>
        `;
    }).join('');

    btnAdd.disabled = (n >= TAREA_LISTA_MAX);
    btnAdd.textContent = (n >= TAREA_LISTA_MAX) ? `Máximo ${TAREA_LISTA_MAX} ítems` : '+ Agregar ítem';

    const completados = items.filter((s) => s && s.trim().length > 0).length;
    estado.classList.remove('tarea-lista__estado--pendiente', 'tarea-lista__estado--lista', 'tarea-lista__estado--saving');
    if (_tareaListaCtx.saving) {
        estado.textContent = 'Guardando…';
        estado.classList.add('tarea-lista__estado--saving');
    } else if (completados >= TAREA_LISTA_MIN) {
        estado.textContent = `Lista lista (${completados} ítems guardados).`;
        estado.classList.add('tarea-lista__estado--lista');
    } else {
        const faltan = TAREA_LISTA_MIN - completados;
        estado.textContent = `Te faltan ${faltan} ${faltan === 1 ? 'ítem' : 'ítems'} para que la lista quede lista.`;
        estado.classList.add('tarea-lista__estado--pendiente');
    }
}

function escapeAttr(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function bindTareaLista() {
    const sec = document.getElementById('tarea-lista');
    const btnAdd = document.getElementById('tarea-lista-add');
    if (!sec || !btnAdd) return;

    btnAdd.addEventListener('click', () => {
        if (_tareaListaCtx.items.length >= TAREA_LISTA_MAX) return;
        _tareaListaCtx.items.push('');
        renderTareaLista();
        // foco al input recién creado
        const last = sec.querySelector('.tarea-item:last-child .tarea-item__input');
        if (last) last.focus();
        // No guardamos todavía: un ítem vacío no se persiste.
    });

    // Event delegation: editar, subir, bajar, borrar.
    sec.addEventListener('input', (ev) => {
        const inp = ev.target.closest('input[data-action="edit"]');
        if (!inp) return;
        const i = Number(inp.closest('.tarea-item')?.dataset.index);
        if (!Number.isInteger(i)) return;
        _tareaListaCtx.items[i] = inp.value.slice(0, TAREA_LISTA_MAX_CHARS);
        // No re-renderizar acá (perdemos foco del usuario). Solo programar save.
        programarGuardarTareaLista();
    });

    sec.addEventListener('click', (ev) => {
        const btn = ev.target.closest('button[data-action]');
        if (!btn) return;
        const li = btn.closest('.tarea-item');
        if (!li) return;
        const i = Number(li.dataset.index);
        if (!Number.isInteger(i)) return;
        const act = btn.dataset.action;

        if (act === 'up' && i > 0) {
            [_tareaListaCtx.items[i - 1], _tareaListaCtx.items[i]] =
                [_tareaListaCtx.items[i], _tareaListaCtx.items[i - 1]];
            renderTareaLista();
            programarGuardarTareaLista();
        } else if (act === 'down' && i < _tareaListaCtx.items.length - 1) {
            [_tareaListaCtx.items[i + 1], _tareaListaCtx.items[i]] =
                [_tareaListaCtx.items[i], _tareaListaCtx.items[i + 1]];
            renderTareaLista();
            programarGuardarTareaLista();
        } else if (act === 'del') {
            _tareaListaCtx.items.splice(i, 1);
            renderTareaLista();
            programarGuardarTareaLista();
        }
    });
}

function programarGuardarTareaLista() {
    if (_tareaListaCtx.saveTimer) clearTimeout(_tareaListaCtx.saveTimer);
    _tareaListaCtx.saveTimer = setTimeout(guardarTareaLista, TAREA_LISTA_DEBOUNCE_MS);
}

function flushGuardarTareaLista() {
    if (_tareaListaCtx.saveTimer) {
        clearTimeout(_tareaListaCtx.saveTimer);
        _tareaListaCtx.saveTimer = null;
        // Disparar el guardado inmediato (best-effort, sin await aquí porque
        // el cierre del modal no debe bloquear).
        guardarTareaLista().catch((e) => console.error('[tarea-lista] flush err:', e));
    }
}

async function guardarTareaLista() {
    _tareaListaCtx.saveTimer = null;
    const id = _tareaListaCtx.asignadoId;
    if (!id) return;

    // Items normalizados: trimear + filtrar vacíos para la persistencia.
    // En memoria conservamos los vacíos para no perder filas mientras el
    // usuario está editando.
    const limpios = _tareaListaCtx.items
        .map((s) => (typeof s === 'string' ? s.trim() : ''))
        .filter((s) => s.length > 0)
        .slice(0, TAREA_LISTA_MAX);

    const nuevoParametros = (limpios.length === 0)
        ? null
        : { items: limpios };

    _tareaListaCtx.saving = true;
    renderTareaLista();

    try {
        const { error } = await supabase
            .from('ejercicios_asignados')
            .update({ parametros: nuevoParametros })
            .eq('id', id);
        if (error) throw error;
    } catch (e) {
        console.error('[tarea-lista] error guardando:', e);
        toast('No pudimos guardar la lista. Reintentá.', 'error');
    } finally {
        _tareaListaCtx.saving = false;
        // re-render para actualizar el estado visual (sin re-pintar inputs)
        const estado = document.getElementById('tarea-lista-estado');
        if (estado && !estado.classList.contains('tarea-lista__estado--saving')) {
            // pisa "Guardando…" con el texto definitivo
            renderTareaLista();
        }
    }
}

// Trae el row de ejercicios_asignados con su jsonb parametros. Lo usa
// abrirModalEjercicio para inicializar la lista cuando es una tarea.
async function fetchAsignadoParametros(asignadoId) {
    try {
        const { data, error } = await supabase
            .from('ejercicios_asignados')
            .select('parametros')
            .eq('id', asignadoId)
            .maybeSingle();
        if (error) {
            console.error('[tarea-lista] error fetch parametros:', error);
            return null;
        }
        return data?.parametros || null;
    } catch (e) {
        console.error('[tarea-lista] crash fetch parametros:', e);
        return null;
    }
}

function abrirModalEjercicio(ej, ejercicioAsignadoId) {
    setText('modal-ejercicio-titulo', ej.nombre || 'Ejercicio');
    const desc = document.getElementById('modal-ejercicio-desc');
    if (ej.descripcion && ej.descripcion.trim()) {
        desc.textContent = ej.descripcion;
        desc.removeAttribute('hidden');
    } else {
        desc.setAttribute('hidden', '');
    }
    // "Cómo se hace": instructivo largo del tutor. Solo si tiene texto.
    // textContent escapa el contenido; los saltos de línea se preservan con
    // white-space: pre-line en el CSS de la sección.
    const comoBox = document.getElementById('modal-ejercicio-comosehace');
    const comoCuerpo = document.getElementById('modal-ejercicio-comosehace-cuerpo');
    if (comoBox && comoCuerpo) {
        if (ej.como_se_hace && ej.como_se_hace.trim()) {
            comoCuerpo.textContent = ej.como_se_hace;
            comoBox.removeAttribute('hidden');
        } else {
            comoCuerpo.textContent = '';
            comoBox.setAttribute('hidden', '');
        }
    }
    const videoBox = document.getElementById('modal-ejercicio-video');
    const ytId = extraerYouTubeId(ej.video_url);
    if (ytId) {
        videoBox.innerHTML = `<iframe src="https://www.youtube-nocookie.com/embed/${ytId}" title="Video del ejercicio" frameborder="0" allow="accelerometer; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>`;
        videoBox.removeAttribute('hidden');
    } else {
        videoBox.innerHTML = '';
        videoBox.setAttribute('hidden', '');
    }
    const inst = document.getElementById('modal-ejercicio-instrucciones');
    if (ej.instrucciones && ej.instrucciones.trim()) {
        inst.textContent = ej.instrucciones;
        inst.classList.remove('modal-ejercicio__instrucciones--vacio');
    } else {
        inst.textContent = 'Tu adiestrador todavía no ha añadido una explicación detallada para este ejercicio.';
        inst.classList.add('modal-ejercicio__instrucciones--vacio');
    }

    const esTarea = (ej.categoria === 'tarea');
    const seccionProgreso = document.getElementById('ejercicio-progreso');
    const seccionMisEntrenos = document.getElementById('mientreno');
    const btnReportar = document.getElementById('btn-reportar-entreno');
    const seccionTarea = document.getElementById('tarea-lista');
    const seccionHerramienta = document.getElementById('herramienta-estado');
    const esHerramienta = (ej.categoria === 'herramienta');

    if (seccionHerramienta) seccionHerramienta.hidden = true;
    if (esHerramienta) {
        if (seccionProgreso) seccionProgreso.hidden = true;
        if (seccionMisEntrenos) seccionMisEntrenos.hidden = true;
        if (btnReportar) btnReportar.hidden = true;
        if (seccionTarea) seccionTarea.hidden = true;
        if (seccionHerramienta) seccionHerramienta.hidden = false;
        renderHerramientaEstado(ejercicioAsignadoId);
    } else if (esTarea) {
        // Ocultamos progreso / mis entrenos / reportar. Mostramos tarea-lista.
        if (seccionProgreso) seccionProgreso.hidden = true;
        if (seccionMisEntrenos) seccionMisEntrenos.hidden = true;
        if (btnReportar) btnReportar.hidden = true;
        // Cargamos parametros de la DB (no usamos cache de progreso porque
        // ese cache no incluye parametros).
        if (seccionTarea) {
            // Mostramos en estado "cargando" mínimo (placeholder con 3 vacíos)
            // hasta que llegue el fetch.
            abrirTareaLista(ejercicioAsignadoId, null);
            fetchAsignadoParametros(ejercicioAsignadoId).then((params) => {
                if (_tareaListaCtx.asignadoId !== ejercicioAsignadoId) return; // cambió modal
                abrirTareaLista(ejercicioAsignadoId, params);
            });
        }
    } else {
        if (seccionTarea) seccionTarea.hidden = true;
        if (btnReportar) btnReportar.hidden = false;
        const _hoy = Number(_progresoCache.get(ejercicioAsignadoId)?.count_dia || 0);
        if (btnReportar) btnReportar.textContent = _hoy > 0 ? 'Reportar otro entreno' : 'Reportar entreno';
        renderProgresoEnModal(ejercicioAsignadoId);
        cargarMisEntrenos(ejercicioAsignadoId);
    }

    abrirModal('modal-ejercicio-detalle');
    // Las notas del canal "+ Añadir nota" se quitaron; el cliente deja notas
    // solo al reportar el entreno. Pero el flujo de reporte necesita saber qué
    // ejercicio está abierto, así que conservamos la asignación.
    _ejercicioModalActualId = ejercicioAsignadoId;
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

function pintarParrafosFicha(contenedorId, texto) {
    const el = document.getElementById(contenedorId);
    if (!el) return;
    el.innerHTML = '';
    (texto || '').split(/\n\n+/).forEach((par) => {
        const t = par.trim();
        if (!t) return;
        const p = document.createElement('p');
        p.textContent = t;
        el.appendChild(p);
    });
}

async function abrirModalFichaProtocolo() {
    const perro = state.perros.find((p) => p.id === state.perroSeleccionadoId);
    if (!perro || !perro.protocolo_principal) return;
    const tituloEl = document.getElementById('modal-ficha-titulo');
    tituloEl.textContent = 'Cargando…';
    ['modal-ficha-trabajo','modal-ficha-reconocer','modal-ficha-clases','modal-ficha-consejos']
        .forEach((id) => pintarParrafosFicha(id, ''));
    abrirModal('modal-ficha-protocolo');
    try {
        const { data, error } = await supabase
            .from('protocolos_fichas')
            .select('titulo, que_trabajamos, como_reconocerlo, clases_estimadas, consejos')
            .eq('clave', perro.protocolo_principal)
            .maybeSingle();
        if (error) throw error;
        if (!data) {
            tituloEl.textContent = (PROTOCOLOS_LABEL[perro.protocolo_principal] || 'Tu plan de trabajo');
            pintarParrafosFicha('modal-ficha-trabajo', 'Pronto vas a encontrar acá más información sobre este trabajo.');
            return;
        }
        tituloEl.textContent = data.titulo || 'Tu plan de trabajo';
        pintarParrafosFicha('modal-ficha-trabajo', data.que_trabajamos);
        pintarParrafosFicha('modal-ficha-reconocer', data.como_reconocerlo);
        pintarParrafosFicha('modal-ficha-clases', data.clases_estimadas);
        pintarParrafosFicha('modal-ficha-consejos', data.consejos);
    } catch (e) {
        console.error('[ficha protocolo]', e);
        tituloEl.textContent = (PROTOCOLOS_LABEL[perro.protocolo_principal] || 'Tu plan de trabajo');
        pintarParrafosFicha('modal-ficha-trabajo', 'No se pudo cargar la información ahora. Probá de nuevo en un rato.');
    }
}

// ───────────────────────────────────────────────────────────
// Modal Añadir Perro (Bloque 4: solo UI, sin INSERT todavía)
// ───────────────────────────────────────────────────────────

function abrirModalAgregarPerro() {
    const form = document.getElementById('form-agregar-perro');
    if (form) form.reset();
    const err = document.getElementById('agregar-perro-error');
    if (err) { err.textContent = ''; err.hidden = true; }
    const btn = document.getElementById('agregar-perro-guardar');
    if (btn) {
        btn.disabled = true;
        btn.textContent = 'Guardar';
    }
    abrirModal('modal-agregar-perro');
    setTimeout(() => {
        const primer = document.getElementById('agregar-perro-nombre');
        if (primer) primer.focus();
    }, 50);
}

function validarFormAgregarPerro() {
    const nombre = (document.getElementById('agregar-perro-nombre')?.value || '').trim();
    const raza   = (document.getElementById('agregar-perro-raza')?.value   || '').trim();
    const edad   = document.getElementById('agregar-perro-edad')?.value || '';
    const peso   = document.getElementById('agregar-perro-peso')?.value   || '';
    const ok = nombre.length > 0
            && raza.length > 0
            && edad !== ''
            && peso !== '' && parseFloat(peso) > 0;
    const btn = document.getElementById('agregar-perro-guardar');
    if (btn) btn.disabled = !ok;
    return ok;
}

async function onSubmitAgregarPerro(ev) {
    ev.preventDefault();
    if (!validarFormAgregarPerro()) return;

    const clienteId = state.usuarioCliente?.cliente_id;
    const err = document.getElementById('agregar-perro-error');
    const btn = document.getElementById('agregar-perro-guardar');

    if (!clienteId) {
        if (err) {
            err.textContent = 'No hemos podido identificar tu sesión. Vuelve a entrar e inténtalo de nuevo.';
            err.hidden = false;
        }
        return;
    }

    const nombre = document.getElementById('agregar-perro-nombre').value.trim();
    const raza   = document.getElementById('agregar-perro-raza').value.trim();
    const edad   = parseInt(document.getElementById('agregar-perro-edad').value, 10);
    const peso   = parseFloat(document.getElementById('agregar-perro-peso').value);

    const proximaPrioridad = (state.perros || []).reduce(
        (max, p) => Math.max(max, p.prioridad || 0),
        0
    ) + 1;

    if (err) { err.textContent = ''; err.hidden = true; }
    if (btn) {
        btn.disabled = true;
        btn.textContent = 'Guardando…';
    }

    try {
        const { data, error } = await supabase
            .from('perros')
            .insert({
                cliente_id: clienteId,
                nombre,
                raza,
                edad_meses: edad,
                peso_kg: peso,
                prioridad: proximaPrioridad,
            })
            .select()
            .single();

        if (error) throw error;

        // Refrescar lista local (ya ordenada por prioridad gracias al Bloque 3)
        state.perros = await cargarPerros();

        // Marcar el nuevo perro como seleccionado para que el cliente lo vea
        if (data?.id) {
            state.perroSeleccionadoId = data.id;
            sessionStorage.setItem(STORAGE_PERRO_KEY, data.id);
        }
        renderSelectorPerros();
        await renderRutinaPerroSeleccionado();

        cerrarModal('modal-agregar-perro');
        toast('Perro añadido');
    } catch (e) {
        console.error('[agregar-perro] error:', e);
        if (err) {
            err.textContent = 'No hemos podido guardar. Inténtalo de nuevo.';
            err.hidden = false;
        }
        if (btn) {
            btn.disabled = false;
            btn.textContent = 'Guardar';
        }
    }
}

function bindFormAgregarPerro() {
    const form = document.getElementById('form-agregar-perro');
    if (!form) return;
    ['agregar-perro-nombre','agregar-perro-raza','agregar-perro-edad','agregar-perro-peso']
        .forEach((id) => {
            const el = document.getElementById(id);
            if (el) {
                el.addEventListener('input', validarFormAgregarPerro);
                el.addEventListener('change', validarFormAgregarPerro);
            }
        });
    form.addEventListener('submit', onSubmitAgregarPerro);
}

// ────────────────────────────────────────────────────────────
// Edición de "mis datos" (cliente) y "datos del perro"
// Dos modales independientes con patrón Guardar/Cancelar +
// botón disabled hasta detectar cambios reales (comparación contra
// snapshot inicial). Re-render del saludo o del hero al guardar.
// ────────────────────────────────────────────────────────────

// Snapshots de los valores iniciales para detectar cambios.
let _editCliCtx = { snapshot: null };
let _editPerroCtx = { snapshot: null, perroId: null };

// Campos editables del cliente y sus IDs de input.
const EDIT_CLI_FIELDS = [
    { col: 'nombre',    id: 'edit-cli-nombre',    tipo: 'text' },
    { col: 'telefono',  id: 'edit-cli-telefono',  tipo: 'text' },
    { col: 'email',     id: 'edit-cli-email',     tipo: 'text' },
    { col: 'direccion', id: 'edit-cli-direccion', tipo: 'text' },
    { col: 'ubicacion_maps', id: 'edit-cli-ubicacion-maps', tipo: 'text' },
    { col: 'zona',      id: 'edit-cli-zona',      tipo: 'text' },
];

// Validación suave para enlaces de Maps: si no empieza por http(s), anteponer
// https://. Los links de Maps tienen mil formatos (maps.app.goo.gl,
// google.com/maps, goo.gl/maps) — solo garantizamos que sea abrible.
function normalizarUrlMaps(valor) {
    const s = (valor || '').trim();
    if (!s) return s;
    return /^https?:\/\//i.test(s) ? s : 'https://' + s;
}

// Campos editables del perro.
const EDIT_PERRO_FIELDS = [
    { col: 'nombre',        id: 'edit-perro-nombre',        tipo: 'text' },
    { col: 'raza',          id: 'edit-perro-raza',          tipo: 'text' },
    { col: 'edad_meses',    id: 'edit-perro-edad-meses',    tipo: 'int' },
    { col: 'peso_kg',       id: 'edit-perro-peso',          tipo: 'num' },
    { col: 'es_ppp',        id: 'edit-perro-ppp',           tipo: 'bool' },
    { col: 'problematica',  id: 'edit-perro-problematica',  tipo: 'text' },
    { col: 'descripcion',   id: 'edit-perro-descripcion',   tipo: 'text' },
    { col: 'metodo_previo', id: 'edit-perro-metodo-previo', tipo: 'text' },
];

// Lee un campo del input según su tipo, devuelve valor normalizado
// listo para comparar/persistir. Strings vacíos → null.
function leerCampo(field) {
    const el = document.getElementById(field.id);
    if (!el) return null;
    if (field.tipo === 'bool') return Boolean(el.checked);
    const raw = (el.value || '').trim();
    if (raw === '') return null;
    if (field.tipo === 'int') {
        const n = Number(raw);
        return (Number.isFinite(n) && Number.isInteger(n)) ? n : null;
    }
    if (field.tipo === 'num') {
        const n = Number(raw);
        return Number.isFinite(n) ? n : null;
    }
    return raw;
}

// Normaliza un valor del row (DB) al formato que devolvería leerCampo,
// para comparar de forma consistente. null/'' → null. booleanos quedan.
function normalizarValor(val, tipo) {
    if (tipo === 'bool') return Boolean(val);
    if (val === null || val === undefined) return null;
    if (typeof val === 'string') {
        const trimmed = val.trim();
        return trimmed === '' ? null : trimmed;
    }
    if (tipo === 'int') return Number.isInteger(val) ? val : null;
    if (tipo === 'num') return Number.isFinite(Number(val)) ? Number(val) : null;
    return val;
}

// Pre-rellena los inputs del modal con los valores actuales y guarda
// el snapshot para detectar cambios.
function cargarFormulario(fields, fuente, snapshot) {
    fields.forEach((f) => {
        const el = document.getElementById(f.id);
        if (!el) return;
        const val = fuente?.[f.col];
        snapshot[f.col] = normalizarValor(val, f.tipo);
        if (f.tipo === 'bool') {
            el.checked = Boolean(val);
        } else if (val == null) {
            el.value = '';
        } else {
            el.value = String(val);
        }
    });
}

// Compara estado actual del formulario contra snapshot. Devuelve
// objeto con los cambios (solo las claves modificadas) o null si nada.
function detectarCambios(fields, snapshot) {
    const cambios = {};
    let hayCambios = false;
    fields.forEach((f) => {
        const actual = leerCampo(f);
        const previo = snapshot[f.col];
        if (actual !== previo) {
            cambios[f.col] = actual;
            hayCambios = true;
        }
    });
    return hayCambios ? cambios : null;
}

// Habilita/deshabilita el botón Guardar según haya cambios reales.
function refrescarBotonGuardar(fields, snapshot, btnId, nombreObligatorio) {
    const btn = document.getElementById(btnId);
    if (!btn) return;
    const cambios = detectarCambios(fields, snapshot);
    let valido = !!cambios;
    if (valido && nombreObligatorio) {
        const nombreVal = leerCampo(fields.find((f) => f.col === 'nombre'));
        if (!nombreVal) valido = false;
    }
    btn.disabled = !valido;
}

// ---------- Modal "Mis datos" ----------

function abrirModalEditarMisDatos() {
    if (!state.cliente) return;
    _editCliCtx.snapshot = {};
    cargarFormulario(EDIT_CLI_FIELDS, state.cliente, _editCliCtx.snapshot);
    const err = document.getElementById('edit-cli-error');
    if (err) { err.textContent = ''; err.hidden = true; }
    refrescarBotonGuardar(EDIT_CLI_FIELDS, _editCliCtx.snapshot, 'edit-cli-guardar', true);
    abrirModal('modal-editar-mis-datos');
}

async function onSubmitEditarMisDatos(ev) {
    ev.preventDefault();
    const err = document.getElementById('edit-cli-error');
    const btn = document.getElementById('edit-cli-guardar');
    if (err) { err.textContent = ''; err.hidden = true; }

    const cambios = detectarCambios(EDIT_CLI_FIELDS, _editCliCtx.snapshot);
    if (!cambios) { cerrarModal('modal-editar-mis-datos'); return; }

    // Validaciones blandas
    if (cambios.nombre !== undefined && (!cambios.nombre || cambios.nombre.length < 2)) {
        if (err) { err.textContent = 'El nombre no puede quedar vacío.'; err.hidden = false; }
        return;
    }
    if (cambios.email !== undefined && cambios.email !== null && !EMAIL_RE.test(cambios.email)) {
        if (err) { err.textContent = 'El email no parece válido.'; err.hidden = false; }
        return;
    }
    // Enlace de Maps: validación suave (anteponer https:// si hace falta).
    if (cambios.ubicacion_maps) {
        cambios.ubicacion_maps = normalizarUrlMaps(cambios.ubicacion_maps);
    }

    if (btn) { btn.disabled = true; btn.textContent = 'Guardando…'; }

    try {
        const { error } = await supabase
            .from('clientes')
            .update(cambios)
            .eq('id', state.cliente.id);
        if (error) throw error;

        // Sincronizar state.cliente con los cambios persistidos.
        Object.assign(state.cliente, cambios);

        // Re-render del saludo (el nombre puede haber cambiado).
        renderHeader();

        toast('Datos guardados');
        cerrarModal('modal-editar-mis-datos');
    } catch (e) {
        console.error('[edit-cli] error guardando:', e);
        if (err) { err.textContent = 'No pudimos guardar. Intentalo de nuevo.'; err.hidden = false; }
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Guardar'; }
    }
}

function bindFormEditarMisDatos() {
    const form = document.getElementById('form-editar-mis-datos');
    if (!form) return;
    EDIT_CLI_FIELDS.forEach((f) => {
        const el = document.getElementById(f.id);
        if (!el) return;
        const handler = () => refrescarBotonGuardar(
            EDIT_CLI_FIELDS, _editCliCtx.snapshot, 'edit-cli-guardar', true,
        );
        el.addEventListener('input', handler);
        el.addEventListener('change', handler);
    });
    form.addEventListener('submit', onSubmitEditarMisDatos);

    document.getElementById('btn-editar-mis-datos')
        ?.addEventListener('click', abrirModalEditarMisDatos);
}

// ---------- Modal "Datos del perro" ----------

function abrirModalEditarPerro() {
    const perro = state.perros.find((p) => p.id === state.perroSeleccionadoId);
    if (!perro) return;
    _editPerroCtx.perroId = perro.id;
    _editPerroCtx.snapshot = {};
    cargarFormulario(EDIT_PERRO_FIELDS, perro, _editPerroCtx.snapshot);
    const err = document.getElementById('edit-perro-error');
    if (err) { err.textContent = ''; err.hidden = true; }
    refrescarBotonGuardar(EDIT_PERRO_FIELDS, _editPerroCtx.snapshot, 'edit-perro-guardar', true);
    abrirModal('modal-editar-perro');
}

async function onSubmitEditarPerro(ev) {
    ev.preventDefault();
    const err = document.getElementById('edit-perro-error');
    const btn = document.getElementById('edit-perro-guardar');
    if (err) { err.textContent = ''; err.hidden = true; }

    const cambios = detectarCambios(EDIT_PERRO_FIELDS, _editPerroCtx.snapshot);
    if (!cambios) { cerrarModal('modal-editar-perro'); return; }

    if (cambios.nombre !== undefined && (!cambios.nombre || cambios.nombre.length < 2)) {
        if (err) { err.textContent = 'El nombre no puede quedar vacío.'; err.hidden = false; }
        return;
    }
    if (cambios.edad_meses !== undefined && cambios.edad_meses !== null
        && (cambios.edad_meses < 0 || cambios.edad_meses > 360)) {
        if (err) { err.textContent = 'La edad en meses debe estar entre 0 y 360.'; err.hidden = false; }
        return;
    }
    if (cambios.peso_kg !== undefined && cambios.peso_kg !== null
        && (cambios.peso_kg <= 0 || cambios.peso_kg > 120)) {
        if (err) { err.textContent = 'El peso debe estar entre 0 y 120 kg.'; err.hidden = false; }
        return;
    }

    // Si se edita edad_meses, también nulleamos el campo legacy `edad` (text)
    // para que las dos representaciones no diverjan.
    if (cambios.edad_meses !== undefined) {
        cambios.edad = null;
    }

    if (btn) { btn.disabled = true; btn.textContent = 'Guardando…'; }

    try {
        const { error } = await supabase
            .from('perros')
            .update(cambios)
            .eq('id', _editPerroCtx.perroId);
        if (error) throw error;

        // Sincronizar el row local en state.perros.
        const idx = state.perros.findIndex((p) => p.id === _editPerroCtx.perroId);
        if (idx >= 0) {
            Object.assign(state.perros[idx], cambios);
        }

        // Re-render del hero del perro.
        await renderRutinaPerroSeleccionado();

        toast('Datos del perro guardados');
        cerrarModal('modal-editar-perro');
    } catch (e) {
        console.error('[edit-perro] error guardando:', e);
        if (err) { err.textContent = 'No pudimos guardar. Intentalo de nuevo.'; err.hidden = false; }
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Guardar'; }
    }
}

function bindFormEditarPerro() {
    const form = document.getElementById('form-editar-perro');
    if (!form) return;
    EDIT_PERRO_FIELDS.forEach((f) => {
        const el = document.getElementById(f.id);
        if (!el) return;
        const handler = () => refrescarBotonGuardar(
            EDIT_PERRO_FIELDS, _editPerroCtx.snapshot, 'edit-perro-guardar', true,
        );
        el.addEventListener('input', handler);
        el.addEventListener('change', handler);
    });
    form.addEventListener('submit', onSubmitEditarPerro);

    document.getElementById('btn-editar-perro')
        ?.addEventListener('click', abrirModalEditarPerro);
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
    const yaAbierto = !modal.hasAttribute('hidden');
    modal.removeAttribute('hidden');
    modal.setAttribute('aria-hidden', 'false');
    requestAnimationFrame(() => modal.classList.add('is-open'));
    document.body.style.overflow = 'hidden';
    // Back navigation: pusheamos una entrada al historial para que el botón
    // atrás físico cierre el modal en lugar de salir de la PWA. Solo cuando
    // recién se abre y no estamos navegando por popstate (re-entrada).
    if (!yaAbierto && !navegandoPorPopstate) {
        history.pushState({ pdli: 'modal', id }, '');
    }
}

function cerrarModal(id) {
    const modal = document.getElementById(id);
    if (!modal || modal.hasAttribute('hidden')) return;

    // Si el dictado está activo sobre un textarea contenido en este modal,
    // cortar el micro para no dejarlo abierto en background.
    if (_voz.activoBtn && _voz.activoTextareaId) {
        const ta = document.getElementById(_voz.activoTextareaId);
        if (ta && modal.contains(ta)) detenerDictado();
    }

    modal.classList.remove('is-open');
    document.body.style.overflow = '';
    if (id === 'modal-ejercicio-detalle') {
        const videoBox = document.getElementById('modal-ejercicio-video');
        if (videoBox) videoBox.innerHTML = '';
        const mientreno = document.getElementById('mientreno');
        if (mientreno) mientreno.hidden = true;
        // Flush + reset de la tarea-lista si estaba abierta.
        if (_tareaListaCtx.asignadoId) cerrarTareaLista();
    }
    // Si el cierre vino de la UI (X, backdrop, Esc, botón Cancelar/Guardar),
    // consumimos la entrada del history que se pusheó al abrir. El handler
    // de popstate detecta cierreUiPendiente y no dispara la lógica de toast.
    if (!navegandoPorPopstate) {
        cierreUiPendiente = true;
        history.back();
    }
    setTimeout(() => {
        modal.setAttribute('hidden', '');
        modal.setAttribute('aria-hidden', 'true');
    }, 200);
}

// ═══════════════════════════════════════════════════════════
// BACK NAVIGATION — botón atrás Android estilo Instagram.
// Patrón: history.pushState + popstate. Mantenemos un "anchor" siempre
// en la historia; abrir un modal suma otra entrada. El handler de
// popstate decide qué hacer según la UI visible.
// Prioridades (descendentes):
//   1) Modal abierto                  → cerrar
//   2) Tab Rutina + Mi progreso       → volver a Rutina principal
//   3) Tab ≠ Rutina                   → volver a Rutina
//   4) Home (Rutina, vista Rutina)    → toast + 2s para confirmar salida
// Flags:
//   · navegandoPorPopstate: evita doble pushState cuando el handler
//     llama a closeModal/cambiarTab durante el procesamiento.
//   · cierreUiPendiente: marca que el back vino de la UI (X/Esc/botón).
//     El handler lo detecta y solo consume + re-ancla, sin toast.
//   · readyToExit + exitTimer: ventana de 2s para confirmar la salida.
//   · bloquearSalida: cuando ya estamos saliendo, el handler deja pasar.
// ═══════════════════════════════════════════════════════════

let navegandoPorPopstate = false;
let cierreUiPendiente = false;
let readyToExit = false;
let exitTimer = null;
let bloquearSalida = true;

function bindBackNavigation() {
    if (window.__backNavBoundCliente) return;
    window.__backNavBoundCliente = true;

    // Anchor inicial: garantiza que el primer back físico dispare popstate
    // en vez de cerrar la PWA directamente. Solo se monta una vez por sesión
    // (la app cliente nunca recarga durante uso normal).
    history.pushState({ pdli: 'anchor' }, '');

    window.addEventListener('popstate', () => {
        if (!bloquearSalida) return; // ya estamos saliendo, dejar pasar

        // Caso especial: el back lo originó cerrarModal() desde UI.
        // Solo consumimos la entrada y re-armamos el guard.
        if (cierreUiPendiente) {
            cierreUiPendiente = false;
            history.pushState({ pdli: 'anchor' }, '');
            return;
        }

        // Prioridad 1: modal abierto → cerrar
        const modal = document.querySelector('.modal-pdli:not([hidden])');
        if (modal) {
            history.pushState({ pdli: 'anchor' }, '');
            navegandoPorPopstate = true;
            try { cerrarModal(modal.id); } finally { navegandoPorPopstate = false; }
            return;
        }

        // Prioridad 2: sub-vista "Mi progreso" dentro de Rutina → volver a Rutina principal
        const tabActual = document.querySelector('.tab-panel.is-active')?.dataset.tab;
        if (tabActual === 'rutina' && state.rutinaModo === 'progreso') {
            history.pushState({ pdli: 'anchor' }, '');
            navegandoPorPopstate = true;
            try { cambiarRutinaModo('rutina'); } finally { navegandoPorPopstate = false; }
            return;
        }

        // Prioridad 3: tab ≠ Rutina → volver a Rutina (siempre arranca en vista 'rutina')
        if (tabActual && tabActual !== 'rutina') {
            history.pushState({ pdli: 'anchor' }, '');
            navegandoPorPopstate = true;
            try { showTab('rutina'); } finally { navegandoPorPopstate = false; }
            return;
        }

        // Prioridad 4: Home (Rutina + vista Rutina) → doble-tap para salir
        if (readyToExit) {
            // Segundo back dentro de los 2s: dejar salir. No re-pushear.
            clearTimeout(exitTimer);
            readyToExit = false;
            bloquearSalida = false;
            history.back(); // si era la última entrada del PWA, el SO la cierra
            return;
        }
        history.pushState({ pdli: 'anchor' }, '');
        toast('Pulsá atrás otra vez para salir');
        readyToExit = true;
        exitTimer = setTimeout(() => { readyToExit = false; }, 2000);
    });
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

/**
 * Detecta si un error de Supabase corresponde a violación del constraint
 * UNIQUE citas_slot_unico (Capa 1, aplicado 22/05/2026).
 */
function esErrorSlotTomado(error) {
    if (!error) return false;
    if (error.code === '23505') return true;
    const msg = typeof error.message === 'string' ? error.message : '';
    return msg.includes('citas_slot_unico') || msg.includes('duplicate key');
}

let toastTimer = null;
function toast(msg, kind = 'info', duracionMs = 2400) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.remove('toast--info', 'toast--error');
    el.classList.add(kind === 'error' ? 'toast--error' : 'toast--info');
    el.removeAttribute('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.setAttribute('hidden', ''), duracionMs);
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
    // Defensivo: la RPC puede devolver null, undefined, o un timestamptz
    // con sufijo "T00:00:00" en vez de date plano.
    if (!iso || typeof iso !== 'string') return 'pronto';
    // Aceptar tanto "2026-05-27" como "2026-05-27T00:00:00..."
    const fechaParte = iso.split('T')[0];
    const [y, m, d] = fechaParte.split('-').map(Number);
    if (!y || !m || !d) return 'pronto';
    const dt = new Date(y, m - 1, d);
    if (isNaN(dt.getTime())) return 'pronto';
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

// ===================== Notas de voz =====================
//
// Web Speech API. Soporta Chrome y Safari (iOS >= 14.5, macOS recientes),
// no Firefox. Estrategia: un único reconocedor compartido entre los
// botones. Si se activa un botón mientras otro está grabando, se
// detiene el primero antes de iniciar el segundo. Si el mismo botón
// se vuelve a tocar, hace toggle off.

const _voz = {
    SR: window.SpeechRecognition || window.webkitSpeechRecognition,
    recognition: null,
    activoBtn: null,
    activoTextareaId: null,
    baseline: '',         // texto que ya había en el textarea al iniciar
    finalAcumulado: '',   // segmentos finales acumulados en esta sesión
};

// Cada textarea con dictado tiene un botón "confirmar" asociado que
// persiste la nota: al detener el dictado lo resaltamos brevemente
// para evitar que el cliente cierre el modal pensando que ya guardó
// (patrón WhatsApp: soltás el mic y se manda; acá no — falta tocar).
const _vozBtnConfirmar = {
    'reporte-nota': 'reporte-guardar',
    'mensaje-textarea': 'mensaje-enviar',
};

function vozSoportada() {
    return !!_voz.SR;
}

function iniciarDictado(textareaId, btn) {
    if (!vozSoportada()) return;

    // Si ya hay otro botón grabando, detenerlo primero.
    if (_voz.activoBtn && _voz.activoBtn !== btn) {
        detenerDictado();
    }
    if (_voz.activoBtn === btn) {
        // Mismo botón = toggle off.
        detenerDictado();
        return;
    }

    const ta = document.getElementById(textareaId);
    if (!ta) return;

    _voz.recognition = new _voz.SR();
    _voz.recognition.lang = 'es-ES';
    _voz.recognition.continuous = true;
    _voz.recognition.interimResults = true;

    _voz.activoBtn = btn;
    _voz.activoTextareaId = textareaId;
    _voz.baseline = ta.value;
    _voz.finalAcumulado = '';

    _voz.recognition.onresult = (e) => {
        let interim = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
            const res = e.results[i];
            if (res.isFinal) {
                _voz.finalAcumulado += (_voz.finalAcumulado ? ' ' : '') + res[0].transcript.trim();
            } else {
                interim += res[0].transcript;
            }
        }
        const sepBase = _voz.baseline && (_voz.finalAcumulado || interim) ? ' ' : '';
        const sepInterim = interim ? (_voz.finalAcumulado ? ' ' : '') : '';
        ta.value = _voz.baseline + sepBase + _voz.finalAcumulado + sepInterim + interim;
        // Disparar 'input' para que auto-grow/contadores reaccionen.
        ta.dispatchEvent(new Event('input', { bubbles: true }));
    };

    _voz.recognition.onerror = (e) => {
        console.warn('[voz] error:', e.error);
        if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
            if (typeof toast === 'function') toast('Permiso de micrófono denegado', 'error');
        }
        limpiarDictado();
    };

    _voz.recognition.onend = () => {
        limpiarDictado();
    };

    try {
        _voz.recognition.start();
        btn.classList.add('is-grabando');
        btn.setAttribute('aria-label', 'Detener dictado');
    } catch (err) {
        console.error('[voz] start:', err);
        limpiarDictado();
    }
}

function detenerDictado() {
    if (!_voz.recognition) return;
    try { _voz.recognition.stop(); } catch (_) {}
    // onend dispara limpiarDictado.
}

function limpiarDictado() {
    // Antes de soltar las refs: si quedó texto en el textarea, resaltar
    // el botón de confirmar correspondiente para guiar el siguiente paso.
    if (_voz.activoTextareaId) {
        const ta = document.getElementById(_voz.activoTextareaId);
        const btnConfirmarId = _vozBtnConfirmar[_voz.activoTextareaId];
        if (ta && ta.value.trim() && btnConfirmarId) {
            const btnConfirmar = document.getElementById(btnConfirmarId);
            if (btnConfirmar) resaltarBoton(btnConfirmar);
        }
    }

    if (_voz.activoBtn) {
        _voz.activoBtn.classList.remove('is-grabando');
        _voz.activoBtn.setAttribute('aria-label', 'Dictar nota por voz');
    }
    _voz.activoBtn = null;
    _voz.activoTextareaId = null;
    _voz.baseline = '';
    _voz.finalAcumulado = '';
    _voz.recognition = null;
}

function resaltarBoton(btn) {
    btn.classList.add('is-resaltado-voz');
    setTimeout(() => btn.classList.remove('is-resaltado-voz'), 4200);
}

function bindBotonesDictado() {
    if (!vozSoportada()) return; // sin soporte → todos quedan hidden
    document.querySelectorAll('.textarea-voz__btn[data-voz-target]').forEach((btn) => {
        btn.hidden = false;
        btn.addEventListener('click', () => {
            iniciarDictado(btn.dataset.vozTarget, btn);
        });
    });
}

// ===================== Service Worker =====================

function registrarServiceWorker() {
    if (!('serviceWorker' in navigator)) return;

    // Snapshot ANTES del register: si ya había un SW controlando,
    // entonces un futuro controllerchange = "se activó una versión nueva".
    // Si NO había (primera visita), controllerchange es la activación
    // inicial → NO hay que reloadear.
    const habiaSwAntes = !!navigator.serviceWorker.controller;
    let recargandoPorSw = false;
    let reg = null;

    navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!habiaSwAntes) return;
        if (recargandoPorSw) return;
        recargandoPorSw = true;
        window.location.reload();
    });

    // Al volver a la tab (PWA reanudada, vuelta de background), forzamos un
    // chequeo de versión nueva. reg se asigna tras el register de abajo.
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && reg) {
            reg.update();
        }
    });

    window.addEventListener('load', () => {
        navigator.serviceWorker
            .register('/clases/service-worker.js', { scope: '/clases/', updateViaCache: 'none' })
            .then((registration) => {
                reg = registration;
                console.log('[app] SW Clases registrado, scope:', registration.scope);
            })
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

// ===================== Helpers de fecha (calendario mes) =====================

function primerDiaDelMes(fechaIso) {
    const [y, m] = fechaIso.split('-');
    return `${y}-${m}-01`;
}

function diasEntreIso(aIso, bIso) {
    const a = new Date(aIso + 'T00:00:00');
    const b = new Date(bIso + 'T00:00:00');
    return Math.round((a - b) / 86400000);
}

function nombreMesAnio(fechaIso) {
    const meses = ['Enero','Febrero','Marzo','Abril','Mayo','Junio',
                   'Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
    const [y, m] = fechaIso.split('-');
    return `${meses[parseInt(m, 10) - 1]} ${y}`;
}

function sumarMesesIso(fechaIso, n) {
    const [y, m] = fechaIso.split('-').map(Number);
    const total = (y * 12 + (m - 1)) + n;
    const ny = Math.floor(total / 12);
    const nm = (total % 12) + 1;
    return `${ny}-${String(nm).padStart(2, '0')}-01`;
}

// ===================== Render del calendario mes =====================

function renderCalMes() {
    const grid = document.getElementById('cal-mes-grid');
    const titulo = document.getElementById('cal-mes-titulo');
    const prev = document.getElementById('cal-mes-prev');
    const next = document.getElementById('cal-mes-next');
    const anchor = state.calMes.anchorIso;
    if (!grid || !anchor) return;

    titulo.textContent = nombreMesAnio(anchor).toUpperCase();

    // Límites de navegación: hoy → +2 meses (cubre las 8 semanas del fetch).
    const hoy = new Date();
    const hoyMes = `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, '0')}-01`;
    const limiteSup = sumarMesesIso(hoyMes, 2);

    prev.disabled = anchor <= hoyMes;
    next.disabled = anchor >= limiteSup;

    // Construir grilla (lunes = 0; getDay() retorna 0=domingo)
    const [y, m] = anchor.split('-').map(Number);
    const primero = new Date(y, m - 1, 1);
    const ultimoDia = new Date(y, m, 0).getDate();
    const diaSemanaInicio = (primero.getDay() + 6) % 7;

    const fechasMias = new Set(state.citas
        .filter((c) => c.estado === 'confirmada' || c.estado === 'realizada')
        .map((c) => c.fecha));

    const hoyIso = new Date().toISOString().slice(0, 10);
    const cells = [];

    for (let i = 0; i < diaSemanaInicio; i++) {
        cells.push('<button type="button" class="cal-dia is-fuera-mes" disabled></button>');
    }

    for (let d = 1; d <= ultimoDia; d++) {
        const iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        const tieneDispo = !!state.calMes.slotsPorFecha[iso];
        const esMia = fechasMias.has(iso);
        const esSeleccionado = iso === state.calMes.diaSeleccionadoIso;
        const esPasado = iso < hoyIso;

        const clases = ['cal-dia'];
        if (esPasado || !tieneDispo) clases.push('is-deshabilitado');
        if (tieneDispo) clases.push('is-disponible');
        if (esSeleccionado) clases.push('is-seleccionado');
        if (esMia) clases.push('is-mia');

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
            state.calMes.diaSeleccionadoIso = btn.dataset.fecha;
            renderCalMes();
            renderDiaPanel();
        });
    });
}

function renderDiaPanel() {
    const panel = document.getElementById('reservar-dia-panel');
    const vacio = document.getElementById('reservar-dia-vacio');
    const titulo = document.getElementById('cal-dia-panel-titulo');
    const slots = document.getElementById('cal-dia-panel-slots');

    const iso = state.calMes.diaSeleccionadoIso;
    if (!iso || !state.calMes.slotsPorFecha[iso]) {
        panel.setAttribute('hidden', '');
        vacio.removeAttribute('hidden');
        return;
    }

    vacio.setAttribute('hidden', '');
    titulo.textContent = formatearFechaLarga(iso).toUpperCase();

    const horas = state.calMes.slotsPorFecha[iso];
    slots.innerHTML = horas.map((h) => `
        <button type="button" class="slot-card is-libre"
                data-fecha="${iso}" data-hora="${h}"
                data-label="${escapeHTML(formatearFechaLarga(iso))} · ${h}">
            <span class="slot-card__hora">${h}</span>
        </button>
    `).join('');

    panel.removeAttribute('hidden');

    slots.querySelectorAll('.slot-card.is-libre').forEach((el) => {
        el.addEventListener('click', () => {
            abrirModalReservar({
                fecha: el.dataset.fecha,
                hora: el.dataset.hora,
                label: el.dataset.label,
            });
        });
    });
}

function navegarMes(delta) {
    state.calMes.anchorIso = sumarMesesIso(state.calMes.anchorIso, delta);
    renderCalMes();
}

// ===================== Flujo guiado post-reserva (sugerencia) =====================

function calcularSugerencia(slotReservado) {
    // Sugerencia: mismo día de semana + 7 días, misma hora.
    // Si ese slot exacto no está libre, buscar la fecha disponible más cercana.
    const fechaSug = sumarDiasIso(slotReservado.fecha, 7);
    const hora = slotReservado.hora;

    const slotsDelDia = state.calMes.slotsPorFecha[fechaSug] || [];
    if (slotsDelDia.includes(hora)) {
        return { fecha: fechaSug, hora, label: `${formatearFechaLarga(fechaSug)} · ${hora}`, exacta: true };
    }

    const fechasDisp = Object.keys(state.calMes.slotsPorFecha).sort();
    if (fechasDisp.length === 0) return null;

    let mejor = null;
    let mejorDist = Infinity;
    fechasDisp.forEach((f) => {
        const dist = Math.abs(diasEntreIso(f, fechaSug));
        if (dist < mejorDist) {
            mejorDist = dist;
            mejor = f;
        }
    });
    if (!mejor) return null;
    const hSug = state.calMes.slotsPorFecha[mejor][0];
    return { fecha: mejor, hora: hSug, label: `${formatearFechaLarga(mejor)} · ${hSug}`, exacta: false };
}

function mostrarModoSugerencia(slotReservado, sugerencia, numProxima) {
    const modal = document.getElementById('modal-reservar');
    const modoConfirmar = modal.querySelector('[data-modo="confirmar"]');
    const modoSugerencia = modal.querySelector('[data-modo="sugerencia"]');

    // Sin sugerencia válida: cerrar y mandar a Mis citas.
    if (!sugerencia) {
        cerrarModal('modal-reservar');
        showTab('mis-citas');
        return;
    }

    modoConfirmar.setAttribute('hidden', '');
    modoSugerencia.removeAttribute('hidden');

    setText('modal-sugerencia-confirmada', slotReservado.label);
    setText('modal-sugerencia-num', `clase ${numProxima}`);
    setText('modal-sugerencia-slot', sugerencia.label);
    setText('modal-sugerencia-nota', sugerencia.exacta
        ? 'Mismo día y hora de la semana próxima.'
        : 'La fecha sugerida no estaba libre; te proponemos la más cercana.');

    state.sugerenciaActiva = sugerencia;

    // Wire idempotente (sobreescribimos handlers cada vez)
    document.getElementById('modal-sugerencia-reservar').onclick = () => {
        const sug = state.sugerenciaActiva;
        if (!sug) return;
        // Pasar al modo confirmar con el slot sugerido precargado.
        // El usuario hace un tap consciente en "Sí, reservar" — evita reservas accidentales.
        state.reservandoSlot = sug;
        state.sugerenciaActiva = null;
        modoSugerencia.setAttribute('hidden', '');
        modoConfirmar.removeAttribute('hidden');
        setText('modal-reservar-slot', sug.label);
        const btn = document.getElementById('modal-reservar-confirmar');
        btn.disabled = false;
        btn.textContent = 'Sí, reservar';
        const err = document.getElementById('modal-reservar-error');
        err.textContent = '';
        err.hidden = true;
    };

    document.getElementById('modal-sugerencia-otra').onclick = () => {
        cerrarModal('modal-reservar');
        // Refrescar la tab para que el cliente vea el calendario actualizado.
        renderTabReservar();
    };
}

// ===================== Modificar cita existente =====================

function iniciarModificarCita(cita) {
    // Verificación de seguridad: ventana >48h (la UI ya filtra esto, defensa).
    const dt = _datetimeCita(cita);
    const horasFaltan = (dt - new Date()) / 36e5;
    if (horasFaltan <= 48) {
        toast(`Para cambios a menos de 48h, escribe al ${TELEFONO_PUBLICO}`, 'error');
        return;
    }

    // Guardar el contexto de modificación.
    state.modificando = {
        id: cita.id,
        fecha_vieja: cita.fecha,
        hora_vieja: cita.hora,
        numero_clase: cita.numero_clase,
    };

    // Saltar a Reservar — renderTabReservar detecta state.modificando y se
    // adapta visualmente (banner arriba + lógica de UPDATE al confirmar).
    showTab('reservar');
}

// ───────────────────────────────────────────────────────────
// Mensajes y notas en ejercicio (Bloque A.2)
// ───────────────────────────────────────────────────────────

let _ejercicioModalActualId = null;
let _reporteTranquilidad = null;       // 1..5 o null (estado del pill seleccionado)
let _avisoTrqEjercicio = '';           // nombre del ejercicio del último aviso de tranquilidad baja
let _reporteCampos = [];               // campos activos del ejercicio actual (de la RPC)
let _reporteSpecs = null;              // null o { valorComida, dificultad, objetivoSeg, objetivoDistancia }
let _editandoRegistroId = null;        // null = reporte nuevo (INSERT); id = editando ese registro (UPDATE)
let _misEntrenosCache = [];            // registros de "Mis entrenos" en pantalla (para el botón Editar)
let _reporteVideoFile = null;          // File de video seleccionado para subir (o null)
let _reporteVideoPreviewUrl = null;    // objectURL activo del preview (para revocar)

// Grabación en vivo (Parte 1B).
let _grabStream = null;        // MediaStream activo de la cámara
let _grabRecorder = null;      // MediaRecorder
let _grabChunks = [];          // Blob[] de la grabación
let _grabMimeType = null;      // mimeType elegido para esta grabación
let _grabTimer = null;         // setInterval del countdown
let _grabSegundosRest = 0;

// Límites de video del entreno (Paso 1A): 25 MB y 65 s.
const VIDEO_MAX_BYTES = 26214400;
const VIDEO_MAX_SEG = 65;

// Helpers de fecha
function formatearFechaRelativa(dateStr) {
    const fecha = new Date(dateStr);
    const hoy = new Date();
    hoy.setHours(0, 0, 0, 0);
    const fechaSinHora = new Date(fecha);
    fechaSinHora.setHours(0, 0, 0, 0);
    const diffMs = hoy - fechaSinHora;
    const diffDias = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffDias === 0) return 'HOY';
    if (diffDias === 1) return 'AYER';
    if (diffDias < 7) return `HACE ${diffDias} DÍAS`;

    const dias = ['DOMINGO','LUNES','MARTES','MIÉRCOLES','JUEVES','VIERNES','SÁBADO'];
    const meses = ['ENERO','FEBRERO','MARZO','ABRIL','MAYO','JUNIO','JULIO','AGOSTO','SEPTIEMBRE','OCTUBRE','NOVIEMBRE','DICIEMBRE'];
    return `${dias[fecha.getDay()]} ${fecha.getDate()} DE ${meses[fecha.getMonth()]}`;
}

function formatearHora(dateStr) {
    const f = new Date(dateStr);
    return f.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', hour12: false });
}

// escapeHTML ya está definida arriba en este archivo — reutilizamos.

// === Mensajes generales (tab Mensajes) ===

async function cargarMensajes() {
    const clienteId = state.usuarioCliente?.cliente_id;
    if (!clienteId) return [];
    const { data, error } = await supabase
        .from('mensajes')
        .select('*')
        .eq('cliente_id', clienteId)
        .is('ejercicio_asignado_id', null)
        .order('created_at', { ascending: true });
    if (error) {
        console.error('[mensajes] error:', error);
        return [];
    }
    return data || [];
}

async function contarRespuestasSinLeer() {
    const clienteId = state.usuarioCliente?.cliente_id;
    if (!clienteId) return 0;
    const { count, error } = await supabase
        .from('mensajes')
        .select('id', { count: 'exact', head: true })
        .eq('cliente_id', clienteId)
        .eq('autor_admin', true)
        .eq('leido_por_cliente', false)
        .is('ejercicio_asignado_id', null);
    if (error) { console.error('[badge-mensajes]', error); return 0; }
    return count || 0;
}

async function actualizarBadgeMensajes() {
    const badge = document.getElementById('nav-badge-mensajes');
    if (!badge) return;
    const n = await contarRespuestasSinLeer();
    badge.hidden = (n === 0);
}

async function marcarRespuestasLeidasYActualizar() {
    try { await supabase.rpc('marcar_respuestas_leidas'); }
    catch (e) { console.error('[marcar-leidas]', e); }
    actualizarBadgeMensajes();
}

async function renderFeedMensajes() {
    const feed = document.getElementById('feed-mensajes');
    if (!feed) return;
    const mensajes = await cargarMensajes();

    if (mensajes.length === 0) {
        feed.innerHTML = `
            <div class="feed-empty">
                <span class="feed-empty__title">Sin mensajes aún</span>
                <p class="feed-empty__text">Aquí aparecerán los mensajes que envíes al adiestrador.</p>
            </div>
        `;
        return;
    }

    // Agrupar por fecha (más reciente arriba)
    const porFecha = {};
    mensajes.forEach((m) => {
        const fecha = formatearFechaRelativa(m.created_at);
        if (!porFecha[fecha]) porFecha[fecha] = [];
        porFecha[fecha].push(m);
    });

    const html = Object.entries(porFecha).map(([fecha, items]) => `
        <div class="feed-date-row">
            <span class="feed-date-label">${escapeHTML(fecha)}</span>
            <span class="feed-date-rule"></span>
        </div>
        <div class="feed-entries">
            ${items.map((m) => {
                const esAdmin = !!m.autor_admin;
                const etiqueta = esAdmin
                    ? '<span class="feed-entry__from">El adiestrador</span>'
                    : (m.leido_por_admin ? '<span class="feed-entry__seen">Visto</span>' : '');
                return `
                <div class="feed-entry${esAdmin ? ' feed-entry--admin' : ''}">
                    <div class="feed-entry__head">
                        <span class="feed-entry__time">${formatearHora(m.created_at)}</span>
                        ${etiqueta}
                    </div>
                    <div class="feed-entry__body">${escapeHTML(m.contenido)}</div>
                </div>
                `;
            }).join('')}
        </div>
    `).join('');

    feed.innerHTML = html;
    requestAnimationFrame(() => {
        feed.scrollTop = feed.scrollHeight;
    });
}

// Lleva la pestaña Mensajes al fondo: feed scrolleado a los últimos mensajes y
// composer a la vista. El feed tiene scroll propio (overflow-y), pero con
// muchos mensajes la página también desborda, así que aseguramos ambos.
function scrollMensajesAlFondo() {
    const ejec = () => {
        const feed = document.querySelector('#tab-mensajes .feed-timeline');
        if (feed) feed.scrollTop = feed.scrollHeight;
        const composer = document.getElementById('mensaje-textarea');
        if (composer) composer.scrollIntoView({ block: 'end', behavior: 'instant' });
        // El scroll relevante es el del window, no el del feed.
        window.scrollTo(0, document.body.scrollHeight);
    };
    // Inmediato: cubre llamados con el layout ya listo.
    ejec();
    // Doble rAF: el tab acaba de pasar a display:flex; esperamos al repaint
    // para que el layout tenga altura real.
    requestAnimationFrame(() => requestAnimationFrame(ejec));
    // Fallback para pestañas hidden / PWA en background, donde Chrome throttlea
    // requestAnimationFrame y el doble rAF no llega a correr.
    setTimeout(ejec, 80);
}

async function enviarMensaje() {
    const ta = document.getElementById('mensaje-textarea');
    const btn = document.getElementById('mensaje-enviar');
    const status = document.getElementById('mensaje-status');
    if (!ta || !btn) return;
    const contenido = ta.value.trim();
    if (!contenido) return;

    const clienteId = state.usuarioCliente?.cliente_id;
    const autorId = state.usuarioCliente?.id;
    if (!clienteId) {
        if (status) { status.textContent = 'No hemos podido identificar tu sesión.'; status.classList.add('is-err'); }
        return;
    }

    btn.disabled = true;
    btn.classList.remove('is-ready');
    if (status) { status.textContent = 'Enviando…'; status.classList.remove('is-err'); }

    try {
        const { error } = await supabase
            .from('mensajes')
            .insert({
                cliente_id: clienteId,
                autor_usuario_cliente_id: autorId,
                contenido,
            });
        if (error) throw error;
        ta.value = '';
        if (status) { status.textContent = ''; }
        await renderFeedMensajes();
        validarComposerMensaje();
    } catch (e) {
        console.error('[enviar-mensaje] error:', e);
        if (status) { status.textContent = 'No hemos podido enviar. Inténtalo de nuevo.'; status.classList.add('is-err'); }
        btn.disabled = false;
    }
}

function validarComposerMensaje() {
    const ta = document.getElementById('mensaje-textarea');
    const btn = document.getElementById('mensaje-enviar');
    if (!ta || !btn) return;
    const ok = ta.value.trim().length > 0;
    btn.disabled = !ok;
    btn.classList.toggle('is-ready', ok);
}

function bindComposerMensaje() {
    const ta = document.getElementById('mensaje-textarea');
    const btn = document.getElementById('mensaje-enviar');
    if (ta) {
        ta.addEventListener('input', () => {
            validarComposerMensaje();
            ta.style.height = 'auto';
            ta.style.height = Math.min(ta.scrollHeight, 96) + 'px';
        });
    }
    if (btn) btn.addEventListener('click', enviarMensaje);
}

// Aviso "tranquilidad baja": banner no bloqueante que invita a escribirle al
// adiestrador cuando el cliente puntúa tranquilidad <= 2 en un registro.
function mostrarAvisoTranquilidadBaja(nombrePerro, nombreEjercicio) {
    const banner = document.getElementById('aviso-trq-banner');
    if (!banner) return;
    _avisoTrqEjercicio = nombreEjercicio || '';
    const txt = document.getElementById('aviso-trq-texto');
    if (txt) {
        txt.textContent = `¿Le ha costado a ${nombrePerro}? Cuéntaselo a tu adiestrador y lo vemos juntos.`;
    }
    banner.removeAttribute('hidden');
    requestAnimationFrame(() => banner.classList.add('is-open'));
}

function cerrarAvisoTranquilidadBaja() {
    const banner = document.getElementById('aviso-trq-banner');
    if (!banner || banner.hasAttribute('hidden')) return;
    banner.classList.remove('is-open');
    setTimeout(() => banner.setAttribute('hidden', ''), 350);
}

function bindNotasEjercicio() {
    // Bloque B — reporte de entreno por ejercicio.
    document.getElementById('btn-reportar-entreno')
        ?.addEventListener('click', abrirModalReporte);
    document.getElementById('reporte-guardar')
        ?.addEventListener('click', guardarReporteEjercicio);
    document.getElementById('reporte-tarea-hecho')
        ?.addEventListener('click', marcarTareaHecha);

    // "Editar" de cada entreno de hoy (delegado: la lista se repinta por innerHTML).
    document.getElementById('mientreno-lista')?.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action="editar-entreno"]');
        if (!btn) return;
        const reg = (_misEntrenosCache || []).find((r) => String(r.id) === String(btn.dataset.regId));
        if (reg) abrirModalReporteEdicion(reg);
    });

    // Video del entreno (opcional): subir / cambiar / quitar + validación.
    document.getElementById('reporte-video-btn')
        ?.addEventListener('click', () => document.getElementById('reporte-video-input')?.click());
    document.getElementById('reporte-video-cambiar')
        ?.addEventListener('click', () => document.getElementById('reporte-video-input')?.click());
    document.getElementById('reporte-video-quitar')
        ?.addEventListener('click', quitarVideoSeleccionado);
    document.getElementById('reporte-video-input')
        ?.addEventListener('change', (e) => onVideoSeleccionado(e.target));

    // Video del entreno (opcional) — Grabar ahora (Parte 1B).
    document.getElementById('reporte-video-grabar')
        ?.addEventListener('click', iniciarGrabacion);
    document.getElementById('reporte-rec-stop')
        ?.addEventListener('click', detenerGrabacion);
    document.getElementById('reporte-rec-cancel')
        ?.addEventListener('click', cancelarGrabacion);
    aplicarSoporteGrabacion();

    // Aviso de tranquilidad baja: cerrar (X) y "Escribir al adiestrador".
    document.getElementById('aviso-trq-cerrar')
        ?.addEventListener('click', cerrarAvisoTranquilidadBaja);
    document.getElementById('aviso-trq-escribir')
        ?.addEventListener('click', () => {
            cerrarAvisoTranquilidadBaja();
            showTab('mensajes');
            const ta = document.getElementById('mensaje-textarea');
            if (!ta) return;
            // Precargamos solo si el composer está vacío, para no pisar un borrador.
            if (_avisoTrqEjercicio && ta.value.trim() === '') {
                ta.value = `Sobre ${_avisoTrqEjercicio}: `;
                validarComposerMensaje();
            }
            ta.focus();
            try { const n = ta.value.length; ta.setSelectionRange(n, n); } catch (_) {}
            // Aseguramos que el composer quede a la vista (la página puede haber
            // desbordado con el historial de mensajes).
            ta.scrollIntoView({ block: 'end', behavior: 'auto' });
        });

    // Pills de tranquilidad (1..5). Toque sobre el mismo número deselecciona.
    document.querySelectorAll('#reporte-tranquilidad .reporte-pill').forEach((btn) => {
        btn.addEventListener('click', () => {
            const valor = Number(btn.dataset.valor);
            _reporteTranquilidad = (_reporteTranquilidad === valor) ? null : valor;
            document.querySelectorAll('#reporte-tranquilidad .reporte-pill').forEach((p) => {
                const activa = Number(p.dataset.valor) === _reporteTranquilidad;
                p.classList.toggle('is-active', activa);
                p.setAttribute('aria-checked', activa ? 'true' : 'false');
            });
        });
    });

    // El control de marca (un solo input min:seg / pasos / reps) se lee
    // directo del DOM al guardar; no necesita listeners en vivo.
}

// Tipo de control de marca según los campos del ejercicio:
//   tiempo (tiempo_total/parcial) → min:seg · distancia → pasos · resto → reps.
function tipoReporteDeCampos(campos) {
    const cs = campos || [];
    if (cs.includes('tiempo_total') || cs.includes('tiempo_parcial')) return 'tiempo';
    if (cs.includes('distancia')) return 'distancia';
    return 'reps';
}

// Segundos → "M:SS" (para mostrar marca/objetivo de tiempo).
function fmtSegToMinSeg(seg) {
    const s = Math.max(0, Math.floor(Number(seg) || 0));
    const min = Math.floor(s / 60);
    const sec = s % 60;
    return `${min}:${String(sec).padStart(2, '0')}`;
}

// Pinta el control único de marca + las specs read-only del adiestrador.
// Reutiliza time-ctrl / num-ctrl ya estilados en el modal del cliente.
function renderReporteControl() {
    const cont = document.getElementById('reporte-control');
    if (!cont) return;
    const tipo = tipoReporteDeCampos(_reporteCampos);

    if (tipo === 'tiempo') {
        cont.innerHTML = `
            <label class="reporte-label">Tu mejor marca de este entreno</label>
            <div class="time-ctrl">
                <span class="seg"><input type="number" id="reporte-marca-min" inputmode="numeric" min="0" step="1" placeholder="0"><span class="u">min</span></span>
                <span class="colon">:</span>
                <span class="seg"><input type="number" id="reporte-marca-seg" inputmode="numeric" min="0" max="59" step="1" placeholder="00"><span class="u">seg</span></span>
            </div>`;
    } else if (tipo === 'distancia') {
        cont.innerHTML = `
            <label class="reporte-label">Tu mejor marca (pasos)</label>
            <div class="num-ctrl">
                <input type="number" id="reporte-marca" inputmode="numeric" min="0" step="1" placeholder="—">
                <span class="u">pasos</span>
            </div>`;
    } else {
        cont.innerHTML = `
            <label class="reporte-label">¿Cuántas repeticiones hiciste?</label>
            <div class="num-ctrl">
                <input type="number" id="reporte-marca" inputmode="numeric" min="0" step="1" placeholder="—">
                <span class="u">reps</span>
            </div>`;
    }

    // Specs del adiestrador, solo lectura. El objetivo se muestra según el
    // tipo; valor de comida y dificultad si están definidos.
    const specsEl = document.getElementById('reporte-specs');
    if (specsEl) {
        const s = _reporteSpecs || {};
        const chips = [];
        if (tipo === 'tiempo' && s.objetivoSeg != null) {
            chips.push(`Objetivo: ${fmtSegToMinSeg(s.objetivoSeg)}`);
        } else if (tipo === 'distancia' && s.objetivoDistancia != null) {
            const n = Number(s.objetivoDistancia);
            chips.push(`Objetivo: ${n} ${n === 1 ? 'paso' : 'pasos'}`);
        }
        if (s.valorComida != null) chips.push(`Valor de comida: ${Number(s.valorComida)}`);
        if (s.dificultad != null) chips.push(`Dificultad: ${Number(s.dificultad)}`);
        // Repeticiones sugeridas (guía del adiestrador). Rango si min≠max; un
        // solo número si solo hay min o min===max. Sin min → no se muestra.
        if (s.repsMin != null) {
            const rmin = Number(s.repsMin);
            const rmax = (s.repsMax != null) ? Number(s.repsMax) : null;
            const txt = (rmax != null && rmax !== rmin) ? `${rmin}-${rmax}` : `${rmin}`;
            chips.push(`Repeticiones sugeridas: ${txt}`);
        }
        if (chips.length > 0) {
            specsEl.innerHTML = chips
                .map((t) => `<span class="reporte-spec">${escapeHTML(t)}</span>`)
                .join('');
            specsEl.hidden = false;
        } else {
            specsEl.innerHTML = '';
            specsEl.hidden = true;
        }
    }
}

// ───────────────────────────────────────────────────────────
// Reporte de entreno por ejercicio (Bloque B)
// ───────────────────────────────────────────────────────────

function abrirModalReporte() {
    if (!_ejercicioModalActualId) {
        toast('Cerrá y reabrí la ficha del ejercicio', 'error');
        return;
    }
    _reporteCampos = _progresoCache.get(_ejercicioModalActualId)?.campos || [];

    // Reporte NUEVO: nunca en modo edición. Título/botón/video en modo "nuevo".
    _editandoRegistroId = null;
    const tituloModal = document.getElementById('modal-reporte-titulo');
    if (tituloModal) tituloModal.textContent = 'Reportar entreno';
    const guardarTxt = document.getElementById('reporte-guardar');
    if (guardarTxt) guardarTxt.textContent = 'Guardar';
    const videoField = document.getElementById('reporte-video-field');
    if (videoField) videoField.hidden = false;

    const nombreEl = document.getElementById('modal-reporte-ejercicio-nombre');
    const tituloOrigen = document.getElementById('modal-ejercicio-titulo');
    if (nombreEl && tituloOrigen) nombreEl.textContent = tituloOrigen.textContent;

    // Reset form
    const notaEl = document.getElementById('reporte-nota');
    if (notaEl) notaEl.value = '';
    const err = document.getElementById('reporte-error');
    if (err) { err.textContent = ''; err.hidden = true; }

    _reporteTranquilidad = null;
    document.querySelectorAll('#reporte-tranquilidad .reporte-pill').forEach((p) => {
        p.classList.remove('is-active');
        p.setAttribute('aria-checked', 'false');
    });

    // Specs del adiestrador para este ejercicio asignado (read-only) y
    // control de marca según el tipo. Las specs viven en la fila de la rutina.
    const _filaRutina = (state.rutinaFilas || []).find((f) => f.id === _ejercicioModalActualId);
    _reporteSpecs = _filaRutina ? {
        valorComida: _filaRutina.valor_comida ?? null,
        dificultad: _filaRutina.dificultad ?? null,
        objetivoSeg: _filaRutina.objetivo_seg ?? null,
        objetivoDistancia: _filaRutina.objetivo_distancia ?? null,
        repsMin: _filaRutina.reps_sugeridas_min ?? null,
        repsMax: _filaRutina.reps_sugeridas_max ?? null,
    } : null;
    renderReporteControl();

    // Reset del video del entreno (estado + preview + errores).
    quitarVideoSeleccionado();
    // Si quedó una grabación a medias (modal cerrado abrupto), liberar cámara.
    liberarRecursosGrabacion();
    document.getElementById('reporte-video-rec')?.setAttribute('hidden', '');

    // Ramificar según categoría: tareas/cambios usan botón "Hecho", no repeticiones.
    const _progActual = _progresoCache.get(_ejercicioModalActualId);
    const _esTareaOCambio = ['tarea', 'cambio_rutina'].includes(_progActual?.categoria);
    const _formEl = document.querySelector('#modal-reporte-ejercicio .reporte-form');
    const _tareaEl = document.getElementById('reporte-tarea');
    const _guardarBtn = document.getElementById('reporte-guardar');
    if (_esTareaOCambio) {
        if (_formEl) _formEl.hidden = true;
        if (_guardarBtn) _guardarBtn.hidden = true;
        if (_tareaEl) {
            _tareaEl.hidden = false;
            const hoy = Number(_progActual?.count_dia || 0);
            const hoyEl = document.getElementById('reporte-tarea-hoy');
            if (hoyEl) hoyEl.textContent = `Hoy: ${hoy} ${hoy === 1 ? 'vez' : 'veces'}`;
        }
        abrirModal('modal-reporte-ejercicio');
        return;
    }
    // Ejercicio normal: aseguramos que se vea el form y no la sección tarea.
    if (_formEl) _formEl.hidden = false;
    if (_guardarBtn) _guardarBtn.hidden = false;
    if (_tareaEl) _tareaEl.hidden = true;
    abrirModal('modal-reporte-ejercicio');
}

// Abre el modal en modo EDICIÓN de un entreno ya reportado (solo forma v:2).
// Corrige marca/reps + tranquilidad + nota. El video NO se edita acá.
function abrirModalReporteEdicion(reg) {
    if (!reg?.id || !_ejercicioModalActualId) return;
    _editandoRegistroId = reg.id;
    _reporteCampos = _progresoCache.get(_ejercicioModalActualId)?.campos || [];

    // Modo "editar": título + botón + ocultar el control de video.
    const tituloModal = document.getElementById('modal-reporte-titulo');
    if (tituloModal) tituloModal.textContent = 'Editar entreno';
    const guardarTxt = document.getElementById('reporte-guardar');
    if (guardarTxt) guardarTxt.textContent = 'Guardar cambios';
    const videoField = document.getElementById('reporte-video-field');
    if (videoField) videoField.hidden = true;

    const nombreEl = document.getElementById('modal-reporte-ejercicio-nombre');
    const tituloOrigen = document.getElementById('modal-ejercicio-titulo');
    if (nombreEl && tituloOrigen) nombreEl.textContent = tituloOrigen.textContent;

    const err = document.getElementById('reporte-error');
    if (err) { err.textContent = ''; err.hidden = true; }

    // Control de marca (mismo tipo que el ejercicio) + specs read-only.
    const _filaRutina = (state.rutinaFilas || []).find((f) => f.id === _ejercicioModalActualId);
    _reporteSpecs = _filaRutina ? {
        valorComida: _filaRutina.valor_comida ?? null,
        dificultad: _filaRutina.dificultad ?? null,
        objetivoSeg: _filaRutina.objetivo_seg ?? null,
        objetivoDistancia: _filaRutina.objetivo_distancia ?? null,
        repsMin: _filaRutina.reps_sugeridas_min ?? null,
        repsMax: _filaRutina.reps_sugeridas_max ?? null,
    } : null;
    renderReporteControl();

    // Prefill de la marca desde datos_registro (solo forma v:2).
    const datos = reg.datos_registro || {};
    const tipo = tipoReporteDeCampos(_reporteCampos);
    if (tipo === 'tiempo' && datos.mejor_seg != null) {
        const seg = Math.max(0, Math.floor(Number(datos.mejor_seg) || 0));
        const minEl = document.getElementById('reporte-marca-min');
        const segEl = document.getElementById('reporte-marca-seg');
        if (minEl) minEl.value = String(Math.floor(seg / 60));
        if (segEl) segEl.value = String(seg % 60);
    } else if (tipo === 'distancia' && datos.mejor_pasos != null) {
        const el = document.getElementById('reporte-marca');
        if (el) el.value = String(datos.mejor_pasos);
    } else if (tipo === 'reps' && datos.reps != null) {
        const el = document.getElementById('reporte-marca');
        if (el) el.value = String(datos.reps);
    }

    // Prefill de tranquilidad: activa la pill correspondiente.
    _reporteTranquilidad = (reg.tranquilidad != null) ? Number(reg.tranquilidad) : null;
    document.querySelectorAll('#reporte-tranquilidad .reporte-pill').forEach((p) => {
        const activa = Number(p.dataset.valor) === _reporteTranquilidad;
        p.classList.toggle('is-active', activa);
        p.setAttribute('aria-checked', activa ? 'true' : 'false');
    });

    // Prefill de la nota.
    const notaEl = document.getElementById('reporte-nota');
    if (notaEl) notaEl.value = reg.nota || '';

    // Aseguramos ver el form (no la sección tarea) y el botón de guardar.
    const _formEl = document.querySelector('#modal-reporte-ejercicio .reporte-form');
    const _tareaEl = document.getElementById('reporte-tarea');
    const _guardarBtn = document.getElementById('reporte-guardar');
    if (_formEl) _formEl.hidden = false;
    if (_tareaEl) _tareaEl.hidden = true;
    if (_guardarBtn) _guardarBtn.hidden = false;

    abrirModal('modal-reporte-ejercicio');
}

// Busca la práctica abierta de hoy (LOCAL del cliente) y la devuelve;
// si no existe, la crea. Sin cierre formal — solo necesitamos su id
// para agrupar registros.
async function obtenerOCrearPracticaHoy(perroId) {
    const ahora = new Date();
    const inicio = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate(), 0, 0, 0, 0);
    const today_start_iso = inicio.toISOString();

    const { data: existentes, error: errSel } = await supabase
        .from('practicas_rutina')
        .select('id')
        .eq('perro_id', perroId)
        .gte('iniciada_en', today_start_iso)
        .is('cerrada_en', null)
        .order('iniciada_en', { ascending: false })
        .limit(1);
    if (errSel) throw errSel;
    if (existentes && existentes.length > 0) return existentes[0].id;

    const { data: creada, error: errIns } = await supabase
        .from('practicas_rutina')
        .insert({
            perro_id: perroId,
            usuario_cliente_id: state.usuarioCliente?.id ?? null,
        })
        .select('id')
        .single();
    if (errIns) throw errIns;
    return creada.id;
}

// ───────────────────────────────────────────────────────────
// Video del entreno (opcional) — Paso 1A
// ───────────────────────────────────────────────────────────

// Lee la duración (en segundos) de un video local. Resuelve null si no se
// puede leer la metadata (validación blanda: el tamaño y el límite del bucket
// siguen protegiendo). Libera el objectURL al terminar.
function leerDuracionVideo(file) {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const v = document.createElement('video');
        v.preload = 'metadata';
        v.onloadedmetadata = () => {
            const d = v.duration;
            URL.revokeObjectURL(url);
            resolve(Number.isFinite(d) ? d : null);
        };
        v.onerror = () => {
            URL.revokeObjectURL(url);
            reject(new Error('No se pudo leer el video'));
        };
        v.src = url;
    });
}

function limpiarVideoPreviewUrl() {
    if (_reporteVideoPreviewUrl) {
        URL.revokeObjectURL(_reporteVideoPreviewUrl);
        _reporteVideoPreviewUrl = null;
    }
}

function setVideoSeleccionado(file) {
    limpiarVideoPreviewUrl();
    _reporteVideoFile = file;
    _reporteVideoPreviewUrl = URL.createObjectURL(file);
    const player = document.getElementById('reporte-video-player');
    const preview = document.getElementById('reporte-video-preview');
    const btn = document.getElementById('reporte-video-btn');
    const grabar = document.getElementById('reporte-video-grabar');
    const hint = document.getElementById('reporte-video-hint');
    if (player) player.src = _reporteVideoPreviewUrl;
    if (preview) preview.hidden = false;
    if (btn) btn.hidden = true;
    if (grabar) grabar.hidden = true;
    if (hint) hint.hidden = true;
}

function quitarVideoSeleccionado() {
    limpiarVideoPreviewUrl();
    _reporteVideoFile = null;
    const player = document.getElementById('reporte-video-player');
    const preview = document.getElementById('reporte-video-preview');
    const btn = document.getElementById('reporte-video-btn');
    const grabar = document.getElementById('reporte-video-grabar');
    const hint = document.getElementById('reporte-video-hint');
    const errEl = document.getElementById('reporte-video-error');
    if (player) player.removeAttribute('src');
    if (preview) preview.hidden = true;
    if (btn) btn.hidden = false;
    if (grabar) grabar.hidden = false;
    if (hint) hint.hidden = false;
    if (errEl) { errEl.textContent = ''; errEl.hidden = true; }
    // Respetar el fallback: si no hay soporte de grabación, ocultar de nuevo.
    aplicarSoporteGrabacion();
}

// Valida un File de video (tipo blando, tamaño, duración) y, si pasa,
// lo deja seleccionado con preview. Reusable: la usa tanto el flujo de
// "Subir video" (onVideoSeleccionado) como "Grabar ahora" (Parte 1B).
async function procesarVideoFile(file) {
    const errEl = document.getElementById('reporte-video-error');
    const showVErr = (m) => { if (errEl) { errEl.textContent = m; errEl.hidden = false; } };
    if (errEl) { errEl.textContent = ''; errEl.hidden = true; }

    if (!file) return;

    // Tipo (chequeo blando).
    if (!file.type || !file.type.startsWith('video/')) {
        showVErr('Ese archivo no parece un video. Usa MP4, MOV o WEBM.');
        return;
    }
    // Tamaño.
    if (file.size > VIDEO_MAX_BYTES) {
        showVErr('El video supera los 25 MB. Graba o elige un clip más corto.');
        return;
    }
    // Duración (blanda).
    let dur = null;
    try {
        dur = await leerDuracionVideo(file);
    } catch (_) {
        dur = null; // metadata ilegible → dejamos pasar (validación blanda)
    }
    if (dur != null && dur > VIDEO_MAX_SEG) {
        showVErr('El video dura más de 1 minuto. Elige un clip más corto.');
        return;
    }

    setVideoSeleccionado(file);
}

// Valida un archivo elegido por el cliente (tamaño, duración, tipo) y, si pasa,
// lo deja seleccionado con preview. No sube nada todavía.
async function onVideoSeleccionado(input) {
    const file = input.files && input.files[0];
    // Permitir volver a elegir el mismo archivo más adelante (reset del input).
    input.value = '';
    if (!file) return;
    await procesarVideoFile(file);
}

// ── Grabar ahora (Parte 1B) ─────────────────────────────────────────────

// Libera la cámara, el recorder y el timer si quedó una grabación a medias.
// Idempotente: se puede llamar siempre sin riesgo.
function liberarRecursosGrabacion() {
    if (_grabTimer) { clearInterval(_grabTimer); _grabTimer = null; }
    if (_grabRecorder && _grabRecorder.state !== 'inactive') {
        try { _grabRecorder.onstop = null; _grabRecorder.stop(); } catch (_) {}
    }
    _grabRecorder = null;
    _grabChunks = [];
    if (_grabStream) {
        _grabStream.getTracks().forEach((t) => { try { t.stop(); } catch (_) {} });
        _grabStream = null;
    }
    const live = document.getElementById('reporte-rec-live');
    if (live) { live.srcObject = null; }
}

function actualizarTimerUI(seg) {
    const el = document.getElementById('reporte-rec-timer');
    if (!el) return;
    const s = Math.max(0, Math.floor(seg));
    const mm = Math.floor(s / 60);
    const ss = String(s % 60).padStart(2, '0');
    el.textContent = `${mm}:${ss}`;
}

async function iniciarGrabacion() {
    // Defensivo: si llegó acá sin soporte (no debería, el fallback oculta el botón).
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
        return;
    }

    // Pedir cámara trasera + audio.
    try {
        _grabStream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: 'environment' },
            audio: true,
        });
    } catch (err) {
        const errEl = document.getElementById('reporte-video-error');
        if (errEl) {
            errEl.textContent = 'No se pudo acceder a la cámara. Puedes subir un video en su lugar.';
            errEl.hidden = false;
        }
        return;
    }

    // Conectar al preview-en-vivo.
    const live = document.getElementById('reporte-rec-live');
    if (live) { live.srcObject = _grabStream; await live.play().catch(() => {}); }

    // Toggle UI: entrar a estado "grabando".
    document.getElementById('reporte-video-btn')?.setAttribute('hidden', '');
    document.getElementById('reporte-video-grabar')?.setAttribute('hidden', '');
    document.getElementById('reporte-video-hint')?.setAttribute('hidden', '');
    const errEl = document.getElementById('reporte-video-error');
    if (errEl) { errEl.textContent = ''; errEl.hidden = true; }
    document.getElementById('reporte-video-rec')?.removeAttribute('hidden');

    // Elegir mimeType (primero soportado).
    const candidatos = ['video/mp4', 'video/webm;codecs=vp8', 'video/webm'];
    _grabMimeType = candidatos.find((m) => MediaRecorder.isTypeSupported(m)) || '';

    // Instanciar MediaRecorder.
    _grabRecorder = _grabMimeType
        ? new MediaRecorder(_grabStream, { mimeType: _grabMimeType })
        : new MediaRecorder(_grabStream);
    _grabChunks = [];
    _grabRecorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) _grabChunks.push(e.data); };
    _grabRecorder.onstop = onGrabacionDetenida;
    _grabRecorder.start();

    // Countdown visible (60 → 0), corte automático a los 60s.
    _grabSegundosRest = 60;
    actualizarTimerUI(_grabSegundosRest);
    _grabTimer = setInterval(() => {
        _grabSegundosRest -= 1;
        actualizarTimerUI(_grabSegundosRest);
        if (_grabSegundosRest <= 0) {
            clearInterval(_grabTimer);
            _grabTimer = null;
            try { _grabRecorder?.stop(); } catch (_) {}
        }
    }, 1000);
}

async function onGrabacionDetenida() {
    // Limpiar timer.
    if (_grabTimer) { clearInterval(_grabTimer); _grabTimer = null; }

    // Liberar cámara (pero conservamos chunks/recorder hasta armar el File).
    if (_grabStream) {
        _grabStream.getTracks().forEach((t) => { try { t.stop(); } catch (_) {} });
        _grabStream = null;
    }
    const live = document.getElementById('reporte-rec-live');
    if (live) { live.srcObject = null; }

    // Ocultar UI de grabación; procesarVideoFile mostrará el preview después.
    document.getElementById('reporte-video-rec')?.setAttribute('hidden', '');

    // Normalizar MIME real a uno de los 3 que acepta subirVideoEntreno.
    // El mimeType del recorder puede traer codecs (ej. 'video/webm;codecs=vp8').
    const realMime = (_grabRecorder?.mimeType || _grabMimeType || '').toLowerCase();
    let typeNormalizado, ext;
    if (realMime.startsWith('video/mp4')) {
        typeNormalizado = 'video/mp4'; ext = 'mp4';
    } else if (realMime.startsWith('video/webm')) {
        typeNormalizado = 'video/webm'; ext = 'webm';
    } else {
        // Caso raro: no se reconoce. Dejamos al fallback de procesarVideoFile.
        typeNormalizado = realMime || 'video/webm';
        ext = 'webm';
    }
    const blob = new Blob(_grabChunks, { type: typeNormalizado });
    const file = new File([blob], `grabacion.${ext}`, { type: typeNormalizado });
    _grabChunks = [];
    _grabRecorder = null;

    // Pasar al flujo de 1A (valida tamaño/duración/tipo y, si pasa, preview).
    await procesarVideoFile(file);
}

function detenerGrabacion() {
    if (_grabTimer) { clearInterval(_grabTimer); _grabTimer = null; }
    try { _grabRecorder?.stop(); } catch (_) {}
    // onGrabacionDetenida se encarga del resto.
}

function cancelarGrabacion() {
    liberarRecursosGrabacion();
    // Volver al estado inicial: ocultar rec, mostrar btn+grabar+hint, sin error.
    document.getElementById('reporte-video-rec')?.setAttribute('hidden', '');
    document.getElementById('reporte-video-btn')?.removeAttribute('hidden');
    document.getElementById('reporte-video-grabar')?.removeAttribute('hidden');
    document.getElementById('reporte-video-hint')?.removeAttribute('hidden');
    const errEl = document.getElementById('reporte-video-error');
    if (errEl) { errEl.textContent = ''; errEl.hidden = true; }
}

// Si el dispositivo no soporta grabación, esconder "Grabar ahora".
function aplicarSoporteGrabacion() {
    const btn = document.getElementById('reporte-video-grabar');
    if (!btn) return;
    const soportado = !!(navigator.mediaDevices?.getUserMedia) && typeof MediaRecorder !== 'undefined';
    if (!soportado) {
        btn.hidden = true;
    }
}

// Sube el video al bucket privado entrenos-videos en {cliente_id}/{uuid}.{ext}
// y devuelve el path. Lanza si el tipo no es soportado, falta cuenta o falla
// la subida. (Bucket privado: NO se usa getPublicUrl.)
async function subirVideoEntreno(file) {
    const extPorMime = { 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm' };
    const ext = extPorMime[file.type];
    if (!ext) throw new Error('Tipo de video no soportado. Usa MP4, MOV o WEBM.');
    const cliente_id = state.usuarioCliente?.cliente_id;
    if (!cliente_id) throw new Error('No pude identificar tu cuenta. Recarga la app.');
    const path = `${cliente_id}/${crypto.randomUUID()}.${ext}`;
    const { error: upErr } = await supabase.storage
        .from('entrenos-videos')
        .upload(path, file, { contentType: file.type, upsert: false });
    if (upErr) throw upErr;
    return path;
}

async function guardarReporteEjercicio() {
    const errBox = document.getElementById('reporte-error');
    const showErr = (msg) => {
        if (errBox) { errBox.textContent = msg; errBox.hidden = false; }
    };
    if (errBox) { errBox.textContent = ''; errBox.hidden = true; }

    const nota = document.getElementById('reporte-nota').value.trim() || null;
    const trq = _reporteTranquilidad;

    // Marca única según el tipo de ejercicio. Forma NUEVA de datos_registro:
    // { v: 2, ... } con UNA sola clave de marca (mejor_seg / mejor_pasos / reps).
    const tipo = tipoReporteDeCampos(_reporteCampos);
    const datos_registro = { v: 2 };
    let tieneValor = false;
    if (tipo === 'tiempo') {
        const minRaw = (document.getElementById('reporte-marca-min')?.value || '').trim();
        const segRaw = (document.getElementById('reporte-marca-seg')?.value || '').trim();
        if (minRaw !== '' || segRaw !== '') {
            const m = minRaw === '' ? 0 : Number(minRaw);
            const s = segRaw === '' ? 0 : Number(segRaw);
            if (!Number.isInteger(m) || m < 0 || !Number.isInteger(s) || s < 0 || s > 59) {
                showErr('Revisá tu marca (enteros, segundos hasta 59).'); return;
            }
            const total = m * 60 + s;
            if (total > 0) { datos_registro.mejor_seg = total; tieneValor = true; }
        }
    } else if (tipo === 'distancia') {
        const raw = (document.getElementById('reporte-marca')?.value || '').trim();
        if (raw !== '') {
            const n = Number(raw);
            if (!Number.isInteger(n) || n < 0) { showErr('Revisá tu marca (entero ≥ 0).'); return; }
            if (n > 0) { datos_registro.mejor_pasos = n; tieneValor = true; }
        }
    } else {
        const raw = (document.getElementById('reporte-marca')?.value || '').trim();
        if (raw !== '') {
            const n = Number(raw);
            if (!Number.isInteger(n) || n < 0) { showErr('Revisá las repeticiones (entero ≥ 0).'); return; }
            if (n > 0) { datos_registro.reps = n; tieneValor = true; }
        }
    }

    const tieneTrq = trq != null;
    if (!tieneValor && !tieneTrq) {
        showErr('Cargá tu marca o el estado emocional para reportar.');
        return;
    }

    const perroId = state.perroSeleccionadoId;
    if (!perroId) {
        showErr('No hay perro seleccionado.');
        return;
    }

    const btn = document.getElementById('reporte-guardar');
    if (btn) btn.disabled = true;
    const asignadoId = _ejercicioModalActualId;
    const esEdicion = (_editandoRegistroId != null);

    // Video del entreno (opcional). Solo en reporte NUEVO: al editar no se toca
    // el video. Se sube ANTES del insert para persistir el path; si la subida
    // falla, NO bloquea el guardado.
    let videoPath = null;
    if (!esEdicion && _reporteVideoFile) {
        try {
            videoPath = await subirVideoEntreno(_reporteVideoFile);
        } catch (e) {
            console.error('[reporte] error subiendo video:', e);
            // No bloquear: el video es opcional. Aceptar = guardar sin video;
            // Cancelar = volver (el cliente puede reintentar el guardado).
            const guardarSinVideo = window.confirm(
                'No pudimos subir el video. ¿Querés guardar el entreno sin el video? '
                + '(Cancelá para volver e intentar de nuevo.)');
            if (!guardarSinVideo) { if (btn) btn.disabled = false; return; }
            videoPath = null;
        }
    }

    try {
        if (esEdicion) {
            // EDICIÓN: UPDATE de marca + tranquilidad + nota. NO tocamos
            // practica_id ni video_path.
            const { error } = await supabase
                .from('registros_ejercicio')
                .update({ datos_registro, tranquilidad: trq, nota })
                .eq('id', _editandoRegistroId);
            if (error) throw error;
            _editandoRegistroId = null;
        } else {
            // Reporte NUEVO: un INSERT independiente del día.
            const practica_id = await obtenerOCrearPracticaHoy(perroId);
            const insertPayload = {
                practica_id,
                ejercicio_asignado_id: asignadoId,
                datos_registro,
                tranquilidad: trq,
                nota,
            };
            if (videoPath) {
                insertPayload.video_path = videoPath;
                insertPayload.video_subido_en = new Date().toISOString();
            }
            const { error } = await supabase
                .from('registros_ejercicio')
                .insert(insertPayload);
            if (error) throw error;
        }

        // Comparación de estados para detectar el "pulso de logro": pasamos
        // de 'debajo' (no llegabamos al mínimo) a 'en_zona' (justo cumplido).
        const estadoAntes = evaluarProgresoEjercicio(_progresoCache.get(asignadoId));
        try {
            await cargarProgresoPerro(perroId);
        } catch (e) {
            // No bloquea el flujo: solo dejamos sin refrescar.
            console.error('[reporte] no se pudo refrescar progreso:', e);
        }
        const estadoDespues = evaluarProgresoEjercicio(_progresoCache.get(asignadoId));
        const justoCumplido = (estadoAntes.estado === 'debajo'
                              && estadoDespues.estado === 'en_zona');
        // Cartel informativo si con este registro el cliente superó el tope
        // diario del ejercicio. NO bloquea el guardado, sólo avisa.
        const superoTopeDiario = estadoDespues.superoTopeDiario;

        // Refrescar la lista "Mis entrenos" del modal de detalle que
        // queda debajo, así el cliente ve el registro nuevo al cerrar.
        try {
            await cargarMisEntrenos(asignadoId);
        } catch (e) {
            console.error('[reporte] no se pudo refrescar mis entrenos:', e);
        }

        // Si el cliente está en "Mi progreso", refrescar la racha + lista
        // ahora (la rutina no se ve, pero la vista debajo sí).
        if (state.rutinaModo === 'progreso') {
            cargarVistaProgreso();
        }

        // Tranquilidad del registro recién guardado.
        const trqGuardada = trq;
        // Capturamos nombres antes de cerrar el modal para el aviso posterior.
        const nombrePerroAviso = state.perros.find((p) => p.id === perroId)?.nombre || 'tu perro';
        const nombreEjAviso = document.getElementById('modal-reporte-ejercicio-nombre')
            ?.textContent?.trim() || '';

        cerrarModal('modal-reporte-ejercicio');
        if (superoTopeDiario) {
            // Cartel informativo, sin tono reprochador. 5s para que se lea.
            toast('Ya superaste el máximo diario de este ejercicio.', 'info', 5000);
        } else {
            toast(esEdicion ? 'Cambios guardados' : 'Entreno registrado');
        }

        // Si el perro lo pasó mal (tranquilidad <= 2), ofrecemos contárselo
        // al adiestrador. Banner no bloqueante, una vez por registro.
        if (trqGuardada != null && trqGuardada <= 2) {
            mostrarAvisoTranquilidadBaja(nombrePerroAviso, nombreEjAviso);
        }

        // Re-render de la rutina (chips + anillo) y, si corresponde, pulso.
        await renderRutinaPerroSeleccionado();
        if (justoCumplido) marcarPulsoLogro(asignadoId);
    } catch (e) {
        console.error('[reporte] error:', e);
        const msg = 'No pudimos guardar el reporte. Inténtalo de nuevo.';
        toast(msg, 'error');
        showErr(msg);
    } finally {
        if (btn) btn.disabled = false;
    }
}

async function marcarTareaHecha() {
    const asignadoId = _ejercicioModalActualId;
    const perroId = state.perroSeleccionadoId;
    if (!asignadoId || !perroId) return;
    const btn = document.getElementById('reporte-tarea-hecho');
    if (btn) btn.disabled = true;
    try {
        const practica_id = await obtenerOCrearPracticaHoy(perroId);
        const { error } = await supabase
            .from('registros_ejercicio')
            .insert({
                practica_id,
                ejercicio_asignado_id: asignadoId,
                datos_registro: {},
                tranquilidad: null,
                nota: null,
            });
        if (error) throw error;
        await cargarProgresoPerro(perroId);
        const prog = _progresoCache.get(asignadoId);
        const hoy = Number(prog?.count_dia || 0);
        const hoyEl = document.getElementById('reporte-tarea-hoy');
        if (hoyEl) hoyEl.textContent = `Hoy: ${hoy} ${hoy === 1 ? 'vez' : 'veces'}`;
        try { await cargarMisEntrenos(asignadoId); } catch (e) {}
        if (state.rutinaModo === 'progreso') cargarVistaProgreso();
        await renderRutinaPerroSeleccionado();
        const estado = evaluarProgresoEjercicio(prog);
        if (estado && estado.superoTopeDiario) {
            toast('Ya superaste el máximo diario de esta tarea.', 'info', 4000);
        } else {
            toast('¡Hecho!');
        }
    } catch (e) {
        console.error('[tarea-hecha] error:', e);
        toast('No pudimos guardarlo. Probá de nuevo.', 'error');
    } finally {
        if (btn) btn.disabled = false;
    }
}

// ───────────────────────────────────────────────────────────
// "Mis entrenos" dentro del modal de detalle del ejercicio
// ───────────────────────────────────────────────────────────

function fmtFechaCliente(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
    const ayer = new Date(hoy); ayer.setDate(ayer.getDate() - 1);
    const dDia = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    if (dDia.getTime() === hoy.getTime()) return 'Hoy';
    if (dDia.getTime() === ayer.getTime()) return 'Ayer';
    const str = d.toLocaleDateString('es-ES', { weekday: 'short', day: 'numeric', month: 'short' });
    // "sáb. 23 may." → "Sáb 23 may"
    return str.replace(/\./g, '').replace(/^\w/, (c) => c.toUpperCase());
}

// ¿El registro es de HOY? Comparación por día LOCAL (mismo criterio que
// fmtFechaCliente / obtenerOCrearPracticaHoy). NO usar toISOString: en Madrid
// (UTC+2) eso correría el día y rompería el gate de edición.
function esDeHoyLocal(iso) {
    if (!iso) return false;
    const d = new Date(iso);
    const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
    const dDia = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    return dDia.getTime() === hoy.getTime();
}

function fmtHoraCliente(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function fmtRepesCliente(datos) {
    if (!datos) return '';
    // Forma NUEVA (v:2): una sola marca por entreno.
    if (datos.v === 2) {
        if (datos.reps != null) {
            const n = Number(datos.reps);
            return `${n} ${n === 1 ? 'repetición' : 'repeticiones'}`;
        }
        if (datos.mejor_seg != null) return `Mejor marca: ${fmtSegToMinSeg(datos.mejor_seg)}`;
        if (datos.mejor_pasos != null) {
            const n = Number(datos.mejor_pasos);
            return `Mejor marca: ${n} ${n === 1 ? 'paso' : 'pasos'}`;
        }
        return '';
    }
    // Forma VIEJA (historial de 104 reportes): lista de repeticiones. No tocar.
    if (!Array.isArray(datos.repeticiones) || datos.repeticiones.length === 0) return '';
    const n = datos.repeticiones.length;
    const totalSeg = Number(datos.tiempo_total_seg) || 0;
    const palabra = n === 1 ? 'rep' : 'reps';
    if (totalSeg === 0) return `${n} ${palabra} · sin duración`;
    const min = Math.floor(totalSeg / 60);
    const sec = totalSeg % 60;
    const dur = sec === 0 ? `${min} min` : `${min} min ${sec}s`;
    return `${n} ${palabra} · ${dur}`;
}

async function cargarMisEntrenos(asignadoId) {
    const cont = document.getElementById('mientreno');
    const loading = document.getElementById('mientreno-loading');
    const empty = document.getElementById('mientreno-empty');
    const lista = document.getElementById('mientreno-lista');
    if (!cont || !loading || !empty || !lista) return;

    if (!asignadoId) {
        cont.hidden = true;
        loading.hidden = true;
        empty.hidden = true;
        lista.hidden = true;
        return;
    }

    cont.hidden = false;
    loading.hidden = false;
    empty.hidden = true;
    lista.hidden = true;
    lista.innerHTML = '';

    try {
        const { data, error } = await supabase
            .from('registros_ejercicio')
            .select('id, registrado_en, datos_registro, tranquilidad, nota, visto_por_admin, comentario_admin, visto_en')
            .eq('ejercicio_asignado_id', asignadoId)
            .order('registrado_en', { ascending: false })
            .limit(10);
        if (error) throw error;

        loading.hidden = true;
        if (!data || data.length === 0) {
            empty.hidden = false;
            lista.hidden = true;
            return;
        }
        _misEntrenosCache = data;
        lista.innerHTML = data.map(renderMiEntrenoItem).join('');
        lista.hidden = false;
        empty.hidden = true;
    } catch (e) {
        console.error('[mientreno] error cargando:', e);
        // Defensivo: ocultar la sección entera para no dejar UI rota.
        cont.hidden = true;
    }
}

function renderMiEntrenoItem(reg) {
    const fecha = fmtFechaCliente(reg.registrado_en);
    const hora = fmtHoraCliente(reg.registrado_en);
    const repesTexto = fmtRepesCliente(reg.datos_registro);
    const tq = (reg.tranquilidad != null) ? Number(reg.tranquilidad) : null;

    const tqChip = (tq != null)
        ? `<span class="mientreno-tq mientreno-tq--${tq}">Tq ${tq}</span>`
        : '';
    const datos = repesTexto
        ? `<p class="mientreno-item__datos">${escapeHTML(repesTexto)}</p>`
        : '';
    const nota = reg.nota
        ? `<p class="mientreno-item__nota">${escapeHTML(reg.nota)}</p>`
        : '';
    // Visto + comentario del adiestrador (solo cuando ya lo revisó).
    const visto = reg.visto_por_admin
        ? '<p class="mientreno-item__visto">✓ Visto por tu adiestrador</p>'
        : '';
    const comentario = (reg.visto_por_admin && reg.comentario_admin)
        ? `<div class="mientreno-item__comentario"><span class="mientreno-item__comentario-label">Tu adiestrador:</span> ${escapeHTML(reg.comentario_admin)}</div>`
        : '';

    // Editar: solo entrenos de HOY y con la forma nueva (v:2). Los días
    // anteriores y los registros viejos (v !== 2) quedan fijos.
    const editable = esDeHoyLocal(reg.registrado_en) && reg.datos_registro?.v === 2;
    const editarBtn = editable
        ? `<button type="button" class="mientreno-item__editar" data-action="editar-entreno" data-reg-id="${escapeHTML(reg.id)}">Editar</button>`
        : '';

    return `
        <li class="mientreno-item">
            <div class="mientreno-item__cab">
                <span class="mientreno-item__fecha">${escapeHTML(fecha)}</span>
                <span class="mientreno-item__hora">${escapeHTML(hora)}</span>
                ${tqChip}
                ${editarBtn}
            </div>
            ${datos}
            ${nota}
            ${visto}
            ${comentario}
        </li>
    `;
}


// ============================================================
// SEGUIMIENTO DE CONDUCTAS — calendario-semáforo (cliente)
// Portado del handoff de Design (React) a vanilla. Vive en el overlay
// #seguimiento-screen (dentro de #screen-app.home → hereda tokens de tema).
// 3 vistas: lista de seguimientos → calendario de una conducta → hoja
// "marcar un día". Persiste en seguimientos_conducta / registros_conducta.
// Texto de cliente en español de España (tú/puedes).
// ============================================================

const SEG_MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
const SEG_MESES_C = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const SEG_DOW_S = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
const SEG_DOW_L = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

// Forma de las celdas con varias marcas. El cliente eligió "horizontales"
// como default (ver handoff); se deja como constante de configuración, no
// por usuario. Valores: 'horizontales' | 'verticales' | 'diagonales'.
const SEG_CELL_SHAPE = 'horizontales';

// Color en DB ('verde'|'amarillo'|'rojo') <-> clave corta de UI ('v'|'a'|'r').
const SEG_COLOR_KEY = { verde: 'v', amarillo: 'a', rojo: 'r' };
const SEG_COLOR_DB = { v: 'verde', a: 'amarillo', r: 'rojo' };
const SEG_SEM = {
    v: { lb: 'Bien', icon: 'check' },
    a: { lb: 'Regular', icon: 'dots' },
    r: { lb: 'Mal', icon: 'x' },
};
const SEG_VAR = { v: 'var(--sem-verde)', a: 'var(--sem-amarillo)', r: 'var(--sem-rojo)' };

const SEG_ICON = {
    left: 'M15 18l-6-6 6-6',
    right: 'M9 18l6-6-6-6',
    chev: 'M9 18l6-6-6-6',
    plus: 'M12 5v14M5 12h14',
    check: 'M20 6L9 17l-5-5',
    x: 'M18 6L6 18M6 6l12 12',
    dots: 'M5 12h.01M12 12h.01M19 12h.01',
    note: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z',
    trash: 'M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6',
    trend: 'M3 17l6-6 4 4 7-7M14 8h6v6',
};
function segIcon(n) {
    const d = SEG_ICON[n] || '';
    const paths = d.split('M').filter(Boolean).map((seg) => `<path d="M${seg}"/>`).join('');
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}

const segState = {
    perro: null,
    vista: 'lista',        // 'lista' | 'cal'
    seguimientos: [],      // [{ id, nombre, descripcion, creado_por_admin, creado_en }]
    countsMes: {},         // { seguimientoId: {v,a,r} } — mes actual, para la lista
    activo: null,          // seguimiento abierto en el calendario
    year: 0,
    month: 0,              // 0-11
    dias: {},              // { diaNum: [ { id, key, nota, orden }, ... ] } del mes activo
    sheetDia: null,        // día abierto en la hoja
    noteEditId: null,      // id de marca con la nota en edición
    newFormOpen: false,
};

// ---------- helpers de fecha ----------
function segHoy() { const n = new Date(); return { y: n.getFullYear(), m: n.getMonth(), d: n.getDate() }; }
function segPad(n) { return n < 10 ? '0' + n : '' + n; }
function segIso(y, m, d) { return `${y}-${segPad(m + 1)}-${segPad(d)}`; }
function segUltimoDia(y, m) { return new Date(y, m + 1, 0).getDate(); }
function segMonthGrid(y, m) {
    const first = new Date(y, m, 1);
    const lead = (first.getDay() + 6) % 7;   // semana empieza en lunes
    const days = segUltimoDia(y, m);
    const cells = [];
    for (let i = 0; i < lead; i++) cells.push(null);
    for (let d = 1; d <= days; d++) cells.push(d);
    while (cells.length % 7 !== 0) cells.push(null);
    return cells;
}
function segIsFuture(y, m, d) {
    const t = segHoy();
    if (y !== t.y) return y > t.y;
    if (m !== t.m) return m > t.m;
    return d > t.d;
}
function segCanNext() { const t = segHoy(); return !(segState.year === t.y && segState.month >= t.m); }
function segFechaCorta(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    return `${d.getDate()} ${SEG_MESES_C[d.getMonth()]}`;
}

// ---------- pintado de celdas según N marcas ----------
function segCellStyle(marks) {
    if (!marks || !marks.length) return '';
    if (marks.length === 1) return `background:${SEG_VAR[marks[0].key]};`;
    const angle = SEG_CELL_SHAPE === 'horizontales' ? '180deg' : SEG_CELL_SHAPE === 'diagonales' ? '135deg' : '90deg';
    const n = marks.length;
    const stops = marks.map((mk, i) => {
        const a = (i / n * 100).toFixed(2), b = ((i + 1) / n * 100).toFixed(2);
        return `${SEG_VAR[mk.key]} ${a}% ${b}%`;
    }).join(', ');
    return `background:linear-gradient(${angle}, ${stops});`;
}

// ---------- frases (historia / progreso) ----------
function segStory(c) {
    const tot = c.v + c.a + c.r;
    if (!tot) return { pip: 'var(--c-text-3)', text: 'Sin registros aún' };
    if (c.v >= c.a + c.r) return { pip: 'var(--sem-verde)', text: 'Mayoría en verde' };
    if (c.r > c.v + c.a) return { pip: 'var(--sem-rojo)', text: 'Semana a semana' };
    return { pip: 'var(--sem-amarillo)', text: 'Mejorando poco a poco' };
}
function segProgressNote(c) {
    const tot = c.v + c.a + c.r;
    if (!tot) return ['Todavía no has registrado días este mes. ', '', 'Cuando toques un día, empezarás a ver el color del mes.'];
    const pv = c.v / tot;
    if (pv >= 0.5) return ['Este mes ', 'vas mejorando', '. La mayoría de los días salieron bien — sigue por ahí.'];
    if (pv >= 0.3) return ['Hay ', 'avances', '. Cada vez más días en verde; los difíciles también son parte del proceso.'];
    return ['Está costando, y ', 'está bien', '. Lo importante es registrar — el camino se construye poco a poco.'];
}
function segCountMes() {
    const c = { v: 0, a: 0, r: 0 };
    Object.values(segState.dias).forEach((arr) => arr.forEach((mk) => { if (c[mk.key] != null) c[mk.key]++; }));
    return c;
}

// ---------- chrome (eyebrow + título) y cambio de vista ----------
function segActualizarChrome() {
    const eyebrow = document.getElementById('seg-eyebrow');
    const title = document.getElementById('seg-title');
    const p = segState.perro;
    const nombre = p?.nombre || 'Tu perro';
    if (segState.vista === 'cal' && segState.activo) {
        eyebrow.textContent = nombre;
        title.textContent = segState.activo.nombre || 'Conducta';
    } else {
        eyebrow.textContent = [nombre, p?.raza].filter(Boolean).join(' · ');
        title.textContent = 'Seguimientos';
    }
}
function segMostrarVista(v) {
    segState.vista = v;
    document.getElementById('seg-vista-lista').toggleAttribute('hidden', v !== 'lista');
    document.getElementById('seg-vista-cal').toggleAttribute('hidden', v !== 'cal');
    const sc = document.querySelector('#seguimiento-screen .seg-scroll');
    if (sc) sc.scrollTop = 0;
    segActualizarChrome();
}

// ---------- abrir / cerrar el overlay ----------
function abrirSeguimiento() {
    const perro = state.perros.find((p) => p.id === state.perroSeleccionadoId);
    if (!perro) return;
    segState.perro = perro;
    segState.vista = 'lista';
    segState.activo = null;
    segState.newFormOpen = false;
    segCerrarSheet();
    segMostrarVista('lista');
    abrirModal('seguimiento-screen');
    cargarListaSeguimientos();
}

// ---------- pantalla 1: lista de seguimientos ----------
async function cargarListaSeguimientos() {
    const cont = document.getElementById('seg-vista-lista');
    const nombre = escapeHTML(segState.perro?.nombre || 'tu perro');
    cont.innerHTML = `<p class="lead">Registra cómo evoluciona cada conducta de ${nombre}, día a día. Toca un seguimiento para ver su mes.</p><p class="seg-loading">Cargando…</p>`;
    try {
        const { data: segs, error } = await supabase
            .from('seguimientos_conducta')
            .select('id, nombre, descripcion, creado_por_admin, creado_en')
            .eq('perro_id', segState.perro.id)
            .eq('activo', true)
            .order('creado_en', { ascending: true });
        if (error) throw error;
        segState.seguimientos = segs || [];

        // Conteos del mes actual para la mini-barra de cada tarjeta.
        segState.countsMes = {};
        const ids = segState.seguimientos.map((s) => s.id);
        if (ids.length) {
            const t = segHoy();
            const desde = segIso(t.y, t.m, 1);
            const hasta = segIso(t.y, t.m, segUltimoDia(t.y, t.m));
            const { data: regs, error: e2 } = await supabase
                .from('registros_conducta')
                .select('seguimiento_id, color')
                .in('seguimiento_id', ids)
                .gte('fecha', desde)
                .lte('fecha', hasta);
            if (e2) throw e2;
            (regs || []).forEach((r) => {
                const k = SEG_COLOR_KEY[r.color];
                if (!k) return;
                const c = segState.countsMes[r.seguimiento_id] || (segState.countsMes[r.seguimiento_id] = { v: 0, a: 0, r: 0 });
                c[k]++;
            });
        }
        renderSegLista();
    } catch (err) {
        console.error('[seguimiento] cargar lista', err);
        cont.innerHTML = '<p class="lead">No se ha podido cargar el seguimiento. Inténtalo de nuevo.</p>';
    }
}
function renderSegLista() {
    const cont = document.getElementById('seg-vista-lista');
    const nombre = escapeHTML(segState.perro?.nombre || 'tu perro');
    const intro = `<p class="lead">Registra cómo evoluciona cada conducta de ${nombre}, día a día. Toca un seguimiento para ver su mes.</p>`;
    const cards = segState.seguimientos.map((s) => {
        const c = segState.countsMes[s.id] || { v: 0, a: 0, r: 0 };
        const tot = c.v + c.a + c.r;
        const w = (v) => (tot ? (v / tot * 100) : 0);
        const st = segStory(c);
        const meta = (s.descripcion && s.descripcion.trim())
            ? escapeHTML(s.descripcion.trim())
            : `Desde ${segFechaCorta(s.creado_en)}`;
        return `
            <button type="button" class="track-card" data-seg-action="open-track" data-id="${escapeHTML(s.id)}">
                <div class="tc-top">
                    <div class="tc-id">
                        <div class="nm">${escapeHTML(s.nombre || 'Conducta')}</div>
                        <div class="meta">${meta}</div>
                    </div>
                    <span class="tc-chev">${segIcon('chev')}</span>
                </div>
                <div class="mini-bar">
                    <i class="v" style="width:${w(c.v)}%"></i>
                    <i class="a" style="width:${w(c.a)}%"></i>
                    <i class="r" style="width:${w(c.r)}%"></i>
                </div>
                <div class="tc-foot">
                    <span class="story"><span class="pip" style="background:${st.pip}"></span>${st.text}</span>
                    <span class="counts">
                        <span class="ct"><span class="sw" style="background:var(--sem-verde)"></span>${c.v}</span>
                        <span class="ct"><span class="sw" style="background:var(--sem-amarillo)"></span>${c.a}</span>
                        <span class="ct"><span class="sw" style="background:var(--sem-rojo)"></span>${c.r}</span>
                    </span>
                </div>
            </button>`;
    }).join('');
    const vacio = segState.seguimientos.length
        ? ''
        : '<p class="seg-empty">Aún no hay conductas en seguimiento. Crea la primera con el botón de abajo.</p>';
    const footer = segState.newFormOpen
        ? segNewFormHTML()
        : `<button type="button" class="new-track" data-seg-action="new-open">${segIcon('plus')} Nueva conducta</button>`;
    cont.innerHTML = intro + cards + vacio + footer;
    if (segState.newFormOpen) document.getElementById('seg-new-nombre')?.focus();
}
function segNewFormHTML() {
    return `
        <div class="new-form">
            <div class="nf-label">Nueva conducta</div>
            <input type="text" id="seg-new-nombre" maxlength="60" placeholder="Nombre (p. ej. Paseos, Quedarse solo)" autocomplete="off">
            <textarea id="seg-new-desc" maxlength="120" placeholder="Descripción (opcional)"></textarea>
            <div class="nf-foot">
                <button type="button" data-seg-action="new-cancel">Cancelar</button>
                <button type="button" class="save" data-seg-action="new-save">Crear</button>
            </div>
        </div>`;
}
async function segCrearConducta() {
    const inp = document.getElementById('seg-new-nombre');
    const ta = document.getElementById('seg-new-desc');
    const nombre = (inp?.value || '').trim();
    const desc = (ta?.value || '').trim();
    if (!nombre) { inp?.focus(); return; }
    const btn = document.querySelector('#seguimiento-screen [data-seg-action="new-save"]');
    if (btn) btn.disabled = true;
    try {
        const { data, error } = await supabase
            .from('seguimientos_conducta')
            .insert({ perro_id: segState.perro.id, nombre, descripcion: desc || null, creado_por_admin: false })
            .select('id, nombre, descripcion, creado_por_admin, creado_en')
            .single();
        if (error) throw error;
        segState.newFormOpen = false;
        segState.seguimientos.push(data);
        segState.countsMes[data.id] = { v: 0, a: 0, r: 0 };
        renderSegLista();
        segToast('Conducta creada');
    } catch (err) {
        console.error('[seguimiento] crear conducta', err);
        if (btn) btn.disabled = false;
        segToast('No se ha podido crear');
    }
}

// ---------- pantalla 2: calendario de una conducta ----------
async function abrirCalendario(id) {
    const s = segState.seguimientos.find((x) => x.id === id);
    if (!s) return;
    segState.activo = s;
    const t = segHoy();
    segState.year = t.y;
    segState.month = t.m;
    segMostrarVista('cal');
    await cargarMesCalendario();
}
async function cargarMesCalendario() {
    const cont = document.getElementById('seg-vista-cal');
    cont.innerHTML = '<p class="seg-loading">Cargando…</p>';
    segState.dias = {};
    try {
        const y = segState.year, m = segState.month;
        const desde = segIso(y, m, 1);
        const hasta = segIso(y, m, segUltimoDia(y, m));
        const { data, error } = await supabase
            .from('registros_conducta')
            .select('id, fecha, color, orden, nota')
            .eq('seguimiento_id', segState.activo.id)
            .gte('fecha', desde)
            .lte('fecha', hasta)
            .order('fecha', { ascending: true })
            .order('orden', { ascending: true });
        if (error) throw error;
        const dias = {};
        (data || []).forEach((r) => {
            const dia = parseInt(String(r.fecha).slice(8, 10), 10);
            const key = SEG_COLOR_KEY[r.color];
            if (!key || !dia) return;
            (dias[dia] || (dias[dia] = [])).push({ id: r.id, key, nota: r.nota || '', orden: r.orden });
        });
        segState.dias = dias;
        renderSegCal();
    } catch (err) {
        console.error('[seguimiento] cargar mes', err);
        cont.innerHTML = '<p class="seg-empty">No se ha podido cargar el mes. Inténtalo de nuevo.</p>';
    }
}
function renderSegCal() {
    const cont = document.getElementById('seg-vista-cal');
    const y = segState.year, m = segState.month, t = segHoy();
    const cells = segMonthGrid(y, m).map((d) => {
        if (d === null) return '<div class="cell is-pad"></div>';
        const marks = segState.dias[d] || [];
        const fut = segIsFuture(y, m, d);
        const cls = ['cell'];
        cls.push(marks.length ? 'has-marks' : 'is-empty');
        if (y === t.y && m === t.m && d === t.d) cls.push('is-today');
        if (fut) cls.push('is-future');
        const cnt = marks.length >= 2 ? `<span class="cnt">${marks.length}</span>` : '';
        // Días futuros: deshabilitados (no se registra el futuro).
        const attrs = fut ? ' disabled' : ` data-seg-action="open-day" data-dia="${d}"`;
        return `<button type="button" class="${cls.join(' ')}"${attrs} style="${segCellStyle(marks)}"><span class="num">${d}</span>${cnt}</button>`;
    }).join('');
    const week = SEG_DOW_S.map((d) => `<span>${d}</span>`).join('');
    const c = segCountMes();
    const note = segProgressNote(c);
    cont.innerHTML = `
        <div class="month-nav">
            <button type="button" class="mn-btn" data-seg-action="month-prev" aria-label="Mes anterior">${segIcon('left')}</button>
            <div class="mn-label"><div class="mo">${SEG_MESES[m]}</div><div class="yr">${y}</div></div>
            <button type="button" class="mn-btn" data-seg-action="month-next" aria-label="Mes siguiente"${segCanNext() ? '' : ' disabled'}>${segIcon('right')}</button>
        </div>
        <div class="weekrow">${week}</div>
        <div class="calgrid">${cells}</div>
        <div class="legend">
            <span class="lg"><span class="dot" style="background:var(--sem-verde)"></span>Bien</span>
            <span class="sep"></span>
            <span class="lg"><span class="dot" style="background:var(--sem-amarillo)"></span>Regular</span>
            <span class="sep"></span>
            <span class="lg"><span class="dot" style="background:var(--sem-rojo)"></span>Mal</span>
        </div>
        <div class="summary">
            <div class="sm-head">Resumen de ${SEG_MESES[m]}</div>
            <div class="sm-stats">
                <div class="st v"><div class="n">${c.v}</div><div class="t">Bien</div></div>
                <div class="st a"><div class="n">${c.a}</div><div class="t">Regular</div></div>
                <div class="st r"><div class="n">${c.r}</div><div class="t">Mal</div></div>
            </div>
            <div class="sm-prog">
                <span class="ico">${segIcon('trend')}</span>
                <span class="tx">${escapeHTML(note[0])}<b>${escapeHTML(note[1])}</b>${escapeHTML(note[2])}</span>
            </div>
        </div>`;
}
function segMesPrev() {
    let y = segState.year, m = segState.month - 1;
    if (m < 0) { m = 11; y--; }
    segState.year = y; segState.month = m;
    cargarMesCalendario();
}
function segMesNext() {
    if (!segCanNext()) return;
    let y = segState.year, m = segState.month + 1;
    if (m > 11) { m = 0; y++; }
    segState.year = y; segState.month = m;
    cargarMesCalendario();
}

// ---------- pantalla 3: hoja "marcar un día" ----------
function segAbrirSheet(dia) {
    if (dia == null || isNaN(dia)) return;
    segState.sheetDia = dia;
    segState.noteEditId = null;
    renderSegSheet();
    const scrim = document.getElementById('seg-sheet-scrim');
    const sheet = document.getElementById('seg-sheet');
    scrim.classList.add('is-open');
    requestAnimationFrame(() => sheet.classList.add('is-open'));
}
function segCerrarSheet() {
    const scrim = document.getElementById('seg-sheet-scrim');
    const sheet = document.getElementById('seg-sheet');
    if (scrim) scrim.classList.remove('is-open');
    if (sheet) sheet.classList.remove('is-open');
    segState.sheetDia = null;
    segState.noteEditId = null;
}
function renderSegSheet() {
    const dia = segState.sheetDia;
    const body = document.getElementById('seg-sheet-body');
    const dateEl = document.getElementById('seg-sheet-date');
    if (dia == null) { body.innerHTML = ''; return; }
    const y = segState.year, m = segState.month;
    const dow = SEG_DOW_L[new Date(y, m, dia).getDay()];
    dateEl.textContent = `${dow} ${dia} · ${SEG_MESES[m]}`;
    const list = segState.dias[dia] || [];
    const pick = ['v', 'a', 'r'].map((k) => `
        <button type="button" class="sem-btn ${k}" data-seg-action="add-mark" data-color="${k}">
            <span class="disc">${segIcon(SEG_SEM[k].icon)}</span>
            <span class="lb">${SEG_SEM[k].lb}</span>
        </button>`).join('');
    let marksHTML;
    if (!list.length) {
        marksHTML = '<div class="marks-empty">Sin marcas. Toca un color de arriba — puedes sumar varias si hubo más de un paseo.</div>';
    } else {
        marksHTML = '<div class="mark-list">' + list.map((mk) => {
            const editing = segState.noteEditId === mk.id;
            const noteTxt = mk.nota ? escapeHTML(mk.nota) : 'Sin nota';
            const noteCls = mk.nota ? 'note' : 'note is-empty';
            const editor = editing ? `
                <div class="note-edit">
                    <textarea id="seg-note-ta" maxlength="120" placeholder="Nota corta (opcional)…">${escapeHTML(mk.nota || '')}</textarea>
                    <div class="ne-foot">
                        <button type="button" data-seg-action="note-cancel">Cancelar</button>
                        <button type="button" class="save" data-seg-action="note-save" data-id="${escapeHTML(mk.id)}">Guardar nota</button>
                    </div>
                </div>` : '';
            return `
                <div class="mark-row ${mk.key}">
                    <span class="sw">${segIcon(SEG_SEM[mk.key].icon)}</span>
                    <div class="mt">
                        <div class="st">${SEG_SEM[mk.key].lb}</div>
                        <div class="${noteCls}">${noteTxt}</div>
                    </div>
                    <button type="button" class="note-btn" data-seg-action="note-toggle" data-id="${escapeHTML(mk.id)}" aria-label="Nota">${segIcon('note')}</button>
                    <button type="button" class="del" data-seg-action="del-mark" data-id="${escapeHTML(mk.id)}" aria-label="Borrar">${segIcon('trash')}</button>
                </div>${editor}`;
        }).join('') + '</div>';
    }
    body.innerHTML = `
        <div class="sb-label">¿Cómo fue?</div>
        <div class="sem-pick">${pick}</div>
        <div class="marks-block">
            <div class="mb-head">
                <span class="lbl">Marcas del día</span>
                ${list.length ? `<span class="cnt">${list.length} ${list.length === 1 ? 'marca' : 'marcas'}</span>` : ''}
            </div>
            ${marksHTML}
        </div>`;
    if (segState.noteEditId != null) {
        const ta = document.getElementById('seg-note-ta');
        if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
    }
}
async function segAddMark(key) {
    const dia = segState.sheetDia;
    if (dia == null || !segState.activo || !SEG_COLOR_DB[key]) return;
    const fecha = segIso(segState.year, segState.month, dia);
    // orden = max(orden del día) + 1 (monotónico; evita choques si se borró
    // una marca intermedia, manteniendo el sentido de "siguiente marca").
    const previas = segState.dias[dia] || [];
    const orden = previas.reduce((mx, mk) => Math.max(mx, mk.orden || 0), 0) + 1;
    try {
        const { data, error } = await supabase
            .from('registros_conducta')
            .insert({ seguimiento_id: segState.activo.id, fecha, color: SEG_COLOR_DB[key], orden })
            .select('id, fecha, color, orden, nota')
            .single();
        if (error) throw error;
        (segState.dias[dia] || (segState.dias[dia] = [])).push({ id: data.id, key, nota: data.nota || '', orden: data.orden });
        renderSegSheet();
        renderSegCal();
        segToast(`${SEG_SEM[key].lb} · marca añadida`);
    } catch (err) {
        console.error('[seguimiento] añadir marca', err);
        segToast('No se ha podido guardar');
    }
}
async function segDelMark(id) {
    const dia = segState.sheetDia;
    try {
        const { error } = await supabase.from('registros_conducta').delete().eq('id', id);
        if (error) throw error;
        if (dia != null && segState.dias[dia]) {
            segState.dias[dia] = segState.dias[dia].filter((mk) => mk.id !== id);
            if (!segState.dias[dia].length) delete segState.dias[dia];
        }
        if (segState.noteEditId === id) segState.noteEditId = null;
        renderSegSheet();
        renderSegCal();
    } catch (err) {
        console.error('[seguimiento] borrar marca', err);
        segToast('No se ha podido borrar');
    }
}
async function segSaveNote(id) {
    const ta = document.getElementById('seg-note-ta');
    const txt = (ta?.value || '').trim();
    const dia = segState.sheetDia;
    try {
        const { error } = await supabase.from('registros_conducta').update({ nota: txt || null }).eq('id', id);
        if (error) throw error;
        if (dia != null && segState.dias[dia]) {
            const mk = segState.dias[dia].find((x) => x.id === id);
            if (mk) mk.nota = txt;
        }
        segState.noteEditId = null;
        renderSegSheet();
    } catch (err) {
        console.error('[seguimiento] guardar nota', err);
        segToast('No se ha podido guardar la nota');
    }
}

// ---------- toast propio del overlay ----------
let _segToastT = null;
function segToast(msg) {
    const el = document.getElementById('seg-toast');
    if (!el) return;
    el.innerHTML = segIcon('check') + escapeHTML(msg);
    el.classList.add('is-on');
    clearTimeout(_segToastT);
    _segToastT = setTimeout(() => el.classList.remove('is-on'), 1600);
}

// ---------- botón "atrás" del appbar (contextual) ----------
function segBack() {
    if (segState.vista === 'cal') {
        segMostrarVista('lista');
        cargarListaSeguimientos();   // refresca conteos del mes por si cambió algo
    } else {
        cerrarModal('seguimiento-screen');
    }
}

// ---------- binding (entrada + delegación en el overlay) ----------
function bindSeguimiento() {
    document.getElementById('btn-seguimiento')?.addEventListener('click', abrirSeguimiento);

    const overlay = document.getElementById('seguimiento-screen');
    if (!overlay || overlay.__segBound) return;
    overlay.__segBound = true;
    overlay.addEventListener('click', (e) => {
        const t = e.target.closest('[data-seg-action]');
        if (!t || !overlay.contains(t)) return;
        switch (t.dataset.segAction) {
            case 'back': segBack(); break;
            case 'open-track': abrirCalendario(t.dataset.id); break;
            case 'new-open': segState.newFormOpen = true; renderSegLista(); break;
            case 'new-cancel': segState.newFormOpen = false; renderSegLista(); break;
            case 'new-save': segCrearConducta(); break;
            case 'month-prev': segMesPrev(); break;
            case 'month-next': segMesNext(); break;
            case 'open-day': segAbrirSheet(parseInt(t.dataset.dia, 10)); break;
            case 'add-mark': segAddMark(t.dataset.color); break;
            case 'del-mark': segDelMark(t.dataset.id); break;
            case 'note-toggle': segState.noteEditId = (segState.noteEditId === t.dataset.id ? null : t.dataset.id); renderSegSheet(); break;
            case 'note-cancel': segState.noteEditId = null; renderSegSheet(); break;
            case 'note-save': segSaveNote(t.dataset.id); break;
            case 'sheet-close': segCerrarSheet(); break;
        }
    });
}
