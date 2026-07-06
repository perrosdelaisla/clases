import { getSupabase } from '../js/supabase.js';
const supabase = getSupabase('admin');

const MALLORCA_D = 'M59.5,77.3 L51.9,65.9 L35.6,63.3 L32.6,58.7 L34.1,46.6 L28.4,40.9 L24.6,40.2 L16.3,43.9 L12.5,50.8 L9.8,48.1 L9.1,42.0 L3.4,41.7 L0.0,37.5 L0.0,34.5 L15.5,24.2 L21.6,22.7 L40.5,8.3 L54.9,3.0 L68.6,2.3 L73.9,0.0 L73.1,2.3 L67.4,4.9 L69.3,9.8 L76.5,8.7 L74.6,12.9 L69.7,13.3 L70.5,18.6 L78.4,25.8 L83.7,25.0 L89.8,20.5 L100.0,28.4 L97.7,35.2 L92.4,39.0 L91.7,44.3 L82.6,52.7 L76.5,66.3 L59.5,77.3 Z';
const LOAD_STEPS = ['Leyendo evaluación SC', 'Revisando ejercicios asignados', 'Eligiendo del catálogo'];

let ctx = { pantalla: null, perroId: null, clienteId: null, nombre: '' };
let fabEl = null;

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let casoActual = null;
let notasCargadas = null;
let recog = null, dictando = false, stopManual = false;

// Historial de la conversación EN MEMORIA de la sesión del navegador. Se
// conserva mientras la pestaña siga abierta (aunque se cierre el panel) y se
// pierde al recargar. Persistencia real: Entrega 2.
let chatHist = [];   // [{ role:'user'|'assistant', content:string }]
let enviando = false;

function svgMallorca(size, color) {
  return `<svg width="${size}" height="${size * 77.3 / 100}" viewBox="0 0 100 77.3" fill="${color}" aria-hidden="true" style="display:block"><path d="${MALLORCA_D}"/></svg>`;
}

export function initJaime(context) {
  ctx = { ...ctx, ...context };
  if (fabEl) return;
  fabEl = document.createElement('button');
  fabEl.className = 'jm-fab';
  fabEl.setAttribute('aria-label', 'Abrir asistente');
  fabEl.innerHTML = '<img class="jm-img" src="img/jaime.png" alt="Jaime"><span class="jm-zzz" aria-hidden="true"><span>z</span><span>z</span><span>z</span></span>';
  document.body.appendChild(fabEl);
  setupFabArrastrable();
  bindInactividad();
}

// ─────────────────── Caritas de estado (solo front) ───────────────────
// Calcado del cliente (js/app.js): swap del src de la imagen del FAB y, si el
// panel está abierto, del avatar de la cabecera. Nunca toca left/top/transform
// del FAB arrastrable (fix 1344f4f): solo reescribe el src y togglea is-durmiendo.
const JM_CARAS = {
  normal: 'img/jaime.png',
  durmiendo: 'img/jaime-durmiendo.png',
  pensando: 'img/jaime-pensando.png',
};
let jmEstado = 'normal';
let jmInactivTimer = null;

function setJmCara(estado) {
  if (!JM_CARAS[estado]) estado = 'normal';
  jmEstado = estado;
  const src = JM_CARAS[estado];
  const fabImg = fabEl && fabEl.querySelector('.jm-img');
  if (fabImg && fabImg.getAttribute('src') !== src) fabImg.setAttribute('src', src);
  // El "zzz" flotante solo se ve dormido.
  if (fabEl) fabEl.classList.toggle('is-durmiendo', estado === 'durmiendo');
  // Si el panel está abierto, la carita de la cabecera también.
  const cabImg = document.querySelector('#jm-overlay .jm-avatar .jm-img');
  if (cabImg && cabImg.getAttribute('src') !== src) cabImg.setAttribute('src', src);
}

// Inactividad: 45s sin interacción → 'durmiendo' (mismo umbral que el cliente).
// Cualquier interacción despierta. No duerme con el panel abierto ni pensando.
function reiniciarInactividad() {
  if (jmInactivTimer) clearTimeout(jmInactivTimer);
  if (jmEstado === 'durmiendo') setJmCara('normal');
  jmInactivTimer = setTimeout(() => {
    const panelAbierto = !!document.getElementById('jm-overlay');
    if (jmEstado === 'pensando' || panelAbierto) return;
    setJmCara('durmiendo');
  }, 45000);
}

function bindInactividad() {
  ['pointerdown', 'keydown', 'scroll'].forEach((ev) => {
    document.addEventListener(ev, reiniciarInactividad, { passive: true });
  });
  reiniciarInactividad();   // arranca el conteo
}

