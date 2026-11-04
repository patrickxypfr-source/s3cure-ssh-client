// Start-Rauchtest: gebaute App kurz starten, prüfen ob das Fenster die Oberfläche lädt, wieder beenden.
// Aufruf: node tools/smoke-test.mjs <Programm> [weitere Argumente …]
//   Windows: node tools/smoke-test.mjs "../dist/S3cure SSH Client-win32-x64/S3cure SSH Client.exe"
//   Mac:     node tools/smoke-test.mjs "../dist/S3cure SSH Client-darwin-arm64/S3cure SSH Client.app/Contents/MacOS/S3cure SSH Client"
// Über --remote-debugging-port wird die Seite abgefragt (Chrome DevTools Protocol).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

const [exe, ...extra] = process.argv.slice(2);
if (!exe) { console.error('Aufruf: node tools/smoke-test.mjs <Programm> [Argumente]'); process.exit(2); }
if (!fs.existsSync(exe)) { console.error('Programm nicht gefunden:', exe); process.exit(2); }

const PORT = 9300 + Math.floor(Math.random() * 500);
const TIMEOUT = 90_000;
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 's3cure-smoke-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));

const child = spawn(exe, [...extra, `--remote-debugging-port=${PORT}`], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, S3CURE_CONFIG_DIR: configDir, S3CURE_UPDATE_URL: 'http://127.0.0.1:9/keine-updates-im-test' },
});
let exited = null;
child.on('exit', code => { exited = code; });
let log = '';
child.stdout.on('data', d => { log += d; });
child.stderr.on('data', d => { log += d; });

function stop() {
  if (exited !== null) return;
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else child.kill('SIGTERM');
  } catch { /* schon beendet */ }
}

function evaluate(wsUrl, expression) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => { ws.close(); reject(new Error('Keine Antwort über DevTools')); }, 10_000);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
    ws.onmessage = ev => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== 1) return;
      clearTimeout(timer);
      ws.close();
      if (msg.result?.exceptionDetails) reject(new Error(msg.result.exceptionDetails.text));
      else resolve(msg.result?.result?.value);
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('WebSocket-Fehler')); };
  });
}

// Was im Fenster vorhanden sein muss
const CHECK = `JSON.stringify({
  ready: document.readyState,
  title: document.title,
  sidebar: !!document.querySelector('#sidebar .brand'),
  bridge: typeof window.myssh === 'object' && typeof window.myssh.connect === 'function',
  tunnels: typeof window.tunnelUi === 'object',
  icons: document.querySelectorAll('svg.ic').length,
})`;

async function main() {
  const start = Date.now();
  let last = 'noch nichts';
  while (Date.now() - start < TIMEOUT) {
    if (exited !== null) throw new Error(`App hat sich sofort beendet (Code ${exited}).`);
    try {
      const pages = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = pages.find(p => p.type === 'page' && /index\.html/.test(p.url));
      if (page) {
        const info = JSON.parse(await evaluate(page.webSocketDebuggerUrl, CHECK));
        last = JSON.stringify(info);
        if (info.ready === 'complete' && info.sidebar && info.bridge && info.tunnels && info.icons > 0) {
          console.log(`OK nach ${((Date.now() - start) / 1000).toFixed(1)} s:`, last);
          return;
        }
      }
    } catch (err) { last = err.message; }
    await sleep(1000);
  }
  throw new Error('Fenster nicht rechtzeitig geladen. Letzter Stand: ' + last);
}

main().then(() => { stop(); process.exitCode = 0; }, err => {
  console.error('Rauchtest fehlgeschlagen:', err.message);
  if (log.trim()) console.error('--- Ausgabe der App ---\n' + log.slice(-4000));
  stop();
  process.exitCode = 1;
}).finally(async () => {
  await sleep(1500);
  try { fs.rmSync(configDir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* Windows: Datei noch gesperrt */ }
  process.exit(process.exitCode);
});
