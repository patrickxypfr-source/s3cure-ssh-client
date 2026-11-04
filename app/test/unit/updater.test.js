// Automatisches Update: Wie ist die App installiert? (lib/updater.js)
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { setupUpdater, isAppImage } = require('../../lib/updater');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 's3cure-updater-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));

function kindFor(platform, { exe = '/opt/x/app', isPackaged = true } = {}) {
  const ipcMain = { handle() {} };
  const app = { isPackaged, getPath: () => exe, getVersion: () => '1.0.0' };
  return setupUpdater({ ipcMain, app, platform, getMainWin: () => null, latestRelease: async () => null, preload: '' }).installKind();
}

const saved = { APPIMAGE: process.env.APPIMAGE, PORTABLE_EXECUTABLE_FILE: process.env.PORTABLE_EXECUTABLE_FILE };
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

test('Entwicklungsmodus (npm start): keine Updates', () => {
  assert.equal(kindFor('linux', { isPackaged: false }).kind, 'dev');
});

test('Linux als AppImage: laufende Datei wird ersetzt', () => {
  process.env.APPIMAGE = '/home/nutzer/Programme/S3cure.AppImage';
  assert.deepEqual(kindFor('linux'), {
    kind: 'linux-appimage', target: '/home/nutzer/Programme/S3cure.AppImage',
    files: ['S3cure-SSH-Client-Linux-x64.AppImage'], fallback: 'S3cure-SSH-Client-Linux-x64.AppImage',
  });
});

test('Linux ohne AppImage (z. B. entpackt): neue Datei nur herunterladen', () => {
  delete process.env.APPIMAGE;
  assert.deepEqual(kindFor('linux'), { kind: 'handoff', files: ['S3cure-SSH-Client-Linux-x64.AppImage'] });
  process.env.APPIMAGE = 'relativ/pfad';
  assert.equal(kindFor('linux').kind, 'handoff');
});

test('Windows portable und macOS', () => {
  process.env.PORTABLE_EXECUTABLE_FILE = 'C:\\\\S3cure.exe';
  assert.equal(kindFor('win32').kind, 'win-portable');
  delete process.env.PORTABLE_EXECUTABLE_FILE;
  assert.equal(kindFor('win32').kind, 'handoff');
  const mac = kindFor('darwin', { exe: '/Applications/S3cure SSH Client.app/Contents/MacOS/S3cure SSH Client' });
  assert.equal(mac.kind, 'mac');
  assert.equal(mac.bundle, '/Applications/S3cure SSH Client.app');
  assert.equal(kindFor('freebsd').kind, 'unknown');
});

test('isAppImage erkennt AppImage-Dateien am Dateikopf', () => {
  const good = path.join(tmp, 'good.AppImage');
  const elf = path.join(tmp, 'elf');
  const text = path.join(tmp, 'text');
  fs.writeFileSync(good, Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, 0x41, 0x49, 0x02]), Buffer.alloc(100)]));
  fs.writeFileSync(elf, Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, 0, 0, 0]), Buffer.alloc(100)]));
  fs.writeFileSync(text, '<html>Fehlerseite</html>');
  assert.equal(isAppImage(good), true);
  assert.equal(isAppImage(elf), false);
  assert.equal(isAppImage(text), false);
  assert.equal(isAppImage(path.join(tmp, 'fehlt')), false);
});
