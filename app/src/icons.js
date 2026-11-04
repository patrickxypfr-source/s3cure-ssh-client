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

// Icons für die Befehlsknöpfe (quickbar.js) – auch im Knopf-Dialog auswählbar
Object.assign(ICON_PATHS, (CIRCLE => ({
  pulse: 'M3 12h4l2.5-6 4 12 2.5-6H21',
  check: 'M5 12.5l4.5 4.5L19 7',
  checkCircle: CIRCLE + ' M8 12.5l3 3 5-6',
  sync: 'M4.5 11A7.5 7.5 0 0 1 17.8 7.2L20 9.5 M20 4.5v5h-5 M19.5 13a7.5 7.5 0 0 1-13.3 3.8L4 14.5 M4 19.5v-5h5',
  restart: 'M4 12a8 8 0 1 0 2.34-5.66 M4 4v5h5',
  power: 'M12 3.5v8 M7.2 6.3a7.5 7.5 0 1 0 9.6 0',
  play: 'M8 5.5v13l10.5-6.5z',
  stop: 'M7.5 6h9A1.5 1.5 0 0 1 18 7.5v9a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 6 16.5v-9A1.5 1.5 0 0 1 7.5 6z',
  pause: 'M9 5.5v13 M15 5.5v13',
  list: 'M9 6h11 M9 12h11 M9 18h11 M4.5 6h.01 M4.5 12h.01 M4.5 18h.01',
  logs: 'M14 3H7.5A2.5 2.5 0 0 0 5 5.5v13A2.5 2.5 0 0 0 7.5 21h9a2.5 2.5 0 0 0 2.5-2.5V8z M14 3v5h5 M8.5 13h7 M8.5 16.5h5',
  radio: 'M12 10.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z M8.5 8.5a5 5 0 0 0 0 7 M15.5 8.5a5 5 0 0 1 0 7 M5.6 5.6a9 9 0 0 0 0 12.8 M18.4 5.6a9 9 0 0 1 0 12.8',
  gitBranch: 'M6 3.5v11.5 M6 15a3 3 0 1 0 0 6 3 3 0 0 0 0-6z M18 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6z M18 9a9 9 0 0 1-9 9',
  gitCommit: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z M3 12h6 M15 12h6',
  hammer: 'M12.9 4.1l7.1 7.1-2.9 2.8-7-7.1z M13.6 10.4L4.5 19.5',
  archive: 'M4 4.5h16A1 1 0 0 1 21 5.5v2.5A1 1 0 0 1 20 9H4a1 1 0 0 1-1-1V5.5a1 1 0 0 1 1-1z M5 9v9.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V9 M10 13h4',
  undo: 'M9 14L4 9l5-5 M4 9h10.5a5.5 5.5 0 0 1 0 11H11',
  gear: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z M12 5a7 7 0 1 0 0 14 7 7 0 0 0 0-14z M12 2.5V5 M12 19v2.5 M2.5 12H5 M19 12h2.5 M5.3 5.3l1.7 1.7 M17 17l1.7 1.7 M5.3 18.7L7 17 M17 7l1.7-1.7',
  sliders: 'M4 6h10 M18 6h2 M16 4v4 M4 12h2 M10 12h10 M8 10v4 M4 18h11 M19 18h1 M17 16v4',
  key: 'M7.5 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10z M7.5 11.2v1.6 M12.5 12H21 M17.5 12v3.5 M21 12v3',
  database: 'M12 3c4.4 0 8 1.3 8 3s-3.6 3-8 3-8-1.3-8-3 3.6-3 8-3z M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6 M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
  container: 'M12 3l8 4.5v9L12 21l-8-4.5v-9z M4 7.5l8 4.5 8-4.5 M12 12v9',
  layers: 'M12 3.5l8.5 4.5-8.5 4.5L3.5 8z M3.5 12l8.5 4.5 8.5-4.5 M3.5 16l8.5 4.5 8.5-4.5',
  globe: CIRCLE + ' M3 12h18 M12 3c2.5 2.5 3.8 5.5 3.8 9s-1.3 6.5-3.8 9 M12 3c-2.5 2.5-3.8 5.5-3.8 9s1.3 6.5 3.8 9',
  network: 'M9.5 3h5v5h-5z M3 16h5v5H3z M16 16h5v5h-5z M12 8v4 M5.5 16v-2a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v2',
  wifi: 'M2.5 9a14 14 0 0 1 19 0 M5.5 12.5a9.5 9.5 0 0 1 13 0 M8.8 16a4.5 4.5 0 0 1 6.4 0 M12 19.5h.01',
  hardDrive: 'M3 13l2.5-7.5A2 2 0 0 1 7.4 4h9.2a2 2 0 0 1 1.9 1.5L21 13 M3 13v4.5A2.5 2.5 0 0 0 5.5 20h13a2.5 2.5 0 0 0 2.5-2.5V13z M7 16.5h.01 M11 16.5h.01',
  memory: 'M4 7.5h16a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1z M7 15.5V19 M12 15.5V19 M17 15.5V19 M7 10.5v2 M10.5 10.5v2 M14 10.5v2 M17.5 10.5v2',
  cpu: 'M8 6.5h8A1.5 1.5 0 0 1 17.5 8v8a1.5 1.5 0 0 1-1.5 1.5H8A1.5 1.5 0 0 1 6.5 16V8A1.5 1.5 0 0 1 8 6.5z M10 10h4v4h-4z M10 3v3.5 M14 3v3.5 M10 17.5V21 M14 17.5V21 M3 10h3.5 M3 14h3.5 M17.5 10H21 M17.5 14H21',
  gauge: 'M4.5 18a8.5 8.5 0 1 1 15 0 M12 14l3.5-4.5 M12 14h.01',
  clock: CIRCLE + ' M12 7.5V12l3 2',
  user: 'M12 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8z M4.5 20a7.5 7.5 0 0 1 15 0',
  users: 'M9 4.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z M2.5 20a6.5 6.5 0 0 1 13 0 M15.5 4.8a3.5 3.5 0 0 1 0 6.4 M18 14a6.5 6.5 0 0 1 3.5 6',
  unlock: 'M7 11V8a5 5 0 0 1 9.6-2 M6.5 11h11A1.5 1.5 0 0 1 19 12.5v6A1.5 1.5 0 0 1 17.5 20h-11A1.5 1.5 0 0 1 5 18.5v-6A1.5 1.5 0 0 1 6.5 11z M12 14.5v2',
  shield: 'M12 3l7.5 3v5.5c0 4.5-3.2 8-7.5 9.5-4.3-1.5-7.5-5-7.5-9.5V6z',
  shieldCheck: 'M12 3l7.5 3v5.5c0 4.5-3.2 8-7.5 9.5-4.3-1.5-7.5-5-7.5-9.5V6z M9 12l2 2 4-4',
  rocket: 'M12 2.5c3 2 4.5 5.5 4.5 9.5L15 16H9l-1.5-4c0-4 1.5-7.5 4.5-9.5z M12 8a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z M7.5 12L5 14.5V18l4-2 M16.5 12l2.5 2.5V18l-4-2 M10.5 18.5L12 21.5l1.5-3',
  cloud: 'M7 19h10.5a4 4 0 0 0 .6-7.96A6 6 0 0 0 6.6 9.6 4.75 4.75 0 0 0 7 19z',
  code: 'M8.5 7L3.5 12l5 5 M15.5 7l5 5-5 5',
  alert: 'M10.3 4.3L2.8 17.5a2 2 0 0 0 1.7 3h15a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0z M12 9.5v4 M12 17h.01',
  info: CIRCLE + ' M12 11v5.5 M12 7.5h.01',
  help: CIRCLE + ' M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .9-1 1.7v.3 M12 17h.01',
  bell: 'M6 16v-5a6 6 0 0 1 12 0v5l1.5 2h-15z M10 20.5a2 2 0 0 0 4 0',
  star: 'M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z',
}))('M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z'));

// Hauptprozess (app/lib/snippets.js) prüft Icon-Namen gegen diese Liste
if (typeof module !== 'undefined' && module.exports) module.exports = { ICON_PATHS };
