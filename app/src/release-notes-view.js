// „Was ist neu?“: Text-Bausteine aus app/lib/release-notes.js anzeigen.
// Nur textContent – Inhalte aus dem Release-Text werden nie als HTML eingesetzt.
window.renderReleaseNotes = (box, blocks) => {
  box.replaceChildren();
  let list = null;
  for (const b of Array.isArray(blocks) ? blocks : []) {
    if (!b || typeof b.text !== 'string') continue;
    if (b.type === 'li') {
      if (!list) { list = document.createElement('ul'); box.appendChild(list); }
      const li = document.createElement('li');
      li.textContent = b.text;
      list.appendChild(li);
      continue;
    }
    list = null;
    const el = document.createElement(b.type === 'h' ? 'h3' : 'p');
    el.textContent = b.text;
    box.appendChild(el);
  }
  return box.childElementCount > 0;
};
