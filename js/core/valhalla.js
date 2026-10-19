// Cliente del motor de rutas Valhalla (datos de OpenStreetMap).
// Módulo puro (sin DOM): se reutilizará en el navegador de la app móvil.

import { decodePolyline, encodePolyline } from './polyline.js';
import { classifyEdge, roadName } from './roadTypes.js';
import { distanceM } from './geometry.js';

export const VALHALLA_URL = 'https://valhalla1.openstreetmap.de';

const EDGE_ATTRIBUTES = [
  'shape',
  'edge.names',
  'edge.road_class',
  'edge.surface',
  'edge.use',
  'edge.unpaved',
  'edge.length',
  'edge.lane_count',
  'edge.traversability',
  'edge.speed_limit',
  'edge.speed',
  'edge.begin_shape_index',
  'edge.end_shape_index',
  'edge.way_id', // vía de OpenStreetMap: para mirar si una pista está prohibida a motos
];

// Los atributos de cada tramo dependen solo de su geometría: al arrastrar un punto
// solo se vuelven a pedir los tramos que han cambiado.
const legCache = new Map();

export class RoutingError extends Error {}

// sin respuesta en este tiempo se da por perdida la petición (se reintenta): sin límite, el
// planificador se quedaba en «Calculando ruta…» para siempre si el servidor no contestaba
const REQUEST_TIMEOUT_MS = 45_000;

