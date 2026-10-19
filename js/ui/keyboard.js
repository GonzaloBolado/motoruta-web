// Teclado del móvil: se oculta al tocar fuera del campo de texto (en un WebView no siempre
// pasa solo, y el teclado tapaba los botones de abajo, como «Navegar esta ruta»).

const isTextField = (el) =>
  el instanceof HTMLTextAreaElement ||
  (el instanceof HTMLInputElement && !['checkbox', 'radio', 'button', 'submit', 'range', 'file'].includes(el.type));

/** Quita el foco del campo de texto activo (y con él, el teclado). */
export function hideKeyboard() {
  if (isTextField(document.activeElement)) document.activeElement.blur();
}

export function initKeyboard() {
  document.addEventListener(
    'pointerdown',
    (e) => {
      const active = document.activeElement;
      if (!isTextField(active)) return;
      const t = e.target;
      // tocar otro campo, el mismo, sus sugerencias o el calendario: el teclado sigue
      if (t === active || isTextField(t) || t.closest?.('.search-results, .calendar')) return;
      active.blur();
    },
    true
  );
}
