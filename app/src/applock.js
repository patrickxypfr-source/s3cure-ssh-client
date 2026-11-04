// Einstellung „App-Sperre“: beim Start mit App-Passwort bzw. Touch ID entsperren (Standard: aus).
// Der Sperrbildschirm selbst ist src/lock.html, die Prüfung macht der Hauptprozess (app/lib/applock.js).

let lockState = null;

function showLockFields() {
  const f = $('#lock-form');
  const on = f.enabled.checked;
  f.querySelector('.lock-fields').hidden = !on;
  $('#lock-touch-wrap').hidden = !(lockState && lockState.canTouchId);
  $('#lock-current-wrap').hidden = !(lockState && lockState.enabled);
  $('#lock-pw-label').textContent = lockState && lockState.enabled ? 'Neues App-Passwort (leer = behalten)' : 'App-Passwort';
}

$('#app-lock-btn').addEventListener('click', async () => {
  lockState = await api.lockStatus();
  const f = $('#lock-form');
  f.reset();
  f.enabled.checked = lockState.enabled;
  f.touchId.checked = lockState.enabled ? lockState.touchId : lockState.canTouchId;
  showLockFields();
  $('#lock-modal').hidden = false;
});

$('#lock-form').enabled.addEventListener('change', showLockFields);

$('#lock-form').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target;
  const enabled = f.enabled.checked;
  if (enabled && f.password.value !== f.password2.value) { showError('Die beiden Passwörter sind nicht gleich.'); return; }
  if (enabled && !lockState.enabled && !f.password.value) { showError('Bitte ein App-Passwort festlegen. Es wird auch gebraucht, falls Touch ID nicht geht.'); return; }
  if (!enabled && !lockState.enabled) { $('#lock-modal').hidden = true; return; }
  try {
    lockState = await api.configureLock({ enabled, touchId: f.touchId.checked, password: f.password.value, current: f.current.value });
  } catch (err) { showError(err); return; }
  $('#lock-modal').hidden = true;
  $('#app-lock-btn').classList.toggle('on', lockState.enabled);
  flash(enabled ? 'App-Sperre ist an – ab dem nächsten Start' : 'App-Sperre ist aus');
});

api.lockStatus().then(st => { lockState = st; $('#app-lock-btn').classList.toggle('on', st.enabled); });
