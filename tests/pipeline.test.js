'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaotihu-test-'));
process.env.XIAOTIHU_DATA_DIR = tmp;

const { processAllBatches, ingestMessages } = require('../core/ingest/pipeline');
const { readContact } = require('../core/memory/stores/contacts');

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

test('通道实时消息：去重归档 + 全量流水', () => {
  const msgs = [
    { name: 'Hank', ts: '2026-08-17 10:00', type: 'text', content: '第二条' },
    { name: 'Hank', ts: '2026-08-17 10:00', type: 'text', content: '第二条' }
  ];
  const added = ingestMessages(msgs, 'Hank');
  assert.strictEqual(added, 1);
  assert.strictEqual(readContact('Hank').messages.length, 3);

  const inbox = fs.readFileSync(path.join(tmp, 'inbox.jsonl'), 'utf8').trim().split(/\r?\n/).filter(Boolean);
  assert.strictEqual(inbox.length, 1);
});
