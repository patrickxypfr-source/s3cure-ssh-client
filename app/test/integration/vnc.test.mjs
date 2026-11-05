// Integrationstest Remote Desktop (VNC): echte App (Electron) + lokaler sshd + VNC-Server auf eigenem Bildschirm.
// Verbinden durch SSH, Passwort-Abfrage, Bild sichtbar, Maus und Tastatur kommen an (xev schreibt mit),
// Strg+Alt+Entf, Zwischenablage, Suche nach VNC-Servern, Fehlermeldung ohne VNC-Server, Trennen.
//
// VNC-Server: TigerVNC (Xtigervnc, bevorzugt) oder Xvfb + x11vnc. Erzwingen: S3CURE_TEST_VNC=tigervnc | x11vnc
// Linux:  sudo apt install openssh-server xvfb x11-utils tigervnc-standalone-server tigervnc-tools (oder x11vnc)
//         (optional xclip: prüft die Zwischenablage auf dem Server)
//         xvfb-run -a npm run test:integration
// Fehlt etwas davon, wird der Test übersprungen (nicht rot).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { startSshd, SSHD, cdpTarget, waitFor, freePort, sleep, tmpDir } from './helpers.mjs';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ELECTRON = createRequire(import.meta.url)('electron');
const which = cmd => { try { return execFileSync('sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8' }).trim(); } catch { return ''; } };
const TOOLS = {
  xclip: which('xclip'), xvfb: which('Xvfb'), x11vnc: which('x11vnc'), xev: which('xev'), stdbuf: which('stdbuf'),
  ss: which('ss') || which('netstat'), tiger: which('Xtigervnc'), vncpasswd: which('vncpasswd') || which('tigervncpasswd'),
};
const want = process.env.S3CURE_TEST_VNC;
const BACKEND = (want !== 'x11vnc' && TOOLS.tiger && TOOLS.vncpasswd) ? 'tigervnc' : (want !== 'tigervnc' && TOOLS.xvfb && TOOLS.x11vnc) ? 'x11vnc' : null;

const missing = process.platform !== 'linux' ? 'nur unter Linux (TigerVNC oder Xvfb + x11vnc)'
  : !SSHD ? 'sshd nicht gefunden (apt install openssh-server)'
  : !process.env.DISPLAY ? 'kein Bildschirm – mit „xvfb-run -a npm run test:integration“ starten'
  : !BACKEND ? 'kein VNC-Server (apt install tigervnc-standalone-server tigervnc-tools oder xvfb x11vnc)'
  : !TOOLS.xev || !TOOLS.stdbuf ? 'xev fehlt (apt install x11-utils)'
  : !fs.existsSync(ELECTRON) ? 'Electron nicht installiert (npm install)' : false;

const ctx = { procs: [] };
const VNC_PASSWORD = 'geheim42';

// freier Port im VNC-Bereich 5900–5999 (damit die Suche ihn als „Display“ erkennt)
async function freeVncPort() {
  for (let p = 5950; p < 6000; p++) {
    const ok = await new Promise(res => { const s = net.createServer(); s.once('error', () => res(false)); s.listen(p, '127.0.0.1', () => s.close(() => res(true))); });
    if (ok) return p;
  }
  throw new Error('kein freier Port 5950–5999');
}
const freeDisplay = () => { for (let n = 77; n < 150; n++) if (!fs.existsSync(`/tmp/.X${n}-lock`) && !fs.existsSync(`/tmp/.X11-unix/X${n}`)) return n; throw new Error('kein freies Display'); };
const run = (cmd, args, opts = {}) => { const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts }); ctx.procs.push(p); return p; };

