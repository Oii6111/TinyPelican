// 小鹈鹕核心 — 关系维护检查（潜意识）
// 找「特别关心 + 冷落」的联系人，由小模型判断需要维护后，
// 把“生成问候消息”作为具体任务写入 agent-tasks.jsonl，
// 再由 DSH 大模型 Worker 拉取执行；执行结果通过队列 Worker 推送给用户。
'use strict';

const fs = require('fs');
const path = require('path');
const { getPaths } = require('../lib/paths');
const { loadConfig } = require('../lib/config');
const { log } = require('../lib/log');
const { readJson, listJsonFiles } = require('../lib/store');
const agentQueue = require('../agent/queue');

const P = getPaths();

function daysBetween(a, b) {
  return Math.floor((b - a) / 86400000);
}

function lastInteractionMs(c) {
  let max = 0;
  for (const m of (c.messages || [])) {
    const t = new Date(String(m.ts || '').replace(' ', 'T')).getTime();
    if (!isNaN(t) && t > max) max = t;
  }
  return max;
}

function buildRelationDetail(c) {
  const recent = (c.messages || []).slice(-5)
    .map((m) => `${m.ts || ''} ${m.name || '?'}：${m.content || '[' + (m.type || 'text') + ']'}`)
    .join('\n');
  const profile = Object.entries(c.profile || {})
    .filter(([, v]) => v && String(v).trim())
    .map(([k, v]) => `${k}：${v}`)
    .join('\n');
  const parts = [`已 ${c.days} 天未联系。`];
  if (profile) parts.push('联系人档案：\n' + profile);
  if (recent) parts.push('近期消息：\n' + recent);
  return parts.join('\n\n');
}

async function runRelationCheck(opts = {}) {
  const cfg = opts.config || loadConfig();
  const queueCfg = (cfg.agent && cfg.agent.queue) || {};
  if (!cfg.relationCheck || cfg.relationCheck.enabled === false) {
    log('info', 'relation', '未启用，跳过');
    return { skipped: true };
  }
  if (queueCfg.enabled === false) {
    log('info', 'relation', 'Agent 队列未启用，关系维护不投递 DSH 任务');
    return { skipped: true, reason: 'agent.queue.enabled=false' };
  }
  if (!fs.existsSync(P.contacts)) {
    log('warn', 'relation', '无档案目录，跳过');
    return { skipped: true };
  }

  const daysThreshold = (cfg.relationCheck && cfg.relationCheck.days) || 7;
  let pushed = {};
  if (fs.existsSync(P.relationPushed)) {
    pushed = readJson(P.relationPushed, {}) || {};
  }

  const cold = [];
  for (const f of listJsonFiles(P.contacts)) {
    const c = readJson(path.join(P.contacts, f), null);
    if (!c || !c.important) continue;
    const last = lastInteractionMs(c);
    if (!last) continue;
    const days = daysBetween(last, Date.now());
    if (days < daysThreshold) continue;
    const lp = pushed[c.name] || 0;
    if (lp && daysBetween(lp, Date.now()) < daysThreshold) continue;
    cold.push({ name: c.name, remark: c.remark || '', days, messages: c.messages || [], profile: c.profile || {} });
  }

  if (!cold.length) {
    console.log('没有需要维护的关系');
    log('info', 'relation', '没有需要维护的关系');
    return { checked: 0, enqueued: 0 };
  }
  console.log('发现 ' + cold.length + ' 个冷落联系人：' + cold.map((c) => c.remark || c.name).join('、'));
  log('info', 'relation', '发现 ' + cold.length + ' 个冷落联系人：' + cold.map((c) => c.remark || c.name).join('、'));

  let enqueued = 0;
  for (const c of cold) {
    const label = c.remark || c.name;
    agentQueue.enqueueTask({
      type: 'relation',
      summary: `为「${label}」生成一条自然问候消息`,
      detail: buildRelationDetail(c),
      source: { contact: c.name },
      payload: { contact: c.name, remark: label, days: c.days }
    });
    enqueued++;
    console.log('已入队：' + label);
    log('info', 'relation', `已入队关系维护任务：${label}`);
  }
  return { checked: cold.length, enqueued };
}

module.exports = { runRelationCheck, daysBetween, lastInteractionMs, buildRelationDetail };
