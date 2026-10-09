'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

test('旧库增量加列与队列表，保留联系人、画像及聊天内容', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pelican-migration-'));
  process.env.XIAOTIHU_DATA_DIR = directory;
  const previous = new DatabaseSync(path.join(directory, 'tinypelican.sqlite'));
  previous.exec(`CREATE TABLE member (
    id INTEGER PRIMARY KEY AUTOINCREMENT, platform_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
    remark TEXT DEFAULT '', avatar TEXT DEFAULT '', important INTEGER DEFAULT 0,
    profile_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE message (
    id INTEGER PRIMARY KEY AUTOINCREMENT, member_id INTEGER NOT NULL, sender TEXT NOT NULL,
    ts TEXT NOT NULL, type TEXT NOT NULL, content TEXT NOT NULL, platform_message_id TEXT,
    content_hash TEXT NOT NULL UNIQUE
  );`);
  previous.prepare('INSERT INTO member(platform_id,name,remark,profile_json,created_at,updated_at) VALUES(?,?,?,?,?,?)').run('old', '老联系人', '老备注', JSON.stringify({ 基础身份: { 城市: '手动保留' } }), '2026-01-01', '2026-01-01');
  previous.prepare('INSERT INTO message(member_id,sender,ts,type,content,content_hash) VALUES(1,?,?,?,?,?)').run('老联系人', new Date().toISOString(), 'text', '旧记录保留', 'old-hash');
  previous.close();
  const chat = require('../core/memory/chat-db');
  try {
    const member = chat.getMember('老联系人');
    assert.equal(member.remark, '老备注');
    assert.equal(member.profile.基础身份.城市, '手动保留');
    assert.deepEqual(member.chatSummary, {});
    assert.deepEqual(member.profileSkipped, []);
    assert.equal(chat.allMessages('老联系人').messages[0].content, '旧记录保留');
    assert.equal(chat.searchMessages('旧记录保留')[0].content, '旧记录保留');
    require('../core/memory/chat-memory').initialize();
    assert.equal(chat.db.prepare("SELECT seed FROM memory_job WHERE kind='summary'").get().seed, 1);
    assert.equal(chat.getMember('老联系人').profile.基础身份.城市, '手动保留');
  } finally { chat.db.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});
