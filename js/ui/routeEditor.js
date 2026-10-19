// Dibujo de la ruta y edición directa sobre el mapa:
//  - marcadores arrastrables para paradas y puntos de paso
//  - arrastrar la línea de la ruta crea un punto de paso nuevo en ese tramo
//  - tooltip con el tipo de vía al pasar el ratón por la ruta

import { ROAD_TYPES } from '../core/roadTypes.js';
import { describeWeather } from '../core/weather.js';
import { icon } from './icons.js';

const HOVER_PX = 14;

export class RouteEditor {
  /**
   * @param map Leaflet map
   * @param handlers {onMapClick, onMove(i, latlng), onInsert(index, latlng), onRemove(i),
   *                  onToggleKind(i), onContextAction(action, latlng)}
   */
  constructor(map, handlers) {
    this.map = map;
    this.h = handlers;
    this.waypoints = [];
    this.route = null;
    this.colorByType = true;

    // pistas por zonas protegidas o prohibidas: halo bajo la ruta (no estorba al arrastrarla)
    map.createPane('offroad').style.zIndex = 390;
    this.offroadLayer = L.layerGroup().addTo(map);
    this.altLayer = L.layerGroup().addTo(map); // debajo de la ruta
    this.altLines = [];
    this.routeLayer = L.layerGroup().addTo(map);
    this.arrowLayer = L.layerGroup().addTo(map);
    this.previewLayer = L.layerGroup().addTo(map);
    this.fuelLayer = L.layerGroup().addTo(map);
    this.weatherLayer = L.layerGroup().addTo(map);
    this.markerLayer = L.layerGroup().addTo(map);

    this.legPoints = []; // [{pts: [L.Point], bounds: L.Bounds}] en coordenadas de capa
    this.hover = null; // {li, i, latlng}
    this.dragging = null;
    this.suppressClick = false;

    this.ghost = L.circleMarker([0, 0], {
      radius: 7,
      color: '#fff',
      weight: 3,
      fillColor: '#111',
      fillOpacity: 1,
      interactive: false,
    });

    this.tip = document.createElement('div');
    this.tip.className = 'route-tip hidden';
    map.getContainer().appendChild(this.tip);

    this.menu = document.createElement('div');
    this.menu.className = 'context-menu hidden';
    map.getContainer().appendChild(this.menu);
    L.DomEvent.disableClickPropagation(this.menu);
    L.DomEvent.on(this.menu, 'contextmenu', L.DomEvent.stop);

    this._bindEvents();
  }

  // ---------- render ----------

  setWaypoints(waypoints) {
    this.waypoints = waypoints;
    this.markerLayer.clearLayers();
    const stopIdx = waypoints.map((w, i) => (w.kind === 'stop' ? i : -1)).filter((i) => i >= 0);

    waypoints.forEach((w, i) => {
      const isFirst = i === 0;
      const isLast = i === waypoints.length - 1 && waypoints.length > 1;
      let html;
      let cls;
      if (w.kind === 'via' && !isFirst && !isLast) {
        cls = 'wp-via';
        html = '';
      } else {
        cls = isFirst ? 'wp-stop wp-start' : isLast ? 'wp-stop wp-end' : w.night ? 'wp-stop wp-night' : 'wp-stop';
        html = isFirst ? 'A' : isLast ? 'B' : w.night ? icon('moon') : String(stopIdx.indexOf(i));
      }
      const size = cls === 'wp-via' ? 14 : 28;
      const marker = L.marker([w.lat, w.lng], {
        draggable: true,
        autoPan: true,
        zIndexOffset: cls === 'wp-via' ? 0 : 1000,
        icon: L.divIcon({ className: `wp ${cls}`, html, iconSize: [size, size] }),
      });

      marker.on('dragstart', () => this._hideGhost());
      marker.on('drag', (e) => this._showPreview(i, e.latlng, true));
      marker.on('dragend', (e) => {
        this.previewLayer.clearLayers();
        this.h.onMove(i, e.target.getLatLng());
      });
      marker.on('mouseover', () => this._hideGhost());
      marker.on('contextmenu', (e) => {
        L.DomEvent.stop(e);
        if (w.kind === 'via') this.h.onRemove(i);
      });
      marker.bindPopup(() => this._popupFor(i), { closeButton: false, offset: [0, -8] });
      marker.addTo(this.markerLayer);
    });
  }

