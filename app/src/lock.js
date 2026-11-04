// Sperrbildschirm: Touch ID (Mac) oder App-Passwort. Nach dem Entsperren lädt der Hauptprozess die Oberfläche.
const api = window.myssh;
document.body.classList.add(api.platform === 'darwin' ? 'mac' : 'win');
applyIcons();
const pw = document.getElementById('unlock-pw');
const error = document.getElementById('unlock-error');

async function touch() {
  error.hidden = true;
  await api.unlockTouchId(); // klappt es nicht, bleibt das Passwortfeld
  pw.focus();
}

document.getElementById('unlock-form').addEventListener('submit', async e => {
  e.preventDefault();
  if (!pw.value) return;
  const ok = await api.unlock(pw.value);
  if (!ok) { error.hidden = false; pw.select(); }
});
document.getElementById('unlock-touch').addEventListener('click', touch);

api.lockStatus().then(st => {
  if (!st.locked) { api.unlock(''); return; }
  document.getElementById('unlock-touch').hidden = !st.touchId;
  pw.focus();
  if (st.touchId) touch();
});
