// Web-Server des Agenten: Web-App (public/) und API. Hört standardmäßig nur auf 127.0.0.1 –
// nach außen über nginx/Caddy mit HTTPS (siehe README). Anmeldung: Passwort + 2FA, Sitzung im Cookie.
// Schutz: SameSite=Strict-Cookie + eigene Kopfzeile bei Änderungen (gegen fremde Webseiten),
// strenge Sicherheits-Header, Rate-Limit bei der Anmeldung, Rollen (admin/viewer), Protokoll aller Aktionen.
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const config = require('./config');
const { createAuth } = require('./auth');
const { createSystem, createDemo } = require('./system');
const { createHistory } = require('./history');
const { createPush } = require('./push');
const { createAlerts } = require('./alerts');

const VERSION = require('../package.json').version;
const PUBLIC = path.join(__dirname, '..', 'public');
const COOKIE = 's3s';
const MAX_BODY = 64 * 1024;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.json': 'application/json', '.ico': 'image/x-icon' };

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()', 'Cross-Origin-Opener-Policy': 'same-origin',
};

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

function createAgent({ demo = !!process.env.S3CURE_AGENT_DEMO } = {}) {
  let cfg = config.load();
  const getCfg = () => cfg;
  const auth = createAuth();
  const sys = demo ? createDemo({ protect: cfg.control.protect }) : createSystem({ protect: cfg.control.protect });
  const history = createHistory();
  const push = createPush({ subject: /^https:\/\//.test(cfg.publicUrl) ? cfg.publicUrl : undefined });
  let lastMetrics = null;

  // ---------- Protokoll ----------
  function audit(entry) {
    try {
      config.ensureDir();
      fs.appendFileSync(config.file('audit.log'), JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n', { mode: 0o600 });
    } catch {}
  }
  function readAudit(n = 200) {
    try { return fs.readFileSync(config.file('audit.log'), 'utf8').trim().split('\n').slice(-n).reverse().map(l => JSON.parse(l)); } catch { return []; }
  }

  // ---------- Server: dieser und weitere (Hub) ----------
  const local = {
    id: 'local',
    async overview() {
      const [m, s] = [lastMetrics || await sys.metrics(), await sys.services().catch(() => ({ list: [] }))];
      return { metrics: m, failed: s.list.filter(x => x.active === 'failed').map(x => x.name), services: s.list };
    },
    services: () => sys.services(), serviceAction: (n, a) => sys.serviceAction(n, a), serviceLogs: (n, l) => sys.serviceLogs(n, l),
    containers: () => sys.containers(), containerAction: (n, a) => sys.containerAction(n, a), containerLogs: (n, l) => sys.containerLogs(n, l),
    reboot: () => sys.reboot(),
  };

  // Anderer Agent: gleiche Aufrufe über HTTPS mit dessen Schlüssel
  function remote(peer) {
    const call = async (method, p, body) => {
      const res = await fetch(peer.url.replace(/\/+$/, '') + '/api/agent' + p, {
        method, headers: { Authorization: 'Bearer ' + peer.token, 'Content-Type': 'application/json', 'X-S3cure': '1' },
        body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(method === 'GET' ? 15000 : 95000),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new HttpError(res.status === 401 ? 502 : res.status, data.error || `Server ${peer.name}: Fehler ${res.status}`);
      return data;
    };
    const e = encodeURIComponent;
    return {
      id: 'peer:' + peer.name, name: peer.name,
      overview: () => call('GET', '/overview'), services: () => call('GET', '/services'), containers: () => call('GET', '/containers'),
      serviceAction: (n, a) => call('POST', `/services/${e(n)}/${e(a)}`), containerAction: (n, a) => call('POST', `/containers/${e(n)}/${e(a)}`),
      serviceLogs: async (n, l) => (await call('GET', `/services/${e(n)}/logs?lines=${l}`)).text,
      containerLogs: async (n, l) => (await call('GET', `/containers/${e(n)}/logs?lines=${l}`)).text,
      reboot: () => call('POST', '/reboot'),
    };
  }

  const servers = () => [{ ...local, name: cfg.name }, ...(cfg.peers || []).map(remote)];
  const server = id => { const s = servers().find(x => x.id === id); if (!s) throw new HttpError(404, 'Server nicht gefunden.'); return s; };

  // Alle Server für Übersicht und Warnungen
  async function collect() {
    return Promise.all(servers().map(async s => {
      try {
        const o = await s.overview();
        return { id: s.id, name: s.name, ok: true, metrics: o.metrics, failed: o.failed, services: o.services || (o.failed || []).map(n => ({ name: n, active: 'failed' })) };
      } catch (err) { return { id: s.id, name: s.name, ok: false, error: String(err.message || err) }; }
    }));
  }

  const alerts = createAlerts({ getCfg, collect, push, audit });

  // Messwerte alle 10 Sekunden (für Verlauf und schnelle Antworten)
  let sampler = null;
  async function sample() { try { lastMetrics = await sys.metrics(); history.add(lastMetrics); } catch {} }

  // ---------- HTTP-Hilfen ----------
  function send(res, status, body, headers = {}) {
    const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    res.writeHead(status, { ...SECURITY_HEADERS, 'Cache-Control': 'no-store', ...(typeof body === 'object' && !Buffer.isBuffer(body) ? { 'Content-Type': 'application/json; charset=utf-8' } : {}), ...headers });
    res.end(data);
  }

  const clientIp = req => {
    const remoteIp = req.socket.remoteAddress || '';
    const fwd = req.headers['x-forwarded-for'];
    // Nur dem Proxy auf demselben Rechner glauben
    if (fwd && /^(127\.|::1$|::ffff:127\.)/.test(remoteIp)) return String(fwd).split(',')[0].trim();
    return remoteIp;
  };
  const isHttps = req => req.headers['x-forwarded-proto'] === 'https' || /^https:/.test(cfg.publicUrl);

  function cookies(req) {
    const out = {};
    for (const part of String(req.headers.cookie || '').split(';')) { const i = part.indexOf('='); if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); }
    return out;
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0; const chunks = [];
      req.on('data', c => { size += c.length; if (size > MAX_BODY) { reject(new HttpError(413, 'Zu groß.')); req.destroy(); } else chunks.push(c); });
      req.on('end', () => { if (!chunks.length) return resolve({}); try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new HttpError(400, 'Ungültige Anfrage.')); } });
      req.on('error', reject);
    });
  }

  function serveStatic(req, res, pathname) {
    let rel = pathname === '/' ? '/index.html' : pathname;
    const file = path.normalize(path.join(PUBLIC, rel));
    if (!file.startsWith(PUBLIC + path.sep)) return send(res, 404, 'Nicht gefunden', { 'Content-Type': 'text/plain' });
    fs.readFile(file, (err, data) => {
      if (err) {
        // Unbekannte Pfade -> App (Navigation innerhalb der App)
        if (!path.extname(rel)) return serveStatic(req, res, '/');
        return send(res, 404, 'Nicht gefunden', { 'Content-Type': 'text/plain' });
      }
      const ext = path.extname(file);
      const cache = rel === '/sw.js' || ext === '.html' || ext === '.webmanifest' ? 'no-cache' : 'public, max-age=3600';
      send(res, 200, data, { 'Content-Type': TYPES[ext] || 'application/octet-stream', 'Cache-Control': cache, ...(rel === '/sw.js' ? { 'Service-Worker-Allowed': '/' } : {}) });
    });
  }

  // ---------- Routen ----------
  const routes = [];
  const route = (method, pattern, opts, fn) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), ...opts, fn });

  route('POST', '/api/login', { public: true }, async ({ req, res, body }) => {
    const ip = clientIp(req);
    const r = await auth.login({ user: body.user, password: body.password, code: body.code, ip, ua: req.headers['user-agent'] });
    audit({ user: String(body.user || '').slice(0, 40), action: r.ok ? 'login' : r.locked ? 'login-locked' : 'login-failed', ip });
    if (!r.ok) throw new HttpError(r.locked ? 429 : 401, r.locked ? 'Zu viele Fehlversuche. Bitte 15 Minuten warten.' : 'Benutzer, Passwort oder Code stimmt nicht.');
    const secure = isHttps(req) ? '; Secure' : '';
    res.setHeader('Set-Cookie', `${COOKIE}=${r.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${30 * 86400}${secure}`);
    return { user: r.user, role: r.role };
  });

  route('POST', '/api/logout', { public: true }, ({ req, res }) => {
    auth.logout(cookies(req)[COOKIE]);
    res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
    return { ok: true };
  });

  route('GET', '/api/me', {}, ({ who }) => ({ user: who.user, role: who.role, name: cfg.name, version: VERSION, push: push.publicKey(), devices: push.forUser(who.user), demo }));

  route('GET', '/api/servers', {}, async () => {
    const list = await collect();
    const act = alerts.list();
    return list.map(s => ({ id: s.id, name: s.name, ok: s.ok, error: s.error, metrics: s.metrics, failed: s.failed || [], issues: act.filter(i => i.server === s.id) }));
  });

  route('GET', '/api/s/:id/overview', {}, async ({ params, url }) => {
    const s = server(params.id);
    const o = await s.overview();
    const hours = Math.min(168, Math.max(1, Number(url.searchParams.get('hours')) || 24));
    return { id: s.id, name: s.name, metrics: o.metrics, failed: o.failed, history: s.id === 'local' ? history.range(hours) : (o.history || []), issues: alerts.list().filter(i => i.server === s.id) };
  });
  route('GET', '/api/s/:id/services', {}, ({ params }) => server(params.id).services());
  route('GET', '/api/s/:id/containers', {}, ({ params }) => server(params.id).containers());
  route('GET', '/api/s/:id/services/:name/logs', {}, async ({ params, url }) => ({ text: await server(params.id).serviceLogs(params.name, Number(url.searchParams.get('lines')) || 200) }));
  route('GET', '/api/s/:id/containers/:name/logs', {}, async ({ params, url }) => ({ text: await server(params.id).containerLogs(params.name, Number(url.searchParams.get('lines')) || 200) }));

  route('POST', '/api/s/:id/services/:name/:action', { admin: true }, async ({ params, who, req }) => {
    const s = server(params.id);
    try { await s.serviceAction(params.name, params.action); } catch (err) { throw new HttpError(err.status || 400, err.message); }
    audit({ user: who.user, action: 'service-' + params.action, target: `${s.name}: ${params.name}`, ip: clientIp(req) });
    return { ok: true };
  });
  route('POST', '/api/s/:id/containers/:name/:action', { admin: true }, async ({ params, who, req }) => {
    const s = server(params.id);
    try { await s.containerAction(params.name, params.action); } catch (err) { throw new HttpError(err.status || 400, err.message); }
    audit({ user: who.user, action: 'container-' + params.action, target: `${s.name}: ${params.name}`, ip: clientIp(req) });
    return { ok: true };
  });

  // Ganzen Server neu starten: nur Admin, nur mit frischem 2FA-Code
  route('POST', '/api/s/:id/reboot', { admin: true }, async ({ params, who, body, req }) => {
    if (!cfg.control.reboot) throw new HttpError(403, 'Neustart ist in der Agent-Konfiguration ausgeschaltet.');
    if (!auth.confirmCode(who.user, body.code)) throw new HttpError(403, 'Der Code stimmt nicht.');
    const s = server(params.id);
    audit({ user: who.user, action: 'reboot', target: s.name, ip: clientIp(req) });
    await s.reboot();
    return { ok: true };
  });

  // Live-Logs (Server-Sent Events) – nur für diesen Server
  route('GET', '/api/s/:id/follow', { raw: true }, ({ params, url, req, res }) => {
    if (params.id !== 'local') throw new HttpError(400, 'Live-Logs gibt es nur für den Hauptserver.');
    const kind = url.searchParams.get('kind') === 'container' ? 'container' : 'service';
    const stop = sys.follow(kind, String(url.searchParams.get('name') || ''), line => res.write(`data: ${JSON.stringify(line)}\n\n`));
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no', Connection: 'keep-alive' });
    res.write(': ok\n\n');
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => { clearInterval(ping); stop(); });
  });

  route('POST', '/api/push/subscribe', {}, ({ who, body, req }) => { push.subscribe(who.user, body.subscription, req.headers['user-agent']); return { ok: true, devices: push.forUser(who.user) }; });
  route('POST', '/api/push/unsubscribe', {}, ({ who, body }) => { push.unsubscribe(body.subscription); return { ok: true, devices: push.forUser(who.user) }; });
  route('POST', '/api/push/test', {}, async ({ who }) => ({ sent: await push.send({ title: 'S3cure', body: cfg.language === 'en' ? 'Notifications work ✓' : 'Mitteilungen funktionieren ✓', url: '/' }, { user: who.user }) }));

  route('GET', '/api/audit', { admin: true }, () => readAudit());
  route('GET', '/api/users', { admin: true }, () => auth.listUsers());

  // ---------- Für andere Agenten (Hub) ----------
  route('GET', '/api/agent/overview', { agent: true }, async () => { const o = await local.overview(); return { ...o, history: history.range(24) }; });
  route('GET', '/api/agent/services', { agent: true }, () => local.services());
  route('GET', '/api/agent/containers', { agent: true }, () => local.containers());
  route('GET', '/api/agent/services/:name/logs', { agent: true }, async ({ params, url }) => ({ text: await local.serviceLogs(params.name, Number(url.searchParams.get('lines')) || 200) }));
  route('GET', '/api/agent/containers/:name/logs', { agent: true }, async ({ params, url }) => ({ text: await local.containerLogs(params.name, Number(url.searchParams.get('lines')) || 200) }));
  route('POST', '/api/agent/services/:name/:action', { agent: true }, async ({ params }) => { await local.serviceAction(params.name, params.action); audit({ user: 'hub', action: 'service-' + params.action, target: params.name }); return { ok: true }; });
  route('POST', '/api/agent/containers/:name/:action', { agent: true }, async ({ params }) => { await local.containerAction(params.name, params.action); audit({ user: 'hub', action: 'container-' + params.action, target: params.name }); return { ok: true }; });
  route('POST', '/api/agent/reboot', { agent: true }, async () => { if (!cfg.control.reboot) throw new HttpError(403, 'Neustart ausgeschaltet.'); audit({ user: 'hub', action: 'reboot', target: cfg.name }); local.reboot(); return { ok: true }; });

  function agentOk(req) {
    const m = /^Bearer (.+)$/.exec(String(req.headers.authorization || ''));
    if (!m) return false;
    const a = Buffer.from(m[1]), b = Buffer.from(cfg.agentToken);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    if (!p.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Nicht erlaubt.' });
      return serveStatic(req, res, p);
    }
    try {
      const r = routes.find(x => x.method === req.method && x.re.test(p));
      if (!r) throw new HttpError(404, 'Nicht gefunden.');
      const params = Object.fromEntries(Object.entries(r.re.exec(p).groups || {}).map(([k, v]) => [k, decodeURIComponent(v)]));
      // Änderungen nur mit eigener Kopfzeile (fremde Webseiten können sie nicht setzen)
      if (req.method !== 'GET' && req.headers['x-s3cure'] !== '1') throw new HttpError(403, 'Anfrage abgelehnt.');
      let who = null;
      if (r.agent) { if (!agentOk(req)) throw new HttpError(401, 'Nicht berechtigt.'); }
      else if (!r.public) {
        who = auth.session(cookies(req)[COOKIE]);
        if (!who) throw new HttpError(401, 'Bitte anmelden.');
        if (r.admin && who.role !== 'admin') throw new HttpError(403, 'Dafür brauchst du Admin-Rechte.');
      }
      const body = req.method === 'POST' ? await readBody(req) : {};
      const out = await r.fn({ req, res, url, params, body, who });
      if (!r.raw) send(res, 200, out ?? { ok: true });
    } catch (err) {
      if (res.headersSent) { try { res.end(); } catch {} return; }
      const status = err.status || 500;
      send(res, status, { error: status === 500 ? String(err.message || 'Fehler') : err.message });
    }
  }

  function listen() {
    const srv = http.createServer((req, res) => { handle(req, res).catch(() => { try { res.end(); } catch {} }); });
    srv.headersTimeout = 20000;
    srv.requestTimeout = 120000;
    return new Promise(resolve => srv.listen(cfg.port, cfg.bind, () => {
      sample(); sampler = setInterval(sample, 10000);
      alerts.start();
      resolve(srv);
    }));
  }

  function stop() { clearInterval(sampler); alerts.stop(); history.save(); }
  const reloadConfig = () => { cfg = config.load(); auth.reload(); };

  return { listen, stop, handle, auth, push, reloadConfig, collect, alerts };
}

module.exports = { createAgent, SECURITY_HEADERS, VERSION };