  setRoute(route) {
    this.route = route;
    this.routeLayer.clearLayers();
    if (!route) {
      this.legPoints = [];
      this.arrowLayer.clearLayers();
      return;
    }

    for (const leg of route.legs) {
      L.polyline(leg.coords, { color: '#111', weight: 9, opacity: 0.55, interactive: false }).addTo(this.routeLayer);
    }
    for (const leg of route.legs) {
      if (!this.colorByType) {
        L.polyline(leg.coords, { color: '#7c4dff', weight: 5, interactive: false }).addTo(this.routeLayer);
        continue;
      }
      for (const seg of leg.segments) {
        const t = ROAD_TYPES[seg.type];
        L.polyline(leg.coords.slice(seg.from, seg.to + 1), {
          color: t.color,
          weight: 5,
          dashArray: t.dash,
          lineCap: 'round',
          interactive: false,
        }).addTo(this.routeLayer);
      }
    }
    this._computeLayerPoints();
  }

  // ---------- alternativas generadas (las no elegidas, discontinuas y clicables) ----------

  setAlternatives(coordsList, selected, onSelect) {
    this.altLayer.clearLayers();
    this.altLines = coordsList.map((coords, i) => {
      if (i === selected || !coords.length) return null; // la elegida, o una oculta con el ojo
      const casing = L.polyline(coords, { color: '#fff', weight: 8, opacity: 0.75, interactive: false });
      const line = L.polyline(coords, { color: '#5b6272', weight: 4, dashArray: '10 8', interactive: false });
      // línea invisible y ancha para que sea fácil hacer clic
      const hit = L.polyline(coords, { weight: 18, opacity: 0, className: 'alt-hit' })
        .bindTooltip(`Alternativa ${i + 1} · clic para usarla`, { sticky: true, direction: 'top', offset: [0, -8] })
        .on('click', (e) => {
          L.DomEvent.stop(e); // que el clic no añada un punto en el mapa
          onSelect(i);
        })
        .on('mouseover', () => this.highlightAlternative(i))
        .on('mouseout', () => this.highlightAlternative(-1));
      L.layerGroup([casing, line, hit]).addTo(this.altLayer);
      return line;
    });
  }

  highlightAlternative(index) {
    this.altLines.forEach((line, i) => {
      line?.setStyle(i === index ? { color: '#ff7a1a', weight: 5, dashArray: null } : { color: '#5b6272', weight: 4, dashArray: '10 8' });
    });
  }

  // ---------- flechas de sentido sobre la ruta ----------

  _drawArrows() {
    this.arrowLayer.clearLayers();
    if (!this.route || !this.legPoints.length) return;
    const SPACING = 140; // px de pantalla entre flechas, a cualquier zoom
    const pad = 40;
    const min = this.map.containerPointToLayerPoint([-pad, -pad]);
    const max = this.map.containerPointToLayerPoint(this.map.getSize().add([pad, pad]));

    // toda la ruta como una sola línea en píxeles, con distancias acumuladas
    const pts = this.legPoints.flatMap(({ pts }, i) => (i === 0 ? pts : pts.slice(1)));
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + pts[i - 1].distanceTo(pts[i]));
    const total = cum[cum.length - 1];
    if (pts.length < 2 || !total) return;
    const at = (d) => {
      d = Math.max(0, Math.min(total, d));
      let lo = 0;
      let hi = pts.length - 2;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (cum[mid] <= d) lo = mid;
        else hi = mid - 1;
      }
      const seg = lo;
      const t = (d - cum[seg]) / (cum[seg + 1] - cum[seg] || 1);
      const a = pts[seg];
      const b = pts[seg + 1];
      return L.point(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
    };

