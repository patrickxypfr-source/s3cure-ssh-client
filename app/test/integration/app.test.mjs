// Integrationstest: echte App (Electron) gegen einen lokalen sshd.
// Verbinden, Befehl im Terminal, Ordner im Dateibrowser, Hoch-/Herunterladen, Editor speichern.
//
// Linux:  xvfb-run -a npm run test:integration   (braucht openssh-server und xvfb)
// macOS:  npm run test:integration                (braucht „Entfernte Anmeldung“ nicht – eigener sshd)
//
// Die App läuft mit eigenem Konfigurationsordner (S3CURE_CONFIG_DIR) und eigenem Home-Ordner;
// ~/.myssh und ~/.ssh des Rechners werden nicht angefasst. Datei-Dialoge werden über den
// Inspector des Hauptprozesses durch feste Antworten ersetzt.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { startSshd, SSHD, cdpTarget, waitFor, freePort, sleep, tmpDir } from './helpers.mjs';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ELECTRON = createRequire(import.meta.url)('electron'); // in Node: Pfad zur Electron-Datei

const missing = !SSHD ? 'sshd nicht gefunden (Linux: apt install openssh-server)'
  : process.platform === 'linux' && !process.env.DISPLAY ? 'kein Bildschirm – mit „xvfb-run -a npm run test:integration“ starten'
  : process.platform === 'win32' ? 'unter Windows nicht unterstützt'
  : !fs.existsSync(ELECTRON) ? 'Electron nicht installiert (npm install)' : false;

const ctx = {};
const RELEASE_NOTES = '## Neu\n\n- **Schneller** verbinden\n- <img src=x onerror=alert(1)> bleibt Text\n\nMehr auf [GitHub](https://github.com).';

before(async () => {
  if (missing) return;
  const root = tmpDir('s3cure-it-');
  ctx.root = root;
  const home = path.join(root, 'home');
  const config = path.join(root, 'config');
  const remote = path.join(root, 'remote');
  const local = path.join(root, 'local');
  for (const d of [home, config, remote, path.join(remote, 'ordner'), local]) fs.mkdirSync(d, { recursive: true });
  Object.assign(ctx, { home, config, remote, local });
  fs.writeFileSync(path.join(remote, 'hallo.txt'), 'Hallo Welt\n');
  fs.writeFileSync(path.join(remote, 'ordner', 'innen.txt'), 'innen\n');
  fs.writeFileSync(path.join(local, 'upload.txt'), 'Hochgeladen aus dem Test\n');

  ctx.sshd = await startSshd(path.join(root, 'sshd'));
  const { port, clientKey, hostPub } = ctx.sshd;
  fs.writeFileSync(path.join(config, 'known_hosts'), `[127.0.0.1]:${port} ${hostPub}\n`);
  fs.writeFileSync(path.join(config, 'hosts.json'), JSON.stringify({
    Testserver: { user: (await import('node:os')).userInfo().username, host: '127.0.0.1', port, key: clientKey },
  }, null, 2));
  // „Erster Start nach einem Update“: zuletzt gesehene Version ist älter als die laufende
  fs.writeFileSync(path.join(config, 'update-check.json'), JSON.stringify({ seenVersion: '0.0.1' }));

  // Gefälschte GitHub-API: Release mit Änderungstext (für „Was ist neu?“)
  const version = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8')).version;
  ctx.version = version;
  ctx.api = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ tag_name: `v${version}`, name: version, html_url: 'https://github.com/x/y', body: RELEASE_NOTES, assets: [] }));
  });
  const apiPort = await freePort();
  await new Promise(r => ctx.api.listen(apiPort, '127.0.0.1', r));

  const pagePort = await freePort();
  const mainPort = await freePort();
  const env = { ...process.env, HOME: home, S3CURE_CONFIG_DIR: config, S3CURE_UPDATE_URL: `http://127.0.0.1:${apiPort}/latest`, S3CURE_LANG: 'de' }; // prüft deutsche Texte
  delete env.SSH_AUTH_SOCK;
  ctx.app = spawn(ELECTRON, [`--remote-debugging-port=${pagePort}`, `--inspect=${mainPort}`, '--no-sandbox', '--disable-gpu', APP_DIR], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  ctx.log = '';
  ctx.app.stdout.on('data', d => { ctx.log += d; });
  ctx.app.stderr.on('data', d => { ctx.log += d; });

  ctx.page = await waitFor(() => cdpTarget(pagePort, t => t.type === 'page' && /index\.html/.test(t.url)), 'Hauptfenster', 60_000);
  ctx.main = await waitFor(() => cdpTarget(mainPort), 'Inspector des Hauptprozesses', 30_000);
  // Datei-Dialoge und „Im Ordner zeigen“ durch feste Antworten ersetzen
  await ctx.main.eval(`(() => {
    const { dialog, shell } = process.mainModule.require('electron');
    globalThis.__dialogs = { open: null, save: null };
    dialog.showOpenDialog = async () => ({ canceled: !__dialogs.open, filePaths: __dialogs.open || [] });
    dialog.showSaveDialog = async () => ({ canceled: !__dialogs.save, filePath: __dialogs.save || '' });
    shell.showItemInFolder = () => {};
    shell.openExternal = async () => {};
    return true;
  })()`);
  await waitFor(() => ctx.page.eval(`document.readyState === 'complete' && document.querySelectorAll('#host-list li').length`), 'Verbindungsliste');
});

