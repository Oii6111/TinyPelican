'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { getPaths } = require('../lib/paths');

function json(value, fallback = null) {
  try { return value == null || value === '' ? fallback : JSON.parse(value); } catch { return fallback; }
}
function now() { return new Date().toISOString(); }
function mapMessage(row) {
  if (!row) return null;
  return {
    id: Number(row.id), accountId: row.account_id, folder: row.folder,
    uidValidity: Number(row.uid_validity || 0), uid: Number(row.uid || 0), messageId: row.message_id || '', threadId: row.thread_id || '',
    from: json(row.from_json, {}), to: json(row.to_json, []), cc: json(row.cc_json, []), subject: row.subject || '', date: row.date || '',
    text: row.text_body || '', html: row.html_body || '', snippet: row.snippet || '', attachments: json(row.attachments_json, []),
    category: row.category || 'unknown', importance: Number(row.importance || 0), summary: row.summary || '', analysisStatus: row.analysis_status || 'pending',
    analysisError: row.analysis_error || '', contact: row.contact_name || '', contactStatus: row.contact_status || (row.contact_name ? 'linked' : 'unmatched'), contactCandidates: json(row.contact_candidates_json, []), notified: !!row.notified, createdAt: row.created_at, updatedAt: row.updated_at
  };
}

