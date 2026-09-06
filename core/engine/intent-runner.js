// 小鹈鹕核心 — 意图识别执行器
// 从 SQLite 增量读取联系人新消息，识别任务/提醒/日程并写入待确认意图库。
'use strict';

const { loadConfig } = require('../lib/config');
const { log } = require('../lib/log');
const { readIntents, saveIntents, loadState, saveState } = require('../memory/stores/intents');
const { runTask } = require('./client');
const { parseDeadline } = require('../lib/deadline');
const { typeLabel } = require('../lib/reminder-rules');
const { notifyUser } = require('../notify');
const chatDb = require('../memory/chat-db');

let extractionPromise = null;

function cloudIntentConfig(config) {
  const cfg = config || loadConfig();
  const intentCfg = cfg.intent || {};
  const providerName = intentCfg.provider || 'deepseek';
  const providers = (cfg.engine && cfg.engine.providers) || {};
  const provider = providers[providerName];
  if (!provider || !provider.apiKey) return null;
  return {
    cfg: {
      ...cfg,
      engine: {
        ...(cfg.engine || {}),
        provider: providerName,
        providers: { ...providers, [providerName]: provider }
      }
    },
    model: intentCfg.model || provider.model || 'deepseek-chat'
  };
}

function normalizeIntentType(value) {
  if (value === 'schedule') return 'schedule';
  if (value === 'reminder') return 'reminder';
  return 'todo';
}

function normalizeExecution(item, type) {
  const rawExecution = item.execution && typeof item.execution === 'object' ? item.execution : {};
  const rawAction = item.action || item.execution;
  const action = rawAction && typeof rawAction === 'object' && !rawAction.mode ? rawAction : null;
  const explicitMode = ['manual', 'system', 'dsh'].includes(rawExecution.mode) ? rawExecution.mode : '';
  const mode = explicitMode || (type === 'reminder' ? 'system' : (action ? 'dsh' : 'manual'));
  const instruction = String(rawExecution.instruction || (action && action.instruction) || '').trim();
  const capability = String(rawExecution.capability || (action && action.capability) || '').trim();
  const inputs = rawExecution.inputs || (action && action.inputs) || {};
  return {
    mode,
    capability,
    instruction,
    inputs: inputs && typeof inputs === 'object' ? inputs : {}
  };
}

function buildIntent(item, contact, newMsgs, context = {}) {
  const type = normalizeIntentType(item.type);
  const summary = String(item.summary || item.description || item.task || '').trim();
  if (!summary) return null;
  const conf = typeof item.confidence === 'number' ? item.confidence : 0.7;
  const firstMsg = newMsgs.find((m) => m.content && String(m.content).includes(String(item.detail || item.description || '').slice(0, 20))) || newMsgs[newMsgs.length - 1] || {};
  const sourceTs = firstMsg.ts || (newMsgs[0] && newMsgs[0].ts) || '';
  const sourceContent = firstMsg.content || '';
  const dueText = item.deadline || item.dueText ? String(item.deadline || item.dueText) : '';
  const parseIntentTime = (value) => {
    if (!value) return null;
    const raw = String(value).trim();
    const absolute = new Date(raw);
    if (!isNaN(absolute.getTime()) && /\d{4}/.test(raw)) return absolute.toISOString();
    return parseDeadline(raw, sourceTs);
  };
  const startText = item.startAt || item.start || item.startTime || dueText;
  const endText = item.endAt || item.end || item.endTime || '';
  const dueAt = parseIntentTime(startText);
  const endAt = parseIntentTime(endText);
  const execution = normalizeExecution(item, type);
  return {
    id: 'intent_' + Date.now() + '_' + Math.random().toString(16).slice(2, 8),
    type,
    summary,
    detail: String(item.detail || item.description || ''),
    action: execution.mode === 'dsh' && type !== 'schedule'
      ? {
        capability: execution.capability || 'other',
        instruction: execution.instruction,
        inputs: execution.inputs
      }
      : null,
    execution,
    recurrence: item.recurrence && typeof item.recurrence === 'object'
      ? item.recurrence
      : null,
    dueAt,
    endAt,
    dueText,
    people: Array.isArray(item.people) ? item.people.map(String) : [],
    priority: ['high', 'medium', 'low'].includes(item.priority) ? item.priority : 'medium',
    confidence: conf,
    reason: String(item.reason || ''),
    source: {
      contact: contact,
      ts: sourceTs,
      content: sourceContent,
      origin: context.origin || 'observed_chat'
    },
    status: 'pending_confirm',
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
    if (intent.status === 'pending_confirm' && intent.confidence >= MEDIUM_CONF) {
      const msg = `🔍 发现疑似${typeLabel(intent.type)}：${intent.summary}（来自 ${intent.source.contact || '未知'}）。请在 Dashboard「待确认意图」中确认进入任务或日程，或忽略。`;
      const notifyResult = await notifyUser({ title: '🔍 小鹈鹕发现待确认事项', message: msg, config: cfg });
      const ok = !!(notifyResult && notifyResult.ok);
      if (ok) {
        intent.notified = true;
        intent.updatedAt = new Date().toISOString();
        changed = true;
        log('info', 'intent', `已推送待确认意图：${intent.summary}`);
      } else {
        log('warn', 'intent', `待确认意图未推送：${intent.summary}`);
      }
    }
  }
  if (changed) saveIntents(intents);
}

