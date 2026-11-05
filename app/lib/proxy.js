// Verbindung über einen Proxy: SOCKS5 (optional mit Benutzer/Passwort) oder HTTP-CONNECT.
// openProxySocket() liefert einen fertigen Socket zum Ziel, der an ssh2 als `sock` übergeben wird.
// Einstellungen: global in ~/.myssh/proxy.json, pro Verbindung in hosts.json (Feld `proxy`).
// Proxy-Passwörter verschlüsselt (safeStorage) in ~/.myssh/proxy-passwords.json.
const fs = require('fs');
const path = require('path');
const net = require('net');
const { t } = require('./i18n');

const TYPES = ['socks5', 'http'];
const TIMEOUT = 15000;

// Proxy-Angabe prüfen und säubern; null = ungültig/leer
function cleanProxy(p) {
  if (!p || typeof p !== 'object' || !TYPES.includes(p.type)) return null;
  const host = String(p.host || '').trim();
  const port = Number(p.port) || (p.type === 'http' ? 8080 : 1080);
  if (!host || port < 1 || port > 65535) return null;
  const out = { type: p.type, host, port };
  const user = String(p.user || '').trim();
  if (user) out.user = user.slice(0, 255);
  return out;
}

// Schlüssel für das gespeicherte Passwort – gleicher Proxy = gleiches Passwort, egal wo eingestellt
const secretKey = p => `${p.type}://${p.user || ''}@${p.host}:${p.port}`;
const describe = p => t('proxy.describe', { type: p.type === 'http' ? 'HTTP' : 'SOCKS5', host: p.host, port: p.port });

function readExactly(sock, n, state) {
  return new Promise((resolve, reject) => {
    const tryRead = () => {
      if (state.buf.length >= n) {
        const out = state.buf.subarray(0, n);
        state.buf = state.buf.subarray(n);
        cleanup();
        resolve(out);
      }
    };
    const onData = d => { state.buf = Buffer.concat([state.buf, d]); tryRead(); };
    const onEnd = () => { cleanup(); reject(new Error(t('proxy.closed'))); };
    const onError = err => { cleanup(); reject(err); };
    const cleanup = () => { sock.off('data', onData); sock.off('end', onEnd); sock.off('close', onEnd); sock.off('error', onError); };
    sock.on('data', onData); sock.on('end', onEnd); sock.on('close', onEnd); sock.on('error', onError);
    tryRead();
  });
}

// Fehlercodes der SOCKS5-Antwort -> Schlüssel im Wörterbuch
const SOCKS_ERRORS = {
  1: 'proxy.socksErr1', 2: 'proxy.socksErr2', 3: 'proxy.socksErr3', 4: 'proxy.socksErr4',
  5: 'proxy.socksErr5', 6: 'proxy.socksErr6', 7: 'proxy.socksErr7', 8: 'proxy.socksErr8',
};

async function socks5(sock, host, port, user, password) {
  const st = { buf: Buffer.alloc(0) };
  const methods = user ? [0x00, 0x02] : [0x00];
  sock.write(Buffer.from([0x05, methods.length, ...methods]));
  const [ver, method] = await readExactly(sock, 2, st);
  if (ver !== 0x05) throw new Error(t('proxy.notSocks'));
  if (method === 0xff) throw new Error(user ? t('proxy.authRejected') : t('proxy.authRequired'));
  if (method === 0x02) {
    if (password == null) { const e = new Error(t('proxy.passwordMissing')); e.needPassword = true; throw e; }
    const u = Buffer.from(user || ''); const pw = Buffer.from(password);
    sock.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([pw.length]), pw]));
    const [, status] = await readExactly(sock, 2, st);
    if (status !== 0x00) { const e = new Error(t('proxy.authFailedCreds')); e.badPassword = true; throw e; }
  } else if (method !== 0x00) throw new Error(t('proxy.noAuthMethod'));

  let addr;
  if (net.isIPv4(host)) addr = Buffer.from([0x01, ...host.split('.').map(Number)]);
  else if (net.isIPv6(host)) {
    const b = Buffer.alloc(17); b[0] = 0x04;
    const full = expandIPv6(host);
    for (let i = 0; i < 8; i++) b.writeUInt16BE(parseInt(full[i], 16), 1 + i * 2);
    addr = b;
  } else {
    const h = Buffer.from(host);
    if (h.length > 255) throw new Error(t('proxy.hostTooLong'));
    addr = Buffer.concat([Buffer.from([0x03, h.length]), h]);
  }
  const portBuf = Buffer.alloc(2); portBuf.writeUInt16BE(port);
  sock.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00]), addr, portBuf]));
  const head = await readExactly(sock, 4, st);
  if (head[1] !== 0x00) throw new Error(t('proxy.cantReach', { host, port, reason: SOCKS_ERRORS[head[1]] ? t(SOCKS_ERRORS[head[1]]) : t('proxy.socksErrN', { code: head[1] }) }));
  const rest = head[3] === 0x01 ? 4 : head[3] === 0x04 ? 16 : (await readExactly(sock, 1, st))[0];
  await readExactly(sock, rest + 2, st);
  if (st.buf.length) sock.unshift(st.buf);
}

