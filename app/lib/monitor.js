// Server-Übersicht: CPU, RAM, Platte und Laufzeit über einen eigenen exec-Kanal
// (nichts wird in die Shell des Terminals getippt). Funktioniert auf Linux (/proc).
const { t } = require('./i18n');

const TIMEOUT = 8000;

// Ein Befehl, Abschnitte durch Markierungen getrennt. Fehlt etwas, bleibt der Abschnitt leer.
const COMMAND = [
  'echo @@load', 'cat /proc/loadavg',
  'echo @@stat', 'head -n 1 /proc/stat',
  'echo @@cpus', 'nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo',
  'echo @@mem', 'cat /proc/meminfo',
  'echo @@df', 'df -Pk / | tail -n 1',
  'echo @@up', 'cat /proc/uptime',
  'echo @@host', 'hostname 2>/dev/null; uname -sr 2>/dev/null',
].map(c => `{ ${c}; } 2>/dev/null`).join('; ');

function sections(text) {
  const out = {};
  let cur = null;
  for (const line of text.split('\n')) {
    const m = /^@@(\w+)$/.exec(line.trim());
    if (m) { cur = m[1]; out[cur] = []; } else if (cur && line.trim()) out[cur].push(line.trim());
  }
  return out;
}

const num = v => { if (v == null || String(v).trim() === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };

// Rohtext -> Werte. prev: letzte CPU-Zähler (für die Auslastung seit der letzten Abfrage)
function parse(text, prev) {
  const s = sections(text);
  const r = {};

  const load = (s.load || [])[0];
  if (load) {
    const [a, b, c] = load.split(/\s+/).map(num);
    if (a != null) r.load = [a, b, c];
  }
  const cpus = num((s.cpus || [])[0]);
  if (cpus && cpus > 0) r.cpus = cpus;

  const stat = (s.stat || [])[0];
  if (stat && /^cpu\s/.test(stat)) {
    const f = stat.split(/\s+/).slice(1).map(Number).filter(Number.isFinite);
    if (f.length >= 4) {
      const idle = f[3] + (f[4] || 0); // idle + iowait
      const total = f.slice(0, 8).reduce((x, y) => x + y, 0);
      r.cpuTicks = { idle, total };
      if (prev && total > prev.total) r.cpu = Math.max(0, Math.min(100, 100 * (1 - (idle - prev.idle) / (total - prev.total))));
    }
  }
  // Ohne Vergleichswert: Last im Verhältnis zu den Kernen als Näherung
  if (r.cpu == null && r.load && r.cpus) r.cpuApprox = Math.min(100, 100 * r.load[0] / r.cpus);

  const mem = {};
  for (const line of s.mem || []) {
    const m = /^(\w+):\s+(\d+)/.exec(line);
    if (m) mem[m[1]] = Number(m[2]) * 1024;
  }
  if (mem.MemTotal) {
    const avail = mem.MemAvailable != null ? mem.MemAvailable : (mem.MemFree || 0) + (mem.Buffers || 0) + (mem.Cached || 0);
    r.mem = { total: mem.MemTotal, used: Math.max(0, mem.MemTotal - avail), available: avail };
    if (mem.SwapTotal) r.swap = { total: mem.SwapTotal, used: Math.max(0, mem.SwapTotal - (mem.SwapFree || 0)) };
  }

  const df = (s.df || [])[0];
  if (df) {
    const p = df.split(/\s+/);
    // Dateisystem 1K-Blöcke Benutzt Verfügbar Kapazität Eingehängt
    const [total, used, free] = [num(p[1]), num(p[2]), num(p[3])];
    if (total) r.disk = { total: total * 1024, used: used * 1024, free: free * 1024, fs: p[0], mount: p.slice(5).join(' ') || '/' };
  }

  const up = num(((s.up || [])[0] || '').split(/\s+/)[0]);
  if (up != null) r.uptime = up;

  const host = s.host || [];
  if (host[0]) r.hostname = host[0];
  if (host[1]) r.system = host[1];

  r.ok = r.load != null || r.mem != null || r.disk != null || r.uptime != null;
  return r;
}

function run(client, cmd) {
  return new Promise((resolve, reject) => {
    client.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let out = '';
      const timer = setTimeout(() => { try { stream.close(); } catch {} reject(new Error(t('monitor.timeout'))); }, TIMEOUT);
      stream.on('data', d => { if (out.length < 200000) out += d.toString('utf8'); });
      stream.stderr.on('data', () => {});
      stream.on('close', () => { clearTimeout(timer); resolve(out); });
    });
  });
}

// sessions: Map Tab-ID -> { client }. Letzte CPU-Zähler hängen an der Sitzung (verschwinden mit ihr).
function register(ipcMain, sessions) {
  const last = new WeakMap();
  const busy = new WeakSet();
  ipcMain.handle('monitor:stats', async (_e, tabId) => {
    const s = sessions.get(tabId);
    if (!s || !s.client) return null;
    if (busy.has(s)) return { ok: true, busy: true };
    busy.add(s);
    try {
      const r = parse(await run(s.client, COMMAND), last.get(s));
      if (r.cpuTicks) last.set(s, r.cpuTicks);
      delete r.cpuTicks;
      r.at = Date.now();
      return r;
    } catch {
      return { ok: false };
    } finally {
      busy.delete(s);
    }
  });
}

module.exports = { register, parse, COMMAND };
