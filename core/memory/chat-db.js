'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const { getPaths } = require('../lib/paths');
const archive = require('./archive');
const { speakerResolver, speakerLabel } = require('../lib/speaker');
const attachmentStore = require('./attachment-store');
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
const messageColumns = new Set(db.prepare('PRAGMA table_info(message)').all().map(column => column.name));
if (!messageColumns.has('source')) db.exec("ALTER TABLE message ADD COLUMN source TEXT NOT NULL DEFAULT ''");
if (!messageColumns.has('is_owner')) db.exec('ALTER TABLE message ADD COLUMN is_owner INTEGER');
archive.ensureMessageTime(db);
db.exec('CREATE INDEX IF NOT EXISTS idx_message_member_time ON message(member_id, ts_ms, id)');
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
// 聊天里的真实附件（图片/视频/文件）。
// 字节不进库：落在 <数据目录>/media/chat/ 下（按 sha256 命名），这里只存相对路径。
// description 是首次导入时生成的描述，agent 回读直接用，不必再识图/解文件。
// 不建外键：删消息的地方统一走 pruneAttachments()，避免依赖 foreign_keys pragma。
function createAttachmentTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS message_attachment (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id INTEGER NOT NULL,
      kind TEXT NOT NULL DEFAULT 'image',
      name TEXT NOT NULL DEFAULT '',
      mime_type TEXT NOT NULL DEFAULT '',
      size INTEGER NOT NULL DEFAULT 0,
      sha256 TEXT NOT NULL,
      path TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      description_source TEXT NOT NULL DEFAULT '',
      description_model TEXT NOT NULL DEFAULT '',
      description_error TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'clipboard',
      created_at TEXT NOT NULL,
      UNIQUE(message_id, sha256)
    );
    CREATE INDEX IF NOT EXISTS idx_message_attachment_message ON message_attachment(message_id);
  `);
}

// 早期版本把字节直接存 BLOB。这里把旧行搬到 media/chat/ 并重建表，
// 数据不丢、调用方也不需要知道曾经有过 BLOB 版本。
function migrateAttachmentStorage() {
  const columns = db.prepare('PRAGMA table_info(message_attachment)').all().map((column) => column.name);
  if (!columns.length) { createAttachmentTable(); return; }
  if (!columns.includes('path')) {
    db.exec('ALTER TABLE message_attachment RENAME TO message_attachment_legacy');
    createAttachmentTable();
    const rows = db.prepare('SELECT * FROM message_attachment_legacy').all();
    const insert = db.prepare(`INSERT OR IGNORE INTO message_attachment(message_id,kind,name,mime_type,size,sha256,path,source,created_at)
      VALUES(?,?,?,?,?,?,?,?,?)`);
    for (const row of rows) {
      let rel = '';
      try {
        rel = attachmentStore.save(Buffer.from(row.bytes || []), { sha256: row.sha256, name: row.name, mimeType: row.mime_type });
      } catch {}
      insert.run(row.message_id, row.kind, row.name, row.mime_type, row.size, row.sha256, rel, row.source || 'clipboard', row.created_at);
    }
    db.exec('DROP TABLE message_attachment_legacy');
    createAttachmentTable();
    return;
  }
  createAttachmentTable();
  for (const column of ['description', 'description_source', 'description_model', 'description_error', 'path']) {
    try { db.exec(`ALTER TABLE message_attachment ADD COLUMN ${column} TEXT NOT NULL DEFAULT ''`); } catch {}
  }
}

migrateAttachmentStorage();
try { db.exec('ALTER TABLE message ADD COLUMN conversation_id INTEGER REFERENCES conversation(id)'); } catch {}
try { db.exec("ALTER TABLE member ADD COLUMN profile_meta_json TEXT NOT NULL DEFAULT '{}'"); } catch {}
// 群聊是独立实体，不再和联系人混在同一个桶里（早期把群消息塞进 'inbox' 那个 key）。
// kind = 'contact' 一对一联系人 / 'group' 群聊；老库里的行默认都是 contact。
// 群里的发言人仍然是 contact：一人一行，私聊和多个群共用同一个联系人，
// 用 member_group_link 挂在群下面——这样「他在群里怎么说」和「他对你怎么说」不会互相污染。
try { db.exec("ALTER TABLE member ADD COLUMN kind TEXT NOT NULL DEFAULT 'contact'"); } catch {}
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_member_kind ON member(kind);
  CREATE TABLE IF NOT EXISTS member_group_link (
    group_id INTEGER NOT NULL REFERENCES member(id) ON DELETE CASCADE,
    member_id INTEGER NOT NULL REFERENCES member(id) ON DELETE CASCADE,
    display_name TEXT NOT NULL DEFAULT '',
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    PRIMARY KEY (group_id, member_id)
  );
  CREATE INDEX IF NOT EXISTS idx_mgl_member ON member_group_link(member_id);
`);
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
  const insertMessage = db.prepare('INSERT OR IGNORE INTO message(member_id,sender,ts,type,content,content_hash,ts_ms) VALUES(?,?,?,?,?,?,?)');
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
    for (const m of (Array.isArray(doc.messages) ? doc.messages : [])) {
      const ts = String(m.ts || '');
      insertMessage.run(member.id, String(m.name || ''), ts, String(m.type || 'text'), String(m.content || ''), hashMessage(name, m), archive.messageTime(ts));
    }
  } db.exec('COMMIT');
  for (const file of files) { try { fs.unlinkSync(path.join(contactsDir, file)); } catch {} }
  db.prepare("INSERT OR REPLACE INTO meta(name,value) VALUES('legacy_json_migrated',?)").run(now);
  syncStamp = 'done'; } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
}

