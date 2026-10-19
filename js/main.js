import { createMap } from './ui/map.js';
import { RouteEditor, escapeHtml } from './ui/routeEditor.js';
import { computeRoute } from './core/valhalla.js';
import { ROAD_TYPES, ROAD_TYPE_ORDER } from './core/roadTypes.js';
import { reverseGeocode, reverseGeocodePlace } from './core/geocode.js';
import { attachAutocomplete } from './ui/autocomplete.js';
import { confirmDialog } from './ui/confirm.js';
import { routeToGpx, gpxToWaypoints, distanceKm } from './core/gpx.js';
import { routeIndicators } from './core/indicators.js';
import { fuelStationsAlongRoute, fuelNearRoute } from './core/fuel.js';
import { poisAlongRoute } from './core/pois.js';
import { camerasAlongRoute } from './core/cameras.js';
import { generateTrip, generateLoop, avoidHighwaysInRoute, ALTERNATIVES } from './core/autoroute.js';
import { splitDays, planNights } from './core/trip.js';
import { sampleSchedule, forecastSamples, weatherWarnings, describeWeather } from './core/weather.js';
import { openWizard } from './ui/wizard.js';
import { buildNavFile } from './core/navExport.js';
import { inApp, openInNavigator, shareFile, goHome, saveToLibrary, onPlanFromApp } from './ui/appBridge.js';
import { initSheet } from './ui/sheet.js';
import { DateField, fillTimeSelect, setTimeSelect } from './ui/dateTime.js';
import * as storage from './ui/storage.js';
import { icon } from './ui/icons.js';
import { errorText, undoHint } from './ui/errors.js';
import { initKeyboard } from './ui/keyboard.js';
import { checkOffroad } from './core/protected.js';
import { sunTimes } from './core/sun.js';

const $ = (id) => document.getElementById(id);

// smartHighways: ruta generada con «autovía solo si hace falta» (autoroute.js); los tramos de
// autovía que quedan son necesarios, así que se recalcula sin evitarlas del todo
const DEFAULT_OPTIONS = { avoidHighways: false, smartHighways: false, avoidTolls: false, allowTrails: false, allowFerry: false };

// interruptores del panel → preferencias de Valhalla (0 = evitar, 1 = preferir)
const toValhallaOptions = (o) => ({
  useHighways: o.avoidHighways ? (o.smartHighways ? 0.5 : 0) : 1,
  useTolls: o.avoidTolls ? 0 : 0.5,
  useTrails: o.allowTrails ? 0.5 : 0,
  useFerry: o.allowFerry ? 0.5 : 0,
});

// solo las claves conocidas (las rutas guardadas antiguas traían valores de deslizador)
const cleanOptions = (o = {}) =>
  Object.fromEntries(Object.keys(DEFAULT_OPTIONS).map((k) => [k, typeof o[k] === 'boolean' ? o[k] : DEFAULT_OPTIONS[k]]));

