// Utilidades geométricas sobre polilíneas [[lat, lng], ...]. Módulo puro.

const R = 6371000;
const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;

export function distanceM(a, b) {
  const dLat = toRad(b[0] - a[0]);
  const dLng = toRad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function bearing(a, b) {
  const y = Math.sin(toRad(b[1] - a[1])) * Math.cos(toRad(b[0]));
  const x =
    Math.cos(toRad(a[0])) * Math.sin(toRad(b[0])) -
    Math.sin(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.cos(toRad(b[1] - a[1]));
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Punto a `distM` metros de `p` con rumbo `bearingDeg`. */
export function destination(p, bearingDeg, distM) {
  const d = distM / R;
  const b = toRad(bearingDeg);
  const lat1 = toRad(p[0]);
  const lng1 = toRad(p[1]);
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(b));
  const lng2 = lng1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
  return [toDeg(lat2), toDeg(lng2)];
}

/** Distancias acumuladas (m) de cada vértice. */
export function cumulative(coords) {
  const cum = [0];
  for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + distanceM(coords[i - 1], coords[i]));
  return cum;
}

/** Punto (e índice de segmento) a `targetM` metros del inicio. */
export function pointAtDistance(coords, cum, targetM) {
  if (targetM <= 0) return { point: coords[0], index: 0 };
  for (let i = 1; i < coords.length; i++) {
    if (cum[i] >= targetM) {
      const t = (targetM - cum[i - 1]) / (cum[i] - cum[i - 1] || 1);
      const [a, b] = [coords[i - 1], coords[i]];
      return { point: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], index: i - 1 };
    }
  }
  return { point: coords[coords.length - 1], index: coords.length - 2 };
}

/** Remuestrea la polilínea cada `stepM` metros. */
export function resample(coords, stepM) {
  if (coords.length < 2) return coords.slice();
  const out = [coords[0]];
  let next = stepM;
  let acc = 0;
  for (let i = 1; i < coords.length; i++) {
    const [a, b] = [coords[i - 1], coords[i]];
    const len = distanceM(a, b);
    while (acc + len >= next) {
      const t = (next - acc) / (len || 1);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      next += stepM;
    }
    acc += len;
  }
  return out;
}

/**
 * Lo revirada que es una ruta, en grados de giro por km. Se ignoran los giros
 * bruscos (> 75° en 50 m), que son cruces y rotondas, no curvas.
 * Referencia: autovía ≈ 5-10 °/km, nacional en llano ≈ 15-25, puerto de montaña > 80.
 */
export function curvature(coords) {
  const pts = resample(coords, 50);
  if (pts.length < 3) return 0;
  let sum = 0;
  let prev = bearing(pts[0], pts[1]);
  for (let i = 1; i < pts.length - 1; i++) {
    const h = bearing(pts[i], pts[i + 1]);
    const delta = Math.abs(((h - prev + 540) % 360) - 180);
    if (delta < 75) sum += delta;
    prev = h;
  }
  return sum / ((pts.length * 50) / 1000);
}

/**
 * Cuánto se aleja la ruta de su destino por el camino: suma de los km en los que la
 * distancia en línea recta hasta `target` aumenta, dividida entre la distancia inicial.
 * Una ruta que avanza siempre da ~0; las curvas de una carretera revirada dan poco
 * (~0,05); subir 20 km hacia un lado para luego volver, mucho más.
 */
export function regression(coords, target) {
  const pts = resample(coords, 1000);
  if (pts.length < 2) return 0;
  let prev = distanceM(pts[0], target);
  const start = prev || 1;
  let away = 0;
  for (let i = 1; i < pts.length; i++) {
    const d = distanceM(pts[i], target);
    if (d > prev) away += d - prev;
    prev = d;
  }
  return away / start;
}

// ---------- parecido entre rutas (para que las alternativas sean distintas) ----------

const FP_CELL = 0.02; // ~2 km
const fpKey = (p) => `${Math.round(p[0] / FP_CELL)},${Math.round(p[1] / (FP_CELL * 1.35))}`;

/** Huella de una ruta: celdas de ~2 km por las que pasa. */
export function footprint(coords) {
  return new Set(resample(coords, 1000).map(fpKey));
}

/** Fracción de la ruta que pasa por la huella de otra (0 = nada en común, 1 = la misma). */
export function similarity(coords, fp) {
  const pts = resample(coords, 1000);
  return pts.length ? pts.filter((p) => fp.has(fpKey(p))).length / pts.length : 0;
}

/** Fracción de la ruta que pasa por sitios por los que ya pasó (ida y vuelta por la misma carretera). */
export function overlap(coords) {
  const pts = resample(coords, 100);
  const seen = new Map(); // celda (~200 m) -> índice de la primera muestra
  let repeated = 0;
  pts.forEach((p, i) => {
    const key = `${Math.round(p[0] / 0.002)},${Math.round(p[1] / 0.0025)}`;
    if (!seen.has(key)) seen.set(key, i);
    else if (i - seen.get(key) > 10) repeated++; // vuelta tras más de 1 km
  });
  return pts.length ? repeated / pts.length : 0;
}
