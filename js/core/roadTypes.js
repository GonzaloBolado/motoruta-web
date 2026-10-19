// Clasificación de vías a partir de los atributos de arista de Valhalla.
// Módulo puro (sin DOM): se reutilizará en el navegador de la app móvil.
//
// Colores de la ruta en verdes y azules: el mapa base ya pinta las carreteras en
// amarillos y naranjas, y la ruta tiene que distinguirse de él.

export const ROAD_TYPES = {
  cabras: {
    label: 'Camino de cabras',
    hint: 'Pista, camino o firme sin asfaltar',
    color: '#a1887f',
    dash: '2 8',
  },
  estrecha: {
    label: 'Carretera estrecha asfaltada',
    hint: 'Locales, terciarias, sin clasificar',
    color: '#2e9e4f',
  },
  nacional: {
    label: 'Nacional normal',
    hint: 'Nacionales y autonómicas de un carril por sentido',
    color: '#4fc3f7',
  },
  nacional_grande: {
    label: 'Nacional grande',
    hint: 'Nacionales desdobladas, con 2+ carriles por sentido',
    color: '#1e88e5',
  },
  autovia: {
    label: 'Autovía / autopista',
    hint: 'Motorway en OSM',
    color: '#0b3d91',
  },
  ferry: {
    label: 'Ferry',
    hint: 'Tramo en barco',
    color: '#8e5cc4',
    dash: '8 6',
  },
  desconocido: {
    label: 'Sin datos',
    hint: 'No se pudo clasificar el tramo',
    color: '#9e9e9e',
  },
};

export const ROAD_TYPE_ORDER = ['cabras', 'estrecha', 'nacional', 'nacional_grande', 'autovia', 'ferry', 'desconocido'];

const UNPAVED_SURFACES = new Set(['compacted', 'dirt', 'gravel', 'path', 'impassable']);
const OFFROAD_USES = new Set([
  'track', 'path', 'footway', 'cycleway', 'bridleway', 'mountain_bike', 'pedestrian', 'steps',
]);

/** Devuelve la clave de ROAD_TYPES para una arista de trace_attributes. */
export function classifyEdge(edge) {
  if (edge.use === 'ferry' || edge.use === 'rail-ferry') return 'ferry';
  if (edge.unpaved || UNPAVED_SURFACES.has(edge.surface) || OFFROAD_USES.has(edge.use)) return 'cabras';

  // Desdoblada: calzada de sentido único con 2+ carriles. No basta con la etiqueta
  // trunk: en España hay "trunk" que son carreteras de montaña de un carril (M-601).
  // Tampoco basta con lane_count: los carriles de adelantamiento lo suben a 2.
  const dualCarriageway = edge.traversability !== 'both' && (edge.lane_count || 1) >= 2;
  switch (edge.road_class) {
    case 'motorway':
      return 'autovia';
    case 'trunk':
    case 'primary':
    case 'secondary':
      return dualCarriageway ? 'nacional_grande' : 'nacional';
    case 'tertiary':
    case 'unclassified':
    case 'residential':
    case 'service_other':
      return 'estrecha';
    default:
      return 'desconocido';
  }
}

/** Nombre legible de una vía: prioriza la referencia (N-110, A-6...) sobre el nombre. */
export function roadName(names) {
  if (!names || names.length === 0) return '';
  const refs = names.filter((n) => /^[A-Z]{1,4}-?\d/.test(n));
  const others = names.filter((n) => !refs.includes(n));
  return [...refs, ...others].slice(0, 2).join(' · ');
}