// API externa mínima: el modo "escucha" del admin (grabar la clase) pone a
// Jaime en 'pensando' mientras graba, y así tampoco se duerme por inactividad.
// Al cortar, vuelve a 'normal'. Solo cambia la carita (src + is-durmiendo);
// no toca la posición/transform del FAB arrastrable.
export function jaimeEscuchando(on) {
  setJmCara(on ? 'pensando' : 'normal');
}

// ─────────────────── FAB arrastrable + persistencia ───────────────────
// TAP corto → abre el chat. Mantener ~250ms o desplazar >8px → arrastre
// (el FAB sigue al puntero por transform, sin reflow). Al soltar, snap al
// borde lateral más cercano conservando la altura, y se guarda { lado, y }.
const FAB_POS_KEY = 'pdli_jaime_fab_pos';
const FAB_MARGEN = 14;
const FAB_UMBRAL = 8;
const FAB_LONGPRESS_MS = 250;

let fabX = 0, fabY = 0;            // posición top-left (aplicada vía transform)
let fabArrastrando = false;
let fabSupressClick = false;
// Mientras sea false, el FAB conserva su posición CSS por defecto (right/bottom,
// responsive). Pasamos a transform solo al restaurar una posición guardada o al
// empezar un arrastre real — así un simple tap no altera el layout por defecto.
let fabTransformActivo = false;

function fabAsegurarTransform() {
  if (fabTransformActivo) return;
  const r = fabEl.getBoundingClientRect();
  fabX = r.left; fabY = r.top;
  // Cortamos cualquier animación de entrada (jmFabIn) que con fill-mode both
  // pisaría permanentemente el transform inline y dejaría el FAB en 0,0.
  fabEl.style.animation = 'none';
  fabEl.style.left = '0'; fabEl.style.top = '0'; fabEl.style.right = 'auto'; fabEl.style.bottom = 'auto';
  fabTransformActivo = true;
  fabAplicarTransform();
}

// Lee las safe-areas de iOS resolviendo env(...) sobre un elemento probe.
function fabSafeAreas() {
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;top:0;left:0;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)';
  document.body.appendChild(probe);
  const cs = getComputedStyle(probe);
  const sa = { top: parseFloat(cs.paddingTop) || 0, right: parseFloat(cs.paddingRight) || 0, bottom: parseFloat(cs.paddingBottom) || 0, left: parseFloat(cs.paddingLeft) || 0 };
  probe.remove();
  return sa;
}

// Límites válidos para el top-left del FAB: dentro del viewport con margen,
// sin invadir safe-areas ni la barra/columna de navegación del admin.
function fabBounds() {
  const w = fabEl.offsetWidth || 64;
  const h = fabEl.offsetHeight || 64;
  const vw = window.innerWidth, vh = window.innerHeight;
  const sa = fabSafeAreas();
  let leftReserve = 0, bottomReserve = 0;
  const nav = document.querySelector('.admin-nav');
  if (nav && getComputedStyle(nav).position === 'fixed' && nav.offsetParent !== null) {
    const r = nav.getBoundingClientRect();
    if (r.left <= 1 && r.width < vw && r.height >= vh * 0.7) leftReserve = r.width;        // sidebar izquierdo (desktop)
    else if (r.bottom >= vh - 1 && r.top >= vh * 0.4) bottomReserve = r.height;            // barra de tabs inferior (mobile)
  }
  const minX = leftReserve + sa.left + FAB_MARGEN;
  const maxX = vw - w - sa.right - FAB_MARGEN;
  const minY = sa.top + FAB_MARGEN;
  const maxY = vh - h - sa.bottom - bottomReserve - FAB_MARGEN;
  return { w, h, vw, vh, minX: Math.min(minX, maxX), maxX, minY: Math.min(minY, maxY), maxY };
}

function fabAplicarTransform() {
  fabEl.style.transform = `translate(${Math.round(fabX)}px, ${Math.round(fabY)}px)` + (fabArrastrando ? ' scale(1.08)' : '');
}

function fabSetPos(x, y, animar) {
  fabX = x; fabY = y;
  if (animar) fabEl.classList.add('jm-fab--snap');
  fabAplicarTransform();
  if (animar) setTimeout(() => { if (fabEl) fabEl.classList.remove('jm-fab--snap'); }, 300);
}

