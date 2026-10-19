// Archivo .motoruta para la app de navegación del móvil.
// Lleva todo lo que el GPX no puede: instrucciones de giro, gasolineras con precio y
// tipo de cada carretera. La app sitúa cada elemento sobre el trazado ella misma
// (proyectándolo en orden), así que aquí solo van posiciones.

import { decodePolyline } from './polyline.js';
import { routeIndicators } from './indicators.js';

export const NAV_FORMAT = 'motoruta-nav';
export const NAV_VERSION = 1;

const round = (n) => Math.round(n * 1e6) / 1e6;

// Valhalla: tipos de maniobra que no hace falta anunciar (seguir recto por la misma vía)
const SILENT_TYPES = new Set([0, 7, 8, 22]);

/**
 * @param route     ruta calculada (computeRoute)
 * @param waypoints puntos del planificador
 * @param fuel      gasolineras en ruta (fuelStationsAlongRoute) o null
 */
export function buildNavFile({ name, departure, route, waypoints, fuel, nearbyFuel = [], food = [], workshops = [], supermarkets = [], cameras = [] }) {
  const track = [];
  const segments = [];
  const maneuvers = [];

  route.legs.forEach((leg, li) => {
    const offset = track.length === 0 ? 0 : track.length - 1; // los tramos comparten el punto de unión
    leg.coords.forEach((c, i) => {
      if (li > 0 && i === 0) return;
      track.push([round(c[0]), round(c[1])]);
    });
    for (const s of leg.segments) {
      segments.push({ from: offset + s.from, to: offset + s.to, type: s.type, name: s.name });
    }

    const shape = leg.routeShape ? decodePolyline(leg.routeShape) : leg.coords;
    const last = leg.maneuvers?.length - 1;
    leg.maneuvers?.forEach((m, mi) => {
      if (SILENT_TYPES.has(m.type)) return;
      // cada tramo empieza con "Salga hacia…" y acaba en "Ha llegado": solo valen el primero y el último
      if (li > 0 && mi === 0) return;
      if (li < route.legs.length - 1 && mi === last) return;
      const p = shape[Math.min(m.begin_shape_index, shape.length - 1)];
      maneuvers.push({
        lat: round(p[0]),
        lng: round(p[1]),
        type: m.type,
        text: m.instruction,
        street: (m.street_names || m.begin_street_names || [])[0] || '',
        exit: m.roundabout_exit_count || undefined,
      });
    });
  });

  const stops = waypoints
    .map((w, i) => ({ w, i }))
    .filter(({ w, i }) => w.kind === 'stop' || i === 0 || i === waypoints.length - 1)
    .map(({ w, i }) => ({
      name: w.name || '',
      lat: round(w.lat),
      lng: round(w.lng),
      kind: i === 0 ? 'start' : i === waypoints.length - 1 ? 'end' : w.night ? 'night' : 'stop',
    }));

  return {
    format: NAV_FORMAT,
    version: NAV_VERSION,
    name: name || 'Ruta',
    createdAt: new Date().toISOString(),
    departure: departure || null,
    lengthKm: Math.round(route.lengthKm * 10) / 10,
    timeS: Math.round(route.timeS),
    // tiempo corregido del planificador (en moto se va más rápido por secundarias): la app
    // calcula con él la hora de llegada, más los descansos, igual que el planificador
    drivingS: Math.round(routeIndicators(route).correctedS),
    track,
    segments,
    stops,
    maneuvers,
    fuel: (Array.isArray(fuel) ? fuel : []).map(fuelDto),
    // para buscar en la moto sin conexión: gasolineras cercanas (no solo en ruta) y comida
    nearbyFuel: nearbyFuel.map(fuelDto),
    food: food.map(poiDto),
    workshops: workshops.map(poiDto),
    supermarkets: supermarkets.map(poiDto),
    // radares fijos sobre la ruta (OpenStreetMap): solo los usa el navegador
    cameras: cameras.map((c) => ({ lat: round(c.lat), lng: round(c.lng), maxspeed: c.maxspeed ?? undefined })),
  };
}

const poiDto = (p) => ({ name: p.name, kind: p.kind, lat: round(p.lat), lng: round(p.lng) });

const fuelDto = (f) => ({
  name: f.brand || 'Gasolinera',
  lat: round(f.lat),
  lng: round(f.lng),
  address: f.address || '',
  hours: f.hours || '',
  p95: f.p95 ?? null,
  p98: f.p98 ?? null,
  diesel: f.diesel ?? null,
});
