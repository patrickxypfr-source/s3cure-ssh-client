// English texts (key -> text). Placeholders {name}, plural { one, other }, or a function p => …
// Same keys as de.js – tools/i18n-check.mjs checks this (npm test).
(function (root) {
  const dict = {
    // ---------- General ----------
    'common.cancel': 'Cancel',
    'common.ok': 'OK',
    'common.save': 'Save',
    'common.delete': 'Delete',
    'common.close': 'Close',
    'common.yes': 'Yes',
    'common.no': 'No',
    'common.rename': 'Rename',
    'common.edit': 'Edit',
    'common.back': 'Back',
    'common.next': 'Next',
    'common.done': 'Done',
    'common.retry': 'Try Again',
    'common.open': 'Open',
    'common.copy': 'Copy',
    'common.apply': 'Apply',
    'common.add': 'Add',
    'common.remove': 'Remove',
    'common.reset': 'Reset',
    'common.error': 'Error',
    'common.warning': 'Warning',
    'common.loading': 'Loading…',
    'common.search': 'Search',
    'common.choose': 'Choose…',
    'common.optional': '(optional)',

    // ---------- Einstellungen (src/settings.js, lib/settings.js) ----------
    'settings.title': 'Settings',
    'settings.titleShortcut': 'Settings ({key}+,)',
    'settings.keyCtrl': 'Ctrl',
    'settings.closeEsc': 'Close (Esc)',
    'settings.resetDefaults': 'Restore Defaults',
    'settings.resetQ': 'Reset?',
    'settings.resetMsg': 'Reset all “{section}” settings to their defaults?',
    'settings.general': 'General',
    'settings.appearance': 'Appearance',
    'settings.appearanceHint': 'System follows the macOS or Windows setting.',
    'settings.system': 'System',
    'settings.light': 'Light',
    'settings.dark': 'Dark',
    'settings.language': 'Language',
    'settings.languageHint': 'System follows the macOS or Windows language (German, otherwise English).',
    'settings.languageReloadHint': 'The new language applies once the window has been reloaded.',
    'settings.languageReloadNow': 'Reload Now',
    'settings.languageReloadQ': 'Reload window?',
    'settings.languageReloadMsg': 'Open connections will briefly disconnect and then reopen.',
    'settings.tooLarge': 'Settings are too large.',
    'settings.invalid': 'Invalid settings.',
    'settings.invalidName': 'Invalid name: {key}',
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = dict;
  else (root.S3_LOCALES = root.S3_LOCALES || {}).en = dict;
})(typeof window !== 'undefined' ? window : globalThis);
