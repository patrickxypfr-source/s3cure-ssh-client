// Linien-Icons (24×24, Farbe folgt dem Text)
const ICON_PATHS = {
  folder: 'M3 7.5A2.5 2.5 0 0 1 5.5 5h3.6l2 2h7.4A2.5 2.5 0 0 1 21 9.5v8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z',
  file: 'M14 3H7.5A2.5 2.5 0 0 0 5 5.5v13A2.5 2.5 0 0 0 7.5 21h9a2.5 2.5 0 0 0 2.5-2.5V8z M14 3v5h5',
  link: 'M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1 M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1',
  up: 'M12 19V5 M6 11l6-6 6 6',
  home: 'M4 11l8-6.5 8 6.5 M6 9.5V20h12V9.5 M10 20v-5h4v5',
  refresh: 'M20 12a8 8 0 1 1-2.34-5.66 M20 4v5h-5',
  edit: 'M4 20h4L19 9l-4-4L4 16z M13.5 6.5l4 4',
  trash: 'M4 7h16 M9.5 7V4.5h5V7 M6.5 7l1 12.5h9l1-12.5 M10 11v5 M14 11v5',
  plus: 'M12 5v14 M5 12h14',
  upload: 'M12 15V4 M7.5 8.5L12 4l4.5 4.5 M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15',
  download: 'M12 4v11 M7.5 10.5L12 15l4.5-4.5 M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15',
  folderPlus: 'M3 7.5A2.5 2.5 0 0 1 5.5 5h3.6l2 2h7.4A2.5 2.5 0 0 1 21 9.5v8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z M12 10.5v6 M9 13.5h6',
  terminal: 'M5 4.5h14A2.5 2.5 0 0 1 21.5 7v10a2.5 2.5 0 0 1-2.5 2.5H5A2.5 2.5 0 0 1 2.5 17V7A2.5 2.5 0 0 1 5 4.5z M7 9.5l3 2.5-3 2.5 M13 15h4',
  server: 'M5.5 4h13A2.5 2.5 0 0 1 21 6.5v2A2.5 2.5 0 0 1 18.5 11h-13A2.5 2.5 0 0 1 3 8.5v-2A2.5 2.5 0 0 1 5.5 4z M5.5 13h13a2.5 2.5 0 0 1 2.5 2.5v2a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5v-2A2.5 2.5 0 0 1 5.5 13z M7 7.5h.01 M7 16.5h.01',
  close: 'M7 7l10 10 M17 7L7 17',
  down: 'M7 10l5 5 5-5',
  bolt: 'M13 3L5 13.5h6L10 21l8-10.5h-6z',
  search: 'M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13z M20 20l-4.8-4.8',
  rename: 'M4 20h4L19 9l-4-4L4 16z',
  lock: 'M7 11V8a5 5 0 0 1 10 0v3 M6.5 11h11A1.5 1.5 0 0 1 19 12.5v6A1.5 1.5 0 0 1 17.5 20h-11A1.5 1.5 0 0 1 5 18.5v-6A1.5 1.5 0 0 1 6.5 11z M12 14.5v2',
};

function icon(name, cls = '') {
  return `<svg class="ic ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${ICON_PATHS[name]}"/></svg>`;
}

// Elemente mit data-icon bekommen ihr Icon vorangestellt
function applyIcons(root = document) {
  for (const el of root.querySelectorAll('[data-icon]')) {
    if (el.querySelector(':scope > svg.ic')) continue;
    el.insertAdjacentHTML('afterbegin', icon(el.dataset.icon));
  }
}
