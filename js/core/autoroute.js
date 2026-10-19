// Generación automática de rutas. Módulo puro.
//
// Valhalla no sabe buscar curvas, así que generamos variantes con puntos de paso
// desplazados, medimos lo reviradas que son (°/km) y nos quedamos con la mejor que
// no se alargue demasiado.

import { quickRoute } from './valhalla.js';
import {
  bearing,
  cumulative,
  curvature,
  destination,
  distanceM,
  footprint,
  overlap,
  pointAtDistance,
  regression,
  similarity,
} from './geometry.js';

export const CURVY_LEVELS = {
  // sectionKm: cada cuántos km se elige un punto de paso; offsets: desvío lateral de los
  // candidatos, relativo al tramo; maxDetour: cuánto se puede alargar respecto a la ruta
  // directa; weight: peso de las curvas (ruta de un día)
  low: { sectionKm: 0, offsets: [], maxDetour: 0.1, weight: 0 },
  mid: { sectionKm: 100, offsets: [0.2, 0.4], maxDetour: 0.3, weight: 0.5 },
  high: { sectionKm: 75, offsets: [0.25, 0.5], maxDetour: 0.5, weight: 1 },
};

// Penalización por alejarse del destino: se toleran las curvas propias de una carretera
// revirada; subir hacia un lado para luego volver hunde la puntuación.
const REGRESSION_TOLERANCE = 0.05;
const regressionFactor = (r) => Math.max(0.05, 1 - 4 * Math.max(0, r - REGRESSION_TOLERANCE));

const routeOptions = (p) => ({
  // "evitar autovías": moderado aquí; luego se quitan las que sobran (avoidHighwaysSmartly)
  useHighways: p.avoidHighways ? AVOID_BASE : 1,
  useTolls: p.avoidTolls ? 0 : 0.5,
  useTrails: p.allowTrails ? 0.5 : 0,
  useFerry: 0,
});

// los puntos generados se enganchan a carreteras secundarias/terciarias, nunca a una
// autovía, un camino o una calle residencial
const VIA_FILTER = { min_road_class: 'tertiary', max_road_class: 'secondary', exclude_ramp: true };

const toWp = (p, kind, name = '') => ({ lat: p[0], lng: p[1], kind, name });

// El planificador recalcula sin los filtros de enganche: guardamos cada punto ya
// colocado sobre la carretera evaluada para que la ruta final sea la misma.
function snapTo(p, coords) {
  let best = coords[0];
  let bestD = Infinity;
  for (const c of coords) {
    const d = (c[0] - p[0]) ** 2 + (c[1] - p[1]) ** 2;
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best;
}

// Curvas "de verdad": en ciudad las rotondas y los giros suman grados igual que un puerto,
// así que se descuenta según los cruces por km (montaña ≈ 0,1-0,3/km; ciudad > 1/km).
function twistiness(route) {
  const perKm = route.maneuvers / Math.max(1, route.lengthKm);
  const urbanFactor = Math.min(1, Math.max(0.15, 1.3 - perKm * 1.5));
  return curvature(route.coords) * urbanFactor;
}

/**
 * Calcula la variante. Si algún punto intermedio ha caído al final de un ramal (la ruta
 * entra y sale por la misma carretera), lo mueve a la base del ramal y recalcula.
 * Devuelve la ruta con `points` (los puntos ya corregidos), o null si no hay camino.
 */
async function tryRoute(points, options, signal) {
  const route = await safeRoute(points, options, signal);
  if (!route || points.length < 3) return route && { ...route, points };

  const cum = cumulative(route.coords);
  let changed = false;
  const fixed = points.map((p, i) => {
    if (i === 0 || i === points.length - 1) return p;
    const base = spurBase(route.coords, cum, [p.lat, p.lng]);
    if (!base) return p;
    changed = true;
    return { lat: base[0], lng: base[1] }; // ya está sobre la ruta: sin filtro
  });
  if (!changed) return { ...route, points };
  const again = await safeRoute(fixed, options, signal);
  return again ? { ...again, points: fixed } : { ...route, points };
}

async function safeRoute(points, options, signal) {
  try {
    return await quickRoute(points, options, signal);
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    return null; // variante imposible (sin camino): se descarta
  }
}

// Si el punto está al final de una ida y vuelta, devuelve dónde empieza ese ramal.
function spurBase(coords, cum, p) {
  let idx = 0;
  let best = Infinity;
  coords.forEach((c, i) => {
    const d = (c[0] - p[0]) ** 2 + (c[1] - p[1]) ** 2;
    if (d < best) {
      best = d;
      idx = i;
    }
  });
  const at = cum[idx];
  let spur = 0;
  for (let d = 100; d <= 30000 && at - d >= 0 && at + d <= cum[cum.length - 1]; d += 100) {
    const before = pointAtDistance(coords, cum, at - d).point;
    const after = pointAtDistance(coords, cum, at + d).point;
    if (distanceM(before, after) > 120) break;
    spur = d;
  }
  return spur >= 500 ? pointAtDistance(coords, cum, at - spur).point : null;
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i], i);
      }
    })
  );
  return results;
}