before(async () => {
  if (missing) return;
  const root = tmpDir('s3cure-vnc-');
  ctx.root = root;
  const home = path.join(root, 'home');
  const config = path.join(root, 'config');
  for (const d of [home, config]) fs.mkdirSync(d, { recursive: true });
  Object.assign(ctx, { home, config });

  // „Server-Bildschirm“ mit VNC-Server, darauf ein xev-Fenster (schreibt Maus/Tastatur mit)
  const disp = freeDisplay();
  ctx.display = `:${disp}`;
  ctx.vncPort = await freeVncPort();
  ctx.vncLog = '';
  const passFile = path.join(root, 'vncpass');
  let vnc;
  if (BACKEND === 'tigervnc') {
    fs.writeFileSync(passFile, execFileSync(TOOLS.vncpasswd, ['-f'], { input: VNC_PASSWORD + '\n' }));
    vnc = run(TOOLS.tiger, [ctx.display, '-geometry', '1024x768', '-depth', '24', '-rfbport', String(ctx.vncPort), '-localhost',
      '-SecurityTypes', 'VncAuth', '-PasswordFile', passFile, '-AlwaysShared', '-nolisten', 'tcp'], { env: { ...process.env, HOME: home } });
  } else {
    run(TOOLS.xvfb, [ctx.display, '-screen', '0', '1024x768x24', '-nolisten', 'tcp']);
    await waitFor(() => fs.existsSync(`/tmp/.X11-unix/X${disp}`), 'Xvfb startet', 10_000);
    execFileSync(TOOLS.x11vnc, ['-storepasswd', VNC_PASSWORD, passFile], { stdio: 'ignore' });
    vnc = run(TOOLS.x11vnc, ['-display', ctx.display, '-localhost', '-rfbport', String(ctx.vncPort), '-rfbauth', passFile, '-forever', '-shared', '-noxdamage', '-nopw', '-quiet'], { env: { ...process.env, DISPLAY: ctx.display, HOME: home } });
  }
  vnc.stderr.on('data', d => { ctx.vncLog += d; });
  vnc.stdout.on('data', d => { ctx.vncLog += d; });
  await waitFor(() => fs.existsSync(`/tmp/.X11-unix/X${disp}`), 'Bildschirm des Servers startet', 10_000);
  await waitFor(() => new Promise(res => { const s = net.connect(ctx.vncPort, '127.0.0.1', () => { s.end(); res(true); }); s.on('error', () => res(false)); }), `${BACKEND} lauscht`, 15_000);
  ctx.xevLog = '';
  const xev = run(TOOLS.stdbuf, ['-oL', TOOLS.xev, '-display', ctx.display, '-geometry', '1024x768+0+0', '-event', 'keyboard', '-event', 'button', '-event', 'mouse'], { env: { ...process.env, DISPLAY: ctx.display } });
  xev.stdout.on('data', d => { ctx.xevLog += d; });
  await waitFor(() => /MapNotify|Expose|ConfigureNotify|PropertyNotify/.test(ctx.xevLog) || ctx.xevLog.length > 0 || xev.exitCode === null, 'xev-Fenster', 5_000);
  await sleep(500);

  ctx.sshd = await startSshd(path.join(root, 'sshd'));
  const { port, clientKey, hostPub } = ctx.sshd;
  fs.writeFileSync(path.join(config, 'known_hosts'), `[127.0.0.1]:${port} ${hostPub}\n`);
  fs.writeFileSync(path.join(config, 'hosts.json'), JSON.stringify({
    Desktopserver: {
      user: os.userInfo().username, host: '127.0.0.1', port, key: clientKey,
      vnc: { enabled: true, host: 'localhost', port: ctx.vncPort, quality: 'balanced', viewOnly: false, scale: 'fit' },
    },
  }, null, 2));
  // kein „Was ist neu?“-Fenster
  const version = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8')).version;
  fs.writeFileSync(path.join(config, 'update-check.json'), JSON.stringify({ seenVersion: version, disabled: true }));

  const pagePort = await freePort();
  const mainPort = await freePort();
  const env = { ...process.env, HOME: home, S3CURE_CONFIG_DIR: config, S3CURE_UPDATE_URL: 'http://127.0.0.1:9/none', S3CURE_LANG: 'de' };
  delete env.SSH_AUTH_SOCK;
  ctx.app = spawn(ELECTRON, [`--remote-debugging-port=${pagePort}`, `--inspect=${mainPort}`, '--no-sandbox', '--disable-gpu', APP_DIR], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  ctx.log = '';
  ctx.app.stdout.on('data', d => { ctx.log += d; });
  ctx.app.stderr.on('data', d => { ctx.log += d; });
  ctx.page = await waitFor(() => cdpTarget(pagePort, t => t.type === 'page' && /index\.html/.test(t.url)), 'Hauptfenster', 60_000);
  ctx.main = await waitFor(() => cdpTarget(mainPort), 'Inspector des Hauptprozesses', 30_000);
  await waitFor(() => ctx.page.eval(`document.readyState === 'complete' && document.querySelectorAll('#host-list li').length`), 'Verbindungsliste');
  await waitFor(() => ctx.page.eval(`!!window.NoVncRFB`), 'noVNC geladen');
});

after(async () => {
  ctx.page?.close();
  ctx.main?.close();
  if (ctx.app && ctx.app.exitCode === null) { ctx.app.kill(); await sleep(500); }
  ctx.sshd?.stop();
  for (const p of ctx.procs) { try { p.kill(); } catch {} }
  await sleep(200);
  if (ctx.root) fs.rmSync(ctx.root, { recursive: true, force: true });
});

const t = (name, opts, fn) => {
  if (typeof opts === 'function') { fn = opts; opts = {}; }
  return test(name, { skip: missing || opts.skip }, async () => {
  try { await fn(); } catch (err) {
    err.message += '\n--- App ---\n' + (ctx.log || '').slice(-2500) + '\n--- VNC-Server (' + BACKEND + ') ---\n' + (ctx.vncLog || '').slice(-1500);
    throw err;
  }
  });
};
const page = expr => ctx.page.eval(expr);
const vncState = () => page(`(() => { const st = Desktop._states.get(activeId); return st && { status: st.status, error: st.error, target: st.target }; })()`);

t('SSH verbinden, Ansicht „Desktop“ öffnen, nach dem VNC-Passwort fragen', async () => {
  await page(`document.querySelector('#host-list li').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
  const state = await waitFor(() => page(`(() => { const s = tabs.get(activeId)?.state; return s === 'open' || s === 'closed' ? s : null; })()`), 'SSH steht', 30_000);
  assert.equal(state, 'open', 'sshd: ' + ctx.sshd.log());
  // Umschalter hat jetzt vier Ansichten
  assert.deepEqual(await page(`[...document.querySelectorAll('#view-switch button')].map(b => b.dataset.view)`), ['terminal', 'files', 'dash', 'db', 'desktop']);
  await page(`document.querySelector('#view-switch button[data-view=desktop]').click()`);
  // VNC ist für die Verbindung eingeschaltet -> verbindet automatisch und fragt nach dem Passwort
  const ask = await waitFor(() => page(`!document.querySelector('#ask-modal').hidden && document.querySelector('#ask-title').textContent`), 'Passwort-Abfrage', 20_000);
  assert.equal(ask, 'VNC-Passwort');
  await page(`(() => { document.querySelector('#ask-input').value = ${JSON.stringify(VNC_PASSWORD)}; document.querySelector('#ask-remember').checked = false; document.querySelector('#ask-form').requestSubmit(); })()`);
  const st = await waitFor(async () => { const s = await vncState(); return s && (s.status === 'connected' || s.status === 'error') && s; }, 'VNC verbunden', 20_000);
  assert.equal(st.status, 'connected', st.error);
  assert.equal(st.target, `localhost:${ctx.vncPort}`);
  assert.match(await page(`Desktop._states.get(activeId).root.querySelector('.vnc-status-text').textContent`), new RegExp(`localhost:${ctx.vncPort}`));
});

t('Bild ist sichtbar (Fenster des Servers im Canvas)', async () => {
  const info = await waitFor(() => page(`(() => {
    const st = Desktop._states.get(activeId);
    const c = st.screen.querySelector('canvas');
    if (!c || !c.width) return null;
    const r = c.getBoundingClientRect();
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let white = 0, black = 0;
    for (let i = 0; i < d.length; i += 4 * 97) { if (d[i] > 240 && d[i + 1] > 240 && d[i + 2] > 240) white++; else if (d[i] < 15 && d[i + 1] < 15 && d[i + 2] < 15) black++; }
    return white > 100 && { w: c.width, h: c.height, shownW: Math.round(r.width), shownH: Math.round(r.height), white, black };
  })()`), 'Bildinhalt im Canvas', 20_000);
  assert.equal(info.w, 1024);
  assert.equal(info.h, 768);
  // „Anpassen“: in das Fenster eingepasst (kleiner als 1024×768, da das Testfenster kleiner ist)
  assert.ok(info.shownW > 0 && info.shownH > 0);
});

async function canvasPoint(fx, fy) {
  return page(`(() => { const c = Desktop._states.get(activeId).screen.querySelector('canvas'); const r = c.getBoundingClientRect(); return { x: Math.round(r.left + r.width * ${fx}), y: Math.round(r.top + r.height * ${fy}) }; })()`);
}

t('Maus: Klick kommt auf dem Server an', async () => {
  const { x, y } = await canvasPoint(0.5, 0.5);
  ctx.xevLog = '';
  await ctx.page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await ctx.page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await ctx.page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  await waitFor(() => /ButtonPress event/.test(ctx.xevLog) && /ButtonRelease event/.test(ctx.xevLog), 'ButtonPress/Release in xev', 10_000);
  // Position grob in der Bildmitte (1024×768)
  const m = /ButtonPress event[\s\S]*?\((\d+),(\d+)\), root:/.exec(ctx.xevLog);
  assert.ok(m, ctx.xevLog.slice(-500));
  assert.ok(Math.abs(Number(m[1]) - 512) < 40 && Math.abs(Number(m[2]) - 384) < 40, `Position ${m[1]},${m[2]}`);
});

t('Tastatur: getippte Zeichen kommen auf dem Server an', async () => {
  ctx.xevLog = '';
  await page(`Desktop._states.get(activeId).rfb.focus()`);
  await ctx.page.key('a', { code: 'KeyA', keyCode: 65, text: 'a' });
  await ctx.page.key('Z', { code: 'KeyZ', keyCode: 90, text: 'Z', modifiers: 8 });
  await waitFor(() => /KeyPress event[\s\S]*keysym 0x61, a\)/.test(ctx.xevLog), 'Taste „a“ in xev', 10_000);
  await waitFor(() => /keysym 0x5a, Z\)/.test(ctx.xevLog), 'Taste „Z“ in xev', 10_000);
});

t('Strg+Alt+Entf-Knopf sendet die Tastenfolge', async () => {
  ctx.xevLog = '';
  await page(`Desktop._states.get(activeId).cadB.click()`);
  await waitFor(() => /Control_L/.test(ctx.xevLog) && /Alt_L/.test(ctx.xevLog) && /Delete/.test(ctx.xevLog), 'Strg, Alt, Entf in xev', 10_000);
});

t('Zwischenablage: Text an den Server senden', async () => {
  await ctx.main.eval(`process.mainModule.require('electron').clipboard.writeText('S3CURE_CLIP')`);
  await page(`Desktop._states.get(activeId).clipB.click()`);
  await waitFor(() => page(`/Zwischenablage an den Server gesendet/.test(document.querySelector('#progress-label').textContent)`), 'Hinweis „gesendet“', 5_000);
  // Der VNC-Server setzt damit die Zwischenablage auf dem Server – mit xclip nachsehen.
  // (x11vnc 0.9.16 nimmt Text über die „erweiterte Zwischenablage“ an, setzt ihn aber nicht in X – nur bei TigerVNC prüfen.)
  if (TOOLS.xclip && BACKEND === 'tigervnc') {
    const read = sel => { try { return execFileSync(TOOLS.xclip, ['-display', ctx.display, '-selection', sel, '-o'], { encoding: 'utf8', timeout: 3000 }); } catch { return ''; } };
    await waitFor(() => read('clipboard') === 'S3CURE_CLIP' || read('primary') === 'S3CURE_CLIP', 'Text in der Zwischenablage des Servers', 10_000);
  }
});

// Mit TigerVNC + xclip echt: Text auf dem Server in die Zwischenablage legen. Sonst (x11vnc in Xvfb schickt
// Änderungen der X-Auswahl nicht zuverlässig) ab noVNC: Ereignis „clipboard“ (ServerCutText) -> Zwischenablage.
t('Zwischenablage: Text vom Server landet in der Zwischenablage dieses Rechners', async () => {
  await ctx.main.eval(`process.mainModule.require('electron').clipboard.writeText('')`);
  if (TOOLS.xclip && BACKEND === 'tigervnc') {
    const p = spawn(TOOLS.xclip, ['-display', ctx.display, '-selection', 'clipboard', '-i'], { stdio: ['pipe', 'ignore', 'ignore'] });
    ctx.procs.push(p);
    p.stdin.end('VOM_SERVER_123');
  } else {
    await page(`Desktop._states.get(activeId).rfb.dispatchEvent(new CustomEvent('clipboard', { detail: { text: 'VOM_SERVER_123' } }))`);
  }
  await waitFor(() => ctx.main.eval(`process.mainModule.require('electron').clipboard.readText()`).then(v => v === 'VOM_SERVER_123'), 'Text vom Server in der Zwischenablage', 10_000);
  assert.match(await page(`document.querySelector('#progress-label').textContent`), /vom Server/);
});

t('Trennen: Desktop-Verbindung zu, SSH bleibt verbunden', async () => {
  await page(`Desktop._states.get(activeId).connB.click()`);
  await waitFor(async () => (await vncState())?.status === 'idle', 'getrennt', 10_000);
  assert.equal(await page(`tabs.get(activeId).state`), 'open');
  assert.equal(await page(`Desktop._states.get(activeId).panel.hidden`), false);
});

t('Suche findet den VNC-Server auf dem Server (ss -ltn)', { skip: !TOOLS.ss && 'weder ss noch netstat installiert' }, async () => {
  await page(`Desktop._states.get(activeId).panel.querySelector('.vnc-scan-btn').click()`);
  const found = await waitFor(() => page(`(() => { const s = Desktop._states.get(activeId).scan; return s && !s.error ? s.found.map(f => [f.port, f.loopbackOnly]) : s?.error; })()`), 'Suchergebnis', 15_000);
  assert.ok(Array.isArray(found), String(found));
  assert.ok(found.some(([p, local]) => p === ctx.vncPort && local), JSON.stringify(found));
  // Vorschlag ist anklickbar
  const btns = await page(`Desktop._states.get(activeId).panel.querySelectorAll('.vnc-found button').length`);
  assert.ok(btns >= 1);
});

t('Ohne VNC-Server auf dem Port: verständliche Fehlermeldung mit Tipp', async () => {
  const port = await freeVncPort();
  await page(`(() => { const p = Desktop._states.get(activeId).panel; p.querySelector('input[name=target]').value = 'localhost:${port}'; p.querySelector('form').requestSubmit(); })()`);
  const st = await waitFor(async () => { const s = await vncState(); return s?.status === 'error' && s; }, 'Fehlermeldung', 15_000);
  assert.match(st.error, new RegExp(`kein VNC-Server auf localhost:${port}`));
  assert.match(st.error, /tigervnc-standalone-server/);
  assert.match(st.error, /raspi-config/);
  assert.match(await page(`Desktop._states.get(activeId).panel.querySelector('.vnc-error').textContent`), /kein VNC-Server/);
});

t('Die Brücke lauscht nur auf 127.0.0.1 und nimmt ein Token nur einmal', async () => {
  // Über die Oberfläche eine Adresse holen, aber nicht benutzen: fremdes Origin wird abgewiesen
  const url = await page(`s3vnc.open(activeId, { target: 'localhost:${ctx.vncPort}' }).then(i => i.url)`);
  assert.match(url, /^ws:\/\/127\.0\.0\.1:\d+\/vnc\/[0-9a-f]{48}$/);
  const status = await new Promise(res => {
    const u = new URL(url);
    const s = net.connect(Number(u.port), '127.0.0.1', () => {
      s.write(`GET ${u.pathname} HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nOrigin: http://evil.example\r\n\r\n`);
    });
    s.once('data', d => { res(String(d).split('\r\n')[0]); s.destroy(); });
    s.on('error', e => res(e.message));
  });
  assert.match(status, /403/);
  await page(`s3vnc.close(activeId)`);
});

