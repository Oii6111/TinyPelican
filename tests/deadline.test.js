'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { parseDeadline, toLocalDate } = require('../core/lib/deadline');

const BASE = '2026-08-16 20:27';

function dueDate(text, ts = BASE) {
  const iso = parseDeadline(text, ts);
  if (!iso) return null;
  return toLocalDate(new Date(iso));
}

test('相对日期', () => {
  assert.strictEqual(dueDate('今天'), '2026-08-16');
  assert.strictEqual(dueDate('明天'), '2026-08-17');
  assert.strictEqual(dueDate('后天'), '2026-08-18');
  assert.strictEqual(dueDate('3天后'), '2026-08-19');
});

test('周与月底', () => {
  assert.strictEqual(dueDate('周一'), '2026-08-17'); // 2026-08-16 是周日
  assert.strictEqual(dueDate('下周一'), '2026-08-24');
  assert.strictEqual(dueDate('月底'), '2026-08-31');
});

test('具体日期', () => {
  assert.strictEqual(dueDate('8月20日'), '2026-08-20');
  assert.strictEqual(dueDate('12月25日'), '2026-12-25');
});

test('时刻', () => {
  assert.strictEqual(dueDate('晚上8点'), '2026-08-17'); // 晚于消息时间 20:27，顺延一天
  assert.strictEqual(dueDate('明天下午3点'), '2026-08-17');
});

test('无时间表达返回 null', () => {
  assert.strictEqual(parseDeadline('随便聊聊', BASE), null);
  assert.strictEqual(parseDeadline('', BASE), null);
});
