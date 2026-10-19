// Estilo vectorial "pensado para moto" a partir del estilo Liberty de OpenFreeMap:
//  - carreteras visibles y con contraste desde poco zoom (como Google Maps)
//  - pueblos y referencias de carretera (N-110, A-6...) antes
//  - sin relieve sombreado; solo los picos importantes y los puertos de montaña
//  - nombres en español

const BASE_STYLE = 'https://tiles.openfreemap.org/styles/liberty';
export const DETAIL_SOURCE = 'roads_detail';

// Carreteras blancas (terciarias y locales) con poco zoom. OpenFreeMap (con teselas de
// 256 px, ver map.js) no trae terciarias hasta el zoom 11 de Leaflet ni locales hasta el
// 12. VersaTiles con teselas de 128 px (dos niveles más de detalle) las trae desde el 9 y
// el 11. Así que en esas franjas se dibujan desde VersaTiles, y fuera de ellas no se
// cargan (menos descargas) y las pinta OpenFreeMap.
// Franjas en zoom de MapLibre (uno menos que el de Leaflet). map.js muestra y oculta estas
// capas según el zoom: minzoom/maxzoom no sirven aquí, porque MapLibre los compara con el
// nivel de la tesela (dos por encima del zoom con 128 px) al preparar los datos.
export const FINE_SOURCE = 'roads_fine';
export const FINE_WINDOWS = {
  fine_tertiary_casing: [8, 10],
  fine_tertiary: [8, 10],
  fine_minor_casing: [10, 11],
  fine_minor: [10, 11],
};
const VERSATILES = 'https://tiles.versatiles.org/tiles/osm/{z}/{x}/{y}';
// [zoom, relleno, borde] más finas que las de OpenFreeMap: con poco zoom hay muchísimas
const FINE_WIDTHS = {
  tertiary: [[8, 0.2, 0.55], [9, 0.35, 0.8], [10, 0.55, 1.1]],
  unclassified: [[10, 0.3, 0.75], [11, 0.45, 1]],
};

// [zoom, grosor] del relleno de cada tipo de vía. Las autovías mandan; el resto va
// claramente más fino para que la red secundaria no se coma el mapa.
const WIDTHS = {
  motorway: [[4, 0.8], [6, 1.6], [8, 2.6], [10, 3.6], [12, 5], [14, 8], [18, 22]],
  trunk_primary: [[5, 0.6], [6, 1], [8, 1.7], [10, 2.2], [12, 3], [14, 4.8], [18, 13]],
  secondary_tertiary: [[6, 0.6], [7, 1], [8, 1.3], [10, 1.6], [12, 2.1], [14, 3.6], [18, 9]],
  minor: [[10, 0.3], [11, 0.4], [12, 0.7], [14, 2.2], [18, 7]],
  service_track: [[12, 0.4], [14, 1.2], [18, 5]],
};

const COLORS = {
  motorway: { fill: '#f2a95b', casing: '#b26a24' },
  trunk_primary: { fill: '#f9d773', casing: '#b48a2c' },
  secondary_tertiary: {
    fill: ['match', ['get', 'class'], 'secondary', '#ffe98c', '#ffffff'],
    casing: ['match', ['get', 'class'], 'secondary', '#9c8140', '#7a7a7a'],
  },
  minor: { fill: '#ffffff', casing: '#9a9a9a' },
  service_track: {
    fill: ['match', ['get', 'class'], 'track', '#c8a882', '#ffffff'],
    casing: ['match', ['get', 'class'], 'track', 'rgba(0,0,0,0)', '#bdbdbd'],
  },
};

function roadGroup(id) {
  if (/_link/.test(id)) return null;
  if (/motorway/.test(id)) return 'motorway';
  if (/trunk_primary/.test(id)) return 'trunk_primary';
  if (/secondary_tertiary/.test(id)) return 'secondary_tertiary';
  if (/service_track/.test(id)) return 'service_track';
  if (/_minor|_street/.test(id)) return 'minor';
  return null;
}

// borde: proporcional al grosor, con un mínimo para que se vea a poco zoom
const widthExpr = (stops, casing) => [
  'interpolate',
  ['linear'],
  ['zoom'],
  ...stops.flatMap(([z, w]) => [z, casing ? w + Math.max(z < 12 ? 0.5 : 0.9, w * 0.3) : w]),
];

const NAME = ['coalesce', ['get', 'name:es'], ['get', 'name']];

