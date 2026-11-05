// „Was ist neu?“: Änderungstexte (CHANGELOG.md bzw. Release-Text auf GitHub) lesen.
//
// Markdown wird hier nur grob verstanden und in einfache Bausteine zerlegt:
//   [{ type: 'h', text }, { type: 'li', text }, { type: 'p', text }]
// Die Oberfläche setzt nur diese Texte ein (textContent) – HTML aus dem Release-Text
// wird nie als HTML ausgeführt, sondern höchstens als Text angezeigt.

const MAX_BLOCKS = 60;
const MAX_TEXT = 500;

// Abschnitt einer Version aus CHANGELOG.md, z. B. „## 1.1.0 – 2026-11-04“ oder „## [1.1.0]“.
// Ergebnis: Text unter der Überschrift bis zur nächsten Versions-Überschrift, sonst ''.
function changelogSection(text, version) {
  const v = String(version || '').replace(/^v/, '').replace(/[.]/g, '\\.');
  if (!v) return '';
  const lines = String(text || '').split(/\r?\n/);
  const head = new RegExp(`^##\\s+\\[?v?${v}\\]?(?=\\s|$)`);
  const start = lines.findIndex(l => head.test(l));
  if (start < 0) return '';
  let end = lines.findIndex((l, i) => i > start && /^##\s/.test(l));
  if (end < 0) end = lines.length;
  return lines.slice(start + 1, end).join('\n').trim();
}

// Inline-Markdown zu reinem Text: **fett**, `code`, [Link](url), ![Bild](url)
function inline(s) {
  return s
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, '$2')
    .replace(/(^|[\s(])[*_](?=\S)([^*_]+?)(?<=\S)[*_](?=$|[\s).,:;!?])/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TEXT);
}

function parseNotes(markdown) {
  const blocks = [];
  let para = [];
  const flush = () => { if (para.length) { const text = inline(para.join(' ')); if (text) blocks.push({ type: 'p', text }); para = []; } };
  let fence = false;
  for (const raw of String(markdown || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (/^(```|~~~)/.test(line)) { flush(); fence = !fence; continue; }
    if (fence) continue; // Code-Blöcke weglassen
    if (!line || /^(-{3,}|\*{3,}|_{3,})$/.test(line) || /^<!--.*-->$/.test(line)) { flush(); continue; }
    let m;
    if ((m = /^#{1,6}\s+(.*?)\s*#*$/.exec(line))) { flush(); const text = inline(m[1]); if (text) blocks.push({ type: 'h', text }); }
    else if ((m = /^(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.*)$/.exec(line))) { flush(); const text = inline(m[1]); if (text) blocks.push({ type: 'li', text }); }
    else if (/^\s{2,}\S/.test(raw) && blocks.length && blocks[blocks.length - 1].type === 'li' && !para.length) {
      // eingerückte Fortsetzung eines Listenpunkts
      const last = blocks[blocks.length - 1];
      last.text = inline(last.text + ' ' + line);
    } else para.push(line.replace(/^>\s?/, ''));
    if (blocks.length >= MAX_BLOCKS) break;
  }
  flush();
  return blocks.slice(0, MAX_BLOCKS);
}

// ---------- Zwei Sprachen im Release-Text ----------
//
// Der Release-Text auf GitHub enthält zuerst den deutschen Abschnitt (CHANGELOG.md) und darunter –
// wenn CHANGELOG.en.md dieselbe Version hat – den englischen (app/tools/release-notes.mjs):
//
//   … deutscher Abschnitt …
//   <!-- lang:en -->
//   ---
//   ## English
//   … englischer Abschnitt …
//
// Warum diese Trennung:
// - Die App teilt den Text an der Zeile „<!-- lang:en -->“ (eindeutig, kommt in normalem Text nie vor).
// - Auf GitHub ist der HTML-Kommentar unsichtbar; man sieht eine Trennlinie und „English“ als Überschrift.
// - Ältere Versionen (1.2.0) kennen die Trennung nicht: parseNotes() lässt einzeilige HTML-Kommentare
//   und „---“ weg, es erscheint also nur zusätzlich die Überschrift „English“ mit den englischen Punkten
//   unter den deutschen – nichts Kaputtes, kein sichtbares Markup. Der deutsche Teil steht immer zuerst
//   (und wird bei der Begrenzung auf 60 Bausteine nie abgeschnitten).
const LANG_MARKER = '<!-- lang:en -->';
const MARKER_RE = /^\s*<!--\s*lang:\s*en\s*-->\s*$/i;

// Release-Text -> { de, en } (en = '' ohne englischen Teil)
function splitLanguages(text) {
  const lines = String(text || '').split(/\r?\n/);
  const at = lines.findIndex(l => MARKER_RE.test(l));
  if (at < 0) return { de: lines.join('\n').trim(), en: '' };
  const en = lines.slice(at + 1);
  // Trennlinie und Überschrift „English“ gehören nur zur Anzeige auf GitHub
  while (en.length && (!en[0].trim() || /^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(en[0]))) en.shift();
  if (en.length && /^\s*#{1,6}\s+English\s*#*\s*$/i.test(en[0])) en.shift();
  return { de: lines.slice(0, at).join('\n').trim(), en: en.join('\n').trim() };
}

// Markdown-Teil für eine Sprache: Englisch, wenn vorhanden und gewünscht, sonst Deutsch
function notesForLang(text, lang) {
  const { de, en } = splitLanguages(text);
  return lang === 'en' && en ? en : de;
}

// Release-Text aus dem deutschen und (optional) englischen CHANGELOG-Abschnitt zusammensetzen
function combineLanguages(de, en) {
  const a = String(de || '').trim();
  const b = String(en || '').trim();
  if (!b) return a;
  return `${a}\n\n${LANG_MARKER}\n\n---\n\n## English\n\n${b}`;
}

module.exports = { changelogSection, parseNotes, splitLanguages, notesForLang, combineLanguages, LANG_MARKER };
