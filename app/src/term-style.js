// Gestaltung der Zeilen, die die App selbst ins Terminal schreibt (nicht die Ausgabe des Servers):
// Trennlinie der Befehlsknöpfe und kurze Meldungen mit Symbol. Nutzt nur die ANSI-Grundfarben,
// damit hell/dunkel automatisch über das Terminal-Theme passen.
window.TermStyle = (() => {
  const ESC = '\x1b[';
  const RESET = ESC + '0m';
  const DIM = ESC + '90m';
  // 31 rot (Akzent), 32 grün, 33 gelb, 34 blau
  const KIND = { run: '31', live: '32', confirm: '33', info: '34' };

  const clean = s => String(s).replace(/[\x00-\x1f\x7f]/g, ' ').trim();
  const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
  const time = () => I18N.fmtTime(Date.now(), { hour: '2-digit', minute: '2-digit' });

  // Trennlinie über die ganze Breite:  ▌ Status ▐ 16:18 ──────────
  // Das Namensschild ist farbig hinterlegt (Umkehrdarstellung -> Text in Hintergrundfarbe des Terminals).
  // Die leere Eingabezeile davor wird ersetzt, darüber bleibt eine Leerzeile Abstand.
  function separator(cols, label, kind = 'run') {
    const c = KIND[kind] || KIND.run;
    const name = cut(clean(label), 48);
    const badge = (kind === 'live' ? '● LIVE · ' : '') + name;
    const stamp = time();
    const rest = Math.max(3, cols - badge.length - stamp.length - 7);
    return '\r' + ESC + '2K\r\n'
      + ESC + '1;7;' + c + 'm ' + badge + ' ' + RESET
      + ' ' + DIM + stamp + ' ' + '─'.repeat(rest) + RESET + '\r\n';
  }

  // Kurze Meldung mit Symbol; mehrzeilige Texte werden eingerückt
  const MARK = { ok: ['32', '✓'], warn: ['33', '⚠'], error: ['31', '✕'], info: ['90', '›'], end: ['90', '○'] };
  function line(kind, text) {
    const [c, sym] = MARK[kind] || MARK.info;
    const body = String(text).replace(/\r?\n/g, '\r\n  ');
    const color = kind === 'info' || kind === 'end' ? DIM : ESC + c + 'm';
    return ESC + c + 'm' + sym + RESET + ' ' + color + body + RESET + '\r\n';
  }

  return { separator, line };
})();
