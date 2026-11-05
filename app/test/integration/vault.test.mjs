// Integrationstest Tresor: echte App (Electron) gegen einen lokalen sshd (nur Schlüssel-Anmeldung).
// Eintrag mit privatem Schlüssel in der Oberfläche anlegen, Verbindung damit verknüpfen und verbinden,
// Schlüssel kopieren (mit „Tresor nur nach Entsperren“), Eintrag löschen (Verbindung wird gelöst).
//
// Linux:  xvfb-run -a npm run test:integration   ·   macOS: npm run test:integration
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { startSshd, SSHD, cdpTarget, waitFor, freePort, sleep, tmpDir } from './helpers.mjs';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ELECTRON = createRequire(import.meta.url)('electron');

const missing = !SSHD ? 'sshd nicht gefunden (Linux: apt install openssh-server)'
  : process.platform === 'linux' && !process.env.DISPLAY ? 'kein Bildschirm – mit „xvfb-run -a npm run test:integration“ starten'
  : process.platform === 'win32' ? 'unter Windows nicht unterstützt'
  : !fs.existsSync(ELECTRON) ? 'Electron nicht installiert (npm install)' : false;

const ctx = {};
const APP_PASSWORD = 'app-sperre-123';

before(async () => {
  if (missing) return;
  const root = tmpDir('s3cure-vault-it-');
  ctx.root = root;
  const home = path.join(root, 'home');
  const config = path.join(root, 'config');
  for (const d of [home, config]) fs.mkdirSync(d, { recursive: true });
  ctx.config = config;
  ctx.sshd = await startSshd(path.join(root, 'sshd'));
  const { port, hostPub } = ctx.sshd;
  ctx.user = os.userInfo().username;
  fs.writeFileSync(path.join(config, 'known_hosts'), `[127.0.0.1]:${port} ${hostPub}\n`);
  // Ohne eigenen Schlüssel: anmelden klappt nur mit dem Schlüssel aus dem Tresor
  fs.writeFileSync(path.join(config, 'hosts.json'), JSON.stringify({
    Testserver: { user: 'falscher-benutzer', host: '127.0.0.1', port, key: null },
  }, null, 2));
  const version = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8')).version;
  fs.writeFileSync(path.join(config, 'update-check.json'), JSON.stringify({ seenVersion: version }));

  const pagePort = await freePort();
  const mainPort = await freePort();
  const env = { ...process.env, HOME: home, S3CURE_CONFIG_DIR: config, S3CURE_UPDATE_URL: 'http://127.0.0.1:9/latest', S3CURE_LANG: 'de' };
  delete env.SSH_AUTH_SOCK;
  // Linux ohne Schlüsselbund (CI, xvfb): einfache Verschlüsselung für safeStorage (siehe unten)
  const store = process.platform === 'linux' ? ['--password-store=basic'] : [];
  ctx.app = spawn(ELECTRON, [`--remote-debugging-port=${pagePort}`, `--inspect=${mainPort}`, '--no-sandbox', '--disable-gpu', ...store, APP_DIR], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  ctx.log = '';
  ctx.app.stdout.on('data', d => { ctx.log += d; });
  ctx.app.stderr.on('data', d => { ctx.log += d; });
  ctx.page = await waitFor(() => cdpTarget(pagePort, t => t.type === 'page' && /index\.html/.test(t.url)), 'Hauptfenster', 60_000);
  ctx.main = await waitFor(() => cdpTarget(mainPort), 'Inspector des Hauptprozesses', 30_000);
  // Linux ohne Schlüsselbund: safeStorage mit festem Test-Schlüssel (nur für diesen Test, nie in der App)
  if (process.platform === 'linux') {
    await ctx.main.eval(`(() => { const { safeStorage } = process.mainModule.require('electron');
      if (!safeStorage.isEncryptionAvailable() && safeStorage.setUsePlainTextEncryption) safeStorage.setUsePlainTextEncryption(true); return true; })()`);
  }
  await waitFor(() => ctx.page.eval(`document.readyState === 'complete' && document.querySelectorAll('#host-list li').length`), 'Verbindungsliste');
});

after(async () => {
  ctx.page?.close();
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
const page = expr => ctx.page.eval(expr);
const readJson = name => JSON.parse(fs.readFileSync(path.join(ctx.config, name), 'utf8'));
const clipboard = () => ctx.main.eval(`process.mainModule.require('electron').clipboard.readText()`);
// Text wie getippt in ein Feld (Fokus + Eingabe über CDP)
async function type(selector, text) {
  await page(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.focus(); el.value = ''; return true; })()`);
  await ctx.page.insertText(text);
}
const clickByTitle = (scope, title) => page(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(scope + ' button')})].find(b => b.title.startsWith(${JSON.stringify(title)})); if (!b) return false; b.click(); return true; })()`);
const clickByText = (scope, text) => page(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(scope + ' button')})].find(b => b.textContent.trim() === ${JSON.stringify(text)}); if (!b) return false; b.click(); return true; })()`);

t('Tresor-Eintrag mit privatem Schlüssel in den Einstellungen anlegen', async () => {
  await page(`Settings.open('vault')`);
  await waitFor(() => page(`!!document.querySelector('#settings-modal .vault-pane .cp-empty')`), 'leerer Tresor');
  assert.ok(await clickByText('#settings-modal .vault-pane .cp-top', 'Neuer Eintrag'));
  await waitFor(() => page(`!!document.querySelector('.vault-dialog')`), 'Dialog „Neuer Tresor-Eintrag“');
  await type('.vault-dialog input', 'Firmen-Login');
  await type('.vault-dialog label:nth-of-type(2) input', ctx.user);
  assert.ok(await clickByText('.vault-dialog .vault-keymode', 'Im Tresor'));
  await type('.vault-dialog textarea.vault-keytext', fs.readFileSync(ctx.sshd.clientKey, 'utf8'));
  await page(`document.querySelector('.vault-dialog button[type=submit]').click()`);
  await waitFor(() => page(`!document.querySelector('.vault-dialog') && [...document.querySelectorAll('#settings-modal .vault-list .cp-name')].map(e => e.textContent).includes('Firmen-Login')`), 'Eintrag in der Liste');

  const meta = readJson('vault.json');
  const [entry] = Object.values(meta.entries);
  ctx.entryId = entry.id;
  assert.equal(entry.name, 'Firmen-Login');
  assert.equal(entry.user, ctx.user);
  assert.equal(entry.keyType, 'ssh-ed25519');
  // Privater Schlüssel nie im Klartext auf der Platte
  for (const f of ['vault.json', 'vault-secrets.json']) assert.doesNotMatch(fs.readFileSync(path.join(ctx.config, f), 'utf8'), /PRIVATE KEY/);
  assert.ok(readJson('vault-secrets.json')[`${entry.id}:key`]);
  await page(`Settings.close()`);
});

t('Verbindung im Dialog mit dem Eintrag verknüpfen – Benutzer kommt aus dem Tresor', async () => {
  await page(`editHost('Testserver')`);
  await waitFor(() => page(`!document.querySelector('#host-modal').hidden && [...document.querySelector('#cred-field select').options].some(o => o.value === ${JSON.stringify(ctx.entryId)})`), 'Feld „Zugangsdaten“');
  await page(`(() => { const s = document.querySelector('#cred-field select'); s.value = ${JSON.stringify(ctx.entryId)}; s.dispatchEvent(new Event('change')); })()`);
  const ui = await page(`({ linked: document.querySelector('#host-form').classList.contains('cred-linked'), user: document.querySelector('#host-form').user.value,
    keyHidden: getComputedStyle(document.querySelector('#key-field')).display === 'none', hint: document.querySelector('.vault-host-hint').textContent })`);
  assert.equal(ui.linked, true);
  assert.equal(ui.user, ctx.user);
  assert.equal(ui.keyHidden, true);
  assert.match(ui.hint, /Firmen-Login/);
  await page(`document.querySelector('#host-form button[type=submit]').click()`);
  await waitFor(() => page(`document.querySelector('#host-modal').hidden`), 'Dialog geschlossen');
  const h = readJson('hosts.json').Testserver;
  assert.equal(h.credential, ctx.entryId);
  assert.equal(await page(`document.querySelector('#host-list li .pw-badge')?.title`), 'Zugangsdaten aus dem Tresor: Firmen-Login');
});

t('Verbinden mit dem Schlüssel aus dem Tresor', async () => {
  await page(`document.querySelector('#host-list li').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
  const state = await waitFor(() => page(`(() => { const s = tabs.get(activeId)?.state; return s === 'open' || s === 'closed' ? s : null; })()`), 'Verbindung steht', 30_000);
  assert.equal(state, 'open', 'sshd: ' + ctx.sshd.log());
  assert.match(await page(`document.querySelector('#tab-status-text').textContent`), new RegExp(`Verbunden mit ${ctx.user}@`));
  await page(`tabs.get(activeId).term.focus()`);
  await sleep(300);
  await ctx.page.insertText('echo VAULT_$((6*7))');
  await ctx.page.key('Enter', { keyCode: 13, text: '\r' });
  await waitFor(() => page(`(() => { const b = tabs.get(activeId).term.buffer.active; for (let i = 0; i < b.length; i++) if (b.getLine(i).translateToString(true).trim() === 'VAULT_42') return true; return false; })()`), 'Ausgabe im Terminal');
});

