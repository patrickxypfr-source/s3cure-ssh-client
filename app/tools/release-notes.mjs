// Release-Text aus CHANGELOG.md: gibt den Abschnitt einer Version aus (für GitHub-Releases).
// Aufruf: node app/tools/release-notes.mjs 1.2.0 > notes.md
// Fehlt der Abschnitt, endet das Skript mit Code 1 (der Workflow nimmt dann automatische Notizen).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { changelogSection } = require('../lib/release-notes.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const version = String(process.argv[2] || '').replace(/^v/, '');
if (!version) { console.error('Aufruf: node app/tools/release-notes.mjs <version>'); process.exit(2); }
const section = changelogSection(fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8'), version);
if (!section) { console.error(`CHANGELOG.md: kein Abschnitt „## ${version}“ gefunden.`); process.exit(1); }
process.stdout.write(section + '\n');
