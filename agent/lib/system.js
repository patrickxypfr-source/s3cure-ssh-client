// Den Server lesen und steuern: Messwerte (/proc), systemd-Dienste, Docker-Container, Logs, Neustart.
// Nie über eine Shell: execFile mit festem Programm und geprüften Namen – Text aus der App wird nie ausgeführt.
// S3CURE_AGENT_DEMO=1: Beispieldaten (zum Ausprobieren auf dem Mac und für Tests).
const fs = require('fs');
const os = require('os');
const { execFile, spawn } = require('child_process');

const UNIT_RE = /^[A-Za-z0-9][A-Za-z0-9@._:\\-]{0,250}\.(service|timer|socket)$/;
const CONTAINER_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const ACTIONS = ['start', 'stop', 'restart'];

function run(cmd, args, { timeout = 30000, maxBuffer = 8 * 1024 * 1024 } = {}) {
  return new Promise(resolve => {
    execFile(cmd, args, { timeout, maxBuffer, env: { ...process.env, LC_ALL: 'C', SYSTEMD_COLORS: '0', SYSTEMD_PAGER: '' } }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: String(stdout || ''), err: String(stderr || (err && err.message) || '') });
    });
  });
}

const has = cmd => ['/usr/bin/', '/bin/', '/usr/local/bin/', '/usr/sbin/', '/sbin/'].some(d => { try { fs.accessSync(d + cmd, fs.constants.X_OK); return true; } catch { return false; } });

// Platzhalter wie "systemd-*" in der Schutzliste
const matches = (name, patterns) => patterns.some(p => new RegExp('^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$').test(name));

// ---------- Messwerte ----------
function parseMeminfo(text) {
  const m = {};
  for (const line of text.split('\n')) { const r = /^(\w+):\s+(\d+)/.exec(line); if (r) m[r[1]] = Number(r[2]) * 1024; }
  const total = m.MemTotal || 0;
  const avail = m.MemAvailable != null ? m.MemAvailable : (m.MemFree || 0) + (m.Buffers || 0) + (m.Cached || 0);
  return { total, used: Math.max(0, total - avail), swapTotal: m.SwapTotal || 0, swapUsed: Math.max(0, (m.SwapTotal || 0) - (m.SwapFree || 0)) };
}

function parseCpu(line) {
  const f = line.trim().split(/\s+/).slice(1).map(Number);
  const idle = f[3] + (f[4] || 0);
  const total = f.slice(0, 8).reduce((a, b) => a + b, 0);
  return { idle, total };
}

function parseNet(text) {
  let rx = 0, tx = 0;
  for (const line of text.split('\n').slice(2)) {
    const [iface, rest] = line.split(':');
    if (!rest || /^\s*(lo|docker\d|veth|br-)/.test(iface)) continue;
    const f = rest.trim().split(/\s+/).map(Number);
    rx += f[0] || 0; tx += f[8] || 0;
  }
  return { rx, tx };
}

// systemctl list-units --plain --no-legend: UNIT LOAD ACTIVE SUB BESCHREIBUNG
function parseUnits(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const m = /^\s*●?\s*(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s*(.*)$/.exec(line);
    if (!m || !UNIT_RE.test(m[1]) || m[2] === 'not-found') continue;
    out.push({ name: m[1], load: m[2], active: m[3], sub: m[4], description: m[5].trim() });
  }
  return out;
}

function parseContainers(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const c = JSON.parse(line);
      out.push({ id: String(c.ID || '').slice(0, 12), name: String(c.Names || '').split(',')[0], image: c.Image || '', state: c.State || '', status: c.Status || '', ports: c.Ports || '' });
    } catch {}
  }
  return out;
}

