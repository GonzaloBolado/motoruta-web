// Gasolineras en ruta con precios del día (API oficial del Ministerio, solo España).
// Se descargan por provincia, solo las que cruza la ruta, y se guardan en caché el día.

import { resample } from './geometry.js';

const API =
  'https://sedeaplicaciones.minetur.gob.es/ServiciosRESTCarburantes/PreciosCarburantes/EstacionesTerrestres/FiltroProvincia/';

// [id, latMin, lngMin, latMax, lngMax], calculado con las propias gasolineras del listado
const PROVINCES = [
  ['01', 42.49, -3.12, 43.15, -2.31], ['02', 38.15, -2.75, 39.37, -0.94], ['03', 37.86, -1.05, 38.86, 0.19],
  ['04', 36.71, -3.0, 37.86, -1.66], ['05', 40.14, -5.52, 41.13, -4.33], ['06', 38.03, -7.17, 39.36, -4.95],
  ['07', 38.71, 1.3, 40.01, 4.27], ['08', 41.19, 1.36, 42.32, 2.78], ['09', 41.57, -4.25, 43.17, -2.7],
  ['10', 39.13, -7.3, 40.38, -5.2], ['11', 36.02, -6.43, 36.93, -5.16], ['12', 39.74, -0.7, 40.66, 0.48],
  ['13', 38.43, -4.97, 39.46, -2.69], ['14', 37.23, -5.44, 38.57, -4.1], ['15', 42.55, -9.27, 43.73, -7.85],
  ['16', 39.33, -3.08, 40.45, -1.27], ['17', 41.68, 1.92, 42.46, 3.28], ['18', 36.7, -4.28, 37.98, -2.33],
  ['19', 40.3, -3.45, 41.21, -1.68], ['20', 42.95, -2.54, 43.36, -1.75], ['21', 37.02, -7.41, 38.14, -6.22],
  ['22', 41.41, -0.79, 42.77, 0.73], ['23', 37.41, -4.26, 38.41, -2.56], ['24', 42.08, -6.92, 43.01, -4.98],
  ['25', 41.37, 0.39, 42.83, 1.85], ['26', 41.98, -3.01, 42.58, -1.73], ['27', 42.47, -7.93, 43.69, -7.02],
  ['28', 39.88, -4.58, 41.17, -3.05], ['29', 36.33, -5.34, 37.27, -3.88], ['30', 37.39, -1.97, 38.62, -0.71],
  ['31', 41.93, -2.37, 43.31, -0.94], ['32', 41.83, -8.25, 42.51, -6.98], ['33', 43.04, -7.15, 43.61, -4.56],
  ['34', 41.79, -4.97, 42.89, -4.08], ['35', 27.75, -15.8, 29.15, -13.46], ['36', 41.85, -8.9, 42.8, -8.05],
  ['37', 40.34, -6.82, 41.24, -5.2], ['38', 27.71, -18.01, 28.83, -16.21], ['39', 42.75, -4.85, 43.52, -3.15],
  ['40', 40.71, -4.7, 41.44, -3.38], ['41', 36.85, -6.32, 38.09, -4.68], ['42', 41.17, -3.19, 42.03, -1.93],
  ['43', 40.53, 0.28, 41.54, 1.62], ['44', 40.06, -1.65, 41.22, 0.21], ['45', 39.35, -5.33, 40.24, -2.99],
  ['46', 38.74, -1.44, 40.13, -0.07], ['47', 41.18, -5.33, 42.16, -4.11], ['48', 42.99, -3.36, 43.42, -2.5],
  ['49', 41.17, -6.84, 42.09, -5.32], ['50', 41.12, -2.12, 42.49, 0.25], ['51', 35.88, -5.34, 35.89, -5.3],
  ['52', 35.27, -2.95, 35.3, -2.93],
];

const MAX_DISTANCE_M = 300; // a esta distancia de la ruta cuenta como "en ruta"
const memory = new Map();

const num = (s) => (s ? parseFloat(String(s).replace(',', '.')) : null);

/** Todas las gasolineras de las provincias que cruza la ruta, situadas por km. */
export async function fuelStationsAlongRoute(route, signal) {
  const coords = route.legs.flatMap((leg, i) => (i === 0 ? leg.coords : leg.coords.slice(1)));
  const ids = provincesFor(coords);
  const lists = await Promise.all(ids.map((id) => loadProvince(id, signal)));
  return locateOnRoute(lists.flat(), coords);
}

/**
 * Gasolineras a menos de `maxM` de la ruta, aunque no estén en ella: para buscarlas en la
 * moto si hacen falta. Las provincias ya están en caché por fuelStationsAlongRoute.
 */
