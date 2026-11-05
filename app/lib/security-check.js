// Sicherheits-Check eines Servers: SSH-Einstellungen, Firewall, fail2ban, Updates, offene Ports,
// Zertifikate … Ergebnis als Liste von Prüfpunkten mit Note (A–F). Läuft über einen eigenen exec-Kanal
// (nichts wird in die Shell getippt), als root bzw. mit sudo -n, sonst mit eingeschränkter Sicht.
// Behoben wird nie heimlich: die Oberfläche (src/security-check.js) zeigt den Befehl und führt ihn
// nach Rückfrage sichtbar im Terminal aus.
const { t } = require('./i18n');
const { exec, sections } = require('./dashboard');

// Prüfskript: läuft als root, mit sudo -n oder als normaler Benutzer (dann fehlt manches)
const SCRIPT = String.raw`
echo @@who; id -u
echo @@sshd; sshd -T 2>/dev/null | grep -Ei '^(permitrootlogin|passwordauthentication|kbdinteractiveauthentication|permitemptypasswords|port) '
echo @@ufw; command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | head -n 1
echo @@nft; command -v nft >/dev/null 2>&1 && nft list ruleset 2>/dev/null | grep -Ec '(policy drop|policy reject| drop$| reject)'
echo @@ipt; command -v iptables >/dev/null 2>&1 && { iptables -S INPUT 2>/dev/null | head -n 1; iptables -S 2>/dev/null | grep -Ec -- '-j (DROP|REJECT)'; }
echo @@f2b; for u in fail2ban crowdsec; do st=$(systemctl is-active "$u" 2>/dev/null); [ -n "$st" ] || st=inactive; echo "$u $st"; done
echo @@apt; command -v apt-get >/dev/null 2>&1 && { L=$(apt-get -s -o Debug::NoLocking=1 upgrade 2>/dev/null | grep '^Inst'); printf '%s\n' "$L" | grep -c '^Inst'; printf '%s\n' "$L" | grep -ci security; }
echo @@unattended; dpkg -s unattended-upgrades 2>/dev/null | grep -q '^Status: install ok' && echo installed; apt-config dump 2>/dev/null | grep -E '^APT::Periodic::Unattended-Upgrade ' | head -n 1
echo @@reboot; [ -f /var/run/reboot-required ] && echo yes
echo @@ports; ss -tulnpH 2>/dev/null | awk '{print $1" "$5" "$7}' | head -n 80
echo @@uid0; awk -F: '$3==0{print $1}' /etc/passwd 2>/dev/null
echo @@emptypw; awk -F: '($2==""){print $1}' /etc/shadow 2>/dev/null
echo @@certs; for f in /etc/letsencrypt/live/*/cert.pem; do [ -f "$f" ] && echo "$(basename "$(dirname "$f")")|$(openssl x509 -enddate -noout -in "$f" 2>/dev/null | cut -d= -f2)"; done
echo @@ntp; timedatectl show -p NTPSynchronized --value 2>/dev/null
echo @@os; ( . /etc/os-release && echo "$ID" )
`;

const ADMIN_WRAP = script => {
  const b64 = Buffer.from(script).toString('base64');
  const run = `echo ${b64} | base64 -d | sh`;
  // root -> direkt; sonst sudo ohne Passwort; sonst als Benutzer (eingeschränkt)
  return `if [ "$(id -u)" = 0 ]; then echo @@mode; echo root; ${run}; elif sudo -n true 2>/dev/null; then echo @@mode; echo sudo; echo ${b64} | base64 -d | sudo -n sh; else echo @@mode; echo user; ${run}; fi`;
};

const DB_PORTS = { 5432: 'PostgreSQL', 3306: 'MySQL/MariaDB', 6379: 'Redis', 27017: 'MongoDB', 9200: 'Elasticsearch', 11211: 'Memcached' };
const WEIGHT = { bad: 15, warn: 5, ok: 0, info: 0, unknown: 0 };

// Befehle zum Beheben – werden im Terminal ausgeführt (bei Bedarf mit sudo davor)
const SSHD_SET = (key, value) => [
  'f=/etc/ssh/sshd_config.d/00-s3cure.conf',
  "grep -qiE '^Include /etc/ssh/sshd_config.d/' /etc/ssh/sshd_config || sed -i '1i Include /etc/ssh/sshd_config.d/*.conf' /etc/ssh/sshd_config",
  'mkdir -p /etc/ssh/sshd_config.d && touch "$f"',
  `sed -i '/^${key} /Id' "$f"`,
  `echo '${key} ${value}' >> "$f"`,
  'sshd -t && (systemctl reload ssh 2>/dev/null || systemctl reload sshd)',
].join(' && ');