function listMembers(query = '') {
  syncLegacy();
  const q = String(query || '').trim();
  return db.prepare(`SELECT member.id,member.platform_id AS platformId,member.name,member.remark,member.important,member.kind,COALESCE(cp.social_goal,'') AS socialGoal,member.profile_json AS profileJson,member.profile_meta_json AS profileMetaJson,(SELECT COUNT(*) FROM message x WHERE x.member_id=member.id) AS messages,(SELECT MAX(ts) FROM message x WHERE x.member_id=member.id) AS updatedAt,(SELECT MAX(x.id) FROM message x WHERE x.member_id=member.id) AS lastMessageId FROM member LEFT JOIN contact_profile cp ON cp.member_id=member.id WHERE ?='' OR member.name LIKE ? OR member.remark LIKE ? ORDER BY important DESC, lastMessageId DESC, member.name COLLATE NOCASE`).all(q, `%${q}%`, `%${q}%`).map((member) => ({ ...member, kind: member.kind || 'contact', important: !!member.important, socialGoal: member.socialGoal || '', profile: JSON.parse(member.profileJson || '{}'), profileMeta: JSON.parse(member.profileMetaJson || '{}'), messages: Number(member.messages || 0), lastMessageId: Number(member.lastMessageId || 0) }));
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
function publicAttachmentRecord(row) {
  return {
    id: Number(row.id),
    kind: row.kind || 'file',
    name: row.name || '',
    mimeType: row.mimeType || '',
    size: Number(row.size) || 0,
    status: 'ready',
    description: row.description || '',
    descriptionSource: row.descriptionSource || '',
    ...(row.descriptionError ? { descriptionError: row.descriptionError } : {}),
    url: `/api/contacts/attachment/${row.id}`,
    downloadUrl: `/api/contacts/attachment/${row.id}?download=1`
  };
}

// 一批消息的附件元数据（不含字节）。按 message_id 归组，页面渲染直接取用。
function attachmentsFor(messageIds) {
  const ids = [...new Set((messageIds || []).map(Number).filter((id) => Number.isInteger(id) && id > 0))];
  const map = new Map();
  if (!ids.length) return map;
  const rows = db.prepare(`SELECT id,message_id AS messageId,kind,name,mime_type AS mimeType,size,
    description,description_source AS descriptionSource,description_error AS descriptionError,created_at AS createdAt
    FROM message_attachment WHERE message_id IN (${ids.map(() => '?').join(',')}) ORDER BY id`).all(...ids);
  for (const row of rows) {
    const list = map.get(row.messageId) || [];
    list.push(publicAttachmentRecord(row));
    map.set(row.messageId, list);
  }
  return map;
}

function getAttachment(id) {
  const row = db.prepare(`SELECT id,message_id AS messageId,kind,name,mime_type AS mimeType,size,sha256,path,
    description,description_source AS descriptionSource,created_at AS createdAt
    FROM message_attachment WHERE id=?`).get(Number(id) || 0);
  if (!row) return null;
  const bytes = attachmentStore.read(row.path);
  return { ...row, size: Number(row.size) || (bytes ? bytes.length : 0), bytes };
}

// 消息被删/被归档后，把失去归属的附件一并清掉：先删库里的行，
// 再删磁盘上已经没人引用的文件（同一份内容被别的消息引用时保留）。
function pruneAttachments() {
  const candidates = db.prepare(`SELECT DISTINCT path FROM message_attachment
    WHERE message_id NOT IN (SELECT id FROM message) AND path<>''`).all();
  const result = db.prepare('DELETE FROM message_attachment WHERE message_id NOT IN (SELECT id FROM message)').run();
  for (const row of candidates) {
    const stillUsed = db.prepare('SELECT 1 FROM message_attachment WHERE path=? LIMIT 1').get(row.path);
    if (!stillUsed) attachmentStore.remove(row.path);
  }
  return Number(result.changes || 0);
}

// 这段聊天里是否已经有同一份附件（按 sha256）：重复复制时不必重新落盘/重新识图
function attachmentExists(contact, sha256) {
  const key = String(contact || '').trim();
  const hash = String(sha256 || '').trim();
  if (!key || !hash) return false;
  const member = db.prepare('SELECT id FROM member WHERE platform_id=?').get(key);
  if (!member) return false;
  const row = db.prepare(`SELECT 1 FROM message_attachment WHERE sha256=?
    AND message_id IN (SELECT id FROM message WHERE member_id=?) LIMIT 1`).get(hash, member.id);
  return !!row;
}

// 同一张图在别处已经描述过就直接复用（转发图片、群聊里同一张图很常见）
function descriptionForSha(sha256) {
  const hash = String(sha256 || '').trim();
  if (!hash) return null;
  const row = db.prepare(`SELECT description, description_source AS descriptionSource, description_model AS descriptionModel
    FROM message_attachment WHERE sha256=? AND description<>'' ORDER BY id LIMIT 1`).get(hash);
  return row || null;
}

function messages(name, query = '', limit = 200, hotOnly = false, before = '', beforeId = 0, config) {
  syncLegacy(); const member = getMember(name); if (!member) return null;
  const q = String(query || '').trim(); const n = Math.min(Math.max(Number(limit) || 200, 1), 500);
  const resolve = resolveMemberSpeaker(member, config);
  const canonical = member.name;
  const cutoff = Date.now() - archive.RETENTION_DAYS * 86400000;
  const cursorId = Number(beforeId) || 0;
  const cursorTime = before || cursorId ? archive.messageTime(before) : Number.MAX_SAFE_INTEGER;
  const rows = db.prepare(`SELECT id, sender, sender AS senderName, ts, ts AS timestamp, type, content, source, is_owner
    FROM message WHERE member_id=? AND ts_ms>=? AND (?='' OR content LIKE ?) AND (ts_ms, id) < (?, ?)
    ORDER BY ts_ms DESC, id DESC LIMIT ?`).all(member.id, hotOnly ? cutoff : Number.MIN_SAFE_INTEGER, q, `%${q}%`, cursorTime, cursorId, n + 1);
  const hasMore = rows.length > n;
  if (hasMore) rows.pop();
  const attachments = attachmentsFor(rows.map((row) => row.id));
  return { contact: canonical, total: rows.length, messages: rows.reverse().map((row) => {
    const files = attachments.get(row.id);
    return { ...messageIdentity(row, resolve), name: row.sender, ...(files ? { attachments: files } : {}) };
  }), hasMore, hasArchive: archive.exists(canonical) || !!db.prepare('SELECT 1 FROM message WHERE member_id=? AND ts_ms<? LIMIT 1').get(member.id, cutoff) };
}

function resolveMemberSpeaker(member, config = require('../lib/config').loadConfig()) {
  const aliases = db.prepare('SELECT name FROM member_name_history WHERE member_id=?').all(member.id);
  return speakerResolver(config.selfNicknames || [], [member.name, member.remark, member.platformId, ...aliases.map(row => row.name)]);
}

function messageIdentity({ is_owner, source, ...message }, resolve) {
  const isOwner = resolve({ is_owner, sender: message.sender || message.name });
  return { ...message, ...(source ? { source } : {}), isOwner, speakerRole: speakerLabel(isOwner) };
}

function archiveMessages(name, before = '', limit = 100, beforeId = 0) {
  const member = getMember(name);
  if (!member) return null;
  archiveExpired(member.name);
  const resolve = resolveMemberSpeaker(member);
  return { contact: member.name, messages: archive.list(member.name, { before, beforeId, limit }).map(message => messageIdentity(message, resolve)) };
}
function* historyPages(name, limit = 300) {
  const member = getMember(name);
  if (!member) return;
  const resolve = resolveMemberSpeaker(member);
  for (const rows of archive.pages(member.name, limit)) yield rows.map(row => messageIdentity(row, resolve));
  let cursor = 0;
  let timestamp = Number.MIN_SAFE_INTEGER;
  const maximum = db.prepare('SELECT MAX(id) AS id FROM message WHERE member_id=?').get(member.id).id || 0;
  while (true) {
    const rows = db.prepare(`SELECT *,sender AS name FROM message WHERE member_id=? AND id<=? AND (ts_ms, id) > (?, ?)
      ORDER BY ts_ms, id LIMIT ?`).all(member.id, maximum, timestamp, cursor, limit);
    if (!rows.length) break;
    cursor = rows[rows.length - 1].id;
    timestamp = rows[rows.length - 1].ts_ms;
    yield rows.map(({ ts_ms, ...row }) => messageIdentity(row, resolve));
  }
}
function allMessages(name) {
  const member = getMember(name);
  if (!member) return null;
  const rows = [...historyPages(member.name)].flat().sort((left, right) => archive.messageTime(left.ts) - archive.messageTime(right.ts) || left.id - right.id);
  const attachments = attachmentsFor(rows.map((row) => row.id));
  return {
    contact: member.name,
    total: rows.length,
    messages: rows.map((row) => {
      const files = attachments.get(row.id);
      return files ? { ...row, attachments: files } : row;
    })
  };
}
function archiveExpired(contact = '') {
  const cutoff = Date.now() - archive.RETENTION_DAYS * 86400000;
  const members = contact ? [getMember(contact)].filter(Boolean) : listMembers('');
  for (const member of members) {
    while (true) {
      const rows = db.prepare('SELECT id,sender,ts,type,content,content_hash,source,is_owner,ts_ms FROM message WHERE member_id=? AND ts_ms<? ORDER BY ts_ms,id LIMIT 500').all(member.id, cutoff);
      if (!rows.length) break;
      archive.append(member.name, rows.map((message) => ({ ...message, name: message.sender })));
      db.exec('BEGIN');
      try {
        for (const row of rows) db.prepare('DELETE FROM message WHERE id=?').run(row.id);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    }
  }
  pruneAttachments();
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
    rows = db.prepare(`SELECT id,sender,sender AS name,ts,type,content,is_owner,source FROM message WHERE member_id=? AND id>? AND type='text' AND TRIM(content)<>'' ORDER BY id ASC LIMIT ?`).all(member.id, cursorId, n);
  } else {
    const all = db.prepare(`SELECT id,sender,sender AS name,ts,type,content,is_owner,source FROM message WHERE member_id=? AND type='text' AND TRIM(content)<>'' ORDER BY id ASC`).all(member.id);
    const sinceMs = parseMessageTime(cursorTs);
    rows = all.filter((row) => {
      if (!cursorTs) return true;
      const rowMs = parseMessageTime(row.ts);
      if (Number.isFinite(rowMs) && Number.isFinite(sinceMs)) return rowMs > sinceMs;
      return String(row.ts || '') > cursorTs;
    }).slice(0, n);
  }
  const resolve = resolveMemberSpeaker(member);
  const result = rows.map(row => ({ ...messageIdentity(row, resolve), timestamp: row.ts }));
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
function deleteMember(name) { const member = getMember(name); if (!member) return false; const result = db.prepare('DELETE FROM member WHERE id=?').run(member.id); pruneAttachments(); archive.remove(member.name); return Number(result.changes || 0) > 0; }
function clearMemberMessages(name) {
  const member = getMember(name);
  if (!member) return 0;
  const result = db.prepare('DELETE FROM message WHERE member_id=?').run(member.id);
  pruneAttachments();
  memoryState.clear(db, member.id);
  archive.remove(member.name);
  return Number(result.changes || 0);
}
function ingestMessages(name, items = [], { kind = 'contact', remark = '' } = {}) {
  const contact = String(name || '').trim() || 'inbox';
  const memberKind = kind === 'group' ? 'group' : 'contact';
  const label = String(remark || '').trim();
  const now = new Date().toISOString();
  db.prepare('INSERT OR IGNORE INTO member(platform_id,name,kind,created_at,updated_at) VALUES(?,?,?,?,?)').run(contact, contact, memberKind, now, now);
  if (memberKind === 'group') db.prepare("UPDATE member SET kind='group',updated_at=? WHERE platform_id=?").run(now, contact);
  // 群里见过的人后来直接和你聊了（或用户手动加了），升级成联系人
  if (memberKind === 'contact') db.prepare("UPDATE member SET kind='contact',updated_at=? WHERE platform_id=? AND kind='member'").run(now, contact);
  const member = db.prepare('SELECT id FROM member WHERE platform_id=?').get(contact);
  // 截图读到的是微信里显示的名字（设了备注就是备注）。只在备注为空时写入，
  // 免得每次复制都把用户手改过的备注覆盖回去。
  if (member && label) {
    db.prepare("UPDATE member SET remark=?,updated_at=? WHERE id=? AND TRIM(COALESCE(remark,''))=''").run(label, now, member.id);
  }
  const insert = db.prepare('INSERT OR IGNORE INTO message(member_id,sender,ts,type,content,content_hash,source,is_owner,platform_message_id,ts_ms) VALUES(?,?,?,?,?,?,?,?,?,?)');
  const findMessage = db.prepare('SELECT id, is_owner FROM message WHERE content_hash=?');
  const confirmOwner = db.prepare('UPDATE message SET is_owner=? WHERE content_hash=? AND is_owner IS NULL');
  const insertAttachment = db.prepare(`INSERT OR IGNORE INTO message_attachment(message_id,kind,name,mime_type,size,sha256,path,description,description_source,description_model,description_error,source,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  let added = 0;
  const cold = archive.duplicateReader(contact);
  db.exec('BEGIN');
  try {
    for (const item of (Array.isArray(items) ? items : [])) {
      const message = { name: String(item.name || item.sender || ''), ts: String(item.ts || item.timestamp || now), type: String(item.type || 'text'), content: String(item.content || '') };
      const externalId = item.source === 'aiworks' ? item.externalId : undefined;
      let hash = externalId
        ? crypto.createHash('sha256').update(JSON.stringify(['aiworks', member.id, externalId])).digest('hex')
        : hashMessage(contact, message);
      const owner = typeof item.isOwner === 'boolean' ? Number(item.isOwner) : null;
      if (owner != null && !externalId) {
        const previous = findMessage.get(hash) || cold.byHash(hash);
        // 同名双方在同一秒发送相同文本时，分别保留两人的原话。
        if (previous?.is_owner != null && previous.is_owner !== owner) hash += ':owner:' + owner;
        const archived = cold.byHash(hash);
        if (archived) {
          if (archived.is_owner == null) cold.confirm(hash, owner);
          continue;
        }
      } else if (cold.has(message, externalId ? hash : '')) continue;
      const result = insert.run(member.id, message.name, message.ts, message.type, message.content, hash,
        externalId ? 'aiworks' : '', owner, externalId || null, archive.messageTime(message.ts));
      if (!result.changes && owner != null) confirmOwner.run(owner, hash);
      added += Number(result.changes || 0);
      const files = Array.isArray(item.attachments) ? item.attachments : [];
      if (!files.length) continue;
      // 消息可能本来就存在（重复导入）：照样把附件补上，unique(message_id,sha256) 负责去重
      const row = findMessage.get(hash);
      if (!row) continue;
      for (const file of files) {
        if (!file || !file.sha256) continue;
        // 兼容只有字节、还没落盘的调用方（例如测试或旧管线）：先落盘再入库
        let relative = String(file.path || '');
        if (!relative && file.bytes) {
          try {
            relative = attachmentStore.save(Buffer.from(file.bytes), { sha256: file.sha256, name: file.name, mimeType: file.mimeType });
          } catch { relative = ''; }
        }
        insertAttachment.run(row.id, String(file.kind || 'file'), String(file.name || ''), String(file.mimeType || ''),
          Number(file.size) || (file.bytes ? file.bytes.length : 0), String(file.sha256), relative,
          String(file.description || ''), String(file.descriptionSource || ''), String(file.descriptionModel || ''),
          String(file.descriptionError || ''), String(file.source || 'clipboard'), now);
      }
    }
    if (added) db.prepare('INSERT INTO conversation(member_id,platform,last_message_at) VALUES(?,?,?) ON CONFLICT(member_id) DO UPDATE SET last_message_at=excluded.last_message_at').run(member.id, 'weixin', now);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  finally { cold.close(); }
  // 注意：romance 分支在这里会自动建立关系档案（require('./stores/romance-relationships')）。
  // main 不引入 romance 关系存储，这一段刻意不移植——入库只负责消息本身。
  return added;
}
function updateMessageContent(p) {
  const r = db.prepare('UPDATE message SET content=? WHERE sender=? AND ts=? AND type=? AND content=?').run(String(p.content || ''), String(p.name || ''), String(p.ts || ''), String(p.type || ''), '');
  return Number(r.changes || 0) > 0;
}

function searchMessages(query, { contact = '', limit = 50, config = require('../lib/config').loadConfig() } = {}) {
  const q = String(query || '').trim();
  if (!q) return [];
  const n = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const cutoff = Date.now() - archive.RETENTION_DAYS * 86400000;
  const resolvers = new Map();
  function identify({ memberId, platformId, remark, ...row }) {
    if (!resolvers.has(memberId)) {
      resolvers.set(memberId, resolveMemberSpeaker({ id: memberId, name: row.contact, platformId, remark }, config));
    }
    return messageIdentity(row, resolvers.get(memberId));
  }
  const fields = 'member.id AS memberId, member.platform_id AS platformId, member.remark, member.name AS contact, message.sender AS name, message.is_owner, message.source, message.ts, message.type, message.content';
  try {
    const indexed = db.prepare(`SELECT ${fields}
      FROM message_fts JOIN message ON message.id=message_fts.rowid JOIN member ON member.id=message.member_id
      WHERE message_fts MATCH ? AND message.ts_ms>=? AND (?='' OR member.name=? OR member.remark=?) ORDER BY message.id DESC LIMIT ?`)
      .all('"' + q.replace(/"/g, '""') + '"', cutoff, contact, contact, contact, n);
    if (indexed.length) return indexed.reverse().map(identify);
  } catch {}
  return db.prepare(`SELECT ${fields}
    FROM message JOIN member ON member.id=message.member_id
    WHERE message.content LIKE ? AND message.ts_ms>=? AND (?='' OR member.name=? OR member.remark=?)
    ORDER BY message.id DESC LIMIT ?`).all('%' + q + '%', cutoff, String(contact || ''), String(contact || ''), String(contact || ''), n).reverse().map(identify);
}

function contactContext(name, { limit = 20, hotOnly = false, config } = {}) {
  const member = getMember(name);
  if (!member) return null;
  const result = messages(member.name, '', limit, hotOnly, '', 0, config);
  const liveCoverage = db.prepare('SELECT COUNT(*) AS total, MIN(ts) AS fromTs, MAX(ts) AS toTs FROM message WHERE member_id=?').get(member.id);
  const archivedCoverage = archive.stats(member.name);
  const recentMessages = result ? result.messages : [];
  const coverageFrom = [liveCoverage?.fromTs, archivedCoverage.fromTs].filter(Boolean).sort()[0] || '';
  const coverageTo = [liveCoverage?.toTs, archivedCoverage.toTs].filter(Boolean).sort().at(-1) || '';
  return {
    contact: member.name,
    remark: member.remark || '',
    important: !!member.important,
    socialGoal: member.socialGoal || '',
    profile: member.profile || {},
    profileSkipped: member.profileSkipped || [],
    chatSummary: member.chatSummary || {},
    recentMessages,
    messageCoverage: {
      previewLimit: Number(limit) || 20,
      previewCount: recentMessages.length,
      liveCount: Number(liveCoverage?.total || 0),
      archivedCount: archivedCoverage.total,
      totalCount: Number(liveCoverage?.total || 0) + archivedCoverage.total,
      from: coverageFrom,
      to: coverageTo,
      previewIsPartial: recentMessages.length < Number(liveCoverage?.total || 0) + archivedCoverage.total
    }
  };
}

// ── 群聊 ────────────────────────────────────────────────────────────────
// 群不是人：它有自己的 member 行（kind='group'），消息挂在群上。
// 群里的发言人另存成 kind='contact' 的联系人，用 member_group_link 挂到群。
// 一人一行：同一个人在私聊和若干个群里都是同一个联系人，但消息不属于任何一个联系人，
// 所以「他在群里对别人怎么说」可以作为独立证据被画像引用，而不是混进「他对你怎么说」。

// 按成员重合找到已经存在的群：同一批人换了个显示名又复制回来时，别裂成两个群。
function findGroupByMembers(members = [], minimum = 2) {
  const names = [...new Set((Array.isArray(members) ? members : []).map((n) => String(n || '').trim()).filter(Boolean))];
  if (names.length < minimum) return null;
  const rows = db.prepare(`SELECT group_member.id,group_member.name,COUNT(*) AS hits
    FROM member_group_link link
    JOIN member group_member ON group_member.id=link.group_id
    JOIN member speaker ON speaker.id=link.member_id
    WHERE group_member.kind='group' AND speaker.name IN (${names.map(() => '?').join(',')})
    GROUP BY group_member.id ORDER BY hits DESC LIMIT 1`).get(...names);
  if (!rows || Number(rows.hits) < minimum) return null;
  return { id: Number(rows.id), name: rows.name };
}

// 群身份的兜底前缀：只有当群的名字和某个联系人重名时才用得上。
// 例：一个群只有张三说过话 -> 身份名就是「张三」，和联系人张三撞了。
// 这种情况下不能把联系人改成群，改用一个带前缀的独立身份。
const GROUP_KEY_PREFIX = '群:';

// 建/取群实体。identity 是 platform_id（默认按发言人拼出来的名字）；
// remark 是截图读到的真实群名——它只做显示，不参与身份判定，但可以用来归并：
// 同一个群名复制两次，就算发言人组合变了也认得回来。
function ensureGroup(identity, { members = [], displayName = '', remark = '' } = {}) {
  const base = String(identity || '').trim();
  const label = String(remark || displayName || '').trim();
  if (!base) return null;
  const now = new Date().toISOString();

  const lookup = (value) => db.prepare('SELECT id,name,kind FROM member WHERE platform_id=?').get(value);
  const hit = lookup(base);
  // 同名的联系人优先：绝不能让一个群把联系人行接管成 kind='group'
  const key = hit && hit.kind !== 'group' ? GROUP_KEY_PREFIX + base : base;
  const exact = key === base ? hit : lookup(key);

  if (exact) {
    db.prepare("UPDATE member SET kind='group',updated_at=? WHERE id=?").run(now, exact.id);
    if (label) db.prepare("UPDATE member SET remark=? WHERE id=? AND TRIM(COALESCE(remark,''))=''").run(label, exact.id);
    return { id: Number(exact.id), name: exact.name };
  }
  // 真实群名是更可靠的归并键：发言人换了、拼出来的名字变了，同一个群仍然认得回来
  if (label) {
    const byRemark = db.prepare("SELECT id,name FROM member WHERE kind='group' AND remark=?").get(label);
    if (byRemark) return { id: Number(byRemark.id), name: byRemark.name };
  }
  const merged = findGroupByMembers(members);
  if (merged) return merged;
  // 群的 name 必须恒等于 platform_id：后续入库、成员挂靠、路由都拿 name 当 key 用。
  // 给人看的名字放 remark（截图读到的真群名）。
  db.prepare("INSERT OR IGNORE INTO member(platform_id,name,kind,remark,created_at,updated_at) VALUES(?,?,'group',?,?,?)")
    .run(key, key, label, now, now);
  const row = db.prepare('SELECT id,name FROM member WHERE platform_id=?').get(key);
  return row ? { id: Number(row.id), name: row.name } : null;
}

// 把本批识别到的发言人挂到群下面。
// 只在两种情况下建 member 行：已经是联系人（不动它的 kind），或者第一次见到——那时建成
// kind='member'，即「群里出现过但还没加为联系人」。它不会出现在联系人列表里，
// 只有用户自己点了「加为联系人」才会升级成 kind='contact'。
function linkGroupMembers(groupName, members = []) {
  const group = ensureGroup(groupName);
  if (!group) return [];
  const now = new Date().toISOString();
  const insertMember = db.prepare("INSERT OR IGNORE INTO member(platform_id,name,kind,created_at,updated_at) VALUES(?,?,'member',?,?)");
  const findMember = db.prepare('SELECT id,name,kind FROM member WHERE platform_id=?');
  const upsertLink = db.prepare(`INSERT INTO member_group_link(group_id,member_id,display_name,first_seen,last_seen)
    VALUES(?,?,?,?,?) ON CONFLICT(group_id,member_id) DO UPDATE SET display_name=excluded.display_name,last_seen=excluded.last_seen`);
  const out = [];
  for (const raw of (Array.isArray(members) ? members : [])) {
    const display = String(raw || '').trim();
    if (!display) continue;
    insertMember.run(display, display, now, now);
    const speaker = findMember.get(display);
    if (!speaker) continue;
    upsertLink.run(group.id, speaker.id, display, now, now);
    out.push({ id: Number(speaker.id), name: speaker.name, displayName: display, kind: speaker.kind });
  }
  return out;
}

// 用户主动把群里的一个人加为联系人。
function promoteContact(name) {
  const key = String(name || '').trim();
  if (!key) return null;
  db.prepare("UPDATE member SET kind='contact',updated_at=? WHERE platform_id=? AND kind='member'").run(new Date().toISOString(), key);
  const row = db.prepare('SELECT id,name,kind,remark FROM member WHERE platform_id=?').get(key);
  return row ? { id: Number(row.id), name: row.name, kind: row.kind, remark: row.remark || '' } : null;
}

function listGroupMembers(groupName) {
  const key = String(groupName || '').trim();
  if (!key) return [];
  return db.prepare(`SELECT speaker.id,speaker.name,speaker.kind,link.display_name AS displayName,link.last_seen AS lastSeen
    FROM member_group_link link
    JOIN member speaker ON speaker.id=link.member_id
    JOIN member group_member ON group_member.id=link.group_id
    WHERE group_member.platform_id=? ORDER BY link.last_seen DESC, speaker.name COLLATE NOCASE`).all(key)
    .map((row) => ({ ...row, id: Number(row.id) }));
}

// 关系页面左侧「群聊」分区的数据：群名、人数、消息量、最近活跃。
function listGroups() {
  return db.prepare(`SELECT m.id,m.name,m.remark,m.important,'group' AS kind,
      (SELECT COUNT(*) FROM message x WHERE x.member_id=m.id) AS messages,
      (SELECT MAX(x.ts) FROM message x WHERE x.member_id=m.id) AS lastMessageAt,
      (SELECT COUNT(*) FROM member_group_link l WHERE l.group_id=m.id) AS memberCount
    FROM member m WHERE m.kind='group'
    ORDER BY lastMessageAt DESC, m.name COLLATE NOCASE`).all()
    .map((row) => ({
      ...row,
      id: Number(row.id),
      important: !!row.important,
      messages: Number(row.messages || 0),
      memberCount: Number(row.memberCount || 0),
      lastMessageAt: row.lastMessageAt || ''
    }));
}

// 某个联系人出现在哪些群里——画像里「他在群里的表现」就是按这个取的。
function listGroupsForMember(name) {
  const member = getMember(name);
  if (!member || member.kind === 'group') return [];
  return db.prepare(`SELECT group_member.id,group_member.name
    FROM member_group_link link
    JOIN member group_member ON group_member.id=link.group_id
    WHERE link.member_id=? ORDER BY group_member.name COLLATE NOCASE`).all(member.id)
    .map((row) => ({ ...row, id: Number(row.id) }));
}

// 他在各个群里说过的话（只取他自己说的），带上群名和紧邻的上一条作为语境。
// 这是画像里唯一的「第三方观察」来源：这些话说给群里其他人听，不是说给用户听。
function groupObservationsForMember(name, { perGroup = 4 } = {}) {
  const member = getMember(name);
  if (!member || member.kind === 'group') return [];
  const limit = Math.max(1, Math.min(Number(perGroup) || 4, 10));
  const select = db.prepare(`SELECT m.id,m.sender,m.ts,m.content,
      (SELECT p.sender FROM message p WHERE p.member_id=m.member_id AND p.id<m.id ORDER BY p.id DESC LIMIT 1) AS previousSender,
      (SELECT p.content FROM message p WHERE p.member_id=m.member_id AND p.id<m.id ORDER BY p.id DESC LIMIT 1) AS previousContent
    FROM message m JOIN member own ON own.id=m.member_id
    WHERE own.platform_id=? AND m.sender=? AND m.type='text' AND TRIM(m.content)<>''
    ORDER BY m.id DESC LIMIT ?`);
  const out = [];
  for (const group of listGroupsForMember(name)) {
    const rows = select.all(group.name, member.name, limit);
    if (!rows.length) continue;
    out.push({
      group: group.name,
      messages: rows.reverse().map((row) => ({
        id: Number(row.id),
        ts: row.ts,
        content: String(row.content || '').slice(0, 400),
        repliedTo: row.previousSender && row.previousSender !== member.name
          ? { sender: String(row.previousSender), content: String(row.previousContent || '').slice(0, 300) }
          : null
      }))
    });
  }
  return out;
}

// 开发期清理：早期所有群消息都被塞进 'inbox' 这个假联系人里，结构上线后它没有意义了。
// 只删这一个 key，不碰真实联系人和群。
function purgeInbox() {
  const row = db.prepare("SELECT id FROM member WHERE platform_id='inbox' OR name='inbox'").get();
  if (!row) return 0;
  const count = Number(db.prepare('SELECT COUNT(*) AS n FROM message WHERE member_id=?').get(row.id)?.n || 0);
  db.prepare('DELETE FROM message WHERE member_id=?').run(row.id);
  db.prepare('DELETE FROM conversation WHERE member_id=?').run(row.id);
  db.prepare('DELETE FROM member WHERE id=?').run(row.id);
  pruneAttachments();
  return count;
}

module.exports = { db, resolveMemberSpeaker, syncLegacy, listMembers, getMember, findUnannotatedMember, messages, archiveMessages, allMessages, historyPages, archiveExpired, messagesSince, searchMessages, contactContext, updateMember, deleteMember, clearMemberMessages, ingestMessages, updateMessageContent, getAttachment, attachmentExists, descriptionForSha, pruneAttachments, normalizeEmailAddress, listMemberEmails, findMembersByEmail, linkMemberEmail, unlinkMemberEmail, ensureGroup, findGroupByMembers, linkGroupMembers, promoteContact, listGroupMembers, listGroups, listGroupsForMember, groupObservationsForMember, purgeInbox };