t('„Tresor nur nach Entsperren“: Kopieren fragt nach dem App-Passwort', async () => {
  await page(`api.configureLock({ enabled: true, password: ${JSON.stringify(APP_PASSWORD)} })`);
  await page(`Settings.open('vault')`);
  await waitFor(() => page(`!document.querySelector('#settings-modal .vault-lock-row input').disabled`), 'Schalter verfügbar');
  await page(`document.querySelector('#settings-modal .vault-lock-row input').click()`);
  await waitFor(() => readJson('vault.json').requireUnlock === true, 'Einstellung gespeichert');

  await clickByTitle('#settings-modal .vault-list', 'Bearbeiten');
  await waitFor(() => page(`!!document.querySelector('.vault-dialog .vault-keyinfo')`), 'Dialog mit gespeichertem Schlüssel');
  await ctx.main.eval(`process.mainModule.require('electron').clipboard.writeText('vorher')`);
  assert.ok(await clickByTitle('.vault-dialog', 'Privaten Schlüssel kopieren'));
  await waitFor(() => page(`!document.querySelector('#ask-modal').hidden && document.querySelector('#ask-title').textContent === 'Tresor entsperren'`), 'Rückfrage „Tresor entsperren“');
  assert.equal(await clipboard(), 'vorher');
  await type('#ask-input', 'falsch');
  await page(`document.querySelector('#ask-ok').click()`);
  await waitFor(() => page(`!document.querySelector('#ask-modal').hidden && /stimmt nicht/.test(document.querySelector('#ask-message').textContent)`), 'Hinweis „falsches Passwort“');
  await type('#ask-input', APP_PASSWORD);
  await page(`document.querySelector('#ask-ok').click()`);
  await waitFor(async () => /OPENSSH PRIVATE KEY/.test(await clipboard()), 'Schlüssel in der Zwischenablage');
  // Anzeigen: innerhalb der Minute nach dem Entsperren ohne erneute Frage, danach wieder ausgeblendet (10 s)
  assert.ok(await clickByTitle('.vault-dialog .vault-keyinfo', 'Anzeigen'));
  await waitFor(() => page(`/PRIVATE KEY/.test(document.querySelector('.vault-dialog textarea.vault-keytext')?.value || '')`), 'Schlüssel angezeigt');
  assert.equal(await page(`document.querySelector('#ask-modal').hidden`), true);
  await waitFor(() => page(`!document.querySelector('.vault-dialog textarea.vault-keytext')?.value`), 'Schlüssel wieder ausgeblendet', 15_000);
  await clickByText('.vault-dialog .actions', 'Abbrechen');
  await ctx.main.eval(`process.mainModule.require('electron').clipboard.clear()`);
});