export const ALTERNATIVES = 3;
// dos alternativas que compartan más de esto del recorrido se consideran la misma
const MAX_SIMILARITY = 0.6;

/**
 * Resumen de una alternativa: geometría completa, km, tiempo y curvas.
 * Valhalla admite 10 puntos por petición: se trocea compartiendo el punto de unión.
 */
async function summarize(waypoints, options, signal) {
  const chunks = [];
  for (let s = 0; s < waypoints.length - 1; s += 9) chunks.push(waypoints.slice(s, s + 10));
  const parts = await mapLimit(chunks, 2, (c) => quickRoute(c.map(({ lat, lng }) => ({ lat, lng })), options, signal));
  let offset = 0;
  const highways = parts.flatMap((r, i) => {
    const shifted = r.highways.map(([s, e]) => [s + offset, e + offset]);
    offset += r.coords.length - 1;
    return shifted;
  });
  const route = {
    highways,
    coords: parts.flatMap((r, i) => (i === 0 ? r.coords : r.coords.slice(1))),
    lengthKm: parts.reduce((a, r) => a + r.lengthKm, 0),
    timeS: parts.reduce((a, r) => a + r.timeS, 0),
    maneuvers: parts.reduce((a, r) => a + r.maneuvers, 0),
  };
  return {
    waypoints,
    coords: route.coords,
    lengthKm: route.lengthKm,
    timeS: route.timeS,
    curvature: twistiness(route),
    highways: route.highways,
  };
}

// ---------- autovías solo cuando hace falta ----------
//
// "Evitar autovías" al máximo en Valhalla evita también las nacionales grandes y da rodeos
// absurdos en viajes largos (Santander → Cádiz: 1.443 km en vez de ~1.000). Así que se calcula
// con autovías permitidas de forma moderada y luego se revisa cada tramo de autovía:
//  - sin alternativa razonable (más de un 50 % más larga): se queda, es necesaria;
//  - con una nacional al lado igual de recta: se queda (no se gana nada);
//  - con una alternativa con curvas: se cambia por ella.

const HIGHWAY_MIN_KM = 5;
const HIGHWAY_NECESSARY_DETOUR = 1.5;
/** °/km por debajo de los cuales una carretera se considera recta (autovía ≈ 5-10) */
const STRAIGHT_TWISTINESS = 22;

/** Opciones base al "evitar autovías": moderadas, para que Valhalla no dé rodeos absurdos. */
const AVOID_BASE = 0.5;

/**
 * Revisa los tramos de autovía de una alternativa y cambia por la carretera paralela los que
 * la tienen con curvas. Devuelve la alternativa (recalculada si ha cambiado algo).
 */