function expandIPv6(ip) {
  const [a, b = ''] = ip.split('::');
  const left = a ? a.split(':') : [];
  const right = b ? b.split(':') : [];
  const fill = ip.includes('::') ? Array(8 - left.length - right.length).fill('0') : [];
  return [...left, ...fill, ...right];
}

async function httpConnect(sock, host, port, user, password) {
  const hostPort = net.isIPv6(host) ? `[${host}]:${port}` : `${host}:${port}`;
  let req = `CONNECT ${hostPort} HTTP/1.1\r\nHost: ${hostPort}\r\n`;
  if (user) {
    if (password == null) { const e = new Error(t('proxy.passwordMissing')); e.needPassword = true; throw e; }
    req += `Proxy-Authorization: Basic ${Buffer.from(`${user}:${password}`).toString('base64')}\r\n`;
  }
  sock.write(req + '\r\n');
  const head = await new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const onData = d => {
      buf = Buffer.concat([buf, d]);
      const end = buf.indexOf('\r\n\r\n');
      if (end >= 0) {
        cleanup();
        const rest = buf.subarray(end + 4);
        if (rest.length) sock.unshift(rest);
        resolve(buf.subarray(0, end).toString('latin1'));
      } else if (buf.length > 16384) { cleanup(); reject(new Error(t('proxy.badResponse'))); }
    };
    const onEnd = () => { cleanup(); reject(new Error(t('proxy.closed'))); };
    const onError = err => { cleanup(); reject(err); };
    const cleanup = () => { sock.off('data', onData); sock.off('end', onEnd); sock.off('close', onEnd); sock.off('error', onError); };
    sock.on('data', onData); sock.on('end', onEnd); sock.on('close', onEnd); sock.on('error', onError);
  });
  const m = /^HTTP\/1\.[01] (\d{3})/.exec(head);
  if (!m) throw new Error(t('proxy.notHttp'));
  const code = Number(m[1]);
  if (code === 407) {
    const e = new Error(user ? t('proxy.authFailedCreds') : t('proxy.authRequired'));
    e.badPassword = !!user;
    throw e;
  }
  if (code < 200 || code >= 300) throw new Error(t('proxy.cantReach', { host, port, reason: `HTTP ${code}` }));
}

// Socket über den Proxy zum Ziel öffnen
function openProxySocket(proxy, host, port, password) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: proxy.host, port: proxy.port });
    let done = false;
    const timer = setTimeout(() => finish(new Error(t('proxy.timeout', { proxy: describe(proxy) }))), TIMEOUT);
    const finish = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.off('error', onError);
      if (err) { sock.destroy(); reject(err); return; }
      sock.pause(); // ssh2 liest erst nach seiner Vorbereitung – bis dahin nichts verlieren
      resolve(sock);
    };
    const onError = err => {
      const msg = /ECONNREFUSED/.test(err.message) ? t('proxy.refused', { proxy: describe(proxy) })
        : /ENOTFOUND|EAI_AGAIN/.test(err.message) ? t('proxy.notFound', { proxy: describe(proxy) })
          : `${describe(proxy)}: ${err.message}`;
      finish(new Error(msg));
    };
    sock.on('error', onError);
    sock.once('connect', () => {
      const fn = proxy.type === 'http' ? httpConnect : socks5;
      fn(sock, host, port, proxy.user, password).then(() => finish(null), err => {
        if (!/proxy/i.test(err.message)) err.message = `${describe(proxy)}: ${err.message}`;
        finish(err);
      });
    });
  });
}