export async function fuelNearRoute(route, maxM = 8_000, signal) {
  const coords = route.legs.flatMap((leg, i) => (i === 0 ? leg.coords : leg.coords.slice(1)));
  const ids = provincesFor(coords);
  const stations = (await Promise.all(ids.map((id) => loadProvince(id, signal)))).flat();
  const pts = resample(coords, 1_000);
  const kLat = 111_195;
  const near = (s) =>
    pts.some(([lat, lng]) => {
      const dy = (s.lat - lat) * kLat;
      const dx = (s.lng - lng) * kLat * Math.cos((lat * Math.PI) / 180);
      return dx * dx + dy * dy < maxM * maxM;
    });
  const seen = new Set();
  return stations.filter((s) => !seen.has(s.id) && seen.add(s.id) && near(s));
}

function provincesFor(coords) {
  const pad = 0.05;
  const step = Math.max(1, Math.floor(coords.length / 2000));
  const ids = new Set();
  for (let i = 0; i < coords.length; i += step) {
    const [lat, lng] = coords[i];
    for (const [id, s, w, n, e] of PROVINCES) {
      if (lat >= s - pad && lat <= n + pad && lng >= w - pad && lng <= e + pad) ids.add(id);
    }
  }
  return [...ids];
}

async function loadProvince(id, signal) {
  if (memory.has(id)) return memory.get(id);

  // los precios cambian a diario: la caché vale para hoy
  const today = new Date().toISOString().slice(0, 10);
  const key = `motoruta.fuel.${id}`;
  try {
    const cached = JSON.parse(localStorage.getItem(key));
    if (cached?.date === today) {
      memory.set(id, cached.stations);
      return cached.stations;
    }
  } catch {}

  const res = await fetch(API + id, { signal, headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error('No se pudieron cargar las gasolineras');
  const data = await res.json();
  const stations = data.ListaEESSPrecio.map((s) => ({
    id: s.IDEESS,
    lat: num(s.Latitud),
    lng: num(s['Longitud (WGS84)']),
    brand: s['Rótulo'],
    address: `${s['Dirección']}, ${s.Localidad}`,
    hours: s.Horario,
    p95: num(s['Precio Gasolina 95 E5']) || num(s['Precio Gasolina 95 E10']),
    p98: num(s['Precio Gasolina 98 E5']) || num(s['Precio Gasolina 98 E10']),
    diesel: num(s['Precio Gasoleo A']),
  })).filter((s) => s.lat && s.lng);

  memory.set(id, stations);
  try {
    localStorage.setItem(key, JSON.stringify({ date: today, stations }));
  } catch {}
  return stations;
}

// Distancia de cada gasolinera a la ruta usando una rejilla de ~1 km para no comparar
// cada gasolinera con todos los puntos de la ruta.
function locateOnRoute(stations, coords) {
  const CELL = 0.01;
  const cellKey = (lat, lng) => `${Math.floor(lat / CELL)},${Math.floor(lng / CELL)}`;
  const kLat = 111320;
  const kLng = 111320 * Math.cos((coords[0][0] * Math.PI) / 180);

  const cum = [0];
  const grid = new Map();
  for (let i = 0; i < coords.length - 1; i++) {
    const [a, b] = [coords[i], coords[i + 1]];
    const len = Math.hypot((b[0] - a[0]) * kLat, (b[1] - a[1]) * kLng);
    cum.push(cum[i] + len);
    for (const c of new Set([cellKey(a[0], a[1]), cellKey(b[0], b[1])])) {
      if (!grid.has(c)) grid.set(c, []);
      grid.get(c).push(i);
    }
  }

  const found = [];
  for (const s of stations) {
    const cy = Math.floor(s.lat / CELL);
    const cx = Math.floor(s.lng / CELL);
    let best = null;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        for (const i of grid.get(`${cy + dy},${cx + dx}`) || []) {
          // proyección del punto sobre el segmento en metros locales
          const ax = coords[i][1] * kLng, ay = coords[i][0] * kLat;
          const bx = coords[i + 1][1] * kLng, by = coords[i + 1][0] * kLat;
          const px = s.lng * kLng, py = s.lat * kLat;
          const vx = bx - ax, vy = by - ay;
          const t = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / (vx * vx + vy * vy || 1)));
          const d = Math.hypot(ax + t * vx - px, ay + t * vy - py);
          if (!best || d < best.d) best = { d, km: (cum[i] + t * (cum[i + 1] - cum[i])) / 1000 };
        }
      }
    }
    if (best && best.d <= MAX_DISTANCE_M) found.push({ ...s, km: best.km, offsetM: Math.round(best.d) });
  }
  return found.sort((a, b) => a.km - b.km);
}
