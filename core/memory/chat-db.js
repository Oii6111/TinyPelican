'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const { getPaths } = require('../lib/paths');

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
try { db.exec('ALTER TABLE message ADD COLUMN conversation_id INTEGER REFERENCES conversation(id)'); } catch {}
try { db.exec('CREATE VIRTUAL TABLE IF NOT EXISTS message_fts USING fts5(content, content="message", content_rowid="id")'); } catch {}

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
  return db.prepare(`SELECT member.id,member.platform_id AS platformId,member.name,member.remark,member.important,COALESCE(cp.social_goal,'') AS socialGoal,member.profile_json AS profileJson,(SELECT COUNT(*) FROM message x WHERE x.member_id=member.id) AS messages,(SELECT MAX(ts) FROM message x WHERE x.member_id=member.id) AS updatedAt,(SELECT MAX(x.id) FROM message x WHERE x.member_id=member.id) AS lastMessageId FROM member LEFT JOIN contact_profile cp ON cp.member_id=member.id WHERE ?='' OR member.name LIKE ? OR member.remark LIKE ? ORDER BY important DESC, lastMessageId DESC, member.name COLLATE NOCASE`).all(q, `%${q}%`, `%${q}%`).map((member) => ({ ...member, important: !!member.important, socialGoal: member.socialGoal || '', profile: JSON.parse(member.profileJson || '{}'), messages: Number(member.messages || 0), lastMessageId: Number(member.lastMessageId || 0) }));
}

function getMember(name) {
  const key = String(name || '').trim();
  if (!key) return null;
  const members = listMembers('');
  const exact = members.find((member) => member.name === key);
  if (exact) return exact;
  const matches = members.filter((member) => member.remark === key);
  matches.sort((leftMember, rightMember) => {
    if (leftMember.lastMessageId !== rightMember.lastMessageId) return rightMember.lastMessageId - leftMember.lastMessageId;
    const leftTime = Date.parse(String(leftMember.updatedAt || '').replace(/ (\d):/, ' 0$1:')) || 0;
    const rightTime = Date.parse(String(rightMember.updatedAt || '').replace(/ (\d):/, ' 0$1:')) || 0;
    return rightTime - leftTime;
  });
  return matches[0] || null;
}
function findUnannotatedMember() {
  return listMembers('').find((member) => !String(member.remark || '').trim() && Number(member.messages || 0) > 0) || null;
}
function messages(name, query = '', limit = 200) {
  syncLegacy(); const member = getMember(name); if (!member) return null;
  const q = String(query || '').trim(); const n = Math.min(Math.max(Number(limit) || 200, 1), 500);
  const config = (() => { try { return JSON.parse(fs.readFileSync(getPaths().config, 'utf8')); } catch { return {}; } })();
  const owners = new Set(config.selfNicknames || []);
  const canonical = member.name;
  const rows = db.prepare(`SELECT message.id, sender, sender AS senderName, ts, ts AS timestamp, type, content FROM message JOIN member ON member.id=message.member_id WHERE member.name=? AND (?='' OR content LIKE ?) ORDER BY message.id DESC LIMIT ?`).all(canonical, q, `%${q}%`, n).map((row) => ({ ...row, isOwner: owners.has(row.sender) }));
  return { contact: canonical, total: Number(db.prepare(`SELECT COUNT(*) AS n FROM message JOIN member ON member.id=message.member_id WHERE member.name=? AND (?='' OR content LIKE ?)`).get(canonical, q, `%${q}%`).n), messages: rows.reverse() };
}
function updateMember(name, patch = {}) {
  const member = getMember(name); if (!member) return null;
  const profile = patch.profile && typeof patch.profile === 'object'
    ? { ...(member.profile || {}), ...patch.profile }
    : (member.profile || {});
  db.prepare('UPDATE member SET remark=?,important=?,profile_json=?,updated_at=? WHERE name=?').run(patch.remark === undefined ? member.remark : String(patch.remark), patch.important === undefined ? (member.important ? 1 : 0) : (patch.important ? 1 : 0), JSON.stringify(profile), new Date().toISOString(), member.name);
  const socialGoal = String(patch.socialGoal ?? patch.social_goal ?? profile['社交目标'] ?? profile.socialGoal ?? member.socialGoal ?? '').trim();
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

function deleteMember(name) { const r = db.prepare('DELETE FROM member WHERE name=?').run(name); return Number(r.changes || 0) > 0; }
function clearMemberMessages(name) { const r = db.prepare('DELETE FROM message WHERE member_id=(SELECT id FROM member WHERE name=?)').run(name); return Number(r.changes || 0); }
function ingestMessages(name, items = []) {
  const contact = String(name || '').trim() || 'inbox'; const now = new Date().toISOString();
  db.prepare('INSERT OR IGNORE INTO member(platform_id,name,created_at,updated_at) VALUES(?,?,?,?)').run(contact, contact, now, now);
  const member = db.prepare('SELECT id FROM member WHERE platform_id=?').get(contact);
  const insert = db.prepare('INSERT OR IGNORE INTO message(member_id,sender,ts,type,content,content_hash) VALUES(?,?,?,?,?,?)');
  let added = 0; db.exec('BEGIN'); try { for (const m of (Array.isArray(items) ? items : [])) { const r = insert.run(member.id, String(m.name || m.sender || ''), String(m.ts || m.timestamp || new Date().toISOString()), String(m.type || 'text'), String(m.content || ''), hashMessage(contact, m)); added += Number(r.changes || 0); } db.prepare('INSERT INTO conversation(member_id,platform,last_message_at) VALUES(?,?,?) ON CONFLICT(member_id) DO UPDATE SET last_message_at=excluded.last_message_at').run(member.id, 'weixin', new Date().toISOString()); db.exec('COMMIT'); } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
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
  return db.prepare(`SELECT member.name AS contact, message.sender AS name, message.ts, message.type, message.content
    FROM message JOIN member ON member.id=message.member_id
    WHERE message.content LIKE ? AND (?='' OR member.name=? OR member.remark=?)
    ORDER BY message.id DESC LIMIT ?`).all('%' + q + '%', String(contact || ''), String(contact || ''), String(contact || ''), n).reverse();
}

function contactContext(name, { limit = 20 } = {}) {
  const member = getMember(name);
  if (!member) return null;
  const result = messages(member.name, '', limit);
  return { contact: member.name, remark: member.remark || '', important: !!member.important, socialGoal: member.socialGoal || '', profile: member.profile || {}, recentMessages: result ? result.messages : [] };
}

module.exports = { db, syncLegacy, listMembers, getMember, findUnannotatedMember, messages, messagesSince, searchMessages, contactContext, updateMember, deleteMember, clearMemberMessages, ingestMessages, updateMessageContent };
