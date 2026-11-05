// Release-Text aus CHANGELOG.md (+ CHANGELOG.en.md): gibt den Abschnitt einer Version aus (für GitHub-Releases).
// Aufruf: node app/tools/release-notes.mjs 1.2.0 > notes.md
// Zuerst der deutsche Abschnitt; hat CHANGELOG.en.md dieselbe Version, folgt darunter der englische,
// getrennt durch „<!-- lang:en -->“ (Aufbau und Gründe: combineLanguages in app/lib/release-notes.js).
// Fehlt der deutsche Abschnitt, endet das Skript mit Code 1 (der Workflow nimmt dann automatische Notizen).
// Fehlt nur der englische, gibt es eine Warnung (der Release-Text ist dann nur deutsch).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { changelogSection, combineLanguages } = require('../lib/release-notes.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const version = String(process.argv[2] || '').replace(/^v/, '');
if (!version) { console.error('Aufruf: node app/tools/release-notes.mjs <version>'); process.exit(2); }
const section = changelogSection(fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8'), version);
if (!section) { console.error(`CHANGELOG.md: kein Abschnitt „## ${version}“ gefunden.`); process.exit(1); }
let en = '';
try { en = changelogSection(fs.readFileSync(path.join(ROOT, 'CHANGELOG.en.md'), 'utf8'), version); } catch { /* keine englische Datei */ }
if (!en) console.error(`Hinweis: CHANGELOG.en.md hat keinen Abschnitt „## ${version}“ – der Release-Text ist nur deutsch.`);
process.stdout.write(combineLanguages(section, en) + '\n');
