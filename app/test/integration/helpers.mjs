// Hilfen für den Integrationstest: lokaler sshd, Chrome-DevTools-Protokoll (CDP), Warten.
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

export const sleep = ms => new Promise(r => setTimeout(r, ms));

// Wartet, bis fn() etwas Wahres liefert (auch async); sonst Fehler mit letztem Stand
export async function waitFor(fn, what, timeout = 20_000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    try { last = await fn(); if (last) return last; } catch (err) { last = err.message; }
    await sleep(200);
  }
  throw new Error(`Zeitüberschreitung: ${what} (letzter Stand: ${JSON.stringify(last)})`);
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
    srv.on('error', reject);
  });
}

const which = cmd => { try { return execFileSync('sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8' }).trim(); } catch { return ''; } };
export const SSHD = ['/usr/sbin/sshd', '/usr/local/sbin/sshd', '/opt/homebrew/sbin/sshd'].find(f => fs.existsSync(f)) || which('sshd');

// Startet einen eigenen sshd auf 127.0.0.1 (nur Schlüssel-Anmeldung, nichts am System geändert)
export async function startSshd(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const hostKey = path.join(dir, 'host_ed25519');
  const clientKey = path.join(dir, 'client_ed25519');
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', hostKey]);
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 's3cure-test', '-f', clientKey]);
  fs.copyFileSync(clientKey + '.pub', path.join(dir, 'authorized_keys'));
  fs.chmodSync(path.join(dir, 'authorized_keys'), 0o600);
  const port = await freePort();
  const config = path.join(dir, 'sshd_config');
  fs.writeFileSync(config, [
    `Port ${port}`, 'ListenAddress 127.0.0.1', `HostKey ${hostKey}`, `PidFile ${path.join(dir, 'sshd.pid')}`,
    `AuthorizedKeysFile ${path.join(dir, 'authorized_keys')}`,
    'PubkeyAuthentication yes', 'PasswordAuthentication no', 'KbdInteractiveAuthentication no',
    'UsePAM no', 'StrictModes no', 'PermitRootLogin prohibit-password',
    'Subsystem sftp internal-sftp', 'LogLevel ERROR', '',
  ].join('\n'));
  if (process.getuid?.() === 0) fs.mkdirSync('/run/sshd', { recursive: true });
  const proc = spawn(SSHD, ['-D', '-e', '-f', config], { stdio: ['ignore', 'ignore', 'pipe'] });
  let log = '';
  proc.stderr.on('data', d => { log += d; });
  await waitFor(() => new Promise(res => {
    if (proc.exitCode !== null) throw new Error('sshd beendet: ' + log);
    const s = net.connect(port, '127.0.0.1', () => { s.end(); res(true); });
    s.on('error', () => res(false));
  }), 'sshd startet', 10_000);
  const hostPub = fs.readFileSync(hostKey + '.pub', 'utf8').trim().split(/\s+/).slice(0, 2).join(' ');
  return { port, clientKey, hostPub, proc, log: () => log, stop: () => proc.kill() };
}

// Kleiner CDP-Client über WebSocket (Node 22 hat WebSocket eingebaut)
export class Cdp {
  static async connect(url) {
    const c = new Cdp();
    c.ws = new WebSocket(url);
    c.id = 0;
    c.pending = new Map();
    c.ws.onmessage = ev => {
      const msg = JSON.parse(ev.data);
      const p = c.pending.get(msg.id);
      if (!p) return;
      c.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result);
    };
    await new Promise((res, rej) => { c.ws.onopen = res; c.ws.onerror = () => rej(new Error('WebSocket-Fehler: ' + url)); });
    return c;
  }

  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => { if (this.pending.delete(id)) reject(new Error('Keine Antwort: ' + method)); }, 15_000);
    });
  }

  // Ausdruck auswerten (Promises werden abgewartet), Ergebnis als Wert
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception?.description || r.exceptionDetails.text).split('\n')[0]);
    return r.result.value;
  }

  insertText(text) { return this.send('Input.insertText', { text }); }

  async key(key, { code = key, keyCode = 0, text, modifiers = 0 } = {}) {
    await this.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key, code, windowsVirtualKeyCode: keyCode, text, modifiers });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode, modifiers });
  }

  close() { try { this.ws.close(); } catch { /* egal */ } }
}

// Seite (type "page") oder Hauptprozess (Node-Inspector) über /json/list finden
export async function cdpTarget(port, match = () => true) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const t = list.find(match);
  return t ? Cdp.connect(t.webSocketDebuggerUrl) : null;
}

export const tmpDir = prefix => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
