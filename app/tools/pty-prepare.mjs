// node-pty fürs Bauen vorbereiten (läuft vor electron-packager, auch in GitHub Actions):
// - Mac: „spawn-helper“ ausführbar machen (kommt im npm-Paket ohne Ausführrecht -> „posix_spawnp failed“)
// - Linux: es gibt keine fertigen Bausteine -> einmal mit node-gyp bauen (N-API, passt zu Electron)
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', 'node-pty');
if (!fs.existsSync(root)) { console.error('node-pty fehlt – erst „npm install“'); process.exit(1); }

const prebuilds = path.join(root, 'prebuilds');
for (const dir of fs.existsSync(prebuilds) ? fs.readdirSync(prebuilds) : []) {
  const helper = path.join(prebuilds, dir, 'spawn-helper');
  if (fs.existsSync(helper)) { fs.chmodSync(helper, 0o755); console.log('ausführbar:', path.relative(root, helper)); }
}

if (process.platform === 'linux' && !fs.existsSync(path.join(root, 'build', 'Release', 'pty.node'))) {
  console.log('Baue node-pty für Linux …');
  execSync('npx --yes node-gyp@11 rebuild', { cwd: root, stdio: 'inherit' });
}
const release = path.join(root, 'build', 'Release', 'spawn-helper');
if (fs.existsSync(release)) fs.chmodSync(release, 0o755);
console.log('node-pty bereit.');
