// Reine Vergleichslogik für „Ordner synchronisieren“ und „Server-Ordner aktuell halten“
// (ohne Dateizugriff, damit sie sich leicht testen lässt). Benutzt von lib/sync.js.

// Standard-Ausschlüsse: werden nie verglichen oder übertragen
const DEFAULT_EXCLUDES = ['node_modules', '.git', '.DS_Store', 'Thumbs.db', 'desktop.ini'];
// Zeitunterschied, der noch als „gleich“ gilt (Server speichern nur ganze Sekunden, FAT 2 s)
const TIME_TOLERANCE = 2000;

// Text oder Liste -> saubere Musterliste (Komma, Strichpunkt oder Zeilenumbruch trennt)
function parsePatterns(input) {
  const list = Array.isArray(input) ? input : String(input || '').split(/[\n,;]+/);
  return [...new Set(list.map(s => String(s).trim()).filter(Boolean))].slice(0, 200);
}

function globToRegex(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/') i++; }
      else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$', 'i');
}

// Muster wie bei .gitignore (vereinfacht):
//   name         passt auf jede Datei/jeden Ordner mit diesem Namen (auch *.log)
//   ordner/      nur Ordner
//   pfad/datei   relativer Pfad ab dem gewählten Ordner (auch mit * und **)
function makeMatcher(patterns) {
  const rules = parsePatterns(patterns).map(raw => {
    let p = raw.replace(/\\/g, '/');
    const dirOnly = p.endsWith('/');
    p = p.replace(/^\/+|\/+$/g, '');
    if (!p) return null;
    return { dirOnly, byPath: p.includes('/'), re: globToRegex(p) };
  }).filter(Boolean);
  return (rel, isDir) => {
    const name = rel.slice(rel.lastIndexOf('/') + 1);
    for (const r of rules) {
      if (r.dirOnly && !isDir) continue;
      if (r.re.test(r.byPath ? rel : name)) return true;
    }
    return false;
  };
}

// Ist rel ein sicherer relativer Pfad (Teile mit /, kein .. und nichts Leeres)?
function safeRel(rel) {
  if (typeof rel !== 'string' || !rel || rel.length > 4096 || rel.includes('\0')) return false;
  return rel.split('/').every(part => part && part !== '.' && part !== '..');
}

// local/remote: Map rel -> { isDir, size, mtime (ms) }
// hashes (optional): Map rel -> { local, remote } Prüfsummen für Dateien mit gleicher Größe
// Liefert { items, same, ... } – items mit status:
//   onlyLocal | onlyRemote | localNewer | remoteNewer | differ (gleiche Zeit, anderer Inhalt) | typeClash
function compareTrees(local, remote, hashes = null) {
  const items = [];
  let same = 0;
  const keys = [...new Set([...local.keys(), ...remote.keys()])].sort();
  const covered = new Set(); // Ordner, die nur auf einer Seite liegen -> Inhalt nicht einzeln zeigen
  const isCovered = rel => {
    for (let i = rel.indexOf('/'); i >= 0; i = rel.indexOf('/', i + 1)) if (covered.has(rel.slice(0, i))) return true;
    return false;
  };

  for (const rel of keys) {
    if (covered.size && isCovered(rel)) continue;
    const l = local.get(rel), r = remote.get(rel);
    if (l && !r) {
      if (l.isDir) { covered.add(rel); items.push({ rel, status: 'onlyLocal', isDir: true, ...summarize(local, rel), local: l }); }
      else items.push({ rel, status: 'onlyLocal', isDir: false, size: l.size, local: l });
      continue;
    }
    if (r && !l) {
      if (r.isDir) { covered.add(rel); items.push({ rel, status: 'onlyRemote', isDir: true, ...summarize(remote, rel), remote: r }); }
      else items.push({ rel, status: 'onlyRemote', isDir: false, size: r.size, remote: r });
      continue;
    }
    if (l.isDir !== r.isDir) { items.push({ rel, status: 'typeClash', isDir: false, local: l, remote: r }); if (l.isDir || r.isDir) covered.add(rel); continue; }
    if (l.isDir) continue; // Ordner auf beiden Seiten: nur der Inhalt zählt
    const dt = l.mtime - r.mtime;
    const h = hashes && hashes.get(rel);
    const sameContent = h && h.local && h.remote ? h.local === h.remote : null;
    if (sameContent === true || (sameContent === null && l.size === r.size && Math.abs(dt) < TIME_TOLERANCE)) { same++; continue; }
    let status;
    if (Math.abs(dt) < TIME_TOLERANCE) status = 'differ';
    else status = dt > 0 ? 'localNewer' : 'remoteNewer';
    items.push({ rel, status, isDir: false, size: Math.max(l.size, r.size), local: l, remote: r });
  }
  return { items, same };
}