// salida por defecto: hoy a las 9:00, o mañana si ya es tarde
function defaultDeparture() {
  const d = new Date();
  if (d.getHours() >= 8) d.setDate(d.getDate() + 1);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T09:00`;
}

const state = {
  waypoints: [], // {id, lat, lng, kind: 'stop'|'via', name, night?: fin de etapa}
  options: { ...DEFAULT_OPTIONS },
  name: '',
  departure: defaultDeparture(), // 'YYYY-MM-DDTHH:MM', hora local
  route: null,
  fuel: null, // gasolineras en ruta: null = cargando, 'error' o lista
  weather: null, // null = cargando | {samples, unavailable} | {error}
  alternatives: null, // rutas generadas: {list, selected, params}
  offroad: null, // pistas de la ruta: null = sin pistas | 'loading' | 'error' | resultado de checkOffroad
  libraryId: null, // ruta de Mis rutas (app) que se está editando
  libraryName: null, // nombre con el que está guardada: otro nombre = ruta nueva
};
const undoStack = [];

let nextId = 1;
const makeWp = (lat, lng, kind = 'stop', name = '', night = false) => ({
  id: nextId++,
  lat,
  lng,
  kind,
  name,
  ...(night && kind === 'stop' && { night: true }),
});

// ---------- mapa ----------

const map = createMap('map');
const editor = new RouteEditor(map, {
  onMapClick: (ll) => addStop(ll, 'end'),
  onMove: (i, ll) =>
    update((wps) => {
      const w = { ...wps[i], lat: ll.lat, lng: ll.lng };
      if (w.kind === 'stop') w.name = '';
      wps[i] = w;
      if (w.kind === 'stop') nameStop(w.id);
    }),
  onInsert: (index, ll) => update((wps) => wps.splice(index, 0, makeWp(ll.lat, ll.lng, 'via'))),
  onRemove: (i) => update((wps) => wps.splice(i, 1)),
  onToggleKind: (i) =>
    update((wps) => {
      const kind = wps[i].kind === 'via' ? 'stop' : 'via';
      wps[i] = { ...wps[i], kind, night: false };
      if (kind === 'stop') nameStop(wps[i].id);
    }),
  onToggleNight: (i) => update((wps) => (wps[i] = { ...wps[i], kind: 'stop', night: !wps[i].night })),
  onContextAction: (action, ll) => addStop(ll, action),
});

// ---------- cambios de estado ----------

/** Aplica un cambio a la lista de puntos (guardando deshacer) y recalcula. */
function update(mutator, { recordUndo = true } = {}) {
  if (recordUndo) {
    undoStack.push(state.waypoints.map((w) => ({ ...w })));
    if (undoStack.length > 100) undoStack.shift();
  }
  const wps = state.waypoints.map((w) => ({ ...w }));
  mutator(wps);
  normalizeEnds(wps);
  state.waypoints = wps;
  afterWaypointsChange();
}

// la salida y la llegada siempre son paradas
function normalizeEnds(wps) {
  if (wps.length) {
    wps[0].kind = 'stop';
    wps[wps.length - 1].kind = 'stop';
    delete wps[0].night;
    delete wps[wps.length - 1].night;
  }
}

function afterWaypointsChange() {
  editor.setWaypoints(state.waypoints);
  renderStops();
  persist();
  recompute();
}

function addStop(ll, where) {
  const w = makeWp(ll.lat, ll.lng, 'stop');
  update((wps) => {
    if (where === 'start') wps.unshift(w);
    else if (where === 'middle') wps.splice(bestInsertIndex(wps, w), 0, w);
    else wps.push(w);
  });
  if (!w.name) nameStop(w.id);
}

// posición donde una parada nueva alarga menos la ruta
function bestInsertIndex(wps, p) {
  let best = 1;
  let bestCost = Infinity;
  for (let i = 0; i < wps.length - 1; i++) {
    const cost = distanceKm(wps[i], p) + distanceKm(p, wps[i + 1]) - distanceKm(wps[i], wps[i + 1]);
    if (cost < bestCost) {
      bestCost = cost;
      best = i + 1;
    }
  }
  return best;
}

async function nameStop(id) {
  const w = state.waypoints.find((x) => x.id === id);
  if (!w) return;
  const name = await reverseGeocode(w.lat, w.lng);
  const current = state.waypoints.find((x) => x.id === id);
  if (!current || current.name || !name) return;
  current.name = name;
  renderStops();
  persist();
}

function undo() {
  if (!undoStack.length) return;
  state.waypoints = undoStack.pop();
  afterWaypointsChange();
}

// ---------- cálculo ----------

let controller = null;
let generation = 0;

/** Recalcula la ruta. Devuelve la ruta nueva, o null si falla o la sustituye otro cálculo. */
async function recompute() {
  controller?.abort();
  const gen = ++generation;

  if (state.waypoints.length < 2) {
    state.route = null;
    state.fuel = null;
    state.weather = null;
    editor.setRoute(null);
    editor.setFuelStations([]);
    editor.setWeather([]);
    state.offroad = null;
    editor.setOffroad(null);
    renderIndicators();
    renderDays();
    setStatus('');
    return null;
  }

  controller = new AbortController();
  const { signal } = controller;
  setStatus('Calculando ruta…', 'loading');
  // hoja plegada del móvil: mientras no hay ruta, que no diga «toca el mapa» con los puntos ya puestos
  if (!state.route) $('sheet-summary').textContent = 'Calculando ruta…';
  try {
    const route = await computeRoute(state.waypoints, toValhallaOptions(state.options), signal);
    if (gen !== generation) return null;
    state.route = route;
    state.fuel = null; // cargando
    editor.setRoute(route);
    editor.setFuelStations([]);
    renderIndicators();
    setStatus('');
    // gasolineras y tiempo llegan después, sin bloquear la ruta
    loadFuel(route, gen, signal);
    loadWeather();
    loadOffroad(route, gen, signal);
    return route;
  } catch (err) {
    if (err.name === 'AbortError' || gen !== generation) return null;
    console.error(err);
    setStatus(`${errorText(err, 'No se pudo calcular la ruta.')}  (${undoHint()})`, 'error');
    if (!state.route) $('sheet-summary').textContent = 'No se pudo calcular la ruta';
    return null;
  }
}

async function loadFuel(route, gen, signal) {
  try {
    const stations = await fuelStationsAlongRoute(route, signal);
    if (gen !== generation) return;
    state.fuel = stations;
  } catch (err) {
    if (err.name === 'AbortError' || gen !== generation) return;
    console.warn(err);
    state.fuel = 'error';
  }
  editor.setFuelStations(Array.isArray(state.fuel) && $('opt-fuel').checked ? state.fuel : []);
  renderIndicators();
}

// pistas (caminos de cabras): espacios protegidos y accesos prohibidos, de OpenStreetMap
async function loadOffroad(route, gen, signal) {
  const hasTracks = route.legs.some((l) => l.segments.some((s) => s.type === 'cabras'));
  state.offroad = hasTracks ? 'loading' : null;
  editor.setOffroad(null);
  renderOffroad();
  if (!hasTracks) return;
  try {
    // se espera a que la ruta deje de cambiar (arrastrando se recalcula mucho): Overpass limita
    await new Promise((r) => setTimeout(r, 1500));
    if (gen !== generation || signal.aborted) return;
    const result = await checkOffroad(route, signal);
    if (gen !== generation) return;
    state.offroad = result;
  } catch (err) {
    if (err.name === 'AbortError' || gen !== generation) return;
    console.warn('zonas protegidas:', err);
    state.offroad = 'error';
  }
  editor.setOffroad(typeof state.offroad === 'object' ? state.offroad : null);
  renderOffroad();
}

function renderOffroad() {
  const el = $('offroad');
  const o = state.offroad;
  el.classList.toggle('hidden', !o);
  if (!o) return;
  const tracksKm = state.route
    ? state.route.legs.flatMap((l) => l.segments).filter((s) => s.type === 'cabras').reduce((a, s) => a + s.lengthKm, 0)
    : 0;
  const head = `<h3>${icon('leaf')} Pistas: ${formatKm(tracksKm)}</h3>`;
  if (o === 'loading') {
    el.innerHTML = `${head}<p class="muted small">Comprobando zonas protegidas y accesos…</p>`;
    return;
  }
  if (o === 'error') {
    el.innerHTML = `${head}<p class="muted small">No se pudo comprobar (sin conexión con OpenStreetMap).</p>`;
    return;
  }
  const items = [];
  const item = (cls, ico, title, detail, ranges) => {
    items.push({ ranges, html: `<li class="${cls}">${icon(ico)}<div><b>${escapeHtml(title)}</b><small>${escapeHtml(detail)}</small></div></li>` });
  };
  for (const f of o.forbidden) item('bad', 'alert', f.name, `${capitalize(f.reason)} · ${formatKm(f.km)}`, f.ranges);
  for (const p of o.permit) item('warn', 'alert', p.name, `${capitalize(p.reason)} · ${formatKm(p.km)}`, p.ranges);
  for (const a of o.areas) {
    const note = a.national ? ' · en parques nacionales suele estar prohibido circular' : '';
    item('area', 'leaf', a.name, `${a.title} · ${formatKm(a.km)} de pista${note}`, a.ranges);
  }
  el.innerHTML =
    head +
    (items.length
      ? `<ul>${items.map((i) => i.html).join('')}</ul>`
      : `<p class="ok">${icon('check')} Sin espacios protegidos ni prohibiciones conocidas en las pistas.</p>`) +
    (o.partial ? '<p class="muted small">Comprobación incompleta: falló una de las consultas.</p>' : '') +
    '<p class="muted small">Orientativo, según OpenStreetMap: puede faltar algún espacio (sobre todo de Red Natura) o alguna prohibición. Consulta la normativa de cada espacio y comunidad.</p>';
  // tocar un aviso centra el mapa en ese tramo
  el.querySelectorAll('li').forEach((li, k) => {
    li.onclick = () => map.fitBounds(L.latLngBounds(items[k].ranges.flat()), { padding: [40, 40], maxZoom: 14 });
  });
}
const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

let weatherController = null;
async function loadWeather() {
  weatherController?.abort();
  const route = state.route;
  if (!route) return;
  weatherController = new AbortController();
  const { signal } = weatherController;
  state.weather = null;
  editor.setWeather([]);
  renderDays();
  try {
    const samples = sampleSchedule(splitDays(route, state.waypoints), state.departure);
    state.weather = await forecastSamples(samples, signal);
  } catch (err) {
    if (err.name === 'AbortError') return;
    console.warn(err);
    state.weather = { error: true };
  }
  showWeatherOnMap();
  renderDays();
}

// en el mapa basta un icono cada ~40 km; el detalle completo está en el panel
function showWeatherOnMap() {
  const all = $('opt-weather').checked ? state.weather?.samples || [] : [];
  let lastKm = -Infinity;
  editor.setWeather(
    all.filter((s) => {
      if (s.km - lastKm < 40) return false;
      lastKm = s.km;
      return true;
    })
  );
}

let statusTimer = 0;
function setStatus(text, kind = '') {
  const el = $('status');
  clearTimeout(statusTimer);
  el.textContent = text;
  el.className = `status ${kind} ${text ? '' : 'hidden'}`;
  if (kind === 'error') statusTimer = setTimeout(() => setStatus(''), 8000);
}

// ---------- panel lateral ----------

function renderStops() {
  const list = $('stops');
  list.innerHTML = '';
  const wps = state.waypoints;
  $('hint').classList.toggle('hidden', wps.length >= 2);

  let vias = 0;
  wps.forEach((w, i) => {
    if (w.kind === 'via') {
      vias++;
      return;
    }
    if (vias) {
      list.insertAdjacentHTML('beforeend', `<li class="via-count">${vias} punto${vias > 1 ? 's' : ''} de paso</li>`);
      vias = 0;
    }
    const isFirst = i === 0;
    const isLast = i === wps.length - 1 && wps.length > 1;
    const stopNum = wps.slice(0, i).filter((x) => x.kind === 'stop').length;
    const badge = isFirst ? 'A' : isLast ? 'B' : w.night ? icon('moon') : stopNum;
    const li = document.createElement('li');
    li.className = 'stop';
    li.draggable = wps.length > 1;
    li.innerHTML = `<span class="grip" title="Arrastra para cambiar el orden">⋮⋮</span>
      <span class="badge ${isFirst ? 'a' : isLast ? 'b' : w.night ? 'night' : ''}">${badge}</span>
      <span class="stop-name">${escapeHtml(w.name || `${w.lat.toFixed(4)}, ${w.lng.toFixed(4)}`)}</span>
      <button class="touch-only move" data-dir="-1" title="Subir">▲</button>
      <button class="touch-only move" data-dir="1" title="Bajar">▼</button>
      <button class="remove" title="Eliminar">✕</button>`;
    li.querySelector('.stop-name').onclick = () => map.setView([w.lat, w.lng], Math.max(map.getZoom(), 13));
    li.querySelector('.remove').onclick = () => update((arr) => arr.splice(i, 1));
    // en pantallas táctiles no se puede arrastrar en la lista: botones para subir y bajar
    const stopIds = wps.filter((x) => x.kind === 'stop').map((x) => x.id);
    const pos = stopIds.indexOf(w.id);
    li.querySelectorAll('.move').forEach((b) => {
      const dir = Number(b.dataset.dir);
      const other = stopIds[pos + dir];
      b.disabled = other === undefined;
      b.onclick = () => other !== undefined && moveStop(w.id, other, dir > 0);
    });
    bindStopDrag(li, w.id);
    list.appendChild(li);
  });
}

// ---------- reordenar paradas arrastrando en la lista ----------

let draggedStopId = null;

function bindStopDrag(li, id) {
  const clear = () => li.classList.remove('drop-before', 'drop-after');
  const isAfter = (e) => {
    const r = li.getBoundingClientRect();
    return e.clientY > r.top + r.height / 2;
  };
  li.addEventListener('dragstart', (e) => {
    draggedStopId = id;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(id));
    requestAnimationFrame(() => li.classList.add('dragging'));
  });
  li.addEventListener('dragend', () => {
    draggedStopId = null;
    document.querySelectorAll('.stops .stop').forEach((el) => el.classList.remove('dragging', 'drop-before', 'drop-after'));
  });
  li.addEventListener('dragover', (e) => {
    if (draggedStopId === null || draggedStopId === id) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const after = isAfter(e);
    li.classList.toggle('drop-after', after);
    li.classList.toggle('drop-before', !after);
  });
  li.addEventListener('dragleave', clear);
  li.addEventListener('drop', (e) => {
    e.preventDefault();
    clear();
    if (draggedStopId !== null && draggedStopId !== id) moveStop(draggedStopId, id, isAfter(e));
  });
}

/**
 * Mueve una parada antes/después de otra. Los puntos de paso de un tramo se conservan
 * si ese tramo sigue uniendo las mismas dos paradas (en cualquier sentido); los de los
 * tramos que desaparecen se descartan, porque ya no tienen sentido.
 */
function moveStop(movedId, targetId, after) {
  update((wps) => {
    const stops = wps.filter((w) => w.kind === 'stop');
    const vias = new Map(); // "idA>idB" -> puntos de paso entre esas dos paradas
    let prev = null;
    for (const w of wps) {
      if (w.kind === 'stop') {
        if (prev) vias.set(`${prev.id}>${w.id}`, vias.get(`${prev.id}>${w.id}`) || []);
        prev = w;
      } else if (prev) {
        const next = wps.slice(wps.indexOf(w)).find((x) => x.kind === 'stop');
        if (next) {
          const key = `${prev.id}>${next.id}`;
          vias.set(key, [...(vias.get(key) || []), w]);
        }
      }
    }

    const order = stops.filter((s) => s.id !== movedId);
    const moved = stops.find((s) => s.id === movedId);
    order.splice(order.findIndex((s) => s.id === targetId) + (after ? 1 : 0), 0, moved);

    const result = [];
    order.forEach((s, k) => {
      if (k > 0) {
        const a = order[k - 1].id;
        const b = s.id;
        result.push(...(vias.get(`${a}>${b}`) || [...(vias.get(`${b}>${a}`) || [])].reverse()));
      }
      result.push(s);
    });
    wps.splice(0, wps.length, ...result);
  });
}

function renderIndicators() {
  const route = state.route;
  $('summary-section').classList.toggle('hidden', !route);
  if (!route) {
    $('sheet-summary').textContent =
      state.waypoints.length ? 'Toca el mapa para poner el destino' : 'Toca el mapa para empezar la ruta';
    return;
  }

  const stations = Array.isArray(state.fuel) ? state.fuel : null;
  const ind = routeIndicators(route, stations);
  $('ind-distance').textContent = formatKm(ind.distanceKm);
  $('ind-time').textContent = formatTime(ind.timeS);
  $('ind-corrected').textContent = formatTime(ind.correctedS);
  $('ind-total').textContent = formatTime(ind.totalS);
  // resumen en la hoja plegada del móvil
  $('sheet-summary').textContent = `${formatKm(ind.distanceKm)} · ${formatTime(ind.totalS)} con paradas`;
  $('ind-rests').textContent = ind.rests
    ? `total con ${ind.rests} parada${ind.rests > 1 ? 's' : ''} de 10 min`
    : 'total (sin paradas)';

  const pending = state.fuel === null ? '…' : '–';
  $('ind-fuel-count').textContent = ind.fuel ? ind.fuel.count : pending;
  $('ind-fuel-gap').textContent = ind.fuel ? formatKm(ind.fuel.longestGapKm) : pending;
  const cheap = ind.fuel?.cheapest95;
  $('ind-cheapest').classList.toggle('hidden', !cheap);
  if (cheap) {
    $('ind-cheapest').innerHTML = `${icon('fuel')} Gasolina 95 más barata: <b>${cheap.p95.toFixed(3)} €/l</b> en ${escapeHtml(
      cheap.brand
    )} (km ${Math.round(cheap.km)})`;
  }
  if (state.fuel === 'error') $('ind-fuel-count').title = 'No se pudieron cargar las gasolineras';

  const byType = {};
  for (const leg of route.legs) for (const s of leg.segments) byType[s.type] = (byType[s.type] || 0) + s.lengthKm;
  const total = Object.values(byType).reduce((a, b) => a + b, 0) || 1;

  const bar = $('type-bar');
  const legend = $('type-legend');
  bar.innerHTML = '';
  legend.innerHTML = '';
  for (const type of ROAD_TYPE_ORDER) {
    const km = byType[type];
    if (!km) continue;
    const t = ROAD_TYPES[type];
    const pct = (km / total) * 100;
    bar.insertAdjacentHTML('beforeend', `<span style="width:${pct}%;background:${t.color}" title="${t.label}"></span>`);
    legend.insertAdjacentHTML(
      'beforeend',
      `<li title="${t.hint}"><span class="dot" style="background:${t.color}"></span>${t.label}
        <b>${formatKm(km)}</b><i>${pct.toFixed(0)}%</i></li>`
    );
  }

  const flags = [];
  if (route.hasToll) flags.push(`<span>${icon('coin')} Tiene peajes</span>`);
  if (route.hasFerry) flags.push(`<span>${icon('ferry')} Incluye ferry</span>`);
  $('sum-flags').innerHTML = flags.join('');
}

// ---------- etapas y tiempo ----------

const pad2 = (n) => String(n).padStart(2, '0');
const formatClock = (d) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
const formatDay = (d) => d.toLocaleDateString('es-ES', { weekday: 'short', day: 'numeric', month: 'short' });

// etapas desplegadas en el panel (por número de día). Con varias etapas empiezan plegadas:
// la previsión hora a hora ocupa mucho
const expandedDays = new Set();
let expandedFor = null; // número de etapas para el que vale expandedDays

function renderDays() {
  const route = state.route;
  $('days-section').classList.toggle('hidden', !route);
  if (!route) return;

  const days = splitDays(route, state.waypoints);
  if (expandedFor !== days.length) {
    expandedDays.clear();
    if (days.length === 1) expandedDays.add(0);
    expandedFor = days.length;
  }
  const weather = state.weather;
  const container = $('days');
  container.innerHTML = '';

  days.forEach((day, di) => {
    const start = new Date(`${state.departure}:00`);
    start.setDate(start.getDate() + di);
    const arrival = new Date(start.getTime() + day.indicators.totalS * 1000);
    const ind = day.indicators;
    const samples = weather?.samples?.filter((s) => s.day === di) || [];
    const open = expandedDays.has(di);
    const night = di < days.length - 1;
    const dark = darkness(start, arrival, day);

    const el = document.createElement('div');
    el.className = `day ${open ? 'open' : ''}`;
    el.innerHTML = `
      <button type="button" class="day-head" aria-expanded="${open}">
        <span class="chev">${open ? '▾' : '▸'}</span>
        <b>${days.length > 1 ? `Día ${di + 1} · ` : ''}${formatDay(start)}</b>
        <span class="day-summary">${dark ? `<span class="dark-flag" title="${escapeHtml(dark)}">${icon('moon')}</span>` : ''}${samples.length ? weatherSummary(samples) : ''}</span>
        <span>${formatKm(day.lengthKm)}</span>
      </button>
      <div class="day-meta">
        ${formatClock(start)} → ${formatClock(arrival)} ·
        ${formatTime(ind.correctedS)} conduciendo${ind.rests ? ` + ${ind.rests} parada${ind.rests > 1 ? 's' : ''}` : ''}
        ${dark ? `<div class="dark-warn">${icon('alert')} ${escapeHtml(dark)}</div>` : ''}
        ${night ? `<div class="sleep">${icon('moon')} Noche en <b>${escapeHtml(day.endName || 'fin de etapa')}</b>${lodgingLinks(day, start)}</div>` : ''}
      </div>`;
    el.querySelector('.day-head').onclick = () => {
      if (expandedDays.has(di)) expandedDays.delete(di);
      else expandedDays.add(di);
      renderDays();
    };
    container.appendChild(el);
    if (!open) return; // plegada: solo cabecera, horario y resumen del tiempo

    if (samples.length) {
      const warnings = weatherWarnings(samples);
      el.insertAdjacentHTML(
        'beforeend',
        warnings.length
          ? `<ul class="warnings">${warnings.map((w) => `<li>${icon(w.icon)} ${escapeHtml(w.text)}</li>`).join('')}</ul>`
          : `<p class="ok">${icon('check')} Buen tiempo para rodar</p>`
      );
      el.insertAdjacentHTML(
        'beforeend',
        `<ol class="timeline">${samples
          .map((s) => {
            const w = describeWeather(s.code);
            return `<li title="${w.text}"><span>${formatClock(s.eta)}</span><span>km ${Math.round(s.km)}</span>
              <span>${icon(w.icon)} ${Math.round(s.temp)}°</span><span>${icon('drop')}${s.rainProb ?? 0}%</span><span>${icon('wind')}${Math.round(s.gusts)}</span></li>`;
          })
          .join('')}</ol>`
      );
    } else {
      const msg =
        weather === null
          ? 'Cargando previsión…'
          : weather.error
            ? 'No se pudo cargar la previsión del tiempo.'
            : 'Sin previsión para esta fecha (solo hay hasta 16 días vista).';
      el.insertAdjacentHTML('beforeend', `<p class="muted small">${msg}</p>`);
    }
  });
}

/**
 * Aviso si se sale antes de que amanezca o se llega después de que anochezca (en el punto de
 * salida y de llegada del día). Devuelve el texto o ''.
 */
function darkness(start, arrival, day) {
  const from = day.legs[0]?.coords[0];
  const to = day.end || (() => {
    const c = day.legs[day.legs.length - 1]?.coords;
    return c && { lat: c[c.length - 1][0], lng: c[c.length - 1][1] };
  })();
  const msgs = [];
  const sunEnd = to && sunTimes(arrival, to.lat, to.lng);
  if (sunEnd && arrival > sunEnd.sunset) msgs.push(`Llegas de noche: anochece a las ${formatClock(sunEnd.sunset)}`);
  const sunStart = from && sunTimes(start, from[0], from[1]);
  if (sunStart && start < sunStart.sunrise) msgs.push(`Sales de noche: amanece a las ${formatClock(sunStart.sunrise)}`);
  return msgs.join(' · ');
}

/** Buscar dónde dormir: Booking (con las fechas de esa noche) y hoteles en Google Maps. */
function lodgingLinks(day, start) {
  if (!day.end) return '';
  const place = day.endName || `${day.end.lat.toFixed(4)},${day.end.lng.toFixed(4)}`;
  const iso = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const next = new Date(start);
  next.setDate(next.getDate() + 1);
  const booking =
    `https://www.booking.com/searchresults.es.html?ss=${encodeURIComponent(place)}` +
    `&latitude=${day.end.lat}&longitude=${day.end.lng}&checkin=${iso(start)}&checkout=${iso(next)}&group_adults=1&no_rooms=1`;
  const maps = `https://www.google.com/maps/search/alojamiento/@${day.end.lat},${day.end.lng},14z`;
  return ` <span class="lodging">· Buscar alojamiento: <a href="${booking}" target="_blank" rel="noopener">Booking</a> · <a href="${maps}" target="_blank" rel="noopener">Google Maps</a></span>`;
}