    // La dirección no sale del tramito donde cae la flecha (en zigzags apunta a cualquier
    // lado) sino de la cuerda entre REACH px antes y REACH px después. Si ese trozo es una
    // curva cerrada (la cuerda es mucho más corta que el camino), se busca una recta cerca.
    // primero rectas de 44 px; en zonas muy reviradas, rectas más cortas (pero rectas)
    const ATTEMPTS = [
      { reach: 22, straight: 0.92 },
      { reach: 11, straight: 0.95 },
      { reach: 7, straight: 0.97 },
    ];
    const OFFSETS = [0, 12, -12, 24, -24, 36, -36, 50, -50, 64, -64];
    const straightness = (d, reach) => at(d - reach).distanceTo(at(d + reach)) / (2 * reach);

    for (let d = SPACING / 2; d < total - 22; d += SPACING) {
      let pick = null;
      for (const { reach, straight } of ATTEMPTS) {
        const x = OFFSETS.map((o) => d + o).find((x) => x > reach && x < total - reach && straightness(x, reach) >= straight);
        if (x !== undefined) {
          pick = { x, reach };
          break;
        }
      }
      if (!pick) continue; // todo curvas por aquí: mejor sin flecha que una flecha mal puesta
      const p = at(pick.x);
      if (p.x < min.x || p.x > max.x || p.y < min.y || p.y > max.y) continue;
      const a = at(pick.x - pick.reach);
      const b = at(pick.x + pick.reach);
      const deg = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
      L.marker(this.map.layerPointToLatLng(p), {
        icon: L.divIcon({
          className: 'route-arrow',
          html: `<svg viewBox="0 0 12 12" style="transform:rotate(${deg.toFixed(0)}deg)"><path d="M2.5 2 L10.5 6 L2.5 10 L5 6 Z"/></svg>`,
          iconSize: [18, 18],
        }),
        interactive: false,
        keyboard: false,
        zIndexOffset: -1000,
      }).addTo(this.arrowLayer);
    }
  }

  setColorByType(on) {
    this.colorByType = on;
    this.setRoute(this.route);
  }

  setWeather(samples) {
    this.weatherLayer.clearLayers();
    const pad = (n) => String(n).padStart(2, '0');
    for (const s of samples) {
      const w = describeWeather(s.code);
      const time = `${pad(s.eta.getHours())}:${pad(s.eta.getMinutes())}`;
      L.marker([s.lat, s.lng], {
        icon: L.divIcon({ className: 'weather-marker', html: `${icon(w.icon)}<span>${Math.round(s.temp)}°</span>`, iconSize: [54, 22], iconAnchor: [27, 32] }),
        keyboard: false,
        zIndexOffset: -500,
      })
        .bindPopup(
          `<div class="fuel-popup">
            <div class="wp-popup-title">${icon(w.icon)} ${w.text}</div>
            <div class="wp-popup-coords">Paso estimado a las ${time} · km ${Math.round(s.km)}</div>
            <table>
              <tr><td>Temperatura</td><td><b>${Math.round(s.temp)} °C</b></td></tr>
              <tr><td>Prob. de lluvia</td><td><b>${s.rainProb ?? 0} %</b>${s.rainMm ? ` (${s.rainMm} mm)` : ''}</td></tr>
              <tr><td>Viento</td><td><b>${Math.round(s.wind)} km/h</b>, rachas ${Math.round(s.gusts)}</td></tr>
            </table>
          </div>`,
          { closeButton: false }
        )
        .on('mouseover', () => this._hideGhost())
        .addTo(this.weatherLayer);
    }
  }

  /** Pistas por espacios protegidos (naranja) o prohibidas (rojo): resultado de checkOffroad. */
  setOffroad(result) {
    this.offroadLayer.clearLayers();
    if (!result) return;
    const halo = (coords, color, opacity) =>
      L.polyline(coords, { pane: 'offroad', color, weight: 16, opacity, lineCap: 'round', interactive: false }).addTo(this.offroadLayer);
    for (const a of result.areas) a.ranges.forEach((c) => halo(c, '#ff9800', 0.45));
    for (const p of result.permit) p.ranges.forEach((c) => halo(c, '#ffc107', 0.55));
    for (const f of result.forbidden) f.ranges.forEach((c) => halo(c, '#e53935', 0.6));
  }

  setFuelStations(stations) {
    this.fuelLayer.clearLayers();
    for (const s of stations) {
      const price = (label, v) => (v ? `<tr><td>${label}</td><td><b>${v.toFixed(3)} €</b></td></tr>` : '');
      L.marker([s.lat, s.lng], {
        icon: L.divIcon({ className: 'fuel-marker', html: icon('fuel'), iconSize: [22, 22] }),
        keyboard: false,
      })
        .bindPopup(
          `<div class="fuel-popup">
            <div class="wp-popup-title">${escapeHtml(s.brand || 'Gasolinera')}</div>
            <div class="wp-popup-coords">km ${s.km.toFixed(1)} de la ruta${s.offsetM > 60 ? ` · a ${s.offsetM} m` : ''}</div>
            <div>${escapeHtml(s.address)}</div>
            <table>${price('Gasolina 95', s.p95)}${price('Gasolina 98', s.p98)}${price('Diésel', s.diesel)}</table>
            <div class="wp-popup-coords">${escapeHtml(s.hours || '')}</div>
          </div>`,
          { closeButton: false }
        )
        .on('mouseover', () => this._hideGhost())
        .addTo(this.fuelLayer);
    }
  }

  fitRoute() {
    const pts = this.route ? this.route.legs.flatMap((l) => l.coords) : this.waypoints.map((w) => [w.lat, w.lng]);
    if (pts.length > 1) this.map.fitBounds(L.latLngBounds(pts), { padding: [40, 40] });
    else if (pts.length === 1) this.map.setView(pts[0], Math.max(this.map.getZoom(), 12));
  }

  // ---------- eventos ----------

  _bindEvents() {
    const map = this.map;
    const container = map.getContainer();

    map.on('zoomend viewreset', () => this._computeLayerPoints());
    map.on('moveend', () => this._drawArrows()); // solo se pintan las flechas visibles

    map.on('click', (e) => {
      this._hideMenu();
      if (this.suppressClick || this.hover) return;
      this.h.onMapClick(e.latlng);
    });

    map.on('contextmenu', (e) => this._showMenu(e));
    map.on('movestart', () => this._hideMenu());

    let raf = 0;
    map.on('mousemove', (e) => {
      if (this.dragging) {
        this.ghost.setLatLng(e.latlng);
        this._showPreview(this.dragging.li, e.latlng, false);
        return;
      }
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => this._updateHover(e));
    });
    map.on('mouseout', () => {
      if (!this.dragging) this._hideGhost();
    });

    // fase de captura: tenemos que adelantarnos al arrastre del mapa de Leaflet
    container.addEventListener(
      'mousedown',
      (e) => {
        if (e.button !== 0 || !this.hover) return;
        e.stopPropagation();
        e.preventDefault();
        this.dragging = { li: this.hover.li };
        map.dragging.disable();
        this.tip.classList.add('hidden');
        container.classList.add('dragging-route');
      },
      true
    );

    const finishDrag = () => {
      if (!this.dragging) return;
      const { li } = this.dragging;
      const latlng = this.ghost.getLatLng();
      this.dragging = null;
      map.dragging.enable();
      container.classList.remove('dragging-route');
      this.previewLayer.clearLayers();
      this._hideGhost();
      this.suppressClick = true;
      setTimeout(() => (this.suppressClick = false), 400); // en táctil el "clic" llega más tarde
      this.h.onInsert(li + 1, latlng);
    };
    document.addEventListener('mouseup', finishDrag);

    // táctil: sin "hover", el arrastre empieza al poner el dedo cerca de la línea.
    // Leaflet usa eventos pointer: se interceptan en captura igual que el ratón.
    const TOUCH_PX = 28;
    container.addEventListener(
      'pointerdown',
      (e) => {
        if (e.pointerType !== 'touch' || !e.isPrimary || !this.route) return;
        const p = map.mouseEventToLayerPoint(e);
        const near = this._nearestOnRoute(p);
        const nearMarker = this.waypoints.some((w) => map.latLngToLayerPoint([w.lat, w.lng]).distanceTo(p) < TOUCH_PX);
        if (!near || near.d > TOUCH_PX || nearMarker) return;
        e.stopPropagation();
        e.preventDefault();
        this.dragging = { li: near.li, pointerId: e.pointerId };
        map.dragging.disable();
        this.ghost.setLatLng(map.layerPointToLatLng(near.point));
        if (!map.hasLayer(this.ghost)) this.ghost.addTo(map);
        this.ghost.setRadius(11); // que se vea bajo el dedo
      },
      true
    );
    container.addEventListener(
      'pointermove',
      (e) => {
        if (!this.dragging || e.pointerId !== this.dragging.pointerId) return;
        e.stopPropagation();
        const latlng = map.mouseEventToLatLng(e);
        this.ghost.setLatLng(latlng);
        this._showPreview(this.dragging.li, latlng, false);
      },
      true
    );
    const endTouch = (e) => {
      if (!this.dragging || e.pointerId !== this.dragging.pointerId) return;
      this.ghost.setRadius(7);
      finishDrag();
    };
    document.addEventListener('pointerup', endTouch);
    document.addEventListener('pointercancel', endTouch);
  }

  _computeLayerPoints() {
    if (!this.route) return;
    this.legPoints = this.route.legs.map((leg) => {
      const pts = leg.coords.map((c) => this.map.latLngToLayerPoint(c));
      return { pts, bounds: L.bounds(pts) };
    });
    this._drawArrows();
  }

  _updateHover(e) {
    const p = e.layerPoint;
    const near = this._nearestOnRoute(p);
    // cerca de un marcador (punto o gasolinera) manda el marcador, no el arrastre de la línea
    const markerLatLngs = [
      ...this.waypoints.map((w) => [w.lat, w.lng]),
      ...this.fuelLayer.getLayers().map((m) => m.getLatLng()),
      ...this.weatherLayer.getLayers().map((m) => m.getLatLng()),
    ];
    const nearMarker = markerLatLngs.some((ll) => this.map.latLngToLayerPoint(ll).distanceTo(p) < HOVER_PX);

    if (!near || near.d > HOVER_PX || nearMarker) {
      this._hideGhost();
      return;
    }

    const latlng = this.map.layerPointToLatLng(near.point);
    this.hover = { li: near.li, i: near.i, latlng };
    this.ghost.setLatLng(latlng);
    if (!this.map.hasLayer(this.ghost)) this.ghost.addTo(this.map);
    this.map.getContainer().classList.add('hover-route');

    const leg = this.route.legs[near.li];
    const seg = leg.segments.find((s) => near.i >= s.from && near.i < s.to) || leg.segments[leg.segments.length - 1];
    if (seg) {
      const t = ROAD_TYPES[seg.type];
      this.tip.innerHTML =
        `<span class="dot" style="background:${t.color}"></span>` +
        `<b>${seg.name || 'Sin nombre'}</b><br>${t.label}` +
        `<small>Arrastra para cambiar el recorrido</small>`;
      this.tip.style.left = `${e.containerPoint.x + 16}px`;
      this.tip.style.top = `${e.containerPoint.y + 16}px`;
      this.tip.classList.remove('hidden');
    }
  }

  _nearestOnRoute(p) {
    let best = null;
    this.legPoints.forEach(({ pts, bounds }, li) => {
      const pad = HOVER_PX;
      if (p.x < bounds.min.x - pad || p.x > bounds.max.x + pad || p.y < bounds.min.y - pad || p.y > bounds.max.y + pad) return;
      for (let i = 0; i < pts.length - 1; i++) {
        const q = L.LineUtil.closestPointOnSegment(p, pts[i], pts[i + 1]);
        const d = q.distanceTo(p);
        if (!best || d < best.d) best = { li, i, d, point: q };
      }
    });
    return best;
  }

  _hideGhost() {
    this.hover = null;
    if (this.map.hasLayer(this.ghost)) this.ghost.remove();
    this.tip.classList.add('hidden');
    this.map.getContainer().classList.remove('hover-route');
  }

  /** Líneas discontinuas desde los puntos vecinos mientras se arrastra. */
  _showPreview(index, latlng, isExisting) {
    this.previewLayer.clearLayers();
    const prev = isExisting ? this.waypoints[index - 1] : this.waypoints[index];
    const next = isExisting ? this.waypoints[index + 1] : this.waypoints[index + 1];
    const style = { color: '#111', weight: 3, dashArray: '6 6', opacity: 0.8, interactive: false };
    if (prev) L.polyline([[prev.lat, prev.lng], latlng], style).addTo(this.previewLayer);
    if (next) L.polyline([latlng, [next.lat, next.lng]], style).addTo(this.previewLayer);
  }

  _popupFor(i) {
    const w = this.waypoints[i];
    const isEnd = i === 0 || i === this.waypoints.length - 1;
    const el = document.createElement('div');
    el.className = 'wp-popup';
    const title = w.kind === 'via' && !isEnd ? 'Punto de paso' : w.name || 'Parada';
    el.innerHTML = `<div class="wp-popup-title">${escapeHtml(title)}</div>
      <div class="wp-popup-coords">${w.lat.toFixed(5)}, ${w.lng.toFixed(5)}</div>`;

    const btn = (label, fn, ico) => {
      const b = document.createElement('button');
      b.innerHTML = ico ? `${icon(ico)} ${escapeHtml(label)}` : escapeHtml(label);
      b.onclick = () => {
        this.map.closePopup();
        fn();
      };
      el.appendChild(b);
    };
    if (!isEnd) {
      btn(w.night ? 'Quitar fin de etapa' : 'Dormir aquí (fin de etapa)', () => this.h.onToggleNight(i), w.night ? 'sun' : 'moon');
      if (w.night) {
        // buscar alojamiento cerca de esta parada
        const a = document.createElement('a');
        a.className = 'popup-link';
        a.href = `https://www.google.com/maps/search/alojamiento/@${w.lat},${w.lng},14z`;
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = 'Buscar alojamiento aquí';
        el.appendChild(a);
      }
      btn(w.kind === 'via' ? 'Convertir en parada' : 'Convertir en punto de paso', () => this.h.onToggleKind(i));
    }
    btn('Eliminar', () => this.h.onRemove(i));
    return el;
  }

  _showMenu(e) {
    const hasRoute = this.waypoints.length >= 2;
    const items = [
      ['start', 'Salir desde aquí'],
      ['end', hasRoute ? 'Añadir destino aquí' : 'Ir hasta aquí'],
    ];
    if (hasRoute) items.push(['middle', 'Añadir parada intermedia aquí']);

    this.menu.innerHTML = '';
    for (const [action, label] of items) {
      const b = document.createElement('button');
      b.textContent = label;
      b.onclick = () => {
        this._hideMenu();
        this.h.onContextAction(action, e.latlng);
      };
      this.menu.appendChild(b);
    }
    this.menu.style.left = `${e.containerPoint.x}px`;
    this.menu.style.top = `${e.containerPoint.y}px`;
    this.menu.classList.remove('hidden');
  }

  _hideMenu() {
    this.menu.classList.add('hidden');
  }
}

export function escapeHtml(s) {
  return String(s).replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
