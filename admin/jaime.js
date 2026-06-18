import { getSupabase } from '../js/supabase.js';
const supabase = getSupabase('admin');

const MALLORCA_D = 'M59.5,77.3 L51.9,65.9 L35.6,63.3 L32.6,58.7 L34.1,46.6 L28.4,40.9 L24.6,40.2 L16.3,43.9 L12.5,50.8 L9.8,48.1 L9.1,42.0 L3.4,41.7 L0.0,37.5 L0.0,34.5 L15.5,24.2 L21.6,22.7 L40.5,8.3 L54.9,3.0 L68.6,2.3 L73.9,0.0 L73.1,2.3 L67.4,4.9 L69.3,9.8 L76.5,8.7 L74.6,12.9 L69.7,13.3 L70.5,18.6 L78.4,25.8 L83.7,25.0 L89.8,20.5 L100.0,28.4 L97.7,35.2 L92.4,39.0 L91.7,44.3 L82.6,52.7 L76.5,66.3 L59.5,77.3 Z';
const LOAD_STEPS = ['Leyendo evaluación SC', 'Revisando ejercicios asignados', 'Eligiendo del catálogo'];

let ctx = { perroId: null, clienteId: null, nombre: '' };
let fabEl = null;

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let casoActual = null;
let notasCargadas = null;
let recog = null, dictando = false, stopManual = false;

function svgMallorca(size, color) {
  return `<svg width="${size}" height="${size * 77.3 / 100}" viewBox="0 0 100 77.3" fill="${color}" aria-hidden="true" style="display:block"><path d="${MALLORCA_D}"/></svg>`;
}

export function initJaime(context) {
  ctx = { ...ctx, ...context };
  if (fabEl) return;
  fabEl = document.createElement('button');
  fabEl.className = 'jm-fab';
  fabEl.setAttribute('aria-label', 'Abrir asistente');
  fabEl.innerHTML = svgMallorca(28, '#F5EFE0');
  fabEl.addEventListener('click', abrir);
  document.body.appendChild(fabEl);
}

function cerrar() {
  const ov = document.getElementById('jm-overlay');
  if (ov) ov.remove();
  if (fabEl) fabEl.hidden = false;
}

function abrir() {
  if (fabEl) fabEl.hidden = true;
  const overlay = document.createElement('div');
  overlay.id = 'jm-overlay';
  overlay.innerHTML = `
    <div class="jm-overlay" data-close></div>
    <div class="jm-sheet" role="dialog" aria-modal="true">
      <div class="jm-grabber"></div>
      <div class="jm-head">
        <div class="jm-avatar">${svgMallorca(20, 'var(--jm-rojo)')}</div>
        <div style="flex:1">
          <div class="jm-name">Jaime</div>
          <div class="jm-sub">Asistente · ${ctx.nombre || ''}</div>
        </div>
        <button class="jm-x" data-close aria-label="Cerrar"><svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3 3 L11 11 M11 3 L3 11"/></svg></button>
      </div>
      <div class="jm-tabs" id="jm-tabs" hidden>
        <button class="jm-tab active" data-tab="sugerencias">Sugerencias</button>
        <button class="jm-tab" data-tab="notas">Notas</button>
      </div>
      <div class="jm-body" id="jm-body"></div>
    </div>`;
  overlay.querySelectorAll('[data-close]').forEach((el) => el.addEventListener('click', cerrar));
  overlay.querySelectorAll('.jm-tab').forEach((t) => t.addEventListener('click', () => setTab(t.dataset.tab)));
  document.body.appendChild(overlay);
  renderLoader();
  cargarYrender();
}

async function cargarYrender() {
  const MIN_LOADER = 1860;
  const t0 = Date.now();
  let payload = null, errMsg = null;
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
    if (!document.getElementById('jm-body')) return; // el panel se cerró
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
