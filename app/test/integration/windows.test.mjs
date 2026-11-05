// Integrationstest: mehrere Fenster (echte App gegen lokalen sshd)
// - zweites Fenster öffnen, Tab hinüberschieben: dieselbe Shell (gleiche PID), Terminal-Inhalt bleibt
// - Übertragung im zweiten Fenster: Meldungen kommen nur dort an
// - Tab in ein neues Fenster, dieses schließen: nur seine Verbindung endet
// - Tab aus der Tab-Leiste auf ein anderes Fenster ziehen
// - App beenden und neu starten: beide Fenster mit Position und Tabs wieder da
//
// Linux: xvfb-run -a npm run test:integration
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { startSshd, SSHD, Cdp, cdpTarget, waitFor, freePort, sleep, tmpDir } from './helpers.mjs';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ELECTRON = createRequire(import.meta.url)('electron');

const missing = !SSHD ? 'sshd nicht gefunden (Linux: apt install openssh-server)'
  : process.platform === 'linux' && !process.env.DISPLAY ? 'kein Bildschirm – mit „xvfb-run -a npm run test:integration“ starten'
  : process.platform === 'win32' ? 'unter Windows nicht unterstützt'
  : !fs.existsSync(ELECTRON) ? 'Electron nicht installiert (npm install)' : false;

const ctx = { pages: new Map() }; // CDP-Ziel-ID -> Cdp

before(async () => {
  if (missing) return;
  const root = tmpDir('s3cure-win-');
  ctx.root = root;
  const home = path.join(root, 'home');
  const config = path.join(root, 'config');
  const remote = path.join(root, 'remote');
  const local = path.join(root, 'local');
  for (const d of [home, config, remote, local]) fs.mkdirSync(d, { recursive: true });
  Object.assign(ctx, { home, config, remote, local });
  fs.writeFileSync(path.join(local, 'zweites-fenster.txt'), 'Hochgeladen im zweiten Fenster\n'.repeat(2000));

  ctx.sshd = await startSshd(path.join(root, 'sshd'));
  const { port, clientKey, hostPub } = ctx.sshd;
  fs.writeFileSync(path.join(config, 'known_hosts'), `[127.0.0.1]:${port} ${hostPub}\n`);
  fs.writeFileSync(path.join(config, 'hosts.json'), JSON.stringify({
    Testserver: { user: os.userInfo().username, host: '127.0.0.1', port, key: clientKey },
  }, null, 2));
  const version = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8')).version;
  fs.writeFileSync(path.join(config, 'update-check.json'), JSON.stringify({ seenVersion: version, disabled: true }));
  await launch();
});

