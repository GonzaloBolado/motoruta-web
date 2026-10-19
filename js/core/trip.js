// Etapas de varios días. Módulo puro.
// Una parada con `night: true` cierra un día; el tramo i de la ruta va del punto i al i+1.

import { routeIndicators } from './indicators.js';
import { cumulative, pointAtDistance } from './geometry.js';

export const DEFAULT_KM_PER_DAY = 350;
export const MAX_HOURS_PER_DAY = 8; // 350 km a 80-90 km/h de media, ya con descansos

/** Divide la ruta en días según las paradas de noche. */
export function splitDays(route, waypoints) {
  const days = [];
  let legs = [];
  route.legs.forEach((leg, i) => {
    legs.push(leg);
    if (waypoints[i + 1]?.night || i === route.legs.length - 1) {
      days.push({
        legs,
        lengthKm: legs.reduce((a, l) => a + l.lengthKm, 0),
        timeS: legs.reduce((a, l) => a + l.timeS, 0),
        endName: waypoints[i + 1]?.name || '',
        // dónde acaba el día (para la puesta de sol y buscar alojamiento)
        end: waypoints[i + 1] ? { lat: waypoints[i + 1].lat, lng: waypoints[i + 1].lng } : null,
      });
      legs = [];
    }
  });
  return days.map((d) => ({ ...d, indicators: routeIndicators(d) }));
}

/**
 * Dónde dormir: reparte la ruta en días iguales sin pasar de `kmPerDay` ni de
 * MAX_HOURS_PER_DAY de conducción con descansos.
 * @returns [{insertAt, lat, lng, day}] con insertAt = índice de punto donde insertar la parada
 */
export function planNights(route, kmPerDay) {
  const ind = routeIndicators(route);
  const days = Math.max(
    Math.ceil(route.lengthKm / kmPerDay),
    Math.ceil(ind.totalS / (MAX_HOURS_PER_DAY * 3600))
  );
  if (days <= 1) return [];

  const nights = [];
  let legStartKm = 0;
  let nextNight = 1;
  route.legs.forEach((leg, li) => {
    const legEndKm = legStartKm + leg.lengthKm;
    while (nextNight < days && (nextNight * route.lengthKm) / days <= legEndKm) {
      const targetKm = (nextNight * route.lengthKm) / days - legStartKm;
      // la geometría y la distancia de Valhalla difieren un poco: reescalamos
      const cum = cumulative(leg.coords);
      const { point } = pointAtDistance(leg.coords, cum, (targetKm / leg.lengthKm) * cum[cum.length - 1]);
      nights.push({ insertAt: li + 1, lat: point[0], lng: point[1], day: nextNight });
      nextNight++;
    }
    legStartKm = legEndKm;
  });
  return nights;
}