function createSystem({ protect = [] } = {}) {
  let prevCpu = null, prevNet = null;

  async function metrics() {
    const read = f => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
    const r = { at: Date.now(), cpus: os.cpus().length || 1, hostname: os.hostname(), kernel: `${os.type()} ${os.release()}` };
    const load = read('/proc/loadavg').split(/\s+/).slice(0, 3).map(Number);
    r.load = load.length === 3 && load.every(Number.isFinite) ? load : os.loadavg();
    const stat = read('/proc/stat').split('\n')[0];
    if (/^cpu\s/.test(stat)) {
      const c = parseCpu(stat);
      if (prevCpu && c.total > prevCpu.total) r.cpu = Math.max(0, Math.min(100, 100 * (1 - (c.idle - prevCpu.idle) / (c.total - prevCpu.total))));
      prevCpu = c;
    }
    if (r.cpu == null) r.cpu = Math.min(100, 100 * r.load[0] / r.cpus);
    const mi = read('/proc/meminfo');
    r.mem = mi ? parseMeminfo(mi) : { total: os.totalmem(), used: os.totalmem() - os.freemem(), swapTotal: 0, swapUsed: 0 };
    try { const s = fs.statfsSync('/'); r.disk = { total: s.blocks * s.bsize, free: s.bavail * s.bsize, used: (s.blocks - s.bfree) * s.bsize }; } catch {}
    r.uptime = Number(read('/proc/uptime').split(/\s+/)[0]) || os.uptime();
    const net = read('/proc/net/dev');
    if (net) {
      const n = { ...parseNet(net), at: r.at };
      if (prevNet && n.at > prevNet.at) { const s = (n.at - prevNet.at) / 1000; r.net = { rx: Math.max(0, (n.rx - prevNet.rx) / s), tx: Math.max(0, (n.tx - prevNet.tx) / s) }; }
      prevNet = n;
    }
    const osr = read('/etc/os-release');
    r.os = (/^PRETTY_NAME="?([^"\n]+)"?/m.exec(osr) || [])[1] || os.type();
    return r;
  }

  async function services() {
    if (!has('systemctl')) return { available: false, list: [] };
    const r = await run('systemctl', ['list-units', '--type=service', '--all', '--no-pager', '--plain', '--no-legend']);
    return { available: true, list: parseUnits(r.out).map(s => ({ ...s, protected: matches(s.name, protect) })) };
  }

  async function serviceAction(name, action) {
    if (!UNIT_RE.test(name) || !ACTIONS.includes(action)) throw new Error('Ungültiger Dienst oder Aktion.');
    if (action === 'stop' && matches(name, protect)) throw new Error(`${name} ist geschützt und kann in der App nicht gestoppt werden.`);
    const r = await run('systemctl', [action, name], { timeout: 90000 });
    if (r.code !== 0) throw new Error(r.err.trim().split('\n').slice(-3).join('\n') || `systemctl ${action} fehlgeschlagen`);
    return true;
  }

  async function serviceLogs(name, lines = 200) {
    if (!UNIT_RE.test(name)) throw new Error('Ungültiger Dienst.');
    const r = await run('journalctl', ['-u', name, '-n', String(Math.min(2000, Math.max(10, lines | 0))), '--no-pager', '-o', 'short-iso']);
    return r.out;
  }

  async function containers() {
    if (!has('docker')) return { available: false, list: [] };
    const r = await run('docker', ['ps', '-a', '--format', '{{json .}}']);
    if (r.code !== 0) return { available: true, error: r.err.trim(), list: [] };
    return { available: true, list: parseContainers(r.out) };
  }

  async function containerAction(name, action) {
    if (!CONTAINER_RE.test(name) || !ACTIONS.includes(action)) throw new Error('Ungültiger Container oder Aktion.');
    const r = await run('docker', [action, name], { timeout: 90000 });
    if (r.code !== 0) throw new Error(r.err.trim() || `docker ${action} fehlgeschlagen`);
    return true;
  }

  async function containerLogs(name, lines = 200) {
    if (!CONTAINER_RE.test(name)) throw new Error('Ungültiger Container.');
    const r = await run('docker', ['logs', '--tail', String(Math.min(2000, Math.max(10, lines | 0))), '--timestamps', name]);
    return (r.out + r.err).split('\n').filter(Boolean).sort().join('\n');
  }

  // Live-Logs: ruft onLine pro Zeile auf, gibt eine Stopp-Funktion zurück
  function follow(kind, name, onLine) {
    let args, cmd;
    if (kind === 'service') { if (!UNIT_RE.test(name)) throw new Error('Ungültiger Dienst.'); cmd = 'journalctl'; args = ['-u', name, '-f', '-n', '50', '--no-pager', '-o', 'short-iso']; }
    else { if (!CONTAINER_RE.test(name)) throw new Error('Ungültiger Container.'); cmd = 'docker'; args = ['logs', '-f', '--tail', '50', '--timestamps', name]; }
    const p = spawn(cmd, args, { env: { ...process.env, LC_ALL: 'C', SYSTEMD_COLORS: '0' } });
    let buf = '';
    const onData = d => { buf += d.toString('utf8'); const parts = buf.split('\n'); buf = parts.pop(); for (const l of parts) onLine(l); };
    p.stdout.on('data', onData); p.stderr.on('data', onData);
    p.on('error', () => {});
    return () => { try { p.kill(); } catch {} };
  }

  // Neustart des ganzen Servers – kurz verzögert, damit die Antwort noch ankommt
  function reboot() { setTimeout(() => run('systemctl', ['reboot']), 3000); return true; }

  return { metrics, services, serviceAction, serviceLogs, containers, containerAction, containerLogs, follow, reboot };
}

