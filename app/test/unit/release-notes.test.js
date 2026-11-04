// „Was ist neu?“: CHANGELOG-Abschnitte und sicheres Zerlegen von Markdown (lib/release-notes.js)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { changelogSection, parseNotes } = require('../../lib/release-notes');

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
