// Backup & Umzug und automatischer Abgleich über einen Cloud-Ordner – Bereich in den Einstellungen.
// Hauptprozess: app/lib/backup.js (Export/Import, Verschlüsselung) und app/lib/sync.js (Abgleich).
// Nutzt aus renderer.js: refreshHosts, askLocal, showError; aus quickbar.js: Quickbar.load; settings.js: Settings.
(() => {
  const B = window.s3backup;
  if (!B) return;
  const MIN_PW = 8;
  const cleanMsg = err => String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const PLATFORMS = { darwin: 'Mac', win32: 'Windows', linux: 'Linux' };
  const n = (count, one, many) => `${count} ${count === 1 ? one : many}`;

  // ---------- kleiner eigener Dialog ----------

  function dialog(html, cls = '') {
    const modal = document.createElement('div');
    modal.className = 'modal bk-modal';
    modal.innerHTML = `<form class="dialog ${cls}">${html}</form>`;
    document.body.appendChild(modal);
    const form = modal.querySelector('form');
    const close = () => modal.remove();
    modal.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } });
    form.querySelectorAll('[data-cancel-bk]').forEach(b => b.addEventListener('click', close));
    const err = form.querySelector('.bk-error');
    const setError = msg => { if (err) { err.textContent = msg || ''; err.hidden = !msg; } };
    const busy = on => form.querySelectorAll('button, input').forEach(el => { el.disabled = on; });
    return { modal, form, close, setError, busy, $: s => form.querySelector(s) };
  }

  const toggleHtml = (name, text, checked = false) =>
    `<label class="toggle"><input type="checkbox" name="${name}"${checked ? ' checked' : ''}><span class="track"><span class="knob"></span></span>${text}</label>`;

  function info(title, message, detail) {
    return askLocal({ kind: 'info', title, message, detail });
  }

  // Nach Änderungen an Verbindungen/Knöpfen die Oberfläche neu laden
  function reloadUi(what = {}) {
    if (what.hosts !== false) refreshHosts().catch(() => {});
    if (what.snippets !== false) window.Quickbar?.load(true);
  }

  // ---------- Export ----------

  function openExport() {
    const d = dialog(`
      <h2>Alles exportieren</h2>
      <p class="bk-text">Verbindungen, Befehlsknöpfe, Lesezeichen, Einstellungen und bekannte Server kommen in eine Datei –
        z. B. für einen neuen Computer. Die Datei wird mit einem Passwort verschlüsselt. Ohne dieses Passwort lässt sie sich
        nicht öffnen – gut merken!</p>
      ${toggleHtml('secrets', 'Gespeicherte Passwörter und Passphrasen mitnehmen')}
      <label>Passwort für das Backup <span class="muted">(mind. ${MIN_PW} Zeichen)</span><input name="pw" type="password" autocomplete="new-password"></label>
      <label>Passwort wiederholen<input name="pw2" type="password" autocomplete="new-password"></label>
      <p class="bk-error" hidden></p>
      <div class="actions">
        <button type="button" class="btn" data-cancel-bk>Abbrechen</button>
        <button type="submit" class="btn primary">Exportieren …</button>
      </div>`, 'bk-dialog');
    d.$('[name=pw]').focus();
    d.form.addEventListener('submit', async e => {
      e.preventDefault();
      const pw = d.$('[name=pw]').value;
      if (pw.length < MIN_PW) return d.setError(`Das Passwort muss mindestens ${MIN_PW} Zeichen haben.`);
      if (pw !== d.$('[name=pw2]').value) return d.setError('Die beiden Passwörter sind nicht gleich.');
      d.setError('');
      d.busy(true);
      try {
        const r = await B.exportAll({ password: pw, secrets: d.$('[name=secrets]').checked });
        if (!r) { d.busy(false); return; } // Speichern abgebrochen
        d.close();
        const lines = [n(r.hosts, 'Verbindung', 'Verbindungen')];
        if (d.$('[name=secrets]').checked) lines.push(n(r.passwords, 'Passwort', 'Passwörter/Passphrasen'));
        if (r.missing) lines.push(`${n(r.missing, 'gespeichertes Passwort', 'gespeicherte Passwörter')} nicht lesbar – fehlt im Backup`);
        info('Backup gespeichert', `${lines.join(', ')} – verschlüsselt gespeichert.`, r.file);
      } catch (err) { d.busy(false); d.setError(cleanMsg(err)); }
    });
  }

  // ---------- Import ----------

  async function openImport() {
    let picked;
    try { picked = await B.pick(); } catch (err) { showError(cleanMsg(err)); return; }
    if (!picked) return;
    const d = dialog(`
      <h2>Backup öffnen</h2>
      <p class="bk-text">Passwort für „<b class="bk-file"></b>“ eingeben.</p>
      <label>Passwort<input name="pw" type="password" autocomplete="current-password"></label>
      <p class="bk-error" hidden></p>
      <div class="actions">
        <button type="button" class="btn" data-cancel-bk>Abbrechen</button>
        <button type="submit" class="btn primary">Öffnen</button>
      </div>`, 'bk-dialog');
    d.$('.bk-file').textContent = picked.name;
    d.$('[name=pw]').focus();
    d.form.addEventListener('submit', async e => {
      e.preventDefault();
      d.setError('');
      d.busy(true);
      try {
        const r = await B.preview(picked.file, d.$('[name=pw]').value);
        d.close();
        showPreview(picked, r);
      } catch (err) {
        d.busy(false);
        d.setError(cleanMsg(err));
        d.$('[name=pw]').select();
      }
    });
  }

  const names = list => (list.length ? `<div class="bk-names">${list.slice(0, 8).map(n => `„${esc(n)}“`).join(', ')}${list.length > 8 ? ` und ${list.length - 8} weitere` : ''}</div>` : '');

  function diffRow(title, ic, diff) {
    const parts = [];
    if (diff.added.length) parts.push(`<b class="bk-new">${diff.added.length} neu</b>`);
    if (diff.changed.length) parts.push(`<b class="bk-chg">${diff.changed.length} anders als hier</b>`);
    if (diff.unchanged) parts.push(`${diff.unchanged} gleich`);
    if (!parts.length) parts.push('keine');
    return `<div class="bk-row">${icon(ic)}<div><div class="bk-row-t">${title}: ${parts.join(' · ')}</div>
      ${diff.added.length ? `<div class="bk-sub">Neu: ${names(diff.added)}</div>` : ''}
      ${diff.changed.length ? `<div class="bk-sub">Anders: ${names(diff.changed)}</div>` : ''}</div></div>`;
  }

  function showPreview(picked, { token, preview: p }) {
    const when = p.created ? new Date(p.created).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' }) : 'unbekannt';
    const from = PLATFORMS[p.platform] ? ` auf einem ${PLATFORMS[p.platform]}` : '';
    const removedAll = [...p.hosts.removed, ...p.snippets.removed.filter(n => !p.hosts.removed.includes(n))];
    const d = dialog(`
      <h2>Was wird importiert?</h2>
      <p class="bk-text">Backup vom ${esc(when)}${from}.</p>
      <div class="bk-rows">
        ${diffRow('Verbindungen', 'server', p.hosts)}
        ${diffRow('Befehlsknöpfe', 'bolt', p.snippets)}
        <div class="bk-row">${icon('shieldCheck')}<div><div class="bk-row-t">Bekannte Server: ${p.knownHosts.added ? `<b class="bk-new">${p.knownHosts.added} neu</b>` : 'nichts Neues'}</div></div></div>
        <div class="bk-row">${icon('sliders')}<div><div class="bk-row-t">Einstellungen: ${p.settings.changed ? `<b class="bk-chg">${p.settings.changed} anders als hier</b>` : 'gleich'}</div></div></div>
        ${p.bookmarks ? `<div class="bk-row">${icon('star')}<div><div class="bk-row-t">Lesezeichen: ${p.bookmarks.changed ? '<b class="bk-chg">anders als hier</b>' : 'gleich'}</div></div></div>` : ''}
        ${p.secrets ? `<div class="bk-row">${icon('lock')}<div><div class="bk-row-t">${n(p.secrets.passwords, 'Passwort', 'Passwörter')}, ${n(p.secrets.passphrases, 'Passphrase', 'Passphrasen')} im Backup</div>
          ${toggleHtml('secrets', 'Gespeicherte Passwörter übernehmen', true)}</div></div>` : ''}
      </div>
      <div class="seg bk-mode">
        <button type="button" data-mode="merge" class="on">Zusammenführen</button>
        <button type="button" data-mode="replace">Alles ersetzen</button>
      </div>
      <div class="bk-mode-merge">
        <p class="bk-text">Neues kommt dazu, alles andere hier bleibt erhalten.</p>
        ${toggleHtml('overwrite', 'Bei gleichem Namen die Version aus dem Backup nehmen', true)}
      </div>
      <div class="bk-mode-replace" hidden>
        <p class="bk-text bk-warn">Verbindungen und Befehlsknöpfe werden genau wie im Backup.
          ${removedAll.length ? `Dabei werden gelöscht: ${names(removedAll)}` : 'Hier wird dabei nichts gelöscht.'}</p>
      </div>
      <p class="bk-text bk-small">Vorher legt die App automatisch eine Sicherung des jetzigen Stands an.</p>
      <p class="bk-error" hidden></p>
      <div class="actions">
        <button type="button" class="btn" data-cancel-bk>Abbrechen</button>
        <button type="submit" class="btn primary">Importieren</button>
      </div>`, 'bk-dialog bk-preview');
    let mode = 'merge';
    for (const b of d.form.querySelectorAll('.bk-mode button')) {
      b.addEventListener('click', () => {
        mode = b.dataset.mode;
        for (const x of d.form.querySelectorAll('.bk-mode button')) x.classList.toggle('on', x === b);
        d.$('.bk-mode-merge').hidden = mode !== 'merge';
        d.$('.bk-mode-replace').hidden = mode !== 'replace';
        d.$('[type=submit]').className = 'btn ' + (mode === 'replace' ? 'danger' : 'primary');
      });
    }
    d.$('[type=submit]').focus();
    d.form.addEventListener('submit', async e => {
      e.preventDefault();
      if (mode === 'replace' && removedAll.length) {
        const ok = await askLocal({
          kind: 'confirm', title: 'Wirklich ersetzen?', danger: true, okLabel: 'Ersetzen',
          message: `${removedAll.length} Einträge, die nicht im Backup sind, werden gelöscht.`, detail: removedAll.join('\n'),
        });
        if (!ok) return;
      }
      d.busy(true);
      try {
        const r = await B.apply(token, {
          mode, overwrite: d.$('[name=overwrite]').checked, secrets: d.$('[name=secrets]') ? d.$('[name=secrets]').checked : false,
        });
        if (r.settings && Object.keys(r.settings).length) await Settings.set(r.settings);
        d.close();
        reloadUi();
        const msg = [];
        const h = r.hosts.added.length + (mode === 'merge' && !d.$('[name=overwrite]').checked ? 0 : r.hosts.changed.length);
        msg.push(`${n(h, 'Verbindung', 'Verbindungen')} übernommen`);
        if (r.knownHosts) msg.push(n(r.knownHosts, 'bekannter Server', 'bekannte Server'));
        if (r.secrets.saved) msg.push(n(r.secrets.saved, 'Passwort', 'Passwörter'));
        info('Import fertig', msg.join(', ') + '.', [...r.warnings, r.safetyCopy ? `Sicherung des vorherigen Stands:\n${r.safetyCopy}` : ''].filter(Boolean).join('\n\n'));
      } catch (err) { d.busy(false); d.setError(cleanMsg(err)); }
    });
  }

  // ---------- Abgleich über Cloud-Ordner ----------

  let syncState = null;
  let syncBox = null; // Anzeige im Einstellungsdialog (wenn offen)

  function openSyncSetup(onDone) {
    const d = dialog(`
      <h2>Abgleich einrichten</h2>
      <p class="bk-text">Wähle einen Ordner, den dein Cloud-Dienst abgleicht – z. B. iCloud Drive oder OneDrive.
        Dort legt die App eine verschlüsselte Datei ab. Auf dem anderen Computer denselben Ordner und dasselbe Passwort wählen.</p>
      <label>Ordner<div class="row"><input name="folder" class="grow" readonly placeholder="Noch kein Ordner gewählt"><button type="button" class="btn" data-pick>Wählen …</button></div></label>
      <p class="bk-text bk-small bk-folder-hint" hidden></p>
      <label>Passwort für die Abgleich-Datei<input name="pw" type="password" autocomplete="new-password"></label>
      <label class="bk-pw2">Passwort wiederholen<input name="pw2" type="password" autocomplete="new-password"></label>
      ${toggleHtml('secrets', 'Gespeicherte Passwörter mit abgleichen')}
      <p class="bk-error" hidden></p>
      <div class="actions">
        <button type="button" class="btn" data-cancel-bk>Abbrechen</button>
        <button type="submit" class="btn primary">Einschalten</button>
      </div>`, 'bk-dialog');
    let folder = null;
    let exists = false;
    d.$('[data-pick]').addEventListener('click', async () => {
      try {
        const r = await B.syncPickFolder();
        if (!r) return;
        folder = r.folder;
        exists = r.exists;
        d.$('[name=folder]').value = folder;
        d.$('[name=folder]').title = folder;
        const hint = d.$('.bk-folder-hint');
        hint.hidden = false;
        hint.textContent = exists
          ? 'Hier gibt es schon eine Abgleich-Datei. Gib das Passwort ein, das du auf dem anderen Computer gewählt hast.'
          : `Hier wird eine neue Abgleich-Datei angelegt. Wähle ein Passwort (mind. ${MIN_PW} Zeichen).`;
        d.$('.bk-pw2').hidden = exists;
        d.$('[name=pw]').focus();
      } catch (err) { d.setError(cleanMsg(err)); }
    });
    d.form.addEventListener('submit', async e => {
      e.preventDefault();
      const pw = d.$('[name=pw]').value;
      if (!folder) return d.setError('Bitte zuerst einen Ordner wählen.');
      if (!exists && pw.length < MIN_PW) return d.setError(`Das Passwort muss mindestens ${MIN_PW} Zeichen haben.`);
      if (!exists && pw !== d.$('[name=pw2]').value) return d.setError('Die beiden Passwörter sind nicht gleich.');
      d.setError('');
      d.busy(true);
      try {
        syncState = await B.syncEnable({ folder, password: pw, secrets: d.$('[name=secrets]').checked });
        d.close();
        onDone?.();
        if (syncState.lastError) showError(syncState.lastError);
      } catch (err) { d.busy(false); d.setError(cleanMsg(err)); }
    });
    d.$('[data-pick]').focus();
  }

  function timeText(iso) {
    const t = new Date(iso);
    const today = new Date().toDateString() === t.toDateString();
    return today ? 'heute ' + t.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) : t.toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });
  }

  function renderSync() {
    if (!syncBox || !syncBox.isConnected) { syncBox = null; return; }
    const st = syncState || {};
    const toggle = syncBox.querySelector('[name=sync-on]');
    toggle.checked = !!st.enabled;
    const details = syncBox.querySelector('.bk-sync-details');
    details.hidden = !st.enabled;
    if (!st.enabled) return;
    syncBox.querySelector('.bk-sync-folder').textContent = st.folder || '';
    syncBox.querySelector('.bk-sync-folder').title = st.folder || '';
    syncBox.querySelector('[name=sync-secrets]').checked = !!st.secrets;
    const line = syncBox.querySelector('.bk-sync-status');
    line.className = 'bk-sync-status';
    if (st.running) line.textContent = 'Gleiche ab …';
    else if (st.lastError) { line.textContent = st.lastError; line.classList.add('err'); }
    else if (st.waiting) line.textContent = st.waiting;
    else if (st.lastSync) {
      line.textContent = `Zuletzt abgeglichen: ${timeText(st.lastSync)}` + (st.applied ? ` · ${st.applied} Änderungen übernommen` : '');
      line.classList.add('ok');
    } else line.textContent = 'Noch nicht abgeglichen.';
    const conf = syncBox.querySelector('.bk-sync-conflicts');
    conf.hidden = !st.conflicts?.length || !!st.lastError;
    if (!conf.hidden) conf.textContent = `Auf beiden Computern geändert – jeweils die neuere Version übernommen: ${st.conflicts.join(', ')}.`;
  }

  function renderSection(box) {
    box.className = 'bk-section';
    box.innerHTML = `
      <div class="bk-block">
        <h4>Backup & Umzug</h4>
        <p class="settings-desc">Alle Verbindungen (mit Gruppen, Farben, Tunneln und Sprung-Servern), Befehlsknöpfe, Lesezeichen,
          Einstellungen und bekannten Server in einer verschlüsselten Datei – z. B. für einen neuen Computer.</p>
        <div class="bk-btns">
          <button type="button" class="btn" data-b="export">${icon('upload')}Alles exportieren …</button>
          <button type="button" class="btn" data-b="import">${icon('download')}Importieren …</button>
        </div>
      </div>
      <div class="bk-block bk-sync">
        <div class="settings-row">
          <div class="settings-label">Verbindungen über einen Cloud-Ordner abgleichen
            <small>Hält Verbindungen, Befehlsknöpfe und Lesezeichen auf mehreren Computern gleich – über iCloud Drive, OneDrive o. Ä.</small></div>
          ${toggleHtml('sync-on', '')}
        </div>
        <div class="bk-sync-details" hidden>
          <div class="bk-sync-where">${icon('cloud')}<span class="bk-sync-folder"></span></div>
          <div class="bk-sync-status"></div>
          <div class="bk-sync-conflicts" hidden></div>
          <div class="settings-row">
            <div class="settings-label">Gespeicherte Passwörter mit abgleichen<small>Liegen in der Datei nur verschlüsselt.</small></div>
            ${toggleHtml('sync-secrets', '')}
          </div>
          <div class="bk-btns">
            <button type="button" class="btn" data-b="sync-now">${icon('sync')}Jetzt abgleichen</button>
            <button type="button" class="btn ghost" data-b="sync-change">Ordner oder Passwort ändern …</button>
          </div>
        </div>
      </div>`;
    syncBox = box.querySelector('.bk-sync');
    box.querySelector('[data-b=export]').addEventListener('click', openExport);
    box.querySelector('[data-b=import]').addEventListener('click', openImport);
    const onToggle = box.querySelector('[name=sync-on]');
    onToggle.addEventListener('change', async () => {
      if (onToggle.checked) { onToggle.checked = false; openSyncSetup(renderSync); return; }
      onToggle.checked = true;
      const ok = await askLocal({ kind: 'confirm', title: 'Abgleich ausschalten?', message: 'Die Datei im Cloud-Ordner bleibt liegen. Deine Verbindungen hier bleiben, wie sie sind.', okLabel: 'Ausschalten' });
      if (!ok) return;
      try { syncState = await B.syncDisable(); } catch (err) { showError(cleanMsg(err)); }
      renderSync();
    });
    box.querySelector('[name=sync-secrets]').addEventListener('change', async e => {
      try { syncState = await B.syncSecrets(e.target.checked); } catch (err) { showError(cleanMsg(err)); }
      renderSync();
    });
    box.querySelector('[data-b=sync-now]').addEventListener('click', async () => {
      try { syncState = await B.syncNow(); } catch (err) { showError(cleanMsg(err)); }
      renderSync();
    });
    box.querySelector('[data-b=sync-change]').addEventListener('click', () => openSyncSetup(renderSync));
    B.syncStatus().then(st => { syncState = st; renderSync(); }).catch(() => {});
    renderSync();
  }

  B.onSyncStatus(st => { syncState = st; renderSync(); });
  // Der Abgleich hat Verbindungen oder Knöpfe geändert -> neu laden
  B.onChanged(what => reloadUi(what || {}));

  registerSettingsSection({
    id: 'backup', title: 'Backup', icon: 'cloud', order: 80,
    render: renderSection,
  });

  window.BackupUi = { openExport, openImport, openSyncSetup };
})();