function fabLeerPos() {
  try {
    const raw = localStorage.getItem(FAB_POS_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (p && (p.lado === 'left' || p.lado === 'right') && typeof p.y === 'number') return p;
  } catch (e) {}
  return null;
}

function fabGuardarPos(lado, y) {
  try { localStorage.setItem(FAB_POS_KEY, JSON.stringify({ lado, y })); } catch (e) {}
}

function fabXYdesdeLado(lado, y, b) {
  return { x: lado === 'left' ? b.minX : b.maxX, y: Math.min(Math.max(y, b.minY), b.maxY) };
}

function setupFabArrastrable() {
  // Solo restauramos vía transform si hay posición guardada; si no, el FAB
  // conserva su posición CSS por defecto (responsive) hasta que se arrastre.
  requestAnimationFrame(() => {
    if (!fabEl) return;
    const saved = fabLeerPos();
    if (!saved) return;
    fabAsegurarTransform();
    const b = fabBounds();
    const p = fabXYdesdeLado(saved.lado, saved.y, b);
    fabSetPos(p.x, p.y, false);
  });

  let pointerId = null, startX = 0, startY = 0, grabDX = 0, grabDY = 0, longTimer = null;

  const entrarArrastre = () => {
    if (fabArrastrando) return;
    fabAsegurarTransform();
    fabArrastrando = true;
    fabEl.classList.add('jm-fab--drag');
    fabAplicarTransform();
  };

  fabEl.addEventListener('pointerdown', (e) => {
    if (pointerId !== null) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    pointerId = e.pointerId;
    startX = e.clientX; startY = e.clientY;
    // Offset del puntero respecto al top-left actual del FAB (rect real, sirva
    // o no transform todavía).
    const r = fabEl.getBoundingClientRect();
    grabDX = e.clientX - r.left; grabDY = e.clientY - r.top;
    fabArrastrando = false;
    try { fabEl.setPointerCapture(pointerId); } catch (er) {}
    longTimer = setTimeout(entrarArrastre, FAB_LONGPRESS_MS);
  });

  fabEl.addEventListener('pointermove', (e) => {
    if (e.pointerId !== pointerId) return;
    if (!fabArrastrando) {
      if (Math.hypot(e.clientX - startX, e.clientY - startY) <= FAB_UMBRAL) return;
      clearTimeout(longTimer);
      entrarArrastre();
    }
    const b = fabBounds();
    fabX = Math.min(Math.max(e.clientX - grabDX, b.minX), b.maxX);
    fabY = Math.min(Math.max(e.clientY - grabDY, b.minY), b.maxY);
    fabAplicarTransform();
    e.preventDefault();
  });

  const soltar = (e) => {
    if (e.pointerId !== pointerId) return;
    clearTimeout(longTimer);
    try { fabEl.releasePointerCapture(pointerId); } catch (er) {}
    pointerId = null;
    if (fabArrastrando) {
      fabArrastrando = false;
      fabEl.classList.remove('jm-fab--drag');
      const b = fabBounds();
      const centro = fabX + b.w / 2;
      const lado = centro < b.vw / 2 ? 'left' : 'right';
      const p = fabXYdesdeLado(lado, fabY, b);
      fabSetPos(p.x, p.y, true);
      fabGuardarPos(lado, p.y);
      // El click que sigue al soltar NO debe abrir el chat.
      fabSupressClick = true;
      setTimeout(() => { fabSupressClick = false; }, 60);
    }
  };
  fabEl.addEventListener('pointerup', soltar);
  fabEl.addEventListener('pointercancel', soltar);

  // TAP (o teclado) abre el chat; se ignora el click sintético tras arrastrar.
  fabEl.addEventListener('click', () => {
    if (fabSupressClick) { fabSupressClick = false; return; }
    abrir();
  });

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(fabReclamp, 120);
  });
}

// Re-clamp en resize/rotación: si la posición guardada quedó fuera, se ajusta.
// Si el FAB sigue en su posición CSS por defecto (nunca se movió), no tocamos
// nada: el propio CSS ya es responsive.
function fabReclamp() {
  if (!fabEl || !fabTransformActivo) return;
  const b = fabBounds();
  const saved = fabLeerPos();
  if (saved) {
    const p = fabXYdesdeLado(saved.lado, saved.y, b);
    fabSetPos(p.x, p.y, false);
    if (p.y !== saved.y) fabGuardarPos(saved.lado, p.y);
  } else {
    fabSetPos(Math.min(Math.max(fabX, b.minX), b.maxX), Math.min(Math.max(fabY, b.minY), b.maxY), false);
  }
}

function cerrar() {
  const ov = document.getElementById('jm-overlay');
  if (ov) ov.remove();
  if (fabEl) fabEl.hidden = false;
}

