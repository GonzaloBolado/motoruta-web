// Iconos de línea sencillos (rejilla de 24, trazo de 2), en gris como el de las capas del mapa.
// Los mismos trazados están en la app Android (Icons.kt).

export const ICON_PATHS = {
  home: 'M3.5 11 12 4l8.5 7M6 9.5V20h12V9.5',
  logo: 'M12 3 19 20 12 16 5 20z',
  sparkles: 'M11 3l1.8 5.2L18 10l-5.2 1.8L11 17l-1.8-5.2L4 10l5.2-1.8zM18.5 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z',
  route: 'M8 18a2 2 0 1 1-4 0 2 2 0 1 1 4 0zM20 6a2 2 0 1 1-4 0 2 2 0 1 1 4 0zM8 18h8.5a3.5 3.5 0 0 0 0-7h-9a3.5 3.5 0 0 1 0-7H16',
  loop: 'M17 2.5l3 3-3 3M20 5.5H8a4 4 0 0 0-4 4V11M7 21.5l-3-3 3-3M4 18.5h12a4 4 0 0 0 4-4V13',
  locate: 'M12 5a7 7 0 1 0 0 14 7 7 0 1 0 0-14zM12 2v3M12 19v3M2 12h3M19 12h3',
  moon: 'M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z',
  sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 1 0 0-8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  fuel: 'M4 21V5a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v16M3 21h12M7 8h4M14 10h2a2 2 0 0 1 2 2v4a1.5 1.5 0 0 0 3 0V9l-3-3',
  coin: 'M12 3a9 9 0 1 0 0 18 9 9 0 1 0 0-18zM15 9a3.5 3.5 0 1 0 0 6M7.5 11h5M7.5 13h5',
  ferry: 'M3 15l1.5 4.5h15L21 15zM5.5 15V9.5h13V15M12 9.5V5M9.5 5h5',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  alert: 'M12 3.5 2.5 20h19zM12 10v4.5M12 17.5v.01',
  drop: 'M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z',
  wind: 'M3 8h10a2.5 2.5 0 1 0-2.5-2.5M3 12h15a2.5 2.5 0 1 1-2.5 2.5M3 16h7',
  cold: 'M10 14.5V5a2 2 0 0 1 4 0v9.5a4 4 0 1 1-4 0zM12 17v.01',
  hot: 'M10 14.5V5a2 2 0 0 1 4 0v9.5a4 4 0 1 1-4 0zM12 17V9',
  // tiempo
  cloud: 'M7 19a4.5 4.5 0 0 1-.6-9 6 6 0 0 1 11.4-1A5 5 0 0 1 17.5 19z',
  'cloud-sun': 'M8 3v1.5M3.5 8H2M4.8 4.8l1 1M12 8.5a4 4 0 0 0-7.4 1.9M8 20a3.5 3.5 0 0 1-.4-7 5 5 0 0 1 9.5-.8A4 4 0 0 1 17 20z',
  fog: 'M4 9h16M3 13h18M5 17h14',
  drizzle: 'M7 15a4.5 4.5 0 0 1-.6-9 6 6 0 0 1 11.4-1A5 5 0 0 1 17.5 15zM9 18.5v.5M12 20v.5M15 18.5v.5',
  rain: 'M7 15a4.5 4.5 0 0 1-.6-9 6 6 0 0 1 11.4-1A5 5 0 0 1 17.5 15zM8.5 18l-1 3M12.5 18l-1 3M16.5 18l-1 3',
  snow: 'M7 15a4.5 4.5 0 0 1-.6-9 6 6 0 0 1 11.4-1A5 5 0 0 1 17.5 15zM8 19h.01M12 21h.01M16 19h.01',
  storm: 'M7 15a4.5 4.5 0 0 1-.6-9 6 6 0 0 1 11.4-1A5 5 0 0 1 17.5 15zM13 15l-3 4h4l-3 4',
  leaf: 'M5 19C5 10 11 5 20 4c0 9-5 15-14 15zM5 19l8-8',
  unknown: 'M9 9a3 3 0 1 1 4.5 2.6c-1 .6-1.5 1.2-1.5 2.4M12 18v.01',
};

/** SVG en línea; toma el color del texto (currentColor). */
export function icon(name, cls = '') {
  return `<svg class="ico ${cls}" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${ICON_PATHS[name] || ICON_PATHS.unknown}"/></svg>`;
}
