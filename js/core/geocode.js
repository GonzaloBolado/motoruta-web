// Búsqueda de lugares sobre datos de OpenStreetMap:
//  - Photon para las sugerencias mientras se escribe
//  - Nominatim para saber qué pueblo hay en un punto (máx. 1 petición/segundo)

const NOMINATIM = 'https://nominatim.openstreetmap.org';

let nextSlot = 0;
async function throttle() {
  const wait = Math.max(0, nextSlot - Date.now());
  nextSlot = Date.now() + wait + 1100;
  if (wait) await new Promise((r) => setTimeout(r, wait));
}

// ---------- sugerencias mientras se escribe (Photon) ----------
// Nominatim prohíbe el autocompletado; Photon (también datos de OSM) está hecho para eso.

const PHOTON = 'https://photon.komoot.io/api/';

// Photon mezcla pueblos con bancos, paradas de bus o calles que se llaman igual:
// se reordena para que salgan antes los sitios a los que se va en moto.
function placePenalty({ osm_key: key, osm_value: value }) {
  if (key === 'place') return ['city', 'town'].includes(value) ? -4 : ['village', 'hamlet', 'locality', 'suburb'].includes(value) ? -1 : 2;
  if (key === 'mountain_pass' || key === 'natural' || value === 'viewpoint') return -1;
  if (key === 'tourism' || key === 'historic' || key === 'aeroway') return 2;
  if (key === 'highway') return value === 'bus_stop' ? 10 : 5;
  if (key === 'railway' || key === 'boundary') return 6;
  return 9; // comercios, oficinas, edificios...
}

/** Sugerencias para lo que se lleva escrito: [{name, detail, lat, lng}] */
export async function suggestPlaces(query, near, signal) {
  const params = new URLSearchParams({ q: query, limit: '15', lang: 'default', location_bias_scale: '0.3', zoom: '9' });
  if (near) {
    params.set('lat', near.lat.toFixed(4));
    params.set('lon', near.lng.toFixed(4));
  }
  const res = await fetch(`${PHOTON}?${params}`, { signal });
  if (!res.ok) throw new Error('No se pudo buscar el lugar.');
  const data = await res.json();

  const seen = new Set();
  return data.features
    .map((f, i) => ({ f, score: i + placePenalty(f.properties) }))
    .sort((a, b) => a.score - b.score)
    .map(({ f }) => {
      const p = f.properties;
      const where = [p.city !== p.name && p.city, p.county !== p.name && p.county, p.state, p.country !== 'España' && p.country];
      return {
        name: p.name || p.street || '',
        detail: [...new Set(where.filter(Boolean))].join(', '),
        lat: f.geometry.coordinates[1],
        lng: f.geometry.coordinates[0],
      };
    })
    .filter((r) => {
      const key = `${r.name}|${r.detail}`;
      if (!r.name || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 6);
}

/** Pueblo o ciudad más cercano: {name, lat, lng} (posición del núcleo) o null. */
export async function reverseGeocodePlace(lat, lng) {
  const params = new URLSearchParams({
    lat: String(lat),
    lon: String(lng),
    format: 'jsonv2',
    zoom: '10',
    'accept-language': 'es',
  });
  try {
    await throttle();
    const res = await fetch(`${NOMINATIM}/reverse?${params}`);
    if (!res.ok) return null;
    const r = await res.json();
    const a = r.address || {};
    const name = a.town || a.city || a.village || a.municipality || r.name;
    return name ? { name, lat: parseFloat(r.lat), lng: parseFloat(r.lon) } : null;
  } catch {
    return null;
  }
}

export async function reverseGeocode(lat, lng) {
  const params = new URLSearchParams({
    lat: String(lat),
    lon: String(lng),
    format: 'jsonv2',
    zoom: '14',
    'accept-language': 'es',
  });
  try {
    await throttle();
    const res = await fetch(`${NOMINATIM}/reverse?${params}`);
    if (!res.ok) return '';
    const r = await res.json();
    const a = r.address || {};
    return a.village || a.town || a.city || a.hamlet || a.municipality || a.county || r.name || '';
  } catch {
    return '';
  }
}