function abrir() {
  if (fabEl) fabEl.hidden = true;
  const sub = ctx.nombre ? `Sobre ${escapeHtml(ctx.nombre)}` : 'Asistente del panel';
  const overlay = document.createElement('div');
  overlay.id = 'jm-overlay';
  overlay.innerHTML = `
    <div class="jm-overlay" data-close></div>
    <div class="jm-sheet" role="dialog" aria-modal="true">
      <div class="jm-grabber"></div>
      <div class="jm-head">
        <div class="jm-avatar"><img class="jm-img" src="img/jaime.png" alt="Jaime"></div>
        <div style="flex:1">
          <div class="jm-name">Jaime</div>
          <div class="jm-sub">${sub}</div>
        </div>
        <button class="jm-x" data-close aria-label="Cerrar"><svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3 3 L11 11 M11 3 L3 11"/></svg></button>
      </div>
      <div class="jm-view" id="jm-view"></div>
    </div>`;
  overlay.querySelectorAll('[data-close]').forEach((el) => el.addEventListener('click', cerrar));
  document.body.appendChild(overlay);
  // Decidir el parte ANTES de pintar: si dispara, su respuesta hace de saludo
  // y no mostramos el saludo estático encima (un solo "hola").
  parteAutoActivo = debeDispararParte();
  renderChatView();
  if (parteAutoActivo) dispararParteDelDia();
}

// Parte del día automático: SOLO en la pantalla index del admin, la primera vez
// que se abre el chat en el día. Dispara internamente "Dame el parte del día"
// (mensaje oculto: se pinta solo la respuesta de Jaime, como si te recibiera
// hablando) y guarda la fecha para no repetir hasta mañana.
const PARTE_FECHA_KEY = 'pdli_jaime_parte_fecha';
// Marca de que Jaime ya se presentó en el panel (luego saluda breve, sin
// volver a presentarse).
const JAIME_ADMIN_PRESENTADO_KEY = 'pdli_jaime_admin_presentado';

// Cuando el parte auto-dispara, el propio parte hace de saludo: no mostramos el
// saludo estático encima (evita el doble "hola"). Se decide al abrir el chat.
let parteAutoActivo = false;
// Saludo calculado UNA sola vez por apertura, para que no cambie entre renders
// (saludoInicial tiene efecto: marca "presentado" la primera vez).
let saludoCache = '';

function hoyLocalISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function primerNombreAdmin() {
  const n = (ctx.adminNombre || '').trim();
  return n ? n.split(/\s+/)[0] : '';
}

// ¿Toca disparar el parte del día? (index, sin conversación en curso, 1ª del día)
function debeDispararParte() {
  if (ctx.pantalla !== 'index') return false;   // ni cliente.html ni perro.html
  if (chatHist.length) return false;            // no interrumpir una conversación
  let ultima = null;
  try { ultima = localStorage.getItem(PARTE_FECHA_KEY); } catch (_e) { /* noop */ }
  return ultima !== hoyLocalISO();
}

function dispararParteDelDia() {
  try { localStorage.setItem(PARTE_FECHA_KEY, hoyLocalISO()); } catch (_e) { /* noop */ }
  mandarMensaje('Dame el parte del día', true);
}

// ─────────────────────────── CHAT ───────────────────────────

function saludoInicial() {
  if (ctx.perroId) return `Estoy sobre el caso de ${escapeHtml(ctx.nombre || 'este perro')}. Pregúntame por su rutina, entrenos, bienestar o resúmenes de clase. También puedes abrir el informe del caso.`;
  if (ctx.clienteId) return `Estoy sobre ${escapeHtml(ctx.nombre || 'este cliente')}. Pregúntame por sus perros, citas, resúmenes de clase o datos de contacto.`;
  // Panel general: saluda por el nombre; se presenta solo la primera vez.
  const nombre = primerNombreAdmin();
  const hola = nombre ? `¡Hola, ${escapeHtml(nombre)}!` : '¡Hola!';
  let presentado = false;
  try { presentado = localStorage.getItem(JAIME_ADMIN_PRESENTADO_KEY) === '1'; } catch (_e) { /* noop */ }
  if (!presentado) {
    try { localStorage.setItem(JAIME_ADMIN_PRESENTADO_KEY, '1'); } catch (_e) { /* noop */ }
    return `${hola} Soy Jaime, tu asistente del panel. Pregúntame por cualquier cliente o perro; puedo buscarlos por nombre y consultar sus datos, rutinas, entrenos y más.`;
  }
  return `${hola} ¿Qué necesitas?`;
}

