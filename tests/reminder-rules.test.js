'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { getReminderPoints, isInDoNotDisturb, typeLabel } = require('../core/lib/reminder-rules');

test('DDL 提醒点：提前1天/2小时/到期', () => {
  const points = getReminderPoints({ type: 'deadline', dueText: '下周一' }, { deadlineLeadDays: [1], deadlineLeadHours: [2] });
  assert.deepStrictEqual(points.map((p) => p.minutes), [1440, 120, 0]);
});

test('日程提醒点：提前30分钟/开始', () => {
  const points = getReminderPoints({ type: 'schedule', dueText: '' }, { scheduleLeadMinutes: 30 });
  assert.deepStrictEqual(points.map((p) => p.minutes), [30, 0]);
});

test('免打扰时段（含跨天）', () => {
  const dnd = { enabled: true, start: '23:00', end: '08:00' };
  assert.strictEqual(isInDoNotDisturb(new Date(2026, 7, 27, 2, 30), dnd), true);
  assert.strictEqual(isInDoNotDisturb(new Date(2026, 7, 27, 12, 0), dnd), false);
  assert.strictEqual(isInDoNotDisturb(new Date(2026, 7, 27, 23, 30), dnd), true);
});

test('类型中文标签', () => {
  assert.strictEqual(typeLabel('deadline'), 'DDL');
  assert.strictEqual(typeLabel('waiting_reply'), '等待回复');
});
