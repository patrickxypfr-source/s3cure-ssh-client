// S3cure SSH Client – Remote Desktop (VNC) durch die SSH-Verbindung (Hauptprozess)
//
// Ablauf:
//   1. Die Oberfläche fragt „vnc:open“ für einen Tab an.
//   2. Hier wird über die bestehende SSH-Verbindung ein Kanal zum VNC-Port auf dem Server geöffnet
//      (ssh2 forwardOut – wie ein lokaler Tunnel, aber ohne lokalen TCP-Port).
//   3. Eine kleine WebSocket-Brücke lauscht nur auf 127.0.0.1 (zufälliger Port). Die Oberfläche bekommt eine
//      Adresse mit Einmal-Token; noVNC (src/vnc.js) verbindet sich damit. Danach ist das Token verbraucht.
//   Es wird kein unverschlüsselter VNC-Port ins Netz geöffnet – alles läuft durch SSH.
//
// Gespeichert pro Verbindung in hosts.json: hosts[name].vnc = { enabled, host, port, quality, viewOnly, scale }
// Das VNC-Passwort liegt verschlüsselt (safeStorage) in vnc-passwords.json.
const http = require('http');
const crypto = require('crypto');
const i18n = require('./i18n');

const VNC_BASE = 5900;
const QUALITIES = ['best', 'balanced', 'low'];
const SCALES = ['fit', 'real'];
const TOKEN_TTL = 20000;   // so lange darf die Oberfläche mit dem Verbinden warten
const BANNER_WAIT = 8000;  // so lange auf „RFB 003.00x“ vom VNC-Server warten

const isPort = n => Number.isInteger(n) && n >= 1 && n <= 65535;

// ---------- Ziel „Adresse:Port“ bzw. Display ----------
// Erlaubt (wie bei VNC-Programmen üblich):
//   ""             -> localhost:5900
//   ":1" / "1"     -> localhost:5901 (Display-Nummer, unter 100)
//   "5901"         -> localhost:5901
//   "host"         -> host:5900
//   "host:1"       -> host:5901       "host:5901" -> host:5901
//   "host::5901"   -> host:5901 (Doppelpunkt doppelt = immer Port)
//   "[::1]:5901"   -> ::1:5901
function parseVncTarget(text) {
  const s = String(text == null ? '' : text).trim();
  if (/\s/.test(s)) throw new Error(i18n.t('vnc.errTargetSpace'));
  let host = '', rest = '', forcePort = false;
  const v6 = /^\[([^\]]+)\](?::(.*))?$/.exec(s);
  if (v6) { host = v6[1]; rest = v6[2] || ''; }
  else if (s.includes('::') && /^[^:]*::\d+$/.test(s)) { [host, rest] = s.split('::'); forcePort = true; }
  else if ((s.match(/:/g) || []).length > 1) { host = s; } // reine IPv6-Adresse ohne Port
  else if (s.includes(':')) { [host, rest] = s.split(':'); }
  else if (/^\d+$/.test(s)) { rest = s; }
  else host = s;
  host = host || 'localhost';
  let port = VNC_BASE;
  if (rest !== '') {
    if (!/^\d+$/.test(rest)) throw new Error(i18n.t('vnc.errTargetPort'));
    const n = Number(rest);
    port = !forcePort && n < 100 ? VNC_BASE + n : n;
  }
  if (!isPort(port)) throw new Error(i18n.t('vnc.errTargetPort'));
  return { host, port };
}

function formatVncTarget({ host, port }) {
  const h = host.includes(':') ? `[${host}]` : host;
  return `${h}:${port}`;
}

// Einstellungen aus dem Host-Dialog prüfen. undefined = keine VNC-Einstellungen (Feld wird entfernt).
function vncField(v) {
  if (!v || typeof v !== 'object') return undefined;
  const target = 'target' in v ? parseVncTarget(v.target) : parseVncTarget(v.host ? formatVncTarget({ host: v.host, port: Number(v.port) || VNC_BASE }) : '');
  const out = {
    enabled: v.enabled === true,
    host: target.host,
    port: target.port,
    quality: QUALITIES.includes(v.quality) ? v.quality : 'balanced',
    viewOnly: v.viewOnly === true,
    scale: SCALES.includes(v.scale) ? v.scale : 'fit',
  };
  // Nichts eingestellt -> nichts speichern (alte hosts.json bleiben schlank)
  if (!out.enabled && out.host === 'localhost' && out.port === VNC_BASE && out.quality === 'balanced' && !out.viewOnly && out.scale === 'fit') return undefined;
  return out;
}

