// macOS: Installationsfenster (.dmg) mit „In Programme ziehen“ aus dem fertigen Build.
// Aufruf: node tools/mac-dmg.mjs arm64|x64   (nach npm run build bzw. build:mac-intel)
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build, Platform, Arch } from 'electron-builder';

const APP_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const NAME = 'S3cure SSH Client';
const arch = process.argv[2] === 'x64' ? 'x64' : 'arm64';
const PREPACKAGED = path.join(APP_DIR, '..', 'dist', `${NAME}-darwin-${arch}`, `${NAME}.app`);
const OUT = path.join(APP_DIR, '..', 'dist', `dmg-${arch}`);
const FINAL = path.join(APP_DIR, '..', 'dist', `S3cure-SSH-Client-Mac-${arch === 'arm64' ? 'AppleSilicon' : 'Intel'}.dmg`);
const pkg = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8'));

await build({
  targets: Platform.MAC.createTarget('dmg', arch === 'x64' ? Arch.x64 : Arch.arm64),
  prepackaged: PREPACKAGED,
  projectDir: APP_DIR,
  publish: 'never',
  config: {
    appId: 'local.s3cure.sshclient',
    productName: NAME,
    directories: { output: OUT, buildResources: 'build' },
    mac: { identity: null }, // schon ad-hoc signiert (tools/zip.mjs) – keine Apple-Signatur vorhanden
    dmg: {
      title: `${NAME} ${pkg.version}`,
      artifactName: 'installer.dmg',
      icon: 'icon.icns',
      background: 'build/dmg-background.png',
      window: { width: 540, height: 380 },
      iconSize: 96,
      contents: [
        { x: 140, y: 190, type: 'file' },
        { x: 400, y: 190, type: 'link', path: '/Applications' },
      ],
    },
    extraMetadata: { version: pkg.version },
  },
});
fs.renameSync(path.join(OUT, 'installer.dmg'), FINAL);
fs.rmSync(OUT, { recursive: true, force: true });
console.log('DMG:', path.relative(path.join(APP_DIR, '..'), FINAL), `(${Math.round(fs.statSync(FINAL).size / 1e6)} MB)`);
