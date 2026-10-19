// Pistas (caminos de cabras) de la ruta: ¿pasan por una zona protegida o están prohibidas a
// las motos? Para enduro/trail; en carretera no aplica. Datos de OpenStreetMap vía Overpass:
//  - accesos de cada pista (motor_vehicle, motorcycle, vehicle, access), por su id de vía;
//  - espacios protegidos (parques nacionales y naturales, reservas, Red Natura…) que contienen
//    puntos de la pista, muestreados cada ~400 m.
// Es orientativo: estar en un espacio protegido no implica que esté prohibido circular, y
// OpenStreetMap puede no tener todos los espacios ni todas las prohibiciones.

const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const SAMPLE_M = 400;
const MAX_SAMPLES = 150;

// etiqueta de acceso que manda para una moto: de la más concreta a la más general
const ACCESS_KEYS = ['motorcycle', 'motor_vehicle', 'vehicle', 'access'];
const FORBIDDEN = new Set(['no', 'private', 'agricultural', 'forestry', 'delivery', 'military']);
const PERMIT = new Set(['permit', 'permissive_with_permit']);

// lo ya consultado no se vuelve a pedir (al arrastrar la ruta casi todo se repite):
// etiquetas de cada vía, y espacios que contiene cada punto (redondeado a ~100 m)
const wayTags = new Map(); // id → tags
const pointAreas = new Map(); // "lat,lng" → [id de espacio]
const areaInfo = new Map(); // id → {name, title, national}

/** Tramos de pista de la ruta: [{leg, from, to, coords, wayIds, name}] */
export function offroadPieces(route) {
  const out = [];
  route?.legs.forEach((leg, li) => {
    for (const s of leg.segments) {
      if (s.type !== 'cabras' || s.to <= s.from) continue;
      out.push({ leg: li, from: s.from, to: s.to, coords: leg.coords.slice(s.from, s.to + 1), wayIds: s.wayIds || [], name: s.name });
    }
  });
  return out;
}

/**
 * Comprueba las pistas de la ruta. Devuelve null si la ruta no tiene pistas, o
 * {km, areas: [{id, name, title, national, km, ranges}], forbidden: [{name, reason, km, ranges}],
 *  permit: [...], partial} — ranges: [[lat,lng],...] para pintar en el mapa.
 */
export async function checkOffroad(route, signal) {
  const pieces = offroadPieces(route);
  if (!pieces.length) return null;
  const km = pieces.reduce((a, p) => a + lengthM(p.coords), 0) / 1000;

  // una consulta detrás de otra: Overpass admite pocas a la vez por usuario
  const settle = (p) => p.then((value) => ({ status: 'fulfilled', value }), (reason) => ({ status: 'rejected', reason }));
  const access = await settle(checkAccess(pieces, signal));
  const areas = await settle(checkAreas(pieces, signal));
  if (signal?.aborted) throw new DOMException('Cancelado', 'AbortError');
  if (access.status === 'rejected' && areas.status === 'rejected') throw areas.reason;
  return {
    km,
    ...(access.status === 'fulfilled' ? access.value : { forbidden: [], permit: [] }),
    areas: areas.status === 'fulfilled' ? areas.value : [],
    // si una de las dos consultas falló, se avisa de que el resultado está incompleto
    partial: access.status === 'rejected' || areas.status === 'rejected',
  };
}

// ---------- accesos de las pistas ----------