after(async () => {
  ctx.page?.close();
  ctx.main?.close();
  if (ctx.app && ctx.app.exitCode === null) { ctx.app.kill(); await sleep(500); }
  ctx.sshd?.stop();
  ctx.api?.close();
  if (ctx.root) fs.rmSync(ctx.root, { recursive: true, force: true });
});

const t = (name, fn) => test(name, { skip: missing }, async () => {
  try { await fn(); } catch (err) {
    if (ctx.log) err.message += '\n--- Ausgabe der App ---\n' + ctx.log.slice(-3000);
    throw err;
  }
});
const page = expr => ctx.page.eval(expr);
const remoteFile = name => path.join(ctx.remote, name);

t('„Was ist neu?“ erscheint nach dem ersten Start einer neuen Version – als Text, ohne HTML', async () => {
  const info = await waitFor(() => page(`(() => {
    const d = document.querySelector('#whats-new');
    return d && !d.hidden && { title: d.querySelector('h2').textContent, items: [...d.querySelectorAll('li')].map(li => li.textContent), imgs: d.querySelectorAll('.wn-body *:not(ul):not(li):not(h3):not(p)').length };
  })()`), '„Was ist neu?“-Fenster');
  assert.equal(info.title, `Was ist neu in ${ctx.version}`);
  assert.deepEqual(info.items, ['Schneller verbinden', '<img src=x onerror=alert(1)> bleibt Text']);
  assert.equal(info.imgs, 0);
  await page(`document.querySelector('#whats-new [data-close]').click()`);
  await waitFor(() => page(`document.querySelector('#whats-new').hidden`), 'Fenster geschlossen');
  const st = JSON.parse(fs.readFileSync(path.join(ctx.config, 'update-check.json'), 'utf8'));
  assert.equal(st.seenVersion, ctx.version);
});

