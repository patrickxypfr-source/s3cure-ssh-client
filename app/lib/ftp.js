// FTP und FTPS (explizit/implizit) als zweiter Verbindungstyp – nur Dateien, kein Terminal.
// Bibliothek: basic-ftp (reines JavaScript).
//
// openFtp() liefert ein Objekt, das sich wie das SFTP-Objekt von ssh2 verhält (dieselben
// Funktionen mit Callback: readdir, stat, mkdir, rename, fastPut, fastGet, …). Dadurch laufen
// Dateiliste, Editor, Übertragungen, Suche und „Mein Computer“ ohne Änderungen auch über FTP.
//
// Eigenheiten von FTP, die hier ausgeglichen werden:
// - Eine FTP-Verbindung kann immer nur einen Befehl gleichzeitig -> Warteschlange.
// - Übertragungen laufen über eine zweite Verbindung, damit die Dateiliste bedienbar bleibt.
// - Server trennen untätige Verbindungen nach einigen Minuten -> beim nächsten Befehl still neu verbinden.
// - Es gibt kein „stat“ -> Eintrag aus der Liste des übergeordneten Ordners (kurz zwischengespeichert).
const fs = require('fs');
const net = require('net');
const tls = require('tls');
const path = require('path');
const { Duplex, Writable, Readable } = require('stream');
const ftp = require('basic-ftp');
const { t } = require('./i18n');

const posix = path.posix;
const TIMEOUT = 30000;
const LIST_CACHE_MS = 4000;

const PROTOCOLS = {
  ftp: { label: 'FTP', port: 21 },
  ftps: { label: 'FTPS', port: 21 },
  'ftps-implicit': { get label() { return t('ftp.protoImplicit'); }, port: 990 }, // Text erst beim Gebrauch (Sprache kann wechseln)
};
const isFtpProtocol = proto => Object.prototype.hasOwnProperty.call(PROTOCOLS, proto || '');

// ftp://user@host:21  ·  ftpes://… = FTPS explizit  ·  ftps://… = FTPS implizit (wie FileZilla)
function parseFtpUrl(text) {
  const m = /^(ftp|ftpes|ftps):\/\/(?:([^@/]*)@)?(\[[^\]]+\]|[^:/]+)(?::(\d+))?\/?$/i.exec(String(text || '').trim());
  if (!m) return null;
  const protocol = { ftp: 'ftp', ftpes: 'ftps', ftps: 'ftps-implicit' }[m[1].toLowerCase()];
  return {
    protocol, user: decodeURIComponent(m[2] || '') || 'anonymous', host: m[3].replace(/^\[|\]$/g, ''),
    port: Number(m[4]) || PROTOCOLS[protocol].port, key: null,
  };
}

// ---------- Fehler ----------

// Muss derselbe Text sein wie in lib/transfers.js (dort wird abgebrochen per Text erkannt)
const cancelText = () => t('transfers.cancelled');
const cancelError = () => Object.assign(new Error(cancelText()), { ftpCancelled: true });