// ---------- Beispieldaten ----------
function createDemo({ protect = [] } = {}) {
  const t0 = Date.now();
  const svc = [
    ['nginx.service', 'A high performance web server'], ['postgresql@15-main.service', 'PostgreSQL Cluster 15-main'],
    ['s3cure-panel.service', 'S3cure Panel (Next.js)'], ['s3cure-bot.service', 'S3cure Discord-Bot'], ['ssh.service', 'OpenBSD Secure Shell server'],
    ['fail2ban.service', 'Fail2Ban Service'], ['cron.service', 'Regular background program processing daemon'], ['backup-postgres.service', 'Nächtliches Postgres-Backup'],
    ['systemd-journald.service', 'Journal Service'], ['redis-server.service', 'Advanced key-value store'],
  ].map(([name, description]) => ({ name, description, load: 'loaded', active: 'active', sub: 'running' }));
  svc.find(s => s.name === 'backup-postgres.service').active = 'failed';
  svc.find(s => s.name === 'backup-postgres.service').sub = 'failed';
  svc.find(s => s.name === 'redis-server.service').active = 'inactive';
  svc.find(s => s.name === 'redis-server.service').sub = 'dead';
  const ctr = [
    { id: 'a1b2c3d4e5f6', name: 'umami', image: 'ghcr.io/umami-software/umami:postgresql-latest', state: 'running', status: 'Up 3 days', ports: '127.0.0.1:3001->3000/tcp' },
    { id: 'f6e5d4c3b2a1', name: 'uptime-kuma', image: 'louislam/uptime-kuma:1', state: 'exited', status: 'Exited (0) 2 hours ago', ports: '' },
  ];
  const wave = (p, a, b) => a + (b - a) * (0.5 + 0.5 * Math.sin((Date.now() - t0) / p));
  const logLine = (name, i) => `${new Date(Date.now() - (50 - i) * 7000).toISOString().slice(0, 19)}+0000 s3cure ${name.replace(/\.service$/, '')}[${1000 + i}]: ${['GET /api/health 200 4ms', 'Neue Anmeldung von 203.0.113.' + (i % 250), 'Cache aktualisiert', 'WARN: langsame Abfrage (812 ms)', 'Job erledigt'][i % 5]}`;
  return {
    async metrics() {
      return {
        at: Date.now(), cpus: 4, hostname: 's3cure', kernel: 'Linux 6.1.0-26-amd64', os: 'Debian GNU/Linux 12 (bookworm)',
        load: [wave(9000, 0.1, 1.4), wave(20000, 0.2, 1.0), 0.6], cpu: wave(7000, 3, 46),
        mem: { total: 18 * 2 ** 30, used: wave(30000, 1.6, 2.6) * 2 ** 30, swapTotal: 2 ** 30, swapUsed: 0 },
        disk: { total: 79 * 2 ** 30, free: 67 * 2 ** 30, used: 12 * 2 ** 30 }, uptime: 79080 + (Date.now() - t0) / 1000,
        net: { rx: wave(5000, 2e4, 9e5), tx: wave(6000, 1e4, 3e5) },
      };
    },
    async services() { return { available: true, list: svc.map(s => ({ ...s, protected: matches(s.name, protect) })) }; },
    async serviceAction(name, action) {
      const s = svc.find(x => x.name === name);
      if (!s || !ACTIONS.includes(action)) throw new Error('Ungültiger Dienst oder Aktion.');
      if (action === 'stop' && matches(name, protect)) throw new Error(`${name} ist geschützt und kann in der App nicht gestoppt werden.`);
      await new Promise(r => setTimeout(r, 600));
      Object.assign(s, action === 'stop' ? { active: 'inactive', sub: 'dead' } : { active: 'active', sub: 'running' });
      return true;
    },
    async serviceLogs(name) { return Array.from({ length: 50 }, (_, i) => logLine(name, i)).join('\n'); },
    async containers() { return { available: true, list: ctr.map(c => ({ ...c })) }; },
    async containerAction(name, action) {
      const c = ctr.find(x => x.name === name);
      if (!c) throw new Error('Ungültiger Container.');
      await new Promise(r => setTimeout(r, 600));
      Object.assign(c, action === 'stop' ? { state: 'exited', status: 'Exited (0) gerade eben' } : { state: 'running', status: 'Up 1 second' });
      return true;
    },
    async containerLogs(name) { return Array.from({ length: 40 }, (_, i) => logLine(name, i)).join('\n'); },
    follow(kind, name, onLine) { let i = 0; const t = setInterval(() => onLine(logLine(name, 50 + i++).replace(/^\S+/, new Date().toISOString().slice(0, 19) + '+0000')), 1500); return () => clearInterval(t); },
    reboot() { return true; },
  };
}

module.exports = { createSystem, createDemo, parseUnits, parseContainers, parseMeminfo, parseNet, matches, UNIT_RE, CONTAINER_RE };
