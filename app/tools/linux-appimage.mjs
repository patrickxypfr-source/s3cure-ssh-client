// Linux: aus dem fertigen Build (build:linux) ein AppImage machen:
//   S3cure-SSH-Client-Linux-x64.AppImage – eine Datei, ausführbar machen und starten;
//   die App ersetzt sie bei Updates selbst (lib/updater.js, process.env.APPIMAGE)
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build, Platform, Arch } from 'electron-builder';

const APP_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const NAME = 'S3cure SSH Client';
const DIST = path.join(APP_DIR, '..', 'dist');
const PREPACKAGED = path.join(DIST, `${NAME}-linux-x64`);
const OUT = path.join(DIST, 'linux-appimage');
const FILE = 'S3cure-SSH-Client-Linux-x64.AppImage';
const pkg = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8'));

await build({
  targets: Platform.LINUX.createTarget('AppImage', Arch.x64),
  prepackaged: PREPACKAGED,
  projectDir: APP_DIR,
  publish: 'never',
  config: {
    appId: 'local.s3cure.sshclient',
    productName: NAME,
    executableName: NAME,
    copyright: `© ${new Date().getFullYear()} S3cure`,
    directories: { output: OUT, buildResources: 'build' },
    linux: {
      icon: 'assets/icon-1024.png',
      category: 'Network',
      synopsis: 'SSH- und SFTP-Client',
      description: 'Terminal, Dateien, Editor und Tunnel für deine Server in einem Fenster.',
      desktop: { entry: { Name: NAME, StartupWMClass: NAME, Keywords: 'ssh;sftp;terminal;server;' } },
    },
    appImage: { artifactName: FILE },
    // Nur Angabe für electron-builder (sonst Abbruch beim AppImage); veröffentlicht wird hier nichts,
    // die App aktualisiert sich über lib/updater.js
    publish: { provider: 'github', owner: 's3cureofficial', repo: 's3cure-ssh-client' },
    extraMetadata: { version: pkg.version },
  },
});
fs.renameSync(path.join(OUT, FILE), path.join(DIST, FILE));
fs.chmodSync(path.join(DIST, FILE), 0o755);
console.log(`${FILE} (${Math.round(fs.statSync(path.join(DIST, FILE)).size / 1e6)} MB)`);
fs.rmSync(OUT, { recursive: true, force: true });
