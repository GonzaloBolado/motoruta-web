// Asistente "Generar ruta": recoge las preferencias y lanza la generación.

import { reverseGeocode } from '../core/geocode.js';
import { attachAutocomplete } from './autocomplete.js';
import { DateField, fillTimeSelect, setTimeSelect } from './dateTime.js';
import { icon } from './icons.js';
import { errorText } from './errors.js';

const $ = (id) => document.getElementById(id);

/** Selector de lugar: sugerencias al escribir + "mi ubicación". value = {lat, lng, name} | null */
class PlacePicker {
  constructor(el, placeholder) {
    this.value = null;
    el.innerHTML = `
      <div class="place-row">
        <input type="text" placeholder="${placeholder}" />
        <button type="button" data-a="here" title="Mi ubicación">${icon('locate')}</button>
      </div>
      <ul class="search-results"></ul>`;
    this.input = el.querySelector('input');
    this.list = el.querySelector('ul');
    this.input.addEventListener('input', () => (this.value = null));
    attachAutocomplete(this.input, this.list, {
      getNear: () => nearHint,
      onSelect: (r) => this.set({ lat: r.lat, lng: r.lng, name: r.name }),
    });
    el.querySelector('[data-a=here]').onclick = () => this.locate();
  }

  /** Si el texto ya no es el del sitio elegido (se cambió o se borró), no hay sitio elegido. */
  syncWithText() {
    if (this.value && this.input.value.trim() !== (this.value.name || '').trim()) this.value = null;
  }

  set(place) {
    this.value = place;
    this.input.value = place?.name || '';
    this.list.innerHTML = '';
  }

  locate() {
    if (!navigator.geolocation) return;
    this.input.value = 'Buscando tu ubicación…';
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const { latitude: lat, longitude: lng } = pos.coords;
        this.set({ lat, lng, name: (await reverseGeocode(lat, lng)) || 'Mi ubicación' });
      },
      () => {
        this.input.value = '';
        this.list.innerHTML = '<li class="muted">No se pudo obtener tu ubicación</li>';
      }
    );
  }
}

let pickers = null;
let throughPickers = [];
let wzDate = null;
let nearHint = null; // centro del mapa: las sugerencias cercanas salen antes
let controller = null;
let onGeneratePending = null;

function addThrough(place = null) {
  const item = document.createElement('div');
  item.className = 'through-item';
  const host = document.createElement('div');
  host.className = 'place';
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'remove';
  remove.title = 'Quitar';
  remove.textContent = '✕';
  item.append(host, remove);
  $('wz-through').appendChild(item);

  const picker = new PlacePicker(host, `Punto intermedio ${throughPickers.length + 1}`);
  if (place) picker.set(place);
  throughPickers.push(picker);
  remove.onclick = () => {
    throughPickers = throughPickers.filter((x) => x !== picker);
    item.remove();
  };
  if (!place) picker.input.focus();
}

/**
 * @param initial {from, to, departure: 'YYYY-MM-DDTHH:MM'}
 * @param onGenerate async (params, onProgress, signal) => void
 */
export function openWizard(initial, onGenerate) {
  const dialog = $('wizard');
  const form = $('wizard-form');

  if (!pickers) {
    wzDate = new DateField($('wz-date'));
    fillTimeSelect($('wz-time'));
    pickers = {
      from: new PlacePicker($('pp-from'), 'Pueblo, ciudad o dirección'),
      to: new PlacePicker($('pp-to'), 'A dónde vas'),
      end: new PlacePicker($('pp-end'), 'Dónde acabas'),
    };
    form.querySelectorAll('[name=mode]').forEach((r) => r.addEventListener('change', syncMode));
    $('wz-same').addEventListener('change', () => $('pp-end').classList.toggle('hidden', $('wz-same').checked));
    $('wz-add-through').onclick = () => addThrough();
    (initial.through || []).forEach((p) => addThrough(p));
    dialog.querySelectorAll('[data-close]').forEach((b) => (b.onclick = close));
    dialog.addEventListener('cancel', () => controller?.abort());
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      submit(onGeneratePending);
    });
  }
  onGeneratePending = onGenerate;
  nearHint = initial.near || null;

  if (initial.from && !pickers.from.value) pickers.from.set(initial.from);
  if (initial.to && !pickers.to.value) pickers.to.set(initial.to);
  const [date, time] = initial.departure.split('T');
  wzDate.value = date;
  setTimeSelect($('wz-time'), time);
  $('wz-error').classList.add('hidden');
  setBusy(false);
  syncMode();
  dialog.showModal();
}

function syncMode() {
  const mode = new FormData($('wizard-form')).get('mode');
  $('wizard').dataset.mode = mode;
  $('wz-from-label').textContent = mode === 'loop' ? 'Sales de' : 'Salida';
}

function close() {
  controller?.abort();
  $('wizard').close();
}

function setBusy(busy, text = '') {
  $('wz-submit').disabled = busy;
  $('wz-progress').classList.toggle('hidden', !busy);
  if (text) $('wz-progress').querySelector('span').textContent = text;
  if (!busy) $('wz-progress').querySelector('div').style.width = '0%';
}

async function submit(onGenerate) {
  const form = $('wizard-form');
  const data = new FormData(form);
  const mode = data.get('mode');
  const err = (msg) => {
    $('wz-error').textContent = msg;
    $('wz-error').classList.remove('hidden');
  };
  $('wz-error').classList.add('hidden');
  // lo que se ve en cada campo manda: un sitio anterior no se usa si su texto ya no está
  [pickers.from, pickers.to, pickers.end, ...throughPickers].forEach((p) => p.syncWithText());

  const from = pickers.from.value;
  if (!from) return err('Elige el punto de salida (busca y pulsa en un resultado).');
  if (!wzDate.value) return err('Escribe el día de salida (dd/mm/aaaa).');
  const params = {
    mode,
    from,
    curvy: data.get('curvy'),
    avoidHighways: $('wz-highways').checked,
    avoidTolls: $('wz-tolls').checked,
    allowTrails: mode === 'loop' && $('wz-trails').checked,
    departure: `${wzDate.value}T${$('wz-time').value}`,
  };
  if (mode === 'trip') {
    if (!pickers.to.value) return err('Elige el destino.');
    const pending = throughPickers.find((tp) => !tp.value && tp.input.value.trim());
    if (pending) return err(`Elige "${pending.input.value.trim()}" en la lista de resultados, o quítalo.`);
    params.through = throughPickers.map((tp) => tp.value).filter(Boolean);
    params.to = pickers.to.value;
    params.kmPerDay = Math.max(100, parseFloat($('wz-kmday').value) || 350);
  } else {
    params.end = $('wz-same').checked ? null : pickers.end.value;
    if (!$('wz-same').checked && !params.end) return err('Elige dónde acabas o marca "Vuelvo al mismo sitio".');
    params.targetKm = Math.max(40, parseFloat($('wz-km').value) || 250);
  }

  controller = new AbortController();
  setBusy(true, 'Calculando la ruta base…');
  const bar = $('wz-progress').querySelector('div');
  const onProgress = (done, total, text) => {
    bar.style.width = `${Math.round((done / Math.max(1, total)) * 100)}%`;
    $('wz-progress').querySelector('span').textContent = text || `Probando variantes de ruta… ${done}/${total}`;
  };
  try {
    await onGenerate(params, onProgress, controller.signal);
    $('wizard').close();
  } catch (e) {
    if (e.name !== 'AbortError') err(errorText(e, 'No se pudo generar la ruta.'));
  } finally {
    setBusy(false);
  }
}