function createProxyManager({ configDir, secrets, ask }) {
  const file = path.join(configDir, 'proxy.json');
  const loadGlobal = () => { try { return cleanProxy(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { return null; } };
  const saveGlobal = p => {
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    if (p) fs.writeFileSync(file, JSON.stringify(p, null, 2), { mode: 0o600 });
    else { try { fs.unlinkSync(file); } catch {} }
  };

  // Welcher Proxy gilt für diese Verbindung? host.proxy: fehlt = global, 'none' = direkt, Objekt = eigener
  function proxyFor(target) {
    if (target && target.proxy === 'none') return null;
    if (target && target.proxy && typeof target.proxy === 'object') return cleanProxy(target.proxy);
    return loadGlobal();
  }

  // Socket zum ersten Server – über den Proxy, mit Passwort aus dem Speicher oder per Rückfrage
  async function connectVia(proxy, host, port, cache) {
    const key = secretKey(proxy);
    let password = proxy.user ? (cache && cache.get(key)) ?? secrets.read(key) : undefined;
    for (let i = 0; i < 4; i++) {
      try {
        const sock = await openProxySocket(proxy, host, port, password ?? undefined);
        if (proxy.user && cache && password != null) cache.set(key, password);
        return sock;
      } catch (err) {
        if (!err.needPassword && !err.badPassword) throw err;
        if (err.badPassword) { if (cache) cache.delete(key); }
        if (i === 3) throw err;
        const answer = await ask({
          kind: 'secret', title: err.badPassword ? t('proxy.passwordWrongTitle') : t('proxy.loginTitle'),
          message: t(err.badPassword ? 'proxy.passwordPromptAgain' : 'proxy.passwordPrompt', { user: proxy.user || '?', proxy: describe(proxy) }),
          remember: true, rememberLabel: t('proxy.rememberPassword'),
        });
        if (answer == null) throw new Error(t('proxy.cancelledNoPassword'));
        password = typeof answer === 'object' ? answer.value : answer;
        if (typeof answer === 'object' && answer.remember) secrets.write(key, password);
      }
    }
    throw new Error(t('proxy.authFailed'));
  }

  // Passwort aus dem Host-Dialog bzw. den Einstellungen speichern
  function setPassword(p, password) {
    const proxy = cleanProxy(p);
    if (!proxy || !proxy.user) return false;
    if (!password) { secrets.remove(secretKey(proxy)); return true; }
    if (!secrets.write(secretKey(proxy), password)) throw new Error(t('proxy.saveFailed'));
    return true;
  }

  function register(ipcMain) {
    ipcMain.handle('proxy:get', () => {
      const p = loadGlobal();
      return p ? { ...p, hasPassword: !!(p.user && secrets.has(secretKey(p))) } : null;
    });
    ipcMain.handle('proxy:set', (_e, p, password) => {
      const proxy = p ? cleanProxy(p) : null;
      if (p && !proxy) throw new Error(t('proxy.incomplete'));
      saveGlobal(proxy);
      if (proxy && password) setPassword(proxy, password);
      return proxy;
    });
    ipcMain.handle('proxy:hasPassword', (_e, p) => { const x = cleanProxy(p); return !!(x && x.user && secrets.has(secretKey(x))); });
    ipcMain.handle('proxy:forgetPassword', (_e, p) => setPassword(p, ''));
    // Kurzer Test: kommt man über den Proxy zu host:port?
    ipcMain.handle('proxy:test', async (_e, p, password, host, port) => {
      const proxy = cleanProxy(p);
      if (!proxy) throw new Error(t('proxy.incomplete'));
      const pw = password || (proxy.user ? secrets.read(secretKey(proxy)) : null);
      const sock = await openProxySocket(proxy, host, Number(port) || 22, pw ?? undefined);
      sock.resume();
      const banner = await new Promise(resolve => {
        const t = setTimeout(() => resolve(''), 4000);
        sock.once('data', d => { clearTimeout(t); resolve(d.toString('latin1').split('\n')[0].trim()); });
      });
      sock.destroy();
      return { banner };
    });
  }

  return { proxyFor, connectVia, setPassword, loadGlobal, register };
}

// Feld `proxy` für hosts.json aus dem Host-Dialog: 'none', Objekt oder undefined (= global)
function hostProxyField(value) {
  if (value === 'none') return 'none';
  return cleanProxy(value) || undefined;
}

module.exports = { openProxySocket, createProxyManager, cleanProxy, hostProxyField, secretKey };
