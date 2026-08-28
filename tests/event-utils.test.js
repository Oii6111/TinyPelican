'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  appendEvent,
  lastSeq,
  summarizeTask,
  sanitizeEventList,
  historyEventList
} = require('../core/agent/event-utils');

test('appendEvent 归一化 seq 并合并连续文本增量', () => {
  const arr = [];
  appendEvent(arr, { type: 'assistant/chunk', data: { chunk: { index: 0, type: 'text-delta', text: '你' } } });
  appendEvent(arr, { type: 'assistant/chunk', data: { chunk: { index: 0, type: 'text-delta', text: '好' } } });
  appendEvent(arr, { type: 'assistant/chunk', data: { chunk: { index: 1, type: 'reasoning-delta', text: '想' } } });
  assert.strictEqual(arr.length, 2);
  assert.strictEqual(arr[0].seq, 2);
  assert.strictEqual(arr[0].data.chunk.text, '你好');
  assert.strictEqual(arr[1].data.chunk.text, '想');
  assert.strictEqual(lastSeq(arr), 3);
});

test('工具结果超长会被裁剪并保留摘要', () => {
  const long = Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n');
  const arr = [];
  appendEvent(arr, {
    type: 'tool/result',
    data: { message: { content: [{ type: 'text', text: long }] } }
  });
  const ev = arr[0];
  assert.strictEqual(ev.data.truncated, true);
  assert.strictEqual(ev.data.fullLines, 60);
  assert.ok(ev.data.message.content[0].text.includes('已截断'));
});

test('summarizeTask 统计工具与截断结果', () => {
  const t = {
    status: 'completed',
    startedAt: new Date(Date.now() - 3000).toISOString(),
    finishedAt: new Date().toISOString(),
    events: [
      { type: 'tool/call', data: { name: 'glob' } },
      { type: 'tool/result', data: { truncated: true } }
    ]
  };
  const s = summarizeTask(t);
  assert.strictEqual(s.tools, 1);
  assert.deepStrictEqual(s.toolNames, ['glob']);
  assert.strictEqual(s.truncatedResults, 1);
  assert.strictEqual(s.durationMs >= 2000, true);
});

test('sanitizeEventList 对旧历史事件同样裁剪', () => {
  const long = 'x'.repeat(9000);
  const out = sanitizeEventList([
    { type: 'tool/result', data: { message: { content: [{ type: 'text', text: long }] } } }
  ]);
  assert.strictEqual(out[0].data.truncated, true);
  assert.ok(out[0].data.message.content[0].text.length < 9000);
});

test('historyEventList 仅保留可展示的思考与执行过程', () => {
  const out = historyEventList([
    { type: 'turn/start', data: {} },
    { type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: '最终回答' } } },
    { type: 'assistant/chunk', data: { chunk: { type: 'reasoning-delta', text: '先读取联系人档案' } } },
    { type: 'tool/call', data: { name: 'read', arguments: '{}' } },
    { type: 'tool/result', data: { message: { content: [{ type: 'text', text: '完成' }] } } }
  ]);
  assert.deepStrictEqual(out.map((ev) => ev.type), ['assistant/chunk', 'tool/call', 'tool/result']);
  assert.strictEqual(out[0].data.chunk.text, '先读取联系人档案');
});