async function checkAccess(pieces, signal) {
  const ids = [...new Set(pieces.flatMap((p) => p.wayIds))];
  if (!ids.length) return { forbidden: [], permit: [] };
  const missing = ids.filter((id) => !wayTags.has(id));
  for (let i = 0; i < missing.length; i += 400) {
    const chunk = missing.slice(i, i + 400);
    const data = await overpass(`[out:json][timeout:60];way(id:${chunk.join(',')});out tags;`, signal);
    for (const id of chunk) wayTags.set(id, {}); // también las que ya no existen
    for (const e of data.elements) wayTags.set(e.id, e.tags || {});
  }
  const tags = wayTags;
  const forbidden = [];
  const permit = [];
  for (const p of pieces) {
    // un tramo agrupa varias vías: se juntan las que comparten veredicto
    for (const id of p.wayIds) {
      const t = tags.get(id);
      if (!t) continue;
      const key = ACCESS_KEYS.find((k) => t[k] != null);
      const value = key && String(t[key]).split(';')[0].trim();
      const list = FORBIDDEN.has(value) ? forbidden : PERMIT.has(value) ? permit : null;
      if (!list) continue;
      list.push({ id, name: t.name || t.ref || p.name || 'Pista sin nombre', reason: accessReason(key, value) });
    }
  }
  // geometría aproximada de cada vía: el tramo entero donde aparece
  const withShape = (list) => {
    const byReason = new Map();
    for (const f of list) {
      const piece = pieces.find((p) => p.wayIds.includes(f.id));
      const k = `${f.name}|${f.reason}`;
      const g = byReason.get(k) || { name: f.name, reason: f.reason, km: 0, ranges: [] };
      if (!g.ranges.includes(piece.coords)) {
        g.ranges.push(piece.coords);
        g.km += lengthM(piece.coords) / 1000;
      }
      byReason.set(k, g);
    }
    return [...byReason.values()];
  };
  return { forbidden: withShape(forbidden), permit: withShape(permit) };
}

function accessReason(key, value) {
  const who = key === 'motorcycle' ? 'motos' : key === 'access' ? 'todo el tráfico' : 'vehículos a motor';
  const why = {
    no: `prohibida a ${who}`,
    private: 'privada',
    agricultural: 'solo uso agrícola',
    forestry: 'solo uso forestal',
    delivery: 'solo reparto',
    military: 'uso militar',
    permit: 'requiere permiso',
    permissive_with_permit: 'requiere permiso',
  };
  return why[value] || value;
}

// ---------- espacios protegidos ----------

async function checkAreas(pieces, signal) {
  // puntos de muestra sobre las pistas (más separados si la ruta tiene muchos km de pista)
  const totalM = pieces.reduce((a, p) => a + lengthM(p.coords), 0);
  const step = Math.max(SAMPLE_M, totalM / MAX_SAMPLES);
  const samples = []; // {piece, idx, lat, lng}
  pieces.forEach((p, pi) => {
    let acc = step; // el primero en el arranque de la pista
    for (let i = 0; i < p.coords.length; i++) {
      if (i > 0) acc += distM(p.coords[i - 1], p.coords[i]);
      if (acc >= step || i === p.coords.length - 1) {
        samples.push({ piece: pi, idx: i, lat: p.coords[i][0], lng: p.coords[i][1] });
        acc = 0;
      }
    }
  });

  // solo se consultan los puntos nuevos
  const key = (s) => `${s.lat.toFixed(3)},${s.lng.toFixed(3)}`;
  const todo = [...new Set(samples.map(key))].filter((k) => !pointAreas.has(k));
  if (todo.length) await queryPoints(todo, signal);

  // qué espacios contienen cada muestra
  const areas = new Map();
  samples.forEach((s, si) => {
    for (const id of pointAreas.get(key(s)) || []) {
      if (!areas.has(id)) areas.set(id, { id, ...areaInfo.get(id), samples: [] });
      areas.get(id).samples.push(si);
    }
  });
  return summarizeAreas(areas, samples, pieces);
}

