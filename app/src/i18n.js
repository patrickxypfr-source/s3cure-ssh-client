// S3cure SSH Client – Übersetzungen (Deutsch/Englisch), ohne Framework
//
// Dieselbe Datei läuft in der Oberfläche (als <script>, nach locales/de.js und locales/en.js)
// und im Hauptprozess (require, über lib/i18n.js).
//
//   t('sync.title')                         -> „Synchronisieren“ / „Sync“
//   t('sync.files', { count: 3 })           -> Plural: { one: '{count} Datei', other: '{count} Dateien' }
//   t('main.notFound', { host: 'pi' })      -> Platzhalter {host}
//   Werte dürfen auch Funktionen sein: p => `…${p.x}…`
//
// Statisches HTML: data-i18n (Text), data-i18n-html (Text mit <br>, <code> …), data-i18n-title,
// data-i18n-placeholder, data-i18n-aria-label. Bei data-i18n wird nur der erste Textknoten ersetzt –
// Symbole (data-icon) und eingebettete Felder (<label>Text<input></label>) bleiben erhalten.
(function (root) {
  const LANGS = ['de', 'en'];
  const LOCALES = { de: 'de-DE', en: 'en-US' };

  // 'system' + Systemsprache -> 'de' | 'en' (Deutsch für de*, sonst Englisch)
  function resolveLang(pref, systemLocale) {
    if (LANGS.includes(pref)) return pref;
    return /^de([-_]|$)/i.test(String(systemLocale || '')) ? 'de' : 'en';
  }

  function createI18n(dicts, lang) {
    if (!LANGS.includes(lang)) lang = 'de';
    const locale = LOCALES[lang];
    const warned = new Set();
    let rules = null;
    const pluralRules = () => rules || (rules = new Intl.PluralRules(locale));

    const fmtNumber = (n, opts) => Number(n).toLocaleString(locale, opts);
    const fmtDate = (d, opts) => new Date(d).toLocaleDateString(locale, opts);
    const fmtTime = (d, opts) => new Date(d).toLocaleTimeString(locale, opts);
    const fmtDateTime = (d, opts) => new Date(d).toLocaleString(locale, opts);

    function fill(text, params) {
      if (!params) return text;
      return text.replace(/\{(\w+)\}/g, (m, name) => {
        if (!(name in params)) return m;
        const v = params[name];
        if (name === 'count' && typeof v === 'number') return fmtNumber(v);
        return v == null ? '' : String(v);
      });
    }

    function lookup(key) {
      const own = dicts[lang] && dicts[lang][key];
      if (own !== undefined) return own;
      if (!warned.has(key)) {
        warned.add(key);
        if (typeof console !== 'undefined') console.warn(`[i18n] Text fehlt (${lang}): ${key}`);
      }
      const other = dicts.de && dicts.de[key];
      return other !== undefined ? other : (dicts.en && dicts.en[key]);
    }

    function t(key, params) {
      let v = lookup(key);
      if (v === undefined) return key;
      if (typeof v === 'function') return String(v(params || {}, api));
      if (v && typeof v === 'object') {
        const n = params && Number(params.count);
        const form = n === 0 && v.zero != null ? 'zero' : pluralRules().select(Number.isFinite(n) ? n : 0);
        v = v[form] != null ? v[form] : v.other;
      }
      return fill(String(v), params);
    }

    const has = key => !!(dicts[lang] && key in dicts[lang]);

    // Statische Texte im HTML übersetzen
    function apply(rootEl) {
      const doc = rootEl || (typeof document !== 'undefined' ? document : null);
      if (!doc) return;
      const all = sel => (doc.querySelectorAll ? [...doc.querySelectorAll(sel)] : []);
      for (const el of all('[data-i18n]')) setText(el, t(el.dataset.i18n));
      for (const el of all('[data-i18n-html]')) el.innerHTML = t(el.dataset.i18nHtml);
      for (const el of all('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
      for (const el of all('[data-i18n-placeholder]')) el.placeholder = t(el.dataset.i18nPlaceholder);
      for (const el of all('[data-i18n-aria-label]')) el.setAttribute('aria-label', t(el.dataset.i18nAriaLabel));
    }

    function setText(el, text) {
      if (!el.children.length) { el.textContent = text; return; }
      for (const node of el.childNodes) {
        if (node.nodeType === 3 && node.nodeValue.trim()) {
          const lead = node.nodeValue.match(/^\s*/)[0];
          const trail = node.nodeValue.match(/\s*$/)[0];
          node.nodeValue = lead + text + trail;
          return;
        }
      }
      el.insertBefore(el.ownerDocument.createTextNode(text), el.firstChild);
    }

    const api = { lang, locale, t, has, apply, fmtNumber, fmtDate, fmtTime, fmtDateTime };
    return api;
  }

  const exported = { createI18n, resolveLang, LANGS, LOCALES };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
    return;
  }

  // ---------- Oberfläche ----------
  const bridge = root.myssh || {};
  const lang = resolveLang(bridge.lang || 'system', bridge.lang ? '' : (root.navigator && root.navigator.language));
  const i18n = createI18n(root.S3_LOCALES || {}, lang);
  i18n.pref = bridge.langPref || 'system';
  root.I18N = i18n;
  root.t = i18n.t;
  if (root.document) {
    root.document.documentElement.lang = lang;
    i18n.apply(root.document);
  }
})(typeof window !== 'undefined' ? window : globalThis);
