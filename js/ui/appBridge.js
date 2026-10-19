// Puente con la app de Android cuando el planificador va dentro de ella (WebView).
// En el navegador normal no existe window.MotoRutaApp y todo funciona como siempre.

const app = window.MotoRutaApp;

export const inApp = !!app;

/**
 * Guarda la ruta (contenido de un .motoruta) en «Mis rutas» de la app y la abre en el
 * navegador. `id`: la ruta que se está editando (se sobrescribe) o null para una nueva.
 * Devuelve el id con el que ha quedado guardada.
 */
export function openInNavigator(json, id) {
  return app.openInNavigator(json, id || '');
}

/** Guarda la ruta en «Mis rutas» sin salir del planificador. Devuelve su id. */
export function saveToLibrary(json, id) {
  return app.saveRoute(json, id || '');
}

/** Comparte un archivo (GPX) con el menú de compartir de Android. */
export function shareFile(fileName, content, mime) {
  app.shareFile(fileName, content, mime);
}

/** Vuelve al menú principal de la app. */
export function goHome() {
  app.goHome();
}

/**
 * «Editar» desde Mis rutas: la app deja una ruta pendiente y avisa con
 * window.__motorutaCheckPlan(); también se mira al arrancar.
 * callback({plan: {name, waypoints, options, departure}, id})
 */
export function onPlanFromApp(callback) {
  if (!app) return;
  window.__motorutaCheckPlan = () => {
    const pending = app.consumePendingPlan();
    if (pending) callback(JSON.parse(pending));
  };
  // después de restaurar la ruta en curso al arrancar (si no, la pisaría)
  setTimeout(window.__motorutaCheckPlan, 0);
}