async function replaceBoringHighways(alt, options, signal, onProgress) {
  const strict = { ...options, useHighways: 0 };
  const cum = cumulative(alt.coords);
  const stretches = alt.highways.filter(([s, e]) => (cum[e] - cum[s]) / 1000 >= HIGHWAY_MIN_KM);
  if (!stretches.length) return alt;

  // posición de cada punto de la ruta sobre el trazado (en orden), para saber dónde insertar
  const wpIndex = [];
  let from = 0;
  alt.waypoints.forEach((w, k) => {
    // salida y llegada son los extremos del trazado. En un bucle están en el mismo sitio:
    // buscándolas, la salida se emparejaba con el final y los puntos de la nacional
    // acababan delante de ella (la ruta empezaba en un punto de paso)
    if (k === 0 || k === alt.waypoints.length - 1) {
      wpIndex.push(k === 0 ? 0 : alt.coords.length - 1);
      return;
    }
    let best = from;
    let bestD = Infinity;
    for (let i = from; i < alt.coords.length; i++) {
      const d = (alt.coords[i][0] - w.lat) ** 2 + (alt.coords[i][1] - w.lng) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
      if (bestD < 1e-8) break;
      // ya encontrado y alejándose (a unos km): no seguir hasta otra pasada por la zona
      if (bestD < 1e-5 && d > 1e-3) break;
    }
    wpIndex.push(best);
    from = best;
  });

  const replacements = []; // {s, e, vias}
  let done = 0;
  for (const [s, e] of stretches) {
    const hwKm = (cum[e] - cum[s]) / 1000;
    const a = alt.coords[s];
    const b = alt.coords[e];
    const r = await tryRoute([{ lat: a[0], lng: a[1] }, { lat: b[0], lng: b[1] }], strict, signal);
    onProgress?.(++done, stretches.length, 'Buscando nacionales con curvas en vez de autovía…');
    if (!r || r.lengthKm > hwKm * HIGHWAY_NECESSARY_DETOUR) continue; // autovía necesaria
    if (twistiness(r) < STRAIGHT_TWISTINESS) continue; // la nacional también es recta
    // puntos de paso por la carretera con curvas: cada ~12 km, al menos uno
    const rc = cumulative(r.coords);
    const total = rc[rc.length - 1];
    const n = Math.max(1, Math.round(total / 12_000));
    const vias = Array.from({ length: n }, (_, k) => pointAtDistance(r.coords, rc, ((k + 1) * total) / (n + 1)).point);
    replacements.push({ s, e, vias });
  }
  if (!replacements.length) return alt;

  // nueva lista de puntos: fuera los de paso que caían en la autovía, dentro los de la nacional
  const waypoints = [];
  alt.waypoints.forEach((w, i) => {
    const idx = wpIndex[i];
    const inside = replacements.find((r) => idx > r.s && idx < r.e);
    if (inside && w.kind === 'via') return;
    // los puntos de la nacional van antes del primer punto que queda después del tramo
    for (const r of replacements) {
      if (!r.inserted && idx >= r.e) {
        r.vias.forEach((v) => waypoints.push(toWp(v, 'via')));
        r.inserted = true;
      }
    }
    waypoints.push(w);
  });
  return summarize(waypoints, options, signal);
}

/** Aplica replaceBoringHighways a todas las alternativas si se pidió evitar autovías. */
async function avoidHighwaysSmartly(p, alternatives, options, signal, onProgress) {
  if (!p.avoidHighways) return alternatives;
  const out = [];
  for (const alt of alternatives) out.push(await replaceBoringHighways(alt, options, signal, onProgress));
  return out;
}

/**
 * «Evitar autovías» del panel sobre una ruta ya trazada: la misma regla que al generar (autovía
 * solo si hace falta o si la nacional paralela también es recta). `options` son las de Valhalla
 * con useHighways moderado. Devuelve los puntos nuevos, o null si no hay nada que cambiar.
 */
export async function avoidHighwaysInRoute(waypoints, options, signal, onProgress) {
  const alt = await summarize(waypoints, options, signal);
  if (!alt) return null;
  const better = await replaceBoringHighways(alt, options, signal, onProgress);
  return better === alt ? null : better.waypoints;
}

