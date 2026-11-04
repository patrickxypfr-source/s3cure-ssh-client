// Ordner oder .app als ZIP verpacken – auf jedem Betriebssystem mit Bordmitteln:
//   macOS: ditto (behält Symlinks/Rechte im .app-Bundle), Windows: tar.exe (bsdtar), Linux: zip
// Aufruf: node tools/zip.mjs <Quelle> <Ziel.zip>
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function zipDir(src, zip) {
  src = path.resolve(src);
  zip = path.resolve(zip);
  if (!fs.existsSync(src)) throw new Error('Nicht gefunden: ' + src);
  fs.rmSync(zip, { force: true });
  const opts = { stdio: 'inherit' };
  if (process.platform === 'darwin') {
    // .app neu ad-hoc signieren: Der Packager verändert das Bundle, danach passt Electrons
    // Signatur nicht mehr – heruntergeladen meldet macOS die App sonst als „beschädigt“.
    if (src.endsWith('.app')) {
      execFileSync('codesign', ['--force', '--deep', '--sign', '-', src], opts);
      execFileSync('codesign', ['--verify', '--deep', '--strict', src], opts);
      console.log('Ad-hoc signiert:', path.basename(src));
    }
    execFileSync('ditto',['-c', '-k', '--keepParent', src, zip], opts);
  } else if (process.platform === 'win32') {
    // Das tar von Windows (nicht das aus Git) kann ZIP schreiben
    const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    execFileSync(tar, ['-a', '-c', '-f', zip, '-C', path.dirname(src), path.basename(src)], opts);
  } else {
    execFileSync('zip', ['-q', '-r', '-y', zip, path.basename(src)], { ...opts, cwd: path.dirname(src) });
  }
  console.log('ZIP:', zip, `(${Math.round(fs.statSync(zip).size / 1e6)} MB)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [src, zip] = process.argv.slice(2);
  if (!src || !zip) { console.error('Aufruf: node tools/zip.mjs <Quelle> <Ziel.zip>'); process.exit(1); }
  zipDir(src, zip);
}
