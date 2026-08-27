// 小鹈鹕核心 — 关系维护检查
// 找「特别关心 + 冷落」的联系人，生成问候建议并推送给用户。
'use strict';

const fs = require('fs');
const path = require('path');
const { getPaths } = require('../lib/paths');
const { loadConfig } = require('../lib/config');
const { log } = require('../lib/log');
const { readJson, writeJson, listJsonFiles } = require('../lib/store');
const { runTask } = require('../engine/client');
const { pushToUser } = require('../channels/weixin/push');

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

function fallbackSuggestion(c) {
  const recent = (c.messages || []).slice(-3)
    .map((m) => (m.name || '?') + '：' + (m.content || '[' + (m.type || 'text') + ']')).join('\n');
  const first = (recent.split('\n')[0] || '上次聊天').slice(0, 40);
  return '最近怎么样？上次聊到「' + first + '」，好久没联系了，想着问候一下～';
}

async function runRelationCheck(opts = {}) {
  const cfg = opts.config || loadConfig();
  if (!cfg.relationCheck || cfg.relationCheck.enabled === false) {
    log('info', 'relation', '未启用，跳过');
    return { skipped: true };
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
    return { checked: 0, pushed: 0 };
  }
  console.log('发现 ' + cold.length + ' 个冷落联系人：' + cold.map((c) => c.remark || c.name).join('、'));
  log('info', 'relation', '发现 ' + cold.length + ' 个冷落联系人：' + cold.map((c) => c.remark || c.name).join('、'));

  let pushedCount = 0;
  for (const c of cold) {
    const r = await runTask('relation', { contact: c }, { config: cfg });
    const suggestion = r.ok && r.text ? r.text : fallbackSuggestion(c);
    const msg = '🦩 关系维护提醒\n你和「' + (c.remark || c.name) + '」已经 ' + c.days + ' 天没联系了。\n\n💬 可以发：' + suggestion;
    const ok = await pushToUser(msg, { config: cfg });
    if (ok) {
      pushed[c.name] = Date.now();
      pushedCount++;
      console.log('已推送：' + (c.remark || c.name));
      log('info', 'relation', '已推送：' + (c.remark || c.name));
    } else {
      console.log('推送失败：' + (c.remark || c.name));
      log('error', 'relation', '推送失败：' + (c.remark || c.name));
    }
  }
  writeJson(P.relationPushed, pushed);
  return { checked: cold.length, pushed: pushedCount };
}

module.exports = { runRelationCheck, daysBetween, lastInteractionMs };