/** Resumen del tiempo de una etapa para la cabecera plegada: icono, "9–18°" y nº de avisos. */
function weatherSummary(samples) {
  // el icono del momento con peor tiempo (código WMO más alto)
  const worst = samples.reduce((a, s) => (s.code > a.code ? s : a));
  const temps = samples.map((s) => s.temp);
  const warnings = weatherWarnings(samples).length;
  return `${icon(describeWeather(worst.code).icon)} ${Math.round(Math.min(...temps))}–${Math.round(Math.max(...temps))}°${
    warnings ? ` <span class="warn-count" title="${warnings} aviso${warnings > 1 ? 's' : ''}">${icon('alert')}${warnings}</span>` : ''
  }`;
}

const depDate = new DateField($('dep-date'));
fillTimeSelect($('dep-time'));

function renderDeparture() {
  const [date, time] = state.departure.split('T');
  depDate.value = date;
  setTimeSelect($('dep-time'), time);
}

function onDepartureChange() {
  if (!depDate.value || !$('dep-time').value) return;
  state.departure = `${depDate.value}T${$('dep-time').value}`;
  persist();
  loadWeather();
}
$('dep-date').addEventListener('change', onDepartureChange);
$('dep-time').addEventListener('change', onDepartureChange);
$('opt-weather').addEventListener('change', showWeatherOnMap);

