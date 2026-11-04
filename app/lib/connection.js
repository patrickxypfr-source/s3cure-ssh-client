// Verbindungsaufbau: Anmeldung, Sprung-Server (ProxyJump), Wachhalten und Erkennen von Verbindungsabbrüchen.
// main.js reicht die Hilfsfunktionen herein (Host-Liste, Host-Key-Prüfung, Fragen an die Oberfläche, …).
const fs = require('fs');
const path = require('path');
const { Client, utils } = require('ssh2');

const KEEPALIVE_INTERVAL = 10000; // alle 10 s ein Lebenszeichen an den Server
const KEEPALIVE_COUNT_MAX = 3;    // bleiben 3 unbeantwortet, gilt die Verbindung als verloren
const MAX_JUMPS = 5;
const WIN_AGENT_PIPE = '\\\\.\\pipe\\openssh-ssh-agent';

function createConnection(deps) {
  const { loadHosts, parseTarget, expandHome, ask, verifyHostKey, friendlyError,
    passwords, passphrases, defaultKeys, sessions, send, proxies } = deps;

  // Pro Tab: Anmeldedaten nur im Arbeitsspeicher, damit das automatische Neuverbinden nicht erneut fragt
  const caches = new Map();
  const cacheFor = id => {
    if (!caches.has(id)) caches.set(id, newCache());
    return caches.get(id);
  };
  const newCache = () => ({ passwords: new Map(), passphrases: new Map(), proxy: new Map() });
  const credKey = (target, hostName) => hostName || `${target.user}@${target.host}:${target.port}`;
  const label = hop => hop.hostName || `${hop.target.user}@${hop.target.host}`;

  function agentPath() {
    if (process.env.SSH_AUTH_SOCK) return process.env.SSH_AUTH_SOCK;
    if (process.platform === 'win32' && fs.existsSync(WIN_AGENT_PIPE)) return WIN_AGENT_PIPE;
    return null;
  }

  // ---------- Anmeldung ----------
  // Reihenfolge: SSH-Agent, Schlüsseldateien, dann Passwort (Sitzung -> gespeichert -> nachfragen)
  // opts.keyOnly: nur die Schlüsseldatei aus target.key, kein Agent, kein Passwort (zum Testen)
  function makeAuthHandler(target, hostName, auth, cache, opts = {}) {
    const user = target.user;
    const ckey = credKey(target, hostName);
    const queue = [];
    const agent = opts.keyOnly ? null : agentPath();
    if (agent) queue.push({ type: 'agent' });
    const keyFiles = target.key ? [expandHome(target.key)] : defaultKeys.filter(f => fs.existsSync(f));
    for (const file of keyFiles) queue.push({ type: 'publickey', file });

    async function unlockKey(file, data) {
      const id = path.resolve(file);
      const tryPass = pass => { const k = utils.parseKey(data, pass); return k instanceof Error ? null : k; };
      const mem = cache.passphrases.get(id);
      if (mem != null) { const k = tryPass(mem); if (k) return k; cache.passphrases.delete(id); }
      let rejected = false;
      const saved = passphrases.read(id);
      if (saved != null) {
        const k = tryPass(saved);
        if (k) { cache.passphrases.set(id, saved); return k; }
        passphrases.remove(id); // Passphrase wurde geändert -> alte verwerfen
        rejected = true;
      }
      if (opts.noPrompt) return null;
      for (let i = 0; i < 3; i++) {
        const answer = await ask({
          kind: 'secret',
          title: i ? 'Falsche Passphrase' : rejected ? 'Passphrase geändert?' : 'Schlüssel entsperren',
          message: i ? `Nochmal versuchen. Passphrase für ${path.basename(file)}:`
            : rejected ? `Die gespeicherte Passphrase passt nicht mehr. Bitte neu eingeben für ${path.basename(file)}:`
              : `Der Schlüssel ${path.basename(file)} ist mit einer Passphrase geschützt:`,
          remember: true,
          rememberLabel: 'Passphrase merken (verschlüsselt)',
        });
        if (answer == null) return null;
        const value = typeof answer === 'object' ? answer.value : answer;
        const k = tryPass(value);
        if (k) {
          cache.passphrases.set(id, value);
          if (typeof answer === 'object' && answer.remember) passphrases.write(id, value);
          return k;
        }
      }
      return null;
    }

    async function loadKey(file) {
      let data;
      try { data = fs.readFileSync(file); } catch { return null; }
      let key = utils.parseKey(data);
      if (key instanceof Error && /passphrase|encrypted/i.test(key.message)) key = await unlockKey(file, data);
      if (!key || key instanceof Error) return null;
      return Array.isArray(key) ? key[0] : key;
    }

    let passwordTries = 0;
    let memTried = false;
    let savedTried = false;
    let savedRejected = false;

    async function askPassword() {
      // Vorheriger Versuch wurde abgelehnt -> diese Quelle verwerfen
      if (auth.source === 'memory') cache.passwords.delete(ckey);
      if (auth.source === 'saved') { savedRejected = true; passwords.remove(hostName); }
      auth.source = null;
      if (!memTried) {
        memTried = true;
        const m = cache.passwords.get(ckey);
        if (m != null) { auth.source = 'memory'; auth.lastPassword = m; return m; }
      }
      if (hostName && !savedTried) {
        savedTried = true;
        const saved = passwords.read(hostName);
        if (saved != null) { auth.source = 'saved'; auth.lastPassword = saved; auth.pending = null; return saved; }
      }
      if (opts.noPrompt) return null;
      const again = passwordTries > 0;
      passwordTries++;
      const answer = await ask({
        kind: 'secret',
        title: savedRejected && !again ? 'Passwort geändert?' : again ? 'Falsches Passwort' : 'Anmeldung',
        message: savedRejected && !again
          ? `Das gespeicherte Passwort wurde abgelehnt. Bitte neu eingeben für ${user}@${target.host}:`
          : `${again ? 'Nochmal versuchen. ' : ''}Passwort für ${user}@${target.host}:`,
        remember: !!hostName,
      });
      if (answer == null) return null;
      const value = typeof answer === 'object' ? answer.value : answer;
      auth.source = 'typed';
      auth.lastPassword = value;
      auth.pending = hostName && typeof answer === 'object' && answer.remember ? value : null;
      return value;
    }

    return (methodsLeft, _partial, next) => {
      (async () => {
        const allowed = methodsLeft || ['publickey', 'password', 'keyboard-interactive'];
        while (queue.length) {
          const m = queue.shift();
          if (!allowed.includes('publickey')) continue;
          if (m.type === 'agent') return next({ type: 'agent', username: user, agent });
          const key = await loadKey(m.file);
          if (key) return next({ type: 'publickey', username: user, key });
        }
        if (opts.keyOnly) return next(false);
        if (passwordTries < 3 || !memTried || (hostName && !savedTried)) {
          if (allowed.includes('password')) {
            const pw = await askPassword();
            if (pw == null) return next(false);
            return next({ type: 'password', username: user, password: pw });
          }
          if (allowed.includes('keyboard-interactive')) {
            return next({
              type: 'keyboard-interactive', username: user,
              prompt: async (_name, _instr, _lang, prompts, finish) => {
                const answers = [];
                for (const p of prompts) {
                  const a = /passw/i.test(p.prompt) ? await askPassword()
                    : await ask({ kind: p.echo ? 'text' : 'secret', title: 'Anmeldung', message: p.prompt });
                  if (a == null) return finish([]);
                  answers.push(a);
                }
                finish(answers);
              },
            });
          }
        }
        next(false);
      })().catch(() => next(false));
    };
  }

  // ---------- Verbindung zu einem Server (optional über einen Tunnel-Socket) ----------

  function connectOne(hop, cache, sock, opts) {
    const { target, hostName } = hop;
    const auth = { pending: null, source: null, lastPassword: null };
    return new Promise((resolve, reject) => {
      const client = new Client();
      let hostError = null;
      let settled = false;
      const fail = err => {
        if (settled) return;
        settled = true;
        client.end();
        reject(new Error(hostError || friendlyError(err, target)));
      };
      client.on('ready', () => {
        settled = true;
        // Anmeldung hat geklappt -> Passwort für diese Sitzung behalten, und dauerhaft, falls gewünscht
        if (auth.lastPassword != null) cache.passwords.set(credKey(target, hostName), auth.lastPassword);
        if (hostName && auth.pending != null) passwords.write(hostName, auth.pending);
        resolve(client);
      });
      client.on('error', fail); // bleibt auch nach „ready“ dran, damit Fehler nicht die App beenden
      client.on('close', () => fail(new Error('Verbindung geschlossen')));
      // Agent-Weiterleitung (pro Verbindung, Standard aus): der Server darf den lokalen SSH-Agent benutzen
      const agent = target.agentForward ? agentPath() : null;
      client.connect({
        host: target.host,
        port: target.port,
        username: target.user,
        sock: sock || undefined,
        readyTimeout: 20000,
        ...(agent ? { agent, agentForward: true } : {}),
        keepaliveInterval: KEEPALIVE_INTERVAL,
        keepaliveCountMax: KEEPALIVE_COUNT_MAX,
        hostVerifier: (rawKey, verify) => {
          verifyHostKey(target, rawKey).then(r => {
            if (!r.ok) hostError = r.error;
            verify(r.ok);
          }, () => verify(false));
        },
        authHandler: makeAuthHandler(target, hostName, auth, cache, opts),
      });
    });
  }

  // Sprung-Server auflösen: gespeicherte Verbindung (Name) oder user@host:port, mehrere mit Komma
  function resolveChain(jump, hosts, depth = 0) {
    if (!jump) return [];
    if (depth > MAX_JUMPS) throw new Error('Zu viele Sprung-Server hintereinander. Verweisen sich zwei Verbindungen gegenseitig?');
    const hops = [];
    for (const part of String(jump).split(',').map(s => s.trim()).filter(Boolean)) {
      if (hosts[part]) {
        hops.push(...resolveChain(hosts[part].jump, hosts, depth + 1));
        hops.push({ target: hosts[part], hostName: part });
      } else {
        hops.push({ target: parseTarget(part), hostName: null });
      }
    }
    if (hops.length > MAX_JUMPS) throw new Error('Zu viele Sprung-Server hintereinander.');
    return hops;
  }

  function forward(via, viaHop, target) {
    return new Promise((resolve, reject) => {
      via.forwardOut('127.0.0.1', 0, target.host, target.port, (err, stream) => {
        if (err) reject(new Error(`Sprung-Server ${label(viaHop)} kann ${target.host}:${target.port} nicht erreichen (${err.message}).`));
        else resolve(stream);
      });
    });
  }

  // Verbindet mit target – bei Bedarf über die Sprung-Server – und gibt den angemeldeten Client zurück
  async function connectTo(target, hostName, cache = newCache(), opts = {}) {
    const hops = [...resolveChain(target.jump, loadHosts()), { target, hostName }];
    const clients = [];
    try {
      let sock = null;
      // Proxy (SOCKS5/HTTP) nur für den ersten Server – die weiteren laufen durch den Sprung-Server
      const proxy = proxies && proxies.proxyFor(hops[0].target);
      if (proxy) sock = await proxies.connectVia(proxy, hops[0].target.host, hops[0].target.port, cache.proxy);
      for (let i = 0; i < hops.length; i++) {
        if (i > 0) sock = await forward(clients[i - 1], hops[i - 1], hops[i].target);
        try {
          clients.push(await connectOne(hops[i], cache, sock, i === hops.length - 1 ? opts : {}));
        } catch (err) {
          if (i < hops.length - 1) throw new Error(`Sprung-Server ${label(hops[i])}: ${err.message}`);
          throw err;
        }
      }
    } catch (err) {
      for (const c of clients) c.end();
      throw err;
    }
    const client = clients.pop();
    // Ziel getrennt -> Sprung-Server auch trennen; Sprung-Server weg -> Ziel ist auch weg
    client.on('close', () => { for (const c of clients) c.end(); });
    for (const c of clients) c.on('close', () => client.destroy());
    client.jumps = clients;
    return client;
  }

  // ---------- Terminal-Sitzung für einen Tab ----------
  // Endet die Shell normal (exit), meldet sie 'ssh:closed'. Reißt die Verbindung ab, 'ssh:lost'
  // – dann verbindet die Oberfläche automatisch neu.

  async function openShell(tabId, spec, cols, rows) {
    const target = spec.name ? loadHosts()[spec.name] : parseTarget(spec.text);
    if (!target) throw new Error(`Keine Verbindung namens „${spec.name}“ gespeichert.`);
    const client = await connectTo(target, spec.name || null, cacheFor(tabId));
    let stream;
    try {
      stream = await new Promise((res, rej) => client.shell({ term: 'xterm-256color', cols, rows }, (e, s) => (e ? rej(e) : res(s))));
    } catch (err) {
      client.end();
      throw new Error(friendlyError(err, target));
    }
    const session = { client, stream, hostName: spec.name || null };
    sessions.set(tabId, session);
    let exited = false;
    let reported = false;
    const done = () => {
      if (reported) return;
      reported = true;
      client.end();
      if (sessions.get(tabId) !== session) return; // vom Nutzer geschlossen oder schon ersetzt
      sessions.delete(tabId);
      send(exited ? 'ssh:closed' : 'ssh:lost', tabId);
    };
    stream.on('data', d => send('ssh:data', tabId, d));
    stream.stderr.on('data', d => send('ssh:data', tabId, d));
    stream.on('exit', () => { exited = true; });
    stream.on('close', done);
    client.on('close', done);
    return { user: target.user, host: target.host, port: target.port };
  }

  // Nach dem Aufwachen: Lebt die Verbindung noch? Antwortet der Server nicht schnell, wird sie
  // getrennt – das löst sofort das Neuverbinden aus, statt auf das Wachhalten zu warten.
  function probe(client, timeout = 6000) {
    const timer = setTimeout(() => client.destroy(), timeout);
    try {
      client.exec('true', (err, stream) => {
        if (err && /not connected|no response/i.test(err.message)) { client.destroy(); return; }
        clearTimeout(timer);
        if (stream) { stream.on('data', () => {}); stream.stderr.on('data', () => {}); }
      });
    } catch { clearTimeout(timer); client.destroy(); }
  }

  function probeAll() {
    for (const s of sessions.values()) probe(s.client);
  }

  return { openShell, connectTo, forget: id => caches.delete(id), probeAll, resolveChain };
}

module.exports = { createConnection };