// Ver FINE_SOURCE.
function addFineRoads(style) {
  style.sources[FINE_SOURCE] = {
    type: 'vector',
    tiles: [VERSATILES],
    maxzoom: 14,
    attribution: '&copy; <a href="https://versatiles.org">VersaTiles</a>',
  };

  const fine = (id, kind, casing) => ({
    id,
    type: 'line',
    source: FINE_SOURCE,
    'source-layer': 'streets',
    filter: ['all', ['==', ['get', 'kind'], kind], ['!=', ['get', 'link'], true]],
    layout: { 'line-join': 'round', 'line-cap': 'round', visibility: 'none' }, // map.js
    paint: {
      'line-color': casing ? '#a6a6a6' : '#ffffff',
      'line-width': ['interpolate', ['linear'], ['zoom'], ...FINE_WIDTHS[kind].flatMap(([z, w, c]) => [z, casing ? c : w])],
    },
  });
  // debajo de las secundarias, para que en los cruces mande la carretera mayor
  const at = style.layers.findIndex((l) => l.id === 'road_secondary_tertiary_casing');
  style.layers.splice(
    at,
    0,
    fine('fine_minor_casing', 'unclassified', true),
    fine('fine_minor', 'unclassified', false),
    fine('fine_tertiary_casing', 'tertiary', true),
    fine('fine_tertiary', 'tertiary', false)
  );
}

export async function loadMotoStyle() {
  const res = await fetch(BASE_STYLE);
  if (!res.ok) throw new Error('No se pudo cargar el estilo del mapa');
  const style = await res.json();

  // Copia de la fuente solo para las líneas de carretera: map.js la pasa a teselas de 256 px
  // para tener más detalle con poco zoom. Las etiquetas siguen en la original, porque la
  // colocación de textos con teselas de 256 los amontona.
  style.sources[DETAIL_SOURCE] = { ...style.sources.openmaptiles };

  // fuera el relieve sombreado; parques naturales mucho más discretos
  style.layers = style.layers.filter((l) => !['natural_earth', 'park_outline'].includes(l.id));

  for (const layer of style.layers) {
    const layout = (layer.layout ||= {});
    const paint = (layer.paint ||= {});

    // nombres en español en vez de en inglés
    if (layout['text-field']) {
      layout['text-field'] = JSON.parse(JSON.stringify(layout['text-field']).replaceAll('"name_en"', '"name:es"'));
    }

    if (layer.id === 'park') paint['fill-opacity'] = 0.25;

    const group = layer['source-layer'] === 'transportation' && layer.type === 'line' && roadGroup(layer.id);
    if (group) {
      const isCasing = layer.id.endsWith('_casing');
      layer.source = DETAIL_SOURCE;
      delete layer.minzoom;
      paint['line-width'] = widthExpr(WIDTHS[group], isCasing);
      paint['line-color'] = COLORS[group][isCasing ? 'casing' : 'fill'];
      delete paint['line-opacity'];
      if (group === 'service_track' && !isCasing && !layer.id.startsWith('tunnel')) {
        paint['line-dasharray'] = ['literal', [2, 1.5]];
      }
    }

    switch (layer.id) {
      case 'label_town':
        layer.minzoom = 6;
        layout['text-font'] = ['Noto Sans Bold'];
        layout['text-size'] = ['interpolate', ['linear'], ['zoom'], 6, 11, 9, 13, 12, 16];
        break;
      case 'label_village':
        layer.minzoom = 8;
        layout['text-size'] = ['interpolate', ['linear'], ['zoom'], 8, 10.5, 11, 13, 14, 15];
        break;
      case 'label_other':
        layer.minzoom = 11; // aldeas, barrios, parajes
        break;
      case 'highway-shield-non-us':
        layer.minzoom = 6.5;
        layout['text-size'] = 11;
        layout['symbol-spacing'] = 300;
        break;
      case 'highway-name-major':
        layer.minzoom = 11;
        break;
    }
  }

  addFineRoads(style);

  // picos importantes (≥ 2000 m) y puertos de montaña
  const peakFont = ['Noto Sans Italic'];
  const before = style.layers.findIndex((l) => l.id === 'label_other');
  style.layers.splice(
    before,
    0,
    {
      id: 'moto_peaks',
      type: 'symbol',
      source: 'openmaptiles',
      'source-layer': 'mountain_peak',
      minzoom: 8,
      filter: ['all', ['==', ['get', 'class'], 'peak'], ['>=', ['to-number', ['get', 'ele'], 0], 2000]],
      layout: {
        'text-field': ['concat', NAME, '\n', ['to-string', ['get', 'ele']], ' m'],
        'text-font': peakFont,
        'text-size': 11,
        'text-anchor': 'top',
      },
      paint: { 'text-color': '#7a5a32', 'text-halo-color': '#fff', 'text-halo-width': 1.3 },
    },
    {
      id: 'moto_passes',
      type: 'symbol',
      source: 'openmaptiles',
      'source-layer': 'mountain_peak',
      minzoom: 9,
      filter: ['==', ['get', 'class'], 'saddle'],
      layout: {
        'text-field': ['concat', NAME,['case', ['has', 'ele'], ['concat', ' (', ['to-string', ['get', 'ele']], ' m)'], '']],
        'text-font': ['Noto Sans Bold'],
        'text-size': 11,
        'text-anchor': 'bottom',
        'text-offset': [0, -0.3],
      },
      paint: { 'text-color': '#8e2c1c', 'text-halo-color': '#fff', 'text-halo-width': 1.5 },
    }
  );

  return style;
}
