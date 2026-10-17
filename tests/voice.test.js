'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaotihu-voice-'));
const previousDataDir = process.env.XIAOTIHU_DATA_DIR;
process.env.XIAOTIHU_DATA_DIR = tmp;

const voice = require('../core/memory/stores/voice');
const { ingestMessages, applyVoiceFill } = require('../core/ingest/pipeline');
const { readContact } = require('../core/memory/stores/contacts');
const chatDb = require('../core/memory/chat-db');

after(() => {
  try {
    chatDb.db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  } finally {
    if (previousDataDir === undefined) delete process.env.XIAOTIHU_DATA_DIR;
    else process.env.XIAOTIHU_DATA_DIR = previousDataDir;
  }
});

test('【语音】消息归档后自动进入待回填队列', () => {
  const added = ingestMessages([
    { name: 'Hank', ts: '2026-08-16 20:35', type: '语音', content: '' }
  ], 'Hank');
  assert.strictEqual(added, 1);
  const items = voice.list();
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].contact, 'Hank');
  assert.strictEqual(items[0].content, '');
});

test('回填：队首出队并更新 SQLite 原消息', () => {
  const before = chatDb.messages('Hank', '', 10).messages;
  assert.strictEqual(before.length, 1);
  const p = voice.fillFirst('转写文本');
  assert.ok(p);
  assert.strictEqual(p.content, '转写文本');
  const ok = applyVoiceFill(p);
  assert.strictEqual(ok, true);
  assert.strictEqual(readContact('Hank').messages[0].content, '转写文本');
  const messages = chatDb.messages('Hank', '', 10).messages;
  assert.strictEqual(messages.length, 1);
  assert.strictEqual(messages[0].id, before[0].id);
  assert.strictEqual(messages[0].sender, before[0].sender);
  assert.strictEqual(messages[0].ts, before[0].ts);
  assert.strictEqual(messages[0].type, '语音');
  assert.strictEqual(messages[0].content, '转写文本');
  assert.strictEqual(voice.list().length, 0);
});
