// Zusatzfelder für gespeicherte Verbindungen: Gruppe, Farbe, Sprung-Server, Agent-Weiterleitung, Proxy, Protokoll,
// Zugangsdaten aus dem Tresor.
// Alte Einträge ohne diese Felder funktionieren unverändert.
const { hostProxyField } = require('./proxy');

const COLORS = ['red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink', 'gray'];

// Mitgeschickte, aber leere Felder kommen als undefined zurück, damit beim Speichern alte Werte
// wirklich verschwinden. Nicht mitgeschickte Felder bleiben unverändert.
function hostExtras(host) {
  const all = {};
  const group = String(host.group || '').trim();
  all.group = group ? group.slice(0, 60) : undefined;
  all.color = COLORS.includes(host.color) ? host.color : undefined;
  const jump = String(host.jump || '').trim();
  all.jump = jump || undefined;
  // Agent-Weiterleitung und Proxy: app/lib/connection.js, app/lib/proxy.js
  all.agentForward = host.agentForward === true ? true : undefined;
  all.proxy = hostProxyField(host.proxy);
  // Zugangsdaten aus dem Tresor (lib/vault.js): Kennung des Eintrags, leer = eigene
  all.credential = typeof host.credential === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(host.credential) ? host.credential : undefined;
  const out = {};
  for (const k of Object.keys(all)) if (k in host) out[k] = all[k];
  // Protokoll SFTP/FTP/FTPS (lib/ftp.js) – nur wenn mitgeschickt (Host-Dialog schickt es immer)
  if ('protocol' in host) Object.assign(out, protocolFields(host));
  return out;
}

// Protokoll: SFTP/SSH (Standard, kein Eintrag) oder FTP/FTPS (lib/ftp.js).
// Felder werden immer gesetzt (auch undefined), damit beim Zurückwechseln auf SFTP nichts Altes übrig bleibt.
function protocolFields(host) {
  const { PROTOCOLS } = require('./ftp');
  const proto = Object.prototype.hasOwnProperty.call(PROTOCOLS, host.protocol || '') ? host.protocol : undefined;
  const out = { protocol: proto, ftpPassive: undefined, ftpInsecure: undefined };
  if (!proto) return out;
  if (host.ftpPassive === false) out.ftpPassive = false;             // Standard: passiv
  if (proto !== 'ftp' && host.ftpInsecure === true) out.ftpInsecure = true; // Standard: Zertifikat prüfen
  if (!Number(host.port)) out.port = PROTOCOLS[proto].port;
  out.jump = undefined;          // Sprung-Server, Agent und Proxy gibt es nur bei SSH
  out.agentForward = undefined;
  return out;
}

// Wird eine Verbindung umbenannt oder gelöscht, Verweise als Sprung-Server anpassen
function updateJumpRefs(hosts, oldName, newName) {
  for (const h of Object.values(hosts)) {
    if (!h.jump) continue;
    const parts = h.jump.split(',').map(s => s.trim());
    if (!parts.includes(oldName)) continue;
    const next = parts.map(s => (s === oldName ? newName : s)).filter(Boolean);
    if (next.length) h.jump = next.join(','); else delete h.jump;
  }
}

module.exports = { hostExtras, updateJumpRefs, COLORS, protocolFields };
