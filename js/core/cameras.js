// Radares fijos a lo largo de la ruta, de OpenStreetMap (highway=speed_camera), para el
// navegador del móvil (van en el .motoruta; el planificador no los pinta).
// Una sola consulta a Overpass con una caja por cada tramo de ~40 km de ruta; después se
// quedan solo los que están pegados al trazado.

import { overpass } from './protected.js';

const PIECE_M = 40_000;
// la ruta va por las vías de OSM: un radar de nuestra calzada está casi encima; el de la
// calzada contraria de una autovía queda a 15-30 m y no cuenta
const MAX_DIST_M = 12;
const MARGIN_DEG = 0.003; // ~300 m alrededor de cada tramo

/** [{lat, lng, maxspeed}] en el orden de la ruta (maxspeed en km/h o null). */
export async function camerasAlongRoute(coords, signal) {
  if (coords.length < 2) return [];
  const boxes = pieceBoxes(coords);
  const query =
    '[out:json][timeout:90];(' +
    boxes.map((b) => `node["highway"="speed_camera"](${b.map((v) => v.toFixed(4)).join(',')});`).join('') +
    ');out;';
  const data = await overpass(query, signal);
  const seen = new Set();
  const out = [];
  for (const e of data.elements || []) {
    if (e.type !== 'node' || seen.has(e.id)) continue;
    seen.add(e.id);
    const along = alongRoute(coords, [e.lat, e.lon]);
    if (along === null) continue;
    out.push({ lat: e.lat, lng: e.lon, maxspeed: parseSpeed(e.tags?.maxspeed), along });
  }
  return out.sort((a, b) => a.along - b.along).map(({ along, ...c }) => c);
}

/** «80», «80 km/h», «ES:urban»… → km/h o null. */
function parseSpeed(v) {
  const n = parseInt(String(v || ''), 10);
  return Number.isFinite(n) && n > 0 && n <= 150 ? n : null;
}

/** Cajas [sur, oeste, norte, este] de cada tramo de la ruta. */
function pieceBoxes(coords) {
  const boxes = [];
  let box = null;
  let acc = 0;
  for (let i = 0; i < coords.length; i++) {
    const [lat, lng] = coords[i];
    if (!box) box = [lat, lng, lat, lng];
    box[0] = Math.min(box[0], lat);
    box[1] = Math.min(box[1], lng);
    box[2] = Math.max(box[2], lat);
    box[3] = Math.max(box[3], lng);
    if (i > 0) acc += distM(coords[i - 1], coords[i]);
    if (acc >= PIECE_M || i === coords.length - 1) {
      boxes.push([box[0] - MARGIN_DEG, box[1] - MARGIN_DEG, box[2] + MARGIN_DEG, box[3] + MARGIN_DEG]);
      box = [lat, lng, lat, lng]; // el siguiente empieza donde acaba este
      acc = 0;
    }
  }
  return boxes;
}

/** Metros sobre la ruta del punto más cercano, si está a menos de MAX_DIST_M; si no, null. */
function alongRoute(coords, p) {
  let best = Infinity;
  let bestAlong = 0;
  let acc = 0;
  const kx = 111_320 * Math.cos((p[0] * Math.PI) / 180);
  const ky = 110_540;
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1];
    const b = coords[i];
    const segLen = distM(a, b);
    // descarte rápido: lejos de los dos extremos y del tramo
    const ax = (a[1] - p[1]) * kx;
    const ay = (a[0] - p[0]) * ky;
    if (Math.abs(ax) > segLen + 500 || Math.abs(ay) > segLen + 500) {
      acc += segLen;
      continue;
    }
    const bx = (b[1] - p[1]) * kx;
    const by = (b[0] - p[0]) * ky;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
    const d = Math.hypot(ax + t * dx, ay + t * dy);
    if (d < best) {
      best = d;
      bestAlong = acc + t * segLen;
    }
    acc += segLen;
  }
  return best <= MAX_DIST_M ? bestAlong : null;
}

function distM(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b[0] - a[0]);
  const dLng = toRad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