function renderChatView() {
  const view = document.getElementById('jm-view');
  if (!view) return;
  // Chip contextual: informe del caso (pantalla de perro) o parte del día
  // (pantalla index del admin).
  const chip = ctx.perroId
    ? `<div class="jm-chip-row"><button type="button" class="jm-chip" id="jm-chip-informe">📋 Informe del caso</button></div>`
    : (ctx.pantalla === 'index'
        ? `<div class="jm-chip-row"><button type="button" class="jm-chip" id="jm-chip-parte">📋 Parte del día</button></div>`
        : '');
  view.innerHTML = `
    <div class="jm-chat-list" id="jm-chat-list"></div>
    <div class="jm-chat-foot">
      ${chip}
      <div class="jm-chat-input">
        <textarea id="jm-chat-ta" class="jm-chat-ta" rows="1" placeholder="Escribe tu pregunta…"></textarea>
        <button class="jm-send" id="jm-chat-send" aria-label="Enviar">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2 L11 13 M22 2 L15 22 L11 13 L2 9 Z"/></svg>
        </button>
      </div>
    </div>`;
  document.getElementById('jm-chip-informe')?.addEventListener('click', abrirInforme);
  document.getElementById('jm-chip-parte')?.addEventListener('click', () => mandarMensaje('Dame el parte del día', false));
  const ta = document.getElementById('jm-chat-ta');
  const send = document.getElementById('jm-chat-send');
  send?.addEventListener('click', enviarMensaje);
  ta?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); enviarMensaje(); }
  });
  ta?.addEventListener('input', () => {
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 120) + 'px';
  });
  // Saludo calculado una vez por apertura. Si el parte auto-dispara, no hay
  // saludo estático (el parte hace de saludo → un solo "hola").
  saludoCache = parteAutoActivo ? '' : saludoInicial();
  renderChat();
  ta?.focus();
}

function renderChat() {
  const list = document.getElementById('jm-chat-list');
  if (!list) return;
  let html = saludoCache
    ? `<div class="jm-msg jaime"><div class="jm-bubble">${escapeHtml(saludoCache)}</div></div>`
    : '';
  html += chatHist.filter((m) => !m.hidden).map((m) =>
    `<div class="jm-msg ${m.role === 'user' ? 'user' : 'jaime'}"><div class="jm-bubble">${escapeHtml(m.content)}</div></div>`
  ).join('');
  list.innerHTML = html;
  list.scrollTop = list.scrollHeight;
}

async function enviarMensaje() {
  const ta = document.getElementById('jm-chat-ta');
  const texto = (ta?.value || '').trim();
  if (!texto || enviando) return;
  if (ta) { ta.value = ''; ta.style.height = 'auto'; }
  await mandarMensaje(texto, false);
}

// Envía un mensaje al asistente. hidden=true: el turno del usuario NO se pinta
// (lo usa el parte del día automático), pero SÍ va en el historial para que la
// conversación siga siendo válida (empieza por 'user').
async function mandarMensaje(texto, hidden) {
  if (!texto || enviando) return;
  enviando = true;
  chatHist.push({ role: 'user', content: texto, hidden: !!hidden });
  renderChat();

  const list = document.getElementById('jm-chat-list');
  if (list) {
    list.insertAdjacentHTML('beforeend', '<div class="jm-msg jaime" id="jm-typing"><div class="jm-bubble jm-typing"><span></span><span></span><span></span></div></div>');
    list.scrollTop = list.scrollHeight;
  }
  const send = document.getElementById('jm-chat-send');
  if (send) send.disabled = true;
  setJmCara('pensando');

  try {
    const { data, error } = await supabase.functions.invoke('asistente-admin', {
      body: {
        mensajes: chatHist.map((m) => ({ role: m.role, content: m.content })),
        contexto: { pantalla: ctx.pantalla, cliente_id: ctx.clienteId, perro_id: ctx.perroId },
      },
    });
    let res = data;
    if (error?.context && typeof error.context.json === 'function') {
      res = await error.context.json().catch(() => null);
    }
    const reply = (res && res.ok && typeof res.reply === 'string')
      ? res.reply
      : (res?.error || 'No he podido responder ahora mismo. Inténtalo de nuevo.');
    chatHist.push({ role: 'assistant', content: reply });
  } catch (e) {
    console.error('[jaime] chat error:', e);
    chatHist.push({ role: 'assistant', content: 'No he podido responder ahora mismo. Inténtalo de nuevo.' });
  } finally {
    enviando = false;
    setJmCara('normal');
    document.getElementById('jm-typing')?.remove();
    renderChat();
    const s = document.getElementById('jm-chat-send');
    if (s) s.disabled = false;
    document.getElementById('jm-chat-ta')?.focus();
  }
}

// ─────────────────────── INFORME (modo clásico) ───────────────────────
// Solo accesible desde el chip "Informe del caso" cuando hay perro en
// contexto (perro.html). Mantiene el flujo y el render de siempre.

