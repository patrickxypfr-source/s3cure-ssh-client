// FTP/FTPS in der Oberfläche: Protokoll im Verbindungs-Dialog, nur Dateiansicht für FTP-Tabs,
// Terminal-Umschalter ausgegraut, SSH-Funktionen (Tunnel, Befehle, Server-Übersicht, ZIP …) ausgeblendet.
// Wird nach renderer.js geladen. Nutzt aus renderer.js: hosts, tabs, activeId, $, flash, showError.
// Einhängepunkte: renderer.js (openTab, connect, setView, updateToolbar), hosts-extra.js (Dialog, Liste),
// files-extra.js (Rechtsklick-Menü).

const FtpUi = (() => {
  const PROTOCOLS = {
    sftp: { label: 'SFTP / SSH', port: 22 },
    ftp: { label: 'FTP', port: 21 },
    ftps: { label: 'FTPS (explizit)', port: 21 },
    'ftps-implicit': { label: 'FTPS (implizit)', port: 990 },
  };
  const SHORT = { ftp: 'FTP', ftps: 'FTPS', 'ftps-implicit': 'FTPS' };
  const isFtpProto = p => p === 'ftp' || p === 'ftps' || p === 'ftps-implicit';
  const URL_RE = /^(ftp|ftpes|ftps):\/\//i;

  const isFtpHost = name => !!(name && hosts[name] && isFtpProto(hosts[name].protocol));
  const isFtpSpec = spec => !!spec && (spec.name ? isFtpHost(spec.name) : URL_RE.test(spec.text || ''));
  const isFtpTab = tab => !!tab && (!!tab.info?.filesOnly || isFtpSpec(tab.spec));
  const protoOf = tab => tab.info?.protocol || (tab.spec.name ? hosts[tab.spec.name]?.protocol
    : { ftp: 'ftp', ftpes: 'ftps', ftps: 'ftps-implicit' }[(URL_RE.exec(tab.spec.text || '') || [])[1]?.toLowerCase()]);

  const NO_TERMINAL = 'FTP-Verbindungen haben kein Terminal – nur die Dateiansicht.';

  // ---------- Werkzeugleiste ----------

  function update(tab) {
    const ftp = isFtpTab(tab);
    document.body.classList.toggle('ftp-tab', ftp); // blendet Tunnel, Befehle, Server-Übersicht aus (ftp.css)
    const termBtn = $('#view-switch [data-view=terminal]');
    if (termBtn.dataset.title == null) termBtn.dataset.title = termBtn.title;
    termBtn.classList.toggle('ftp-off', ftp);
    termBtn.setAttribute('aria-disabled', ftp ? 'true' : 'false');
    termBtn.title = ftp ? NO_TERMINAL : termBtn.dataset.title;
    // auch das „⋯“-Menü (layout.js) richtet sich nach hidden
    const tunnelsBtn = $('#btn-tunnels');
    if (ftp) { tunnelsBtn.hidden = true; tunnelsBtn.dataset.ftpHidden = '1'; }
    else if (tunnelsBtn.dataset.ftpHidden) { tunnelsBtn.hidden = false; delete tunnelsBtn.dataset.ftpHidden; }
    if (!ftp || !tab) return;
    $('#btn-quick').hidden = true;
    const proto = protoOf(tab);
    if (tab.state === 'open' && tab.info) {
      $('#tab-status-text').textContent = `Verbunden mit ${tab.info.user}@${tab.info.host} · ${SHORT[proto] || 'FTP'}`
        + (proto === 'ftp' ? ' (unverschlüsselt)' : '');
    }
  }

  // Terminal-Ansicht für FTP verhindern (Umschalter, Schnellbefehle)
  function blockTerminal(tab) {
    if (!isFtpTab(tab)) return false;
    flash(NO_TERMINAL);
    return true;
  }

  // Bei FTP ist das Terminal unsichtbar – Fehler beim Verbinden deshalb als Dialog zeigen
  function connectFailed(tab, msg) {
    if (isFtpTab(tab) && !/abgebrochen/.test(msg)) showError(msg);
  }

  // ---------- Verbindungs-Dialog ----------

  let lastProto = 'sftp';

  function applyForm(form) {
    const proto = form.protocol.value;
    const ftp = isFtpProto(proto);
    $('#ftp-options').hidden = !ftp;
    $('#ftp-tls-options').hidden = !ftp || proto === 'ftp';
    $('#ftp-plain-note').hidden = proto !== 'ftp';
    $('#ftp-insecure-warn').hidden = !form.ftpInsecure.checked;
    for (const id of ['#key-field', '#jump-field']) { const el = $(id); if (el) el.hidden = ftp; }
    if (ftp) $('#setup-key').hidden = true;
    form.user.placeholder = ftp ? 'Benutzername vom Hoster' : 'pi';
  }

  function onProtocolChange(form) {
    const proto = form.protocol.value;
    // Port anpassen, solange er noch dem Standard des vorigen Protokolls entspricht
    const port = Number(form.port.value);
    if (!port || port === PROTOCOLS[lastProto].port) form.port.value = PROTOCOLS[proto].port;
    lastProto = proto;
    applyForm(form);
  }

  // Aufruf aus fillHostExtras (hosts-extra.js)
  function fillForm(form, h) {
    const proto = isFtpProto(h.protocol) ? h.protocol : 'sftp';
    form.protocol.value = proto;
    lastProto = proto;
    form.ftpPassive.checked = h.ftpPassive !== false;
    form.ftpInsecure.checked = h.ftpInsecure === true;
    if (!h.port) form.port.value = PROTOCOLS[proto].port;
    applyForm(form);
  }

  // Aufruf aus readHostExtras (hosts-extra.js)
  function readForm(form) {
    const proto = form.protocol.value;
    if (!isFtpProto(proto)) return { protocol: '' };
    return { protocol: proto, ftpPassive: form.ftpPassive.checked, ftpInsecure: proto !== 'ftp' && form.ftpInsecure.checked };
  }

  function setupForm() {
    const form = $('#host-form');
    if (!form || !form.protocol) return;
    form.protocol.addEventListener('change', () => onProtocolChange(form));
    form.ftpInsecure.addEventListener('change', () => applyForm(form));
  }
  setupForm();

  // ---------- Verbindungsliste ----------

  // Kennzeichnung in der Liste (Aufruf aus decorateHostItem in hosts-extra.js)
  function decorateHost(li, name) {
    if (!isFtpHost(name)) return;
    const proto = hosts[name].protocol;
    const badge = document.createElement('span');
    badge.className = 'proto-badge' + (proto === 'ftp' ? ' plain' : '');
    badge.textContent = SHORT[proto];
    badge.title = PROTOCOLS[proto].label + (proto === 'ftp' ? ' – unverschlüsselt' : ' – verschlüsselt');
    li.querySelector('.host-name')?.appendChild(badge);
    const files = li.querySelector('[data-act=files]');
    if (files) files.title = `Dateien öffnen (${PROTOCOLS[proto].label})`;
    li.title = 'Doppelklick öffnet die Dateien';
  }

  return { isFtpHost, isFtpSpec, isFtpTab, update, blockTerminal, connectFailed, fillForm, readForm, decorateHost, NO_TERMINAL };
})();
window.FtpUi = FtpUi;
