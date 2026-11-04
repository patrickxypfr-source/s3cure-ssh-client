// Nachbearbeitung des Windows-Builds (läuft auf dem Mac, ohne Wine):
// 1. icon.ico aus assets/icon-1024.png erzeugen
// 2. Symbol und Programm-Infos in die .exe schreiben
// 3. alles als ZIP zum Weitergeben verpacken
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
const ZIP = path.join(APP_DIR, '..', 'dist', 'S3cure-SSH-Client-Windows-x64.zip');
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

// --- 3. ZIP ---
function zip() {
  fs.rmSync(ZIP, { force: true });
  execFileSync('ditto', ['-c', '-k', '--keepParent', BUILD, ZIP]);
  console.log('ZIP:', path.relative(path.join(APP_DIR, '..'), ZIP), `(${Math.round(fs.statSync(ZIP).size / 1e6)} MB)`);
}

if (!fs.existsSync(EXE)) { console.error('Kein Windows-Build gefunden:', EXE); process.exit(1); }
makeIco();
patchExe();
zip();
