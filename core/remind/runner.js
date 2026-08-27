// 小鹈鹕核心 — 主动提醒执行器
// 消费 intents.json，对已确认/自动添加且带 dueAt 的意图做 DDL/日程/事项提醒。
'use strict';

const { getPaths } = require('../lib/paths');
const { loadConfig } = require('../lib/config');
const { log } = require('../lib/log');
const { readIntents, saveIntents } = require('../memory/stores/intents');
const { runTask } = require('../engine/client');
const { isInDoNotDisturb, typeLabel, getReminderPoints } = require('../lib/reminder-rules');
const { pushToUser } = require('../channels/weixin/push');

const P = getPaths();

async function generateReminderMessage(intent, cfg) {
  const r = await runTask('reminder_text', { intent }, { config: cfg });
  if (r.ok && r.text && r.text.trim()) return r.text.trim();
  return `⏰ ${typeLabel(intent.type)}提醒：${intent.summary}${intent.dueText ? '（' + intent.dueText + '）' : ''}`;
}

async function runReminders(opts = {}) {
  const cfg = opts.config || loadConfig();
  const reminderCfg = cfg.reminder || {};
  const dndCfg = cfg.doNotDisturb || {};
  const intents = readIntents();
  if (!intents.length) {
    log('info', 'remind', '无意图，跳过');
    return { checked: 0, pushed: 0 };
  }

  let changed = false;
  let pushedCount = 0;
  const now = Date.now();

  for (const intent of intents) {
    if (!['auto_added', 'confirmed'].includes(intent.status)) continue;
    if (!intent.dueAt) continue;
    const due = new Date(intent.dueAt).getTime();
    if (isNaN(due)) continue;
    if (!Array.isArray(intent.reminders)) intent.reminders = [];

    const points = getReminderPoints(intent, reminderCfg);
    const passed = points
      .filter((p) => now >= due - p.minutes * 60000 && !intent.reminders.includes(String(p.minutes)))
      .sort((a, b) => a.minutes - b.minutes);
    if (!passed.length) continue;

    // 只推送"最接近当前时间"的已到达提醒点，避免一次性全推
    const point = passed[0];

    // 免打扰时段不推送，也不标记已提醒，等结束后的下一轮再补推
    if (isInDoNotDisturb(new Date(), dndCfg)) {
      console.log(`[remind] ${intent.id} 处于免打扰时段，延后提醒 ${point.label}`);
      log('warn', 'remind', `${intent.id} 处于免打扰时段，延后提醒 ${point.label}`);
      continue;
    }

    const msg = await generateReminderMessage(intent, cfg);
    const ok = opts.dryRun
      ? (console.log('[remind][dry-run]', msg), true)
      : await pushToUser(msg, { config: cfg });
    if (ok) {
      intent.reminders.push(String(point.minutes));
      intent.updatedAt = new Date().toISOString();
      changed = true;
      pushedCount++;
      console.log(`[remind] 已提醒 ${intent.id} ${point.label}`);
      log('info', 'remind', `已提醒 ${intent.id} ${point.label}`);
    } else {
      console.log(`[remind] 推送失败 ${intent.id} ${point.label}`);
      log('error', 'remind', `推送失败 ${intent.id} ${point.label}`);
    }
  }

  if (changed) saveIntents(intents);
  console.log('[remind] 完成');
  log('info', 'remind', '完成');
  return { checked: intents.length, pushed: pushedCount };
}

module.exports = { runReminders, generateReminderMessage };