// ---------- generar ruta automática ----------

async function handleGenerate(p, onProgress, signal) {
  const { alternatives } =
    p.mode === 'trip'
      ? await generateTrip(p, onProgress, signal)
      : await generateLoop({ ...p, home: p.from }, onProgress, signal);
  if (!alternatives.length) throw new Error('No se pudo generar ninguna ruta.');

  state.options = { avoidHighways: p.avoidHighways, smartHighways: p.avoidHighways, avoidTolls: p.avoidTolls, allowTrails: p.allowTrails, allowFerry: false };
  state.departure = p.departure;
  state.name =
    p.mode === 'trip' ? `${p.from.name} → ${p.to.name}` : `Vuelta desde ${p.from.name} (${Math.round(p.targetKm)} km)`;
  $('route-name').value = state.name;
  renderOptions();
  renderDeparture();

  state.alternatives = { list: alternatives, selected: 0, params: p };
  await applyAlternative(0, onProgress);
  editor.fitRoute();
}

/** Usa la alternativa `index` como ruta (con sus noches si es un viaje de varios días). */
async function applyAlternative(index, onProgress = () => {}) {
  const alts = state.alternatives;
  const alt = alts.list[index];
  alts.selected = index;
  renderAlternatives();

  undoStack.push(state.waypoints.map((w) => ({ ...w })));
  const setWaypoints = (wps) => {
    state.waypoints = wps;
    editor.setWaypoints(wps);
    renderStops();
    persist();
  };
  const wps = alt.waypoints.map((w) => makeWp(w.lat, w.lng, w.kind, w.name));
  normalizeEnds(wps);
  setWaypoints(wps);
  onProgress(1, 1, 'Calculando la ruta final…');
  let route = await recompute();
  if (!route) throw new Error('No se pudo calcular la ruta generada.');

  // viaje de varios días: paradas para dormir, a ser posible en un pueblo
  if (alts.params.mode === 'trip') {
    const nights = planNights(route, alts.params.kmPerDay);
    if (nights.length) {
      const wps = [...state.waypoints];
      for (const [k, n] of nights.entries()) {
        onProgress(k, nights.length, `Buscando dónde dormir (noche ${k + 1})…`);
        setStatus(`Buscando dónde dormir (noche ${k + 1})…`, 'loading');
        const town = await reverseGeocodePlace(n.lat, n.lng);
        const near = town && distanceKm(n, town) < 6;
        wps.splice(n.insertAt + k, 0, makeWp(near ? town.lat : n.lat, near ? town.lng : n.lng, 'stop', town?.name || '', true));
      }
      if (alts.selected !== index) return; // se eligió otra mientras tanto
      setWaypoints(wps);
      onProgress(1, 1, 'Calculando etapas…');
      route = await recompute();
      if (!route) throw new Error('No se pudo calcular la ruta con las etapas.');
    }
  }
}

