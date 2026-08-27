// 小鹈鹕核心 — 意图识别执行器
// 扫描各联系人档案中的新增消息，调用引擎识别任务/DDL/日程/等待回复，写入意图库并通知。
'use strict';

const fs = require('fs');
const path = require('path');
const { getPaths } = require('../lib/paths');
const { loadConfig } = require('../lib/config');
const { log } = require('../lib/log');
const { readIntents, saveIntents, loadState, saveState } = require('../memory/stores/intents');
const { runTask } = require('./client');
const { parseDeadline } = require('../lib/deadline');
const { typeLabel } = require('../lib/reminder-rules');
const { pushToUser } = require('../channels/weixin/push');

const P = getPaths();

function buildIntent(item, contact, newMsgs) {
  const type = ['task', 'deadline', 'schedule', 'reminder', 'waiting_reply'].includes(item.type) ? item.type : 'task';
  const summary = String(item.summary || item.description || item.task || '').trim();
  if (!summary) return null;
  const conf = typeof item.confidence === 'number' ? item.confidence : 0.7;
  const firstMsg = newMsgs.find((m) => m.content && String(m.content).includes(String(item.detail || item.description || '').slice(0, 20))) || newMsgs[newMsgs.length - 1] || {};
  const sourceTs = firstMsg.ts || (newMsgs[0] && newMsgs[0].ts) || '';
  const sourceContent = firstMsg.content || '';
  const dueText = item.deadline ? String(item.deadline) : '';
  const dueAt = parseDeadline(dueText, sourceTs);
  return {
    id: 'intent_' + Date.now() + '_' + Math.random().toString(16).slice(2, 8),
    type,
    summary,
    detail: String(item.detail || item.description || ''),
    dueAt,
    dueText,
    people: Array.isArray(item.people) ? item.people.map(String) : [],
    priority: ['high', 'medium', 'low'].includes(item.priority) ? item.priority : 'medium',
    confidence: conf,
    reason: String(item.reason || ''),
    source: {
      contact: contact,
      ts: sourceTs,
      content: sourceContent
    },
    status: conf >= 0.85 ? 'auto_added' : 'pending_confirm',
    notified: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

function isDuplicate(intents, intent) {
  return intents.some((x) =>
    x.source &&
    x.source.contact === intent.source.contact &&
    x.source.ts === intent.source.ts &&
    x.source.content === intent.source.content &&
    x.type === intent.type &&
    x.summary === intent.summary
  );
}

async function notifyNewIntents(intents, cfg) {
  const intentCfg = cfg.intent || {};
  const MEDIUM_CONF = intentCfg.mediumConfidence !== undefined ? intentCfg.mediumConfidence : 0.5;
  let changed = false;
  for (const intent of intents) {
    if (intent.notified) continue;
    if (intent.status === 'auto_added') {
      const msg = `✅ 已添加${typeLabel(intent.type)}：${intent.summary}（来自 ${intent.source.contact || '未知'}${intent.dueText ? '，' + intent.dueText : ''}）`;
      const ok = await pushToUser(msg, { config: cfg });
      if (ok) {
        intent.notified = true;
        intent.updatedAt = new Date().toISOString();
        changed = true;
        log('info', 'weixin', `已推送意图通知：${intent.summary}`);
      } else {
        log('warn', 'weixin', `意图通知未推送（微信通道未就绪）：${intent.summary}`);
      }
    } else if (intent.status === 'pending_confirm' && intent.confidence >= MEDIUM_CONF) {
      const msg = `🔍 发现疑似${typeLabel(intent.type)}：${intent.summary}（来自 ${intent.source.contact || '未知'}）。请在 Dashboard「意图」页确认或忽略。`;
      const ok = await pushToUser(msg, { config: cfg });
      if (ok) {
        intent.notified = true;
        intent.updatedAt = new Date().toISOString();
        changed = true;
        log('info', 'weixin', `已推送待确认意图：${intent.summary}`);
      } else {
        log('warn', 'weixin', `待确认意图未推送（微信通道未就绪）：${intent.summary}`);
      }
    }
  }
  if (changed) saveIntents(intents);
}

async function runIntentExtraction(opts = {}) {
  const cfg = opts.config || loadConfig();
  const intentCfg = cfg.intent || {};
  const HIGH_CONF = intentCfg.highConfidence !== undefined ? intentCfg.highConfidence : 0.85;
  const MAX_MSGS = intentCfg.maxMessagesPerBatch || 50;

  if (!fs.existsSync(P.contacts)) {
    log('warn', 'intent', '无联系人目录，跳过');
    return { totalNew: 0 };
  }
  const intents = readIntents();
  const state = loadState();
  const files = fs.readdirSync(P.contacts).filter((f) => f.endsWith('.json')).sort();
  let totalNew = 0;

  for (const file of files) {
    let c;
    try {
      c = JSON.parse(fs.readFileSync(path.join(P.contacts, file), 'utf8'));
    } catch {
      continue;
    }
    const key = c.name || file.replace(/\.json$/, '');
    const since = state[key] || '';
    const newMsgs = (c.messages || []).filter((m) =>
      m && m.ts && m.ts > since && m.type === 'text' && m.content && String(m.content).trim()
    );
    if (!newMsgs.length) continue;
    const batch = newMsgs.slice(-MAX_MSGS);
    const chatText = batch.map((m) => `${m.ts} ${m.name}: ${m.content}`).join('\n');
    console.log(`[intent] 扫描 ${key}，新增 ${newMsgs.length} 条`);
    log('info', 'intent', `扫描 ${key}，新增 ${newMsgs.length} 条`);

    const result = await runTask('intent', { chatText, sourceLabel: key }, { config: cfg });
    if (!result.ok) {
      console.log(`[intent] ${key} 调用失败：${result.error}，下次重试`);
      log('error', 'intent', `${key} 调用失败：${result.error}，下次重试`);
      continue;
    }
    const text = result.text || '';
    if (!text.trim()) {
      console.log(`[intent] ${key} 输出为空，保留待重试`);
      log('warn', 'intent', `${key} 输出为空，保留待重试`);
      continue;
    }
    if (text.trim().toUpperCase() === 'NO_TASK') {
      console.log(`[intent] ${key} 无意图`);
      log('info', 'intent', `${key} 无意图`);
    } else {
      const arr = result.array;
      if (!arr) {
        console.log(`[intent] ${key} 输出无法解析，保留待重试：${text.slice(0, 200)}`);
        log('error', 'intent', `${key} 输出无法解析，保留待重试：${text.slice(0, 200)}`);
        continue;
      }
      let added = 0;
      for (const item of arr) {
        const intent = buildIntent(item, key, batch);
        if (intent && !isDuplicate(intents, intent)) {
          intents.push(intent);
          added++;
          totalNew++;
        }
      }
      console.log(`[intent] ${key} 新增 ${added} 条意图`);
      log('info', 'intent', `${key} 新增 ${added} 条意图`);
    }

    // 只有成功处理后才推进游标
    state[key] = newMsgs[newMsgs.length - 1].ts;
    saveState(state);
    saveIntents(intents);
  }

  console.log(`[intent] 本次新增意图 ${totalNew} 条`);
  log('info', 'intent', `本次新增意图 ${totalNew} 条`);
  await notifyNewIntents(intents, cfg);
  console.log('[intent] 完成');
  log('info', 'intent', '完成');
  return { totalNew };
}

module.exports = { runIntentExtraction, buildIntent, isDuplicate };