function abrirInforme() {
  const view = document.getElementById('jm-view');
  if (!view) return;
  view.innerHTML = `
    <button class="jm-back" id="jm-back-chat">‹ Volver al chat</button>
    <div class="jm-tabs" id="jm-tabs" hidden>
      <button class="jm-tab active" data-tab="sugerencias">Sugerencias</button>
      <button class="jm-tab" data-tab="notas">Notas</button>
    </div>
    <div class="jm-body" id="jm-body"></div>`;
  document.getElementById('jm-back-chat')?.addEventListener('click', renderChatView);
  view.querySelectorAll('.jm-tab').forEach((t) => t.addEventListener('click', () => setTab(t.dataset.tab)));
  renderLoader();
  cargarYrender();
}

async function cargarYrender() {
  const MIN_LOADER = 1860;
  const t0 = Date.now();
  let payload = null, errMsg = null;
  setJmCara('pensando');
  try {
    const { data, error } = await supabase.functions.invoke('asistente-admin', {
      body: { perro_id: ctx.perroId, cliente_id: ctx.clienteId },
    });
    let res = data;
    if (error?.context && typeof error.context.json === 'function') {
      res = await error.context.json().catch(() => null);
    }
    if (res?.ok) payload = res;
    else errMsg = res?.error || error?.message || 'No pude leer el caso.';
  } catch (e) {
    errMsg = 'No pude leer el caso.';
  }
  const espera = Math.max(0, MIN_LOADER - (Date.now() - t0));
  setTimeout(() => {
    setJmCara('normal');
    if (!document.getElementById('jm-body')) return; // el panel se cerró o volvió al chat
    if (payload) {
      casoActual = payload;
      const tabs = document.getElementById('jm-tabs');
      if (tabs) tabs.hidden = false;
      setTab('sugerencias');
    } else {
      renderError(errMsg);
    }
  }, espera);
}

function renderError(msg) {
  const body = document.getElementById('jm-body');
  if (!body) return;
  body.innerHTML = `<div class="jm-pad jm-fade"><div class="jm-noeval"><div class="t">No pude leer el caso.</div><div class="d">${msg || 'Probá de nuevo en un momento.'}</div></div></div>`;
}

function renderLoader() {
  const body = document.getElementById('jm-body');
  if (!body) return;
  body.innerHTML = `
    <div class="jm-load">
      <div class="head"><span>Leyendo el caso</span>${[0,1,2].map(d=>`<span class="dot" style="animation-delay:${d*0.18}s"></span>`).join('')}</div>
      <div class="track"><i id="jm-prog"></i></div>
      <div class="jm-steps">${LOAD_STEPS.map((t,i)=>`<div class="jm-step" data-i="${i}"><div class="ic"></div><div class="t">${t}</div></div>`).join('')}</div>
    </div>`;
  let s = 0;
  const total = LOAD_STEPS.length;
  const prog = document.getElementById('jm-prog');
  const steps = [...body.querySelectorAll('.jm-step')];
  const tick = () => {
    steps.forEach((el, i) => {
      el.classList.toggle('done', i < s);
      el.classList.toggle('on', i === s);
      const ic = el.querySelector('.ic');
      ic.innerHTML = i < s
        ? '<svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 6.5 L5 9 L9.5 3.5"/></svg>'
        : (i === s ? '<span class="live"></span>' : '');
    });
    if (prog) prog.style.transform = `scaleX(${Math.min(s/total,1)})`;
  };
  tick();
  const id = setInterval(() => { s++; tick(); if (s >= total) clearInterval(id); }, 620);
}

function bloqueSC(sc) {
  if (!sc || !sc.tiene) {
    return `<div class="jm-pad jm-fade"><div class="jm-eyebrow">Lectura SC</div>
      <div class="jm-noeval"><div class="t">Sin evaluación todavía.</div>
      <div class="d">No hay evaluación de Salud Comportamental cargada. Cuando la subas, la leo y ajusto las sugerencias.</div></div></div>`;
  }
  const flag = sc.bandera ? `<div class="jm-flag"><svg width="11" height="14" viewBox="0 0 11 14"><rect x="0.6" y="0" width="1.6" height="14" fill="var(--jm-rojo)"/><path d="M2.2 0.6 H10 L7.6 3.4 L10 6.2 H2.2 Z" fill="var(--jm-rojo)"/></svg><span>Bandera roja</span></div>` : '';
  const dims = sc.dims.map(d => `
    <div class="jm-dim ${d.low?'low':''}">
      <div class="row"><span class="k">${d.k}${d.low?' · la más baja':''}</span><span class="v">${d.v}</span></div>
      <div class="jm-bar"><i style="width:${d.v}%"></i></div>
    </div>`).join('');
  return `<div class="jm-pad jm-fade">
    <div style="display:flex;align-items:center;justify-content:space-between">
      <div class="jm-eyebrow">Lectura SC <span class="soft">· eval ${sc.fecha}</span></div>${flag}
    </div>
    <div class="jm-total"><span class="n">${sc.total}</span><span class="lbl">Total SC</span></div>
    <div class="jm-dims">${dims}</div></div>`;
}