function createEmailDb(file = getPaths().emailDatabase) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS email_account (id TEXT PRIMARY KEY, address TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'disabled', last_error TEXT NOT NULL DEFAULT '', last_sync_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT '');
    CREATE TABLE IF NOT EXISTS email_message (
      id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL, folder TEXT NOT NULL, uid_validity INTEGER NOT NULL DEFAULT 0, uid INTEGER NOT NULL DEFAULT 0,
      message_id TEXT NOT NULL DEFAULT '', content_hash TEXT NOT NULL, thread_id TEXT NOT NULL DEFAULT '', from_json TEXT NOT NULL DEFAULT '{}', to_json TEXT NOT NULL DEFAULT '[]', cc_json TEXT NOT NULL DEFAULT '[]',
      subject TEXT NOT NULL DEFAULT '', date TEXT NOT NULL DEFAULT '', text_body TEXT NOT NULL DEFAULT '', html_body TEXT NOT NULL DEFAULT '', snippet TEXT NOT NULL DEFAULT '', attachments_json TEXT NOT NULL DEFAULT '[]',
      category TEXT NOT NULL DEFAULT 'unknown', importance REAL NOT NULL DEFAULT 0, summary TEXT NOT NULL DEFAULT '', analysis_status TEXT NOT NULL DEFAULT 'pending', analysis_error TEXT NOT NULL DEFAULT '',
      contact_name TEXT NOT NULL DEFAULT '', contact_status TEXT NOT NULL DEFAULT 'unmatched', contact_candidates_json TEXT NOT NULL DEFAULT '[]', notified INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(account_id, folder, uid_validity, uid), UNIQUE(content_hash)
    );
    CREATE INDEX IF NOT EXISTS idx_email_message_date ON email_message(date DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_email_message_category ON email_message(category, analysis_status);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_email_message_message_id ON email_message(account_id, message_id) WHERE message_id<>'';
    CREATE TABLE IF NOT EXISTS email_sync_state (account_id TEXT NOT NULL, folder TEXT NOT NULL, uid_validity INTEGER NOT NULL DEFAULT 0, last_uid INTEGER NOT NULL DEFAULT 0, initial_done INTEGER NOT NULL DEFAULT 0, last_sync_at TEXT NOT NULL DEFAULT '', last_error TEXT NOT NULL DEFAULT '', PRIMARY KEY(account_id, folder));
    CREATE TABLE IF NOT EXISTS email_job (id INTEGER PRIMARY KEY AUTOINCREMENT, message_id INTEGER NOT NULL UNIQUE REFERENCES email_message(id) ON DELETE CASCADE, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, next_at TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS email_notification (account_id TEXT NOT NULL, message_id TEXT NOT NULL, event TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(account_id, message_id, event));
  `);
  try { db.exec("ALTER TABLE email_message ADD COLUMN contact_status TEXT NOT NULL DEFAULT 'unmatched'"); } catch {}
  try { db.exec("ALTER TABLE email_message ADD COLUMN contact_candidates_json TEXT NOT NULL DEFAULT '[]'"); } catch {}
  const ensureAccount = (id, address) => {
    const accountId = String(id);
    const stamp = now();
    if (address === undefined) {
      return db.prepare(`INSERT INTO email_account(id,address,updated_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at`).run(accountId, '', stamp);
    }
    return db.prepare(`INSERT INTO email_account(id,address,updated_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET address=excluded.address,updated_at=excluded.updated_at`).run(accountId, String(address || ''), stamp);
  };
  const getAccount = (id) => db.prepare('SELECT * FROM email_account WHERE id=?').get(String(id)) || null;
  function setAccountStatus(id, status, error = '') { ensureAccount(id); db.prepare('UPDATE email_account SET status=?,last_error=?,last_sync_at=CASE WHEN ?=\'connected\' THEN ? ELSE last_sync_at END,updated_at=? WHERE id=?').run(String(status), String(error || ''), String(status), now(), now(), String(id)); }
  function getSync(id, folder) { return db.prepare('SELECT * FROM email_sync_state WHERE account_id=? AND folder=?').get(String(id), String(folder)) || { account_id: id, folder, uid_validity: 0, last_uid: 0, initial_done: 0, last_sync_at: '', last_error: '' }; }
  function saveSync(id, folder, patch = {}) {
    const current = getSync(id, folder);
    const uidValidity = patch.uidValidity === undefined ? Number(current.uid_validity || 0) : Number(patch.uidValidity || 0);
    const lastUid = patch.lastUid === undefined ? Number(current.last_uid || 0) : Number(patch.lastUid || 0);
    const initialDone = patch.initialDone === undefined ? Number(current.initial_done || 0) : (patch.initialDone ? 1 : 0);
    db.prepare(`INSERT INTO email_sync_state(account_id,folder,uid_validity,last_uid,initial_done,last_sync_at,last_error) VALUES(?,?,?,?,?,?,?) ON CONFLICT(account_id,folder) DO UPDATE SET uid_validity=excluded.uid_validity,last_uid=excluded.last_uid,initial_done=excluded.initial_done,last_sync_at=excluded.last_sync_at,last_error=excluded.last_error`).run(String(id), String(folder), uidValidity, lastUid, initialDone, patch.lastSyncAt ?? current.last_sync_at ?? '', patch.lastError ?? current.last_error ?? '');
  }
  function insertMessage(input) {
    const stamp = now();
    const row = { accountId: String(input.accountId), folder: String(input.folder || 'INBOX'), uidValidity: Number(input.uidValidity || 0), uid: Number(input.uid || 0), messageId: String(input.messageId || ''), contentHash: String(input.contentHash || '') || crypto.createHash('sha256').update(JSON.stringify([input.accountId, input.folder || 'INBOX', input.uidValidity || 0, input.uid || 0, input.subject || '', input.text || ''])).digest('hex'), threadId: String(input.threadId || ''), from: JSON.stringify(input.from || {}), to: JSON.stringify(input.to || []), cc: JSON.stringify(input.cc || []), subject: String(input.subject || ''), date: String(input.date || stamp), text: String(input.text || ''), html: String(input.html || ''), snippet: String(input.snippet || '').slice(0, 1000), attachments: JSON.stringify(input.attachments || []) };
    const existing = row.messageId ? db.prepare('SELECT id FROM email_message WHERE account_id=? AND message_id=?').get(row.accountId, row.messageId) : (row.contentHash ? db.prepare('SELECT id FROM email_message WHERE content_hash=?').get(row.contentHash) : null);
    if (existing) return { inserted: false, id: Number(existing.id), message: getMessage(existing.id) };
    const result = db.prepare(`INSERT INTO email_message(account_id,folder,uid_validity,uid,message_id,content_hash,thread_id,from_json,to_json,cc_json,subject,date,text_body,html_body,snippet,attachments_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(row.accountId, row.folder, row.uidValidity, row.uid, row.messageId, row.contentHash, row.threadId, row.from, row.to, row.cc, row.subject, row.date, row.text, row.html, row.snippet, row.attachments, stamp, stamp);
    const id = Number(result.lastInsertRowid);
    db.prepare('INSERT OR IGNORE INTO email_job(message_id,updated_at) VALUES(?,?)').run(id, stamp);
    return { inserted: true, id, message: getMessage(id) };
  }
  const getMessage = (id) => mapMessage(db.prepare('SELECT * FROM email_message WHERE id=?').get(Number(id)));
  function listMessages(options = {}) {
    const where = []; const params = [];
    if (options.category) { where.push('category=?'); params.push(String(options.category)); }
    if (options.status) { where.push('analysis_status=?'); params.push(String(options.status)); }
    if (options.important !== undefined && options.important !== '') {
      const important = String(options.important).trim().toLowerCase();
      if (important === '1' || important === 'true') { where.push('importance>=?'); params.push(0.5); }
      else if (important === '0' || important === 'false') { where.push('importance<?'); params.push(0.5); }
    }
    if (options.contact) { where.push('contact_name=?'); params.push(String(options.contact)); }
    if (options.contactStatus) { where.push('contact_status=?'); params.push(String(options.contactStatus)); }
    if (options.q) { where.push('(subject LIKE ? OR text_body LIKE ? OR from_json LIKE ?)'); const q = `%${String(options.q)}%`; params.push(q, q, q); }
    if (options.before) { where.push('(date<? OR (date=? AND id<?))'); params.push(String(options.before.date || ''), String(options.before.date || ''), Number(options.before.id || 0)); }
    const limit = Math.min(100, Math.max(1, Number(options.limit) || 30)); const rows = db.prepare(`SELECT * FROM email_message ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY date DESC,id DESC LIMIT ?`).all(...params, limit + 1); const hasMore = rows.length > limit; if (hasMore) rows.pop(); return { messages: rows.map(mapMessage), hasMore };
  }
  function claimJobs(limit = 2) { const rows = db.prepare("SELECT * FROM email_job WHERE status='pending' AND (next_at='' OR next_at<=?) ORDER BY id LIMIT ?").all(now(), Math.min(10, Math.max(1, Number(limit) || 2))); const claimed = []; for (const row of rows) { const result = db.prepare("UPDATE email_job SET status='running',attempts=attempts+1,updated_at=? WHERE id=? AND status='pending'").run(now(), row.id); if (result.changes) claimed.push({ ...row, attempts: Number(row.attempts || 0) + 1, message: getMessage(row.message_id) }); } return claimed; }
  const completeJob = (id) => db.prepare("UPDATE email_job SET status='done',error='',updated_at=? WHERE id=?").run(now(), Number(id));
  const failJob = (id, error, retryMs = 60000) => db.prepare("UPDATE email_job SET status='pending',error=?,next_at=?,updated_at=? WHERE id=?").run(String(error || '').slice(0, 1000), new Date(Date.now() + retryMs).toISOString(), now(), Number(id));
  function updateAnalysis(id, patch = {}) { const fields = []; const values = []; for (const [key, value] of [['category', patch.category], ['importance', patch.importance], ['summary', patch.summary], ['analysis_status', patch.analysisStatus], ['analysis_error', patch.analysisError], ['contact_name', patch.contact], ['contact_status', patch.contactStatus], ['contact_candidates_json', patch.contactCandidates === undefined ? undefined : JSON.stringify(patch.contactCandidates || [])], ['notified', patch.notified === undefined ? undefined : (patch.notified ? 1 : 0)]]) { if (value !== undefined) { fields.push(`${key}=?`); values.push(value); } } if (!fields.length) return getMessage(id); fields.push('updated_at=?'); values.push(now(), Number(id)); db.prepare(`UPDATE email_message SET ${fields.join(',')} WHERE id=?`).run(...values); return getMessage(id); }
  const notificationExists = (accountId, messageId, event) => !!db.prepare('SELECT 1 FROM email_notification WHERE account_id=? AND message_id=? AND event=?').get(String(accountId), String(messageId), String(event));
  const recordNotification = (accountId, messageId, event) => db.prepare('INSERT OR IGNORE INTO email_notification(account_id,message_id,event,created_at) VALUES(?,?,?,?)').run(String(accountId), String(messageId), String(event), now());
  function status(id) { const account = getAccount(id); const sync = db.prepare('SELECT * FROM email_sync_state WHERE account_id=? ORDER BY folder LIMIT 1').get(String(id)); return { account: account || null, sync: sync || null, pending: Number(db.prepare("SELECT COUNT(*) AS n FROM email_job WHERE status IN ('pending','running')").get().n || 0) }; }
  const close = () => { try { db.close(); } catch {} };
  return { db, ensureAccount, setAccountStatus, getAccount, getSync, saveSync, insertMessage, getMessage, listMessages, claimJobs, completeJob, failJob, updateAnalysis, notificationExists, recordNotification, status, close };
}

module.exports = { createEmailDb, mapMessage };
