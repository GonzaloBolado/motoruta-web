// Indicadores de la ruta: tiempos corregidos, descansos y gasolineras.
// Módulo puro: lo usará también el navegador del móvil.

// En secundarias el navegador calcula a la velocidad de la vía, pero en moto se va más rápido
export const SECONDARY_TYPES = new Set(['estrecha', 'nacional']);
export const SECONDARY_TIME_REDUCTION = 0.2;
// un descanso de 10 minutos por cada hora de conducción
export const REST_EVERY_S = 3600;
export const REST_S = 600;

export function routeIndicators(route, stations = null) {
  let secondaryS = 0;
  for (const leg of route.legs) {
    // los tiempos por arista son aproximados: los reescalamos al tiempo real del tramo
    const raw = leg.segments.reduce((a, s) => a + (s.timeS || 0), 0);
    if (!raw) continue;
    const rawSecondary = leg.segments.filter((s) => SECONDARY_TYPES.has(s.type)).reduce((a, s) => a + s.timeS, 0);
    secondaryS += leg.timeS * (rawSecondary / raw);
  }

  const correctedS = route.timeS - secondaryS * SECONDARY_TIME_REDUCTION;
  const rests = Math.max(0, Math.ceil(correctedS / REST_EVERY_S) - 1);

  const result = {
    distanceKm: route.lengthKm,
    timeS: route.timeS,
    correctedS,
    rests,
    totalS: correctedS + rests * REST_S,
    fuel: null,
  };

  if (stations) {
    const marks = [0, ...stations.map((s) => s.km), route.lengthKm];
    let longestGapKm = 0;
    for (let i = 1; i < marks.length; i++) longestGapKm = Math.max(longestGapKm, marks[i] - marks[i - 1]);
    const with95 = stations.filter((s) => s.p95);
    result.fuel = {
      count: stations.length,
      longestGapKm,
      cheapest95: with95.length ? with95.reduce((a, b) => (b.p95 < a.p95 ? b : a)) : null,
    };
  }
  return result;
}
