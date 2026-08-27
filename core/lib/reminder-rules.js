// 小鹈鹕核心 — 提醒规则（纯函数）
'use strict';

function parseHM(str) {
  const m = String(str || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return { h, min };
}

function isInDoNotDisturb(now, dndCfg = {}) {
  if (!dndCfg.enabled) return false;
  const start = parseHM(dndCfg.start);
  const end = parseHM(dndCfg.end);
  if (!start || !end) return false;
  const cur = now.getHours() * 60 + now.getMinutes();
  const s = start.h * 60 + start.min;
  const e = end.h * 60 + end.min;
  if (s === e) return false;
  if (s < e) return cur >= s && cur < e;
  // 跨天，如 23:00 - 08:00
  return cur >= s || cur < e;
}

function typeLabel(type) {
  const map = { task: '任务', deadline: 'DDL', schedule: '日程', reminder: '事项提醒', waiting_reply: '等待回复' };
  return map[type] || type;
}

function getReminderPoints(intent, reminderCfg = {}) {
  const type = intent.type || 'task';
  const dueText = intent.dueText ? `（${intent.dueText}）` : '';
  if (type === 'deadline') {
    const points = [];
    const leadDays = reminderCfg.deadlineLeadDays !== undefined ? reminderCfg.deadlineLeadDays : [1];
    const leadHours = reminderCfg.deadlineLeadHours !== undefined ? reminderCfg.deadlineLeadHours : [2];
    for (const d of leadDays) points.push({ minutes: d * 1440, label: `提前${d}天` + dueText });
    for (const h of leadHours) points.push({ minutes: h * 60, label: `提前${h}小时` + dueText });
    points.push({ minutes: 0, label: '已到期' + dueText });
    return points;
  }
  if (type === 'schedule') {
    const lead = reminderCfg.scheduleLeadMinutes !== undefined ? reminderCfg.scheduleLeadMinutes : 30;
    return [
      { minutes: lead, label: `提前${lead}分钟` + dueText },
      { minutes: 0, label: '日程开始' + dueText }
    ];
  }
  if (type === 'reminder') {
    return [{ minutes: 0, label: '事项提醒' + dueText }];
  }
  // task 或其它带 dueAt 的类型：默认到期提醒
  return [{ minutes: 0, label: '到期提醒' + dueText }];
}

module.exports = { parseHM, isInDoNotDisturb, typeLabel, getReminderPoints };