function grade(score) {
  return score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 70 ? 'C' : score >= 60 ? 'D' : score >= 50 ? 'E' : 'F';
}

// Lokale Adresse "0.0.0.0:5432" / "[::]:80" / "*:22" / "127.0.0.1:5432" -> { addr, port, public }
function parseAddr(s) {
  const m = /^(.*):(\d+)$/.exec(String(s || ''));
  if (!m) return null;
  const addr = m[1].replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const local = /^(127\.|::1$|localhost$)/.test(addr);
  return { addr, port: Number(m[2]), public: !local };
}

// Rohtext -> { mode, os, checks: [{ id, status, title, detail, fix?, fixNote?, danger? }], score, grade }
function evaluate(text, { auth = null } = {}) {
  const s = sections(text);
  const one = k => (s[k] || [])[0] || '';
  const mode = one('mode') || 'user';
  const admin = mode === 'root' || mode === 'sudo';
  const checks = [];
  const add = c => checks.push(c);

  // ---------- SSH ----------
  const sshd = {};
  for (const line of s.sshd || []) { const [k, ...v] = line.split(/\s+/); sshd[k.toLowerCase()] = v.join(' ').toLowerCase(); }
  const haveSshd = Object.keys(sshd).length > 0;
  const sshPort = Number(sshd.port) || 22;
  const keyLogin = auth === 'publickey' || auth === 'agent';

  if (!haveSshd) {
    add({ id: 'rootLogin', status: 'unknown', title: t('sec.rootLogin'), detail: t('sec.needAdmin') });
    add({ id: 'passwordAuth', status: 'unknown', title: t('sec.passwordAuth'), detail: t('sec.needAdmin') });
  } else {
    const prl = sshd.permitrootlogin;
    if (prl === 'yes') {
      add({ id: 'rootLogin', status: 'bad', title: t('sec.rootLogin'), detail: t('sec.rootLoginYes'),
        fix: SSHD_SET('PermitRootLogin', 'prohibit-password'), fixNote: t('sec.rootLoginFix') });
    } else {
      add({ id: 'rootLogin', status: 'ok', title: t('sec.rootLogin'), detail: prl === 'no' ? t('sec.rootLoginNo') : t('sec.rootLoginKey') });
    }
    const pw = sshd.passwordauthentication === 'yes' || sshd.kbdinteractiveauthentication === 'yes';
    if (pw) {
      add({ id: 'passwordAuth', status: 'warn', title: t('sec.passwordAuth'), detail: t('sec.passwordAuthOn'),
        fix: keyLogin ? `${SSHD_SET('PasswordAuthentication', 'no')} && ${SSHD_SET('KbdInteractiveAuthentication', 'no')}` : null,
        fixNote: keyLogin ? t('sec.passwordAuthFix') : null, blocked: keyLogin ? null : t('sec.passwordAuthNeedKey'), danger: true });
    } else {
      add({ id: 'passwordAuth', status: 'ok', title: t('sec.passwordAuth'), detail: t('sec.passwordAuthOff') });
    }
    if (sshd.permitemptypasswords === 'yes') {
      add({ id: 'emptyPasswordsSsh', status: 'bad', title: t('sec.emptySsh'), detail: t('sec.emptySshDetail'),
        fix: SSHD_SET('PermitEmptyPasswords', 'no') });
    }
  }

  // ---------- Firewall ----------
  const ufw = one('ufw').toLowerCase();
  const nftDrops = Number(one('nft')) || 0;
  const ipt = s.ipt || [];
  const iptPolicyDrop = /-P INPUT (DROP|REJECT)/.test(ipt[0] || '');
  const iptDrops = Number(ipt[1]) || 0;
  const firewall = /status: active/.test(ufw) ? 'ufw' : (nftDrops > 0 || iptPolicyDrop || iptDrops > 0) ? 'rules' : null;
  if (firewall) {
    add({ id: 'firewall', status: 'ok', title: t('sec.firewall'), detail: firewall === 'ufw' ? t('sec.firewallUfw') : t('sec.firewallRules') });
  } else if (!admin && !ufw) {
    add({ id: 'firewall', status: 'unknown', title: t('sec.firewall'), detail: t('sec.needAdmin') });
  } else {
    add({ id: 'firewall', status: 'bad', title: t('sec.firewall'), detail: t('sec.firewallOff'),
      fix: `(command -v ufw >/dev/null || (apt-get update && apt-get install -y ufw)) && ufw allow ${sshPort}/tcp && ufw allow 80/tcp && ufw allow 443/tcp && ufw --force enable && ufw status`,
      fixNote: t('sec.firewallFix', { port: sshPort }), danger: true });
  }

  // ---------- fail2ban / CrowdSec ----------
  const guards = Object.fromEntries((s.f2b || []).map(l => l.split(/\s+/)).map(([k, v]) => [k, v]));
  if (guards.fail2ban === 'active' || guards.crowdsec === 'active') {
    add({ id: 'bruteforce', status: 'ok', title: t('sec.bruteforce'), detail: guards.crowdsec === 'active' ? 'CrowdSec' : 'fail2ban' });
  } else {
    add({ id: 'bruteforce', status: 'warn', title: t('sec.bruteforce'), detail: t('sec.bruteforceOff'),
      fix: "apt-get update && apt-get install -y fail2ban python3-systemd && mkdir -p /etc/fail2ban/jail.d && printf '[sshd]\\nenabled = true\\nbackend = systemd\\nmaxretry = 5\\nbantime = 1h\\n' > /etc/fail2ban/jail.d/s3cure.conf && systemctl enable --now fail2ban && systemctl restart fail2ban && fail2ban-client status sshd",
      fixNote: t('sec.bruteforceFix') });
  }

  // ---------- Updates ----------
  const apt = s.apt || [];
  if (apt.length) {
    const total = Number(apt[0]) || 0, security = Number(apt[1]) || 0;
    if (total === 0) add({ id: 'updates', status: 'ok', title: t('sec.updates'), detail: t('sec.updatesNone') });
    else add({ id: 'updates', status: security ? 'bad' : 'warn', title: t('sec.updates'),
      detail: security ? t('sec.updatesSecurity', { n: total, s: security }) : t('sec.updatesSome', { n: total }),
      fix: 'apt-get update && DEBIAN_FRONTEND=noninteractive apt-get -y upgrade', fixNote: t('sec.updatesFix') });
    const un = s.unattended || [];
    const installed = un.includes('installed');
    const enabled = un.some(l => /Unattended-Upgrade "1"/.test(l));
    if (installed && enabled) add({ id: 'autoUpdates', status: 'ok', title: t('sec.autoUpdates'), detail: t('sec.autoUpdatesOn') });
    else add({ id: 'autoUpdates', status: 'warn', title: t('sec.autoUpdates'), detail: t('sec.autoUpdatesOff'),
      fix: "apt-get update && apt-get install -y unattended-upgrades && printf 'APT::Periodic::Update-Package-Lists \"1\";\\nAPT::Periodic::Unattended-Upgrade \"1\";\\n' > /etc/apt/apt.conf.d/20auto-upgrades && systemctl enable --now unattended-upgrades",
      fixNote: t('sec.autoUpdatesFix') });
  }
  if (one('reboot') === 'yes') add({ id: 'reboot', status: 'warn', title: t('sec.reboot'), detail: t('sec.rebootDetail') });

  // ---------- Offene Ports ----------
  const open = [];
  for (const line of s.ports || []) {
    const [proto, local, proc = ''] = line.split(/\s+/);
    const a = parseAddr(local);
    if (!a || !a.public || a.port === sshPort || a.port === 80 || a.port === 443) continue;
    if (proto === 'udp' && [53, 68, 123, 323, 546, 5353].includes(a.port)) continue; // DNS, DHCP, Zeit
    const name = (/"([^"]+)"/.exec(proc) || [])[1] || '';
    if (!open.some(o => o.port === a.port && o.proto === proto)) open.push({ proto, port: a.port, name });
  }
  const dbOpen = open.filter(o => DB_PORTS[o.port]);
  const fmt = list => list.map(o => `${o.port}/${o.proto}${o.name ? ` (${o.name})` : DB_PORTS[o.port] ? ` (${DB_PORTS[o.port]})` : ''}`).join(', ');
  if (!s.ports) add({ id: 'ports', status: 'unknown', title: t('sec.ports'), detail: t('sec.portsUnknown') });
  else if (dbOpen.length) add({ id: 'ports', status: firewall ? 'warn' : 'bad', title: t('sec.ports'),
    detail: t(firewall ? 'sec.portsDbFw' : 'sec.portsDb', { list: fmt(dbOpen) }) + (open.length > dbOpen.length ? '\n' + t('sec.portsOther', { list: fmt(open.filter(o => !DB_PORTS[o.port])) }) : '') });
  else if (open.length) add({ id: 'ports', status: firewall ? 'ok' : 'info', title: t('sec.ports'), detail: t(firewall ? 'sec.portsOpenFw' : 'sec.portsOpen', { list: fmt(open) }) });
  else add({ id: 'ports', status: 'ok', title: t('sec.ports'), detail: t('sec.portsNone') });

  // ---------- Konten ----------
  const uid0 = (s.uid0 || []).filter(u => u !== 'root');
  if (uid0.length) add({ id: 'uid0', status: 'bad', title: t('sec.uid0'), detail: t('sec.uid0Detail', { list: uid0.join(', ') }) });
  if (admin) {
    const empty = s.emptypw || [];
    if (empty.length) add({ id: 'emptyPw', status: 'bad', title: t('sec.emptyPw'), detail: t('sec.emptyPwDetail', { list: empty.join(', ') }),
      fix: empty.map(u => `passwd -l '${u.replace(/'/g, '')}'`).join(' && '), fixNote: t('sec.emptyPwFix') });
  }

  // ---------- Zertifikate (Let's Encrypt) ----------
  const now = Date.now();
  const certs = (s.certs || []).map(l => { const [name, date] = l.split('|'); return { name, days: Math.floor((Date.parse(date) - now) / 86400000) }; })
    .filter(c => c.name && Number.isFinite(c.days));
  if (certs.length) {
    const expired = certs.filter(c => c.days < 0), soon = certs.filter(c => c.days >= 0 && c.days < 14);
    if (expired.length) add({ id: 'certs', status: 'bad', title: t('sec.certs'), detail: t('sec.certsExpired', { list: expired.map(c => c.name).join(', ') }), fix: 'certbot renew', fixNote: t('sec.certsFix') });
    else if (soon.length) add({ id: 'certs', status: 'warn', title: t('sec.certs'), detail: t('sec.certsSoon', { list: soon.map(c => `${c.name} (${c.days})`).join(', ') }), fix: 'certbot renew', fixNote: t('sec.certsFix') });
    else add({ id: 'certs', status: 'ok', title: t('sec.certs'), detail: t('sec.certsOk', { n: certs.length, days: Math.min(...certs.map(c => c.days)) }) });
  }

  // ---------- Uhrzeit ----------
  const ntp = one('ntp');
  if (ntp === 'no') add({ id: 'ntp', status: 'warn', title: t('sec.ntp'), detail: t('sec.ntpOff'), fix: 'timedatectl set-ntp true' });
  else if (ntp === 'yes') add({ id: 'ntp', status: 'ok', title: t('sec.ntp'), detail: t('sec.ntpOn') });

  const score = Math.max(0, 100 - checks.reduce((n, c) => n + WEIGHT[c.status], 0));
  // Ohne root/sudo fehlen wichtige Punkte – dann keine Note, die besser aussieht als die Wirklichkeit
  const unknown = checks.filter(c => c.status === 'unknown').length;
  return { mode, admin, os: one('os'), sshPort, checks, score, grade: unknown ? null : grade(score), unknown };
}

function register(ipcMain, sessions) {
  ipcMain.handle('sec:scan', async (_e, tabId, opts = {}) => {
    const s = sessions.get(tabId);
    if (!s || !s.client) throw new Error(t('dashboard.notConnected'));
    const r = await exec(s.client, ADMIN_WRAP(SCRIPT), { timeout: 90000 });
    if (r.timeout) throw new Error(t('sec.timeout'));
    return { ...evaluate(r.out, { auth: opts.auth || s.client.authMethod || null }), at: Date.now() };
  });
}

module.exports = { register, evaluate, parseAddr, grade, SSHD_SET, SCRIPT };