async function post(path, body, signal, attempt = 0) {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), REQUEST_TIMEOUT_MS);
  const onAbort = () => timeout.abort();
  signal?.addEventListener('abort', onAbort);
  let res;
  let data;
  try {
    res = await fetch(`${VALHALLA_URL}/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: timeout.signal,
    });
    data = await res.json().catch(() => ({}));
  } catch (err) {
    if (signal?.aborted) throw err; // cancelada a propósito (nueva ruta)
    if (err.name === 'AbortError') {
      if (attempt < 2) return post(path, body, signal, attempt + 1);
      throw new RoutingError('El servidor de rutas no responde. Comprueba la conexión e inténtalo de nuevo.');
    }
    throw err;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
  if (!res.ok) {
    if (res.status === 429 || res.status >= 502) {
      // rutas con muchos puntos lanzan muchas peticiones: esperamos y reintentamos
      if (attempt < 4) {
        await sleep(1000 * 2 ** attempt, signal);
        return post(path, body, signal, attempt + 1);
      }
      throw new RoutingError('El servidor de rutas está saturado, prueba en unos segundos.');
    }
    throw new RoutingError(data.error ? translateError(data) : `Error del servidor de rutas (${res.status})`);
  }
  return data;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new DOMException('Aborted', 'AbortError'));
    });
  });
}

function translateError(data) {
  switch (data.error_code) {
    case 442:
      return 'No se encontró ningún camino entre esos puntos.';
    case 171:
    case 170:
      return 'Algún punto está demasiado lejos de una carretera.';
    case 154:
      return 'La ruta es demasiado larga para el servidor público.';
    default:
      return data.error;
  }
}

/**
 * Calcula la ruta completa.
 * @param waypoints [{lat, lng, kind: 'stop'|'via'}]
 * @param options   {useHighways, useTolls, useTrails, useFerry} en rango 0..1
 */
export async function computeRoute(waypoints, options, signal) {
  // El servidor público acepta como mucho 10 puntos por petición: partimos la ruta
  // en bloques que comparten el punto de unión y juntamos los tramos.
  const chunks = [];
  for (let start = 0; start < waypoints.length - 1; start += MAX_LOCATIONS - 1) {
    chunks.push(waypoints.slice(start, start + MAX_LOCATIONS));
  }

  const trips = await mapLimit(chunks, 2, (chunk) => routeChunk(chunk, options, signal));
  const tripLegs = trips.flatMap((t) => t.legs);

  const legs = await mapLimit(tripLegs, 3, async (leg) => ({
    lengthKm: leg.summary.length,
    timeS: leg.summary.time,
    maneuvers: leg.maneuvers,
    // geometría de /route: los begin_shape_index de las maniobras se refieren a ella
    // (coords puede diferir un poco, sale de trace_attributes)
    routeShape: leg.shape,
    ...(await getLegDetail(leg.shape, signal)),
  }));

  return {
    lengthKm: trips.reduce((a, t) => a + t.summary.length, 0),
    timeS: trips.reduce((a, t) => a + t.summary.time, 0),
    hasToll: trips.some((t) => t.summary.has_toll),
    hasFerry: trips.some((t) => t.summary.has_ferry),
    legs,
  };
}

const quickCache = new Map();

/**
 * Ruta ligera para evaluar variantes al generar rutas: solo geometría, distancia y tiempo.
 * Las mismas variantes se evalúan varias veces al buscar alternativas: van a caché.
 * @param points [{lat, lng, filter?}]  filter = search_filter de Valhalla para ese punto
 * @param alternates cuántas rutas alternativas pedir a Valhalla (solo con 2 puntos)
 * @returns {coords, lengthKm, timeS, maneuvers, alternates: [mismo formato]}
 */
export async function quickRoute(points, options, signal, alternates = 0) {
  const key = JSON.stringify([points, options, alternates]);
  if (quickCache.has(key)) return quickCache.get(key);
  const result = await quickRouteUncached(points, options, signal, alternates);
  quickCache.set(key, result);
  if (quickCache.size > 400) quickCache.delete(quickCache.keys().next().value);
  return result;
}

async function quickRouteUncached(points, options, signal, alternates) {
  const last = points.length - 1;
  const body = {
    locations: points.map((p, i) => ({
      lat: p.lat,
      lon: p.lng,
      type: i === 0 || i === last ? 'break' : 'break_through',
      ...(p.filter && { search_filter: p.filter }),
    })),
    costing: 'motorcycle',
    costing_options: {
      motorcycle: {
        use_highways: options.useHighways,
        use_tolls: options.useTolls,
        use_trails: options.useTrails,
        use_ferry: options.useFerry,
      },
    },
    directions_type: 'maneuvers', // sin textos; solo para contar cruces
    ...(alternates && { alternates }),
  };
  const data = await post('route', body, signal);
  return { ...tripGeometry(data.trip), alternates: (data.alternates || []).map((a) => tripGeometry(a.trip)) };
}

function tripGeometry(trip) {
  const coords = [];
  // tramos de autovía [índice inicial, índice final] sobre coords (maniobras con highway)
  const highways = [];
  for (const leg of trip.legs) {
    const offset = coords.length ? coords.length - 1 : 0; // los tramos comparten el punto de unión
    const c = decodePolyline(leg.shape);
    coords.push(...(coords.length ? c.slice(1) : c));
    for (const m of leg.maneuvers || []) {
      if (!m.highway) continue;
      const s = offset + m.begin_shape_index;
      const e = offset + m.end_shape_index;
      const prev = highways[highways.length - 1];
      if (prev && s <= prev[1] + 1) prev[1] = Math.max(prev[1], e);
      else highways.push([s, e]);
    }
  }
  const maneuvers = trip.legs.reduce((a, leg) => a + (leg.maneuvers?.length || 0), 0);
  return { coords, lengthKm: trip.summary.length, timeS: trip.summary.time, maneuvers, highways };
}

const MAX_LOCATIONS = 10;
const chunkCache = new Map();

async function routeChunk(waypoints, options, signal) {
  const last = waypoints.length - 1;
  const body = {
    locations: waypoints.map((w, i) => ({
      lat: w.lat,
      lon: w.lng,
      // break_through: corta tramo pero sin permitir media vuelta (punto de paso)
      type: i === 0 || i === last || w.kind === 'stop' ? 'break' : 'break_through',
    })),
    costing: 'motorcycle',
    costing_options: {
      motorcycle: {
        use_highways: options.useHighways,
        use_tolls: options.useTolls,
        use_trails: options.useTrails,
        use_ferry: options.useFerry,
      },
    },
    directions_options: { units: 'kilometers', language: 'es-ES' },
  };

  // al mover un punto solo cambia su bloque: los demás salen de caché
  const key = JSON.stringify(body);
  if (chunkCache.has(key)) return chunkCache.get(key);
  const trip = (await post('route', body, signal)).trip;
  chunkCache.set(key, trip);
  if (chunkCache.size > 200) chunkCache.delete(chunkCache.keys().next().value);
  return trip;
}

/** Geometría del tramo + segmentos agrupados por tipo de vía y nombre. */
async function getLegDetail(shape, signal) {
  if (legCache.has(shape)) return legCache.get(shape);

  let detail;
  try {
    // el servidor público no acepta trazas de más de ~200 km: los tramos largos se clasifican
    // por trozos (compartiendo el punto de unión) y se juntan
    const pieces = splitShape(decodePolyline(shape), TRACE_MAX_KM * 1000);
    const parts = await mapLimit(pieces, 2, async (piece) => {
      const data = await post(
        'trace_attributes',
        {
          // edge_walk es exacto pero falla en algunos tramos; walk_or_snap prueba
          // edge_walk y si no, ajusta la geometría al mapa
          shape_match: 'walk_or_snap',
          encoded_polyline: pieces.length === 1 ? shape : encodePolyline(piece),
          costing: 'motorcycle',
          filters: { attributes: EDGE_ATTRIBUTES, action: 'include' },
        },
        signal
      );
      const coords = decodePolyline(data.shape);
      return { coords, segments: groupEdges(data.edges || [], coords.length) };
    });
    const coords = [];
    const segments = [];
    for (const part of parts) {
      const offset = coords.length ? coords.length - 1 : 0;
      coords.push(...(coords.length ? part.coords.slice(1) : part.coords));
      segments.push(...part.segments.map((s) => ({ ...s, from: s.from + offset, to: s.to + offset })));
    }
    detail = { coords, segments };
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    console.warn('trace_attributes falló:', err.message);
    // Sin atributos: dibujamos el tramo igualmente, sin clasificar
    const coords = decodePolyline(shape);
    detail = {
      coords,
      segments: [{ type: 'desconocido', name: '', lengthKm: 0, from: 0, to: coords.length - 1 }],
    };
    return detail; // no se cachea: se reintentará en el próximo cálculo
  }

  legCache.set(shape, detail);
  if (legCache.size > 500) legCache.delete(legCache.keys().next().value);
  return detail;
}

const TRACE_MAX_KM = 150;

/** Trocea una polilínea en partes de como mucho `maxM` metros que comparten el punto de unión. */
function splitShape(coords, maxM) {
  const pieces = [];
  let start = 0;
  let acc = 0;
  for (let i = 1; i < coords.length; i++) {
    acc += distanceM(coords[i - 1], coords[i]);
    if (acc >= maxM && i < coords.length - 1) {
      pieces.push(coords.slice(start, i + 1));
      start = i;
      acc = 0;
    }
  }
  pieces.push(coords.slice(start));
  return pieces;
}

function groupEdges(edges, nCoords) {
  const segments = [];
  for (const edge of edges) {
    const type = classifyEdge(edge);
    const name = roadName(edge.names);
    // tiempo aproximado de la arista; el total del tramo lo da /route, esto sirve
    // para repartirlo entre tipos de vía
    const timeS = edge.speed > 0 ? ((edge.length || 0) / edge.speed) * 3600 : 0;
    const prev = segments[segments.length - 1];
    if (prev && prev.type === type && prev.name === name) {
      prev.to = edge.end_shape_index;
      prev.lengthKm += edge.length || 0;
      prev.timeS += timeS;
      if (prev.wayIds && edge.way_id && !prev.wayIds.includes(edge.way_id)) prev.wayIds.push(edge.way_id);
    } else {
      segments.push({
        type,
        name,
        lengthKm: edge.length || 0,
        timeS,
        from: edge.begin_shape_index,
        to: edge.end_shape_index,
        surface: edge.surface,
        roadClass: edge.road_class,
        speedLimit: edge.speed_limit,
        // pistas: sus vías de OSM, para comprobar accesos (protected.js)
        ...(type === 'cabras' && { wayIds: edge.way_id ? [edge.way_id] : [] }),
      });
    }
  }
  if (segments.length === 0 && nCoords > 1) {
    segments.push({ type: 'desconocido', name: '', lengthKm: 0, timeS: 0, from: 0, to: nCoords - 1 });
  }
  return segments;
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}