function vncSettings(host) {
  const v = host && host.vnc;
  return { enabled: false, host: 'localhost', port: VNC_BASE, quality: 'balanced', viewOnly: false, scale: 'fit', ...(v && typeof v === 'object' ? vncField(v) : {}) };
}

// ---------- Lauschende Ports auf dem Server (ss -ltn bzw. netstat -ltn) ----------

// Liefert [{ addr, port }] aus der Ausgabe von `ss -ltn` oder `netstat -ltn`
function parseListening(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 4) continue;
    // ss: State Recv-Q Send-Q Local Peer  /  netstat: Proto Recv-Q Send-Q Local Foreign State
    const isSs = /^LISTEN$/i.test(cols[0]);
    const isNetstat = /^tcp6?$/i.test(cols[0]) && /LISTEN/i.test(line);
    if (!isSs && !isNetstat) continue;
    const m = /^(.*)[:.](\d+)$/.exec(cols[3]);
    if (!m) continue;
    let addr = m[1].replace(/^\[|\]$/g, '').replace(/%[\w.-]+$/, '');
    if (addr === '' || addr === ':') addr = '::';
    out.push({ addr, port: Number(m[2]) });
  }
  return out;
}

const isLoopback = a => /^127\./.test(a) || a === '::1' || a === 'localhost';
const isAny = a => a === '0.0.0.0' || a === '*' || a === '::' || a === '[::]';
const isV4 = a => /^\d+\.\d+\.\d+\.\d+$/.test(a) || a === '*';

// Mögliche VNC-Server: Ports 5900–5999 (Display :0 bis :99)
function vncCandidates(listening) {
  const byPort = new Map();
  for (const { addr, port } of listening) {
    if (port < VNC_BASE || port > VNC_BASE + 99) continue;
    if (!byPort.has(port)) byPort.set(port, new Set());
    byPort.get(port).add(addr);
  }
  return [...byPort.entries()].sort((a, b) => a[0] - b[0]).map(([port, set]) => {
    const addrs = [...set];
    const local = addrs.some(a => isLoopback(a) || isAny(a));
    // Adresse, unter der der Server selbst den Dienst erreicht
    let host = 'localhost';
    if (addrs.some(a => isV4(a) && (isLoopback(a) || isAny(a)))) host = '127.0.0.1';
    else if (addrs.some(a => a === '::1' || a === '::')) host = '::1';
    else if (!local) host = addrs[0];
    return {
      port, display: port - VNC_BASE, host, addrs,
      loopbackOnly: addrs.every(isLoopback), // nur auf dem Server selbst erreichbar (gut so)
      target: formatVncTarget({ host, port }),
    };
  });
}

// ---------- Verständliche Fehler ----------

function friendlyVncError(err, target) {
  const msg = String(err && err.message || err);
  const where = formatVncTarget(target);
  if (/Connection refused|ECONNREFUSED/i.test(msg)) return i18n.t('vnc.errNoServer', { target: where, port: target.port });
  if (/administratively prohibited|prohibited/i.test(msg)) return i18n.t('vnc.errProhibited');
  if (/not found|ENOTFOUND|resolve|Name or service/i.test(msg)) return i18n.t('vnc.errNotFound', { host: target.host });
  if (/Not connected|No response|closed/i.test(msg)) return i18n.t('vnc.errConnGone');
  return i18n.t('vnc.errUnreachable', { target: where, error: msg });
}

// ---------- Brücke WebSocket <-> SSH-Kanal ----------

