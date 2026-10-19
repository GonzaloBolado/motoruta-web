// Salida y puesta de sol (algoritmo de la NOAA, simplificado; error de ~1-2 min). Módulo puro.

const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

/**
 * Salida y puesta del sol en un punto un día dado.
 * @param date Date (cuenta el día local de esa fecha)
 * @returns {sunrise: Date, sunset: Date} | null en días sin salida o sin puesta (latitudes polares)
 */
export function sunTimes(date, lat, lng) {
  const start = Date.UTC(date.getFullYear(), 0, 0);
  const day = Math.floor((Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) - start) / 86400000);
  // fracción del año (radianes), a mediodía
  const g = ((2 * Math.PI) / 365) * (day - 1);
  const eqTime =
    229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const decl =
    0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) +
    0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  // 90,833°: el sol toca el horizonte contando la refracción y su radio
  const cosH = Math.cos(rad(90.833)) / (Math.cos(rad(lat)) * Math.cos(decl)) - Math.tan(rad(lat)) * Math.tan(decl);
  if (cosH > 1 || cosH < -1) return null;
  const h = deg(Math.acos(cosH));
  const utcMin = (minutes) => new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) + minutes * 60000);
  return {
    sunrise: utcMin(720 - 4 * (lng + h) - eqTime),
    sunset: utcMin(720 - 4 * (lng - h) - eqTime),
  };
}
