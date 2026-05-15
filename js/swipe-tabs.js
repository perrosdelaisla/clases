/**
 * SWIPE TABS — Helper de navegación lateral entre tabs.
 *
 * Conecta un contenedor que envuelve a los paneles de tabs con la lista
 * de IDs (o claves) de tabs y una función de cambio. Cuando el usuario
 * desliza horizontalmente, dispara onChange con el próximo o anterior
 * tab.
 *
 * Uso:
 *   initSwipeTabs({
 *     container: document.querySelector('.tab-panels-wrapper'),
 *     tabs: ['rutina', 'reservar', 'mis-citas', 'salud'],
 *     getCurrent: () => state.currentTab,
 *     onChange: (newTab) => showTab(newTab),
 *   });
 *
 * Notas:
 * - El "container" es el elemento que envuelve TODOS los paneles de tabs.
 * - Bind idempotente por container — si lo llamás dos veces, ignora la 2da.
 * - Distingue swipe horizontal de scroll vertical (si el primer movimiento
 *   es más vertical, suelta el tracking y deja que el browser scrollee).
 * - Bloquea el gesto cuando el usuario interactúa con inputs / botones,
 *   excepto sobre tarjetas de slot/calendario donde sí queremos swipear.
 * - Bonus: funciona con drag de mouse en escritorio (debug y desktop UX).
 */
export function initSwipeTabs({ container, tabs, getCurrent, onChange }) {
    if (!container || !tabs || tabs.length < 2 || typeof onChange !== 'function') return;
    if (container.__swipeTabsBound) return;
    container.__swipeTabsBound = true;

    const UMBRAL_PX = 50;
    const UMBRAL_VELOCIDAD = 0.3; // px/ms
    const TOLERANCIA_VERTICAL = 0.7;

    let startX = 0;
    let startY = 0;
    let startTime = 0;
    let trackingActivo = false;
    let direccionDecidida = null; // 'h' | 'v' | null

    const onStart = (e) => {
        // Si el target es un input/select/button/anchor propio, no capturamos —
        // salvo que esté dentro de una card de slot/calendario (donde el botón
        // ocupa toda la celda y queremos poder iniciar el swipe desde ahí).
        const tag = (e.target.tagName || '').toLowerCase();
        if (['input', 'select', 'textarea', 'button', 'a'].includes(tag)) {
            if (!e.target.closest('.slot-card, .cal-dia, .perro-foto-btn')) {
                return;
            }
        }
        const touch = e.touches ? e.touches[0] : e;
        startX = touch.clientX;
        startY = touch.clientY;
        startTime = Date.now();
        trackingActivo = true;
        direccionDecidida = null;
    };

    const onMove = (e) => {
        if (!trackingActivo) return;
        const touch = e.touches ? e.touches[0] : e;
        const dx = touch.clientX - startX;
        const dy = touch.clientY - startY;

        if (direccionDecidida === null) {
            if (Math.abs(dx) > 12 || Math.abs(dy) > 12) {
                direccionDecidida = Math.abs(dy) > Math.abs(dx) * TOLERANCIA_VERTICAL ? 'v' : 'h';
                if (direccionDecidida === 'v') {
                    trackingActivo = false; // soltamos: es scroll vertical
                }
            }
        }
    };

    const onEnd = (e) => {
        if (!trackingActivo || direccionDecidida !== 'h') {
            trackingActivo = false;
            return;
        }
        const touch = e.changedTouches ? e.changedTouches[0] : e;
        const dx = touch.clientX - startX;
        const dt = Math.max(1, Date.now() - startTime);
        const velocidad = Math.abs(dx) / dt;

        trackingActivo = false;
        direccionDecidida = null;

        if (Math.abs(dx) < UMBRAL_PX) return;
        if (velocidad < UMBRAL_VELOCIDAD) return;

        const tabActual = typeof getCurrent === 'function' ? getCurrent() : null;
        const idx = tabs.indexOf(tabActual);
        if (idx === -1) return;

        // dx negativo = swipe izquierda = ir al SIGUIENTE tab
        // dx positivo = swipe derecha   = ir al ANTERIOR tab
        const nuevoIdx = dx < 0 ? idx + 1 : idx - 1;
        if (nuevoIdx < 0 || nuevoIdx >= tabs.length) return;

        onChange(tabs[nuevoIdx]);
    };

    // Touch
    container.addEventListener('touchstart', onStart, { passive: true });
    container.addEventListener('touchmove',  onMove,  { passive: true });
    container.addEventListener('touchend',   onEnd,   { passive: true });
    container.addEventListener('touchcancel', () => { trackingActivo = false; }, { passive: true });

    // Mouse (escritorio, bonus)
    let mouseDown = false;
    container.addEventListener('mousedown', (e) => { mouseDown = true; onStart(e); });
    container.addEventListener('mousemove', (e) => { if (mouseDown) onMove(e); });
    container.addEventListener('mouseup',   (e) => { if (mouseDown) { onEnd(e); mouseDown = false; } });
    container.addEventListener('mouseleave', () => { mouseDown = false; trackingActivo = false; });
}
