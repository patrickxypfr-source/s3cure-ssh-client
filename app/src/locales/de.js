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

    // ---------- Einstellungen (src/settings.js, lib/settings.js) ----------
    'settings.title': 'Einstellungen',
    'settings.titleShortcut': 'Einstellungen ({key}+,)',
    'settings.keyCtrl': 'Strg',
    'settings.closeEsc': 'Schließen (Esc)',
    'settings.resetDefaults': 'Auf Standard zurücksetzen',
    'settings.resetQ': 'Zurücksetzen?',
    'settings.resetMsg': 'Alle Einstellungen unter „{section}“ auf den Standard zurücksetzen?',
    'settings.general': 'Allgemein',
    'settings.appearance': 'Erscheinungsbild',
    'settings.appearanceHint': 'System folgt der Einstellung von macOS bzw. Windows.',
    'settings.system': 'System',
    'settings.light': 'Hell',
    'settings.dark': 'Dunkel',
    'settings.language': 'Sprache',
    'settings.languageHint': 'System folgt der Sprache von macOS bzw. Windows (Deutsch, sonst Englisch).',
    'settings.languageReloadHint': 'Die neue Sprache gilt, sobald das Fenster neu geladen ist.',
    'settings.languageReloadNow': 'Jetzt neu laden',
    'settings.languageReloadQ': 'Fenster neu laden?',
    'settings.languageReloadMsg': 'Offene Verbindungen werden dabei kurz getrennt und danach wieder geöffnet.',
    'settings.tooLarge': 'Einstellungen sind zu groß.',
    'settings.invalid': 'Ungültige Einstellungen.',
    'settings.invalidName': 'Ungültiger Name: {key}',
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = dict;
  else (root.S3_LOCALES = root.S3_LOCALES || {}).de = dict;
})(typeof window !== 'undefined' ? window : globalThis);
