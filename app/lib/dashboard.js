// Server-Übersicht („Übersicht“-Ansicht): Dienste (systemd), Docker-Container, System.
// Alles läuft über eigene exec-Kanäle der bestehenden Verbindung – nichts wird in die Shell getippt.
// sudo nur, wenn nötig und ohne Passwort möglich (sudo -n). Geht das nicht, bekommt die Oberfläche
// den passenden Befehl zurück, damit sie ihn im Terminal ausführen kann (dort fragt sudo nach dem Passwort).
const TIMEOUT = 15000;
const DU_TIMEOUT = 180000;
const MAX_OUT = 2 * 1024 * 1024;

const UNIT_RE = /^[A-Za-z0-9][A-Za-z0-9@._:\\-]{0,250}\.service$/;
const CONTAINER_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const ACTIONS = ['start', 'stop', 'restart'];

// Wert sicher in einfache Anführungszeichen für die Shell
const sq = v => `'${String(v).replace(/'/g, `'\\''`)}'`;

function exec(client, cmd, { timeout = TIMEOUT, onStream } = {}) {
  return new Promise((resolve, reject) => {
    client.exec(cmd, (err, stream) => {
      if (err) return reject(new Error('Befehl konnte nicht gestartet werden: ' + err.message));
      let out = '', errOut = '', done = false;
      const finish = (code, extra = {}) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ code, out, err: errOut, ...extra });
      };
      const timer = setTimeout(() => { try { stream.close(); } catch {} finish(null, { timeout: true }); }, timeout);
      if (onStream) onStream(stream, () => finish(null, { cancelled: true }));
      stream.on('data', d => { if (out.length < MAX_OUT) out += d.toString('utf8'); });
      stream.stderr.on('data', d => { if (errOut.length < 100000) errOut += d.toString('utf8'); });
      stream.on('exit', code => { stream._code = code; });
      stream.on('close', code => finish(code ?? stream._code ?? null));
    });
  });
}

function sections(text) {
  const out = {};
  let cur = null;
  for (const line of text.split('\n')) {
    const m = /^@@(\w+)$/.exec(line.trim());
    if (m) { cur = m[1]; out[cur] = []; } else if (cur && line.trim()) out[cur].push(line.trim());
  }
  return out;
}

// ---------- Was gibt es auf dem Server? ----------

const PROBE = [
  'echo @@id', 'id -u; id -un; echo "$HOME"',
  'echo @@systemd', '[ -d /run/systemd/system ] && command -v systemctl',
  'echo @@journal', 'command -v journalctl',
  'echo @@docker', 'command -v docker',
  'echo @@sudo', 'if sudo -n true 2>/dev/null; then echo nopass; elif command -v sudo >/dev/null; then echo password; else echo none; fi',
  'echo @@os', '( . /etc/os-release && echo "$PRETTY_NAME" )',
  'echo @@kernel', 'uname -sr',
  'echo @@cpu', "grep -m1 -i 'model name' /proc/cpuinfo | cut -d: -f2-",
].map(c => `{ ${c}; } 2>/dev/null`).join('; ');

function parseProbe(text) {
  const s = sections(text);
  const id = s.id || [];
  return {
    uid: id[0] != null ? Number(id[0]) : null,
    user: id[1] || '',
    home: id[2] || '',
    root: id[0] === '0',
    systemd: !!(s.systemd || [])[0],
    journal: !!(s.journal || [])[0],
    docker: !!(s.docker || [])[0],
    sudo: (s.sudo || [])[0] || 'none', // nopass | password | none
    os: (s.os || [])[0] || '',
    kernel: (s.kernel || [])[0] || '',
    cpuModel: ((s.cpu || [])[0] || '').replace(/\s+/g, ' ').trim(),
  };
}

// ---------- Dienste ----------

const LIST_UNITS = 'systemctl list-units --type=service --all --no-legend --no-pager --plain 2>/dev/null';

function parseUnits(text) {
  const list = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/^[●*\s]+/, '').trim();
    if (!line) continue;
    const m = /^(\S+\.service)\s+(\S+)\s+(\S+)\s+(\S+)\s*(.*)$/.exec(line);
    if (!m) continue;
    const [, name, load, active, sub, description] = m;
    if (load === 'not-found') continue; // nur verwiesen, nicht installiert
    list.push({ name, load, active, sub, description });
  }
  return list.sort((a, b) => a.name.localeCompare(b.name));
}

// ---------- Docker ----------

function parseContainers(text) {
  const list = [];
  for (const line of text.split('\n')) {
    if (!line.trim().startsWith('{')) continue;
    let c;
    try { c = JSON.parse(line); } catch { continue; }
    list.push({
      id: String(c.ID || ''), name: String(c.Names || '').split(',')[0], image: String(c.Image || ''),
      state: String(c.State || '').toLowerCase(), status: String(c.Status || ''), ports: String(c.Ports || ''),
    });
  }
  return list.sort((a, b) => a.name.localeCompare(b.name));
}

const dockerDenied = r => /permission denied|connect: permission|Got permission denied/i.test(r.err + r.out);
const dockerDown = r => /Cannot connect to the Docker daemon|Is the docker daemon running/i.test(r.err + r.out);

// ---------- System ----------

const SYSTEM = [
  'echo @@df', 'df -Pk',
  'echo @@ps', 'ps -eo pid=,user=,pcpu=,pmem=,comm= --sort=-pcpu | head -n 8',
].map(c => `{ ${c}; } 2>/dev/null`).join('; ');

const SKIP_FS = /^(tmpfs|devtmpfs|udev|none|shm|overlay|squashfs|efivarfs|cgroup2?|proc|sysfs|run|devpts)$/;

function parseSystem(text) {
  const s = sections(text);
  const disks = [];
  for (const line of s.df || []) {
    const p = line.split(/\s+/);
    if (p.length < 6 || p[0] === 'Filesystem' || p[0] === 'Dateisystem') continue;
    const mount = p.slice(5).join(' ');
    // Nur echte Laufwerke (Gerät /dev/…, Netzlaufwerk host:/…) und immer die Wurzel /
    if (mount !== '/' && (SKIP_FS.test(p[0]) || mount.startsWith('/snap/') || !(p[0].startsWith('/') || p[0].includes(':')))) continue;
    if (mount !== '/' && disks.some(d => d.fs === p[0])) continue; // dasselbe Laufwerk mehrfach eingehängt
    if (/^\/(proc|sys|dev|run)(\/|$)/.test(mount)) continue;
    const total = Number(p[1]) * 1024, used = Number(p[2]) * 1024, free = Number(p[3]) * 1024;
    if (!Number.isFinite(total) || total <= 0) continue;
    disks.push({ fs: p[0], mount, total, used, free });
  }
  const procs = [];
  for (const line of s.ps || []) {
    const m = /^(\d+)\s+(\S+)\s+([\d.,]+)\s+([\d.,]+)\s+(.+)$/.exec(line);
    if (m) procs.push({ pid: Number(m[1]), user: m[2], cpu: Number(m[3].replace(',', '.')), mem: Number(m[4].replace(',', '.')), name: m[5] });
  }
  return { disks, procs };
}

function parseDu(text, dir) {
  const rows = [];
  for (const line of text.split('\n')) {
    const m = /^(\d+)\s+(.+)$/.exec(line.trim());
    if (m) rows.push({ size: Number(m[1]) * 1024, path: m[2] });
  }
  const norm = p => p.replace(/\/+$/, '') || '/';
  const self = rows.find(r => norm(r.path) === norm(dir));
  return { total: self ? self.size : null, dirs: rows.filter(r => r !== self).slice(0, 15) };
}

// ---------- IPC ----------

function register(ipcMain, sessions) {
  const info = new WeakMap(); // Sitzung -> Ergebnis von probe (sudo, root …)
  const running = new WeakMap(); // Sitzung -> laufendes du (zum Abbrechen)

  function client(tabId) {
    const s = sessions.get(tabId);
    if (!s || !s.client) throw new Error('Nicht verbunden.');
    return s;
  }

  async function probe(s, force = false) {
    if (!force && info.has(s)) return info.get(s);
    const r = await exec(s.client, PROBE);
    const p = parseProbe(r.out);
    info.set(s, p);
    return p;
  }

  // Befehl mit Administratorrechten: als root direkt, sonst sudo -n, sonst Hinweis + Befehl fürs Terminal
  async function asAdmin(s, cmd, label) {
    const p = await probe(s);
    if (p.root) return { ...(await exec(s.client, cmd)), via: 'root' };
    if (p.sudo === 'nopass') return { ...(await exec(s.client, `sudo -n ${cmd}`)), via: 'sudo' };
    // Vielleicht klappt es auch ohne (z. B. über polkit-Regeln)
    const r = await exec(s.client, cmd);
    if (r.code === 0) return { ...r, via: 'user' };
    return {
      ...r, via: 'user', needsAdmin: true,
      terminal: p.sudo === 'password' ? `sudo ${cmd}` : null,
      hint: p.sudo === 'password'
        ? `${label} braucht Administratorrechte. Dein Benutzer darf sudo nur mit Passwort benutzen – das geht hier nicht im Hintergrund.`
        : `${label} braucht Administratorrechte, und dein Benutzer darf sudo auf diesem Server nicht benutzen. Melde dich als Administrator (root) an oder frag den Betreiber des Servers.`,
    };
  }

  const errText = r => (r.err || r.out || '').trim().split('\n').slice(-4).join('\n');

  ipcMain.handle('dash:probe', async (_e, tabId) => probe(client(tabId), true));

  ipcMain.handle('dash:services', async (_e, tabId) => {
    const s = client(tabId);
    const p = await probe(s);
    if (!p.systemd) return { available: false, list: [] };
    const r = await exec(s.client, LIST_UNITS);
    if (r.timeout) throw new Error('Der Server hat nicht rechtzeitig geantwortet.');
    return { available: true, list: parseUnits(r.out) };
  });

  ipcMain.handle('dash:serviceAction', async (_e, tabId, unit, action) => {
    if (!UNIT_RE.test(String(unit))) throw new Error('Ungültiger Dienstname.');
    if (!ACTIONS.includes(action)) throw new Error('Unbekannte Aktion.');
    const s = client(tabId);
    const verb = { start: 'Starten', stop: 'Stoppen', restart: 'Neustarten' }[action];
    const r = await asAdmin(s, `systemctl --no-ask-password ${action} ${sq(unit)}`, `${verb} eines Dienstes`);
    if (r.needsAdmin) return { ok: false, needsAdmin: true, hint: r.hint, terminal: r.terminal ? `sudo systemctl ${action} ${unit}` : null, detail: errText(r) };
    if (r.timeout) return { ok: false, error: 'Der Server hat nicht rechtzeitig geantwortet. Der Dienst braucht vielleicht länger – bitte gleich noch einmal aktualisieren.' };
    if (r.code !== 0) return { ok: false, error: errText(r) || `Fehlercode ${r.code}` };
    return { ok: true, via: r.via };
  });

  ipcMain.handle('dash:serviceLogs', async (_e, tabId, unit, lines = 200) => {
    if (!UNIT_RE.test(String(unit))) throw new Error('Ungültiger Dienstname.');
    const n = Math.max(10, Math.min(2000, Number(lines) || 200));
    const s = client(tabId);
    const p = await probe(s);
    if (!p.journal) return { text: '', hint: 'Auf diesem Server gibt es kein journalctl.' };
    const cmd = `journalctl -u ${sq(unit)} -n ${n} --no-pager -o short-iso 2>&1`;
    let r = await exec(s.client, cmd);
    let via = 'user';
    const restricted = t => /insufficient permissions|No journal files were opened|not seeing messages from other users/i.test(t);
    if (!p.root && restricted(r.out) && p.sudo === 'nopass') { r = await exec(s.client, `sudo -n ${cmd}`); via = 'sudo'; }
    let hint = '';
    if (restricted(r.out)) hint = 'Ohne Administratorrechte sind nicht alle Logs sichtbar. Im Terminal geht es mit: sudo journalctl -u ' + unit;
    return { text: r.out, via, hint, timeout: !!r.timeout };
  });

  // Docker: erst ohne sudo, bei „permission denied“ mit sudo -n (wird für die Sitzung gemerkt)
  const dockerSudo = new WeakMap();
  async function docker(s, args, opts) {
    const p = await probe(s);
    if (!p.docker) return { code: 127, out: '', err: 'docker fehlt' };
    if (dockerSudo.get(s)) return exec(s.client, `sudo -n docker ${args}`, opts);
    let r = await exec(s.client, `docker ${args}`, opts);
    if (r.code !== 0 && dockerDenied(r) && !p.root && p.sudo === 'nopass') {
      const r2 = await exec(s.client, `sudo -n docker ${args}`, opts);
      if (r2.code === 0) { dockerSudo.set(s, true); return r2; }
    }
    return r;
  }

  ipcMain.handle('dash:containers', async (_e, tabId) => {
    const s = client(tabId);
    const p = await probe(s);
    if (!p.docker) return { available: false, list: [] };
    const r = await docker(s, `ps -a --no-trunc --format '{{json .}}'`);
    if (r.code !== 0) {
      if (dockerDenied(r)) return { available: true, list: [], denied: true, hint: p.sudo === 'password'
        ? 'Dein Benutzer darf Docker nicht direkt benutzen, und sudo geht nur mit Passwort. Im Terminal geht es mit: sudo docker ps'
        : 'Dein Benutzer darf Docker nicht benutzen. Ein Administrator kann dich mit „sudo usermod -aG docker ' + (p.user || 'BENUTZER') + '“ freischalten (danach neu anmelden).' };
      if (dockerDown(r)) return { available: true, list: [], down: true, hint: 'Docker ist installiert, läuft aber gerade nicht.' };
      return { available: true, list: [], hint: errText(r) || 'Docker hat nicht geantwortet.' };
    }
    return { available: true, list: parseContainers(r.out).map(c => ({ ...c, id: c.id.slice(0, 12) })) };
  });

  ipcMain.handle('dash:containerAction', async (_e, tabId, id, action) => {
    if (!CONTAINER_RE.test(String(id))) throw new Error('Ungültiger Container-Name.');
    if (!ACTIONS.includes(action)) throw new Error('Unbekannte Aktion.');
    const s = client(tabId);
    const r = await docker(s, `${action} ${sq(id)}`, { timeout: 60000 });
    if (r.timeout) return { ok: false, error: 'Docker hat nicht rechtzeitig geantwortet – bitte gleich noch einmal aktualisieren.' };
    if (r.code !== 0) {
      const p = await probe(s);
      if (dockerDenied(r) && p.sudo === 'password') return { ok: false, needsAdmin: true, hint: 'Dafür braucht Docker Administratorrechte, und sudo geht nur mit Passwort.', terminal: `sudo docker ${action} ${id}` };
      return { ok: false, error: errText(r) || `Fehlercode ${r.code}` };
    }
    return { ok: true };
  });

  ipcMain.handle('dash:containerLogs', async (_e, tabId, id, lines = 200) => {
    if (!CONTAINER_RE.test(String(id))) throw new Error('Ungültiger Container-Name.');
    const n = Math.max(10, Math.min(2000, Number(lines) || 200));
    const s = client(tabId);
    const r = await docker(s, `logs --tail ${n} --timestamps ${sq(id)} 2>&1`);
    return { text: r.out || r.err, timeout: !!r.timeout, hint: r.code !== 0 && dockerDenied(r) ? 'Keine Berechtigung für Docker.' : '' };
  });

  ipcMain.handle('dash:system', async (_e, tabId) => {
    const s = client(tabId);
    const [p, r] = await Promise.all([probe(s), exec(s.client, SYSTEM)]);
    return { ...parseSystem(r.out), os: p.os, kernel: p.kernel, cpuModel: p.cpuModel };
  });

  // Größte Ordner (du). useSudo nur auf ausdrücklichen Wunsch und nur ohne Passwort.
  ipcMain.handle('dash:bigDirs', async (_e, tabId, dir, useSudo) => {
    dir = String(dir || '/').trim() || '/';
    if (dir.length > 1000 || /[\0\n\r]/.test(dir)) throw new Error('Ungültiger Ordner.');
    const s = client(tabId);
    const p = await probe(s);
    const sudo = useSudo && !p.root && p.sudo === 'nopass' ? 'sudo -n ' : '';
    if (dir === '~' || dir.startsWith('~/')) dir = (p.home || '') + dir.slice(1) || '/';
    const cmd = `${sudo}du -xk -d 1 -- ${sq(dir)}`;
    const r = await exec(s.client, cmd, {
      timeout: DU_TIMEOUT,
      onStream: (stream, cancel) => running.set(s, () => { try { stream.signal('INT'); stream.close(); } catch {} cancel(); }),
    });
    running.delete(s);
    if (r.cancelled) return { cancelled: true };
    const sorted = r.out.split('\n').sort((a, b) => (parseInt(b, 10) || 0) - (parseInt(a, 10) || 0)).join('\n');
    const res = parseDu(sorted, dir);
    if (!res.dirs.length && res.total == null) {
      if (r.timeout) throw new Error('Das Zählen hat zu lange gedauert. Bitte einen kleineren Ordner wählen.');
      throw new Error(`Der Ordner „${dir}“ konnte nicht gelesen werden.`);
    }
    return { ...res, dir, incomplete: /denied|Keine Berechtigung/i.test(r.err), canSudo: !p.root && p.sudo === 'nopass', usedSudo: !!sudo, timeout: !!r.timeout };
  });

  ipcMain.handle('dash:cancel', (_e, tabId) => { const s = sessions.get(tabId); const c = s && running.get(s); if (c) c(); return !!c; });
}

module.exports = { register, parseProbe, parseUnits, parseContainers, parseSystem, parseDu, UNIT_RE, CONTAINER_RE, PROBE };
