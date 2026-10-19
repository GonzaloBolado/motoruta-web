// Sitios cerca de la ruta para buscarlos en la moto sin conexión: para comer, talleres y
// supermercados.
// Salen de las propias teselas vectoriales del mapa (OpenFreeMap, capa "poi" a zoom 14),
// porque los servidores públicos de Overpass no responden de forma fiable.

import { resample, distanceM } from './geometry.js';

const TILEJSON = 'https://tiles.openfreemap.org/planet';
const Z = 14;
// categoría → subclases de la capa poi de OpenMapTiles
const CATEGORIES = {
  food: ['restaurant', 'fast_food', 'cafe'],
  // talleres de coche y tiendas de motos (que suelen reparar)
  workshop: ['car_repair', 'motorcycle'],
  // supermercados y tiendas de alimentación (las de los pueblos)
  supermarket: ['supermarket', 'convenience', 'department_store'],
};
const CATEGORY_OF = new Map(Object.entries(CATEGORIES).flatMap(([cat, subs]) => subs.map((s) => [s, cat])));
const MAX_DISTANCE_M = 2_000;

let libs = null;
async function loadLibs() {
  // decodificadores de teselas: solo se cargan al exportar
  libs ||= Promise.all([
    import('../../vendor/pbf.js'),
    import('../../vendor/vector-tile.js'),
  ]);
  const [pbf, vt] = await libs;
  return { Pbf: pbf.default, VectorTile: vt.VectorTile };
}

const tileX = (lng) => Math.floor(((lng + 180) / 360) * 2 ** Z);
const tileY = (lat) => {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** Z);
};

/** Teselas que tocan la ruta y sus vecinas (~1,8 km a cada lado a zoom 14). */
function corridorTiles(coords) {
  const set = new Set();
  for (const [lat, lng] of resample(coords, 500)) {
    const x = tileX(lng);
    const y = tileY(lat);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) set.add(`${x + dx}/${y + dy}`);
  }
  return [...set].map((k) => k.split('/').map(Number));
}

/**
 * @returns {food, workshop, supermarket}: [{name, kind (subclase), lat, lng}] a menos de 2 km
 */
export async function poisAlongRoute(coords, onProgress = () => {}, signal) {
  const { Pbf, VectorTile } = await loadLibs();
  const tj = await (await fetch(TILEJSON, { signal })).json();
  const url = tj.tiles[0];
  const tiles = corridorTiles(coords);
  const route = resample(coords, 250);

  const found = new Map();
  let done = 0;
  let next = 0;
  const worker = async () => {
    while (next < tiles.length) {
      const [x, y] = tiles[next++];
      try {
        const res = await fetch(url.replace('{z}', Z).replace('{x}', x).replace('{y}', y), { signal });
        if (res.ok) {
          const layer = new VectorTile(new Pbf(new Uint8Array(await res.arrayBuffer()))).layers.poi;
          for (let i = 0; layer && i < layer.length; i++) {
            const f = layer.feature(i);
            const p = f.properties;
            const category = CATEGORY_OF.get(p.subclass) || CATEGORY_OF.get(p.class);
            if (!category) continue;
            const name = p['name:es'] || p.name;
            if (!name) continue;
            const [lng, lat] = f.toGeoJSON(x, y, Z).geometry.coordinates;
            if (typeof lat !== 'number') continue;
            found.set(`${name}|${lat.toFixed(4)}|${lng.toFixed(4)}`, {
              name,
              kind: CATEGORY_OF.has(p.subclass) ? p.subclass : p.class,
              category,
              lat: Math.round(lat * 1e6) / 1e6,
              lng: Math.round(lng * 1e6) / 1e6,
            });
          }
        }
      } catch (err) {
        if (err.name === 'AbortError') throw err;
      }
      onProgress(++done, tiles.length);
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));

  // solo los que quedan cerca de la ruta (las teselas vecinas cubren algo más)
  const near = [...found.values()].filter((poi) => route.some((r) => distanceM(r, [poi.lat, poi.lng]) < MAX_DISTANCE_M));
  const out = Object.fromEntries(Object.keys(CATEGORIES).map((cat) => [cat, []]));
  for (const { category, ...poi } of near) out[category].push(poi);
  return out;
}
