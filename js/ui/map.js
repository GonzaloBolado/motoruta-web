// Mapa base y capas (carreteras, satélite, híbrido, topográfico).

import { loadMotoStyle, DETAIL_SOURCE, FINE_SOURCE, FINE_WINDOWS } from './motoStyle.js';

const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services';

function satelliteLabels() {
  return [
    L.tileLayer(`${ESRI}/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}`, { maxZoom: 19, opacity: 0.9 }),
    L.tileLayer(`${ESRI}/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}`, { maxZoom: 19 }),
  ];
}

// Las teselas solo traen las secundarias y terciarias a partir de cierto nivel. Con
// tileSize 256 MapLibre pide las teselas del nivel siguiente (más detalle por pantalla) y
// las carreteras pequeñas aparecen un nivel de zoom antes. El estilo no admite ese valor
// en fuentes vectoriales, así que se cambia en la fuente ya creada (solo la de carreteras).
// (FINE_SOURCE, solo en una franja de zoom: 128 px, dos niveles más; ver motoStyle.js)
const TILE_SIZES = { [DETAIL_SOURCE]: 256, [FINE_SOURCE]: 128 };

function moreDetail(gl) {
  const apply = () => {
    for (const [id, size] of Object.entries(TILE_SIZES)) {
      const source = gl.getSource(id);
      if (!source || source.tileSize === size) continue;
      source.tileSize = size;
      gl.style.sourceCaches[id]?.clearTiles();
    }
    gl.triggerRepaint();
  };
  if (gl.getSource(DETAIL_SOURCE)) apply();
  else gl.once('styledata', apply);
}

// ---------- mostrar / ocultar autovías en el mapa "Carreteras" ----------

let motorwaysVisible = true;
try {
  motorwaysVisible = localStorage.getItem('motoruta.motorways') !== 'off';
} catch {}
let motoGl = null;
const originalShieldFilter = new Map();

function applyMotorways(gl) {
  if (!gl?.getStyle()) return;
  for (const layer of gl.getStyle().layers) {
    if (layer['source-layer'] === 'transportation' && /motorway/.test(layer.id)) {
      gl.setLayoutProperty(layer.id, 'visibility', motorwaysVisible ? 'visible' : 'none');
    }
    // sin la autovía, sus señales (A-66, AP-66…) quedarían flotando
    if (layer.id.startsWith('highway-shield') || layer.id.startsWith('road_shield')) {
      if (!originalShieldFilter.has(layer.id)) originalShieldFilter.set(layer.id, layer.filter);
      const original = originalShieldFilter.get(layer.id);
      gl.setFilter(layer.id, motorwaysVisible ? original : ['all', original, ['!=', ['get', 'class'], 'motorway']]);
    }
  }
}

function setMotorwaysVisible(visible) {
  motorwaysVisible = visible;
  try {
    localStorage.setItem('motoruta.motorways', visible ? 'on' : 'off');
  } catch {}
  applyMotorways(motoGl);
}

// carreteras blancas de VersaTiles: solo en su franja de zoom (fuera, ni se descargan)
function syncFineRoads(gl) {
  if (!gl.getStyle()) return;
  const z = gl.getZoom();
  for (const [id, [min, max]] of Object.entries(FINE_WINDOWS)) {
    const visibility = z >= min && z < max ? 'visible' : 'none';
    if (gl.getLayer(id) && gl.getLayoutProperty(id, 'visibility') !== visibility) {
      gl.setLayoutProperty(id, 'visibility', visibility);
    }
  }
}

function whenStyleReady(gl, fn) {
  if (gl.isStyleLoaded()) fn();
  else gl.once('load', fn);
}

function motoRoadsLayer(stylePromise) {
  const group = L.layerGroup();
  stylePromise
    .then((style) => {
      const layer = L.maplibreGL({
        style,
        attribution:
          '&copy; <a href="https://openfreemap.org">OpenFreeMap</a> &copy; <a href="https://www.openmaptiles.org/">OpenMapTiles</a> ' +
          '&copy; <a href="https://versatiles.org">VersaTiles</a> ' +
          '&copy; colaboradores de <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      });
      layer.on('add', () => {
        motoGl = layer.getMaplibreMap();
        moreDetail(motoGl);
        whenStyleReady(motoGl, () => {
          applyMotorways(motoGl);
          syncFineRoads(motoGl);
        });
        motoGl.on('zoom', () => syncFineRoads(motoGl));
      });
      layer.addTo(group);
    })
    .catch((err) => {
      // sin estilo vectorial: caemos al mapa clásico de OSM
      console.warn(err);
      osmClassic().addTo(group);
    });
  return group;
}

const osmClassic = () =>
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; colaboradores de <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  });

