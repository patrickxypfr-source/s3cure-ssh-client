// Windows: aus dem fertigen Build eine einzelne, portable .exe machen (ohne Installation).
// Nutzt den bereits gepackten Ordner von build:win (Icon/Infos schon eingetragen).
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build, Platform } from 'electron-builder';

const APP_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const NAME = 'S3cure SSH Client';
const PREPACKAGED = path.join(APP_DIR, '..', 'dist', `${NAME}-win32-x64`);
const OUT = path.join(APP_DIR, '..', 'dist', 'portable');
const FINAL = path.join(APP_DIR, '..', 'dist', 'S3cure-SSH-Client-Windows-Portable.exe');
const pkg = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8'));

await build({
  targets: Platform.WINDOWS.createTarget('portable', 1 /* x64 */),
  prepackaged: PREPACKAGED,
  projectDir: APP_DIR,
  publish: 'never',
  config: {
    appId: 'local.s3cure.sshclient',
    productName: NAME,
    directories: { output: OUT },
    win: { icon: 'icon.ico', signAndEditExecutable: false },
    portable: { artifactName: 'portable.exe' },
    extraMetadata: { version: pkg.version },
  },
});
fs.renameSync(path.join(OUT, 'portable.exe'), FINAL);
fs.rmSync(OUT, { recursive: true, force: true });
console.log('Portable:', path.relative(path.join(APP_DIR, '..'), FINAL), `(${Math.round(fs.statSync(FINAL).size / 1e6)} MB)`);
