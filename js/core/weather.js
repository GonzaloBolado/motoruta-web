// Previsión del tiempo a lo largo de la ruta, a la hora a la que se pasa por cada punto.
// Datos de Open-Meteo (gratuito, sin clave, previsión hasta 16 días). Módulo puro.

import { REST_EVERY_S, REST_S } from './indicators.js';
import { cumulative, pointAtDistance } from './geometry.js';

const API = 'https://api.open-meteo.com/v1/forecast';
const FORECAST_DAYS = 16;
const MAX_POINTS = 80;

// códigos WMO → icono (nombre en js/ui/icons.js) y texto
const CODES = [
  [[0], 'sun', 'Despejado'],
  [[1], 'cloud-sun', 'Casi despejado'],
  [[2], 'cloud-sun', 'Parcialmente nublado'],
  [[3], 'cloud', 'Nublado'],
  [[45, 48], 'fog', 'Niebla'],
  [[51, 53, 55, 56, 57], 'drizzle', 'Llovizna'],
  [[61, 63, 80, 81], 'rain', 'Lluvia'],
  [[65, 82], 'rain', 'Lluvia fuerte'],
  [[66, 67], 'rain', 'Lluvia helada'],
  [[71, 73, 75, 77, 85, 86], 'snow', 'Nieve'],
  [[95, 96, 99], 'storm', 'Tormenta'],
];
export function describeWeather(code) {
  const row = CODES.find(([codes]) => codes.includes(code));
  return row ? { icon: row[1], text: row[2] } : { icon: 'unknown', text: 'Sin datos' };
}

const pad = (n) => String(n).padStart(2, '0');
const localHourKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:00`;
const localDate = (d) => localHourKey(d).slice(0, 10);

/**
 * Puntos de paso con su hora estimada.
 * @param days       resultado de splitDays (cada día con legs e indicators)
 * @param departure  'YYYY-MM-DDTHH:MM' (hora local); cada día se sale a la misma hora
 */
export function sampleSchedule(days, departure) {
  const [date, time] = departure.split('T');
  const samples = [];
  let kmBefore = 0;
  const totalKm = days.reduce((a, d) => a + d.lengthKm, 0);
  const stepKm = Math.max(20, totalKm / MAX_POINTS);

  days.forEach((day, di) => {
    const start = new Date(`${date}T${time}:00`);
    start.setDate(start.getDate() + di);
    const coords = day.legs.flatMap((l, i) => (i === 0 ? l.coords : l.coords.slice(1)));
    const cum = cumulative(coords);
    const geomKm = cum[cum.length - 1] / 1000;
    const n = Math.max(1, Math.round(day.lengthKm / stepKm));

    for (let k = 0; k <= n; k++) {
      const km = (k / n) * day.lengthKm;
      // conducción a ritmo medio del día (tiempo corregido) + descansos ya hechos
      const drivingS = (km / day.lengthKm) * day.indicators.correctedS;
      const restsS = Math.floor(drivingS / REST_EVERY_S) * REST_S;
      const eta = new Date(start.getTime() + (drivingS + restsS) * 1000);
      const { point } = pointAtDistance(coords, cum, (km / day.lengthKm) * geomKm * 1000);
      samples.push({ day: di, lat: point[0], lng: point[1], km: kmBefore + km, eta });
    }
    kmBefore += day.lengthKm;
  });
  return samples;
}

/** Añade la previsión a cada muestra. Devuelve {samples, unavailable} */
export async function forecastSamples(samples, signal) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const limit = new Date(today);
  limit.setDate(limit.getDate() + FORECAST_DAYS - 1);
  const inRange = samples.filter((s) => s.eta >= today && s.eta < new Date(limit.getTime() + 86400000));
  if (!inRange.length) return { samples: [], unavailable: true };

  const dates = inRange.map((s) => localDate(s.eta)).sort();
  const params = new URLSearchParams({
    latitude: inRange.map((s) => s.lat.toFixed(4)).join(','),
    longitude: inRange.map((s) => s.lng.toFixed(4)).join(','),
    hourly: 'temperature_2m,precipitation_probability,precipitation,weather_code,wind_speed_10m,wind_gusts_10m',
    timezone: 'auto',
    start_date: dates[0],
    end_date: dates[dates.length - 1],
  });
  const res = await fetch(`${API}?${params}`, { signal });
  if (!res.ok) throw new Error('No se pudo obtener la previsión del tiempo');
  const data = await res.json();
  const results = Array.isArray(data) ? data : [data];

  const out = inRange.map((s, i) => {
    const h = results[i].hourly;
    const idx = h.time.indexOf(localHourKey(s.eta));
    if (idx < 0) return { ...s, missing: true };
    return {
      ...s,
      temp: h.temperature_2m[idx],
      rainProb: h.precipitation_probability[idx],
      rainMm: h.precipitation[idx],
      code: h.weather_code[idx],
      wind: h.wind_speed_10m[idx],
      gusts: h.wind_gusts_10m[idx],
    };
  });
  return { samples: out.filter((s) => !s.missing), unavailable: inRange.length < samples.length };
}

/** Avisos relevantes para ir en moto: [{icon, text}]. */
export function weatherWarnings(samples) {
  const w = [];
  const fmt = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const rain = samples.filter((s) => s.rainProb >= 50 || s.rainMm >= 0.5);
  if (rain.length) w.push({ icon: 'rain', text: `Probable lluvia (${fmt(rain[0].eta)}–${fmt(rain[rain.length - 1].eta)})` });
  const storm = samples.find((s) => s.code >= 95);
  if (storm) w.push({ icon: 'storm', text: `Tormentas hacia las ${fmt(storm.eta)}` });
  const gust = samples.reduce((a, s) => (s.gusts > (a?.gusts || 0) ? s : a), null);
  if (gust && gust.gusts >= 50) w.push({ icon: 'wind', text: `Rachas de ${Math.round(gust.gusts)} km/h` });
  const cold = samples.reduce((a, s) => (s.temp < (a?.temp ?? 99) ? s : a), null);
  if (cold && cold.temp <= 3) w.push({ icon: 'cold', text: `${Math.round(cold.temp)}° (posible hielo)` });
  else if (cold && cold.temp <= 8) w.push({ icon: 'cold', text: `Frío: mínima de ${Math.round(cold.temp)}°` });
  const hot = samples.reduce((a, s) => (s.temp > (a?.temp ?? -99) ? s : a), null);
  if (hot && hot.temp >= 33) w.push({ icon: 'hot', text: `Calor: hasta ${Math.round(hot.temp)}°` });
  const fog = samples.find((s) => s.code === 45 || s.code === 48);
  if (fog) w.push({ icon: 'fog', text: `Niebla hacia las ${fmt(fog.eta)}` });
  return w;
}