/** Se queda con las que no se parecen a ninguna anterior. */
function distinct(alternatives, maxSimilarity = MAX_SIMILARITY) {
  const kept = [];
  for (const alt of alternatives) {
    if (kept.every((k) => similarity(alt.coords, k.fp) < maxSimilarity)) kept.push({ ...alt, fp: footprint(alt.coords) });
  }
  return kept.map(({ fp, ...alt }) => alt);
}

/**
 * Viaje de A a B, pasando opcionalmente por puntos intermedios obligatorios.
 * @param p {from:{lat,lng,name}, to, through:[{lat,lng,name}], avoidHighways, avoidTolls,
 *           curvy:'low'|'mid'|'high'}
 * @returns {alternatives: [{waypoints, coords, lengthKm, timeS, curvature}]} hasta 3, distintas
 */
export async function generateTrip(p, onProgress, signal) {
  const options = routeOptions(p);
  const level = CURVY_LEVELS[p.curvy];
  const stops = [p.from, ...(p.through || []), p.to];
  const stopWp = (s) => toWp([s.lat, s.lng], 'stop', s.name);

  onProgress(0, 1, 'Calculando la ruta base…');
  const legs = await mapLimit(stops.slice(0, -1), 2, async (a, i) => {
    const b = stops[i + 1];
    const baseline = await quickRoute([a, b].map(({ lat, lng }) => ({ lat, lng })), options, signal, 2);
    return { a, b, baseline, anchors: level.sectionKm ? anchorsAlong(baseline, level.sectionKm) : [] };
  });

  // viajes largos: cada alternativa por un corredor distinto en los tramos largos
  const longLegKm = LONG_TRIP_DAYS * (p.kmPerDay || 350);
  for (const leg of legs) {
    leg.corridors = leg.baseline.lengthKm >= longLegKm ? await corridorsFor(leg, options, signal, onProgress) : [];
  }

  // "pocas curvas" (o viaje demasiado corto para buscar variantes) en viajes cortos: las
  // alternativas que propone el propio Valhalla, fijadas con un punto de paso a mitad de
  // recorrido (sin él, el planificador recalcularía la principal)
  if (!legs.some((leg) => leg.anchors.length || leg.corridors.length > 1)) {
    const direct = { waypoints: stops.map(stopWp) };
    const alts = legs.length === 1 ? legs[0].baseline.alternates : [];
    const list = [direct];
    for (const alt of alts) {
      const cum = cumulative(alt.coords);
      const mid = pointAtDistance(alt.coords, cum, cum[cum.length - 1] / 2).point;
      list.push({ waypoints: [stopWp(stops[0]), toWp(mid, 'via'), stopWp(stops[1])] });
    }
    const summaries = await mapLimit(list, 2, (a) => summarize(a.waypoints, options, signal));
    const smart = await avoidHighwaysSmartly(p, summaries, options, signal, onProgress);
    return { alternatives: distinct(smart).slice(0, ALTERNATIVES) };
  }

  const candidatesPer = 1 + level.offsets.length * 2;
  const total = ALTERNATIVES * legs.reduce((n, leg) => n + leg.anchors.length * candidatesPer, 0) || 1;
  let done = 0;
  const progress = () => onProgress(++done, total, `Probando variantes de ruta… ${Math.min(done, total)}/${total}`);

  // Cada alternativa repite la búsqueda penalizando pasar por donde ya pasan las anteriores
  // (y, en tramos largos, siguiendo su propio corredor). Las variantes repetidas salen de la
  // caché de quickRoute.
  const footprints = [];
  const alternatives = [];
  for (let k = 0; k < ALTERNATIVES; k++) {
    const waypoints = [stopWp(stops[0])];
    for (const leg of legs) {
      const corridor = leg.corridors[k];
      const base = corridor?.route || leg.baseline;
      const anchors = corridor ? anchorsAlong(base, level.sectionKm || base.lengthKm) : leg.anchors;
      // relación km por carretera / km en línea recta de este tramo, para limitar los desvíos
      const roadFactor = base.lengthKm / Math.max(1, distanceM([leg.a.lat, leg.a.lng], [leg.b.lat, leg.b.lng]) / 1000);
      let prev = [leg.a.lat, leg.a.lng];
      // "pocas curvas": el corredor se fija con su punto de paso y nada más
      if (corridor && !level.sectionKm) corridor.vias.forEach((v) => waypoints.push(toWp(v, 'via')));
      for (let i = 0; level.sectionKm && i < anchors.length; i++) {
        const next = i + 1 < anchors.length ? anchors[i + 1] : [leg.b.lat, leg.b.lng];
        const pick = await bestStep(prev, anchors[i], next, roadFactor, level, options, signal, progress, footprints);
        if (!pick) continue;
        waypoints.push(toWp(pick, 'via'));
        prev = pick;
      }
      waypoints.push(stopWp(leg.b));
    }
    const summary = await summarize(waypoints, options, signal);
    alternatives.push(summary);
    footprints.push(footprint(summary.coords));
  }
  const long = legs.some((leg) => leg.corridors.length > 1);
  const smart = await avoidHighwaysSmartly(p, alternatives, options, signal, onProgress);
  return { alternatives: distinct(smart, long ? CORRIDOR_MAX_SIMILARITY : MAX_SIMILARITY) };
}