// FTP-Antwortcodes auf die Fehlercodes von SFTP abbilden (2 = gibt es nicht, 3 = keine Berechtigung,
// 4 = fehlgeschlagen) – dann zeigt main.js dieselben verständlichen Meldungen wie bei SFTP.
function mapError(err) {
  if (!err || err.ftpMapped) return err;
  const msg = String(err.message || err);
  let e;
  if (err instanceof ftp.FTPError || typeof err.code === 'number') {
    const code = err.code;
    const text = msg.replace(/^\d{3}[ -]/, '').trim();
    e = new Error(text || msg);
    e.ftpCode = code;
    if (code === 550) {
      if (/denied|permission|not allowed|verweigert|berechtigung/i.test(text)) e.code = 3;
      else if (/exists|not empty|vorhanden|nicht leer/i.test(text)) e.code = 4;
      else if (/no such|not found|not exist|n'existe|nicht gefunden|unavailable/i.test(text)) e.code = 2;
      else e.code = 4;
    }
    else if (code === 553 || code === 532) e.code = 3;
    else if (code === 421) e = new Error(t('ftp.err421'));
    else if (code === 530) e = new Error(t('ftp.loginFailed'));
    else if (code === 500 || code === 502 || code === 504) e = new Error(t('ftp.notSupported', { text }));
    else if (code >= 400) e.code = 4;
  } else {
    e = err instanceof Error ? err : new Error(msg);
  }
  e.ftpMapped = true;
  return e;
}

function friendlyConnectError(err, target) {
  const msg = String(err && err.message || err);
  if (err && err.code === 530) return t('ftp.loginFailed');
  if (/ENOTFOUND|EAI_AGAIN/.test(msg)) return t('ftp.hostNotFound', { host: target.host });
  if (/ECONNREFUSED/.test(msg)) return t('ftp.refused', { host: target.host, port: target.port });
  if (/ETIMEDOUT|Timeout|timed out/i.test(msg)) return t('ftp.timeout', { host: target.host });
  if (/EHOSTUNREACH|ENETUNREACH/.test(msg)) return t('ftp.unreachable', { host: target.host });
  if (/AUTH|TLS|SSL|handshake|wrong version/i.test(msg) && target.protocol !== 'ftp') {
    const variant = target.protocol === 'ftps' ? t('ftp.variantExplicit') : t('ftp.variantImplicit');
    return t('ftp.tlsFailed', { variant })
      + '\n\n' + t('ftp.techDetails', { details: msg.split('\n')[0].replace(/^[0-9A-F]{8,}:error:[0-9A-F]+:/, '').slice(0, 160) });
  }
  return t('ftp.connectFailed', { msg });
}

// ---------- Aktiver Modus ----------
// basic-ftp kann nur passiv. Für den aktiven Modus wartet die App selbst auf die Datenverbindung
// des Servers (PORT/EPRT). Bis der Server sich meldet, nimmt ein Platzhalter-Stream die Daten an.

class ActiveDataSocket extends Duplex {
  constructor(server, ctx) {
    super();
    this.server = server;
    this.ctx = ctx;
    this.real = null;
    this.waiting = [];
    this.timeoutMs = 0;
  }
  get bytesRead() { return this.real ? this.real.bytesRead : 0; }
  get bytesWritten() { return this.real ? this.real.bytesWritten : 0; }
  get remoteAddress() { return this.real ? this.real.remoteAddress : undefined; }
  get remotePort() { return this.real ? this.real.remotePort : undefined; }
  setTimeout(ms) { this.timeoutMs = ms; if (this.real) this.real.setTimeout(ms); return this; }
  attach(raw) {
    let sock = raw;
    if (this.ctx.socket instanceof tls.TLSSocket) {
      // Auch im aktiven Modus ist die App der TLS-Client (RFC 4217)
      sock = tls.connect({ ...this.ctx.tlsOptions, socket: raw, session: this.ctx.socket.getSession() });
    }
    this.real = sock;
    sock.setTimeout(this.timeoutMs);
    sock.on('timeout', () => this.emit('timeout'));
    sock.on('error', err => this.destroy(err));
    sock.on('data', d => { if (!this.push(d)) sock.pause(); });
    sock.on('end', () => this.push(null));
    const ready = () => { const w = this.waiting; this.waiting = []; w.forEach(fn => fn()); };
    if (sock instanceof tls.TLSSocket) sock.once('secureConnect', ready); else ready();
  }
  whenReady(fn) { if (this.real && this.waiting.length === 0 && (!(this.real instanceof tls.TLSSocket) || this.real.getCipher())) fn(); else this.waiting.push(fn); }
  _read() { if (this.real) this.real.resume(); }
  _write(chunk, enc, cb) { this.whenReady(() => this.real.write(chunk, enc, cb)); }
  _final(cb) { this.whenReady(() => this.real.end(cb)); }
  _destroy(err, cb) {
    try { this.server.close(); } catch {}
    if (this.real) this.real.destroy();
    cb(err);
  }
}

async function enterActiveMode(ctx) {
  const local = String(ctx.socket.localAddress || '').replace(/^::ffff:/, '');
  const v6 = net.isIPv6(local);
  const server = net.createServer();
  await new Promise((res, rej) => { server.once('error', rej); server.listen(0, local, res); });
  const port = server.address().port;
  const data = new ActiveDataSocket(server, ctx);
  const timer = setTimeout(() => data.destroy(new Error(t('ftp.activeNoData'))), ctx.timeout || TIMEOUT);
  server.once('connection', sock => { clearTimeout(timer); server.close(); data.attach(sock); });
  try {
    if (v6) await ctx.request(`EPRT |2|${local}|${port}|`);
    else await ctx.request(`PORT ${local.split('.').join(',')},${port >> 8},${port & 255}`);
  } catch (err) {
    clearTimeout(timer);
    server.close();
    throw err;
  }
  ctx.dataSocket = data;
  return {};
}

// ---------- Einträge aus der Ordnerliste ----------

const MONTHS = { jan: 0, feb: 1, mar: 2, mär: 2, apr: 3, may: 4, mai: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, okt: 9, nov: 10, dec: 11, dez: 11 };

// Zeit aus der Liste: MLSD liefert sie genau, LIST nur als Text („Nov 04 12:30“, „Nov 04 2025“, „11-04-25 12:30PM“)
function parseTime(info) {
  if (info.modifiedAt instanceof Date && !isNaN(info.modifiedAt)) return info.modifiedAt.getTime();
  const raw = String(info.rawModifiedAt || '').trim();
  let m = /^([A-Za-zä]{3})\s+(\d{1,2})\s+(?:(\d{4})|(\d{1,2}):(\d{2}))$/.exec(raw);
  if (m) {
    const mon = MONTHS[m[1].toLowerCase()];
    if (mon === undefined) return 0;
    const now = new Date();
    if (m[3]) return new Date(Number(m[3]), mon, Number(m[2])).getTime();
    let d = new Date(now.getFullYear(), mon, Number(m[2]), Number(m[4]), Number(m[5]));
    if (d.getTime() > now.getTime() + 86400000) d = new Date(now.getFullYear() - 1, mon, Number(m[2]), Number(m[4]), Number(m[5]));
    return d.getTime();
  }
  m = /^(\d{1,2})-(\d{1,2})-(\d{2,4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)?$/i.exec(raw);
  if (m) {
    let year = Number(m[3]);
    if (year < 100) year += year < 70 ? 2000 : 1900;
    let hour = Number(m[4]) % (m[6] ? 12 : 24);
    if (m[6] && m[6].toUpperCase() === 'PM') hour += 12;
    return new Date(year, Number(m[1]) - 1, Number(m[2]), hour, Number(m[5])).getTime();
  }
  return 0;
}

const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;

// Stats-Objekt wie bei ssh2 (mode, size, mtime in Sekunden, isDirectory() …)
function makeStats({ isDir, isLink = false, size = 0, mtimeMs = 0, perms = null }) {
  const type = isLink ? S_IFLNK : isDir ? S_IFDIR : S_IFREG;
  const mode = type | (perms == null ? 0 : perms);
  const mtime = Math.floor(mtimeMs / 1000);
  return {
    mode, size, mtime, atime: mtime, uid: 0, gid: 0, permsKnown: perms != null,
    isDirectory: () => isDir && !isLink, isFile: () => !isDir && !isLink, isSymbolicLink: () => isLink,
  };
}

function statsFromInfo(info) {
  const p = info.permissions;
  const perms = p && [p.user, p.group, p.world].every(n => Number.isInteger(n)) ? (p.user << 6) | (p.group << 3) | p.world : null;
  return makeStats({
    isDir: info.type === ftp.FileType.Directory, isLink: info.type === ftp.FileType.SymbolicLink,
    size: info.size || 0, mtimeMs: parseTime(info), perms,
  });
}

const checkPath = p => {
  if (typeof p !== 'string' || /[\r\n\0]/.test(p)) throw new Error(t('ftp.badPath'));
  return p;
};

// ---------- Verbindung ----------
// target: { protocol, host, port, user, ftpPassive (Standard an), ftpInsecure }
// deps: { ask, passwords: { read, write, remove }, certs: { get, set }, cache: Map (Passwörter dieses Tabs), hostName }

async function openFtp(target, deps) {
  const { ask, passwords, certs, hostName } = deps;
  const cache = deps.cache || new Map();
  const credKey = hostName || `${target.user}@${target.host}:${target.port}`;
  const proto = target.protocol;
  const secure = proto === 'ftps' || proto === 'ftps-implicit';
  const passive = target.ftpPassive !== false;
  const state = { closed: false, password: null, home: '/', sessionTrust: null };

  // TLS: Zertifikat erst nach dem Aufbau prüfen – vor dem Senden des Passworts
  async function checkCertificate(socket) {
    if (!(socket instanceof tls.TLSSocket)) return;
    if (target.ftpInsecure) return; // Nutzer hat „Zertifikat trotzdem akzeptieren“ gewählt
    if (socket.authorized) return;
    const cert = socket.getPeerCertificate() || {};
    const fp = cert.fingerprint256 || '';
    const id = `${target.host}:${target.port}`;
    if (fp && state.sessionTrust === fp) return;
    const saved = certs.get(id);
    if (saved && saved.fingerprint === fp) { state.sessionTrust = fp; return; }
    const reasonKey = {
      DEPTH_ZERO_SELF_SIGNED_CERT: 'ftp.certSelfSigned',
      SELF_SIGNED_CERT_IN_CHAIN: 'ftp.certSelfSignedChain',
      UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'ftp.certNoIntermediate',
      CERT_HAS_EXPIRED: 'ftp.certExpired',
      ERR_TLS_CERT_ALTNAME_INVALID: 'ftp.certWrongHost',
    }[socket.authorizationError] || 'ftp.certUntrusted';
    const reason = t(reasonKey, { host: target.host, error: socket.authorizationError });
    const name = s => (s && (s.CN || s.O)) || '–';
    const detail = reason + '\n\n' + t('ftp.certDetail', { subject: name(cert.subject), issuer: name(cert.issuer), validTo: cert.valid_to || '–', fp });
    const changed = saved && saved.fingerprint !== fp;
    const ok = await ask({
      kind: 'confirm',
      title: changed ? t('ftp.certChangedTitle') : t('ftp.certUnknownTitle'),
      message: changed ? t('ftp.certChanged', { id }) : t('ftp.certUnknown', { id }),
      detail: detail + (changed ? '\n\n' + t('ftp.certPrevious', { fp: saved.fingerprint }) : '') + '\n\n' + t('ftp.certTrustQ'),
      okLabel: t('ftp.certTrustOk'),
      danger: !!changed,
    });
    if (!ok) throw Object.assign(new Error(t('ftp.certRejected')), { userAbort: true });
    state.sessionTrust = fp;
    certs.set(id, { fingerprint: fp, subject: name(cert.subject), savedAt: new Date().toISOString() });
  }

  // Verbindung aufbauen und (bei FTPS) das Zertifikat prüfen – noch ohne Anmeldung
  async function open() {
    const client = new ftp.Client(TIMEOUT);
    if (!passive) client.prepareTransfer = enterActiveMode;
    const tlsOptions = { rejectUnauthorized: false, servername: net.isIP(target.host) ? undefined : target.host };
    try {
      if (proto === 'ftps-implicit') await client.connectImplicitTLS(target.host, target.port, tlsOptions);
      else await client.connect(target.host, target.port);
      if (proto === 'ftps') await client.useTLS(tlsOptions);
      await checkCertificate(client.ftp.socket);
      return client;
    } catch (err) {
      client.close();
      throw err;
    }
  }

  async function auth(client, password) {
    try {
      await client.login(target.user || 'anonymous', password == null ? '' : password);
      await client.useDefaultSettings();
    } catch (err) {
      if (!(err instanceof ftp.FTPError && err.code === 530)) client.close();
      throw err;
    }
  }

  // Neue angemeldete Verbindung (weitere Verbindungen und Neuverbinden nach Zeitüberschreitung)
  async function login(password) {
    const client = await open();
    try { await auth(client, password); } catch (err) { client.close(); throw err; }
    return client;
  }

  // Erste Anmeldung: erst verbinden, dann Passwort aus der Sitzung, gespeichert oder nachfragen (bis zu 3 Versuche)
  async function firstLogin() {
    const sources = [];
    if (cache.has(credKey)) sources.push({ from: 'memory', value: cache.get(credKey) });
    const saved = hostName ? passwords.read(hostName) : null;
    if (saved != null) sources.push({ from: 'saved', value: saved });
    if (!sources.length && /^(anonymous|ftp)$/i.test(target.user || '')) sources.push({ from: 'anonymous', value: 'anonymous@' });
    let tries = 0;
    let savedRejected = false;
    let client = null;
    try {
      for (;;) {
        if (!client || client.closed) {
          try { client = await open(); } catch (err) { if (err.userAbort) throw err; throw new Error(friendlyConnectError(err, target)); }
        }
        let src = sources.shift();
        if (!src) {
          const again = tries > 0;
          const answer = await ask({
            kind: 'secret',
            title: savedRejected && !again ? t('ftp.pwChangedTitle') : again ? t('ftp.pwWrongTitle') : t('ftp.loginTitle'),
            message: t(savedRejected && !again ? 'ftp.pwSavedRejected' : again ? 'ftp.pwPromptAgain' : 'ftp.pwPrompt',
              { user: target.user, host: target.host }),
            remember: !!hostName,
          });
          if (answer == null) throw Object.assign(new Error(t('ftp.loginCancelled')), { userAbort: true });
          tries++;
          src = typeof answer === 'object' ? { from: 'typed', value: answer.value, remember: answer.remember } : { from: 'typed', value: answer };
        }
        try {
          // Hat der Server die Verbindung beim Warten auf die Eingabe getrennt? Dann neu aufbauen.
          if (client.closed) client = await open();
          await auth(client, src.value);
          state.password = src.value;
          cache.set(credKey, src.value);
          if (hostName && src.from === 'typed' && src.remember) passwords.write(hostName, src.value);
          const done = client;
          client = null;
          return done;
        } catch (err) {
          if (err.userAbort) throw err;
          if (!(err instanceof ftp.FTPError && err.code === 530)) throw new Error(friendlyConnectError(err, target));
          if (src.from === 'memory') cache.delete(credKey);
          if (src.from === 'saved') { savedRejected = true; passwords.remove(hostName); }
          if (tries >= 3) throw new Error(friendlyConnectError(err, target));
        }
      }
    } finally {
      if (client) client.close();
    }
  }

  // Eine „Spur“ = eine FTP-Verbindung mit Warteschlange. Getrennt? Beim nächsten Befehl neu verbinden.
  function createLane(initial) {
    let client = initial;
    let chain = Promise.resolve();
    const ensure = async () => {
      if (state.closed) throw new Error(t('ftp.noConnection'));
      if (!client || client.closed) {
        client = null;
        try { client = await login(state.password); } catch (err) { throw new Error(friendlyConnectError(err, target)); }
      }
      return client;
    };
    const lane = {
      run(fn) {
        const job = chain.then(async () => {
          let c = await ensure();
          const ctl = { aborted: false };
          try { return await fn(c, ctl); } catch (err) {
            // Verbindung war still weg (Zeitüberschreitung des Servers) -> einmal neu versuchen
            const dropped = c.closed && !ctl.aborted && !state.closed && !(err instanceof ftp.FTPError && err.code !== 421);
            if (!dropped) throw err;
            client = null;
            c = await ensure();
            return fn(c, ctl);
          }
        });
        chain = job.catch(() => {});
        return job;
      },
      drop() { if (client) { client.close(); client = null; } },
      close() { lane.drop(); },
    };
    return lane;
  }

  const firstClient = await firstLogin();
  try { state.home = await firstClient.pwd() || '/'; } catch {}
  const main = createLane(firstClient);
  const xfer = createLane(null); // eigene Verbindung für Übertragungen, erst bei Bedarf

  // ---------- Ordnerlisten mit kurzem Zwischenspeicher ----------

  const listCache = new Map(); // Ordner -> { at, list }
  const forget = p => { listCache.delete(posix.dirname(p)); listCache.delete(p); };
  const forgetAll = () => listCache.clear();
  const abs = p => (p.startsWith('/') ? posix.normalize(p) : posix.join(state.home, p));

  async function listDir(c, dir) {
    await c.cd(dir);
    const list = (await c.list()).filter(i => i.name !== '.' && i.name !== '..' && !i.name.includes('/'));
    listCache.set(dir, { at: Date.now(), list });
    return list;
  }

  function cachedList(dir) {
    const hit = listCache.get(dir);
    if (hit && Date.now() - hit.at < LIST_CACHE_MS) return Promise.resolve(hit.list);
    return main.run(c => listDir(c, dir));
  }

  const isDirByCd = file => main.run(c => c.cd(file).then(() => true, err => {
    if (err instanceof ftp.FTPError) return false;
    throw err;
  }));

  async function statPath(file, follow) {
    file = abs(checkPath(file));
    if (file === '/' ) return makeStats({ isDir: true });
    const dir = posix.dirname(file);
    const name = posix.basename(file);
    let list = null;
    try { list = await cachedList(dir); } catch (err) { if (!(err instanceof ftp.FTPError)) throw err; }
    const info = list && list.find(i => i.name === name);
    if (info) {
      const st = statsFromInfo(info);
      if (info.type === ftp.FileType.SymbolicLink && follow) {
        const isDir = await isDirByCd(file);
        return makeStats({ isDir, size: info.size || 0, mtimeMs: parseTime(info) });
      }
      if (info.type === ftp.FileType.Unknown && follow) return makeStats({ isDir: await isDirByCd(file), size: info.size || 0, mtimeMs: parseTime(info) });
      return st;
    }
    // Übergeordneter Ordner nicht lesbar? Dann wenigstens prüfen, ob es ein Ordner ist
    if (!list && await isDirByCd(file)) return makeStats({ isDir: true });
    throw Object.assign(new Error(t('ftp.notFound')), { code: 2, ftpMapped: true });
  }

  // ---------- Schreib-Handles (für den Editor: open/write/close) ----------

  const handles = new Map();
  let handleSeq = 0;

  // Callback-Hilfe: Promise -> cb(err, result), Fehler mit SFTP-Codes
  const cbify = (promise, cb) => {
    promise.then(r => cb && cb(null, r), err => cb && cb(mapError(err)));
  };
  const lastCb = args => (typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null);

  async function uploadBuffer(remote, buf) {
    await main.run(c => c.uploadFrom(Readable.from([buf]), remote));
    forget(remote);
  }

  async function siteChmod(file, mode) {
    await main.run(c => c.send(`SITE CHMOD ${(mode & 0o7777).toString(8).padStart(3, '0')} ${file}`));
    forget(file);
  }

  // Übertragung mit Fortschritt und Abbrechen (opts.cancelled kommt aus lib/transfers.js)
  function transfer(kind, remote, local, opts = {}) {
    return xfer.run(async (c, ctl) => {
      const cancelled = typeof opts.cancelled === 'function' ? opts.cancelled : () => false;
      if (cancelled()) throw cancelError();
      c.trackProgress(info => {
        if (typeof opts.step === 'function') opts.step(info.bytesOverall);
        if (cancelled() && !ctl.aborted) { ctl.aborted = true; c.close(); }
      });
      // auch ohne neue Daten regelmäßig auf „Abbrechen“ prüfen
      const poll = setInterval(() => { if (cancelled() && !ctl.aborted) { ctl.aborted = true; c.close(); } }, 300);
      try {
        if (kind === 'put') await c.uploadFrom(local, remote);
        else await c.downloadTo(local, remote);
      } catch (err) {
        if (ctl.aborted) throw cancelError();
        throw err;
      } finally {
        clearInterval(poll);
        c.trackProgress();
      }
      if (kind === 'put') forget(remote);
    });
  }

  const adapter = {
    isFtp: true,
    protocol: proto,
    label: PROTOCOLS[proto].label,

    realpath(p, cb) { cbify(Promise.resolve().then(() => (p === '.' || p === '' ? state.home : abs(checkPath(p)))), cb); },

    readdir(dir, cb) {
      cbify((async () => {
        const d = abs(checkPath(dir));
        const list = await main.run(c => listDir(c, d));
        return list.map(info => ({ filename: info.name, longname: '', attrs: statsFromInfo(info) }));
      })(), cb);
    },

    stat(file, cb) { cbify(statPath(file, true), cb); },
    lstat(file, cb) { cbify(statPath(file, false), cb); },

    mkdir(dir, ...rest) {
      cbify(main.run(c => c.send('MKD ' + checkPath(dir))).then(() => { forget(dir); }), lastCb(rest));
    },
    rmdir(dir, cb) { cbify(main.run(c => c.removeEmptyDir(checkPath(dir))).then(() => { forget(dir); }), cb); },
    unlink(file, cb) { cbify(main.run(c => c.remove(checkPath(file))).then(() => { forget(file); }), cb); },
    rename(from, to, cb) {
      cbify(main.run(c => c.rename(checkPath(from), checkPath(to))).then(() => { forget(from); forget(to); }), cb);
    },
    ext_openssh_rename(_from, _to, cb) { process.nextTick(cb, new Error(t('ftp.notAvailable'))); },

    // Rechte per SITE CHMOD (können nicht alle Server)
    chmod(file, mode, cb) {
      cbify(siteChmod(checkPath(file), mode).catch(err => {
        if (err instanceof ftp.FTPError && err.code >= 500 && err.code < 550) throw new Error(t('ftp.chmodNotAllowed'));
        throw err;
      }), cb);
    },
    setstat(file, attrs, cb) { if (attrs && attrs.mode != null) adapter.chmod(file, attrs.mode, cb); else process.nextTick(cb, null); },

    // Nur Schreiben wird unterstützt (Lesen: readStart)
    open(file, flags, ...rest) {
      const cb = lastCb(rest);
      cbify((async () => {
        checkPath(file);
        if (!/^w/.test(flags)) throw new Error(t('ftp.notAvailable'));
        if (flags.includes('x')) {
          let exists = false;
          try { await statPath(file, false); exists = true; } catch {}
          if (exists) throw Object.assign(new Error(t('ftp.exists')), { code: 4, ftpMapped: true });
        }
        const h = Buffer.from(`ftp${++handleSeq}`);
        handles.set(h.toString(), { file, chunks: [], mode: 0 });
        return h;
      })(), cb);
    },
    write(handle, buf, off, len, pos, cb) {
      const h = handles.get(handle.toString());
      if (!h) return process.nextTick(cb, new Error(t('ftp.badHandle')));
      h.chunks.push({ pos, data: Buffer.from(buf.subarray(off, off + len)) });
      process.nextTick(cb, null);
    },
    fchmod(handle, mode, cb) {
      const h = handles.get(handle.toString());
      if (h) h.mode = mode & 0o7777;
      process.nextTick(cb, null);
    },
    fchown(_handle, _uid, _gid, cb) { process.nextTick(cb, new Error(t('ftp.notAvailable'))); },
    close(handle, cb) {
      const key = handle.toString();
      const h = handles.get(key);
      handles.delete(key);
      if (!h) return process.nextTick(cb, null);
      cbify((async () => {
        const size = h.chunks.reduce((n, c) => Math.max(n, c.pos + c.data.length), 0);
        const buf = Buffer.alloc(size);
        for (const c of h.chunks) c.data.copy(buf, c.pos);
        await uploadBuffer(h.file, buf);
        // 0 = Rechte unbekannt (Server liefert keine) -> nichts ändern statt Datei unlesbar zu machen
        if (h.mode) await siteChmod(h.file, h.mode).catch(() => {});
      })(), cb);
    },

    // Anfang einer Datei lesen (Editor, Vorschau). Ist die Datei größer, wird die Übertragung
    // abgebrochen und die Verbindung beim nächsten Befehl neu aufgebaut.
    readStart(file, max) {
      return main.run(async (c, ctl) => {
        const parts = [];
        let got = 0;
        const sink = new Writable({
          write(chunk, _enc, done) {
            if (got < max) { parts.push(chunk.subarray(0, max - got)); got += Math.min(chunk.length, max - got); }
            if (got >= max && !ctl.aborted) { ctl.aborted = true; setImmediate(() => c.close()); }
            done();
          },
        });
        try { await c.downloadTo(sink, checkPath(file)); } catch (err) { if (!ctl.aborted) throw mapError(err); }
        return Buffer.concat(parts, got);
      });
    },

    fastPut(local, remote, opts, cb) {
      if (typeof opts === 'function') { cb = opts; opts = {}; }
      cbify(transfer('put', checkPath(remote), local, opts), cb);
    },
    fastGet(remote, local, opts, cb) {
      if (typeof opts === 'function') { cb = opts; opts = {}; }
      cbify(transfer('get', checkPath(remote), local, opts).catch(err => {
        // halb geschriebene lokale Datei bei Fehlern nicht liegen lassen
        if (!err.ftpCancelled) { try { fs.unlinkSync(local); } catch {} }
        throw err;
      }), cb);
    },

    refresh: forgetAll,
    end() {
      state.closed = true;
      main.close();
      xfer.close();
    },
  };
  return adapter;
}

// Gemerkte Zertifikate (wie known_hosts bei SSH): { "host:port": { fingerprint, subject, savedAt } }
function createCertStore(file) {
  const load = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } };
  return {
    get: id => load()[id] || null,
    set(id, entry) {
      const all = load();
      all[id] = entry;
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, JSON.stringify(all, null, 2), { mode: 0o600 });
    },
  };
}

module.exports = {
  openFtp, parseFtpUrl, isFtpProtocol, createCertStore, PROTOCOLS, mapError, parseTime,
  get CANCEL_TEXT() { return cancelText(); }, // Text in der aktuellen Sprache
};