async function launch() {
  ctx.pagePort = await freePort();
  ctx.mainPort = await freePort();
  const env = { ...process.env, HOME: ctx.home, S3CURE_CONFIG_DIR: ctx.config, S3CURE_UPDATE_URL: 'http://127.0.0.1:9/none', S3CURE_LANG: 'de' };
  delete env.SSH_AUTH_SOCK;
  ctx.app = spawn(ELECTRON, [`--remote-debugging-port=${ctx.pagePort}`, `--inspect=${ctx.mainPort}`, '--no-sandbox', '--disable-gpu', APP_DIR], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  ctx.log = '';
  ctx.app.stdout.on('data', d => { ctx.log += d; });
  ctx.app.stderr.on('data', d => { ctx.log += d; });
  // Zur Fehlersuche: S3CURE_IT_LOG=/pfad/datei schreibt die Ausgabe der App mit
  ctx.app.on('exit', () => { if (process.env.S3CURE_IT_LOG) fs.appendFileSync(process.env.S3CURE_IT_LOG, ctx.log); });
  ctx.pages.clear();
  ctx.main = await waitFor(() => cdpTarget(ctx.mainPort), 'Inspector des Hauptprozesses', 60_000);
}

// Alle Fenster mit der Oberfläche (index.html) als CDP-Verbindungen
async function windowPages() {
  const list = (await (await fetch(`http://127.0.0.1:${ctx.pagePort}/json/list`)).json())
    .filter(t => t.type === 'page' && /index\.html/.test(t.url));
  for (const t of list) if (!ctx.pages.has(t.id)) ctx.pages.set(t.id, await Cdp.connect(t.webSocketDebuggerUrl));
  for (const id of [...ctx.pages.keys()]) if (!list.some(t => t.id === id)) { ctx.pages.get(id).close(); ctx.pages.delete(id); }
  return list.map(t => ctx.pages.get(t.id));
}

async function newPage(known) {
  return waitFor(async () => {
    const all = await windowPages();
    const p = all.find(x => !known.includes(x));
    return p && (await p.eval(`document.readyState === 'complete' && typeof WindowTabs === 'object'`)) ? p : null;
  }, 'neues Fenster', 30_000);
}

after(async () => {
  for (const p of ctx.pages.values()) p.close();
  ctx.main?.close();
  if (ctx.app && ctx.app.exitCode === null) { ctx.app.kill(); await sleep(500); }
  ctx.sshd?.stop();
  if (ctx.root) fs.rmSync(ctx.root, { recursive: true, force: true });
});

const t = (name, fn) => test(name, { skip: missing }, async () => {
  try { await fn(); } catch (err) {
    if (ctx.log) err.message += '\n--- Ausgabe der App ---\n' + ctx.log.slice(-3000);
    throw err;
  }
});

const termText = (p, id) => p.eval(`(() => { const b = tabs.get(${JSON.stringify(id)}).term.buffer.active; let s = ''; for (let i = 0; i < b.length; i++) s += b.getLine(i).translateToString(true) + '\\n'; return s; })()`);
const waitState = (p, id) => waitFor(() => p.eval(`(() => { const s = tabs.get(${JSON.stringify(id)})?.state; return s === 'open' || s === 'closed' ? s : null; })()`), 'Verbindung steht', 30_000);

// Befehl im Tab ausführen und eine Zeile mit „<mark>_<Zahl>“ abwarten
async function shellPid(p, id, mark) {
  await p.eval(`myssh.write(${JSON.stringify(id)}, 'echo ${mark}_$$\\r')`);
  const re = new RegExp(`^${mark}_(\\d+)\\s*$`, 'm');
  const text = await waitFor(async () => { const s = await termText(p, id); return re.test(s) && s; }, `Ausgabe ${mark}`);
  return Number(text.match(re)[1]);
}

const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function openTab(p) {
  const id = await p.eval(`openTab({ name: 'Testserver' }, 'Testserver').id`);
  assert.equal(await waitState(p, id), 'open');
  return id;
}

t('zwei Fenster: Tab verschieben ohne Neuverbinden, Terminal-Inhalt bleibt', async () => {
  const [w1] = await waitFor(async () => { const l = await windowPages(); return l.length && (await l[0].eval(`document.readyState === 'complete'`)) && l; }, 'erstes Fenster', 60_000);
  ctx.w1 = w1;
  ctx.a = await openTab(w1);
  ctx.b = await openTab(w1);
  ctx.c = await openTab(w1);
  ctx.pidA = await shellPid(w1, ctx.a, 'VORHER');
  ctx.pidB = await shellPid(w1, ctx.b, 'PB');
  ctx.pidC = await shellPid(w1, ctx.c, 'PC');

  // Neues Fenster über dieselbe Funktion wie Strg+Umschalt+N / Menü / Befehlspalette
  await w1.eval(`WindowTabs.newWindow()`);
  const w2 = await newPage([w1]);
  ctx.w2 = w2;
  const others = await w1.eval(`s3windows.list().then(l => l.filter(w => !w.self))`);
  assert.equal(others.length, 1);
  ctx.w2id = others[0].id;

  assert.equal(await w1.eval(`WindowTabs.moveTab(${JSON.stringify(ctx.a)}, { wcId: ${ctx.w2id} })`), true);
  await waitFor(() => w2.eval(`tabs.get(${JSON.stringify(ctx.a)})?.state === 'open'`), 'Tab im zweiten Fenster');
  assert.equal(await w1.eval(`tabs.has(${JSON.stringify(ctx.a)})`), false, 'Tab ist aus dem ersten Fenster weg');
  assert.equal(await w1.eval(`tabs.size`), 2);
  assert.match(await termText(w2, ctx.a), new RegExp(`VORHER_${ctx.pidA}`), 'alter Terminal-Inhalt im neuen Fenster');
  // Dieselbe Shell: gleiche Prozess-ID, kein Neuverbinden
  assert.equal(await shellPid(w2, ctx.a, 'NACHHER'), ctx.pidA);
  // Tastatureingabe im neuen Fenster kommt an
  await w2.eval(`tabs.get(${JSON.stringify(ctx.a)}).term.focus()`);
  await sleep(200);
  await w2.insertText('echo GETIPPT_$((2+3))');
  await w2.key('Enter', { keyCode: 13, text: '\r' });
  await waitFor(async () => /^GETIPPT_5\s*$/m.test(await termText(w2, ctx.a)), 'Eingabe im zweiten Fenster');
  // Ausgabe des verschobenen Tabs landet nicht mehr im ersten Fenster
  assert.equal(await w1.eval(`[...tabs.values()].some(t => { const b = t.term.buffer.active; for (let i = 0; i < b.length; i++) if (b.getLine(i).translateToString(true).includes('NACHHER_')) return true; return false; })`), false);
});

t('Übertragung im zweiten Fenster: Fortschritt nur dort', async () => {
  for (const p of [ctx.w1, ctx.w2]) await p.eval(`(() => { window.__tr = []; myssh.onTransfer(i => __tr.push(i)); return true; })()`);
  const n = await ctx.w2.eval(`myssh.sftpUpload(${JSON.stringify(ctx.a)}, ${JSON.stringify(ctx.remote)}, [${JSON.stringify(path.join(ctx.local, 'zweites-fenster.txt'))}])`);
  assert.equal(n, 1);
  assert.equal(fs.readFileSync(path.join(ctx.remote, 'zweites-fenster.txt'), 'utf8'), fs.readFileSync(path.join(ctx.local, 'zweites-fenster.txt'), 'utf8'));
  await waitFor(() => ctx.w2.eval(`__tr.some(i => i.state === 'done')`), 'Meldung „fertig“ im zweiten Fenster');
  assert.equal(await ctx.w1.eval(`__tr.length`), 0, 'erstes Fenster bekommt keine Meldungen');
  // Liste der Übertragungen pro Fenster
  assert.equal((await ctx.w2.eval(`myssh.transferList()`)).length, 1);
  assert.equal((await ctx.w1.eval(`myssh.transferList()`)).length, 0);
});

t('Tab in neues Fenster, Fenster schließen beendet nur dessen Verbindung', async () => {
  const known = await windowPages();
  assert.equal(await ctx.w1.eval(`WindowTabs.moveTab(${JSON.stringify(ctx.c)}, { newWindow: true })`), true);
  const w3 = await newPage(known);
  await waitFor(() => w3.eval(`tabs.get(${JSON.stringify(ctx.c)})?.state === 'open'`), 'Tab im dritten Fenster');
  assert.equal(await shellPid(w3, ctx.c, 'DRITTES'), ctx.pidC);
  await w3.eval(`setTimeout(() => window.close(), 10), true`);
  await waitFor(() => !alive(ctx.pidC), 'Shell des geschlossenen Fensters beendet', 15_000);
  assert.ok(alive(ctx.pidA), 'Tab im zweiten Fenster läuft weiter');
  assert.ok(alive(ctx.pidB), 'Tab im ersten Fenster läuft weiter');
  assert.equal(await shellPid(ctx.w1, ctx.b, 'NOCHDA'), ctx.pidB);
  assert.equal(await shellPid(ctx.w2, ctx.a, 'AUCHNOCH'), ctx.pidA);
  assert.equal((await windowPages()).length, 2);
});

t('Tab aus der Tab-Leiste ziehen: auf ein anderes Fenster, ins Leere, im eigenen Fenster', async () => {
  // Fenster übereinander legen und die Mausposition im Hauptprozess vorgeben (unter xvfb gibt es keine echte Maus)
  await ctx.main.eval(`(() => {
    const { BrowserWindow, webContents, screen } = process.mainModule.require('electron');
    const wins = BrowserWindow.getAllWindows();
    const w2 = BrowserWindow.fromWebContents(webContents.fromId(${ctx.w2id}));
    wins.find(w => w !== w2).setBounds({ x: 0, y: 0, width: 760, height: 480 });
    w2.setBounds({ x: 0, y: 520, width: 760, height: 480 });
    globalThis.__cursor = null;
    if (!globalThis.__realCursor) {
      globalThis.__realCursor = screen.getCursorScreenPoint.bind(screen);
      screen.getCursorScreenPoint = () => globalThis.__cursor || globalThis.__realCursor();
    }
    return true;
  })()`);
  const cursor = (x, y) => ctx.main.eval(`(globalThis.__cursor = { x: ${x}, y: ${y} }, true)`);
  const d = await openTab(ctx.w1);
  const pidD = await shellPid(ctx.w1, d, 'GEZOGEN');

  await cursor(100, 100); // über dem eigenen Fenster: bleibt
  assert.equal(await ctx.w1.eval(`s3windows.dropTarget()`), null);
  await cursor(1100, 300); // neben allen Fenstern: neues Fenster an dieser Stelle
  assert.deepEqual(await ctx.w1.eval(`s3windows.dropTarget()`), { newWindow: true, at: { x: 1100, y: 300 } });

  // über Fenster 2 loslassen
  await cursor(300, 700);
  await ctx.w1.eval(`tabs.get(${JSON.stringify(d)}).tabEl.dispatchEvent(new DragEvent('dragend', { bubbles: true })), true`);
  await waitFor(() => ctx.w2.eval(`tabs.get(${JSON.stringify(d)})?.state === 'open'`), 'gezogener Tab im zweiten Fenster');
  assert.equal(await ctx.w1.eval(`tabs.has(${JSON.stringify(d)})`), false);
  assert.equal(await shellPid(ctx.w2, d, 'ANGEKOMMEN'), pidD);
  await ctx.main.eval(`(globalThis.__cursor = null, true)`);

  // wieder schließen (beendet die Verbindung)
  await ctx.w2.eval(`closeTab(${JSON.stringify(d)}), true`);
  await waitFor(() => !alive(pidD), 'Shell des geschlossenen Tabs beendet', 15_000);
  assert.ok(alive(ctx.pidA) && alive(ctx.pidB));
});

t('Neustart: beide Fenster mit Position und Tabs wiederhergestellt', async () => {
  // Fenster 2 an eine feste Stelle legen
  await ctx.main.eval(`(() => {
    const { BrowserWindow, webContents } = process.mainModule.require('electron');
    BrowserWindow.fromWebContents(webContents.fromId(${ctx.w2id})).setBounds({ x: 140, y: 90, width: 900, height: 600 });
    return true;
  })()`);
  const file = path.join(ctx.config, 'session.json');
  await waitFor(() => {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    return d.windows?.length === 2 && d.windows.some(w => w.window?.x === 140 && w.window?.width === 900 && w.tabs.length === 1) && d.windows.every(w => w.tabs.length === 1);
  }, 'session.json mit zwei Fenstern', 10_000);

  // Ordentlich beenden (wie Cmd+Q bzw. das automatische Update)
  for (const p of ctx.pages.values()) p.close();
  ctx.pages.clear();
  const exited = new Promise(r => ctx.app.once('exit', r));
  await ctx.main.eval(`process.mainModule.require('electron').app.quit(), true`).catch(() => {});
  ctx.main.close();
  await exited;
  await waitFor(() => !alive(ctx.pidA) && !alive(ctx.pidB), 'Verbindungen beim Beenden geschlossen', 15_000);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.windows.length, 2, 'beide Fenster gemerkt');

  await launch();
  const list = await waitFor(async () => {
    const l = await windowPages();
    if (l.length !== 2) return null;
    for (const p of l) if (!(await p.eval(`tabs.size === 1 && [...tabs.values()][0].state === 'open'`))) return null;
    return l;
  }, 'zwei Fenster mit verbundenem Tab', 60_000);
  const bounds = await ctx.main.eval(`process.mainModule.require('electron').BrowserWindow.getAllWindows().map(w => w.getBounds())`);
  assert.ok(bounds.some(b => b.x === 140 && b.y === 90 && b.width === 900 && b.height === 600), 'Position von Fenster 2: ' + JSON.stringify(bounds));
  for (const p of list) assert.match(await p.eval(`[...tabs.values()][0].title`), /Testserver/);
});
