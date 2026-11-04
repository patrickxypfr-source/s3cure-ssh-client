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