function renderContenido(data) {
  const body = document.getElementById('jm-body');
  if (!body) return;
  const estado = data.estado.map((l,i)=>`<div class="l ${i===0?'first':''}">${l}</div>`).join('');
  body.innerHTML = `
    <div class="jm-pad jm-fade" style="margin-bottom:6px"><div class="jm-intro">${data.intro}</div></div>
    <div class="jm-divider"></div>
    <div class="jm-pad jm-fade"><div class="jm-eyebrow">Estado del caso</div><div class="jm-estado">${estado}</div></div>
    <div class="jm-divider"></div>
    ${bloqueSC(data.sc)}
    <div class="jm-divider"></div>
    <div class="jm-pad jm-fade"><div class="jm-eyebrow">Sugerencias <span class="soft">· del catálogo</span></div><div class="jm-sugs" id="jm-sugs"></div></div>
    <div class="jm-close jm-fade"><div class="line"></div><div class="t">El criterio final es tuyo.</div></div>`;
  const cont = body.querySelector('#jm-sugs');
  data.sugerencias.forEach((s) => cont.appendChild(cardSugerencia(s)));
}

function registrarEvento(tipo, ejercicioId, codigo) {
  supabase.from('eventos').insert({
    perro_id: ctx.perroId,
    cliente_id: ctx.clienteId,
    tipo,
    payload: { ejercicio_id: ejercicioId, codigo, origen: 'jaime' },
    creado_por: 'asistente',
  }).then(({ error }) => { if (error) console.warn('[jaime] no se pudo registrar evento:', error); });
}

function cardSugerencia(s) {
  const card = document.createElement('div');
  card.className = 'jm-card';
  card.dataset.ejercicioId = s.id || '';
  card.dataset.codigo = s.codigo || '';

  const pintarOpen = () => {
    card.className = 'jm-card';
    card.innerHTML = `
      <div class="top"><div class="ej">${s.nombre}</div></div>
      <div class="why">${s.por_que}</div>
      <div class="jm-actions"><button class="jm-assign">Asignar</button><button class="jm-discard">Descartar</button></div>`;
    card.querySelector('.jm-assign').addEventListener('click', onAsignarClick);
    card.querySelector('.jm-discard').addEventListener('click', pintarDismissed);
  };

  const onAsignarClick = async (e) => {
    const btn = e.currentTarget;
    if (!card.dataset.ejercicioId) { if (ctx.toast) ctx.toast('No se pudo identificar el ejercicio', 'error'); return; }
    btn.disabled = true; btn.textContent = 'Asignando…';
    try {
      if (ctx.onAsignar) await ctx.onAsignar(card.dataset.ejercicioId);
      registrarEvento('ejercicio_asignado', card.dataset.ejercicioId, card.dataset.codigo);
      pintarAssigned();
    } catch (err) {
      console.error('[jaime] error asignando:', err);
      btn.disabled = false; btn.textContent = 'Asignar';
      if (ctx.toast) ctx.toast('No se pudo asignar', 'error');
    }
  };

  const pintarAssigned = () => {
    card.className = 'jm-card assigned';
    card.innerHTML = `
      <div class="top"><div class="jm-check"><svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 6.5 L5 9 L9.5 3.5"/></svg></div><div class="ej">${s.nombre}</div></div>
      <div class="jm-assigned-row"><span class="ok">Asignado a la rutina</span><button class="jm-undo">Deshacer</button></div>`;
    card.querySelector('.jm-undo').addEventListener('click', onDeshacerClick);
  };

  const onDeshacerClick = async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      if (ctx.onDeshacer) await ctx.onDeshacer(card.dataset.ejercicioId);
      pintarOpen();
    } catch (err) {
      console.error('[jaime] error deshaciendo:', err);
      btn.disabled = false;
      if (ctx.toast) ctx.toast('No se pudo deshacer', 'error');
    }
  };

  const pintarDismissed = () => {
    card.className = 'jm-card dismissed';
    card.innerHTML = `<span class="ej">${s.nombre}</span><button class="jm-undo">Deshacer</button>`;
    card.querySelector('.jm-undo').addEventListener('click', pintarOpen);
  };

  pintarOpen();
  return card;
}