// Anzahl Dateien und Gesamtgröße unterhalb eines Ordners
function summarize(tree, dir) {
  let files = 0, size = 0;
  const prefix = dir + '/';
  for (const [rel, e] of tree) if (!e.isDir && rel.startsWith(prefix)) { files++; size += e.size; }
  return { files, size };
}

// Paare mit gleicher Größe auf beiden Seiten – nur diese brauchen eine Prüfsumme
function hashCandidates(local, remote) {
  const out = [];
  for (const [rel, l] of local) {
    const r = remote.get(rel);
    if (r && !l.isDir && !r.isDir && l.size === r.size) out.push(rel);
  }
  return out;
}

// Vorschlag, was mit einem Eintrag passieren soll.
// mode: 'up' (PC -> Server), 'down' (Server -> PC), 'both' (neuere gewinnt)
// del: Gelöschtes auch drüben löschen (nur bei 'up'/'down')
// Liefert { action: 'upload'|'download'|'deleteRemote'|'deleteLocal'|null, checked, warn }
function suggest(item, mode, del) {
  const s = item.status;
  if (s === 'typeClash') return { action: null, checked: false, warn: 'Auf einer Seite Datei, auf der anderen Ordner – bitte von Hand klären' };
  if (mode === 'up') {
    if (s === 'onlyLocal' || s === 'localNewer' || s === 'differ') return { action: 'upload', checked: true };
    if (s === 'remoteNewer') return { action: 'upload', checked: false, warn: 'Die Server-Datei ist neuer und würde überschrieben' };
    if (s === 'onlyRemote') return del ? { action: 'deleteRemote', checked: true } : { action: null, checked: false };
  }
  if (mode === 'down') {
    if (s === 'onlyRemote' || s === 'remoteNewer' || s === 'differ') return { action: 'download', checked: true };
    if (s === 'localNewer') return { action: 'download', checked: false, warn: 'Die Datei auf diesem Computer ist neuer und würde überschrieben' };
    if (s === 'onlyLocal') return del ? { action: 'deleteLocal', checked: true } : { action: null, checked: false };
  }
  if (mode === 'both') {
    if (s === 'onlyLocal' || s === 'localNewer') return { action: 'upload', checked: true };
    if (s === 'onlyRemote' || s === 'remoteNewer') return { action: 'download', checked: true };
    if (s === 'differ') return { action: 'upload', checked: false, warn: 'Gleiche Zeit, aber anderer Inhalt – bitte Richtung wählen' };
  }
  return { action: null, checked: false };
}

// Mögliche Aktionen für einen Eintrag (Auswahlfeld in der Liste)
function possibleActions(item) {
  switch (item.status) {
    case 'onlyLocal': return ['upload', 'deleteLocal'];
    case 'onlyRemote': return ['download', 'deleteRemote'];
    case 'localNewer': case 'remoteNewer': case 'differ': return ['upload', 'download'];
    default: return [];
  }
}

module.exports = {
  DEFAULT_EXCLUDES, TIME_TOLERANCE, parsePatterns, makeMatcher, globToRegex, safeRel,
  compareTrees, hashCandidates, suggest, possibleActions,
};
