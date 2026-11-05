// Gemeinsamer Dateizugriff für alle Datei-Funktionen (Liste, Editor, Übertragungen, Suche, „Mein Computer“).
// get(tabId) liefert für SSH-Tabs das SFTP-Objekt von ssh2, für FTP-Tabs den FTP-Adapter aus lib/ftp.js –
// beide haben dieselben Funktionen. main.js ruft getSftp(tabId) wie bisher auf.
const path = require('path');
const { t } = require('./i18n');
const { openFtp, parseFtpUrl, isFtpProtocol, createCertStore, PROTOCOLS } = require('./ftp');

function createFilesAdapter({ configDir, loadHosts, ask, passwords, sshSftp, vault }) {
  const ftpTabs = new Map();   // Tab-ID -> FTP-Adapter
  const caches = new Map();    // Tab-ID -> Passwörter im Arbeitsspeicher (Neu verbinden ohne Nachfragen)
  const certs = createCertStore(path.join(configDir, 'ftp_certs.json'));

  // Ist das eine FTP-Verbindung? spec: { name } (gespeichert) oder { text } (Schnellverbinden, ftp://…)
  function ftpTarget(spec) {
    if (!spec) return null;
    if (spec.name) {
      const h = loadHosts()[spec.name];
      return h && isFtpProtocol(h.protocol) ? h : null;
    }
    return parseFtpUrl(spec.text);
  }

  // Tresor-Eintrag (lib/vault.js): Benutzer und Passwort von dort. Ein abgelehntes Tresor-Passwort
  // wird nicht gelöscht; „Merken“ nach der Rückfrage speichert es im Eintrag (gilt für alle verknüpften Verbindungen).
  function withVault(target) {
    const linked = vault ? vault.resolve(target) : null;
    if (!linked) return { target, passwords };
    const { cred } = linked;
    return {
      target: linked.target,
      passwords: { read: () => cred.password(), write: (_name, v) => cred.setPassword(v), remove: () => {} },
    };
  }

  async function connect(tabId, spec) {
    const found = ftpTarget(spec);
    if (!found) throw new Error(t('files.noFtp'));
    const { target, passwords: pw } = withVault(found);
    close(tabId);
    if (!caches.has(tabId)) caches.set(tabId, new Map());
    const adapter = await openFtp(target, {
      ask, passwords: pw, certs, cache: caches.get(tabId), hostName: spec.name || null,
    });
    ftpTabs.set(tabId, adapter);
    return {
      user: target.user, host: target.host, port: target.port,
      protocol: target.protocol, protocolLabel: PROTOCOLS[target.protocol].label, filesOnly: true,
    };
  }

  function close(tabId) {
    const a = ftpTabs.get(tabId);
    if (a) { ftpTabs.delete(tabId); a.end(); }
  }

  return {
    isFtpSpec: spec => !!ftpTarget(spec),
    isFtp: tabId => ftpTabs.has(tabId),
    ftpTabIds: () => [...ftpTabs.keys()],
    connect,
    close,
    forget: tabId => caches.delete(tabId),
    // Dateizugriff für einen Tab (Promise, wie bisher getSftp)
    get(tabId) {
      const a = ftpTabs.get(tabId);
      return a ? Promise.resolve(a) : sshSftp(tabId);
    },
  };
}

module.exports = { createFilesAdapter };
