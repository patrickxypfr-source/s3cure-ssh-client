// S3cure SSH Client – Einstellungen
// Gespeichert in ~/.myssh/settings.json (über window.mysshSettings → lib/settings.js).
//
// Eigene Einstellungen ergänzen (z. B. in app/src/<feature>.js):
//
//   registerSettingsSection({
//     id: 'dateien', title: 'Dateien', icon: 'folder', order: 30,
//     defaults: { 'files.showHidden': false },
//     fields: [
//       { key: 'files.showHidden', type: 'toggle', label: 'Versteckte Dateien zeigen' },
//       { key: 'files.sort', type: 'select', label: 'Sortieren nach', options: [['name', 'Name'], ['size', 'Größe']] },
//       { key: 'files.limit', type: 'number', label: 'Höchstens', min: 10, max: 9999, unit: 'Einträge' },
//       { key: 'files.zoom', type: 'range', label: 'Zoom', min: 50, max: 200, step: 10, unit: '%' },
//     ],
//     render(container) { … }   // optional: eigener Inhalt unter den Feldern
//   });
//   Settings.get('files.showHidden');           // Wert oder Standard
//   Settings.set({ 'files.showHidden': true }); // speichern (null = Standard)
//   Settings.onChange((values, changedKeys) => …);
(() => {
  const store = window.mysshSettings;
  const sections = [];
  const defaults = {};
  const listeners = [];
  let values = {};
  let current = null; // gerade angezeigter Abschnitt

  Object.assign(ICON_PATHS, {
    gear: 'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
    sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z M12 2v2 M12 20v2 M4.9 4.9l1.4 1.4 M17.7 17.7l1.4 1.4 M2 12h2 M20 12h2 M4.9 19.1l1.4-1.4 M17.7 6.3l1.4-1.4',
  });

  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const get = key => (key in values ? values[key] : defaults[key]);
  const all = () => ({ ...defaults, ...values });

  function emit(changed) {
    if (!changed.length) return;
    const v = all();
    for (const cb of listeners) { try { cb(v, changed); } catch (err) { console.error(err); } }
  }

  async function set(patch) {
    const clean = {};
    for (const [k, v] of Object.entries(patch)) clean[k] = v === undefined || same(v, defaults[k]) ? null : v;
    const before = all();
    values = await store.set(clean);
    const after = all();
    emit(Object.keys(patch).filter(k => !same(before[k], after[k])));
    return after;
  }

  const ready = store.get().then(v => { values = v || {}; emit(Object.keys(all())); }).catch(err => console.error(err));

  // In einem anderen Fenster geändert (mehrere Fenster, app/lib/windows.js)
  store.onChanged?.(v => {
    const before = all();
    values = v || {};
    const after = all();
    emit(Object.keys({ ...before, ...after }).filter(k => !same(before[k], after[k])));
    if (!modal.hidden && current) renderNav();
  });

  function registerSettingsSection(section) {
    if (!section || !section.id) throw new Error('registerSettingsSection: id fehlt');
    const i = sections.findIndex(s => s.id === section.id);
    if (i >= 0) sections.splice(i, 1);
    sections.push({ order: 50, fields: [], ...section });
    sections.sort((a, b) => a.order - b.order);
    Object.assign(defaults, section.defaults || {});
    if (!modal.hidden) renderNav();
  }

  // ---------- Dialog ----------

  const modal = document.createElement('div');
  modal.id = 'settings-modal';
  modal.className = 'modal';
  modal.hidden = true;
  modal.innerHTML = `
    <div class="dialog settings-dialog" role="dialog" aria-labelledby="settings-title">
      <div class="settings-head">
        <h2 id="settings-title">${t('settings.title')}</h2>
        <button class="mini-btn" data-close title="${t('settings.closeEsc')}">${icon('close')}</button>
      </div>
      <div class="settings-body">
        <nav class="settings-nav"></nav>
        <div class="settings-content"></div>
      </div>
      <div class="actions">
        <button type="button" class="btn" data-reset>${t('settings.resetDefaults')}</button>
        <div class="spacer"></div>
        <button type="button" class="btn primary" data-close>${t('common.done')}</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  const nav = modal.querySelector('.settings-nav');
  const content = modal.querySelector('.settings-content');

  function renderNav() {
    nav.innerHTML = '';
    nav.hidden = sections.length < 2;
    for (const s of sections) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = s.id === current ? 'on' : '';
      b.innerHTML = icon(s.icon || 'gear');
      b.append(s.title);
      b.addEventListener('click', () => show(s.id));
      nav.appendChild(b);
    }
  }

  function fieldControl(f) {
    const value = get(f.key);
    const save = v => set({ [f.key]: v }).catch(err => (window.showError ? showError(err) : console.error(err)));
    if (f.type === 'toggle') {
      const wrap = document.createElement('label');
      wrap.className = 'toggle';
      wrap.innerHTML = '<input type="checkbox"><span class="track"><span class="knob"></span></span>';
      const input = wrap.querySelector('input');
      input.checked = !!value;
      input.addEventListener('change', () => save(input.checked));
      return wrap;
    }
    if (f.type === 'select') {
      const sel = document.createElement('select');
      const options = typeof f.options === 'function' ? f.options(value) : f.options;
      for (const [v, text, disabled] of options) {
        const o = document.createElement('option');
        o.value = JSON.stringify(v);
        o.textContent = text;
        o.disabled = !!disabled;
        sel.appendChild(o);
      }
      sel.value = JSON.stringify(value);
      sel.addEventListener('change', () => save(JSON.parse(sel.value)));
      return sel;
    }
    if (f.type === 'number' || f.type === 'range') {
      const wrap = document.createElement('div');
      wrap.className = 'settings-num';
      const input = document.createElement('input');
      input.type = f.type;
      Object.assign(input, { min: f.min ?? '', max: f.max ?? '', step: f.step ?? 1, value });
      wrap.appendChild(input);
      const out = document.createElement('span');
      out.className = 'unit';
      const show = v => { out.textContent = (f.type === 'range' ? v + ' ' : '') + (f.unit || ''); };
      show(value);
      wrap.appendChild(out);
      const commit = () => {
        let v = Number(input.value);
        if (!Number.isFinite(v)) return;
        if (f.min != null) v = Math.max(f.min, v);
        if (f.max != null) v = Math.min(f.max, v);
        show(v);
        save(v);
      };
      input.addEventListener(f.type === 'range' ? 'input' : 'change', commit);
      if (f.type === 'range') input.addEventListener('input', () => show(input.value));
      return wrap;
    }
    if (f.type === 'segment') {
      const seg = document.createElement('div');
      seg.className = 'seg';
      for (const [v, text, ic] of f.options) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = same(v, value) ? 'on' : '';
        if (ic) b.innerHTML = icon(ic);
        b.append(text);
        b.addEventListener('click', () => {
          for (const x of seg.children) x.classList.remove('on');
          b.classList.add('on');
          save(v);
        });
        seg.appendChild(b);
      }
      return seg;
    }
    const input = document.createElement('input');
    input.value = value ?? '';
    input.addEventListener('change', () => save(input.value));
    return input;
  }

  function show(id) {
    const s = sections.find(x => x.id === id) || sections[0];
    if (!s) return;
    current = s.id;
    renderNav();
    content.innerHTML = '';
    const h = document.createElement('h3');
    h.textContent = s.title;
    content.appendChild(h);
    if (s.description) content.appendChild(Object.assign(document.createElement('p'), { className: 'settings-desc', textContent: s.description }));
    for (const f of s.fields) {
      const row = document.createElement('div');
      row.className = 'settings-row';
      row.dataset.key = f.key;
      const text = document.createElement('div');
      text.className = 'settings-label';
      text.textContent = f.label;
      if (f.hint) text.appendChild(Object.assign(document.createElement('small'), { textContent: f.hint }));
      row.append(text, fieldControl(f));
      content.appendChild(row);
    }
    if (s.render) { const box = document.createElement('div'); content.appendChild(box); s.render(box, { get, set, all }); }
    modal.querySelector('[data-reset]').hidden = !Object.keys(s.defaults || {}).length;
  }

  function open(id) {
    modal.hidden = false;
    show(id || current);
    modal.querySelector('.btn.primary').focus();
  }

  function close() {
    modal.hidden = true;
    if (typeof tabs !== 'undefined') tabs.get(activeId)?.term.focus();
  }

  modal.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', close));
  modal.addEventListener('mousedown', e => { if (e.target === modal) close(); });
  modal.querySelector('[data-reset]').addEventListener('click', async () => {
    const s = sections.find(x => x.id === current);
    if (!s) return;
    const ok = await askLocal({ kind: 'confirm', title: t('settings.resetQ'), message: t('settings.resetMsg', { section: s.title }), okLabel: t('common.reset'), danger: true });
    if (!ok) return;
    await set(Object.fromEntries(Object.keys(s.defaults || {}).map(k => [k, null])));
    show(s.id);
  });
  // Esc schließt – aber nicht, solange darüber eine Rückfrage offen ist
  document.addEventListener('keydown', e => {
    if (modal.hidden) return;
    if (e.key === 'Escape' && document.getElementById('ask-modal').hidden) { e.preventDefault(); e.stopPropagation(); close(); }
  }, true);
  // Cmd+, (Mac) bzw. Strg+, (Windows) öffnet die Einstellungen
  window.addEventListener('keydown', e => {
    if (e.key === ',' && (api.platform === 'darwin' ? e.metaKey : e.ctrlKey)) { e.preventDefault(); modal.hidden ? open() : close(); }
  }, true);

  // Zahnrad unten in der Seitenleiste
  let foot = document.getElementById('sidebar-foot');
  if (!foot) {
    foot = document.createElement('div');
    foot.id = 'sidebar-foot';
    document.getElementById('sidebar').appendChild(foot);
  }
  const gear = document.createElement('button');
  gear.id = 'open-settings';
  gear.className = 'foot-btn';
  gear.title = t('settings.titleShortcut', { key: api.platform === 'darwin' ? 'Cmd' : t('settings.keyCtrl') });
  gear.innerHTML = icon('gear');
  gear.append(t('settings.title'));
  gear.addEventListener('click', () => open());
  foot.appendChild(gear);

  // ---------- Allgemein ----------

  // Sprache: gilt nach dem Neuladen des Fensters (src/i18n.js liest sie beim Laden, lib/i18n.js im Hauptprozess sofort)
  const langNotice = document.createElement('div');
  langNotice.className = 'settings-lang-notice';
  langNotice.innerHTML = `<span>${t('settings.languageReloadHint')}</span>`;
  const reloadBtn = document.createElement('button');
  reloadBtn.type = 'button';
  reloadBtn.className = 'btn primary';
  reloadBtn.textContent = t('settings.languageReloadNow');
  reloadBtn.addEventListener('click', async () => {
    if (typeof tabs !== 'undefined' && tabs.size) {
      const ok = await askLocal({ kind: 'confirm', title: t('settings.languageReloadQ'), message: t('settings.languageReloadMsg'), okLabel: t('settings.languageReloadNow') });
      if (!ok) return;
    }
    try { window.SessionRestore?.save?.(); } catch {}
    api.reloadForLanguage();
  });
  langNotice.appendChild(reloadBtn);
  const updateLangNotice = () => { langNotice.hidden = (get('language') || 'system') === (I18N.pref || 'system'); };
  listeners.push((_v, changed) => { if (changed.includes('language')) updateLangNotice(); });

  registerSettingsSection({
    id: 'general', title: t('settings.general'), icon: 'sun', order: 0,
    defaults: { appearance: 'system', language: 'system' },
    fields: [
      { key: 'appearance', type: 'segment', label: t('settings.appearance'), hint: t('settings.appearanceHint'),
        options: [['system', t('settings.system')], ['light', t('settings.light')], ['dark', t('settings.dark')]] },
      { key: 'language', type: 'segment', label: t('settings.language'), hint: t('settings.languageHint'),
        // Sprachnamen immer in der eigenen Sprache
        options: [['system', t('settings.system')], ['de', 'Deutsch'], ['en', 'English']] },
    ],
    render(box) { updateLangNotice(); box.appendChild(langNotice); },
  });

  window.Settings = { ready, get, all, set, onChange: cb => listeners.push(cb), open, close, isOpen: () => !modal.hidden };
  window.registerSettingsSection = registerSettingsSection;
})();
