// Hoja inferior del panel en móvil: se abre y se cierra tocando el asa o arrastrándola,
// y estando abierta se cierra también arrastrando hacia abajo desde arriba del contenido.

const OPEN_CLASS = 'sheet-open';
/** px de arrastre (o velocidad) a partir de los que se completa el gesto */
const THRESHOLD_PX = 60;
const FLING_PX_PER_MS = 0.5;

export function initSheet(sheet, handle) {
  const isMobile = () => getComputedStyle(handle).display !== 'none';
  const isOpen = () => document.body.classList.contains(OPEN_CLASS);
  const setOpen = (open) => document.body.classList.toggle(OPEN_CLASS, open);

  let drag = null; // {startY, lastY, lastT, v, fromOpen, moved, fromContent}

  // desplazamiento de la hoja (0 = abierta) mientras se arrastra
  const closedOffset = () => sheet.offsetHeight - handle.offsetHeight;
  const apply = (dy) => {
    const base = drag.fromOpen ? 0 : closedOffset();
    const y = Math.max(0, Math.min(closedOffset(), base + dy));
    sheet.style.transition = 'none';
    sheet.style.transform = `translateY(${y}px)`;
  };

  const start = (y, fromContent) => {
    drag = { startY: y, lastY: y, lastT: performance.now(), v: 0, fromOpen: isOpen(), moved: false, fromContent };
  };
  const move = (y) => {
    const now = performance.now();
    drag.v = (y - drag.lastY) / Math.max(1, now - drag.lastT);
    drag.lastY = y;
    drag.lastT = now;
    const dy = y - drag.startY;
    if (!drag.moved && Math.abs(dy) < 8) return;
    drag.moved = true;
    apply(dy);
  };
  const end = () => {
    const dy = drag.lastY - drag.startY;
    sheet.style.transition = '';
    sheet.style.transform = '';
    if (!drag.moved) {
      // toque simple en el asa: alterna
      if (!drag.fromContent) setOpen(!drag.fromOpen);
    } else if (dy < -THRESHOLD_PX || drag.v < -FLING_PX_PER_MS) {
      setOpen(true);
    } else if (dy > THRESHOLD_PX || drag.v > FLING_PX_PER_MS) {
      setOpen(false);
    } else {
      setOpen(drag.fromOpen);
    }
    drag = null;
  };

  // asa: toque o arrastre en cualquier sentido
  handle.style.touchAction = 'none';
  handle.addEventListener('pointerdown', (e) => {
    if (!isMobile()) return;
    handle.setPointerCapture(e.pointerId);
    start(e.clientY, false);
  });
  handle.addEventListener('pointermove', (e) => drag && !drag.fromContent && move(e.clientY));
  handle.addEventListener('pointerup', () => drag && !drag.fromContent && end());
  handle.addEventListener('pointercancel', () => drag && !drag.fromContent && end());
  // el click llega tras pointerup: ya se ha gestionado
  handle.addEventListener('click', (e) => e.preventDefault());

  // contenido: con la hoja abierta y arriba del todo, arrastrar hacia abajo la cierra
  // (si no, el gesto es el scroll normal de la hoja)
  sheet.addEventListener(
    'touchstart',
    (e) => {
      if (!isMobile() || !isOpen() || sheet.scrollTop > 0 || handle.contains(e.target)) return;
      start(e.touches[0].clientY, true);
    },
    { passive: true }
  );
  sheet.addEventListener(
    'touchmove',
    (e) => {
      if (!drag?.fromContent) return;
      const dy = e.touches[0].clientY - drag.startY;
      if (dy < 0 && !drag.moved) {
        drag = null; // hacia arriba: es scroll
        return;
      }
      e.preventDefault();
      move(e.touches[0].clientY);
    },
    { passive: false }
  );
  sheet.addEventListener('touchend', () => drag?.fromContent && end());
  sheet.addEventListener('touchcancel', () => drag?.fromContent && end());
}
