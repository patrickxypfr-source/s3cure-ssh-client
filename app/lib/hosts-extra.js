// Zusatzfelder für gespeicherte Verbindungen: Gruppe, Farbe, Sprung-Server.
// Alte Einträge ohne diese Felder funktionieren unverändert.
const COLORS = ['red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink', 'gray'];

function hostExtras(host) {
  const out = {};
  const group = String(host.group || '').trim();
  if (group) out.group = group.slice(0, 60);
  if (COLORS.includes(host.color)) out.color = host.color;
  const jump = String(host.jump || '').trim();
  if (jump) out.jump = jump;
  Object.assign(out, protocolFields(host));
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
  out.jump = undefined; // Sprung-Server gibt es nur bei SSH
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
