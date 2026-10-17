'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaotihu-test-'));
const previousDataDir = process.env.XIAOTIHU_DATA_DIR;
process.env.XIAOTIHU_DATA_DIR = tmp;

const { processAllBatches, ingestMessages } = require('../core/ingest/pipeline');
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

test('批次归档：按 contact 建档并删除批次', () => {
  fs.mkdirSync(path.join(tmp, 'batches'), { recursive: true });
  const batch = path.join(tmp, 'batches', 'batch-test.jsonl');
  fs.writeFileSync(batch, [
    JSON.stringify({ name: 'Hank', ts: '2026-08-16 20:35', type: 'text', content: '你好', contact: 'Hank' }),
    JSON.stringify({ name: '六壹', ts: '2026-08-16 20:36', type: 'text', content: '我在做mvp', contact: 'Hank' })
  ].join('\n'), 'utf8');

  const added = processAllBatches();
  assert.strictEqual(added, 2);
  assert.strictEqual(fs.existsSync(batch), false);

  const doc = readContact('Hank');
  assert.strictEqual(doc.messages.length, 2);
  assert.strictEqual(doc.messages[0].content, '你好');
  assert.strictEqual(doc.messages[1].name, '六壹');
});

test('通道实时消息：SQLite 归档与重复导入去重', () => {
  const msgs = [
    { name: 'Hank', ts: '2026-08-17 10:00', type: 'text', content: '第二条' },
    { name: 'Hank', ts: '2026-08-17 10:00', type: 'text', content: '第二条' }
  ];
  const added = ingestMessages(msgs, 'Hank');
  assert.strictEqual(added, 1);
  assert.strictEqual(readContact('Hank').messages.length, 3);

  const messages = chatDb.messages('Hank', '', 10).messages;
  assert.strictEqual(messages.length, 3);
  const persisted = messages.filter(message => message.ts === msgs[0].ts);
  assert.strictEqual(persisted.length, 1);
  assert.strictEqual(persisted[0].sender, msgs[0].name);
  assert.strictEqual(persisted[0].type, msgs[0].type);
  assert.strictEqual(persisted[0].content, msgs[0].content);
  assert.strictEqual(ingestMessages(msgs, 'Hank'), 0);
  assert.strictEqual(chatDb.messages('Hank', '', 10).messages.length, 3);
});
