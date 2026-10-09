'use strict';

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { getPaths } = require('../lib/paths');

const RETENTION_DAYS = 90;
const archiveDir = () => path.join(getPaths().dataDir, 'archives', 'contacts');
const safeName = (name) => Buffer.from(String(name || ''), 'utf8').toString('hex') || 'contact';
const archivePath = (name) => path.join(archiveDir(), safeName(name) + '.sqlite');

function open(name) {
  fs.mkdirSync(archiveDir(), { recursive: true });
  const db = new DatabaseSync(archivePath(name));
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS message (id INTEGER PRIMARY KEY, sender TEXT NOT NULL, ts TEXT NOT NULL, type TEXT NOT NULL, content TEXT NOT NULL, content_hash TEXT UNIQUE); CREATE INDEX IF NOT EXISTS idx_message_ts ON message(ts, id);');
  return db;
}
function exists(name) { return fs.existsSync(archivePath(name)); }

function list(name, { before = '', beforeId = 0, limit = 100 } = {}) {
  if (!exists(name)) return [];
  const db = open(name);
  const n = Math.min(Math.max(Number(limit) || 100, 1), 500);
  try {
    const rows = db.prepare('SELECT id,sender,ts,type,content FROM message WHERE (? = \'\' OR ts < ? OR (ts=? AND id<?)) ORDER BY ts DESC,id DESC LIMIT ?').all(String(before || ''), String(before || ''), String(before || ''), Number(beforeId) || 0, n).reverse();
    return rows.map((message) => ({ ...message, name: message.sender }));
  } finally { db.close(); }
}

function duplicateReader(name) {
  if (!exists(name)) return { has: () => false, close() {} };
  const connection = new DatabaseSync(archivePath(name), { readOnly: true });
  const statement = connection.prepare('SELECT 1 FROM message WHERE ts=? AND sender=? AND type=? AND content=? LIMIT 1');
  return { has: (message) => !!statement.get(message.ts, message.name, message.type, message.content), close: () => connection.close() };
}

function* pages(name, limit = 300) {
  if (!exists(name)) return;
  const db = new DatabaseSync(archivePath(name), { readOnly: true });
  try {
    let cursor = -1;
    let timestamp = '';
    const maximum = db.prepare('SELECT MAX(id) AS id FROM message').get().id;
    if (maximum === null) return;
    while (true) {
      const rows = db.prepare('SELECT * FROM message WHERE id<=? AND (ts>? OR (ts=? AND id>?)) ORDER BY ts,id LIMIT ?').all(maximum, timestamp, timestamp, cursor, limit);
      if (!rows.length) break;
      cursor = rows[rows.length - 1].id;
      timestamp = rows[rows.length - 1].ts;
      yield rows.map((row) => ({ ...row, name: row.sender }));
    }
  } finally { db.close(); }
}

function all(name) { return [...pages(name)].flat(); }

function append(name, rows) {
  if (!rows.length) return;
  const db = open(name);
  const stmt = db.prepare('INSERT OR IGNORE INTO message(id,sender,ts,type,content,content_hash) VALUES(?,?,?,?,?,?)');
  db.exec('BEGIN');
  try {
    for (const m of rows) {
      stmt.run(Number(m.id || 0), String(m.name || m.sender || ''), String(m.ts || ''), String(m.type || 'text'), String(m.content || ''), String(m.content_hash || m.contentHash || `${m.name}|${m.ts}|${m.type}|${m.content}`));
    }
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    throw e;
  } finally { db.close(); }
}

function remove(name) { try { fs.rmSync(archivePath(name), { force: true }); fs.rmSync(archivePath(name) + '-wal', { force: true }); fs.rmSync(archivePath(name) + '-shm', { force: true }); } catch {} }

module.exports = { RETENTION_DAYS, archivePath, exists, list, all, pages, append, remove, duplicateReader };
