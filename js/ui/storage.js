// Persistencia local (localStorage). La ruta en curso se guarda sola en cada cambio.

const CURRENT = 'motoruta.current';
const SAVED = 'motoruta.saved';

function read(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (err) {
    console.warn('No se pudo guardar en localStorage', err);
  }
}

export const loadCurrent = () => read(CURRENT, null);
export const saveCurrent = (data) => write(CURRENT, data);

export const listSaved = () => read(SAVED, []).sort((a, b) => b.savedAt - a.savedAt);

/** Guarda una ruta; si ya existe una con el mismo nombre, la sobrescribe. */
export function upsertSaved(route) {
  const all = read(SAVED, []);
  const existing = all.find((r) => r.name === route.name);
  const entry = { ...route, id: existing?.id || crypto.randomUUID(), savedAt: Date.now() };
  write(SAVED, existing ? all.map((r) => (r.id === existing.id ? entry : r)) : [...all, entry]);
}

export function deleteSaved(id) {
  write(SAVED, read(SAVED, []).filter((r) => r.id !== id));
}
