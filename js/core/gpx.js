// Exportación / importación GPX.
// La ruta (<rte>) guarda todos los puntos, incluidos los de paso, para que al
// reimportar la ruta salga exactamente igual (<type>: stop, via o night = fin de etapa). El track (<trk>) lleva la geometría
// completa para usarla en otros navegadores (TomTom, Garmin, OsmAnd...).

const esc = (s) => String(s).replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
const fmt = (n) => n.toFixed(6);

export function routeToGpx(name, waypoints, route) {
  const stops = waypoints.filter((w) => w.kind === 'stop');
  const out = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="MotoRuta" xmlns="http://www.topografix.com/GPX/1/1">',
    `  <metadata><name>${esc(name)}</name><time>${new Date().toISOString()}</time></metadata>`,
  ];

  stops.forEach((w, i) => {
    out.push(`  <wpt lat="${fmt(w.lat)}" lon="${fmt(w.lng)}"><name>${esc(w.name || `Parada ${i + 1}`)}</name></wpt>`);
  });

  out.push(`  <rte><name>${esc(name)}</name>`);
  waypoints.forEach((w, i) => {
    const label = w.kind === 'stop' ? w.name || `Parada ${i + 1}` : `Paso ${i}`;
    out.push(`    <rtept lat="${fmt(w.lat)}" lon="${fmt(w.lng)}"><name>${esc(label)}</name><type>${w.night ? 'night' : w.kind}</type></rtept>`);
  });
  out.push('  </rte>');

  if (route) {
    out.push(`  <trk><name>${esc(name)}</name><trkseg>`);
    route.legs.forEach((leg, li) => {
      // el primer punto de cada tramo repite el último del anterior
      leg.coords.forEach(([lat, lng], i) => {
        if (li > 0 && i === 0) return;
        out.push(`    <trkpt lat="${fmt(lat)}" lon="${fmt(lng)}"/>`);
      });
    });
    out.push('  </trkseg></trk>');
  }

  out.push('</gpx>');
  return out.join('\n');
}

/** Devuelve {name, waypoints} o lanza un Error con mensaje legible. */
export function gpxToWaypoints(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('El archivo no es un GPX válido.');

  const name = doc.querySelector('metadata > name, rte > name, trk > name')?.textContent || 'Ruta importada';
  const read = (el, kind) => ({
    lat: parseFloat(el.getAttribute('lat')),
    lng: parseFloat(el.getAttribute('lon')),
    kind,
    name: el.querySelector('name')?.textContent || '',
  });

  const rtepts = [...doc.getElementsByTagName('rtept')];
  if (rtepts.length >= 2) {
    const waypoints = rtepts.map((el, i) => {
      const type = el.querySelector('type')?.textContent;
      const isEnd = i === 0 || i === rtepts.length - 1;
      const w = read(el, isEnd || type !== 'via' ? 'stop' : 'via');
      if (w.kind === 'via') w.name = '';
      if (type === 'night' && !isEnd) w.night = true;
      return w;
    });
    return { name, waypoints };
  }

  const wpts = [...doc.getElementsByTagName('wpt')];
  if (wpts.length >= 2) return { name, waypoints: wpts.map((el) => read(el, 'stop')) };

  const trkpts = [...doc.getElementsByTagName('trkpt')];
  if (trkpts.length >= 2) return { name, waypoints: simplifyTrack(trkpts.map((el) => read(el, 'via'))) };

  throw new Error('El GPX no contiene una ruta ni puntos.');
}

// Un track solo trae geometría: lo convertimos en puntos de paso cada ~3 km
// para que el planificador lo recalcule siguiendo el mismo recorrido.
function simplifyTrack(points) {
  const result = [points[0]];
  let acc = 0;
  for (let i = 1; i < points.length - 1; i++) {
    acc += distanceKm(points[i - 1], points[i]);
    if (acc >= 3) {
      result.push(points[i]);
      acc = 0;
    }
  }
  result.push(points[points.length - 1]);
  result[0].kind = 'stop';
  result[result.length - 1].kind = 'stop';
  return result;
}

export function distanceKm(a, b) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
