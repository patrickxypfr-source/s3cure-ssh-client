// .env lesen und schreiben, ohne Kommentare, Leerzeilen und Reihenfolge zu verlieren.
// Läuft in der Oberfläche (<script>, window.EnvCore) und in den Tests (require).
(function (root) {
  const KEY_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
  const LINE_RE = /^(\s*)(export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s?(.*)$/;

  // Wert aus der rechten Seite lesen: "…" (mit \n, \", \\), '…' (wörtlich) oder ohne Anführungszeichen (# = Kommentar)
  function readValue(rest) {
    const r = rest.trimStart();
    if (r[0] === '"' || r[0] === "'") {
      const q = r[0];
      let out = '', i = 1;
      for (; i < r.length; i++) {
        const c = r[i];
        if (q === '"' && c === '\\' && i + 1 < r.length) {
          const n = r[++i];
          out += n === 'n' ? '\n' : n === 'r' ? '\r' : n === 't' ? '\t' : n;
          continue;
        }
        if (c === q) return { value: out, quote: q, closed: true };
        out += c;
      }
      return { value: out, quote: q, closed: false }; // mehrzeilig – nicht unterstützt, unverändert lassen
    }
    const hash = r.search(/\s#/);
    return { value: (hash >= 0 ? r.slice(0, hash) : r).trim(), quote: '', closed: true };
  }

  function parse(text) {
    const lines = String(text).replace(/\r\n/g, '\n').split('\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    return lines.map(raw => {
      const m = LINE_RE.exec(raw);
      if (!m || /^\s*#/.test(raw)) return { type: 'other', raw };
      const v = readValue(m[4]);
      if (!v.closed) return { type: 'other', raw };
      return { type: 'pair', raw, key: m[3], value: v.value, quote: v.quote, export: !!m[2], indent: m[1] };
    });
  }

  // Wert so schreiben, dass er wieder genauso gelesen wird – möglichst ohne Escapes, weil nicht jedes
  // Programm sie gleich versteht (Node-dotenv liest z. B. \$ wörtlich). Daher bevorzugt '…'.
  function formatValue(value, quote = '') {
    const v = String(value);
    const plain = v !== '' && !/[\s#"'\\$`]/.test(v);
    if (plain && quote !== '"' && quote !== "'") return v;
    if (plain && quote) return quote + v + quote;
    if (!v.includes("'") && !v.includes('\n')) return `'${v}'`;
    return '"' + v.replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"';
  }

  const lineFor = p => `${p.indent || ''}${p.export ? 'export ' : ''}${p.key}=${formatValue(p.value, p.quote)}`;

  function serialize(lines) {
    return lines.map(l => (l.type === 'pair' && l.dirty ? lineFor(l) : l.raw)).join('\n') + '\n';
  }

  const pairs = lines => lines.filter(l => l.type === 'pair');
  const toMap = lines => { const m = new Map(); for (const p of pairs(lines)) m.set(p.key, p.value); return m; };

  function set(lines, key, value) {
    const hits = pairs(lines).filter(p => p.key === key);
    if (!hits.length) { lines.push({ type: 'pair', key, value: String(value), quote: '', export: false, indent: '', dirty: true, raw: '' }); return; }
    const last = hits[hits.length - 1]; // gilt der letzte Eintrag
    if (last.value !== String(value)) { last.value = String(value); last.dirty = true; }
  }

  function remove(lines, key) {
    for (let i = lines.length - 1; i >= 0; i--) if (lines[i].type === 'pair' && lines[i].key === key) lines.splice(i, 1);
  }

  // Unterschiede zweier Stände (für die Rückfrage vor dem Speichern) – nur Schlüssel, keine Werte
  function diff(beforeText, lines) {
    const a = toMap(parse(beforeText)), b = toMap(lines);
    const added = [...b.keys()].filter(k => !a.has(k));
    const removed = [...a.keys()].filter(k => !b.has(k));
    const changed = [...b.keys()].filter(k => a.has(k) && a.get(k) !== b.get(k));
    return { added, removed, changed };
  }

  // Vergleich mit einer anderen Datei (z. B. .env.example): fehlende Schlüssel auf beiden Seiten
  function compare(lines, otherText) {
    const mine = toMap(lines), other = toMap(parse(otherText));
    return {
      missingHere: [...other.keys()].filter(k => !mine.has(k)).map(k => ({ key: k, value: other.get(k) })),
      onlyHere: [...mine.keys()].filter(k => !other.has(k)),
    };
  }

  // Sieht der Name nach einem Geheimnis aus? (dann standardmäßig verdeckt)
  const isSecretKey = k => /pass|secret|token|key|private|auth|cred|cookie|session|salt|dsn|database_url|_url$/i.test(k);

  const api = { parse, serialize, set, remove, diff, compare, formatValue, isSecretKey, KEY_RE, toMap };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.EnvCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
