'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaotihu-voice-'));
process.env.XIAOTIHU_DATA_DIR = tmp;

const voice = require('../core/memory/stores/voice');
const { ingestMessages, applyVoiceFill } = require('../core/ingest/pipeline');
const { readContact } = require('../core/memory/stores/contacts');

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

test('回填：队首出队并写回联系人档案与 inbox', () => {
  const p = voice.fillFirst('转写文本');
  assert.ok(p);
  assert.strictEqual(p.content, '转写文本');
  const ok = applyVoiceFill(p);
  assert.strictEqual(ok, true);
  assert.strictEqual(readContact('Hank').messages[0].content, '转写文本');
  assert.ok(fs.readFileSync(path.join(tmp, 'inbox.jsonl'), 'utf8').includes('转写文本'));
  assert.strictEqual(voice.list().length, 0);
});
