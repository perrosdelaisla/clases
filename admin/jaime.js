const MALLORCA_D = 'M3,47 L13,30 L34,19 L60,16 L77,19 L88,9 L83,23 L91,38 L83,53 L71,63 L60,65 L52,57 L43,65 L27,63 L15,55 Z';
const LOAD_STEPS = ['Leyendo evaluación SC', 'Revisando ejercicios asignados', 'Eligiendo del catálogo'];

// MOCK Bloque A — en Bloque B esto viene de la edge function asistente-admin.
const MOCK = {
  intro: 'Kira viene con lo emocional muy abajo. Te tiro tres del catálogo para arrancar por ahí.',
  estado: ['Malinois, 7 meses · cliente activa.', 'Rutina activa: Déjalo estar · Aguanta y gana.', 'Todavía sin reportes del cliente.'],
  sc: { tiene: true, fecha: '21/05', total: 68, bandera: true,
        dims: [{ k: 'Emocional', v: 39, low: true }, { k: 'Física', v: 89, low: false }, { k: 'Cognitiva', v: 89, low: false }] },
  sugerencias: [
    { nombre: 'Espacio de calma', why: 'Apoya la autorregulación; encaja con lo emocional bajo en un perro de alta energía.' },
    { nombre: 'Intercambios afectivos calmantes', why: 'Trabaja el vínculo y la calma con el tutor.' },
    { nombre: 'Lista jerárquica de situaciones de ansiedad', why: 'Mapea disparadores antes de exponer.' },
  ],
};

let ctx = { perroId: null, clienteId: null, nombre: '' };
let fabEl = null;

function svgMallorca(size, color) {
  return `<svg width="${size}" height="${size * 72 / 95}" viewBox="0 0 95 72" fill="${color}" aria-hidden="true" style="display:block"><path d="${MALLORCA_D}"/></svg>`;
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
      <div class="jm-body" id="jm-body"></div>
    </div>`;
  overlay.querySelectorAll('[data-close]').forEach((el) => el.addEventListener('click', cerrar));
  document.body.appendChild(overlay);
  renderLoader();
  // En Bloque B, acá va la llamada real; por ahora simula la lectura.
  setTimeout(() => renderContenido(MOCK), 1980);
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

function cardSugerencia(s) {
  const card = document.createElement('div');
  card.className = 'jm-card';
  const pintarOpen = () => {
    card.className = 'jm-card';
    card.innerHTML = `
      <div class="top"><div class="ej">${s.nombre}</div></div>
      <div class="why">${s.why}</div>
      <div class="jm-actions"><button class="jm-assign">Asignar</button><button class="jm-discard">Descartar</button></div>`;
    card.querySelector('.jm-assign').addEventListener('click', pintarAssigned);
    card.querySelector('.jm-discard').addEventListener('click', pintarDismissed);
  };
  const pintarAssigned = () => {
    card.className = 'jm-card assigned';
    card.innerHTML = `
      <div class="top"><div class="jm-check"><svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 6.5 L5 9 L9.5 3.5"/></svg></div><div class="ej">${s.nombre}</div></div>
      <div class="jm-assigned-row"><span class="ok">Asignado a la rutina</span><button class="jm-undo">Deshacer</button></div>`;
    card.querySelector('.jm-undo').addEventListener('click', pintarOpen);
    // En Bloque C: acá se llama a toggleOn(...) y se registra en eventos.
  };
  const pintarDismissed = () => {
    card.className = 'jm-card dismissed';
    card.innerHTML = `<span class="ej">${s.nombre}</span><button class="jm-undo">Deshacer</button>`;
    card.querySelector('.jm-undo').addEventListener('click', pintarOpen);
  };
  pintarOpen();
  return card;
}