t('Passwort erzeugen und Eintrag löschen: Rückfrage nennt die Verbindung, die danach gelöst ist', async () => {
  await clickByTitle('#settings-modal .vault-list', 'Bearbeiten');
  await waitFor(() => page(`!!document.querySelector('.vault-dialog')`), 'Dialog');
  assert.ok(await clickByTitle('.vault-dialog', 'Starkes Passwort erzeugen'));
  const pw = await waitFor(() => page(`(() => { const i = document.querySelector('.vault-dialog .vault-secret input'); return i.type === 'text' && i.value; })()`), 'erzeugtes Passwort sichtbar');
  assert.equal(pw.length, 24);
  await page(`document.querySelector('.vault-dialog button[type=submit]').click()`);
  await waitFor(() => page(`!document.querySelector('.vault-dialog')`), 'gespeichert');
  assert.doesNotMatch(fs.readFileSync(path.join(ctx.config, 'vault-secrets.json'), 'utf8'), new RegExp(pw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  await clickByTitle('#settings-modal .vault-list', 'Löschen');
  await waitFor(() => page(`!document.querySelector('#ask-modal').hidden && /Testserver/.test(document.querySelector('#ask-detail').textContent)`), 'Rückfrage mit betroffener Verbindung');
  await page(`document.querySelector('#ask-ok').click()`);
  await waitFor(() => page(`!!document.querySelector('#settings-modal .vault-pane .cp-empty')`), 'Tresor leer');
  const h = readJson('hosts.json').Testserver;
  assert.equal(h.credential, undefined);
  assert.equal(h.user, ctx.user); // Benutzer bleibt an der Verbindung
  assert.deepEqual(readJson('vault-secrets.json'), {});
  await page(`Settings.close()`);
});
