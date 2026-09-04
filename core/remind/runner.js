// 小鹈鹕核心 — 主动提醒执行器（正式任务）
// 意图识别只负责建议；提醒统一消费「任务」：
//   once  一次性任务：dueAt 到期提醒
//   cron  周期任务：nextAt 到期提醒，提醒后自动推进到下一次
'use strict';

const { loadConfig } = require('../lib/config');
const { log } = require('../lib/log');
const { isInDoNotDisturb } = require('../lib/reminder-rules');
const { notifyUser } = require('../notify');
const tasks = require('../memory/stores/tasks');

function taskTimeText(task) {
  const iso = task.kind === 'cron' ? task.nextAt : task.dueAt;
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleString('zh-CN', { hour12: false });
}

function buildTaskMessage(task) {
  const lines = [];
  lines.push(`📌 任务提醒：${task.title || '未命名任务'}`);
  if (task.detail) lines.push(task.detail);
  const time = taskTimeText(task);
  if (time) lines.push(`⏰ ${task.kind === 'cron' ? '本次时间' : '截止时间'}：${time}`);
  return lines.join('\n');
}

async function runReminders(opts = {}) {
  const cfg = opts.config || loadConfig();
  const dndCfg = cfg.doNotDisturb || {};
  const items = tasks.listTasks({ status: 'open' });
  let pushedCount = 0;
  const now = Date.now();

  for (const task of items) {
    const dueIso = task.kind === 'cron' ? task.nextAt : task.dueAt;
    if (!dueIso) continue;
    const due = new Date(dueIso).getTime();
    if (isNaN(due) || now < due) continue;
    if (task.lastNotifiedAt === dueIso) continue;

    if (isInDoNotDisturb(new Date(), dndCfg)) {
      log('warn', 'remind', `任务 ${task.id} 处于免打扰时段，延后提醒`);
      continue;
    }

    const msg = buildTaskMessage(task);
    const notifyResult = opts.dryRun
      ? (console.log('[remind][dry-run]', msg), { ok: true })
      : await notifyUser({ title: '⏰ 小鹈鹕提醒', message: msg, config: cfg });
    if (notifyResult && notifyResult.ok) {
      // 对 cron 任务，updateTask 会把 nextAt 自动推进到下一次
      tasks.updateTask(task.id, { lastNotifiedAt: dueIso });
      pushedCount++;
      log('info', 'remind', `已提醒任务 ${task.id} ${task.title}`);
    } else {
      log('error', 'remind', `任务提醒推送失败 ${task.id} ${task.title}`);
    }
  }

  return { checked: items.length, pushed: pushedCount };
}

module.exports = { runReminders, buildTaskMessage };
