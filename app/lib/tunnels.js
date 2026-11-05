// S3cure SSH Client – Port-Weiterleitung (Tunnel) im Hauptprozess
//
// Tunnel werden pro gespeicherter Verbindung in hosts.json gespeichert:
//   hosts[name].tunnels = [{ id, type, name, localPort, targetHost, targetPort, remotePort, web, autoStart }]
// Arten:
//   local   – 127.0.0.1:<localPort> auf diesem Rechner  -> <targetHost>:<targetPort> vom Server aus (forwardOut)
//   remote  – Port <remotePort> auf dem Server          -> <targetHost>:<targetPort> von diesem Rechner aus (forwardIn)
//   dynamic – SOCKS5-Proxy auf 127.0.0.1:<localPort>, Ziel bestimmt das Programm (z. B. Browser)
// Lokale Ports werden immer nur an 127.0.0.1 gebunden (nicht im Netzwerk erreichbar).
const net = require('net');
const crypto = require('crypto');
const i18n = require('./i18n'); // i18n.t – „t“ ist hier oft ein Tunnel

const LOCAL_BIND = '127.0.0.1';
const TYPES = ['local', 'remote', 'dynamic'];
const WEB = ['', 'http', 'https'];

// ---------- Gespeicherte Tunnel ----------

const isPort = n => Number.isInteger(n) && n >= 1 && n <= 65535;

// Eingaben prüfen und vereinheitlichen; wirft eine verständliche Fehlermeldung
function normalizeTunnel(t) {
  const type = TYPES.includes(t.type) ? t.type : 'local';
  const out = {
    id: typeof t.id === 'string' && t.id ? t.id : crypto.randomUUID(),
    type,
    name: String(t.name || '').trim().slice(0, 80),
    autoStart: !!t.autoStart,
  };
  const num = v => (v === '' || v == null ? NaN : Number(v));
  if (type === 'local' || type === 'dynamic') {
    out.localPort = num(t.localPort);
    if (!isPort(out.localPort)) throw new Error(i18n.t('tunnels.errLocalPort'));
  }
  if (type === 'remote') {
    out.remotePort = num(t.remotePort);
    if (!isPort(out.remotePort)) throw new Error(i18n.t('tunnels.errRemotePort'));
  }
  if (type === 'local' || type === 'remote') {
    out.targetHost = String(t.targetHost || '').trim() || (type === 'local' ? 'localhost' : '127.0.0.1');
    if (/\s/.test(out.targetHost)) throw new Error(i18n.t('tunnels.errTargetSpace'));
    out.targetPort = num(t.targetPort);
    if (!isPort(out.targetPort)) throw new Error(i18n.t('tunnels.errTargetPort'));
  }
  if (type === 'local') out.web = WEB.includes(t.web) ? t.web : '';
  return out;
}

// Ältere hosts.json ohne Tunnel -> leere Liste; kaputte Einträge werden übersprungen
function tunnelsOf(host) {
  if (!host || !Array.isArray(host.tunnels)) return [];
  const list = [];
  for (const t of host.tunnels) { try { list.push(normalizeTunnel(t || {})); } catch { /* ungültig */ } }
  return list;
}

function describe(t) {
  if (t.type === 'local') return `localhost:${t.localPort} → ${t.targetHost}:${t.targetPort}`;
  if (t.type === 'remote') return i18n.t('tunnels.descRemote', { remotePort: t.remotePort, host: t.targetHost, port: t.targetPort });
  return i18n.t('tunnels.descDynamic', { port: t.localPort });
}

// ---------- Laufende Tunnel ----------

function friendlyListenError(err, port) {
  if (err && err.code === 'EADDRINUSE') return i18n.t('tunnels.errInUse', { port });
  if (err && err.code === 'EACCES') return i18n.t('tunnels.errAccess', { port });
  return i18n.t('tunnels.errStart', { error: err && err.message || err });
}

function friendlyForwardError(err, host, port) {
  const msg = String(err && err.message || err);
  if (/Connection refused|ECONNREFUSED/i.test(msg)) return i18n.t('tunnels.errRefused', { host, port });
  if (/administratively prohibited|prohibited/i.test(msg)) return i18n.t('tunnels.errProhibited');
  if (/not found|ENOTFOUND|resolve/i.test(msg)) return i18n.t('tunnels.errNotFound', { host });
  if (/Not connected|No response/i.test(msg)) return i18n.t('tunnels.errConnGone');
  return i18n.t('tunnels.errUnreachable', { host, port, error: msg });
}