export function createMap(container) {
  const map = L.map(container, { zoomControl: false, doubleClickZoom: false });
  // al abrir, el mapa vuelve a donde lo dejaste
  try {
    const v = JSON.parse(localStorage.getItem('motoruta.view'));
    map.setView(v ? [v.lat, v.lng] : [40.25, -3.7], v ? v.zoom : 7);
  } catch {
    map.setView([40.25, -3.7], 7);
  }
  map.on('moveend', () => {
    const c = map.getCenter();
    try {
      localStorage.setItem('motoruta.view', JSON.stringify({ lat: c.lat, lng: c.lng, zoom: map.getZoom() }));
    } catch {}
  });
  L.control.zoom({ position: 'bottomright' }).addTo(map);
  // «mi ubicación» encima del zoom, como en Google Maps (las esquinas de abajo apilan hacia arriba)
  addLocateControl(map);
  L.control.scale({ position: 'bottomleft', imperial: false }).addTo(map);

  const esriImagery = () =>
    L.tileLayer(`${ESRI}/World_Imagery/MapServer/tile/{z}/{y}/{x}`, {
      maxZoom: 19,
      attribution: 'Imágenes &copy; Esri, Maxar, Earthstar Geographics',
    });

  const baseLayers = {
    Carreteras: motoRoadsLayer(loadMotoStyle()),
    'OpenStreetMap clásico': osmClassic(),
    'Satélite + nombres': L.layerGroup([esriImagery(), ...satelliteLabels()]),
    'Topográfico': L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
      maxZoom: 17,
      attribution: '&copy; OpenStreetMap, SRTM | estilo &copy; OpenTopoMap (CC-BY-SA)',
    }),
  };

  let current = 'Carreteras';
  try {
    const saved = localStorage.getItem('motoruta.baseLayer');
    if (saved && baseLayers[saved]) current = saved;
  } catch {}
  baseLayers[current].addTo(map);

  // casilla para ocultar autovías (solo afecta al mapa "Carreteras"); es una capa vacía
  // que el control de capas muestra como casilla
  const motorwaysToggle = L.layerGroup();
  if (motorwaysVisible) motorwaysToggle.addTo(map);
  const compact = window.innerWidth < 760;
  const layersControl = L.control
    .layers(baseLayers, { 'Mostrar autovías': motorwaysToggle }, { position: 'topright', collapsed: compact })
    .addTo(map);
  if (compact) {
    // móvil: la lista desplegada se cierra con ✕ o al elegir un mapa, y vuelve al icono
    const section = layersControl.getContainer().querySelector('.leaflet-control-layers-list');
    const close = L.DomUtil.create('button', 'layers-close');
    close.type = 'button';
    close.textContent = '✕';
    close.title = 'Cerrar';
    section.prepend(close);
    L.DomEvent.on(close, 'click', (e) => {
      L.DomEvent.stop(e);
      layersControl.collapse();
    });
    map.on('baselayerchange', () => layersControl.collapse());
  }
  map.on('overlayadd overlayremove', (e) => {
    if (e.layer === motorwaysToggle) setMotorwaysVisible(e.type === 'overlayadd');
  });
  map.on('baselayerchange', (e) => {
    try {
      localStorage.setItem('motoruta.baseLayer', e.name);
    } catch {}
  });
  compactAttribution(map);

  return map;
}

/**
 * Botón «mi ubicación»: centra el mapa donde estás y lo marca con un punto azul (con su
 * círculo de precisión). Sigue tu posición mientras el mapa no se mueva a mano.
 */
function addLocateControl(map) {
  let dot = null;
  let ring = null;
  let watch = null;
  const Locate = L.Control.extend({
    options: { position: 'bottomright' },
    onAdd() {
      const b = L.DomUtil.create('button', 'locate-control');
      b.type = 'button';
      b.title = 'Mi ubicación';
      b.innerHTML =
        '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.5" fill="currentColor"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>';
      L.DomEvent.disableClickPropagation(b);
      L.DomEvent.on(b, 'click', () => locate(b));
      return b;
    },
  });
  const show = (pos, center) => {
    const ll = [pos.coords.latitude, pos.coords.longitude];
    const acc = Math.min(pos.coords.accuracy || 50, 2000);
    if (!dot) {
      ring = L.circle(ll, { radius: acc, color: '#1a73e8', weight: 1, fillColor: '#1a73e8', fillOpacity: 0.12, interactive: false }).addTo(map);
      dot = L.circleMarker(ll, { radius: 7, color: '#fff', weight: 2.5, fillColor: '#1a73e8', fillOpacity: 1, interactive: false }).addTo(map);
    } else {
      dot.setLatLng(ll);
      ring.setLatLng(ll).setRadius(acc);
    }
    if (center) map.setView(ll, Math.max(map.getZoom(), 14));
  };
  const locate = (b) => {
    if (!navigator.geolocation) return;
    b.classList.add('busy');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        b.classList.remove('busy');
        b.classList.add('on');
        show(pos, true);
        // el punto se actualiza solo mientras sigas en el planificador
        if (watch === null) watch = navigator.geolocation.watchPosition((p) => show(p, false), () => {}, { enableHighAccuracy: true });
      },
      () => {
        b.classList.remove('busy');
        b.title = 'No se pudo obtener tu ubicación';
        b.classList.add('error');
        setTimeout(() => b.classList.remove('error'), 2000);
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 }
    );
  };
  new Locate().addTo(map);
}

/**
 * Créditos del mapa (obligatorios: OpenStreetMap, OpenFreeMap/OpenMapTiles…) plegados en un
 * botón «ⓘ» que se despliega al tocarlo, como en los mapas del móvil. Sin el prefijo de Leaflet.
 */
function compactAttribution(map) {
  const ctl = map.attributionControl;
  ctl.setPrefix(false);
  const box = ctl.getContainer();
  box.classList.add('attr-compact');
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'attr-toggle';
  btn.title = 'Créditos del mapa';
  btn.textContent = 'i';
  box.prepend(btn);
  // Leaflet reescribe el contenido al cambiar de capa: el botón se vuelve a poner
  const update = ctl._update.bind(ctl);
  ctl._update = () => {
    update();
    box.prepend(btn);
  };
  L.DomEvent.disableClickPropagation(box);
  btn.addEventListener('click', () => box.classList.toggle('open'));
}
