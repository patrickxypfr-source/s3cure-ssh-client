// Windows: aus dem fertigen Build (build:win) den Installer machen:
//   S3cure-SSH-Client-Setup.exe – Installationsfenster, Startmenü/Desktop, Deinstallation;
//                                 darüber laufen später auch die automatischen Updates
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build, Platform } from 'electron-builder';

const APP_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const NAME = 'S3cure SSH Client';
const DIST = path.join(APP_DIR, '..', 'dist');
const PREPACKAGED = path.join(DIST, `${NAME}-win32-x64`);
const OUT = path.join(DIST, 'win-installers');
const pkg = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8'));

await build({
  targets: Platform.WINDOWS.createTarget('nsis', 1 /* x64 */),
  prepackaged: PREPACKAGED,
  projectDir: APP_DIR,
  publish: 'never',
  config: {
    appId: 'local.s3cure.sshclient',
    productName: NAME,
    copyright: `© ${new Date().getFullYear()} S3cure`,
    directories: { output: OUT, buildResources: 'build' },
    win: { icon: 'icon.ico', signAndEditExecutable: false },
    nsis: {
      artifactName: 'nsis-installer.exe',
      // Hinweis „unsicherer Dateiname“ (setup/install): der Installer hat ein eigenes Manifest, daher unkritisch
      warningsAsErrors: false,
      oneClick: false,                          // richtiges Installationsfenster
      perMachine: false,                        // für den Benutzer – keine Admin-Rechte, Updates ohne Rückfrage
      allowToChangeInstallationDirectory: true,
      createDesktopShortcut: true,
      createStartMenuShortcut: true,
      shortcutName: NAME,
      runAfterFinish: true,
      installerIcon: 'icon.ico',
      uninstallerIcon: 'icon.ico',
      uninstallDisplayName: NAME,
      deleteAppDataOnUninstall: false,
      language: '1031',
      installerLanguages: ['de_DE'],
    },
    extraMetadata: { version: pkg.version },
  },
});
const move = (from, to) => { fs.renameSync(path.join(OUT, from), path.join(DIST, to)); console.log(`${to} (${Math.round(fs.statSync(path.join(DIST, to)).size / 1e6)} MB)`); };
move('nsis-installer.exe', 'S3cure-SSH-Client-Setup.exe');
fs.rmSync(OUT, { recursive: true, force: true });
