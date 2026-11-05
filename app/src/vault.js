// Tresor für Zugangsdaten – Bereich „Tresor“ in den Einstellungen (auch über „Schlüssel & Server“) und
// Feld „Zugangsdaten“ im Verbindungs-Dialog (über hostFormHooks aus hosts-extra.js).
// Hauptprozess: app/lib/vault.js (Brücke window.s3vault). Geheimnisse kommen nur auf ausdrücklichen Wunsch
// hierher („Anzeigen“, nach 10 s wieder ausgeblendet) oder direkt in die Zwischenablage („Kopieren“).
// Nutzt aus renderer.js: hosts, $, askLocal, showError, flash, refreshHosts, openMenu; settings.js: Settings.
(() => {
  const V = window.s3vault;
  if (!V) return;
  const REVEAL_MS = 10 * 1000;
  const GEN_KEY = 'vault:generator';

  Object.assign(ICON_PATHS, {
    vault: 'M4.5 4h15A1.5 1.5 0 0 1 21 5.5v12a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5v-12A1.5 1.5 0 0 1 4.5 4z M6 19v1.5 M18 19v1.5 M14 11.5a2.5 2.5 0 1 0-5 0 2.5 2.5 0 0 0 5 0z M11.5 9V7.5 M11.5 15.5V14 M17.5 9v5',
    eye: 'M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
    eyeOff: 'M3 3l18 18 M10.6 5.6A9.6 9.6 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a16 16 0 0 1-2.9 3.6 M6.6 6.6C3.9 8.3 2.5 12 2.5 12S6 18.5 12 18.5a9 9 0 0 0 4.4-1.1 M9.9 9.9a3 3 0 0 0 4.2 4.2',
    wand: 'M15 4V2 M15 10V8 M11 6h2 M17 6h2 M3 21l10-10 M18.5 3.5l-1 1 M18.5 8.5l-1-1',
  });
  if (!ICON_PATHS.copy) ICON_PATHS.copy = 'M9 9h10.5A1.5 1.5 0 0 1 21 10.5v9a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 9 19.5z M5 15H4.5A1.5 1.5 0 0 1 3 13.5v-9A1.5 1.5 0 0 1 4.5 3h9A1.5 1.5 0 0 1 15 4.5V5';
  if (!ICON_PATHS.key) ICON_PATHS.key = 'M15.5 3a5.5 5.5 0 0 0-5.24 7.18L3 17.44V21h3.56l.94-.94V18h2.06l1.5-1.5v-2.06l.76-.76A5.5 5.5 0 1 0 15.5 3z M16.5 6.5h.01';

  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const iconBtn = (name, title, onClick, cls = '') => {
    const b = el('button', 'mini-btn ' + cls);
    b.type = 'button';
    b.title = title;
    b.setAttribute('aria-label', title);
    b.innerHTML = icon(name);
    b.addEventListener('click', onClick);
    return b;
  };
  const textBtn = (text, onClick, cls = 'btn') => {
    const b = el('button', cls, text);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  };
  const cleanMsg = err => String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

  // ---------- Zustand ----------

  let state = { entries: [], requireUnlock: false, lockEnabled: false };
  const listeners = new Set();
  const byId = id => state.entries.find(e => e.id === id) || null;
  const setState = s => { state = s; for (const cb of listeners) { try { cb(); } catch (err) { console.error(err); } } };
  async function load() {
    try { setState(await V.list()); } catch (err) { console.error(err); }
    return state;
  }

  // ---------- Entsperren, Anzeigen, Kopieren ----------

  // Fragt nach App-Passwort bzw. Touch ID, wenn „Tresor nur nach Entsperren“ an ist
  async function unlock(touchId) {
    if (touchId && await V.unlock({ touchId: true }).catch(() => false)) return true;
    for (let i = 0; i < 3; i++) {
      const pw = await askLocal({
        kind: 'secret', title: t('vault.unlockTitle'),
        message: t(i ? 'vault.unlockWrong' : 'vault.unlockMsg'), okLabel: t('vault.unlockOk'),
      });
      if (pw == null) return false;
      if (await V.unlock({ password: pw }).catch(() => false)) return true;
    }
    return false;
  }
  async function gated(call) {
    let r = await call();
    if (r && r.needUnlock) {
      if (!await unlock(r.touchId)) return null;
      r = await call();
      if (r && r.needUnlock) return null;
    }
    return r;
  }
  async function copy(id, kind) {
    try {
      const r = await gated(() => V.copy(id, kind));
      if (r) flash(r.clearAfter ? t('vault.copiedClear', { seconds: r.clearAfter }) : t('vault.copied'));
    } catch (err) { showError(cleanMsg(err)); }
  }
  async function reveal(id, kind) {
    try {
      const r = await gated(() => V.reveal(id, kind));
      return r ? r.value : null;
    } catch (err) { showError(cleanMsg(err)); return null; }
  }

  // ---------- Passwort erzeugen ----------

  function genOptions() {
    try { const o = JSON.parse(localStorage.getItem(GEN_KEY) || '{}'); return { length: Number(o.length) || 24, symbols: o.symbols !== false }; } catch { return { length: 24, symbols: true }; }
  }
  const saveGenOptions = o => { try { localStorage.setItem(GEN_KEY, JSON.stringify(o)); } catch {} };

  // ---------- Eingabefeld für ein Geheimnis: Anzeigen (kurz), Kopieren, Entfernen ----------

  // opts: { entry, kind, placeholder, generator: true, autocomplete }
  function secretField({ entry, kind, generator = false }) {
    const saved = !!(entry && entry[{ password: 'hasPassword', passphrase: 'hasPassphrase' }[kind]]);
    const wrap = el('div', 'vault-secret');
    const row = el('div', 'row');
    const input = el('input', 'grow');
    Object.assign(input, { type: 'password', autocomplete: 'new-password', spellcheck: false });
    input.placeholder = saved ? t('vault.savedKeep') : kind === 'password' ? t('vault.passwordPh') : t('vault.passphrasePh');
    let cleared = false;
    let timer = null;
    let revealedValue = null;
    const hide = () => {
      clearTimeout(timer);
      timer = null;
      input.type = 'password';
      eye.innerHTML = icon('eye');
      // Nur Angezeigtes wieder wegnehmen – selbst Eingetipptes bleibt (verdeckt) stehen
      if (revealedValue != null && input.value === revealedValue) input.value = '';
      revealedValue = null;
    };
    const showFor = () => {
      input.type = 'text';
      eye.innerHTML = icon('eyeOff');
      clearTimeout(timer);
      timer = setTimeout(hide, REVEAL_MS);
    };
    const eye = iconBtn('eye', t('vault.reveal'), async () => {
      if (input.type === 'text') { hide(); return; }
      if (!input.value && saved && !cleared) {
        const v = await reveal(entry.id, kind);
        if (v == null) return;
        input.value = v;
        revealedValue = v;
      }
      if (input.value) showFor();
    });
    row.append(input, eye);
    if (saved) row.append(iconBtn('copy', t('vault.copy'), () => copy(entry.id, kind)));
    let gen = null;
    if (generator) {
      gen = el('div', 'vault-gen');
      gen.hidden = true;
      const o = genOptions();
      const len = el('input');
      Object.assign(len, { type: 'range', min: 8, max: 64, step: 1, value: o.length });
      const lenOut = el('span', 'vault-gen-len', String(o.length));
      const sym = el('label', 'toggle');
      sym.innerHTML = '<input type="checkbox"><span class="track"><span class="knob"></span></span>';
      sym.append(t('vault.genSymbols'));
      const symInput = sym.querySelector('input');
      symInput.checked = o.symbols;
      const lenLabel = el('span', 'vault-gen-label', t('vault.genLength'));
      gen.append(lenLabel, len, lenOut, sym, textBtn(t('vault.genAgain'), () => make()));
      const make = async () => {
        const opts = { length: Number(len.value), symbols: symInput.checked };
        saveGenOptions(opts);
        lenOut.textContent = String(opts.length);
        try { input.value = await V.generate(opts); } catch (err) { showError(cleanMsg(err)); return; }
        revealedValue = null; // neu erzeugt: bleibt beim Ausblenden stehen
        cleared = false;
        showFor();
      };
      len.addEventListener('input', () => { lenOut.textContent = len.value; });
      len.addEventListener('change', make);
      symInput.addEventListener('change', make);
      row.append(iconBtn('wand', t('vault.generate'), () => { gen.hidden = false; make(); }));
    }
    if (saved) {
      const del = textBtn(t('common.remove'), () => {
        cleared = true;
        input.value = '';
        input.placeholder = t('vault.removeOnSave');
        del.hidden = true;
      }, 'btn ghost vault-remove');
      row.append(del);
    }
    wrap.append(row);
    if (gen) wrap.append(gen);
    return {
      root: wrap, input,
      // undefined = unverändert, '' = entfernen, Text = neu
      value() {
        if (input.value && input.value !== revealedValue) return input.value;
        if (cleared) return '';
        return undefined;
      },
      dispose: () => clearTimeout(timer),
    };
  }

  // ---------- Eintrag anlegen / bearbeiten ----------

  function openEditor(entry = null, preset = {}) {
    return new Promise(resolve => {
      const modal = el('div', 'modal bk-modal vault-modal');
      const form = el('form', 'dialog vault-dialog');
      modal.appendChild(form);
      form.appendChild(el('h2', '', entry ? t('vault.editTitle') : t('vault.newTitle')));

      const field = (labelText, control, note) => {
        const l = el('label');
        l.append(labelText);
        if (note) { l.append(' '); l.append(el('span', 'muted', note)); }
        l.appendChild(control);
        return l;
      };
      const name = el('input');
      Object.assign(name, { required: true, autocomplete: 'off', placeholder: t('vault.namePh'), value: entry ? entry.name : preset.name || '' });
      const user = el('input');
      Object.assign(user, { autocomplete: 'off', spellcheck: false, placeholder: t('vault.userPh'), value: entry ? entry.user || '' : preset.user || '' });
      const pw = secretField({ entry, kind: 'password', generator: true });
      if (!entry && preset.password) pw.input.value = preset.password;

      // SSH-Schlüssel: keiner / Datei / im Tresor
      let mode = entry ? (entry.keyPath ? 'file' : entry.hasKey ? 'stored' : 'none') : 'none';
      const seg = el('div', 'seg vault-keymode');
      const modes = [['none', t('vault.keyNone')], ['file', t('vault.keyFile')], ['stored', t('vault.keyStored')]];
      for (const [v, text] of modes) {
        const b = textBtn(text, () => { mode = v; syncMode(); }, v === mode ? 'on' : '');
        b.dataset.mode = v;
        seg.appendChild(b);
      }
      const fileRow = el('div', 'row');
      const keyPath = el('input', 'grow');
      Object.assign(keyPath, { spellcheck: false, autocomplete: 'off', placeholder: '~/.ssh/id_ed25519', value: entry && entry.keyPath || '' });
      fileRow.append(keyPath, textBtn(t('common.choose'), async () => { const k = await api.pickKey(); if (k) keyPath.value = k; }));

      const storedBox = el('div', 'vault-stored');
      let replacing = !(entry && entry.hasKey);
      let keyFile = null;
      const keyText = el('textarea', 'vault-keytext');
      Object.assign(keyText, { spellcheck: false, rows: 4, placeholder: t('vault.keyPastePh') });
      const fromFile = el('p', 'vault-keyfile');
      let keyTimer = null;
      function renderStored() {
        storedBox.innerHTML = '';
        if (!replacing) {
          const info = el('div', 'vault-keyinfo');
          info.append(el('span', 'cp-badge', entry.keyType ? entry.keyType.replace(/^ssh-/, '') : t('vault.keyEncrypted')));
          if (entry.keyFingerprint) info.append(el('span', 'cp-fp', entry.keyFingerprint));
          const btns = el('div', 'cp-btns');
          if (entry.publicKey) btns.append(iconBtn('send', t('vault.copyPublic'), () => copy(entry.id, 'publicKey')));
          btns.append(
            iconBtn('copy', t('vault.copyPrivate'), () => copy(entry.id, 'key')),
            iconBtn('eye', t('vault.reveal'), async () => {
              const v = await reveal(entry.id, 'key');
              if (v == null) return;
              keyText.value = v;
              keyText.readOnly = true;
              storedBox.appendChild(keyText);
              clearTimeout(keyTimer);
              keyTimer = setTimeout(() => { keyText.value = ''; keyText.readOnly = false; keyText.remove(); }, REVEAL_MS);
            }),
            textBtn(t('vault.keyReplace'), () => { replacing = true; keyText.value = ''; keyText.readOnly = false; renderStored(); }, 'btn ghost'),
          );
          info.append(btns);
          storedBox.append(info);
          return;
        }
        clearTimeout(keyTimer);
        keyText.readOnly = false;
        if (keyFile) {
          fromFile.textContent = t('vault.keyFromFile', { file: keyFile });
          storedBox.append(fromFile, textBtn(t('vault.keyPasteInstead'), () => { keyFile = null; renderStored(); }, 'btn ghost'));
        } else {
          const r = el('div', 'vault-stored-btns');
          r.append(textBtn(t('vault.keyImport'), async () => { const k = await api.pickKey(); if (k) { keyFile = k; renderStored(); } }));
          if (entry && entry.hasKey) r.append(textBtn(t('common.cancel'), () => { replacing = false; keyFile = null; renderStored(); }, 'btn ghost'));
          storedBox.append(keyText, r);
        }
      }
      renderStored();
      const pass = secretField({ entry, kind: 'passphrase' });
      const keyLabel = el('div', 'vault-label', t('vault.key'));
      const passLabel = field(t('vault.passphrase'), pass.root, t('vault.passphraseNote'));
      function syncMode() {
        for (const b of seg.children) b.classList.toggle('on', b.dataset.mode === mode);
        fileRow.hidden = mode !== 'file';
        storedBox.hidden = mode !== 'stored';
        passLabel.hidden = mode === 'none';
        keyPath.required = mode === 'file';
      }

      const note = el('textarea', 'vault-note');
      Object.assign(note, { rows: 3, placeholder: t('vault.notePh'), value: entry ? entry.note || '' : '' });

      form.append(
        field(t('vault.name'), name),
        field(t('vault.user'), user, t('common.optional')),
        field(t('vault.password'), pw.root, t('common.optional')),
        keyLabel, seg, fileRow, storedBox, passLabel,
        field(t('vault.note'), note, t('common.optional')),
      );
      if (entry && entry.usedBy.length) form.append(el('p', 'vault-used', t('vault.usedByLong', { list: entry.usedBy.join(', ') })));
      const err = el('p', 'bk-error');
      err.hidden = true;
      const actions = el('div', 'actions');
      const save = el('button', 'btn primary', t('common.save'));
      save.type = 'submit';
      actions.append(textBtn(t('common.cancel'), () => close(null)), save);
      form.append(err, actions);
      syncMode();

      const close = result => {
        pw.dispose(); pass.dispose(); clearTimeout(keyTimer);
        keyText.value = '';
        modal.remove();
        resolve(result);
      };
      modal.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(null); } });
      form.addEventListener('submit', async e => {
        e.preventDefault();
        err.hidden = true;
        const input = {
          id: entry ? entry.id : undefined,
          name: name.value.trim(), user: user.value.trim(), note: note.value,
          keyMode: mode, keyPath: keyPath.value.trim(),
          password: pw.value(), passphrase: mode === 'none' ? undefined : pass.value(),
        };
        if (mode === 'stored' && replacing) {
          if (keyFile) input.keyFile = keyFile;
          else if (keyText.value.trim()) input.key = keyText.value;
        }
        save.disabled = true;
        try {
          const r = await V.save(input);
          setState(r);
          close(r.saved);
        } catch (ex) {
          save.disabled = false;
          err.textContent = cleanMsg(ex);
          err.hidden = false;
        }
      });
      document.body.appendChild(modal);
      name.focus();
    });
  }

  async function removeEntry(entry) {
    const ok = await askLocal({
      kind: 'confirm', title: t('vault.deleteTitle'), danger: true, okLabel: t('common.delete'),
      message: t('vault.deleteMsg', { name: entry.name }),
      detail: entry.usedBy.length ? t('vault.deleteUsed', { list: entry.usedBy.join('\n') }) : t('vault.deleteUnused'),
    });
    if (!ok) return;
    try {
      const r = await V.remove(entry.id);
      setState(r);
      if (r.unlinked.length) await refreshHosts();
      flash(t('vault.deleted', { name: entry.name }));
    } catch (err) { showError(cleanMsg(err)); }
  }

  async function editAndRefresh(entry, preset) {
    const saved = await openEditor(entry, preset);
    if (saved) { flash(t('vault.saved', { name: saved.name })); refreshHosts().catch(() => {}); }
    return saved;
  }

  // ---------- Bereich in den Einstellungen ----------

  function renderSection(box) {
    box.className = 'cp-pane vault-pane';
    const top = el('div', 'cp-top');
    const search = el('input', 'cp-search');
    search.placeholder = t('vault.search');
    search.spellcheck = false;
    const add = textBtn(t('vault.add'), () => editAndRefresh(null), 'btn primary');
    add.insertAdjacentHTML('afterbegin', icon('plus'));
    top.append(search, add);
    const list = el('ul', 'cp-list vault-list');

    // „Tresor nur nach Entsperren“
    const lockRow = el('div', 'settings-row vault-lock-row');
    const lockText = el('div', 'settings-label', t('vault.requireUnlock'));
    const lockHint = el('small');
    lockText.appendChild(lockHint);
    const lockToggle = el('label', 'toggle');
    lockToggle.innerHTML = '<input type="checkbox"><span class="track"><span class="knob"></span></span>';
    const lockInput = lockToggle.querySelector('input');
    lockRow.append(lockText, lockToggle);
    lockInput.addEventListener('change', async () => {
      const want = lockInput.checked;
      try {
        const r = await gated(() => V.setRequireUnlock(want));
        if (r) setState(r); else render();
      } catch (err) { showError(cleanMsg(err)); render(); }
    });
    const note = el('p', 'cp-note', t('vault.storageNote'));
    box.append(top, list, lockRow, note);

    function render() {
      if (!box.isConnected) { listeners.delete(render); return; }
      lockInput.checked = state.requireUnlock && state.lockEnabled;
      lockInput.disabled = !state.lockEnabled;
      lockHint.textContent = state.lockEnabled ? t('vault.requireUnlockHint') : t('vault.requireUnlockOff');
      const q = search.value.trim().toLowerCase();
      list.innerHTML = '';
      const shown = state.entries.filter(e => !q || [e.name, e.user || '', e.note || '', ...e.usedBy].some(s => s.toLowerCase().includes(q)));
      if (!shown.length) {
        list.appendChild(el('li', 'cp-empty', state.entries.length ? t('vault.noHits') : t('vault.empty')));
        return;
      }
      for (const e of shown) {
        const li = el('li', 'cp-item');
        const main = el('div', 'cp-main');
        const title = el('div', 'cp-title');
        title.append(el('span', 'cp-name', e.name));
        if (e.hasPassword) title.append(el('span', 'cp-badge', t('vault.badgePassword')));
        if (e.keyPath) title.append(el('span', 'cp-badge', t('vault.badgeKeyFile')));
        if (e.hasKey) title.append(el('span', 'cp-badge ok', t('vault.badgeKeyStored')));
        if (e.hasPassphrase) title.append(el('span', 'cp-badge', t('vault.badgePassphrase')));
        const meta = el('div', 'cp-meta', [e.user, e.usedBy.length ? t('vault.usedBy', { count: e.usedBy.length, list: e.usedBy.join(', ') }) : t('vault.unused')].filter(Boolean).join(' · '));
        meta.title = meta.textContent;
        main.append(title, meta);
        if (e.note) { const n = el('div', 'cp-meta vault-note-line', e.note.split('\n')[0]); n.title = e.note; main.append(n); }
        main.addEventListener('dblclick', () => editAndRefresh(byId(e.id)));
        const btns = el('div', 'cp-btns');
        if (e.user) btns.append(iconBtn('user', t('vault.copyUser'), async () => {
          try { await navigator.clipboard.writeText(e.user); flash(t('vault.copied')); } catch (err) { showError(err); }
        }));
        if (e.hasPassword) btns.append(iconBtn('copy', t('vault.copyPassword'), () => copy(e.id, 'password')));
        btns.append(
          iconBtn('edit', t('common.edit'), () => editAndRefresh(byId(e.id))),
          iconBtn('trash', t('common.delete'), () => removeEntry(byId(e.id)), 'danger'),
        );
        li.append(main, btns);
        list.appendChild(li);
      }
    }
    search.addEventListener('input', render);
    search.addEventListener('keydown', e => { if (e.key === 'Escape' && search.value) { e.stopPropagation(); search.value = ''; render(); } });
    listeners.add(render);
    render();
    load();
  }

  registerSettingsSection({
    id: 'vault', title: t('vault.title'), icon: 'vault', order: 59,
    description: t('vault.desc'),
    render: renderSection,
  });

  // Nach Backup-Import oder Abgleich neu laden
  window.s3backup?.onChanged(() => load());

  // ---------- Verbindungs-Dialog: „Zugangsdaten“ ----------

  const form = document.getElementById('host-form');
  if (form && typeof hostFormHooks !== 'undefined') {
    const userLabel = form.user.closest('label');
    const credLabel = el('label');
    credLabel.id = 'cred-field';
    credLabel.append(t('vault.hostField'));
    const sel = el('select');
    sel.name = 'credential';
    credLabel.appendChild(sel);
    const hint = el('p', 'vault-host-hint');
    hint.hidden = true;
    userLabel.before(credLabel, hint);
    // Felder, die bei einem Tresor-Eintrag nicht gelten (ausgeblendet über .cred-linked, vault.css)
    form.password.closest('label').classList.add('cred-own');
    document.getElementById('key-field')?.classList.add('cred-own');
    document.getElementById('setup-key')?.classList.add('cred-own');

    let ownUser = '';
    let lastValue = '';
    function options(selected) {
      sel.innerHTML = '';
      sel.appendChild(new Option(t('vault.hostOwn'), ''));
      for (const e of state.entries) sel.appendChild(new Option(e.user ? `${e.name} (${e.user})` : e.name, e.id));
      sel.appendChild(new Option(t('vault.hostNew'), '__new__'));
      sel.value = selected && byId(selected) ? selected : '';
      lastValue = sel.value;
    }
    function apply() {
      const e = byId(sel.value);
      form.classList.toggle('cred-linked', !!e);
      hint.hidden = !e;
      if (e) {
        const parts = [e.hasPassword && t('vault.badgePassword'), (e.keyPath || e.hasKey) && t('vault.badgeKey')].filter(Boolean);
        hint.textContent = t('vault.hostHint', { name: e.name, what: parts.length ? parts.join(', ') : t('vault.hostHintNothing') });
      }
      if (e && e.user) {
        if (!form.user.readOnly) ownUser = form.user.value;
        form.user.value = e.user;
        form.user.readOnly = true;
        form.user.title = t('vault.userFromEntry');
      } else if (form.user.readOnly) {
        form.user.readOnly = false;
        form.user.value = ownUser;
        form.user.title = '';
      }
    }
    sel.addEventListener('change', async () => {
      if (sel.value !== '__new__') { lastValue = sel.value; apply(); return; }
      sel.value = lastValue;
      const saved = await editAndRefresh(null, {
        name: form.label.value.trim(), user: form.user.readOnly ? '' : form.user.value.trim(), password: form.password.value,
      });
      if (!saved) return;
      options(saved.id);
      apply();
    });
    hostFormHooks.push({
      fill(_f, name) {
        const h = (name && hosts[name]) || {};
        form.user.readOnly = false;
        form.user.title = '';
        ownUser = form.user.value;
        options(h.credential);
        apply();
        // Liste kann veraltet sein (Abgleich, anderer Dialog) – nachladen und Auswahl behalten
        load().then(() => {
          if (document.getElementById('host-modal').hidden) return;
          const cur = sel.value || h.credential;
          options(cur);
          apply();
        });
      },
      read: () => ({ credential: byId(sel.value) ? sel.value : '' }),
    });
  }

  window.Vault = { load, open: () => Settings.open('vault'), edit: editAndRefresh, entries: () => state.entries };
  load();
})();