// a partir de cuántos días de viaje las alternativas van por corredores distintos
const LONG_TRIP_DAYS = 2;
// desvíos laterales a mitad de tramo (fracción de la distancia en línea recta; con signo:
// a un lado y al otro de la línea recta, no de la ruta directa)
const CORRIDOR_OFFSETS = [-0.27, -0.18, -0.1, 0.1, 0.18, 0.27];
// "dentro de límites lógicos": como mucho esto más largo que la ruta directa
const CORRIDOR_MAX_DETOUR = 1.4;
// el punto que fija un corredor se engancha a una carretera de paso (hasta nacionales): en una
// secundaria pequeña obligaría a rodeos para llegar a él
const CORRIDOR_FILTER = { min_road_class: 'tertiary', max_road_class: 'trunk', exclude_ramp: true };
// dos corredores que compartan más de esto del recorrido son el mismo
// (más permisivo que en viajes cortos: en 1.000 km dos corredores comparten por fuerza la salida
// y la llegada)
const CORRIDOR_MAX_SIMILARITY = 0.7;

/**
 * Corredores para un tramo largo: la ruta directa y los dos más distintos entre sí que no
 * la alarguen más de un 40 % (p. ej. Santander → Cádiz: por Salamanca, por Madrid y por
 * Guadalajara). Se prueban desvíos a ambos lados de la línea recta y se eligen por
 * diferencia: cada nuevo corredor, el que menos se parece a los ya elegidos.
 * Cada corredor se fija con dos puntos (a 1/3 y 2/3 del viaje): con uno solo a mitad, la
 * ruta seguía por el camino de siempre y solo se desviaba al final.
 * @returns [{route, vias}] (vias = puntos que fijan el corredor, vacío en el directo)
 */
