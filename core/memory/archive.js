'use strict';

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { getPaths } = require('../lib/paths');

const RETENTION_DAYS = 90;
const archiveDir = () => path.join(getPaths().dataDir, 'archives', 'contacts');
const safeName = (name) => Buffer.from(String(name || ''), 'utf8').toString('hex') || 'contact';
const archivePath = (name) => path.join(archiveDir(), safeName(name) + '.sqlite');

// 微信旧记录使用本地时间，录音和部分导入使用带时区的 ISO 时间。
function messageTime(ts) { return Date.parse(ts) || 0; }

// ⚠️ 一次性成本，不是零成本迁移：第一次打开一个还没有 ts_ms 的库时，这里会对 message
// 全表做 `UPDATE message SET ts_ms=chat_time(ts)`（每行还要过一次 JS 的 Date.parse）。
// 主库和每个 90 天冷库（archives/contacts/*.sqlite）都会各跑一次，量级是 O(全表行数)：
//   - 主库：chat-db.js 启动时就会调用。消息多（几万行以上）时首次启动要慢几秒，
//     WAL 也会临时涨到接近被回填数据量的大小；之后启动只做一次 PRAGMA 判断，几乎零成本。
//   - 冷库：属于「懒迁移」——某个联系人的冷库第一次被 list/pages/stats/duplicateReader
//     打开时才回填。所以升级后第一次翻一个很久没看的老联系人会明显变慢，第二次起就是普通查询。
// 迁移本身幂等：ts_ms 已存在直接返回；回填在事务里，失败 ROLLBACK，下次打开重试。
// 回填完成后所有分页/搜索走 idx_message_time 上的 (ts_ms,id) 游标，不再逐行解析 ts 字符串。
function ensureMessageTime(db) {
  const hasColumn = () => db.prepare('PRAGMA table_info(message)').all().some(column => column.name === 'ts_ms');
  if (hasColumn()) return;
  db.function('chat_time', messageTime);
  db.exec('BEGIN IMMEDIATE');
  try {
    if (!hasColumn()) {
      db.exec('ALTER TABLE message ADD COLUMN ts_ms INTEGER NOT NULL DEFAULT 0');
      db.exec('UPDATE message SET ts_ms=chat_time(ts)');
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function open(name) {
  fs.mkdirSync(archiveDir(), { recursive: true });
  const db = new DatabaseSync(archivePath(name));
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS message (id INTEGER PRIMARY KEY, sender TEXT NOT NULL, ts TEXT NOT NULL, type TEXT NOT NULL, content TEXT NOT NULL, content_hash TEXT UNIQUE); CREATE INDEX IF NOT EXISTS idx_message_ts ON message(ts, id);');
  const columns = new Set(db.prepare('PRAGMA table_info(message)').all().map(column => column.name));
  if (!columns.has('source')) db.exec("ALTER TABLE message ADD COLUMN source TEXT NOT NULL DEFAULT ''");
  if (!columns.has('is_owner')) db.exec('ALTER TABLE message ADD COLUMN is_owner INTEGER');
  ensureMessageTime(db);
  db.exec('CREATE INDEX IF NOT EXISTS idx_message_time ON message(ts_ms, id)');
  return db;
}
function exists(name) { return fs.existsSync(archivePath(name)); }

function list(name, { before = '', beforeId = 0, limit = 100 } = {}) {
  if (!exists(name)) return [];
  const db = open(name);
  const n = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const cursorId = Number(beforeId) || 0;
  const cursorTime = before || cursorId ? messageTime(before) : Number.MAX_SAFE_INTEGER;
  try {
    const rows = db.prepare(`SELECT id,sender,ts,type,content,source,is_owner FROM message
      WHERE (ts_ms, id) < (?, ?) ORDER BY ts_ms DESC, id DESC LIMIT ?`)
      .all(cursorTime, cursorId, n).reverse();
    return rows.map((message) => ({ ...message, name: message.sender }));
  } finally { db.close(); }
}

function senderFlags(name, hashes) {
  if (!hashes.length || !exists(name)) return new Map();
  const db = open(name);
  try {
    const rows = db.prepare(`SELECT content_hash, is_owner FROM message WHERE is_owner IS NOT NULL
      AND content_hash IN (${hashes.map(() => '?').join(',')})`).all(...hashes);
    return new Map(rows.map(row => [row.content_hash, row.is_owner]));
  } finally { db.close(); }
}

function duplicateReader(name) {
  if (!exists(name)) return { has: () => false, byHash: () => undefined, close() {} };
  const connection = open(name);
  const statement = connection.prepare('SELECT 1 FROM message WHERE ts=? AND sender=? AND type=? AND content=? AND source=\'\' LIMIT 1');
  const byHash = connection.prepare('SELECT is_owner FROM message WHERE content_hash=?');
  const confirm = connection.prepare('UPDATE message SET is_owner=? WHERE content_hash=? AND is_owner IS NULL');
  return { byHash: hash => byHash.get(hash), confirm: (hash, owner) => confirm.run(owner, hash),
    has: (message, hash) => hash ? !!byHash.get(hash) : !!statement.get(message.ts, message.name, message.type, message.content), close: () => connection.close() };
}

function* pages(name, limit = 300) {
  if (!exists(name)) return;
  const db = open(name);
  try {
    let cursor = 0;
    let timestamp = Number.MIN_SAFE_INTEGER;
    const maximum = db.prepare('SELECT MAX(id) AS id FROM message').get().id;
    if (maximum === null) return;
    while (true) {
      const rows = db.prepare(`SELECT * FROM message WHERE id<=? AND (ts_ms, id) > (?, ?)
        ORDER BY ts_ms, id LIMIT ?`).all(maximum, timestamp, cursor, limit);
      if (!rows.length) break;
      cursor = rows[rows.length - 1].id;
      timestamp = rows[rows.length - 1].ts_ms;
      yield rows.map(({ ts_ms, ...row }) => ({ ...row, name: row.sender }));
    }
  } finally { db.close(); }
}

function all(name) { return [...pages(name)].flat(); }

function stats(name) {
  if (!exists(name)) return { total: 0, fromTs: '', toTs: '' };
  const db = open(name);
  try {
    const row = db.prepare('SELECT COUNT(*) AS total, MIN(ts) AS fromTs, MAX(ts) AS toTs FROM message').get();
    return { total: Number(row?.total || 0), fromTs: row?.fromTs || '', toTs: row?.toTs || '' };
  } finally { db.close(); }
}

function append(name, rows) {
  if (!rows.length) return;
  const db = open(name);
  const stmt = db.prepare('INSERT OR IGNORE INTO message(id,sender,ts,type,content,content_hash,source,is_owner,ts_ms) VALUES(?,?,?,?,?,?,?,?,?)');
  db.exec('BEGIN');
  try {
    for (const m of rows) {
      stmt.run(Number(m.id || 0), String(m.name || m.sender || ''), String(m.ts || ''), String(m.type || 'text'), String(m.content || ''), String(m.content_hash || m.contentHash || `${m.name}|${m.ts}|${m.type}|${m.content}`), m.source || '', m.is_owner ?? null, m.ts_ms ?? messageTime(m.ts));
    }
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    throw e;
  } finally { db.close(); }
}

function remove(name) { try { fs.rmSync(archivePath(name), { force: true }); fs.rmSync(archivePath(name) + '-wal', { force: true }); fs.rmSync(archivePath(name) + '-shm', { force: true }); } catch {} }

module.exports = { RETENTION_DAYS, messageTime, ensureMessageTime, archivePath, exists, senderFlags, list, all, stats, pages, append, remove, duplicateReader };