t('Verbinden per Doppelklick auf die gespeicherte Verbindung', async () => {
  await page(`document.querySelector('#host-list li').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
  const state = await waitFor(() => page(`(() => { const s = tabs.get(activeId)?.state; return s === 'open' || s === 'closed' ? s : null; })()`), 'Verbindung steht', 30_000);
  const termText = await page(`(() => { const b = tabs.get(activeId).term.buffer.active; let s = ''; for (let i = 0; i < b.length; i++) s += b.getLine(i).translateToString(true) + '\\n'; return s.trim(); })()`);
  assert.equal(state, 'open', 'Terminal: ' + termText + '\nsshd: ' + ctx.sshd.log());
  assert.match(await page(`document.querySelector('#tab-status-text').textContent`), /Verbunden mit/);
});

t('Befehl im Terminal ausführen', async () => {
  await page(`tabs.get(activeId).term.focus()`);
  await sleep(300);
  await ctx.page.insertText('echo S3CURE_$((6*7)) && pwd');
  await ctx.page.key('Enter', { keyCode: 13, text: '\r' });
  await waitFor(() => page(`(() => { const b = tabs.get(activeId).term.buffer.active; for (let i = 0; i < b.length; i++) if (b.getLine(i).translateToString(true).trim() === 'S3CURE_42') return true; return false; })()`), 'Ausgabe „S3CURE_42“ im Terminal');
});

t('Dateibrowser: Ordner öffnen und zurück', async () => {
  await page(`document.querySelector('#view-switch button[data-view=files]').click()`);
  await waitFor(() => page(`tabs.get(activeId).files.loaded`), 'Dateiliste geladen');
  await page(`(() => { const f = tabs.get(activeId).files; f.pathInput.value = ${JSON.stringify(ctx.remote)}; f.pathInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
  await waitFor(() => page(`tabs.get(activeId).files.path === ${JSON.stringify(ctx.remote)}`), 'Pfad gewechselt');
  const names = await page(`[...tabs.get(activeId).files.body.querySelectorAll('tr')].map(tr => tr.dataset.name)`);
  assert.deepEqual(names.filter(n => ['hallo.txt', 'ordner'].includes(n)).sort(), ['hallo.txt', 'ordner']);
  await page(`tabs.get(activeId).files.body.querySelector('tr[data-name=ordner]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
  await waitFor(() => page(`tabs.get(activeId).files.path.endsWith('/ordner') && !!tabs.get(activeId).files.body.querySelector('tr[data-name="innen.txt"]')`), 'Unterordner mit innen.txt');
  await page(`tabs.get(activeId).files.el.querySelector('[data-a=up]').click()`);
  await waitFor(() => page(`tabs.get(activeId).files.path === ${JSON.stringify(ctx.remote)}`), 'zurück im Ordner darüber');
});

t('Datei hochladen', async () => {
  await ctx.main.eval(`__dialogs.open = [${JSON.stringify(path.join(ctx.local, 'upload.txt'))}]`);
  await page(`tabs.get(activeId).files.el.querySelector('[data-a=upload]').click()`);
  // Windows/Linux: kleines Menü „Dateien / Ordner hochladen“; macOS: direkt der Dialog
  await page(`(() => { const b = [...document.querySelectorAll('#ctx-menu button')].find(b => /Dateien hochladen/.test(b.textContent)); if (b && !document.querySelector('#ctx-menu').hidden) b.click(); return true; })()`);
  await waitFor(() => fs.existsSync(remoteFile('upload.txt')) && fs.readFileSync(remoteFile('upload.txt'), 'utf8') === 'Hochgeladen aus dem Test\n', 'Datei auf dem Server');
  await waitFor(() => page(`!!tabs.get(activeId).files.body.querySelector('tr[data-name="upload.txt"]')`), 'Datei in der Liste');
});

t('Datei herunterladen', async () => {
  const target = path.join(ctx.local, 'heruntergeladen.txt');
  await ctx.main.eval(`__dialogs.save = ${JSON.stringify(target)}`);
  await page(`tabs.get(activeId).files.body.querySelector('tr[data-name="hallo.txt"]').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))`);
  await page(`tabs.get(activeId).files.el.querySelector('[data-a=download]').click()`);
  await waitFor(() => fs.existsSync(target) && fs.readFileSync(target, 'utf8') === 'Hallo Welt\n', 'heruntergeladene Datei');
});

t('Datei im Editor ändern und mit Strg+S speichern', async () => {
  await page(`tabs.get(activeId).files.body.querySelector('tr[data-name="hallo.txt"]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
  await waitFor(() => page(`(() => { const ta = [...document.querySelectorAll('.editor-text')].find(x => x.offsetParent); return ta && ta.value === 'Hallo Welt\\n'; })()`), 'Editor mit Dateiinhalt');
  await page(`(() => { const ta = [...document.querySelectorAll('.editor-text')].find(x => x.offsetParent); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); })()`);
  await ctx.page.insertText('Neue Zeile aus dem Test\n');
  const mod = process.platform === 'darwin' ? 4 : 2; // Cmd bzw. Strg
  await ctx.page.key('s', { code: 'KeyS', keyCode: 83, modifiers: mod });
  await waitFor(() => fs.readFileSync(remoteFile('hallo.txt'), 'utf8') === 'Hallo Welt\nNeue Zeile aus dem Test\n', 'gespeicherte Datei auf dem Server');
});
