// Übersetzungen im Hauptprozess: dieselben Wörterbücher wie die Oberfläche (src/locales/*.js)
//   const { t } = require('./i18n');  t('main.saveAs')
// t() erst beim Gebrauch aufrufen (nicht beim Laden des Moduls) – die Sprache kann sich ändern.
// Sprache: Einstellung „language“ (system/de/en); „system“ = app.getLocale() (Deutsch für de*, sonst Englisch).
// S3CURE_LANG (de/en) nur für Tests. Ohne Electron (Unit-Tests) ist Deutsch der Standard.
const { createI18n, resolveLang, LANGS } = require('../src/i18n.js');

const dicts = { de: require('../src/locales/de.js'), en: require('../src/locales/en.js') };

let electronApp = null;
try {
  const e = require('electron');
  if (e && typeof e === 'object' && e.app) electronApp = e.app;
} catch { /* ohne Electron */ }

let pref = 'system';
let current = null; // { lang, api }
const listeners = [];

function systemLocale() {
  if (!electronApp) return 'de';
  try {
    if (electronApp.isReady()) return electronApp.getLocale();
    const list = electronApp.getPreferredSystemLanguages ? electronApp.getPreferredSystemLanguages() : [];
    return list[0] || process.env.LANG || '';
  } catch { return ''; }
}

function lang() {
  const forced = process.env.S3CURE_LANG;
  if (LANGS.includes(forced)) return forced;
  return resolveLang(pref, systemLocale());
}

function api() {
  const l = lang();
  if (!current || current.lang !== l) current = { lang: l, api: createI18n(dicts, l) };
  return current.api;
}

function setPreference(value) {
  const next = LANGS.includes(value) ? value : 'system';
  const before = lang();
  pref = next;
  if (lang() !== before) for (const cb of listeners) { try { cb(lang()); } catch (err) { console.error(err); } }
}

// Oberfläche fragt beim Laden synchron nach der Sprache (preload.js)
function register(ipcMain) {
  ipcMain.on('i18n:get', e => { e.returnValue = { lang: lang(), pref }; });
}

module.exports = {
  t: (key, params) => api().t(key, params),
  lang,
  locale: () => api().locale,
  getPreference: () => pref,
  setPreference,
  onChange: cb => listeners.push(cb),
  fmtNumber: (n, o) => api().fmtNumber(n, o),
  fmtDate: (d, o) => api().fmtDate(d, o),
  fmtTime: (d, o) => api().fmtTime(d, o),
  fmtDateTime: (d, o) => api().fmtDateTime(d, o),
  register,
  dicts,
};
