// Nachbearbeitung des Windows-Builds (läuft auf Mac, Windows und Linux, ohne Wine):
// 1. icon.ico nehmen (liegt im Repo). Neu erzeugen aus assets/icon-1024.png nur mit
//    `node tools/win-finish.mjs --new-icon` (braucht `sips`, also macOS)
// 2. Symbol und Programm-Infos in die .exe schreiben
// 3. (Installer und portable .exe: tools/win-installers.mjs)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as ResEdit from 'resedit';

const APP_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const NAME = 'S3cure SSH Client';
const BUILD = path.join(APP_DIR, '..', 'dist', `${NAME}-win32-x64`);
const EXE = path.join(BUILD, `${NAME}.exe`);
const ICO = path.join(APP_DIR, 'icon.ico');
const pkg = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8'));

// --- 1. ICO-Datei (PNG-Bilder in einem ICO-Container) ---
function makeIco() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 's3ico-'));
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const images = sizes.map(size => {
    const out = path.join(tmp, `${size}.png`);
    execFileSync('sips', ['-z', String(size), String(size), path.join(APP_DIR, 'assets', 'icon-1024.png'), '--out', out], { stdio: 'ignore' });
    return { size, data: fs.readFileSync(out) };
  });
  fs.rmSync(tmp, { recursive: true, force: true });

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserviert
  header.writeUInt16LE(1, 2); // Typ: Icon
  header.writeUInt16LE(images.length, 4);
  const dir = Buffer.alloc(16 * images.length);
  let offset = 6 + dir.length;
  images.forEach((img, i) => {
    const o = i * 16;
    dir.writeUInt8(img.size >= 256 ? 0 : img.size, o);     // Breite (0 = 256)
    dir.writeUInt8(img.size >= 256 ? 0 : img.size, o + 1); // Höhe
    dir.writeUInt8(0, o + 2);                              // Farbpalette
    dir.writeUInt8(0, o + 3);
    dir.writeUInt16LE(1, o + 4);                           // Farbebenen
    dir.writeUInt16LE(32, o + 6);                          // Bit pro Pixel
    dir.writeUInt32LE(img.data.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += img.data.length;
  });
  fs.writeFileSync(ICO, Buffer.concat([header, dir, ...images.map(i => i.data)]));
  console.log('icon.ico erstellt');
}

// --- 2. Symbol + Versionsinfos in die .exe ---
function patchExe() {
  const exe = ResEdit.NtExecutable.from(fs.readFileSync(EXE), { ignoreCert: true });
  const res = ResEdit.NtExecutableResource.from(exe);

  const iconFile = ResEdit.Data.IconFile.from(fs.readFileSync(ICO));
  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
  const target = groups[0] || { id: 1, lang: 1033 };
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, target.id, target.lang, iconFile.icons.map(i => i.data));

  const [vi] = ResEdit.Resource.VersionInfo.fromEntries(res.entries);
  const [a, b, c] = pkg.version.split('.').map(Number);
  vi.setFileVersion(a, b, c, 0, 1033);
  vi.setProductVersion(a, b, c, 0, 1033);
  vi.setStringValues({ lang: 1033, codepage: 1200 }, {
    ProductName: NAME,
    FileDescription: NAME,
    CompanyName: 'S3cure',
    LegalCopyright: `© ${new Date().getFullYear()} S3cure`,
    OriginalFilename: `${NAME}.exe`,
    InternalName: NAME,
    FileVersion: pkg.version,
    ProductVersion: pkg.version,
  });
  vi.outputToResourceEntries(res.entries);

  res.outputResource(exe);
  fs.writeFileSync(EXE, Buffer.from(exe.generate()));
  console.log(`Symbol und Infos eingetragen (Icon-Gruppe ${target.id})`);
}

// --- 3. Installer ---

if (!fs.existsSync(EXE)) { console.error('Kein Windows-Build gefunden:', EXE); process.exit(1); }
if (process.argv.includes('--new-icon') || !fs.existsSync(ICO)) {
  if (process.platform !== 'darwin') { console.error('icon.ico fehlt und kann nur auf dem Mac (sips) erzeugt werden.'); process.exit(1); }
  makeIco();
} else {
  console.log('icon.ico vorhanden – wird verwendet');
}
patchExe();
// Keine Windows-ZIP mehr: Installer und portable .exe macht tools/win-installers.mjs
