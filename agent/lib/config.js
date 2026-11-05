// Einstellungen und Daten des Agenten. Alles liegt in einem Ordner (Standard /var/lib/s3cure-agent,
// nur für root lesbar): config.json, users.json, sessions.json, push.json, audit.log, history.json.
// S3CURE_AGENT_DIR ändert den Ordner (Tests, Demo).
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const DIR = process.env.S3CURE_AGENT_DIR || '/var/lib/s3cure-agent';

const DEFAULTS = {
  name: os.hostname().split('.')[0], // kurzer Rechnername (ohne .fritz.box usw.)
  bind: '127.0.0.1',          // nur lokal – nach außen über nginx/Caddy mit HTTPS
  port: 7777,
  publicUrl: '',              // z. B. https://ops.s3cure.xyz (für Links in Mitteilungen)
  language: 'de',
  alerts: { disk: 90, mem: 95, loadPerCpu: 3, serviceFailed: true, everySec: 60 },
  control: {
    reboot: true,
    // Diese Dienste lassen sich in der App nicht stoppen (Neustart geht) – sonst sperrt man sich aus
    protect: ['ssh.service', 'sshd.service', 'systemd-*', 'dbus.service', 's3cure-agent.service', 'networking.service', 'systemd-networkd.service'],
  },
  peers: [],                  // weitere Server: [{ name, url, token }]
};

function file(name) { return path.join(DIR, name); }

function ensureDir() {
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(DIR, 0o700); } catch {}
}

function readJson(name, fallback) {
  try { return JSON.parse(fs.readFileSync(file(name), 'utf8')); } catch { return fallback; }
}

// Sicher schreiben: erst Hilfsdatei, dann umbenennen (bei Absturz nichts kaputt), nur für root lesbar
function writeJson(name, data) {
  ensureDir();
  const tmp = file(name + '.tmp');
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file(name));
}

function merge(base, extra) {
  const out = { ...base };
  for (const [k, v] of Object.entries(extra || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k]) ? merge(base[k], v) : v;
  }
  return out;
}

function load() {
  const cfg = merge(DEFAULTS, readJson('config.json', {}));
  // Schlüssel, mit dem andere Agenten (Hub) diesen Server abfragen dürfen
  if (!cfg.agentToken) {
    cfg.agentToken = crypto.randomBytes(32).toString('base64url');
    save(cfg);
  }
  return cfg;
}

function save(cfg) {
  const { ...plain } = cfg;
  writeJson('config.json', plain);
}

module.exports = { DIR, DEFAULTS, file, ensureDir, readJson, writeJson, load, save, merge };
