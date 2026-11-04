// Verbindungen aus ~/.ssh/config übernehmen (HostName, User, Port, IdentityFile, ProxyJump).
// Wie OpenSSH: Für jeden Namen gelten alle passenden Host-Blöcke, der erste Wert gewinnt.
const fs = require('fs');
const path = require('path');
const os = require('os');

const WANTED = ['hostname', 'user', 'port', 'identityfile', 'proxyjump'];

function unquote(v) {
  return v.length > 1 && v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1) : v;
}

function splitArgs(v) {
  return (v.match(/"[^"]*"|\S+/g) || []).map(unquote);
}

function globToRegex(glob) {
  const re = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${re}$`, 'i');
}

const homify = p => p.replace(/^~(?=$|[\\/])/, os.homedir());

// Include-Dateien: relative Pfade zählen ab ~/.ssh, * und ? im Dateinamen sind erlaubt
function expandInclude(pattern, baseDir) {
  let p = homify(pattern);
  if (!path.isAbsolute(p)) p = path.join(baseDir, p);
  const dir = path.dirname(p);
  const name = path.basename(p);
  if (!/[*?]/.test(name)) return [p];
  try {
    const re = globToRegex(name);
    return fs.readdirSync(dir).filter(f => re.test(f)).sort().map(f => path.join(dir, f));
  } catch { return []; }
}

// Liefert Blöcke [{ patterns, options: { key: [werte] } }] in Dateireihenfolge
function parseConfig(text, baseDir, depth = 0, blocks = [{ patterns: ['*'], options: {} }]) {
  let current = blocks[blocks.length - 1];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(\S+?)(?:\s*=\s*|\s+)(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === 'host') {
      current = { patterns: splitArgs(value), options: {} };
      blocks.push(current);
    } else if (key === 'match') {
      current = { patterns: [], options: {} }; // Match-Blöcke werden nicht ausgewertet
      blocks.push(current);
    } else if (key === 'include') {
      if (depth > 8) continue;
      for (const pat of splitArgs(value)) {
        for (const file of expandInclude(pat, baseDir)) {
          let inc;
          try { inc = fs.readFileSync(file, 'utf8'); } catch { continue; }
          parseConfig(inc, baseDir, depth + 1, blocks);
        }
      }
      // Nach einem Include gilt wieder der Block, in dem das Include stand
      blocks.push({ patterns: current.patterns, options: current.options });
      current = blocks[blocks.length - 1];
    } else if (WANTED.includes(key)) {
      (current.options[key] ||= []).push(unquote(value));
    }
  }
  return blocks;
}

function blockMatches(patterns, alias) {
  let hit = false;
  for (const p of patterns) {
    if (p.startsWith('!')) { if (globToRegex(p.slice(1)).test(alias)) return false; }
    else if (globToRegex(p).test(alias)) hit = true;
  }
  return hit;
}

function resolveAlias(blocks, alias) {
  const out = {};
  for (const b of blocks) {
    if (!blockMatches(b.patterns, alias)) continue;
    for (const [k, vals] of Object.entries(b.options)) if (!(k in out)) out[k] = vals[0];
  }
  return out;
}

// Platzhalter wie OpenSSH (%h, %r, %u, %d, %%)
function tokens(value, ctx) {
  return value.replace(/%([hrud%])/g, (_, t) => ({ h: ctx.host, r: ctx.user, u: os.userInfo().username, d: os.homedir(), '%': '%' })[t]);
}

// Alle konkreten Host-Namen (ohne * ? !) mit ihren Einstellungen
function readSshConfig(file = path.join(os.homedir(), '.ssh', 'config')) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const blocks = parseConfig(text, path.dirname(file));
  const aliases = [];
  for (const b of blocks) for (const p of b.patterns) {
    if (!/[*?!]/.test(p) && !aliases.includes(p)) aliases.push(p);
  }
  return aliases.map(alias => {
    const o = resolveAlias(blocks, alias);
    const host = o.hostname ? tokens(o.hostname, { host: alias, user: '' }) : alias;
    const user = o.user || os.userInfo().username;
    let key = o.identityfile ? homify(tokens(o.identityfile, { host, user })) : null;
    if (key && !fs.existsSync(key)) key = null; // Datei fehlt -> Standard-Schlüssel bzw. Passwort
    if (key && key.startsWith(os.homedir())) key = '~' + key.slice(os.homedir().length);
    const jump = o.proxyjump && o.proxyjump.toLowerCase() !== 'none' ? o.proxyjump : null;
    return { name: alias, user, host, port: Number(o.port) || 22, key, jump };
  });
}

// Plan: was neu übernommen wird und was übersprungen wird (Name oder Adresse gibt es schon)
function planImport(entries, hosts) {
  const add = [];
  const skip = [];
  const sameAddr = (a, b) => a.host === b.host && a.user === b.user && Number(a.port) === Number(b.port);
  const rename = {}; // Alias aus der config -> Name in der App (für ProxyJump)
  for (const e of entries) {
    const existing = Object.keys(hosts).find(n => sameAddr(hosts[n], e));
    if (existing) { skip.push({ name: e.name, reason: `gibt es schon als „${existing}“` }); rename[e.name] = existing; continue; }
    if (hosts[e.name]) { skip.push({ name: e.name, reason: 'Name schon vergeben' }); continue; }
    add.push(e);
  }
  for (const e of add) {
    if (e.jump) e.jump = e.jump.split(',').map(s => rename[s.trim()] || s.trim()).join(',');
  }
  return { add, skip };
}

function register(ipcMain, { loadHosts, saveHosts }) {
  const plan = () => {
    const entries = readSshConfig();
    if (!entries) throw new Error('Keine Datei ~/.ssh/config gefunden.');
    return planImport(entries, loadHosts());
  };
  ipcMain.handle('sshconfig:scan', () => plan());
  ipcMain.handle('sshconfig:import', () => {
    const { add, skip } = plan();
    const hosts = loadHosts();
    for (const e of add) {
      hosts[e.name] = { user: e.user, host: e.host, port: e.port, key: e.key };
      if (e.jump) hosts[e.name].jump = e.jump;
    }
    saveHosts(hosts);
    return { added: add.map(e => e.name), skipped: skip };
  });
}

module.exports = { readSshConfig, planImport, parseConfig, register };