function setTab(tab) {
  document.querySelectorAll('.jm-tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
  if (tab === 'notas') renderNotas();
  else if (casoActual) renderContenido(casoActual);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const MIC_SVG = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>';

async function renderNotas() {
  const body = document.getElementById('jm-body');
  if (!body) return;
  body.innerHTML = `
    <div class="jm-pad jm-fade">
      <div class="jm-notas-lista" id="jm-notas-lista"><div class="jm-notas-cargando">Cargando notas…</div></div>
      <div class="jm-nota-input">
        <textarea id="jm-nota-texto" class="jm-nota-textarea" placeholder="Dejá una nota de este perro…" rows="3"></textarea>
        <div class="jm-nota-acciones">
          ${SR ? `<button class="jm-mic" id="jm-mic" aria-label="Dictar" title="Dictar">${MIC_SVG}</button>` : ''}
          <button class="jm-nota-guardar" id="jm-nota-guardar">Guardar</button>
        </div>
      </div>
    </div>`;
  try {
    const { data, error } = await supabase.from('eventos')
      .select('id, payload, created_at')
      .eq('perro_id', ctx.perroId).eq('tipo', 'nota_caso')
      .order('created_at', { ascending: false });
    if (error) throw error;
    notasCargadas = data || [];
  } catch (e) {
    console.warn('[jaime] no se pudieron cargar notas:', e);
    notasCargadas = [];
  }
  pintarListaNotas();
  document.getElementById('jm-nota-guardar')?.addEventListener('click', onGuardarNota);
  if (SR) bindDictado();
}

function pintarListaNotas() {
  const cont = document.getElementById('jm-notas-lista');
  if (!cont) return;
  if (!notasCargadas || notasCargadas.length === 0) {
    cont.innerHTML = '<div class="jm-notas-vacio">Todavía no dejaste notas de este perro.</div>';
    return;
  }
  cont.innerHTML = notasCargadas.map((n) => {
    const f = new Date(n.created_at);
    const fecha = f.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' }) +
      ' · ' + f.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
    const texto = (n.payload && n.payload.texto) ? n.payload.texto : '';
    return `<div class="jm-nota-item"><div class="jm-nota-fecha">${fecha}</div><div class="jm-nota-cuerpo">${escapeHtml(texto)}</div></div>`;
  }).join('');
}

async function onGuardarNota() {
  const ta = document.getElementById('jm-nota-texto');
  const btn = document.getElementById('jm-nota-guardar');
  const texto = (ta?.value || '').trim();
  if (!texto) return;
  if (dictando && recog) { stopManual = true; dictando = false; try { recog.stop(); } catch (e) {} }
  btn.disabled = true; btn.textContent = 'Guardando…';
  try {
    const { error } = await supabase.from('eventos').insert({
      perro_id: ctx.perroId,
      cliente_id: ctx.clienteId,
      tipo: 'nota_caso',
      payload: { texto },
      creado_por: 'charly',
    });
    if (error) throw error;
    notasCargadas = null;
    await renderNotas();
  } catch (e) {
    console.error('[jaime] error guardando nota:', e);
    btn.disabled = false; btn.textContent = 'Guardar';
    if (ctx.toast) ctx.toast('No se pudo guardar la nota', 'error');
  }
}

function bindDictado() {
  const mic = document.getElementById('jm-mic');
  if (!mic) return;
  mic.addEventListener('click', () => {
    // Si ya está dictando, el usuario quiere PARAR de verdad.
    if (dictando) {
      stopManual = true;
      try { recog && recog.stop(); } catch (e) {}
      dictando = false;
      mic.classList.remove('on');
      return;
    }
    // Arranca el dictado.
    stopManual = false;
    dictando = true;
    mic.classList.add('on');
    arrancarRecog();
  });
}

function arrancarRecog() {
  const ta = document.getElementById('jm-nota-texto');
  const mic = document.getElementById('jm-mic');
  if (!ta) return;
  recog = new SR();
  recog.lang = 'es-ES';
  recog.interimResults = true;
  recog.continuous = true;
  let finalAcum = ta.value;
  recog.onresult = (ev) => {
    let interim = '';
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const t = ev.results[i][0].transcript;
      if (ev.results[i].isFinal) finalAcum = (finalAcum ? finalAcum + ' ' : '') + t.trim();
      else interim += t;
    }
    ta.value = finalAcum + (interim ? ' ' + interim : '');
  };
  recog.onend = () => {
    // Si el navegador cortó por silencio y NO fue Stop manual, reanudamos.
    if (dictando && !stopManual) {
      try { recog.start(); } catch (e) { dictando = false; mic && mic.classList.remove('on'); }
    } else {
      dictando = false;
      mic && mic.classList.remove('on');
    }
  };
  recog.onerror = (e) => {
    // 'no-speech' o 'aborted' por silencio: dejamos que onend decida reanudar.
    if (e && (e.error === 'not-allowed' || e.error === 'service-not-allowed')) {
      stopManual = true; dictando = false; mic && mic.classList.remove('on');
    }
  };
  try { recog.start(); } catch (e) {}
}
