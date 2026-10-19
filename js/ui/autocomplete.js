// Sugerencias de lugares mientras se escribe, con navegación por teclado.

import { suggestPlaces } from '../core/geocode.js';
import { escapeHtml } from './routeEditor.js';
import { errorText } from './errors.js';

const DEBOUNCE_MS = 250;
const MIN_CHARS = 3;

/**
 * @param input   <input> de texto
 * @param list    <ul> donde se pintan las sugerencias
 * @param opts {getNear: () => {lat,lng} | null, onSelect(item), extra(item, li)?: añade botones a cada fila}
 * @returns {search()} para lanzar la búsqueda ya (botón "Buscar")
 */
export function attachAutocomplete(input, list, { getNear = () => null, onSelect, extra }) {
  let items = [];
  let active = -1;
  let timer = 0;
  let controller = null;
  input.setAttribute('autocomplete', 'off');
  list.classList.add('suggestions');

  const close = () => {
    list.innerHTML = '';
    items = [];
    active = -1;
  };

  const highlight = (i) => {
    active = i;
    [...list.children].forEach((li, k) => li.classList.toggle('active', k === i));
  };

  const choose = (i) => {
    const item = items[i];
    if (!item) return;
    close();
    onSelect(item);
    input.blur(); // sitio elegido: fuera teclado
  };

  const render = () => {
    list.innerHTML = '';
    items.forEach((r, i) => {
      const li = document.createElement('li');
      li.innerHTML = `<div class="result-text"><b>${escapeHtml(r.name)}</b><small>${escapeHtml(r.detail)}</small></div>`;
      li.addEventListener('mousedown', (e) => e.preventDefault()); // no quitar el foco al input
      li.addEventListener('mouseenter', () => highlight(i));
      // toda la fila elige el sitio, salvo sus botones (Desde / Hasta)
      li.onclick = (e) => {
        if (!e.target.closest('button')) choose(i);
      };
      extra?.(r, li, close);
      list.appendChild(li);
    });
    if (!items.length) list.innerHTML = '<li class="muted">Sin resultados</li>';
  };

  async function search() {
    clearTimeout(timer);
    const q = input.value.trim();
    controller?.abort();
    if (q.length < MIN_CHARS) return close();
    controller = new AbortController();
    if (!items.length) list.innerHTML = '<li class="muted">Buscando…</li>';
    try {
      items = await suggestPlaces(q, getNear(), controller.signal);
      active = -1;
      if (document.activeElement === input || items.length) render();
    } catch (err) {
      if (err.name !== 'AbortError') list.innerHTML = `<li class="muted">${escapeHtml(errorText(err, 'No se pudo buscar.'))}</li>`;
    }
  }

  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(search, DEBOUNCE_MS);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' && items.length) {
      e.preventDefault();
      highlight((active + 1) % items.length);
    } else if (e.key === 'ArrowUp' && items.length) {
      e.preventDefault();
      highlight((active - 1 + items.length) % items.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (items.length) choose(Math.max(0, active));
      else search();
    } else if (e.key === 'Escape' && items.length) {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  });
  input.addEventListener('blur', () => setTimeout(close, 150));
  // botones de la fila (Desde / Hasta): también ocultan el teclado
  list.addEventListener('click', (e) => {
    if (e.target.closest('button')) input.blur();
  });

  return { search, close };
}