async function corridorsFor(leg, options, signal, onProgress) {
  const a = [leg.a.lat, leg.a.lng];
  const b = [leg.b.lat, leg.b.lng];
  const straight = distanceM(a, b);
  const perp = bearing(a, b) + 90;
  const along = (t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  const maxKm = leg.baseline.lengthKm * CORRIDOR_MAX_DETOUR;

  let done = 0;
  const tries = await mapLimit(CORRIDOR_OFFSETS, 3, async (f) => {
    // f negativo = al otro lado de la línea recta
    const controls = [1 / 3, 2 / 3].map((t) => destination(along(t), perp, f * straight));
    const r = await tryRoute(
      [
        { lat: a[0], lng: a[1] },
        ...controls.map(([lat, lng]) => ({ lat, lng, filter: CORRIDOR_FILTER })),
        { lat: b[0], lng: b[1] },
      ],
      options,
      signal
    );
    onProgress(++done, CORRIDOR_OFFSETS.length, 'Buscando corredores para el viaje…');
    if (!r || r.lengthKm > maxKm) return null;
    const vias = r.points.slice(1, -1).map((q) => snapTo([q.lat, q.lng], r.coords));
    return { route: r, vias, fp: footprint(r.coords) };
  });

  const chosen = [{ route: leg.baseline, vias: [], fp: footprint(leg.baseline.coords) }];
  let pool = tries.filter(Boolean);
  while (chosen.length < ALTERNATIVES && pool.length) {
    // parecido de cada candidato a lo ya elegido (el mayor); se elige el menos parecido,
    // y a igualdad el más corto
    const scored = pool
      .map((c) => ({ c, sim: Math.max(...chosen.map((k) => similarity(c.route.coords, k.fp))) }))
      .filter((s) => s.sim < CORRIDOR_MAX_SIMILARITY)
      .sort((x, y) => x.sim - y.sim || x.c.route.lengthKm - y.c.route.lengthKm);
    if (!scored.length) break;
    chosen.push(scored[0].c);
    pool = pool.filter((c) => c !== scored[0].c);
  }
  return chosen.map(({ route, vias }) => ({ route, vias }));
}

// Puntos de referencia repartidos cada ~sectionKm por la ruta directa.
function anchorsAlong(baseline, sectionKm) {
  const n = Math.round(baseline.lengthKm / sectionKm);
  if (n < 2) return [];
  const cum = cumulative(baseline.coords);
  const total = cum[cum.length - 1];
  return Array.from({ length: n - 1 }, (_, i) => pointAtDistance(baseline.coords, cum, ((i + 1) * total) / n).point);
}

/**
 * Elige el siguiente punto de paso avanzando desde `prev`: candidatos en la altura de
 * `anchor` (sobre la ruta directa y desplazados a los lados), puntuados por curvas,
 * penalizando alargar demasiado, repetir carretera y alejarse del destino.
 * No se vuelve a la ruta directa: el siguiente paso sale del punto elegido.
 * `avoid`: huellas de alternativas ya generadas; cuanto más se les parezca, peor puntúa.
 */
async function bestStep(prev, anchor, next, roadFactor, level, options, signal, progress, avoid = []) {
  const perp = bearing(prev, next) + 90;
  const step = distanceM(prev, anchor);
  const candidates = [anchor, ...level.offsets.flatMap((f) => [destination(anchor, perp, f * step), destination(anchor, perp + 180, f * step)])];
  const limitKm = ((distanceM(prev, next) / 1000) * roadFactor) * (1 + level.maxDetour);

  const results = await mapLimit(candidates, 3, async (c) => {
    const r = await tryRoute(
      [{ lat: prev[0], lng: prev[1] }, { lat: c[0], lng: c[1], filter: VIA_FILTER }, { lat: next[0], lng: next[1] }],
      options,
      signal
    );
    progress();
    if (!r) return null;
    const lengthPenalty = r.lengthKm > limitKm ? Math.min(1, (r.lengthKm / limitKm - 1) * 3) : 0;
    const score =
      Math.max(1, twistiness(r)) *
      (1 - lengthPenalty) *
      Math.max(0, 1 - 2 * overlap(r.coords)) *
      regressionFactor(regression(r.coords, next)) *
      (1 - 0.85 * Math.max(0, ...avoid.map((fp) => similarity(r.coords, fp))));
    return { score, point: snapTo([r.points[1].lat, r.points[1].lng], r.coords) };
  });
  const best = results.filter(Boolean).sort((a, b) => b.score - a.score)[0];
  return best?.point || null;
}

/**
 * Ruta circular de un día: sale de `home`, da una vuelta de ~targetKm y acaba en `end`.
 * Se prueban bucles en 8 direcciones y se ajusta el tamaño del mejor.
 */
export async function generateLoop(p, onProgress, signal) {
  const options = routeOptions(p);
  const level = CURVY_LEVELS[p.curvy];
  const home = [p.home.lat, p.home.lng];
  const end = p.end ? [p.end.lat, p.end.lng] : home;
  const target = p.targetKm;

  // la carretera da ~1,6 veces la longitud del círculo que dibujan los puntos
  const radiusFor = (km) => (km * 1000) / (2 * Math.PI * 1.6);
  const loopPoints = (theta, r) => {
    const center = destination(home, theta, r);
    const vias = [1, 2, 3, 4].map((k) => destination(center, (theta + 180 + 72 * k) % 360, r));
    return [home, ...vias, end];
  };

  const evaluate = async (theta, r) => {
    const pts = loopPoints(theta, r);
    const route = await tryRoute(
      pts.map((q, i) => ({ lat: q[0], lng: q[1], ...(i > 0 && i < pts.length - 1 && { filter: VIA_FILTER }) })),
      options,
      signal
    );
    if (!route) return null;
    const error = Math.abs(route.lengthKm - target) / target;
    // también con "pocas curvas" se evita meterse en ciudad
    const perKm = route.maneuvers / Math.max(1, route.lengthKm);
    // calidad del trazado (curvas, sin repetir carretera, sin ciudad), sin contar los km
    const shapeScore = level.weight * twistiness(route) - 150 * overlap(route.coords) - 20 * Math.max(0, perKm - 0.3);
    // fuera de ±10 % de los km pedidos la penalización se dispara
    const score = shapeScore - 120 * error - 600 * Math.max(0, error - 0.1);
    return { theta, r, pts: route.points.map((q) => [q.lat, q.lng]), route, score, shapeScore, error };
  };

  // giro aleatorio para que "otra variante" dé un bucle distinto
  const offset = Math.random() * 45;
  const thetas = Array.from({ length: 8 }, (_, i) => (offset + i * 45) % 360);
  const REFINES = 2;
  let done = 0;
  const total = thetas.length + (ALTERNATIVES + 1) * REFINES;
  onProgress(0, total);
  const results = await mapLimit(thetas, 2, async (t) => {
    const res = await evaluate(t, radiusFor(target));
    onProgress(++done, total);
    return res;
  });

  // los km se corrigen después escalando el bucle: aquí se ordenan las direcciones por trazado
  const ranked = results.filter((c) => c && c.error < 0.6).sort((a, b) => b.shapeScore - a.shapeScore);
  if (!ranked.length) throw new Error('No se pudo generar ningún bucle desde ese punto.');

  // ajuste del tamaño para clavar los km
  const refine = async (cand) => {
    let current = cand;
    let scaleFrom = current;
    for (let k = 0; k < REFINES; k++) {
      if (scaleFrom.error < 0.05) break;
      const next = await evaluate(scaleFrom.theta, scaleFrom.r * (target / scaleFrom.route.lengthKm));
      onProgress(++done, total);
      if (!next) break;
      scaleFrom = next; // se sigue escalando desde el último aunque puntúe peor
      if (next.score > current.score) current = next;
    }
    return current;
  };

  // las mejores direcciones que no se parezcan entre sí (bucles vecinos suelen compartir carreteras)
  const accepted = [];
  for (const cand of ranked) {
    if (accepted.length === ALTERNATIVES) break;
    const loop = await refine(cand);
    // las alternativas también tienen que respetar los km pedidos (la primera siempre entra)
    if (accepted.length && loop.error > 0.15) continue;
    if (accepted.some((a) => similarity(loop.route.coords, a.fp) >= MAX_SIMILARITY)) continue;
    accepted.push({ ...loop, fp: footprint(loop.route.coords) });
  }
  onProgress(total, total);

  const alternatives = accepted
    .sort((a, b) => b.score - a.score)
    .map((loop) => {
      const pts = loop.pts;
      const last = pts.length - 1;
      return {
        waypoints: pts.map((q, i) =>
          i === 0 || i === last
            ? toWp(q, 'stop', i === 0 ? p.home.name : (p.end || p.home).name)
            : toWp(snapTo(q, loop.route.coords), 'via')
        ),
        coords: loop.route.coords,
        lengthKm: loop.route.lengthKm,
        timeS: loop.route.timeS,
        curvature: twistiness(loop.route),
        highways: loop.route.highways,
      };
    });
  return { alternatives: await avoidHighwaysSmartly(p, alternatives, options, signal, onProgress) };
}
