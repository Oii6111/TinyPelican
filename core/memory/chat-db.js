'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const { getPaths } = require('../lib/paths');
const archive = require('./archive');
const { mergeProfile } = require('./profile-template');
const memoryState = require('./memory-state');

const dbPath = path.join(getPaths().dataDir, 'tinypelican.sqlite');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new DatabaseSync(dbPath);
let syncStamp = '';
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS meta (name TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS member (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    platform_id TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    remark TEXT DEFAULT '',
    avatar TEXT DEFAULT '',
    important INTEGER NOT NULL DEFAULT 0,
    profile_json TEXT NOT NULL DEFAULT '{}',
    profile_meta_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS member_name_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id INTEGER NOT NULL REFERENCES member(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    start_ts TEXT NOT NULL,
    end_ts TEXT
  );
  CREATE TABLE IF NOT EXISTS contact_profile (
    contact_key TEXT PRIMARY KEY,
    member_id INTEGER NOT NULL UNIQUE REFERENCES member(id) ON DELETE CASCADE,
    display_name TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    relationship TEXT NOT NULL DEFAULT '',
    social_goal TEXT NOT NULL DEFAULT '',
    tone TEXT NOT NULL DEFAULT '',
    boundaries TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS conversation (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id INTEGER NOT NULL UNIQUE REFERENCES member(id) ON DELETE CASCADE,
    platform TEXT NOT NULL DEFAULT 'weixin',
    last_message_at TEXT
  );
  CREATE TABLE IF NOT EXISTS message (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id INTEGER NOT NULL REFERENCES member(id) ON DELETE CASCADE,
    sender TEXT NOT NULL,
    ts TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'text',
    content TEXT NOT NULL DEFAULT '',
    platform_message_id TEXT,
    content_hash TEXT NOT NULL UNIQUE
  );
  CREATE INDEX IF NOT EXISTS idx_message_member_ts ON message(member_id, ts DESC, id DESC);
  CREATE INDEX IF NOT EXISTS idx_message_member_id ON message(member_id, id ASC);
  CREATE INDEX IF NOT EXISTS idx_message_content ON message(content);
  CREATE INDEX IF NOT EXISTS idx_member_name ON member(name);
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS member_email (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id INTEGER NOT NULL REFERENCES member(id) ON DELETE CASCADE,
    normalized_address TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'manual',
    verified INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(member_id, normalized_address)
  );
  CREATE INDEX IF NOT EXISTS idx_member_email_address ON member_email(normalized_address);
`);
try { db.exec('ALTER TABLE message ADD COLUMN conversation_id INTEGER REFERENCES conversation(id)'); } catch {}
try { db.exec("ALTER TABLE member ADD COLUMN profile_meta_json TEXT NOT NULL DEFAULT '{}'"); } catch {}
try { db.exec('CREATE VIRTUAL TABLE IF NOT EXISTS message_fts USING fts5(content, content="message", content_rowid="id")'); } catch {}
if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='message_fts'").get()) {
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS message_fts_insert AFTER INSERT ON message BEGIN
      INSERT INTO message_fts(rowid,content) VALUES(NEW.id,NEW.content);
    END;
    CREATE TRIGGER IF NOT EXISTS message_fts_delete AFTER DELETE ON message BEGIN
      INSERT INTO message_fts(message_fts,rowid,content) VALUES('delete',OLD.id,OLD.content);
    END;
    CREATE TRIGGER IF NOT EXISTS message_fts_update AFTER UPDATE OF content ON message BEGIN
      INSERT INTO message_fts(message_fts,rowid,content) VALUES('delete',OLD.id,OLD.content);
      INSERT INTO message_fts(rowid,content) VALUES(NEW.id,NEW.content);
    END;
  `);
  if (!db.prepare("SELECT 1 FROM meta WHERE name='message_fts_initialized_v1'").get()) {
    db.exec("INSERT INTO message_fts(message_fts) VALUES('rebuild'); INSERT INTO meta(name,value) VALUES('message_fts_initialized_v1','1')");
  }
}
memoryState.setup(db);

function hashMessage(member, m) { return crypto.createHash('sha1').update(JSON.stringify([member, m.name, m.ts, m.type, m.content])).digest('hex'); }

function syncLegacy() {
  const contactsDir = getPaths().contacts;
  if (!fs.existsSync(contactsDir)) return;
  const files = fs.readdirSync(contactsDir).filter((x) => x.endsWith('.json'));
  if (db.prepare("SELECT 1 FROM meta WHERE name='legacy_json_migrated'").get() && !files.length) { syncStamp = 'done'; return; }
  const stamp = files.map((file) => { try { const s = fs.statSync(path.join(contactsDir, file)); return file + ':' + s.size + ':' + s.mtimeMs; } catch { return file; } }).join('|');
  if (stamp === syncStamp) return;
  const now = new Date().toISOString();
  const insertMember = db.prepare('INSERT OR IGNORE INTO member(platform_id,name,remark,important,profile_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)');
  const updateMember = db.prepare('UPDATE member SET name=?,remark=?,important=?,profile_json=?,updated_at=? WHERE platform_id=?');
  const insertMessage = db.prepare('INSERT OR IGNORE INTO message(member_id,sender,ts,type,content,content_hash) VALUES(?,?,?,?,?,?)');
  const upsertConversation = db.prepare('INSERT INTO conversation(member_id,platform,last_message_at) VALUES(?,?,?) ON CONFLICT(member_id) DO UPDATE SET last_message_at=excluded.last_message_at');
  db.exec('BEGIN');
  try { for (const file of files) {
    let doc; try { doc = JSON.parse(fs.readFileSync(path.join(contactsDir, file), 'utf8')); } catch { continue; }
    const name = String(doc.name || file.replace(/\.json$/i, ''));
    const existing = db.prepare('SELECT updated_at AS updatedAt FROM member WHERE platform_id=?').get(name);
    insertMember.run(name, name, String(doc.remark || ''), doc.important ? 1 : 0, JSON.stringify(doc.profile || {}), now, now);
    if (!existing || !existing.updatedAt || String(doc.updatedAt || '') >= String(existing.updatedAt)) updateMember.run(name, String(doc.remark || ''), doc.important ? 1 : 0, JSON.stringify(doc.profile || {}), String(doc.updatedAt || now), name);
    const member = db.prepare('SELECT id FROM member WHERE platform_id=?').get(name);
    upsertConversation.run(member.id, 'weixin', doc.updatedAt || now);
    for (const m of (Array.isArray(doc.messages) ? doc.messages : [])) insertMessage.run(member.id, String(m.name || ''), String(m.ts || ''), String(m.type || 'text'), String(m.content || ''), hashMessage(name, m));
  } db.exec('COMMIT');
  for (const file of files) { try { fs.unlinkSync(path.join(contactsDir, file)); } catch {} }
  db.prepare("INSERT OR REPLACE INTO meta(name,value) VALUES('legacy_json_migrated',?)").run(now);
  syncStamp = 'done'; } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
}

function listMembers(query = '') {
  syncLegacy();
  const q = String(query || '').trim();
  return db.prepare(`SELECT member.id,member.platform_id AS platformId,member.name,member.remark,member.important,COALESCE(cp.social_goal,'') AS socialGoal,member.profile_json AS profileJson,member.profile_meta_json AS profileMetaJson,(SELECT COUNT(*) FROM message x WHERE x.member_id=member.id) AS messages,(SELECT MAX(ts) FROM message x WHERE x.member_id=member.id) AS updatedAt,(SELECT MAX(x.id) FROM message x WHERE x.member_id=member.id) AS lastMessageId FROM member LEFT JOIN contact_profile cp ON cp.member_id=member.id WHERE ?='' OR member.name LIKE ? OR member.remark LIKE ? ORDER BY important DESC, lastMessageId DESC, member.name COLLATE NOCASE`).all(q, `%${q}%`, `%${q}%`).map((member) => ({ ...member, important: !!member.important, socialGoal: member.socialGoal || '', profile: JSON.parse(member.profileJson || '{}'), profileMeta: JSON.parse(member.profileMetaJson || '{}'), messages: Number(member.messages || 0), lastMessageId: Number(member.lastMessageId || 0) }));
}

function getMember(name) {
  const key = String(name || '').trim();
  if (!key) return null;
  const members = listMembers('');
  const exact = members.find((member) => member.name === key);
  if (exact) return withMemory(exact);
  const matches = members.filter((member) => member.remark === key);
  matches.sort((leftMember, rightMember) => {
    if (leftMember.lastMessageId !== rightMember.lastMessageId) return rightMember.lastMessageId - leftMember.lastMessageId;
    const leftTime = Date.parse(String(leftMember.updatedAt || '').replace(/ (\d):/, ' 0$1:')) || 0;
    const rightTime = Date.parse(String(rightMember.updatedAt || '').replace(/ (\d):/, ' 0$1:')) || 0;
    return rightTime - leftTime;
  });
  return matches[0] ? withMemory(matches[0]) : null;
}
function withMemory(member) {
  const row = db.prepare('SELECT chat_summary_json,profile_skip_json FROM member WHERE id=?').get(member.id);
  return { ...member, chatSummary: JSON.parse(row.chat_summary_json || '{}'), profileSkipped: JSON.parse(row.profile_skip_json || '[]') };
}
function findUnannotatedMember() {
  return listMembers('').find((member) => !String(member.remark || '').trim() && Number(member.messages || 0) > 0) || null;
}
function messages(name, query = '', limit = 200, hotOnly = false, before = '', beforeId = 0) {
  syncLegacy(); const member = getMember(name); if (!member) return null;
  const q = String(query || '').trim(); const n = Math.min(Math.max(Number(limit) || 200, 1), 500);
  const config = (() => { try { return JSON.parse(fs.readFileSync(getPaths().config, 'utf8')); } catch { return {}; } })();
  const owners = new Set(config.selfNicknames || []);
  const canonical = member.name;
  const cutoff = new Date(Date.now() - archive.RETENTION_DAYS * 86400000).toISOString();
  const cursorTs = String(before || '');
  const cursorId = Number(beforeId) || 0;
  const rows = hotOnly
    ? db.prepare(`SELECT message.id, sender, sender AS senderName, ts, ts AS timestamp, type, content FROM message JOIN member ON member.id=message.member_id WHERE member.name=? AND ts>=? AND (?='' OR content LIKE ?) AND (?='' OR ts<? OR (ts=? AND message.id<?)) ORDER BY ts DESC,message.id DESC LIMIT ?`).all(canonical, cutoff, q, `%${q}%`, cursorTs, cursorTs, cursorTs, cursorId, n + 1)
    : db.prepare(`SELECT message.id, sender, sender AS senderName, ts, ts AS timestamp, type, content FROM message JOIN member ON member.id=message.member_id WHERE member.name=? AND (?='' OR content LIKE ?) AND (?='' OR ts<? OR (ts=? AND message.id<?)) ORDER BY ts DESC,message.id DESC LIMIT ?`).all(canonical, q, `%${q}%`, cursorTs, cursorTs, cursorTs, cursorId, n + 1);
  const hasMore = rows.length > n;
  if (hasMore) rows.pop();
  return { contact: canonical, total: rows.length, messages: rows.reverse().map((row) => ({ ...row, name: row.sender, isOwner: owners.has(row.sender) })), hasMore, hasArchive: archive.exists(canonical) || !!db.prepare('SELECT 1 FROM message WHERE member_id=? AND ts<? LIMIT 1').get(member.id, cutoff) };
}

function archiveMessages(name, before = '', limit = 100, beforeId = 0) {
  const member = getMember(name);
  if (!member) return null;
  archiveExpired(member.name);
  const owners = new Set(require('../lib/config').loadConfig().selfNicknames || []);
  return { contact: member.name, messages: archive.list(member.name, { before, beforeId, limit }).map((message) => ({ ...message, isOwner: owners.has(message.sender) })) };
}
function* historyPages(name, limit = 300) {
  const member = getMember(name);
  if (!member) return;
  yield* archive.pages(member.name, limit);
  let cursor = 0;
  let timestamp = '';
  const maximum = db.prepare('SELECT MAX(id) AS id FROM message WHERE member_id=?').get(member.id).id || 0;
  while (true) {
    const rows = db.prepare('SELECT *,sender AS name FROM message WHERE member_id=? AND id<=? AND (ts>? OR (ts=? AND id>?)) ORDER BY ts,id LIMIT ?').all(member.id, maximum, timestamp, timestamp, cursor, limit);
    if (!rows.length) break;
    cursor = rows[rows.length - 1].id;
    timestamp = rows[rows.length - 1].ts;
    yield rows;
  }
}
function allMessages(name) {
  const member = getMember(name);
  if (!member) return null;
  const rows = [...historyPages(member.name)].flat().sort((left, right) => String(left.ts).localeCompare(String(right.ts)) || left.id - right.id);
  return { contact: member.name, total: rows.length, messages: rows };
}
function archiveExpired(contact = '') {
  const cutoff = new Date(Date.now() - archive.RETENTION_DAYS * 86400000).toISOString();
  const members = contact ? [getMember(contact)].filter(Boolean) : listMembers('');
  for (const member of members) {
    while (true) {
      const rows = db.prepare('SELECT message.id,sender,ts,type,content,content_hash FROM message WHERE member_id=? AND ts<? ORDER BY id LIMIT 500').all(member.id, cutoff);
      if (!rows.length) break;
      archive.append(member.name, rows.map((message) => ({ ...message, name: message.sender })));
      db.exec('BEGIN');
      try {
        for (const row of rows) db.prepare('DELETE FROM message WHERE id=?').run(row.id);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    }
  }
  try { db.exec('PRAGMA optimize'); } catch {}
}
function updateMember(name, patch = {}, { replaceProfile = false } = {}) {
  const member = getMember(name); if (!member) return null;
  const profile = patch.profile && typeof patch.profile === 'object'
    ? mergeProfile(replaceProfile ? {} : member.profile || {}, patch.profile)
    : (member.profile || {});
  const meta = { ...(member.profileMeta || {}), ...(patch.profileMeta || {}), updatedAt: new Date().toISOString(), source: patch.profileMeta?.source || 'manual' };
  if (Array.isArray(patch.profileSkipped)) db.prepare('UPDATE member SET profile_skip_json=? WHERE id=?').run(JSON.stringify([...new Set(patch.profileSkipped.filter((value) => typeof value === 'string'))]), member.id);
  try { db.prepare('UPDATE member SET remark=?,important=?,profile_json=?,profile_meta_json=?,updated_at=? WHERE name=?').run(patch.remark === undefined ? member.remark : String(patch.remark), patch.important === undefined ? (member.important ? 1 : 0) : (patch.important ? 1 : 0), JSON.stringify(profile), JSON.stringify(meta), new Date().toISOString(), member.name); } catch { db.prepare('UPDATE member SET remark=?,important=?,profile_json=?,updated_at=? WHERE name=?').run(patch.remark === undefined ? member.remark : String(patch.remark), patch.important === undefined ? (member.important ? 1 : 0) : (patch.important ? 1 : 0), JSON.stringify(profile), new Date().toISOString(), member.name); }
  const socialGoal = String(patch.socialGoal ?? patch.social_goal ?? profile['社交目的及策略']?.['社交目的'] ?? profile['社交目标'] ?? profile.socialGoal ?? (replaceProfile ? '' : member.socialGoal) ?? '').trim();
  const currentProfile = db.prepare('SELECT * FROM contact_profile WHERE member_id=?').get(member.id);
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO contact_profile(contact_key,member_id,display_name,notes,relationship,social_goal,tone,boundaries,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(contact_key) DO UPDATE SET display_name=excluded.display_name,social_goal=excluded.social_goal,updated_at=excluded.updated_at`)
    .run(member.name, member.id, patch.remark === undefined ? (currentProfile?.display_name || member.remark || member.name) : String(patch.remark), currentProfile?.notes || '', currentProfile?.relationship || '', socialGoal, currentProfile?.tone || '', currentProfile?.boundaries || '', now);
  return getMember(member.name);
}

function parseMessageTime(value) {
  const text = String(value || '').trim();
  if (!text) return NaN;
  const local = text.match(/^(\d{4})[-年](\d{1,2})[-月](\d{1,2})(?:日)?[ T]+(\d{1,2}):([0-9]{2})(?::([0-9]{2}))?$/);
  if (local) {
    const parsed = new Date(Number(local[1]), Number(local[2]) - 1, Number(local[3]), Number(local[4]), Number(local[5]), Number(local[6] || 0)).getTime();
    if (Number.isFinite(parsed)) return parsed;
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : NaN;
}

// 按联系人读取游标之后的新文字消息。cursor 支持旧版时间字符串，
// 扫描成功后返回带 message id 的游标，后续查询只走索引增量读取。
function messagesSince(name, cursor = '', limit = 50) {
  const member = getMember(name);
  if (!member) return null;
  const n = Math.min(Math.max(Number(limit) || 50, 1), 500);
  const rawCursor = cursor && typeof cursor === 'object' ? cursor : { ts: String(cursor || '') };
  const cursorId = Number(rawCursor.id) || 0;
  const cursorTs = String(rawCursor.ts || rawCursor.timestamp || '').trim();
  let rows;
  if (cursorId > 0) {
    rows = db.prepare(`SELECT id,sender,sender AS name,ts,type,content FROM message WHERE member_id=? AND id>? AND type='text' AND TRIM(content)<>'' ORDER BY id ASC LIMIT ?`).all(member.id, cursorId, n);
  } else {
    const all = db.prepare(`SELECT id,sender,sender AS name,ts,type,content FROM message WHERE member_id=? AND type='text' AND TRIM(content)<>'' ORDER BY id ASC`).all(member.id);
    const sinceMs = parseMessageTime(cursorTs);
    rows = all.filter((row) => {
      if (!cursorTs) return true;
      const rowMs = parseMessageTime(row.ts);
      if (Number.isFinite(rowMs) && Number.isFinite(sinceMs)) return rowMs > sinceMs;
      return String(row.ts || '') > cursorTs;
    }).slice(0, n);
  }
  const result = rows.map((row) => ({
    id: Number(row.id), name: row.name || row.sender || '', sender: row.sender || row.name || '',
    ts: row.ts || '', timestamp: row.ts || '', type: row.type || 'text', content: row.content || ''
  }));
  const last = result[result.length - 1] || null;
  return { contact: member.name, messages: result, cursor: last ? { id: last.id, ts: last.ts } : (cursor && typeof cursor === 'object' ? cursor : { ts: cursorTs }) };
}

function normalizeEmailAddress(value) { return String(value || '').trim().toLowerCase(); }
function listMemberEmails(name) {
  const member = getMember(name); if (!member) return null;
  return db.prepare('SELECT normalized_address AS address,source,verified,created_at AS createdAt,updated_at AS updatedAt FROM member_email WHERE member_id=? ORDER BY normalized_address').all(member.id).map((row) => ({ ...row, verified: !!row.verified }));
}
function findMembersByEmail(address) {
  const normalized = normalizeEmailAddress(address); if (!normalized) return [];
  return db.prepare('SELECT member.name,member.remark,member_email.normalized_address AS address,member_email.source,member_email.verified FROM member_email JOIN member ON member.id=member_email.member_id WHERE member_email.normalized_address=? ORDER BY member.name').all(normalized).map((row) => ({ ...row, verified: !!row.verified }));
}
function linkMemberEmail(name, address, { source = 'manual', verified = false } = {}) {
  const member = getMember(name); const normalized = normalizeEmailAddress(address);
  if (!member || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized)) return null;
  const stamp = new Date().toISOString();
  db.prepare('INSERT INTO member_email(member_id,normalized_address,source,verified,created_at,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(member_id,normalized_address) DO UPDATE SET source=excluded.source,verified=excluded.verified,updated_at=excluded.updated_at').run(member.id, normalized, String(source), verified ? 1 : 0, stamp, stamp);
  return { address: normalized, source: String(source), verified: !!verified, member: member.name };
}
function unlinkMemberEmail(name, address) {
  const member = getMember(name); if (!member) return false;
  const result = db.prepare('DELETE FROM member_email WHERE member_id=? AND normalized_address=?').run(member.id, normalizeEmailAddress(address));
  return Number(result.changes || 0) > 0;
}
function deleteMember(name) { const member = getMember(name); if (!member) return false; const result = db.prepare('DELETE FROM member WHERE id=?').run(member.id); archive.remove(member.name); return Number(result.changes || 0) > 0; }
function clearMemberMessages(name) {
  const member = getMember(name);
  if (!member) return 0;
  const result = db.prepare('DELETE FROM message WHERE member_id=?').run(member.id);
  memoryState.clear(db, member.id);
  archive.remove(member.name);
  return Number(result.changes || 0);
}
function ingestMessages(name, items = []) {
  const contact = String(name || '').trim() || 'inbox'; const now = new Date().toISOString();
  db.prepare('INSERT OR IGNORE INTO member(platform_id,name,created_at,updated_at) VALUES(?,?,?,?)').run(contact, contact, now, now);
  const member = db.prepare('SELECT id FROM member WHERE platform_id=?').get(contact);
  const insert = db.prepare('INSERT OR IGNORE INTO message(member_id,sender,ts,type,content,content_hash) VALUES(?,?,?,?,?,?)');
  let added = 0;
  const cold = archive.duplicateReader(contact);
  db.exec('BEGIN');
  try {
    for (const item of (Array.isArray(items) ? items : [])) {
      const message = { name: String(item.name || item.sender || ''), ts: String(item.ts || item.timestamp || now), type: String(item.type || 'text'), content: String(item.content || '') };
      if (cold.has(message)) continue;
      const result = insert.run(member.id, message.name, message.ts, message.type, message.content, hashMessage(contact, message));
      added += Number(result.changes || 0);
    }
    if (added) db.prepare('INSERT INTO conversation(member_id,platform,last_message_at) VALUES(?,?,?) ON CONFLICT(member_id) DO UPDATE SET last_message_at=excluded.last_message_at').run(member.id, 'weixin', now);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  finally { cold.close(); }
  return added;
}
function updateMessageContent(p) {
  const r = db.prepare('UPDATE message SET content=? WHERE sender=? AND ts=? AND type=? AND content=?').run(String(p.content || ''), String(p.name || ''), String(p.ts || ''), String(p.type || ''), '');
  return Number(r.changes || 0) > 0;
}

function searchMessages(query, { contact = '', limit = 50 } = {}) {
  const q = String(query || '').trim();
  if (!q) return [];
  const n = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const cutoff = new Date(Date.now() - archive.RETENTION_DAYS * 86400000).toISOString();
  try {
    const indexed = db.prepare(`SELECT member.name AS contact, message.sender AS name, message.ts, message.type, message.content
      FROM message_fts JOIN message ON message.id=message_fts.rowid JOIN member ON member.id=message.member_id
      WHERE message_fts MATCH ? AND message.ts>=? AND (?='' OR member.name=? OR member.remark=?) ORDER BY message.id DESC LIMIT ?`)
      .all('"' + q.replace(/"/g, '""') + '"', cutoff, contact, contact, contact, n);
    if (indexed.length) return indexed.reverse();
  } catch {}
  return db.prepare(`SELECT member.name AS contact, message.sender AS name, message.ts, message.type, message.content
    FROM message JOIN member ON member.id=message.member_id
    WHERE message.content LIKE ? AND message.ts>=? AND (?='' OR member.name=? OR member.remark=?)
    ORDER BY message.id DESC LIMIT ?`).all('%' + q + '%', cutoff, String(contact || ''), String(contact || ''), String(contact || ''), n).reverse();
}

function contactContext(name, { limit = 20, hotOnly = false } = {}) {
  const member = getMember(name);
  if (!member) return null;
  const result = messages(member.name, '', limit, hotOnly);
  return { contact: member.name, remark: member.remark || '', important: !!member.important, socialGoal: member.socialGoal || '', profile: member.profile || {}, profileSkipped: member.profileSkipped || [], chatSummary: member.chatSummary || {}, recentMessages: result ? result.messages : [] };
}

module.exports = { db, syncLegacy, listMembers, getMember, findUnannotatedMember, messages, archiveMessages, allMessages, historyPages, archiveExpired, messagesSince, searchMessages, contactContext, updateMember, deleteMember, clearMemberMessages, ingestMessages, updateMessageContent, normalizeEmailAddress, listMemberEmails, findMembersByEmail, linkMemberEmail, unlinkMemberEmail };
