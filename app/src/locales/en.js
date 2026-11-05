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
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = dict;
  else (root.S3_LOCALES = root.S3_LOCALES || {}).en = dict;
})(typeof window !== 'undefined' ? window : globalThis);