function createVncBridge({ getSession, loadHosts, secrets, clipboard }) {
  const { WebSocketServer } = require('ws');
  let server = null;     // http-Server, nur auf 127.0.0.1
  let listening = null;  // Promise auf den Port
  const pending = new Map(); // Token -> { tabId, channel, chunks, timer }
  const active = new Map();  // Tab-ID -> Set({ channel, ws })

  const wss = new WebSocketServer({
    noServer: true, perMessageDeflate: false, maxPayload: 32 * 1024 * 1024,
    handleProtocols: protocols => (protocols.has('binary') ? 'binary' : false),
  });

  function ensureServer() {
    if (listening) return listening;
    server = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
    server.on('upgrade', onUpgrade);
    listening = new Promise((resolve, reject) => {
      server.once('error', err => { listening = null; server = null; reject(err); });
      server.listen({ host: '127.0.0.1', port: 0 }, () => resolve(server.address().port));
    });
    return listening;
  }

  function reject(socket, code) {
    try { socket.end(`HTTP/1.1 ${code} ${http.STATUS_CODES[code]}\r\nConnection: close\r\n\r\n`); } catch {}
    socket.destroy();
  }

  function onUpgrade(req, socket, head) {
    const m = /^\/vnc\/([0-9a-f]{48})$/.exec(req.url || '');
    const p = m && pending.get(m[1]);
    // Nur von diesem Rechner und nur aus der App (Seite aus file://)
    const origin = req.headers.origin;
    const fromApp = origin === undefined || origin === 'file://' || origin === 'null';
    const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
    if (!p || !fromApp || !local) return reject(socket, 403);
    pending.delete(m[1]); // Einmal-Token
    clearTimeout(p.timer);
    wss.handleUpgrade(req, socket, head, ws => attach(p, ws));
  }

  function attach(p, ws) {
    const { tabId, channel } = p;
    const link = { channel, ws };
    if (!active.has(tabId)) active.set(tabId, new Set());
    active.get(tabId).add(link);
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      active.get(tabId)?.delete(link);
      try { channel.close(); } catch {}
      try { ws.close(); } catch {}
    };
    for (const c of p.chunks) ws.send(c);
    channel.removeAllListeners('data');
    channel.on('data', d => { if (ws.readyState === 1) ws.send(d); });
    channel.on('close', close);
    channel.on('error', close);
    ws.on('message', d => { try { channel.write(d); } catch { close(); } });
    ws.on('close', close);
    ws.on('error', close);
    channel.resume();
  }

  // Kanal zum VNC-Server öffnen und auf die Begrüßung „RFB 003.00x“ warten
  function openChannel(client, target) {
    return new Promise((resolve, rejectP) => {
      client.forwardOut('127.0.0.1', 0, target.host, target.port, (err, channel) => {
        if (err) return rejectP(new Error(friendlyVncError(err, target)));
        const chunks = [];
        let got = Buffer.alloc(0);
        let done = false;
        const finish = e => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          if (e) { try { channel.close(); } catch {} return rejectP(e); }
          channel.pause();
          resolve({ channel, chunks, version: got.subarray(4, 11).toString('latin1') });
        };
        const timer = setTimeout(() => finish(new Error(i18n.t('vnc.errNoBanner', { target: formatVncTarget(target) }))), BANNER_WAIT);
        channel.on('data', d => {
          chunks.push(d);
          got = Buffer.concat([got, d]);
          if (got.length >= 12) finish(/^RFB \d{3}\.\d{3}\n/.test(got.subarray(0, 12).toString('latin1')) ? null : new Error(i18n.t('vnc.errNotVnc', { target: formatVncTarget(target) })));
        });
        channel.on('close', () => finish(new Error(got.length ? i18n.t('vnc.errNotVnc', { target: formatVncTarget(target) }) : i18n.t('vnc.errClosedEarly', { target: formatVncTarget(target) }))));
        channel.on('error', e => finish(new Error(friendlyVncError(e, target))));
      });
    });
  }

  // opts.target: anderes Ziel als gespeichert (z. B. aus der Suche oder Schnellverbinden)
  async function open(tabId, opts = {}) {
    const s = getSession(tabId);
    if (!s) throw new Error(i18n.t('vnc.errNoSession'));
    const settings = vncSettings(s.hostName ? loadHosts()[s.hostName] : null);
    const target = opts.target != null && opts.target !== '' ? parseVncTarget(opts.target) : { host: settings.host, port: settings.port };
    stopAll(tabId); // pro Tab nur eine Desktop-Verbindung
    const { channel, chunks, version } = await openChannel(s.client, target);
    const port = await ensureServer();
    const token = crypto.randomBytes(24).toString('hex');
    const timer = setTimeout(() => { if (pending.delete(token)) { try { channel.close(); } catch {} } }, TOKEN_TTL);
    pending.set(token, { tabId, channel, chunks, timer });
    return {
      url: `ws://127.0.0.1:${port}/vnc/${token}`,
      target: formatVncTarget(target), version,
      settings,
      // Gespeichertes VNC-Passwort nur für diese Verbindung herausgeben (noVNC braucht es zum Anmelden)
      password: s.hostName ? secrets.read(s.hostName) : null,
    };
  }

  function stopAll(tabId) {
    for (const [token, p] of pending) {
      if (p.tabId !== tabId) continue;
      pending.delete(token);
      clearTimeout(p.timer);
      try { p.channel.close(); } catch {}
    }
    for (const link of active.get(tabId) || []) {
      try { link.channel.close(); } catch {}
      try { link.ws.close(); } catch {}
    }
    active.delete(tabId);
  }

  // Lauschende VNC-Server auf dem Server finden (eigener exec-Kanal, nichts im Terminal)
  function scan(tabId) {
    const s = getSession(tabId);
    if (!s) return Promise.reject(new Error(i18n.t('vnc.errNoSession')));
    const cmd = 'LC_ALL=C; export LC_ALL; if command -v ss >/dev/null 2>&1; then ss -ltn; ' +
      'elif command -v netstat >/dev/null 2>&1; then netstat -ltn; else echo S3CURE_NO_TOOL; fi';
    return new Promise((resolve, rejectP) => {
      s.client.exec(cmd, (err, stream) => {
        if (err) return rejectP(new Error(i18n.t('vnc.errScan', { error: err.message })));
        let outText = '';
        const timer = setTimeout(() => { try { stream.close(); } catch {} }, 10000);
        stream.on('data', d => { outText += d; });
        stream.stderr.on('data', () => {});
        stream.on('close', () => {
          clearTimeout(timer);
          if (/S3CURE_NO_TOOL/.test(outText)) return resolve({ tool: false, found: [] });
          resolve({ tool: true, found: vncCandidates(parseListening(outText)) });
        });
      });
    });
  }

  function register(ipcMain) {
    ipcMain.handle('vnc:open', (_e, tabId, opts) => open(tabId, opts || {}));
    ipcMain.handle('vnc:close', (_e, tabId) => { stopAll(tabId); return true; });
    ipcMain.handle('vnc:scan', (_e, tabId) => scan(tabId));
    ipcMain.handle('vnc:settings', (_e, hostName) => vncSettings(hostName ? loadHosts()[hostName] : null));
    ipcMain.handle('vnc:hasPassword', (_e, hostName) => !!hostName && secrets.has(hostName));
    ipcMain.handle('vnc:savePassword', (_e, hostName, password) => {
      if (!hostName || !loadHosts()[hostName]) throw new Error(i18n.t('vnc.errOnlySaved'));
      if (!secrets.write(hostName, String(password))) throw new Error(i18n.t('main.passwordNotSaved'));
      return true;
    });
    ipcMain.handle('vnc:forgetPassword', (_e, hostName) => { if (hostName) secrets.remove(hostName); return true; });
    // Zwischenablage über den Hauptprozess (funktioniert auch, wenn das Fenster gerade keinen Fokus hat)
    ipcMain.handle('vnc:clipboardRead', () => clipboard.readText());
    ipcMain.handle('vnc:clipboardWrite', (_e, text) => { clipboard.writeText(String(text || '')); return true; });
  }

  // Aufrufe aus main.js (hosts:save / hosts:delete)
  function onHostSaved(name, host, oldName) {
    if (oldName && oldName !== name && secrets.has(oldName)) {
      const pw = secrets.read(oldName);
      if (pw != null) secrets.write(name, pw);
      secrets.remove(oldName);
    }
    if (host.vncForgetPassword) secrets.remove(name);
    if (host.vncPassword) {
      if (!secrets.write(name, String(host.vncPassword))) throw new Error(i18n.t('main.passwordNotSaved'));
    }
  }
  function onHostDeleted(name) { secrets.remove(name); }

  function closeAll() {
    for (const tabId of [...active.keys()]) stopAll(tabId);
    for (const p of pending.values()) stopAll(p.tabId);
    if (server) { try { server.close(); } catch {} }
    server = null; listening = null;
  }

  return { register, open, stopAll, scan, onHostSaved, onHostDeleted, closeAll, _pending: pending, _ensureServer: ensureServer };
}

module.exports = {
  createVncBridge, parseVncTarget, formatVncTarget, vncField, vncSettings,
  parseListening, vncCandidates, friendlyVncError, VNC_BASE,
};