async function runIntentExtraction(opts = {}) {
  if (extractionPromise) return extractionPromise;
  extractionPromise = runIntentExtractionInternal(opts);
  try {
    return await extractionPromise;
  } finally {
    extractionPromise = null;
  }
}

async function runIntentExtractionInternal(opts = {}) {
  const cfg = opts.config || loadConfig();
  const intentCfg = cfg.intent || {};
  const MAX_MSGS = intentCfg.maxMessagesPerBatch || 50;
  const intents = readIntents();
  const state = loadState();
  const taskRunner = typeof opts.runTask === 'function' ? opts.runTask : runTask;
  const members = chatDb.listMembers('').sort((leftMember, rightMember) => String(leftMember.name).localeCompare(String(rightMember.name)));
  let totalNew = 0;
  let totalScanned = 0;

  for (const member of members) {
    const key = member.name;
    const since = state[key] || '';
    const page = chatDb.messagesSince(key, since, MAX_MSGS);
    const newMsgs = page ? page.messages : [];
    if (!newMsgs.length) continue;
    totalScanned += newMsgs.length;
    const batch = newMsgs;
    const chatText = batch.map((m) => `${m.ts} ${m.name}: ${m.content}`).join('\n');
    console.log(`[intent] 扫描 ${key}，新增 ${newMsgs.length} 条`);
    log('info', 'intent', `扫描 ${key}，新增 ${newMsgs.length} 条`);

    const cloud = cloudIntentConfig(cfg);
    if (!cloud) {
      log('error', 'intent', 'DeepSeek 意图模型未配置 API Key，跳过本次扫描');
      continue;
    }
    const result = await taskRunner('intent', { chatText, sourceLabel: key }, {
      config: cloud.cfg,
      model: cloud.model,
      timeoutMs: intentCfg.agentTimeoutMs || 120000
    });
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
          // 意图识别只生成“待确认建议”，不自动创建正式任务，也不自动入 DSH 执行队列。
          // 用户确认后由「任务」页/待确认页手动转为正式任务。
        }
      }
      console.log(`[intent] ${key} 新增 ${added} 条意图`);
      log('info', 'intent', `${key} 新增 ${added} 条意图`);
    }

    // 只有成功处理后才推进游标
    state[key] = page.cursor;
    saveState(state);
    saveIntents(intents);
  }

  console.log(`[intent] 本次扫描 ${totalScanned} 条消息，新增意图 ${totalNew} 条`);
  log('info', 'intent', `本次扫描 ${totalScanned} 条消息，新增意图 ${totalNew} 条`);
  await notifyNewIntents(intents, cfg);
  console.log('[intent] 完成');
  log('info', 'intent', '完成');
  return { totalNew, totalScanned };
}

module.exports = { runIntentExtraction, buildIntent, isDuplicate };
