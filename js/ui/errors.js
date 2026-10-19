// Mensajes de error para el usuario, en español: los fallos de red del navegador llegan en
// inglés ("Failed to fetch", "NetworkError…", "Load failed").

export function errorText(err, fallback = 'Algo ha fallado.') {
  const msg = err?.message || '';
  if (err?.name === 'TypeError' && /fetch|network|load failed/i.test(msg)) {
    return navigator.onLine === false
      ? 'Sin conexión a internet.'
      : 'No se pudo conectar con el servidor. Comprueba la conexión e inténtalo de nuevo.';
  }
  return msg || fallback;
}

/** Cómo deshacer, según el dispositivo: en táctil no hay Ctrl+Z, está el botón ↶. */
export const undoHint = () =>
  matchMedia('(pointer: coarse)').matches ? 'botón ↶ para deshacer' : 'Ctrl+Z para deshacer';
