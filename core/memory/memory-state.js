'use strict';

function setup(db) {
  const columns = new Set(db.prepare('PRAGMA table_info(member)').all().map((column) => column.name));
  if (!columns.has('chat_summary_json')) db.exec("ALTER TABLE member ADD COLUMN chat_summary_json TEXT NOT NULL DEFAULT '{}'");
  if (!columns.has('profile_skip_json')) db.exec("ALTER TABLE member ADD COLUMN profile_skip_json TEXT NOT NULL DEFAULT '[]'");
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_state (
      member_id INTEGER PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0,
      profile_revision INTEGER NOT NULL DEFAULT -1, last_profile_at TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS memory_job (
      id TEXT PRIMARY KEY, member_id INTEGER NOT NULL, kind TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', seed INTEGER NOT NULL DEFAULT 0,
      generation INTEGER NOT NULL DEFAULT 1, priority INTEGER NOT NULL DEFAULT 1, manual INTEGER NOT NULL DEFAULT 0,
      attempts INTEGER NOT NULL DEFAULT 0, retry_at TEXT NOT NULL DEFAULT '',
      error TEXT NOT NULL DEFAULT '', payload_json TEXT NOT NULL DEFAULT '{}',
      target_revision INTEGER NOT NULL DEFAULT 0, intent_id TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT '', UNIQUE(member_id, kind)
    );
    CREATE TABLE IF NOT EXISTS memory_queue (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, member_id INTEGER NOT NULL,
      kind TEXT NOT NULL, hash TEXT NOT NULL, sender TEXT NOT NULL, ts TEXT NOT NULL,
      type TEXT NOT NULL, content TEXT NOT NULL, UNIQUE(member_id, kind, hash)
    );
    CREATE INDEX IF NOT EXISTS idx_memory_queue_member ON memory_queue(member_id, kind, seq);
    CREATE TABLE IF NOT EXISTS profile_candidate_outbox (
      id TEXT PRIMARY KEY, member_id INTEGER NOT NULL, payload_json TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0
    );
    CREATE TRIGGER IF NOT EXISTS memory_after_message_insert AFTER INSERT ON message BEGIN
      INSERT INTO memory_state(member_id,revision,last_profile_at) VALUES(NEW.member_id,1,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        ON CONFLICT(member_id) DO UPDATE SET revision=revision+1;
      INSERT OR IGNORE INTO memory_queue(member_id,kind,hash,sender,ts,type,content)
        VALUES(NEW.member_id,'summary',NEW.content_hash,NEW.sender,NEW.ts,NEW.type,NEW.content);
      INSERT INTO memory_job(id,member_id,kind,updated_at) VALUES('summary-'||NEW.member_id,NEW.member_id,'summary',strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        ON CONFLICT(member_id,kind) DO UPDATE SET status=CASE WHEN status='running' THEN status ELSE 'pending' END,
          priority=1,attempts=0,retry_at='',error='',updated_at=excluded.updated_at;
    END;
    CREATE TRIGGER IF NOT EXISTS memory_after_message_fill AFTER UPDATE OF content ON message WHEN NEW.content<>OLD.content BEGIN
      INSERT INTO memory_state(member_id,revision,last_profile_at) VALUES(NEW.member_id,1,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        ON CONFLICT(member_id) DO UPDATE SET revision=revision+1;
      INSERT INTO memory_queue(member_id,kind,hash,sender,ts,type,content)
        VALUES(NEW.member_id,'summary',NEW.content_hash,NEW.sender,NEW.ts,NEW.type,NEW.content)
        ON CONFLICT(member_id,kind,hash) DO UPDATE SET content=excluded.content;
      INSERT INTO memory_job(id,member_id,kind,updated_at) VALUES('summary-'||NEW.member_id,NEW.member_id,'summary',strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        ON CONFLICT(member_id,kind) DO UPDATE SET status=CASE WHEN status='running' THEN status ELSE 'pending' END,retry_at='',attempts=0;
    END;
    CREATE TRIGGER IF NOT EXISTS memory_before_member_delete BEFORE DELETE ON member BEGIN
      DELETE FROM message WHERE member_id=OLD.id;
      DELETE FROM contact_profile WHERE member_id=OLD.id;
      DELETE FROM conversation WHERE member_id=OLD.id;
      DELETE FROM memory_queue WHERE member_id=OLD.id;
      DELETE FROM memory_job WHERE member_id=OLD.id;
      DELETE FROM memory_state WHERE member_id=OLD.id;
      DELETE FROM profile_candidate_outbox WHERE member_id=OLD.id;
    END;
  `);
}

function clear(db, memberId) {
  for (const table of ['memory_queue', 'memory_job', 'memory_state', 'profile_candidate_outbox']) db.prepare(`DELETE FROM ${table} WHERE member_id=?`).run(memberId);
  db.prepare("UPDATE member SET chat_summary_json='{}' WHERE id=?").run(memberId);
}

module.exports = { setup, clear };
