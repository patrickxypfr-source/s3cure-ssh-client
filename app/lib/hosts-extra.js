// Zusatzfelder für gespeicherte Verbindungen: Gruppe, Farbe, Sprung-Server, Agent-Weiterleitung, Proxy.
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
  const out = {};
  for (const k of Object.keys(all)) if (k in host) out[k] = all[k];
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

module.exports = { hostExtras, updateJumpRefs, COLORS };