t('Verbindungs-Dialog speichert die VNC-Einstellungen (Display-Nummer wird zum Port)', async () => {
  await page(`editHost('Desktopserver')`);
  await page(`(() => {
    const f = document.querySelector('#host-form');
    f.vncEnabled.checked = true; f.vncTarget.value = ':3'; f.vncQuality.value = 'low'; f.vncViewOnly.checked = true;
    f.requestSubmit();
  })()`);
  await waitFor(() => page(`document.querySelector('#host-modal').hidden`), 'Dialog geschlossen');
  const h = JSON.parse(fs.readFileSync(path.join(ctx.config, 'hosts.json'), 'utf8')).Desktopserver;
  assert.deepEqual(h.vnc, { enabled: true, host: 'localhost', port: 5903, quality: 'low', viewOnly: true, scale: 'fit' });
  // Ungültige Adresse: verständlicher Fehler, nichts gespeichert
  await page(`editHost('Desktopserver'); document.querySelector('#host-form').vncTarget.value = 'a b'; document.querySelector('#host-form').requestSubmit()`);
  const err = await waitFor(() => page(`!document.querySelector('#ask-modal').hidden && document.querySelector('#ask-message').textContent + document.querySelector('#ask-detail').textContent + document.querySelector('#ask-title').textContent`), 'Fehlermeldung');
  assert.match(err, /Leerzeichen/);
  await page(`document.querySelector('#ask-ok').click(); document.querySelector('#host-modal').hidden = true`);
});
