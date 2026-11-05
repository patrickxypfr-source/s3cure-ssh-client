// Mitteilungen aufs Handy (Web Push). iPhone: ab iOS 16.4, wenn die Web-App auf dem Home-Bildschirm liegt.
// VAPID-Schlüssel werden beim ersten Start erzeugt und in push.json gespeichert (nur für root lesbar).
const crypto = require('crypto');
const config = require('./config');

function createPush({ subject } = {}) {
  let webpush = null;
  try { webpush = require('web-push'); } catch {}
  const data = config.readJson('push.json', { vapid: null, subs: {} });
  if (!data.subs) data.subs = {};
  if (webpush && !data.vapid) { data.vapid = webpush.generateVAPIDKeys(); config.writeJson('push.json', data); }
  if (webpush && data.vapid) webpush.setVapidDetails(subject || 'https://github.com/s3cureofficial/s3cure-ssh-client', data.vapid.publicKey, data.vapid.privateKey);
  const save = () => config.writeJson('push.json', data);
  const key = sub => crypto.createHash('sha256').update(String(sub && sub.endpoint)).digest('hex').slice(0, 32);

  function subscribe(user, sub, ua = '') {
    if (!sub || typeof sub.endpoint !== 'string' || !/^https:\/\//.test(sub.endpoint) || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) throw new Error('Ungültige Anmeldung für Mitteilungen.');
    data.subs[key(sub)] = { user, sub: { endpoint: sub.endpoint, keys: { p256dh: String(sub.keys.p256dh), auth: String(sub.keys.auth) } }, created: Date.now(), ua: String(ua).slice(0, 200) };
    save();
  }
  function unsubscribe(sub) { delete data.subs[key(sub)]; save(); }
  const forUser = user => Object.values(data.subs).filter(s => s.user === user).length;

  // An alle (oder einen Benutzer) schicken. Abgelaufene Anmeldungen (404/410) werden entfernt.
  async function send(payload, { user = null } = {}) {
    if (!webpush || !data.vapid) return 0;
    let sent = 0;
    for (const [k, s] of Object.entries(data.subs)) {
      if (user && s.user !== user) continue;
      try {
        await webpush.sendNotification(s.sub, JSON.stringify(payload), { TTL: 3600, urgency: payload.urgent ? 'high' : 'normal' });
        sent++;
      } catch (err) {
        if (err && (err.statusCode === 404 || err.statusCode === 410)) { delete data.subs[k]; save(); }
      }
    }
    return sent;
  }

  // Benutzer gelöscht -> seine Geräte auch
  function dropUser(user) { for (const [k, s] of Object.entries(data.subs)) if (s.user === user) delete data.subs[k]; save(); }

  return { publicKey: () => (data.vapid ? data.vapid.publicKey : null), subscribe, unsubscribe, send, forUser, dropUser, available: () => !!webpush };
}

module.exports = { createPush };