// ---------- alternativas generadas ----------

const EYE_ICON =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/><path class="slash" d="M3 3l18 18"/></svg>';

// curvas en °/km → nivel de 1 a 5 (autovía ≈ 5-10, puerto de montaña > 60)
const curvyLevel = (c) => (c < 12 ? 1 : c < 22 ? 2 : c < 35 ? 3 : c < 55 ? 4 : 5);

function renderAlternatives() {
  const box = $('alts');
  const alts = state.alternatives;
  box.classList.toggle('hidden', !alts);
  // las ocultas con el ojo se pasan vacías: no se dibujan
  editor.setAlternatives(
    alts ? alts.list.map((a, i) => (alts.hidden?.has(i) ? [] : a.coords)) : [],
    alts?.selected ?? -1,
    (i) => selectAlternative(i)
  );
  if (!alts) return;
  alts.hidden ||= new Set();

  const shortest = Math.min(...alts.list.map((a) => a.lengthKm));
  const curviest = Math.max(...alts.list.map((a) => a.curvature));
  const list = $('alts-list');
  list.innerHTML = '';
  alts.list.forEach((a, i) => {
    const tags = [];
    if (alts.list.length > 1 && a.curvature === curviest) tags.push('más curvas');
    if (alts.list.length > 1 && a.lengthKm === shortest) tags.push('más corta');
    const level = curvyLevel(a.curvature);
    const li = document.createElement('li');
    li.className = i === alts.selected ? 'selected' : '';
    li.innerHTML = `
      <span class="alt-num">${i + 1}</span>
      <div class="alt-info">
        <b>${formatKm(a.lengthKm)} · ${formatTime(a.timeS)}</b>
        <small><span class="curvy" title="${Math.round(a.curvature)} °/km">${'●'.repeat(level)}${'○'.repeat(5 - level)}</span> curvas${
          tags.length ? ` · ${tags.join(' · ')}` : ''
        }</small>
      </div>
      ${
        i === alts.selected
          ? '<span class="alt-eye on current" title="Es la ruta elegida">●</span>'
          : `<button type="button" class="alt-eye ${alts.hidden.has(i) ? '' : 'on'}" title="${
              alts.hidden.has(i) ? 'Mostrar en el mapa' : 'Ocultar del mapa'
            }">${EYE_ICON}</button>`
      }`;
    li.querySelector('button.alt-eye')?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (alts.hidden.has(i)) alts.hidden.delete(i);
      else alts.hidden.add(i);
      renderAlternatives();
    });
    li.classList.toggle('dimmed', alts.hidden.has(i) && i !== alts.selected);
    li.onclick = () => selectAlternative(i);
    li.onmouseenter = () => editor.highlightAlternative(i);
    li.onmouseleave = () => editor.highlightAlternative(-1);
    list.appendChild(li);
  });
  if (alts.list.length < ALTERNATIVES) {
    list.insertAdjacentHTML(
      'beforeend',
      `<li class="muted small">Solo ${alts.list.length === 1 ? 'hay una opción' : `hay ${alts.list.length} opciones`} realmente distinta${alts.list.length === 1 ? '' : 's'}.</li>`
    );
  }
}

async function selectAlternative(i) {
  if (!state.alternatives || i === state.alternatives.selected) return;
  try {
    await applyAlternative(i);
  } catch (err) {
    setStatus(errorText(err), 'error');
  }
}

$('alts-close').onclick = () => {
  state.alternatives = null;
  renderAlternatives();
};

$('btn-generate').onclick = () => {
  const wps = state.waypoints;
  const place = (w) => w && { lat: w.lat, lng: w.lng, name: w.name || `${w.lat.toFixed(4)}, ${w.lng.toFixed(4)}` };
  openWizard(
    {
      from: place(wps[0]),
      to: wps.length > 1 ? place(wps[wps.length - 1]) : null,
      // paradas intermedias de la ruta actual (las noches se recalculan solas)
      through: wps.slice(1, -1).filter((w) => w.kind === 'stop' && !w.night).map(place),
      departure: state.departure,
      near: map.getCenter(),
    },
    handleGenerate
  );
};

const formatKm = (km) => (km < 10 ? `${km.toFixed(1)} km` : `${Math.round(km)} km`);
function formatTime(s) {
  const total = Math.round(s / 60);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h ? `${h} h ${m} min` : `${m} min`;
}

// ---------- opciones ----------

const OPTION_INPUTS = {
  avoidHighways: 'opt-highways',
  avoidTolls: 'opt-tolls',
  allowTrails: 'opt-trails',
  allowFerry: 'opt-ferry',
};

function renderOptions() {
  for (const [key, id] of Object.entries(OPTION_INPUTS)) $(id).checked = state.options[key];
}

async function onOptionChange(e) {
  for (const [key, id] of Object.entries(OPTION_INPUTS)) state.options[key] = $(id).checked;
  // «Evitar autovías» = autovía solo si hace falta, igual que en la ruta generada
  state.options.smartHighways = state.options.avoidHighways;
  persist();
  const route = await recompute();
  if (e?.target?.id !== 'opt-highways' || !state.options.avoidHighways || !route) return;
  // cambia por la nacional paralela los tramos de autovía que la tienen con curvas
  const gen = generation;
  const stale = () => gen !== generation || !state.options.avoidHighways;
  try {
    setStatus('Buscando nacionales con curvas en vez de autovía…', 'loading');
    const wps = await avoidHighwaysInRoute(planWaypoints(), toValhallaOptions(state.options));
    if (stale()) return;
    setStatus('');
    if (wps) update((arr) => arr.splice(0, arr.length, ...wps.map((w) => makeWp(w.lat, w.lng, w.kind, w.name, w.night))));
  } catch (err) {
    if (!stale()) setStatus(errorText(err, 'No se pudo revisar las autovías.'), 'error');
  }
}
for (const id of Object.values(OPTION_INPUTS)) $(id).addEventListener('change', onOptionChange);
$('opt-color').addEventListener('change', (e) => editor.setColorByType(e.target.checked));
$('opt-fuel').addEventListener('change', (e) =>
  editor.setFuelStations(e.target.checked && Array.isArray(state.fuel) ? state.fuel : [])
);

// ---------- búsqueda ----------

// sugerencias según se escribe; Intro o clic en el nombre centra el mapa ahí, y cada
// resultado tiene botones para usarlo como salida o destino
const sidebarSearch = attachAutocomplete($('search-input'), $('search-results'), {
  getNear: () => map.getCenter(),
  onSelect: (r) => map.setView([r.lat, r.lng], 13),
  extra: (r, li, close) => {
    li.insertAdjacentHTML(
      'beforeend',
      '<div class="result-actions"><button type="button" data-a="start">Desde</button><button type="button" data-a="end">Hasta</button></div>'
    );
    li.querySelectorAll('button').forEach((b) => {
      b.onclick = () => {
        const w = makeWp(r.lat, r.lng, 'stop', r.name);
        update((wps) => (b.dataset.a === 'start' ? wps.unshift(w) : wps.push(w)));
        close();
        $('search-input').value = '';
        editor.fitRoute();
      };
    });
  },
});
$('search-form').addEventListener('submit', (e) => {
  e.preventDefault();
  sidebarSearch.search();
});

// ---------- herramientas ----------

$('btn-undo').onclick = undo;
$('btn-reverse').onclick = () => update((wps) => wps.reverse());
$('btn-fit').onclick = () => editor.fitRoute();
$('btn-clear').onclick = async () => {
  if (!state.waypoints.length) return;
  const ok = await confirmDialog(`Se quitarán todos los puntos del mapa. Puedes recuperarla con ${matchMedia('(pointer: coarse)').matches ? 'el botón ↶' : 'Ctrl+Z'}.`, {
    title: '¿Borrar la ruta actual?',
    okText: 'Borrar ruta',
    danger: true,
  });
  if (!ok) return;
  state.alternatives = null;
  renderAlternatives();
  update((wps) => wps.splice(0));
  state.name = '';
  state.libraryId = null;
  state.libraryName = null;
  $('route-name').value = '';
  persist();
};

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.target.matches('input')) {
    e.preventDefault();
    undo();
  }
});

// ---------- guardar / cargar ----------

function persist() {
  storage.saveCurrent({ waypoints: state.waypoints, options: state.options, name: state.name, departure: state.departure, libraryId: state.libraryId, libraryName: state.libraryName });
}

/**
 * Guarda en Mis rutas de la app (o la abre en el navegador). Con el mismo nombre sobrescribe la
 * ruta que se está editando; con otro nombre se guarda como una ruta nueva.
 */
function storeInApp(data, send) {
  const sameRoute = state.libraryId && data.name === state.libraryName;
  state.libraryId = send(JSON.stringify(data), sameRoute ? state.libraryId : null);
  state.libraryName = data.name;
  persist();
}

function loadRoute(data, fit = true) {
  undoStack.push(state.waypoints.map((w) => ({ ...w })));
  state.alternatives = null;
  renderAlternatives();
  state.waypoints = data.waypoints.map((w) => makeWp(w.lat, w.lng, w.kind, w.name, w.night));
  normalizeEnds(state.waypoints);
  state.options = cleanOptions(data.options);
  state.name = data.name || '';
  // ruta de «Mis rutas» de la app que se está editando (guardar la sobrescribe)
  state.libraryId = data.libraryId || null;
  state.libraryName = data.libraryId ? data.libraryName ?? data.name ?? '' : null;
  // una salida guardada que ya pasó no sirve para la previsión
  if (data.departure && new Date(data.departure) > new Date()) state.departure = data.departure;
  $('route-name').value = state.name;
  renderOptions();
  renderDeparture();
  afterWaypointsChange();
  if (fit) editor.fitRoute();
  state.waypoints.filter((w) => w.kind === 'stop' && !w.name).forEach((w) => nameStop(w.id));
}

function renderSaved() {
  const list = $('saved');
  list.innerHTML = '';
  const saved = storage.listSaved();
  if (!saved.length) list.innerHTML = '<li class="muted">Aún no has guardado ninguna ruta.</li>';
  for (const r of saved) {
    const li = document.createElement('li');
    li.innerHTML = `<div><b>${escapeHtml(r.name)}</b><small>${r.lengthKm ? formatKm(r.lengthKm) + ' · ' : ''}${new Date(
      r.savedAt
    ).toLocaleDateString('es-ES')}</small></div><button title="Borrar">✕</button>`;
    li.querySelector('div').onclick = () => loadRoute(r);
    li.querySelector('button').onclick = async () => {
      const ok = await confirmDialog('Esta acción no se puede deshacer.', {
        title: `¿Borrar "${r.name}"?`,
        okText: 'Borrar',
        danger: true,
      });
      if (!ok) return;
      storage.deleteSaved(r.id);
      renderSaved();
    };
    list.appendChild(li);
  }
}

$('save-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (state.waypoints.length < 2) return setStatus('Traza una ruta antes de guardarla.', 'error');
  const name = $('route-name').value.trim() || defaultName();
  state.name = name;
  $('route-name').value = name;
  if (inApp) {
    // en la app, «Mis rutas» es la biblioteca del móvil: guardar = dejarla lista para navegar
    if (!state.route) return setStatus('Espera a que se calcule la ruta para guardarla.', 'error');
    const data = await prepareNavFile();
    if (!data) return;
    storeInApp(data, saveToLibrary);
    setStatus(`«${name}» guardada en Mis rutas: lista para navegar.`);
    statusTimer = setTimeout(() => setStatus(''), 3000);
    return;
  }
  storage.upsertSaved({
    name,
    waypoints: planWaypoints(),
    options: state.options,
    departure: state.departure,
    lengthKm: state.route?.lengthKm,
  });
  persist();
  renderSaved();
  setStatus(`Ruta "${name}" guardada.`);
  statusTimer = setTimeout(() => setStatus(''), 2000);
});

/**
 * Completa un GPX añadido en «Mis rutas» de la app: se recalcula por el mismo trazado (puntos
 * de paso cada ~3 km) y se guarda en su lugar con giros, gasolineras, tipos de vía, etc.
 */
async function completeGpxFromApp(gpx, id) {
  let parsed;
  try {
    parsed = gpxToWaypoints(gpx);
  } catch (err) {
    return setStatus(err.message, 'error');
  }
  loadRoute({ name: parsed.name, waypoints: parsed.waypoints, options: state.options, libraryId: id, libraryName: parsed.name });
  // espera a que termine el cálculo (lo lanza loadRoute)
  const gen = generation;
  for (let i = 0; i < 600; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (generation !== gen && !state.route) return; // se cambió la ruta mientras tanto
    if (state.route && !/Calculando/.test($('status').textContent)) break;
  }
  if (!state.route || state.libraryId !== id) return;
  const data = await prepareNavFile();
  if (!data || state.libraryId !== id) return;
  storeInApp(data, saveToLibrary);
  setStatus('Ruta completada y guardada en Mis rutas. Revísala y pulsa «Navegar esta ruta».');
}

const planWaypoints = () => state.waypoints.map(({ lat, lng, kind, name, night }) => ({ lat, lng, kind, name, night }));

function defaultName() {
  const first = state.waypoints[0]?.name;
  const last = state.waypoints[state.waypoints.length - 1]?.name;
  return first && last ? `${first} → ${last}` : `Ruta ${new Date().toLocaleDateString('es-ES')}`;
}

/**
 * Ruta lista para navegar (.motoruta): trazado, giros, gasolineras, sitios cercanos para la
 * búsqueda sin conexión y los datos de planificación para poder editarla otra vez.
 * Devuelve null si ya se está preparando otra.
 */
let exporting = false;
async function prepareNavFile() {
  if (exporting) return null;
  exporting = true;
  const route = state.route;
  // el nombre escrito en «Mis rutas» manda (con otro nombre se guarda como ruta nueva)
  const name = $('route-name').value.trim() || state.name || defaultName();
  state.name = name;
  $('route-name').value = name;
  const warnings = [];
  try {
    setStatus('Preparando la ruta para la moto: gasolineras cercanas…', 'loading');
    const nearbyFuel = await fuelNearRoute(route).catch(() => (warnings.push('gasolineras cercanas'), []));
    const pois = await poisAlongRoute(
      route.legs.flatMap((leg, i) => (i === 0 ? leg.coords : leg.coords.slice(1))),
      (done, total) => setStatus(`Preparando la ruta para la moto: restaurantes, talleres y súper… ${Math.round((done / total) * 100)} %`, 'loading')
    ).catch(() => (warnings.push('restaurantes, talleres y supermercados'), { food: [], workshop: [], supermarket: [] }));
    setStatus('Preparando la ruta para la moto: radares fijos…', 'loading');
    const cameras = await camerasAlongRoute(
      route.legs.flatMap((leg, i) => (i === 0 ? leg.coords : leg.coords.slice(1)))
    ).catch(() => (warnings.push('radares'), []));
    if (!Array.isArray(state.fuel)) warnings.push('gasolineras en ruta');
    const data = buildNavFile({
      name,
      departure: state.departure,
      route,
      waypoints: state.waypoints,
      fuel: state.fuel,
      nearbyFuel,
      food: pois.food,
      workshops: pois.workshop,
      supermarkets: pois.supermarket,
      cameras,
    });
    data.plan = { name, waypoints: planWaypoints(), options: state.options, departure: state.departure };
    setStatus(warnings.length ? `Sin ${warnings.join(', ')}: no se pudieron cargar.` : '', warnings.length ? 'error' : '');
    prepared = { nearbyFuel: nearbyFuel.length, food: pois.food.length, workshops: pois.workshop.length, supermarkets: pois.supermarket.length, cameras: cameras.length, warnings };
    return data;
  } finally {
    exporting = false;
  }
}
let prepared = null;

$('btn-export-nav').onclick = async () => {
  if (!state.route) return setStatus('Calcula una ruta antes de exportarla.', 'error');
  const data = await prepareNavFile();
  if (!data) return;
  if (inApp) {
    // dentro de la app: se guarda en Mis rutas y se abre directamente en el navegador
    storeInApp(data, openInNavigator);
    return;
  }
  downloadFile(`${safeFileName(data.name)}.motoruta`, JSON.stringify(data), 'application/json');
  if (!prepared.warnings.length) {
    setStatus(`Exportada: ${prepared.nearbyFuel} gasolineras, ${prepared.food} sitios para comer, ${prepared.workshops} talleres, ${prepared.supermarkets} supermercados y ${prepared.cameras} radares.`);
    statusTimer = setTimeout(() => setStatus(''), 4000);
  }
};
const safeFileName = (name) => name.replace(/[^\w\- áéíóúñÁÉÍÓÚÑ→]/g, '_');

function downloadFile(fileName, content, type) {
  // en la app no hay descargas: se comparte el archivo con el menú de Android
  if (inApp) return shareFile(fileName, content, type);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

$('btn-export').onclick = () => {
  if (state.waypoints.length < 2) return setStatus('No hay ruta que exportar.', 'error');
  const name = state.name || $('route-name').value.trim() || 'Ruta MotoRuta';
  downloadFile(`${safeFileName(name)}.gpx`, routeToGpx(name, state.waypoints, state.route), 'application/gpx+xml');
};

$('btn-import').onclick = () => $('file-import').click();
$('file-import').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const { name, waypoints } = gpxToWaypoints(await file.text());
    loadRoute({ name, waypoints, options: state.options });
  } catch (err) {
    setStatus(errorText(err), 'error');
  }
});

// ---------- arranque ----------

// iconos de los botones de la página (index.html: data-icon)
document.querySelectorAll('[data-icon]').forEach((el) => el.insertAdjacentHTML('afterbegin', `${icon(el.dataset.icon)} `));

// móvil: la hoja del panel se abre y se cierra tocando su asa o arrastrándola
initSheet($('sidebar'), $('sheet-handle'));
// móvil: el teclado se oculta al tocar fuera del campo de texto
initKeyboard();

// dentro de la app de Android: diseño de móvil y la ruta va directa al navegador
if (inApp) {
  document.body.classList.add('in-app');
  $('btn-export-nav').textContent = 'Navegar esta ruta';
  // «Mis rutas» es la de la app (pantalla principal): aquí solo se guarda
  $('saved').classList.add('hidden');
  $('route-name').placeholder = 'Nombre de la ruta';
  // «Editar» desde Mis rutas de la app
  onPlanFromApp(({ plan, id, gpx }) => {
    // GPX añadido en la app: completarlo (recalcular y guardarlo en su lugar)
    if (gpx) return completeGpxFromApp(gpx, id);
    // el nombre queda en el campo de «Mis rutas»; «Guardar» con el mismo nombre sobrescribe esta ruta
    loadRoute({ ...plan, libraryId: id });
  });
  // casita arriba a la izquierda (las capas están a la derecha): vuelve al menú de la app
  const Home = L.Control.extend({
    options: { position: 'topleft' },
    onAdd() {
      const b = L.DomUtil.create('button', 'home-control');
      b.type = 'button';
      b.innerHTML = icon('home');
      b.title = 'Menú principal';
      L.DomEvent.disableClickPropagation(b);
      L.DomEvent.on(b, 'click', goHome);
      return b;
    },
  });
  new Home().addTo(map);
}

window.__motoruta = { state, editor, map, handleGenerate, renderAlternatives }; // para depurar desde la consola

renderSaved();
const current = storage.loadCurrent();
if (current?.waypoints?.length) {
  loadRoute(current);
  undoStack.length = 0;
} else {
  renderOptions();
  renderStops();
  renderDeparture();
}