async function queryPoints(todo, signal) {
  const query = ['[out:json][timeout:90];'];
  todo.forEach((k, i) => {
    query.push(
      `is_in(${k})->.a;make p i=${i};out;` +
        '(area.a["boundary"~"^(protected_area|national_park)$"];area.a["leisure"="nature_reserve"];);out tags;'
    );
  });
  const data = await overpass(query.join('\n'), signal);
  const found = todo.map(() => []);
  let current = -1;
  for (const e of data.elements) {
    if (e.type === 'p') {
      current = Number(e.tags?.i);
      continue;
    }
    if (current < 0 || e.type !== 'area') continue;
    const t = e.tags || {};
    areaInfo.set(e.id, {
      name: t.name || t['name:es'] || 'Espacio protegido',
      title: areaTitle(t),
      national: t.boundary === 'national_park' || t.protect_class === '2',
    });
    found[current].push(e.id);
  }
  todo.forEach((k, i) => pointAreas.set(k, found[i]));
}

function summarizeAreas(areas, samples, pieces) {
  // cada espacio: km de pista dentro y trozos para pintar (muestras seguidas en la misma pista)
  const result = [];
  for (const a of areas.values()) {
    const ranges = [];
    let run = null;
    for (const si of a.samples) {
      const s = samples[si];
      const prev = run && samples[run.last];
      if (prev && prev.piece === s.piece && si === run.last + 1) {
        run.last = si;
        run.to = s.idx;
      } else {
        if (run) ranges.push(run);
        run = { piece: s.piece, from: Math.max(0, s.idx), to: s.idx, last: si };
      }
    }
    if (run) ranges.push(run);
    const shapes = ranges.map((r) => {
      const coords = pieces[r.piece].coords;
      // medio paso por cada lado: la muestra representa su entorno
      return coords.slice(Math.max(0, r.from - 1), Math.min(coords.length, r.to + 2));
    });
    result.push({
      id: a.id,
      name: a.name,
      title: a.title,
      national: a.national,
      km: shapes.reduce((acc, c) => acc + lengthM(c), 0) / 1000,
      ranges: shapes,
    });
  }
  // primero los parques nacionales (los más restrictivos), luego por km
  return result.sort((x, y) => y.national - x.national || y.km - x.km);
}

/** Tipo de espacio en español (protection_title viene a veces en inglés). */
function areaTitle(t) {
  const title = t.protection_title || '';
  const en = {
    'Special Protection Area': 'ZEPA (Red Natura 2000)',
    'Special Area of Conservation': 'ZEC (Red Natura 2000)',
    'Site of Community Importance': 'LIC (Red Natura 2000)',
    'National Park': 'Parque Nacional',
    'Natural Park': 'Parque Natural',
    'Nature Reserve': 'Reserva Natural',
  };
  if (en[title]) return en[title];
  if (title) return title;
  if (t.boundary === 'national_park' || t.protect_class === '2') return 'Parque Nacional';
  const byClass = { '1a': 'Reserva natural', '1b': 'Área silvestre', 3: 'Monumento natural', 4: 'Espacio protegido', 5: 'Paisaje protegido', 97: 'Red Natura 2000', 98: 'Espacio protegido internacional' };
  return byClass[t.protect_class] || 'Espacio protegido';
}

// ---------- utilidades ----------

export async function overpass(query, signal) {
  try {
    return await overpassOnce(query, signal);
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    // servidores saturados (responden 429/504 sin cabeceras CORS: «Failed to fetch»): otro intento
    await new Promise((r) => setTimeout(r, 5000));
    if (signal?.aborted) throw new DOMException('Cancelado', 'AbortError');
    return overpassOnce(query, signal);
  }
}

async function overpassOnce(query, signal) {
  let lastErr;
  for (const url of OVERPASS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `data=${encodeURIComponent(query)}`,
        signal,
      });
      if (!res.ok) throw new Error(`Overpass ${res.status}`);
      return await res.json();
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      lastErr = err; // se prueba el siguiente servidor
    }
  }
  throw lastErr;
}

function distM(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b[0] - a[0]);
  const dLng = toRad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function lengthM(coords) {
  let m = 0;
  for (let i = 1; i < coords.length; i++) m += distM(coords[i - 1], coords[i]);
  return m;
}