// sendTab(tabId, channel, ...args): nur an das Fenster dieses Tabs (app/lib/windows.js)
function createTunnelManager({ ipcMain, shell, getWin, sendTab, getSession, loadHosts, saveHosts }) {
  // Tab-ID -> { hostName, client, running: Map(tunnelId -> Lauf), onTcp }
  const tabs = new Map();

  const send = (channel, tabId, ...args) => {
    if (sendTab) { sendTab(tabId, channel, tabId, ...args); return; }
    const win = getWin();
    if (win && !win.isDestroyed()) win.webContents.send(channel, tabId, ...args);
  };

  function tabState(tabId) {
    let st = tabs.get(tabId);
    const s = getSession(tabId);
    if (st && s && st.client !== s.client) { stopAll(tabId); st = null; }
    if (!st) {
      if (!s) return null;
      st = { hostName: s.hostName || null, client: s.client, running: new Map(), remoteByPort: new Map(), onTcp: null };
      tabs.set(tabId, st);
      // Bricht die SSH-Verbindung ab, gehen alle Tunnel dieses Tabs aus
      s.client.once('close', () => { if (tabs.get(tabId) === st) stopAll(tabId); });
    }
    return st;
  }

  // Status für die Oberfläche (gespeicherte Tunnel + was gerade läuft)
  function status(tabId) {
    const s = getSession(tabId);
    const st = tabs.get(tabId);
    const hostName = s?.hostName || st?.hostName || null;
    const saved = hostName ? tunnelsOf(loadHosts()[hostName]) : [];
    const list = saved.map(t => {
      const r = st?.running.get(t.id);
      return {
        ...t, text: describe(t),
        state: r ? r.state : 'off', error: r?.error || null, warning: r?.warning || null,
        active: r ? r.sockets.size : 0, total: r ? r.total : 0, boundPort: r?.boundPort || null,
      };
    });
    return { hostName, connected: !!s, tunnels: list };
  }

  // Änderungen an die Oberfläche melden (Zähler gebündelt, max. ~5x pro Sekunde)
  const timers = new Map();
  function notify(tabId, now = false) {
    if (now) { clearTimeout(timers.get(tabId)); timers.delete(tabId); send('tunnels:status', tabId, status(tabId)); return; }
    if (timers.has(tabId)) return;
    timers.set(tabId, setTimeout(() => { timers.delete(tabId); send('tunnels:status', tabId, status(tabId)); }, 200));
  }

  function track(tabId, run, sock, other) {
    run.sockets.add(sock);
    run.total++;
    notify(tabId);
    const done = () => {
      if (run.sockets.delete(sock)) notify(tabId);
      sock.destroy();
      if (other) other.destroy();
    };
    sock.on('close', done);
    sock.on('error', done);
    if (other) { other.on('close', done); other.on('error', done); }
  }

  // Lokaler Port (local + dynamic)
  function listenLocal(tabId, st, run, handler) {
    return new Promise(resolve => {
      const server = net.createServer({ pauseOnConnect: true }, sock => handler(sock));
      run.server = server;
      server.once('error', err => {
        run.state = 'error';
        run.error = friendlyListenError(err, run.cfg.localPort);
        resolve();
      });
      server.listen({ host: LOCAL_BIND, port: run.cfg.localPort, exclusive: true }, () => {
        run.state = 'active';
        run.boundPort = server.address().port;
        server.on('error', () => {});
        resolve();
      });
    });
  }

  function forward(tabId, st, run, sock, host, port, onReady) {
    st.client.forwardOut(sock.remoteAddress || LOCAL_BIND, sock.remotePort || 0, host, port, (err, channel) => {
      if (err) {
        run.warning = friendlyForwardError(err, host, port);
        notify(tabId);
        if (onReady) onReady(err);
        sock.destroy();
        return;
      }
      if (run.stopped) { channel.close(); sock.destroy(); return; }
      run.warning = null;
      if (onReady) onReady(null);
      track(tabId, run, sock, channel);
      sock.pipe(channel).pipe(sock);
      sock.resume();
    });
  }

  function startLocal(tabId, st, run) {
    const { targetHost, targetPort } = run.cfg;
    return listenLocal(tabId, st, run, sock => forward(tabId, st, run, sock, targetHost, targetPort));
  }

  // Einfacher SOCKS5-Server (nur CONNECT, ohne Anmeldung – er hört ja nur auf 127.0.0.1)
  function startDynamic(tabId, st, run) {
    return listenLocal(tabId, st, run, sock => {
      sock.resume();
      let buf = Buffer.alloc(0);
      let phase = 'greet';
      sock.setTimeout(15000, () => sock.destroy());
      const reply = code => Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0]);
      const onData = chunk => {
        buf = Buffer.concat([buf, chunk]);
        if (phase === 'greet') {
          if (buf.length < 2) return;
          if (buf[0] !== 5) return sock.destroy(); // nur SOCKS5
          const n = buf[1];
          if (buf.length < 2 + n) return;
          const methods = buf.subarray(2, 2 + n);
          buf = buf.subarray(2 + n);
          if (!methods.includes(0)) { sock.end(Buffer.from([5, 0xff])); return; }
          sock.write(Buffer.from([5, 0]));
          phase = 'request';
        }
        if (phase === 'request') {
          if (buf.length < 5) return;
          const [ver, cmd, , atyp] = buf;
          if (ver !== 5) return sock.destroy();
          let host, end;
          if (atyp === 1) { end = 4 + 4; if (buf.length < end + 2) return; host = [...buf.subarray(4, 8)].join('.'); }
          else if (atyp === 3) { const len = buf[4]; end = 5 + len; if (buf.length < end + 2) return; host = buf.subarray(5, end).toString('utf8'); }
          else if (atyp === 4) {
            end = 4 + 16; if (buf.length < end + 2) return;
            const b = buf.subarray(4, 20);
            host = Array.from({ length: 8 }, (_, i) => b.readUInt16BE(i * 2).toString(16)).join(':');
          } else { sock.end(reply(8)); return; }
          const port = buf.readUInt16BE(end);
          const rest = buf.subarray(end + 2);
          if (cmd !== 1) { sock.end(reply(7)); return; } // nur CONNECT
          phase = 'connecting';
          sock.removeListener('data', onData);
          sock.setTimeout(0);
          sock.pause();
          forward(tabId, st, run, sock, host, port, err => {
            if (err) { try { sock.end(reply(/refused/i.test(err.message) ? 5 : 4)); } catch {} return; }
            sock.write(reply(0));
            if (rest.length) sock.unshift(rest);
          });
        }
      };
      sock.on('data', onData);
      sock.on('error', () => sock.destroy());
    });
  }

  // Port auf dem Server -> Ziel auf diesem Rechner
  function startRemote(tabId, st, run) {
    if (!st.onTcp) {
      st.onTcp = (info, accept, reject) => {
        const r = st.remoteByPort.get(info.destPort);
        if (!r || r.stopped) return reject();
        const channel = accept();
        const sock = net.connect(r.cfg.targetPort, r.cfg.targetHost);
        channel.pause();
        sock.once('connect', () => { r.warning = null; channel.pipe(sock).pipe(channel); channel.resume(); });
        sock.once('error', err => { r.warning = friendlyForwardError(err, r.cfg.targetHost, r.cfg.targetPort); notify(tabId); });
        track(tabId, r, sock, channel);
      };
      st.client.on('tcp connection', st.onTcp);
    }
    return new Promise(resolve => {
      // 'localhost' = nur auf dem Server selbst erreichbar (wie ssh -R ohne Adresse)
      st.client.forwardIn('localhost', run.cfg.remotePort, (err, port) => {
        if (err) {
          run.state = 'error';
          run.error = /prohibited|denied|refused|failed/i.test(err.message)
            ? i18n.t('tunnels.errRemoteDenied', { port: run.cfg.remotePort })
            : i18n.t('tunnels.errStart', { error: err.message });
          return resolve();
        }
        if (run.stopped) { st.client.unforwardIn('localhost', port, () => {}); return resolve(); }
        run.state = 'active';
        run.boundPort = port || run.cfg.remotePort;
        st.remoteByPort.set(run.boundPort, run);
        resolve();
      });
    });
  }

  async function start(tabId, tunnelId) {
    const st = tabState(tabId);
    if (!st) throw new Error(i18n.t('tunnels.errNoSession'));
    if (!st.hostName) throw new Error(i18n.t('tunnels.errOnlySaved'));
    const cfg = tunnelsOf(loadHosts()[st.hostName]).find(t => t.id === tunnelId);
    if (!cfg) throw new Error(i18n.t('tunnels.errGone'));
    if (st.running.has(tunnelId)) stop(tabId, tunnelId, false);

    const run = { cfg, state: 'starting', error: null, warning: null, sockets: new Set(), total: 0, server: null, boundPort: null, stopped: false };
    st.running.set(tunnelId, run);
    notify(tabId, true);
    if (cfg.type === 'local') await startLocal(tabId, st, run);
    else if (cfg.type === 'dynamic') await startDynamic(tabId, st, run);
    else await startRemote(tabId, st, run);
    if (run.state === 'error' && run.server) { try { run.server.close(); } catch {} run.server = null; }
    notify(tabId, true);
    return status(tabId);
  }

  function stop(tabId, tunnelId, report = true) {
    const st = tabs.get(tabId);
    const run = st?.running.get(tunnelId);
    if (!run) return;
    run.stopped = true;
    st.running.delete(tunnelId);
    if (run.server) { try { run.server.close(); } catch {} }
    if (run.cfg.type === 'remote' && run.boundPort && st.remoteByPort.get(run.boundPort) === run) {
      st.remoteByPort.delete(run.boundPort);
      try { st.client.unforwardIn('localhost', run.boundPort, () => {}); } catch {}
    }
    for (const sock of run.sockets) sock.destroy();
    run.sockets.clear();
    if (report) notify(tabId, true);
  }

  // Alles für einen Tab schließen (Tab zu, Verbindung weg)
  function stopAll(tabId) {
    const st = tabs.get(tabId);
    if (!st) return;
    for (const id of [...st.running.keys()]) stop(tabId, id, false);
    if (st.onTcp) st.client.removeListener('tcp connection', st.onTcp);
    tabs.delete(tabId);
    notify(tabId, true);
  }

  // Nach erfolgreichem Verbinden: Tunnel mit „automatisch starten“ einschalten
  async function onConnected(tabId) {
    const st = tabState(tabId);
    if (!st || !st.hostName) return;
    for (const t of tunnelsOf(loadHosts()[st.hostName])) {
      if (t.autoStart) { try { await start(tabId, t.id); } catch { /* Status zeigt den Fehler */ } }
    }
    notify(tabId, true);
  }

  function saveList(hostName, mutate) {
    const hosts = loadHosts();
    if (!hosts[hostName]) throw new Error(i18n.t('tunnels.errNoHost', { name: hostName }));
    const list = tunnelsOf(hosts[hostName]);
    const next = mutate(list);
    hosts[hostName] = { ...hosts[hostName], tunnels: next };
    saveHosts(hosts);
    return next;
  }

  // Für alle Tabs dieser Verbindung den Status neu senden
  function notifyHost(hostName) {
    for (const [tabId, st] of tabs) if (st.hostName === hostName) notify(tabId, true);
  }

  // ---------- IPC ----------
  ipcMain.handle('tunnels:status', (_e, tabId) => status(tabId));
  ipcMain.handle('tunnels:start', (_e, tabId, tunnelId) => start(tabId, tunnelId));
  ipcMain.handle('tunnels:stop', (_e, tabId, tunnelId) => { stop(tabId, tunnelId); return status(tabId); });
  ipcMain.handle('tunnels:save', (_e, hostName, tunnel) => {
    const t = normalizeTunnel(tunnel || {});
    saveList(hostName, list => {
      const i = list.findIndex(x => x.id === t.id);
      if (i >= 0) list[i] = t; else list.push(t);
      return list;
    });
    // Läuft der Tunnel gerade, mit den neuen Einstellungen neu starten
    for (const [tabId, st] of tabs) {
      if (st.hostName === hostName && st.running.has(t.id)) start(tabId, t.id).catch(() => {});
    }
    notifyHost(hostName);
    return t;
  });
  ipcMain.handle('tunnels:delete', (_e, hostName, tunnelId) => {
    for (const [tabId, st] of tabs) if (st.hostName === hostName) stop(tabId, tunnelId, false);
    saveList(hostName, list => list.filter(t => t.id !== tunnelId));
    notifyHost(hostName);
    return true;
  });
  // Nur Adressen von laufenden lokalen Tunneln öffnen – nie beliebige URLs aus der Oberfläche
  ipcMain.handle('tunnels:open', (_e, tabId, tunnelId) => {
    const run = tabs.get(tabId)?.running.get(tunnelId);
    if (!run || run.state !== 'active' || run.cfg.type !== 'local') throw new Error(i18n.t('tunnels.errNotRunning'));

    const proto = run.cfg.web === 'https' ? 'https' : 'http';
    return shell.openExternal(`${proto}://127.0.0.1:${run.boundPort}/`);
  });

  return { onConnected, stopAll, status };
}

module.exports = { createTunnelManager, normalizeTunnel, tunnelsOf, describe };
