'use strict';

const { readIntents, saveIntents } = require('../memory/stores/intents');
const tasks = require('../memory/stores/tasks');
const schedules = require('../memory/stores/schedules');
const { nextCronAfter } = require('../lib/cron');

function canonicalType(value) {
  if (value === 'schedule') return 'schedule';
  if (value === 'reminder') return 'reminder';
  return 'todo';
}

function validCron(value) {
  const cron = String(value || '').trim();
  if (!cron) return '';
  try {
    return nextCronAfter(cron, new Date()) ? cron : '';
  } catch {
    return '';
  }
}

function timeParts(text) {
  const match = String(text || '').match(/(上午|中午|下午|晚上)?\s*(\d{1,2})(?::|：|点)(\d{1,2})?/);
  if (!match) return null;
  let hour = Number(match[2]);
  const minute = Number(match[3] || 0);
  if (match[1] === '下午' || match[1] === '晚上') {
    if (hour < 12) hour += 12;
  } else if (match[1] === '中午' && hour < 12) {
    hour = 12;
  }
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

function recurrenceForIntent(intent) {
  const recurrence = intent.recurrence && typeof intent.recurrence === 'object' ? intent.recurrence : {};
  const action = intent.action && typeof intent.action === 'object' ? intent.action : {};
  const inputs = action.inputs && typeof action.inputs === 'object' ? action.inputs : {};
  const explicit = validCron(recurrence.cron || action.cron || inputs.cron);
  if (explicit) return { cron: explicit, label: recurrence.label || '' };

  const text = [
    intent.summary,
    intent.detail,
    intent.dueText,
    recurrence.label,
    action.instruction,
    inputs.repeat,
    inputs.schedule,
    inputs.time,
    inputs.reminder_time
  ].filter(Boolean).join(' ');
  const time = timeParts(text);
  if (!time) return null;
  const minute = time.minute;
  const hour = time.hour;
  if (/(工作日|周一至周五)/.test(text)) return { cron: `${minute} ${hour} * * 1-5`, label: '工作日' };
  if (/(每天|每日)/.test(text)) return { cron: `${minute} ${hour} * * *`, label: '每天' };
  const weekly = text.match(/每周([一二三四五六日天])/);
  if (weekly) {
    const day = { '日': 0, '天': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6 }[weekly[1]];
    return { cron: `${minute} ${hour} * * ${day}`, label: '每周' + weekly[1] };
  }
  return null;
}

function materializeIntent(intent, { direct = false } = {}) {
  const type = canonicalType(intent.type);
  const isSchedule = type === 'schedule';
  if (isSchedule && !intent.dueAt) return { ok: false, status: 400, error: '日程需要先填写具体开始时间' };
  if (type === 'reminder' && !intent.dueAt && !recurrenceForIntent(intent)) {
    return { ok: false, status: 400, error: '提醒需要先填写具体时间或重复规则' };
  }

  const recurrence = isSchedule ? null : recurrenceForIntent(intent);
  const execution = intent.execution && typeof intent.execution === 'object' ? intent.execution : {};
  const isReminder = type === 'reminder';
  const action = !isSchedule && !isReminder && (execution.mode === 'dsh' || (!execution.mode && intent.action))
    ? (intent.action || null)
    : null;
  const target = isSchedule
    ? schedules.createSchedule({
      title: intent.summary,
      detail: intent.detail || '',
      startAt: intent.dueAt,
      endAt: intent.endAt || null,
      sourceIntentId: intent.id,
      source: intent.source || null
    })
    : tasks.createTask({
      type,
      title: intent.summary,
      detail: intent.detail || '',
      kind: isReminder && recurrence ? 'cron' : 'once',
      dueAt: intent.dueAt || null,
      cron: isReminder && recurrence ? recurrence.cron : '',
      action,
      executionMode: action ? 'dsh' : (isReminder ? 'system' : 'manual'),
      sourceIntentId: intent.id,
      source: intent.source || null
    });
  if (!target) return { ok: false, status: 400, error: isSchedule ? '日程创建失败' : '事项创建失败' };

  const updatedIntent = {
    ...intent,
    type,
    status: direct ? 'auto_created' : 'confirmed',
    targetType: type,
    targetId: target.id,
    updatedAt: new Date().toISOString()
  };
  const items = readIntents();
  saveIntents(items.some((item) => item.id === updatedIntent.id)
    ? items.map((item) => item.id === updatedIntent.id ? updatedIntent : item)
    : [...items, updatedIntent]);
  return { ok: true, intent: updatedIntent, targetType: type, target, queued: null };
}

function confirmIntent(id) {
  const items = readIntents();
  const intent = items.find((item) => item.id === id);
  if (!intent) return { ok: false, status: 404, error: '意图不存在' };
  if (intent.status !== 'pending_confirm') return { ok: false, status: 409, error: '该意图已经处理过了' };

  const result = materializeIntent(intent);
  if (!result.ok) return result;
  return { ...result, queued: null };
}

module.exports = { confirmIntent, materializeIntent, recurrenceForIntent };
