'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { parseSensorLine } = require('../core/capture/clipboard');
const { latestTextMessage, normalizeOptions, canSuggest } = require('../core/reply/suggestions');
const store = require('../core/reply/suggestion-store');

test('剪贴板传感器新/旧格式解析', () => {
  const current = parseSensorLine('CHANGE 123456 aGVsbG8=');
  assert.strictEqual(current.handle, '123456');
  assert.strictEqual(current.encoded, 'aGVsbG8=');

  const zero = parseSensorLine('CHANGE 0 aGVsbG8=');
  assert.strictEqual(zero.handle, null);

  const legacy = parseSensorLine('CHANGE aGVsbG8=');
  assert.strictEqual(legacy.handle, null);
  assert.strictEqual(legacy.encoded, 'aGVsbG8=');

  assert.strictEqual(parseSensorLine('CHANGE'), null);
});

test('最后一条文本消息不区分发送方', () => {
  const doc = {
    messages: [
      { name: 'Hank', ts: '2026-08-29 10:00', type: 'text', content: '你明天有时间吗？' },
      { name: '我', ts: '2026-08-29 10:01', type: 'text', content: '有的' },
      { name: 'Hank', ts: '2026-08-29 10:02', type: '图片', content: '' }
    ]
  };
  const latest = latestTextMessage(doc);
  assert.ok(latest);
  assert.strictEqual(latest.content, '有的');

  assert.strictEqual(latestTextMessage({ messages: [] }), null);
  assert.strictEqual(latestTextMessage({ messages: [{ name: 'Hank', type: '图片', content: '' }] }), null);
});

test('建议选项规范化：去空/去重/限长/最多 3 条', () => {
  const out = normalizeOptions([
    { tone: '自然', text: '好的' },
    { tone: '关心', text: '好的' },
    { tone: '简洁', text: '' },
    { tone: '正式', text: 'x'.repeat(600) },
    { tone: '自然', text: '嗯嗯' },
    { tone: '简洁', text: '收到' }
  ]);
  assert.strictEqual(out.length, 3);
  assert.deepStrictEqual(out.map((o) => o.text), ['好的', '嗯嗯', '收到']);
});

test('触发条件：剪贴板开启、私聊联系人、建议开关', () => {
  const cfg = {
    capture: {
      enabled: true,
      replySuggestions: { enabled: true }
    }
  };
  assert.strictEqual(canSuggest({ contact: 'Hank', cfg }), true);
  assert.strictEqual(canSuggest({ contact: '', cfg }), false);
  assert.strictEqual(canSuggest({ contact: 'Hank', cfg: { capture: { enabled: true, replySuggestions: { enabled: false } } } }), false);
  assert.strictEqual(canSuggest({ contact: 'Hank', cfg: { capture: { enabled: false, replySuggestions: { enabled: true } } } }), false);
});

test('建议状态：过期/失效/锁定/消费/忽略', () => {
  store.invalidate();
  const base = {
    id: 'reply_test_1',
    contact: 'Hank',
    sourceMessage: '好的',
    options: [{ tone: '自然', text: '嗯嗯' }],
    targetWindow: { handle: '123' },
    createdAt: new Date().toISOString(),
    expiresAt: Date.now() + 100000
  };

  store.replaceSuggestion({ ...base });
  assert.strictEqual(store.getCurrent().id, 'reply_test_1');
  assert.strictEqual(store.sanitize(store.getCurrent()).canPaste, true);
  assert.strictEqual(store.sanitize(store.getCurrent()).targetWindow, undefined);

  assert.strictEqual(store.lock('reply_test_1'), true);
  assert.strictEqual(store.lock('reply_test_1'), true);
  assert.strictEqual(store.consume('reply_test_1'), true);
  assert.strictEqual(store.getCurrent(), null);

  store.replaceSuggestion({ ...base, id: 'reply_test_2', expiresAt: Date.now() - 1 });
  assert.strictEqual(store.getCurrent(), null);

  store.replaceSuggestion({ ...base, id: 'reply_test_3' });
  assert.strictEqual(store.dismiss('wrong'), false);
  assert.strictEqual(store.dismiss('reply_test_3'), true);
  assert.strictEqual(store.getCurrent(), null);
});

test('生成序号乱序防护', () => {
  store.invalidate();
  const a = store.beginGeneration();
  const b = store.beginGeneration();
  assert.strictEqual(store.isLatestGeneration(a), false);
  assert.strictEqual(store.isLatestGeneration(b), true);
});
