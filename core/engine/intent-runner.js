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

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function formatNow(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}（${WEEKDAYS[date.getDay()]}）`;
}

function formatMessages(msgs) {
  return (msgs || []).map((m) => `${m.ts} ${m.name}: ${m.content}`).join('\n');
}

// 取该批次之前的一段消息当背景：只看新增消息时，模型无法知道「后来已经做完了」。
function historyBefore(contact, firstBatchId, limit = 12) {
  try {
    const page = chatDb.messages(contact, '', 60);
    const rows = (page && page.messages) || [];
    return rows.filter((m) => Number(m.id) < Number(firstBatchId)).slice(-limit);
  } catch {
    return [];
  }
}

// 过期的判断兜底：模型没标 expired、但截止时间已经过去很久的，不要变成待确认事项。
function staleReason(intent, now, staleDays) {
  const dueIso = intent.dueAt || intent.endAt;
  if (!dueIso) return '';
  const due = Date.parse(dueIso);
  if (!Number.isFinite(due)) return '';
  if (due >= now - staleDays * 86400000) return '';
  return `${intent.dueText || dueIso} 已经过去 ${Math.floor((now - due) / 86400000)} 天`;
}

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
  const now = opts.now instanceof Date ? opts.now : new Date();
  const nowMs = now.getTime();
  const staleDays = Number.isFinite(Number(intentCfg.staleDeadlineDays)) ? Math.max(0, Number(intentCfg.staleDeadlineDays)) : 2;
  let totalNew = 0;
  let totalScanned = 0;
  let totalStale = 0;

  for (const member of members) {
    const key = member.name;
    const since = state[key] || '';
    const page = chatDb.messagesSince(key, since, MAX_MSGS);
    const newMsgs = page ? page.messages : [];
    if (!newMsgs.length) continue;
    totalScanned += newMsgs.length;
    const batch = newMsgs;
    const chatText = formatMessages(batch);
    const contextMsgs = historyBefore(key, batch[0] && batch[0].id);
    const contextText = formatMessages(contextMsgs);
    console.log(`[intent] 扫描 ${key}，新增 ${newMsgs.length} 条`);
    log('info', 'intent', `扫描 ${key}，新增 ${newMsgs.length} 条`);

    const cloud = cloudIntentConfig(cfg);
    if (!cloud) {
      log('error', 'intent', 'DeepSeek 意图模型未配置 API Key，跳过本次扫描');
      continue;
    }
    const result = await taskRunner('intent', { chatText, contextText, sourceLabel: key, now: formatNow(now) }, {
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
      let skippedStale = 0;
      for (const item of arr) {
        const intent = buildIntent(item, key, batch);
        if (!intent) continue;
        // 已完成 / 已取消 / 已过期的，不进入待确认列表（模型标 expired，或截止时间过去太久）
        const stale = item.expired === true ? '模型判断已完成或已过期' : staleReason(intent, nowMs, staleDays);
        if (stale) {
          skippedStale++;
          totalStale++;
          log('info', 'intent', `跳过过期/已完成事项：${intent.summary}（${stale}）`);
          continue;
        }
        if (isDuplicate(intents, intent)) continue;
        intents.push(intent);
        added++;
        totalNew++;
        // 意图识别只生成“待确认建议”，不自动创建正式任务，也不自动入 DSH 执行队列。
        // 用户确认后由「任务」页/待确认页手动转为正式任务。
      }
      const staleText = skippedStale ? `，跳过过期/已完成 ${skippedStale} 条` : '';
      console.log(`[intent] ${key} 新增 ${added} 条意图${staleText}`);
      log('info', 'intent', `${key} 新增 ${added} 条意图${staleText}`);
    }

    // 只有成功处理后才推进游标
    state[key] = page.cursor;
    saveState(state);
    saveIntents(intents);
  }

  // 顺手清理：之前生成的待确认事项里，截止时间已经过去太久的，不要再留在「待确认」里刷屏
  let expired = 0;
  for (const item of intents) {
    if (item.status !== 'pending_confirm') continue;
    const why = staleReason(item, nowMs, staleDays);
    if (!why) continue;
    item.status = 'ignored';
    item.staleReason = why;
    item.updatedAt = new Date().toISOString();
    expired++;
  }
  if (expired) {
    saveIntents(intents);
    log('info', 'intent', `自动过期 ${expired} 条过期的待确认事项（改为已忽略）`);
  }

  console.log(`[intent] 本次扫描 ${totalScanned} 条消息，新增意图 ${totalNew} 条，跳过过期/已完成 ${totalStale} 条`);
  log('info', 'intent', `本次扫描 ${totalScanned} 条消息，新增意图 ${totalNew} 条，跳过过期/已完成 ${totalStale} 条`);
  await notifyNewIntents(intents, cfg);
  console.log('[intent] 完成');
  log('info', 'intent', '完成');
  return { totalNew, totalScanned, totalStale, expired };
}

module.exports = { runIntentExtraction, buildIntent, isDuplicate, formatNow, staleReason, historyBefore };
