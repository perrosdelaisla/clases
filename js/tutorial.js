// =====================================================================
// tutorial.js — Motor del tour de la app cliente.
//
// Lee los pasos de `window.PDLI_TUTORIAL_PASOS` (definidos en
// `tutorial-pasos.js`) y monta sobre la app:
//   · Un botón discreto "?" en el header (junto al avatar) para abrir
//     el tour cuando el usuario quiera.
//   · Un overlay oscuro con un hueco recortado al elemento destacado.
//   · Un tooltip con título, texto, navegación (← / →), botón "saltar"
//     y un botón "Escuchar" que usa la Web Speech API del navegador
//     (TTS), sin archivos de audio que mantener.
//   · Auto-apertura la primera vez (flag `localStorage.pdli_tutorial_visto`).
//
// El motor NO toca lógica existente de la app: para cambiar de tab,
// hace click en el botón correspondiente del `.bottom-nav`, que es el
// flujo natural que ya funcionaba.
//
// Para agregar/editar pasos, ver `tutorial-pasos.js`. No hace falta
// tocar este archivo cuando crezca la app.
// =====================================================================

(function () {
    'use strict';

    // ----- Constantes -----
    const STORAGE_KEY = 'pdli_tutorial_visto';
    const BTN_ID = 'btn-tutorial';
    const ROOT_ID = 'pdli-tour-root';
    const PASOS = Array.isArray(window.PDLI_TUTORIAL_PASOS)
        ? window.PDLI_TUTORIAL_PASOS
        : [];

    // ----- Estado -----
    let indice = 0;
    let abierto = false;
    let utterActual = null;
    let voz = null;

    // ----- Utils -----
    function $(sel, root = document) {
        return root.querySelector(sel);
    }

    function esperar(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    // Carga la voz española una vez. `getVoices()` puede devolver vacío
    // en el primer tick; en ese caso esperamos al evento `voiceschanged`.
    function cargarVoz() {
        if (voz) return Promise.resolve(voz);
        if (!('speechSynthesis' in window)) return Promise.resolve(null);

        return new Promise((resolve) => {
            const elegir = () => {
                const voces = window.speechSynthesis.getVoices();
                if (!voces.length) return false;
                // Preferimos español de España, luego cualquier español, luego nada.
                voz =
                    voces.find((v) => /^es-ES/i.test(v.lang)) ||
                    voces.find((v) => /^es/i.test(v.lang)) ||
                    null;
                resolve(voz);
                return true;
            };
            if (elegir()) return;
            const handler = () => {
                if (elegir()) {
                    window.speechSynthesis.removeEventListener('voiceschanged', handler);
                }
            };
            window.speechSynthesis.addEventListener('voiceschanged', handler);
            // Por las dudas, resolvemos a null tras 1s si nunca llega voz.
            setTimeout(() => resolve(voz || null), 1000);
        });
    }

    function pararTts() {
        if (!('speechSynthesis' in window)) return;
        try {
            window.speechSynthesis.cancel();
        } catch (_e) {
            /* no-op */
        }
        utterActual = null;
        actualizarBtnPlay(false);
    }

    function hablar(texto) {
        if (!('speechSynthesis' in window) || !texto) return;
        pararTts();
        const utter = new SpeechSynthesisUtterance(texto);
        utter.lang = voz ? voz.lang : 'es-ES';
        if (voz) utter.voice = voz;
        utter.rate = 1;
        utter.pitch = 1;
        utter.onend = () => {
            if (utterActual === utter) {
                utterActual = null;
                actualizarBtnPlay(false);
            }
        };
        utter.onerror = utter.onend;
        utterActual = utter;
        actualizarBtnPlay(true);
        window.speechSynthesis.speak(utter);
    }

    function actualizarBtnPlay(reproduciendo) {
        const btn = $('#pdli-tour-play');
        if (!btn) return;
        btn.dataset.estado = reproduciendo ? 'on' : 'off';
        btn.setAttribute(
            'aria-label',
            reproduciendo ? 'Pausar narración' : 'Escuchar narración'
        );
        btn.innerHTML = reproduciendo
            ? '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg><span>Pausar</span>'
            : '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg><span>Escuchar</span>';
    }

    // ----- Cambio de tab usando el flujo natural de la app -----
    async function asegurarTab(slug) {
        if (!slug) return;
        const tabActivaPanel = document.querySelector('.tab-panel.is-active');
        const actual = tabActivaPanel ? tabActivaPanel.dataset.tab : null;
        if (actual === slug) return;
        const btn = document.querySelector(
            '.bottom-nav__btn[data-tab-target="' + slug + '"]'
        );
        if (btn) {
            btn.click();
            // Damos un par de frames para que se monte el panel destino.
            await esperar(60);
        }
    }

    // ----- Render del DOM del tour -----
    function montarDom() {
        if (document.getElementById(ROOT_ID)) return;
        const root = document.createElement('div');
        root.id = ROOT_ID;
        root.className = 'pdli-tour';
        root.setAttribute('hidden', '');
        root.setAttribute('aria-hidden', 'true');
        root.innerHTML = `
            <svg class="pdli-tour__overlay" aria-hidden="true" preserveAspectRatio="none">
                <defs>
                    <mask id="pdli-tour-mask">
                        <rect class="pdli-tour__mask-bg" x="0" y="0" width="100%" height="100%" fill="white"/>
                        <rect class="pdli-tour__mask-hole" x="0" y="0" width="0" height="0" rx="12" ry="12" fill="black"/>
                    </mask>
                </defs>
                <rect x="0" y="0" width="100%" height="100%" fill="rgba(0,0,0,0.72)" mask="url(#pdli-tour-mask)"/>
            </svg>
            <div class="pdli-tour__tooltip" role="dialog" aria-modal="true" aria-labelledby="pdli-tour-titulo">
                <div class="pdli-tour__arrow" data-pos="bottom"></div>
                <div class="pdli-tour__contador" id="pdli-tour-contador"></div>
                <h3 class="pdli-tour__titulo" id="pdli-tour-titulo"></h3>
                <p class="pdli-tour__texto" id="pdli-tour-texto"></p>
                <div class="pdli-tour__actions">
                    <button type="button" class="pdli-tour__btn pdli-tour__btn--ghost" id="pdli-tour-saltar">Saltar</button>
                    <div class="pdli-tour__nav">
                        <button type="button" class="pdli-tour__play" id="pdli-tour-play" data-estado="off" aria-label="Escuchar narración">
                            <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg><span>Escuchar</span>
                        </button>
                        <button type="button" class="pdli-tour__btn pdli-tour__btn--ghost" id="pdli-tour-prev" aria-label="Paso anterior">←</button>
                        <button type="button" class="pdli-tour__btn" id="pdli-tour-next">Siguiente</button>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(root);

        // Listeners
        $('#pdli-tour-saltar').addEventListener('click', cerrar);
        $('#pdli-tour-prev').addEventListener('click', anterior);
        $('#pdli-tour-next').addEventListener('click', siguiente);
        $('#pdli-tour-play').addEventListener('click', toggleTts);
        // Overlay clic NO cierra: evitamos cierres accidentales en móvil.
        // Cierre con ESC.
        document.addEventListener('keydown', (e) => {
            if (!abierto) return;
            if (e.key === 'Escape') cerrar();
            else if (e.key === 'ArrowRight') siguiente();
            else if (e.key === 'ArrowLeft') anterior();
        });

        // Reposicionar en resize / scroll (el scroll del overlay no llega a la
        // página de fondo, pero sí puede cambiar la posición del target si la
        // app abajo se reflowea por algún motivo).
        let raf = null;
        const onLayout = () => {
            if (!abierto) return;
            if (raf) cancelAnimationFrame(raf);
            raf = requestAnimationFrame(() => {
                renderPaso();
                raf = null;
            });
        };
        window.addEventListener('resize', onLayout);
        window.addEventListener('orientationchange', onLayout);
    }

    function montarBoton() {
        if (document.getElementById(BTN_ID)) return;
        // Tras el rediseño del home, el header es .ctop > .ctop-right (con
        // .cdogs y .cavatar). Montamos el botón "?" dentro de .ctop-right.
        const menu = document.querySelector('.ctop-right');
        if (!menu) return;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.id = BTN_ID;
        btn.className = 'tutorial-btn';
        btn.setAttribute('aria-label', 'Abrir tutorial de la app');
        btn.title = 'Tutorial';
        btn.innerHTML =
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
            '<circle cx="12" cy="12" r="9"/>' +
            '<path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.8.4-1.3 1-1.3 1.9V14"/>' +
            '<circle cx="12" cy="17" r="0.6" fill="currentColor"/>' +
            '</svg>';
        btn.addEventListener('click', () => abrir(0));
        // Lo insertamos ANTES del avatar (.cavatar) para que el avatar siga
        // siendo el último elemento del header (foco visual derecho).
        const avatar = menu.querySelector('.cavatar');
        if (avatar) menu.insertBefore(btn, avatar);
        else menu.appendChild(btn);
    }

    // ----- Posicionamiento del hueco y del tooltip -----
    function clamp(n, min, max) {
        return Math.max(min, Math.min(max, n));
    }

    async function actualizarHueco(target) {
        const hole = $('.pdli-tour__mask-hole');
        if (!hole) return null;
        if (!target) {
            hole.setAttribute('width', '0');
            hole.setAttribute('height', '0');
            return null;
        }
        // Scroll suave hacia el target antes de medir.
        try {
            target.scrollIntoView({ behavior: 'instant', block: 'center' });
        } catch (_e) {
            target.scrollIntoView();
        }
        await esperar(20);
        const r = target.getBoundingClientRect();
        const pad = 6;
        const x = clamp(r.left - pad, 0, window.innerWidth);
        const y = clamp(r.top - pad, 0, window.innerHeight);
        const w = Math.min(r.width + pad * 2, window.innerWidth - x);
        const h = Math.min(r.height + pad * 2, window.innerHeight - y);
        hole.setAttribute('x', String(x));
        hole.setAttribute('y', String(y));
        hole.setAttribute('width', String(w));
        hole.setAttribute('height', String(h));
        return { x, y, w, h };
    }

    function colocarTooltip(rect, posPref) {
        const tooltip = $('.pdli-tour__tooltip');
        const arrow = $('.pdli-tour__arrow');
        if (!tooltip) return;
        tooltip.style.visibility = 'hidden';
        tooltip.classList.remove('pdli-tour__tooltip--center');
        if (!rect || posPref === 'center') {
            tooltip.classList.add('pdli-tour__tooltip--center');
            tooltip.style.top = '';
            tooltip.style.left = '';
            arrow.style.display = 'none';
            tooltip.style.visibility = '';
            return;
        }
        arrow.style.display = '';

        const margin = 12;
        const tw = tooltip.offsetWidth;
        const th = tooltip.offsetHeight;
        const vw = window.innerWidth;
        const vh = window.innerHeight;

        // Decidir lado
        const espacioAbajo = vh - (rect.y + rect.h);
        const espacioArriba = rect.y;
        let lado = posPref;
        if (!lado || lado === 'auto') {
            lado = espacioAbajo >= th + margin || espacioAbajo >= espacioArriba ? 'bottom' : 'top';
        }
        if (lado === 'bottom' && espacioAbajo < th + margin && espacioArriba > espacioAbajo) {
            lado = 'top';
        }
        if (lado === 'top' && espacioArriba < th + margin && espacioAbajo > espacioArriba) {
            lado = 'bottom';
        }

        const cx = rect.x + rect.w / 2;
        const left = clamp(cx - tw / 2, margin, vw - tw - margin);
        let top;
        if (lado === 'bottom') {
            top = rect.y + rect.h + margin;
            arrow.dataset.pos = 'top'; // la flecha del tooltip apunta hacia arriba
        } else {
            top = rect.y - th - margin;
            arrow.dataset.pos = 'bottom';
        }
        top = clamp(top, margin, vh - th - margin);

        tooltip.style.left = left + 'px';
        tooltip.style.top = top + 'px';

        // Centrar flecha respecto del target
        const arrowLeft = clamp(cx - left, 16, tw - 16);
        arrow.style.left = arrowLeft + 'px';

        tooltip.style.visibility = '';
    }

    // ----- Flujo -----
    async function renderPaso() {
        if (!PASOS.length) return cerrar();
        indice = clamp(indice, 0, PASOS.length - 1);
        const paso = PASOS[indice];

        await asegurarTab(paso.tab);

        const target = paso.selector ? document.querySelector(paso.selector) : null;
        const rect = await actualizarHueco(target);

        $('#pdli-tour-titulo').textContent = paso.titulo || '';
        $('#pdli-tour-texto').textContent = paso.texto || '';
        $('#pdli-tour-contador').textContent =
            (indice + 1) + ' de ' + PASOS.length;

        const btnPrev = $('#pdli-tour-prev');
        const btnNext = $('#pdli-tour-next');
        btnPrev.disabled = indice === 0;
        btnNext.textContent = indice === PASOS.length - 1 ? 'Terminar' : 'Siguiente';

        colocarTooltip(rect, paso.posicion);

        // Cancelamos cualquier narración del paso anterior.
        pararTts();
    }

    function toggleTts() {
        if (utterActual && window.speechSynthesis.speaking) {
            pararTts();
            return;
        }
        const paso = PASOS[indice];
        if (!paso) return;
        const texto = (paso.titulo ? paso.titulo + '. ' : '') + (paso.texto || '');
        cargarVoz().then(() => hablar(texto));
    }

    function siguiente() {
        if (indice >= PASOS.length - 1) return cerrar();
        indice += 1;
        renderPaso();
    }

    function anterior() {
        if (indice <= 0) return;
        indice -= 1;
        renderPaso();
    }

    function abrir(desdeIndice) {
        if (!PASOS.length) return;
        montarDom();
        montarBoton();
        const root = document.getElementById(ROOT_ID);
        if (!root) return;
        indice = typeof desdeIndice === 'number' ? desdeIndice : 0;
        abierto = true;
        root.removeAttribute('hidden');
        root.setAttribute('aria-hidden', 'false');
        document.documentElement.classList.add('pdli-tour-open');
        // Cargamos la voz en paralelo, sin bloquear el render.
        cargarVoz();
        renderPaso();
    }

    function cerrar() {
        pararTts();
        abierto = false;
        const root = document.getElementById(ROOT_ID);
        if (root) {
            root.setAttribute('hidden', '');
            root.setAttribute('aria-hidden', 'true');
        }
        document.documentElement.classList.remove('pdli-tour-open');
        try {
            localStorage.setItem(STORAGE_KEY, '1');
        } catch (_e) {
            /* localStorage puede fallar en modo privado */
        }
    }

    // ----- Auto-apertura primera vez -----
    // Esperamos a que la screen de la app esté visible (login OK) y a que
    // el header exista. La app aplica `hidden` a `#screen-app` hasta que
    // el usuario inicia sesión.
    function iniciar() {
        montarBoton();
        // Auto-apertura desactivada: en la primera vez ahora se presenta Jaime
        // (burbuja de bienvenida) y desde ahí se ofrece lanzar el tutorial. El
        // tour sigue disponible por su botón (montarBoton) y por
        // window.PdliTour.abrir(). El flag STORAGE_KEY se mantiene intacto.
    }

    // Exponemos un mini-API por si en el futuro quisiéramos abrirlo desde
    // otros sitios (ej: tras un cambio grande de la app, resetear el flag).
    window.PdliTour = {
        abrir: (i) => abrir(typeof i === 'number' ? i : 0),
        cerrar: cerrar,
        reset: () => {
            try {
                localStorage.removeItem(STORAGE_KEY);
            } catch (_e) {
                /* ignore */
            }
        },
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', iniciar);
    } else {
        iniciar();
    }
})();
