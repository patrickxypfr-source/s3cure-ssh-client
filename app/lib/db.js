// Datenbank-Ansicht (PostgreSQL) durch die SSH-Verbindung: ein lokaler Port auf 127.0.0.1 leitet
// über forwardOut zum Datenbank-Server weiter (wie ein Tunnel) – Postgres muss nicht offen im Netz sein.
// Tabellen anzeigen, blättern, sortieren, suchen; Zellen ändern und Zeilen löschen nur über den
// Primärschlüssel und nur, wenn genau eine Zeile betroffen ist; SQL ausführen; CSV-Export.
// Zugangsdaten pro Verbindung in db-connections.json, Passwörter verschlüsselt (secrets).
// Oberfläche: src/db-view.js
const fs = require('fs');
const net = require('net');
const path = require('path');
const { t } = require('./i18n');
const { exec } = require('./dashboard');
const { findCmd } = require('./env-files');

const MAX_ROWS = 2000;      // höchstens so viele Zeilen an die Oberfläche
const MAX_CELL = 20000;     // lange Texte kürzen
const COUNT_CAP = 100000;   // ab hier nur „100.000+“

const qi = s => '"' + String(s).replace(/"/g, '""') + '"'; // Bezeichner sicher in Anführungszeichen

// Zellwert für die Anzeige (alles als Text, null bleibt null)
function cell(v) {
  if (v === null || v === undefined) return null;
  let s;
  if (Buffer.isBuffer(v)) s = '\\x' + v.subarray(0, 1024).toString('hex') + (v.length > 1024 ? '…' : '');
  else if (v instanceof Date) s = isNaN(v) ? String(v) : v.toISOString();
  else if (typeof v === 'object') s = JSON.stringify(v);
  else s = String(v);
  return s.length > MAX_CELL ? s.slice(0, MAX_CELL) + '…' : s;
}

// postgres://user:pass@host:5432/db?x=y -> Teile
function parseUrl(u) {
  try {
    const url = new URL(String(u).trim().replace(/^postgres(ql)?(\+\w+)?:/i, 'http:'));
    if (!url.hostname) return null;
    return {
      host: decodeURIComponent(url.hostname).replace(/^\[|\]$/g, ''), port: Number(url.port) || 5432,
      database: decodeURIComponent(url.pathname.replace(/^\//, '')) || '', user: decodeURIComponent(url.username || ''),
      password: decodeURIComponent(url.password || ''),
    };
  } catch { return null; }
}

// Ausgabe von grep -H (Datei:Zeile) -> Vorschläge aus .env-Dateien
function parseCandidates(out) {
  const files = new Map();
  for (const line of String(out).split('\n')) {
    const m = /^(\/[^:]+):(?:export\s+)?([A-Z0-9_]+)=(.*)$/.exec(line);
    if (!m) continue;
    let v = m[3].trim();
    if ((v[0] === '"' || v[0] === "'") && v.endsWith(v[0])) v = v.slice(1, -1);
    if (!files.has(m[1])) files.set(m[1], {});
    files.get(m[1])[m[2]] = v;
  }
  const list = [];
  for (const [source, vars] of files) {
    for (const k of ['DATABASE_URL', 'POSTGRES_URL', 'POSTGRES_PRISMA_URL', 'DB_URL', 'PG_URL']) {
      const p = vars[k] && /^postgres/i.test(vars[k]) ? parseUrl(vars[k]) : null;
      if (p) list.push({ source, via: k, ...p });
    }
    const user = vars.PGUSER || vars.POSTGRES_USER || vars.DB_USER || vars.DB_USERNAME;
    const db = vars.PGDATABASE || vars.POSTGRES_DB || vars.DB_NAME || vars.DB_DATABASE;
    if (user && db && !list.some(c => c.source === source)) {
      list.push({ source, via: 'vars', host: vars.PGHOST || vars.POSTGRES_HOST || vars.DB_HOST || '127.0.0.1',
        port: Number(vars.PGPORT || vars.POSTGRES_PORT || vars.DB_PORT) || 5432, database: db, user,
        password: vars.PGPASSWORD || vars.POSTGRES_PASSWORD || vars.DB_PASSWORD || '' });
    }
  }
  // Docker-Hostnamen (z. B. „db“) sind vom Server aus meist nicht erreichbar -> lokale Adresse vorschlagen
  for (const c of list) if (!/^[\d.:]+$|^localhost$/.test(c.host) && !c.host.includes('.')) { c.dockerHost = c.host; c.host = '127.0.0.1'; }
  return list;
}

// Nur lesend? (dann ohne Rückfrage ausführen)
function isReadOnly(sql) {
  const stmts = String(sql).replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, ' ').split(';').map(s => s.trim()).filter(Boolean);
  return stmts.length > 0 && stmts.every(s => /^(select|with|show|explain|values|table)\b/i.test(s) && !/\b(insert|update|delete|drop|alter|truncate|create|grant|revoke)\b/i.test(s.replace(/'[^']*'/g, '')));
}

function friendly(err) {
  const c = err && err.code;
  if (c === '28P01' || c === '28000') return t('db.errAuth');
  if (c === '3D000') return t('db.errNoDb');
  if (c === '42501') return t('db.errPermission', { error: err.message });
  if (/refused|ECONNREFUSED/i.test(String(err && err.message))) return t('db.errRefused');
  return String((err && err.message) || err);
}

function register({ ipcMain, sessions, secrets, configDir, dialog, getWin }) {
  const file = path.join(configDir, 'db-connections.json');
  const conns = new Map(); // Tab-ID -> { client, server, cfg }

  const loadCfg = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { return {}; } };
  const saveCfg = all => { fs.mkdirSync(configDir, { recursive: true, mode: 0o700 }); fs.writeFileSync(file, JSON.stringify(all, null, 2), { mode: 0o600 }); };
  const ssh = tabId => { const s = sessions.get(tabId); if (!s || !s.client) throw new Error(t('dashboard.notConnected')); return s.client; };
  const conn = tabId => { const c = conns.get(tabId); if (!c) throw new Error(t('db.notConnected')); return c; };
  const wrap = fn => async (...a) => { try { return await fn(...a); } catch (err) { throw new Error(friendly(err)); } };

  async function close(tabId) {
    const c = conns.get(tabId);
    if (!c) return;
    conns.delete(tabId);
    try { await c.client.end(); } catch {}
    try { c.server.close(); } catch {}
  }

  // Lokaler Port -> forwardOut über die SSH-Verbindung
  function forwarder(client, host, port) {
    return new Promise((resolve, reject) => {
      const server = net.createServer({ pauseOnConnect: true }, sock => {
        client.forwardOut('127.0.0.1', 0, host, port, (err, ch) => {
          if (err) { sock.destroy(); return; }
          sock.pipe(ch).pipe(sock);
          sock.on('error', () => ch.close()); ch.on('error', () => sock.destroy());
          sock.on('close', () => ch.close()); ch.on('close', () => sock.destroy());
          sock.resume();
        });
      });
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => resolve(server));
    });
  }

  ipcMain.handle('db:config', (_e, key) => {
    const cfg = loadCfg()[String(key)] || null;
    return { cfg, hasPassword: !!(cfg && secrets.read(String(key)) != null) };
  });

  ipcMain.handle('db:forget', (_e, key) => {
    const all = loadCfg(); delete all[String(key)]; saveCfg(all); secrets.remove(String(key)); return true;
  });

  ipcMain.handle('db:detect', wrap(async (_e, tabId) => {
    const pattern = "'^(export )?(DATABASE_URL|POSTGRES_URL|POSTGRES_PRISMA_URL|DB_URL|PG_URL|PGHOST|PGPORT|PGUSER|PGPASSWORD|PGDATABASE|POSTGRES_(HOST|PORT|USER|PASSWORD|DB)|DB_(HOST|PORT|USER|USERNAME|PASSWORD|NAME|DATABASE))='";
    const r = await exec(ssh(tabId), `${findCmd()} | while IFS= read -r f; do grep -HE ${pattern} "$f" 2>/dev/null; done | head -n 200`, { timeout: 30000 });
    return parseCandidates(r.out);
  }));

  ipcMain.handle('db:connect', wrap(async (_e, tabId, key, input = {}) => {
    await close(tabId);
    const k = String(key);
    const cfg = {
      host: String(input.host || '127.0.0.1').trim(), port: Number(input.port) || 5432,
      database: String(input.database || '').trim(), user: String(input.user || '').trim(),
    };
    if (!cfg.database || !cfg.user) throw new Error(t('db.errMissing'));
    const password = input.password != null && input.password !== '' ? String(input.password) : secrets.read(k) || '';
    const server = await forwarder(ssh(tabId), cfg.host, cfg.port);
    const { Client } = require('pg');
    const client = new Client({
      host: '127.0.0.1', port: server.address().port, database: cfg.database, user: cfg.user, password,
      connectionTimeoutMillis: 15000, application_name: 'S3cure SSH Client', ssl: false,
    });
    client.on('error', () => close(tabId));
    try { await client.connect(); } catch (err) { server.close(); throw err; }
    conns.set(tabId, { client, server, cfg });
    // gemerkt wird erst nach erfolgreicher Anmeldung
    const all = loadCfg(); all[k] = cfg; saveCfg(all);
    if (input.remember && input.password) secrets.write(k, String(input.password));
    if (input.remember === false) secrets.remove(k);
    const v = await client.query('select current_user as u, current_database() as d, version() as v');
    return { ...cfg, user: v.rows[0].u, database: v.rows[0].d, version: String(v.rows[0].v).split(' on ')[0] };
  }));

  ipcMain.handle('db:close', (_e, tabId) => close(tabId));

  ipcMain.handle('db:tables', wrap(async (_e, tabId) => {
    const r = await conn(tabId).client.query(`
      select n.nspname as schema, c.relname as name, c.relkind as kind, greatest(c.reltuples, 0)::bigint as rows,
             pg_total_relation_size(c.oid) as size
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind in ('r','v','m','p','f') and n.nspname not in ('pg_catalog','information_schema') and n.nspname not like 'pg_toast%'
      order by n.nspname <> 'public', n.nspname, c.relname`);
    return r.rows.map(x => ({ schema: x.schema, name: x.name, kind: x.kind, rows: Number(x.rows), size: Number(x.size) }));
  }));

  // Tabelle blättern: { schema, table, offset, limit, orderBy, desc, filter }
  ipcMain.handle('db:table', wrap(async (_e, tabId, o = {}) => {
    const c = conn(tabId).client;
    const rel = `${qi(o.schema)}.${qi(o.table)}`;
    const pk = (await c.query(`select a.attname from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
      where i.indrelid = (quote_ident($1) || '.' || quote_ident($2))::regclass and i.indisprimary order by array_position(i.indkey, a.attnum)`, [o.schema, o.table])).rows.map(x => x.attname);
    const head = await c.query({ text: `select * from ${rel} limit 0`, rowMode: 'array' });
    const cols = head.fields.map(f => f.name);
    const where = o.filter ? ' where _t::text ilike $1' : '';
    const params = o.filter ? ['%' + String(o.filter).replace(/[\\%_]/g, m => '\\' + m) + '%'] : [];
    const order = cols.includes(o.orderBy) ? ` order by ${qi(o.orderBy)} ${o.desc ? 'desc' : 'asc'} nulls last` : pk.length ? ` order by ${pk.map(qi).join(', ')}` : '';
    const limit = Math.min(500, Math.max(1, Number(o.limit) || 100));
    const offset = Math.max(0, Number(o.offset) || 0);
    const pkSel = pk.map((k, i) => `, ${qi(k)}::text as ${qi('__pk' + i)}`).join('');
    const rows = await c.query({ text: `select _t.*${pkSel} from ${rel} as _t${where}${order} offset ${offset} limit ${limit}`, values: params, rowMode: 'array' });
    const count = await c.query({ text: `select count(*)::int as n from (select 1 from ${rel} as _t${where} limit ${COUNT_CAP + 1}) x`, values: params });
    const types = await typeNames(c, head.fields.map(f => f.dataTypeID));
    return {
      columns: head.fields.map(f => ({ name: f.name, type: types.get(f.dataTypeID) || '' })), pk,
      rows: rows.rows.map(r => ({ cells: r.slice(0, cols.length).map(cell), pk: r.slice(cols.length) })),
      total: count.rows[0].n, capped: count.rows[0].n > COUNT_CAP, offset, limit,
    };
  }));

  async function typeNames(c, ids) {
    const uniq = [...new Set(ids)];
    if (!uniq.length) return new Map();
    const r = await c.query('select oid, format_type(oid, null) as name from pg_type where oid = any($1)', [uniq]);
    return new Map(r.rows.map(x => [Number(x.oid), x.name]));
  }

  // Genau eine Zeile ändern/löschen – sonst zurückrollen
  async function oneRow(c, sql, values) {
    await c.query('begin');
    try {
      const r = await c.query(sql, values);
      if (r.rowCount !== 1) throw new Error(t('db.errRowCount', { n: r.rowCount }));
      await c.query('commit');
    } catch (err) { await c.query('rollback').catch(() => {}); throw err; }
  }
  const pkWhere = (pk, start) => pk.map((k, i) => `${qi(k)} = $${start + i}`).join(' and ');

  ipcMain.handle('db:update', wrap(async (_e, tabId, o = {}) => {
    const c = conn(tabId).client;
    if (!Array.isArray(o.pk) || !o.pk.length) throw new Error(t('db.errNoPk'));
    await oneRow(c, `update ${qi(o.schema)}.${qi(o.table)} set ${qi(o.column)} = $1 where ${pkWhere(o.pk, 2)}`, [o.value, ...o.pkValues]);
    return true;
  }));

  ipcMain.handle('db:delete', wrap(async (_e, tabId, o = {}) => {
    const c = conn(tabId).client;
    if (!Array.isArray(o.pk) || !o.pk.length) throw new Error(t('db.errNoPk'));
    await oneRow(c, `delete from ${qi(o.schema)}.${qi(o.table)} where ${pkWhere(o.pk, 1)}`, o.pkValues);
    return true;
  }));

  ipcMain.handle('db:query', wrap(async (_e, tabId, sql) => {
    const c = conn(tabId).client;
    const started = Date.now();
    const res = await c.query({ text: String(sql), rowMode: 'array' });
    const list = Array.isArray(res) ? res : [res];
    const last = [...list].reverse().find(r => r.fields && r.fields.length) || list[list.length - 1];
    const types = await typeNames(c, (last.fields || []).map(f => f.dataTypeID));
    return {
      ms: Date.now() - started, command: last.command, rowCount: last.rowCount, statements: list.length,
      columns: (last.fields || []).map(f => ({ name: f.name, type: types.get(f.dataTypeID) || '' })),
      rows: (last.rows || []).slice(0, MAX_ROWS).map(r => ({ cells: r.map(cell) })), truncated: (last.rows || []).length > MAX_ROWS,
    };
  }));

  ipcMain.handle('db:isReadOnly', (_e, sql) => isReadOnly(sql));

  // CSV speichern (UTF-8 mit BOM, damit Excel Umlaute richtig zeigt)
  ipcMain.handle('db:export', async (_e, { name = 'export', columns = [], rows = [] } = {}) => {
    const r = await dialog.showSaveDialog(getWin(), { defaultPath: String(name).replace(/[^\w.-]+/g, '_') + '.csv', filters: [{ name: 'CSV', extensions: ['csv'] }] });
    if (r.canceled || !r.filePath) return null;
    const q = v => (v == null ? '' : /[",\n\r]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v));
    const text = '﻿' + [columns.map(c => q(c.name || c)).join(','), ...rows.map(row => (row.cells || row).map(q).join(','))].join('\r\n') + '\r\n';
    fs.writeFileSync(r.filePath, text);
    return r.filePath;
  });

  return { close, closeAll: () => Promise.all([...conns.keys()].map(close)) };
}

module.exports = { register, parseUrl, parseCandidates, isReadOnly, cell, qi };
