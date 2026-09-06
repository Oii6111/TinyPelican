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
const { enqueueTask } = require('../agent/queue');

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
    if (isInDoNotDisturb(new Date(), dndCfg)) {
      log('warn', 'remind', `任务 ${task.id} 处于免打扰时段，延后处理`);
      continue;
    }
    if (task.action && task.lastQueuedAt !== dueIso) {
      const queued = enqueueTask({
        type: task.action.capability || 'task',
        summary: task.title,
        detail: task.detail,
        payload: { action: task.action, taskId: task.id },
        taskId: task.id,
        source: { taskId: task.id, intentId: task.sourceIntentId, ...(task.source || {}) }
      });
      if (queued) {
        tasks.updateTask(task.id, {
          lastQueuedAt: dueIso,
          executionStatus: 'queued'
        });
        pushedCount++;
        log('info', 'remind', `已将到期任务交给 Agent：${task.id} ${task.title}`);
      }
      if (queued) continue;
    }
    if (task.lastNotifiedAt === dueIso) continue;

    const msg = buildTaskMessage(task);
    const notifyResult = opts.dryRun
      ? (console.log('[remind][dry-run]', msg), { ok: true })
      : await notifyUser({ title: '⏰ 小鹈鹕提醒', message: msg, config: cfg });
    if (notifyResult && notifyResult.ok) {
      if (task.kind === 'cron') {
        // 对 cron 任务，updateTask 会把 nextAt 自动推进到下一次
        tasks.updateTask(task.id, { lastNotifiedAt: dueIso });
      } else {
        // 一次性提醒送达后即完成，不再长期留在进行中列表。
        tasks.completeTask(task.id);
      }
      pushedCount++;
      log('info', 'remind', `已提醒任务 ${task.id} ${task.title}`);
    } else {
      log('error', 'remind', `任务提醒推送失败 ${task.id} ${task.title}`);
    }
  }

  return { checked: items.length, pushed: pushedCount };
}

module.exports = { runReminders, buildTaskMessage };
