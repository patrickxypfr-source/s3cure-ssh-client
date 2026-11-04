// Besitzer und Gruppe für die Server-Dateiliste (Spalten „Besitzer“/„Gruppe“ in src/file-columns.js)
// SFTP liefert nur Zahlen (UID/GID). Die Namen werden einmal pro Verbindung aufgelöst:
//   1. `getent passwd` / `getent group` (bzw. /etc/passwd, /etc/group) auf dem Server
//   2. sonst aus der „longname“-Zeile von readdir (wie `ls -l`, liefert OpenSSH mit)
//   3. sonst bleibt die Zahl stehen.

const SCRIPT = '(getent passwd 2>/dev/null || cat /etc/passwd 2>/dev/null); echo "--S3CURE--"; (getent group 2>/dev/null || cat /etc/group 2>/dev/null)';
const MAX_BYTES = 4 * 1024 * 1024;

function run(client, cmd, timeout = 5000) {
  return new Promise(resolve => {
    let out = '';
    let done = false;
    const finish = v => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
    const timer = setTimeout(() => finish(null), timeout);
    try {
      client.exec(cmd, (err, stream) => {
        if (err) return finish(null);
        stream.on('data', d => { out += d; if (out.length > MAX_BYTES) { stream.close(); finish(null); } });
        stream.stderr.on('data', () => {});
        stream.on('close', () => finish(out));
      });
    } catch { finish(null); }
  });
}

// „name:x:1000:…“ -> Map(1000 -> name)
function parseTable(text) {
  const map = new Map();
  for (const line of text.split('\n')) {
    const parts = line.split(':');
    if (parts.length < 3) continue;
    const id = Number(parts[2]);
    if (Number.isInteger(id) && !map.has(id)) map.set(id, parts[0]);
  }
  return map;
}

async function resolveNames(session) {
  if (!session) return { users: new Map(), groups: new Map() };
  if (!session.ownerNames) {
    session.ownerNames = run(session.client, SCRIPT).then(text => {
      if (!text) return { users: new Map(), groups: new Map() };
      const [u, g = ''] = text.split('--S3CURE--');
      return { users: parseTable(u), groups: parseTable(g) };
    });
  }
  return session.ownerNames;
}

// „-rw-r--r--  1 tester  tester  220 Mar 31 2024 .bashrc“ -> { owner, group }
function fromLongname(longname) {
  const parts = String(longname || '').trim().split(/\s+/);
  if (parts.length < 5 || !/^[-dlcbps]/.test(parts[0])) return {};
  return { owner: parts[2], group: parts[3] };
}

// entries: [{ uid, gid, longname }] – ergänzt owner/group und entfernt longname
async function annotate(session, entries) {
  let names = { users: new Map(), groups: new Map() };
  try { names = await resolveNames(session); } catch {}
  for (const e of entries) {
    const ln = fromLongname(e.longname);
    const num = v => (v == null ? '' : String(v));
    e.owner = names.users.get(e.uid) ?? (ln.owner && ln.owner !== num(e.uid) ? ln.owner : null) ?? num(e.uid);
    e.group = names.groups.get(e.gid) ?? (ln.group && ln.group !== num(e.gid) ? ln.group : null) ?? num(e.gid);
    delete e.longname;
  }
  return entries;
}

module.exports = { annotate, parseTable, fromLongname };
