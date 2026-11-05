// „Was ist neu?“: CHANGELOG-Abschnitte und sicheres Zerlegen von Markdown (lib/release-notes.js)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { changelogSection, parseNotes, splitLanguages, notesForLang, combineLanguages } = require('../../lib/release-notes');

const CHANGELOG = `# Änderungsprotokoll

## [Unveröffentlicht]
- kommt noch

## 1.10.0 – 2026-12-01
- Zehn

## [1.1.0] – 2026-11-04
### Neu
- Eins

## 1.0.0
- Null
`;

test('changelogSection findet genau die Version', () => {
  assert.equal(changelogSection(CHANGELOG, '1.1.0'), '### Neu\n- Eins');
  assert.equal(changelogSection(CHANGELOG, 'v1.10.0'), '- Zehn');
  assert.equal(changelogSection(CHANGELOG, '1.0.0'), '- Null');
  assert.equal(changelogSection(CHANGELOG, '1.1'), '');
  assert.equal(changelogSection(CHANGELOG, '2.0.0'), '');
  assert.equal(changelogSection('', '1.0.0'), '');
});

test('parseNotes: Überschriften, Listen, Absätze als reiner Text', () => {
  const md = '## Neu\n\n- **Fett** und `code`\n* [Link](https://x.y) hier\n1. nummeriert\n  Fortsetzung\n\nEin\nAbsatz mit _Betonung_.\n\n```\ngeheim\n```\n---\n> Zitat';
  assert.deepEqual(parseNotes(md), [
    { type: 'h', text: 'Neu' },
    { type: 'li', text: 'Fett und code' },
    { type: 'li', text: 'Link hier' },
    { type: 'li', text: 'nummeriert Fortsetzung' },
    { type: 'p', text: 'Ein Absatz mit Betonung.' },
    { type: 'p', text: 'Zitat' },
  ]);
});

test('parseNotes lässt HTML als Text stehen (wird nie als HTML eingesetzt)', () => {
  const blocks = parseNotes('- <img src=x onerror=alert(1)>\n<script>alert(1)</script>');
  assert.deepEqual(blocks, [{ type: 'li', text: '<img src=x onerror=alert(1)>' }, { type: 'p', text: '<script>alert(1)</script>' }]);
  for (const b of blocks) assert.deepEqual(Object.keys(b).sort(), ['text', 'type']);
});

test('parseNotes begrenzt Länge und Anzahl', () => {
  assert.equal(parseNotes('- ' + 'x'.repeat(2000))[0].text.length, 500);
  assert.equal(parseNotes(Array.from({ length: 200 }, (_, i) => `- ${i}`).join('\n')).length, 60);
  assert.deepEqual(parseNotes(null), []);
});

test('CHANGELOG.md im Repo hat einen Abschnitt für die aktuelle Version', () => {
  const root = path.join(__dirname, '..', '..', '..');
  const version = JSON.parse(fs.readFileSync(path.join(root, 'app', 'package.json'), 'utf8')).version;
  const section = changelogSection(fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'), version);
  assert.ok(section, `Abschnitt „## ${version}“ fehlt in CHANGELOG.md`);
  assert.ok(parseNotes(section).some(b => b.type === 'li'), 'Abschnitt ohne Listenpunkte');
});

// ---------- Zwei Sprachen im Release-Text ----------

const DE = '### Neu\n- Englisch als Sprache';
const EN = '### New\n- English as a language';

test('Der Release-Text enthält Deutsch zuerst und Englisch nach der Trennzeile', () => {
  const body = combineLanguages(DE, EN);
  assert.ok(body.startsWith(DE));
  assert.match(body, /\n<!-- lang:en -->\n/);
  assert.ok(body.indexOf('<!-- lang:en -->') < body.indexOf('## English'));
  assert.ok(body.endsWith(EN));
  assert.equal(combineLanguages(DE, ''), DE, 'ohne englischen Abschnitt nur Deutsch');
});

test('Der Release-Text wird wieder in Deutsch und Englisch zerlegt', () => {
  assert.deepEqual(splitLanguages(combineLanguages(DE, EN)), { de: DE, en: EN });
  assert.deepEqual(splitLanguages(DE), { de: DE, en: '' });
  assert.deepEqual(splitLanguages(DE + '\r\n<!--lang:EN-->\r\n## English\r\n' + EN), { de: DE, en: EN });
  assert.deepEqual(splitLanguages(null), { de: '', en: '' });
});

test('Die App zeigt den Teil in ihrer Sprache und sonst Deutsch', () => {
  const body = combineLanguages(DE, EN);
  assert.equal(notesForLang(body, 'en'), EN);
  assert.equal(notesForLang(body, 'de'), DE);
  assert.equal(notesForLang(DE, 'en'), DE, 'alter Release-Text ohne Englisch');
});

test('Ältere App-Versionen zeigen bei zwei Sprachen nichts Kaputtes', () => {
  // So zerlegt 1.2.0 den Text (parseNotes ohne Sprachtrennung): kein HTML-Kommentar, keine Trennlinie
  const blocks = parseNotes(combineLanguages(DE, EN));
  assert.deepEqual(blocks, [
    { type: 'h', text: 'Neu' }, { type: 'li', text: 'Englisch als Sprache' },
    { type: 'h', text: 'English' },
    { type: 'h', text: 'New' }, { type: 'li', text: 'English as a language' },
  ]);
});

test('CHANGELOG.en.md hat dieselben Versionen wie CHANGELOG.md', () => {
  const root = path.join(__dirname, '..', '..', '..');
  const versions = file => [...fs.readFileSync(path.join(root, file), 'utf8').matchAll(/^##\s+\[?v?(\d+\.\d+\.\d+)/gm)].map(m => m[1]);
  assert.deepEqual(versions('CHANGELOG.en.md'), versions('CHANGELOG.md'));
  const version = JSON.parse(fs.readFileSync(path.join(root, 'app', 'package.json'), 'utf8')).version;
  const section = changelogSection(fs.readFileSync(path.join(root, 'CHANGELOG.en.md'), 'utf8'), version);
  assert.ok(parseNotes(section).some(b => b.type === 'li'), `Abschnitt „## ${version}“ fehlt in CHANGELOG.en.md`);
});
