// Fecha en formato español (dd/mm/aaaa) con calendario propio, y hora de 24 h.
// Los <input type="date|time"> nativos usan el idioma del navegador (mm/dd, AM/PM).

const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const WEEKDAYS = ['L', 'M', 'X', 'J', 'V', 'S', 'D'];
const pad = (n) => String(n).padStart(2, '0');

const isoToEs = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '');
const toIso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function esToIso(text) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text.trim());
  if (!m) return null;
  const d = new Date(+m[3], +m[2] - 1, +m[1]);
  // descarta fechas imposibles como 31/02
  return d.getDate() === +m[1] && d.getMonth() === +m[2] - 1 ? toIso(d) : null;
}

/**
 * Convierte un <input> en campo de fecha dd/mm/aaaa con calendario.
 * `value` es la fecha ISO (aaaa-mm-dd). Lanza 'change' en el input al cambiar.
 */
export class DateField {
  constructor(input) {
    this.input = input;
    this.iso = '';
    input.type = 'text';
    input.placeholder = 'dd/mm/aaaa';
    input.inputMode = 'numeric';
    input.maxLength = 10;
    input.autocomplete = 'off';
    input.classList.add('date-input');

    input.addEventListener('input', () => {
      // pone las barras solas mientras se escribe
      const digits = input.value.replace(/\D/g, '').slice(0, 8);
      input.value = [digits.slice(0, 2), digits.slice(2, 4), digits.slice(4)].filter(Boolean).join('/');
    });
    input.addEventListener('blur', () => this.commit());
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.commit();
        this.close();
      } else if (e.key === 'Escape' && this.popup) {
        e.stopPropagation();
        e.preventDefault();
        this.close();
      }
    });
    input.addEventListener('focus', () => this.open());
    input.addEventListener('click', () => this.open());
  }

  get value() {
    return this.iso;
  }

  set value(iso) {
    this.iso = iso || '';
    this.input.value = isoToEs(this.iso);
  }

  commit() {
    const iso = esToIso(this.input.value);
    if (iso && iso !== this.iso) {
      this.iso = iso;
      this.input.value = isoToEs(iso);
      this.input.dispatchEvent(new Event('change'));
    } else {
      this.input.value = isoToEs(this.iso); // texto inválido: se vuelve a la fecha anterior
    }
  }

  select(iso) {
    this.value = iso;
    this.input.dispatchEvent(new Event('change'));
    this.close();
    this.input.blur(); // día elegido en el calendario: fuera teclado
  }

  open() {
    if (this.popup) return;
    const base = this.iso ? new Date(`${this.iso}T00:00`) : new Date();
    this.month = new Date(base.getFullYear(), base.getMonth(), 1);

    this.popup = document.createElement('div');
    this.popup.className = 'calendar';
    // dentro de un <dialog> modal el calendario tiene que estar en el propio diálogo
    (this.input.closest('dialog') || document.body).appendChild(this.popup);
    this.popup.addEventListener('mousedown', (e) => e.preventDefault()); // no quitar el foco al input
    this.render();
    this.position();

    this.outside = (e) => {
      if (!this.popup?.contains(e.target) && e.target !== this.input) this.close();
    };
    document.addEventListener('mousedown', this.outside, true);
  }

  close() {
    this.popup?.remove();
    this.popup = null;
    document.removeEventListener('mousedown', this.outside, true);
  }

  position() {
    const r = this.input.getBoundingClientRect();
    const h = this.popup.offsetHeight;
    const below = r.bottom + 4 + h < window.innerHeight;
    this.popup.style.left = `${Math.min(r.left, window.innerWidth - this.popup.offsetWidth - 8)}px`;
    this.popup.style.top = `${below ? r.bottom + 4 : r.top - h - 4}px`;
  }

  render() {
    const y = this.month.getFullYear();
    const m = this.month.getMonth();
    const first = (new Date(y, m, 1).getDay() + 6) % 7; // lunes = 0
    const days = new Date(y, m + 1, 0).getDate();
    const today = toIso(new Date());

    let cells = '';
    for (let i = 0; i < first; i++) cells += '<span></span>';
    for (let d = 1; d <= days; d++) {
      const iso = toIso(new Date(y, m, d));
      const cls = [iso === this.iso && 'selected', iso === today && 'today'].filter(Boolean).join(' ');
      cells += `<button type="button" data-iso="${iso}" class="${cls}">${d}</button>`;
    }

    this.popup.innerHTML = `
      <div class="cal-head">
        <button type="button" data-nav="-1" title="Mes anterior">‹</button>
        <b>${MONTHS[m]} ${y}</b>
        <button type="button" data-nav="1" title="Mes siguiente">›</button>
      </div>
      <div class="cal-grid">${WEEKDAYS.map((w) => `<i>${w}</i>`).join('')}${cells}</div>
      <div class="cal-foot"><button type="button" data-iso="${today}">Hoy</button></div>`;

    this.popup.querySelectorAll('[data-nav]').forEach((b) => {
      b.onclick = () => {
        this.month = new Date(y, m + +b.dataset.nav, 1);
        this.render();
      };
    });
    this.popup.querySelectorAll('[data-iso]').forEach((b) => (b.onclick = () => this.select(b.dataset.iso)));
  }
}

/** Rellena un <select> con horas de 24 h cada `stepMin` minutos. */
export function fillTimeSelect(select, stepMin = 15) {
  select.innerHTML = '';
  for (let t = 0; t < 24 * 60; t += stepMin) {
    const v = `${pad(Math.floor(t / 60))}:${pad(t % 60)}`;
    select.add(new Option(v, v));
  }
}

/** Pone una hora en el select, redondeando al paso más cercano. */
export function setTimeSelect(select, hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const step = 15;
  const t = Math.round((h * 60 + m) / step) * step % (24 * 60);
  select.value = `${pad(Math.floor(t / 60))}:${pad(t % 60)}`;
}
