// Deutsche Texte (Schlüssel -> Text). Platzhalter {name}, Plural { one, other }, oder Funktion p => …
// Gleiche Schlüssel in en.js – tools/i18n-check.mjs prüft das (npm test).
(function (root) {
  const dict = {
    // ---------- Allgemein ----------
    'common.cancel': 'Abbrechen',
    'common.ok': 'OK',
    'common.save': 'Speichern',
    'common.delete': 'Löschen',
    'common.close': 'Schließen',
    'common.yes': 'Ja',
    'common.no': 'Nein',
    'common.rename': 'Umbenennen',
    'common.edit': 'Bearbeiten',
    'common.back': 'Zurück',
    'common.next': 'Weiter',
    'common.done': 'Fertig',
    'common.retry': 'Erneut versuchen',
    'common.open': 'Öffnen',
    'common.copy': 'Kopieren',
    'common.apply': 'Übernehmen',
    'common.add': 'Hinzufügen',
    'common.remove': 'Entfernen',
    'common.reset': 'Zurücksetzen',
    'common.error': 'Fehler',
    'common.warning': 'Achtung',
    'common.loading': 'Wird geladen …',
    'common.search': 'Suchen',
    'common.choose': 'Wählen …',
    'common.optional': '(optional)',
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = dict;
  else (root.S3_LOCALES = root.S3_LOCALES || {}).de = dict;
})(typeof window !== 'undefined' ? window : globalThis);
