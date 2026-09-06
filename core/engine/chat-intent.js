'use strict';

const { loadConfig } = require('../lib/config');
const { chatCompletion, runTask } = require('./client');
const { buildIntent } = require('./intent-runner');
const { readIntents, saveIntents } = require('../memory/stores/intents');
const tasks = require('../memory/stores/tasks');
const schedules = require('../memory/stores/schedules');
const chatDb = require('../memory/chat-db');

function isExplicitCommand(message) {
  return /^(请|请帮我|帮我|帮忙|替我|麻烦你|你帮我|直接|现在|立刻)/.test(String(message || '').trim())
    || /(帮我|替我|请你|请帮|直接执行|开始处理|整理并|修改并|搜索并|调研并|生成并)/.test(String(message || ''));
}

const ACTION_WORDS = /提醒|待办|任务|日程|安排|会议|开会|约会|截止|今天|今晚|明早|明天|后天|本周|下周|下个月|月底|帮我|请你|需要你|整理|修改|搜索|调研|研究|查一下|创建|添加|记得|别忘了|等回复/;

function shouldExtractChatIntent(message) {
  return ACTION_WORDS.test(String(message || ''));
}

function classifyDataQuery(message) {
  const text = String(message || '').trim();
  if (/(待确认意图|待确认事项|有哪些意图)/.test(text)) return 'pending_intent';
  const hasReminder = /(提醒|提醒事项)/.test(text);
  const hasSchedule = /(日程|会议安排|我的安排)/.test(text);
  const hasTodo = /(待办|待做|要做的事情)/.test(text);
  if (hasReminder && hasSchedule && !hasTodo) return 'reminder_schedule';
  if (hasReminder && !hasTodo && !hasSchedule) return 'reminder';
  if (hasSchedule && !hasTodo && !hasReminder) return 'schedule';
  if (hasTodo && !hasReminder && !hasSchedule) return 'todo';
  return 'overview';
}

function isDataQuery(message) {
  const text = String(message || '').trim();
  if (!/(待办|待做|提醒|日程|安排|待确认意图)/.test(text)) return false;
  if (/(创建|新建|添加|设置|安排我|提醒我|记得|别忘了|执行|处理)/.test(text)) return false;
  return /(现在|当前|目前|还有|有没有|有啥|有哪些|列出|查看|查询|告诉我|什么)/.test(text)
    || /^(待办|提醒|日程|安排)(事项|列表)?[呢吗？?！!。]*$/.test(text);
}

function queryRecords(scope) {
  const formalTasks = tasks.listTasks().filter((item) => item.status !== 'done');
  const formalSchedules = schedules.listSchedules().filter((item) => item.status !== 'done');
  const pendingIntents = readIntents().filter((item) => item.status === 'pending_confirm');
  if (scope === 'todo') return { todos: formalTasks.filter((item) => item.type !== 'reminder'), reminders: [], schedules: [], pendingIntents: [] };
  if (scope === 'reminder') return { todos: [], reminders: formalTasks.filter((item) => item.type === 'reminder'), schedules: [], pendingIntents: [] };
  if (scope === 'schedule') return { todos: [], reminders: [], schedules: formalSchedules, pendingIntents: [] };
  if (scope === 'reminder_schedule') return { todos: [], reminders: formalTasks.filter((item) => item.type === 'reminder'), schedules: formalSchedules, pendingIntents: [] };
  if (scope === 'pending_intent') return { todos: [], reminders: [], schedules: [], pendingIntents };
  return {
    todos: formalTasks.filter((item) => item.type !== 'reminder'),
    reminders: formalTasks.filter((item) => item.type === 'reminder'),
    schedules: formalSchedules,
    pendingIntents
  };
}

function compactRecord(item, kind) {
  const result = { type: kind, title: item.title || item.summary || '' };
  if (item.detail) result.detail = item.detail;
  if (kind === 'todo') {
    if (item.scheduledStartAt) result.scheduledStartAt = item.scheduledStartAt;
    if (item.dueAt) result.dueAt = item.dueAt;
    if (item.executionMode === 'dsh') result.aiProcessing = item.executionStatus || 'not_started';
  } else if (kind === 'reminder') {
    result.recurrence = item.kind === 'cron' ? item.cron : 'once';
    result.nextAt = item.kind === 'cron' ? item.nextAt : item.dueAt;
  } else if (kind === 'schedule') {
    result.startAt = item.startAt;
    if (item.endAt) result.endAt = item.endAt;
  } else {
    result.detail = item.detail || '';
    result.dueAt = item.dueAt || null;
    result.dueText = item.dueText || '';
    result.status = item.status;
  }
  return result;
}

function formatDataQueryFallback(scope, data) {
  const labels = { todo: '正式待办', reminder: '系统提醒', schedule: '日程', reminder_schedule: '提醒和日程', pending_intent: '待确认意图' };
  const groups = scope === 'todo' ? [['todo', data.todos]]
    : scope === 'reminder' ? [['reminder', data.reminders]]
      : scope === 'schedule' ? [['schedule', data.schedules]]
        : scope === 'reminder_schedule' ? [['reminder', data.reminders], ['schedule', data.schedules]]
        : scope === 'pending_intent' ? [['pending_intent', data.pendingIntents]]
          : [['todo', data.todos], ['reminder', data.reminders], ['schedule', data.schedules], ['pending_intent', data.pendingIntents]];
  const lines = [];
  for (const [kind, items] of groups) {
    if (!items.length) continue;
    lines.push(`【${labels[kind]}】`);
    for (const item of items) {
      const compact = compactRecord(item, kind);
      const time = compact.nextAt || compact.startAt || compact.dueAt || compact.dueText || '';
      lines.push(`- ${compact.title}${time ? `（${time}）` : ''}${compact.detail ? `：${compact.detail}` : ''}`);
    }
  }
  return lines.length ? lines.join('\n') : `当前没有${labels[scope] || '正式事项'}。`;
}

async function answerDataQuery(message, config) {
  const scope = classifyDataQuery(message);
  const data = queryRecords(scope);
  const fallback = formatDataQueryFallback(scope, data);
  const cfg = deepseekConfig(config);
  if (!cfg) return { ok: true, text: fallback, scope, data, model: false };
  const intentCfg = cfg.intent || {};
  const provider = cfg.engine.providers[intentCfg.provider || 'deepseek'] || {};
  const payload = {
    todos: data.todos.slice(0, 50).map((item) => compactRecord(item, 'todo')),
    reminders: data.reminders.slice(0, 50).map((item) => compactRecord(item, 'reminder')),
    schedules: data.schedules.slice(0, 50).map((item) => compactRecord(item, 'schedule')),
    pendingIntents: data.pendingIntents.slice(0, 50).map((item) => compactRecord(item, 'pending_intent'))
  };
  const result = await chatCompletion([
    {
      role: 'system',
      content: '你是小鹈鹕的数据查询助手。只能依据系统提供的 JSON 数据回答，不得读取文件、调用工具或猜测不存在的事项。必须严格区分正式待办、系统提醒、日程和待确认意图；用户只问待办时不要混入提醒、日程或待确认意图。用简洁中文分组列出具体条目，没有数据就明确说没有。'
    },
    { role: 'user', content: `用户问题：${message}\n查询范围：${scope}\n系统正式数据：${JSON.stringify(payload)}` }
  ], {
    config: cfg,
    model: intentCfg.queryModel || intentCfg.model || provider.model || 'deepseek-chat',
    timeoutMs: intentCfg.queryTimeoutMs || 30000,
    temperature: 0.1
  });
  return { ok: true, text: result.ok ? result.text : fallback, scope, data, model: result.ok };
}

function deepseekConfig(config) {
  const cfg = config || loadConfig();
  const intentCfg = cfg.intent || {};
  const providerName = intentCfg.provider || 'deepseek';
  const providers = (cfg.engine && cfg.engine.providers) || {};
  const provider = providers[providerName];
  if (!provider || !provider.apiKey) return null;
  return {
    ...cfg,
    engine: {
      ...(cfg.engine || {}),
      provider: providerName,
      providers: { ...providers, [providerName]: provider }
    }
  };
}

function messageText(history, message) {
  const lines = (history || []).map((item) => {
    const role = item.role === 'bot' || item.role === 'assistant' ? '小鹈鹕' : '用户';
    return `${item.ts || ''} ${role}: ${item.text || item.content || ''}`.trim();
  });
  lines.push(`${new Date().toISOString()} 用户: ${message}`);
  return lines.join('\n');
}

function localSourceTs() {
  const d = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function duplicate(intents, intent) {
  return intents.some((item) =>
    item.source && intent.source &&
    item.source.channel === intent.source.channel &&
    item.source.session === intent.source.session &&
    item.source.ts === intent.source.ts &&
    item.type === intent.type &&
    item.summary === intent.summary
  );
}

async function extractChatIntents({ message, history = [], session, channel = 'webui', config, origin = 'direct_message', persist = true }) {
  if (!shouldExtractChatIntent(message)) return { ok: true, intents: [], skipped: true };
  const cfg = deepseekConfig(config);
  if (!cfg) return { ok: false, error: 'DeepSeek 意图模型未配置 API Key' };
  const intentCfg = cfg.intent || {};
  const sourceLabel = `${channel}:${session || 'default'}`;
  const result = await runTask('intent', {
    chatText: messageText(history, message),
    sourceLabel
  }, {
    config: cfg,
    model: intentCfg.model || (cfg.engine.providers[intentCfg.provider || 'deepseek'] && cfg.engine.providers[intentCfg.provider || 'deepseek'].model) || 'deepseek-chat',
    timeoutMs: intentCfg.chatTimeoutMs || intentCfg.agentTimeoutMs || 120000
  });
  if (!result.ok) return result;
  if (!Array.isArray(result.array) || !result.array.length) return { ok: true, intents: [] };

  const now = localSourceTs();
  const sourceMessages = [{ ts: now, content: message, type: 'text' }];
  const items = readIntents();
  const created = [];
  for (const item of result.array) {
    const intent = buildIntent(item, sourceLabel, sourceMessages, { origin });
    if (!intent) continue;
    intent.source.channel = channel;
    intent.source.session = session || '';
    intent.source.origin = origin;
    if (duplicate(items, intent)) continue;
    items.push(intent);
    created.push(intent);
  }
  if (persist && created.length) saveIntents(items);
  return { ok: true, intents: created };
}

function latestPendingIntent(session, channel = 'webui') {
  const sourceSession = session || '';
  return readIntents()
    .filter((item) => item.status === 'pending_confirm' && item.source && item.source.session === sourceSession && (item.source.channel || 'webui') === channel)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0] || null;
}

function isConfirmMessage(message) {
  return /^(确认|确认执行|执行吧|就这样|可以|可以执行|好|好的|好的执行|同意|批准|确定)(提醒|待办|任务|日程)?(吧|了)?[。！!，, ]*$/.test(String(message || '').trim());
}

function isIgnoreMessage(message) {
  return /^(忽略|取消|不要执行|不执行|算了|跳过)(吧|了)?[。！!，, ]*$/.test(String(message || '').trim());
}

// 新联系人通知后的补充信息可以直接回复给 Agent，例如“备注：妈妈，描述：我的母亲”。
// 这类消息不是待办意图，应在进入模型前落到联系人画像，避免被当作普通闲聊丢失。
function parseContactProfileMessage(message) {
  const text = String(message || '').trim();
  if (!text || !/(备注|描述|画像|社交目标)/.test(text)) return null;
  const remarkMatch = text.match(/(?:给|为)\s*(?:联系人)?\s*([^\s，,：:]{1,30})\s*备注(?:为|是|：|:)?\s*([^，,；;\n]+)/)
    || text.match(/^([^\s，,：:]{1,30})\s*备注(?:为|是|：|:)?\s*([^，,；;\n]+)/)
    || text.match(/^(?:联系人)?\s*备注(?:为|是|：|:)\s*([^，,；;\n]+)/)
    || text.match(/^(?:联系人)?\s*备注\s*([^，,；;\n]+)/);
  const descriptionMatch = text.match(/(?:描述|画像|说明)(?:为|是|：|:)\s*([^；;\n]+)/)
    || text.match(/(?:描述|画像|说明)\s*([^；;\n]+)/);
  const goalMatch = text.match(/社交目标(?:为|是|：|:)\s*([^；;\n]+)/);
  const goalContactMatch = text.match(/(?:给|为)\s*([^\s，,：:]{1,30})\s*(?:设置|更新)?社交目标(?:为|是|：|:)\s*([^；;\n]+)/);
  const startsWithRemark = /^(?:联系人)?\s*备注(?:为|是|：|:)/.test(text);
  if (!remarkMatch && !descriptionMatch && !goalMatch && !goalContactMatch) return null;
  let contact = remarkMatch && remarkMatch[2] ? remarkMatch[1].trim() : '';
  const remarkValue = remarkMatch && remarkMatch[2] ? remarkMatch[2] : (remarkMatch && remarkMatch[1]);
  if (startsWithRemark) contact = '';
  const patch = {};
  if (remarkValue) patch.remark = remarkValue.trim();
  if (descriptionMatch && descriptionMatch[1]) {
    patch.profile = patch.profile || {};
    patch.profile['描述'] = descriptionMatch[1].trim();
  }
  if (goalMatch && goalMatch[1]) {
    patch.profile = patch.profile || {};
    patch.socialGoal = goalMatch[1].trim();
    patch.profile['社交目标'] = goalMatch[1].trim();
  }
  if (goalContactMatch && goalContactMatch[2]) {
    patch.profile = patch.profile || {};
    contact = goalContactMatch[1].trim();
    patch.socialGoal = goalContactMatch[2].trim();
    patch.profile['社交目标'] = goalContactMatch[2].trim();
  }
  return { contact, patch };
}

function applyContactProfileMessage(message) {
  const parsed = parseContactProfileMessage(message);
  if (!parsed) return null;
  let member = parsed.contact ? chatDb.getMember(parsed.contact) : null;
  if (!member) member = chatDb.findUnannotatedMember();
  if (!member) return { ok: false, error: '未找到需要补充资料的联系人' };
  const updated = chatDb.updateMember(member.name, parsed.patch);
  if (!updated) return { ok: false, error: '联系人资料更新失败' };
  const labels = [];
  if (parsed.patch.remark) labels.push(`备注为“${parsed.patch.remark}”`);
  if (parsed.patch.profile && parsed.patch.profile['描述']) labels.push('已补充描述');
  if (parsed.patch.socialGoal) labels.push('已更新社交目标');
  return { ok: true, contact: updated, text: `已更新联系人「${updated.remark || updated.name}」：${labels.join('，') || '资料已保存'}。` };
}

async function handleConversationIntent({ message, history = [], session, channel = 'webui', config }) {
  const profileUpdate = applyContactProfileMessage(message);
  if (profileUpdate) {
    return profileUpdate.ok
      ? { handled: true, ok: true, text: profileUpdate.text, profileUpdate }
      : { handled: true, ok: false, error: profileUpdate.error };
  }
  const pending = latestPendingIntent(session, channel);
  if (pending && isConfirmMessage(message)) {
    const { confirmIntent } = require('./intent-actions');
    const result = confirmIntent(pending.id);
    if (!result.ok) return { handled: true, ok: false, error: result.error };
    const targetLabel = result.targetType === 'schedule'
      ? '日程'
      : result.targetType === 'reminder' ? '提醒' : '待办';
    const nextStep = result.targetType === 'todo' && result.target && result.target.action
      ? '如需让 AI 处理，请在待办列表中点击“开始 AI 处理”。'
      : '';
    return {
      handled: true,
      ok: true,
      text: `已确认：${pending.summary}\n已创建${targetLabel}。${nextStep}`,
      result
    };
  }
  if (pending && isIgnoreMessage(message)) {
    const items = readIntents();
    const target = items.find((item) => item.id === pending.id);
    if (target) {
      target.status = 'ignored';
      target.updatedAt = new Date().toISOString();
      saveIntents(items);
    }
    return { handled: true, ok: true, text: `已忽略：${pending.summary}` };
  }

  if (isDataQuery(message)) {
    const result = await answerDataQuery(message, config);
    return { handled: true, ok: true, text: result.text, query: result };
  }

  const extracted = await extractChatIntents({
    message,
    history,
    session,
    channel,
    config,
    origin: 'direct_message',
    persist: false
  });
  if (extracted.ok && extracted.intents && extracted.intents.length) {
    const dshIntent = extracted.intents.find((intent) =>
      intent.type === 'todo' && intent.execution && intent.execution.mode === 'dsh' && isExplicitCommand(message));
    if (dshIntent) {
      const items = readIntents();
      const recorded = {
        ...dshIntent,
        status: 'auto_dispatched',
        updatedAt: new Date().toISOString()
      };
      saveIntents([...items.filter((item) => item.id !== recorded.id), recorded]);
      return {
        handled: false,
        ok: true,
        dispatchDsh: true,
        dshPrompt: buildDshPrompt(dshIntent, message),
        intent: recorded
      };
    }

    const { materializeIntent } = require('./intent-actions');
    const targets = [];
    for (const intent of extracted.intents) {
      const result = materializeIntent(intent, { direct: true });
      if (result.ok) targets.push(result);
    }
    return { handled: true, ok: true, text: formatDirectReply(targets), targets };
  }
  return { handled: !extracted.ok, ok: extracted.ok, error: extracted.error || '' };
}

function buildDshPrompt(intent, originalMessage) {
  const action = intent.action || {};
  return [
    '请立即执行下面这条用户指令。',
    `用户原话：${String(originalMessage || '').trim()}`,
    `执行类型：${intent.type}`,
    `执行说明：${action.instruction || intent.execution?.instruction || intent.summary}`,
    action.inputs ? `结构化输入：${JSON.stringify(action.inputs)}` : '',
    '这是用户直接发出的执行请求，请完成实际工作并用简洁中文汇报结果。'
  ].filter(Boolean).join('\n');
}

function formatDirectReply(results) {
  const lines = [];
  for (const result of results) {
    const label = result.targetType === 'schedule' ? '日程' : (result.targetType === 'reminder' ? '提醒' : '待办');
    lines.push(`已创建${label}：${result.target.title || result.target.summary}`);
  }
  return lines.length ? lines.join('\n') : '已记录，没有需要立即执行的事项。';
}

function formatIntentReply(intents) {
  const lines = ['我识别到以下事项，请确认后处理：'];
  for (const item of intents) {
    const target = item.type === 'schedule' ? '加入日历' : (item.type === 'reminder' ? '创建提醒' : '创建待办');
    const time = item.dueText || (item.dueAt ? item.dueAt : '未设置具体时间');
    lines.push(`• ${item.summary}（${target}，时间：${time}）`);
    if (item.execution && item.execution.mode === 'dsh') lines.push(`  可由 AI 处理：${item.execution.instruction || item.summary}`);
  }
  lines.push('请回复“确认执行”，或到「主动仪表盘 → 待确认意图」中修改后确认。');
  return lines.join('\n');
}

module.exports = {
  extractChatIntents,
  latestPendingIntent,
  isConfirmMessage,
  isIgnoreMessage,
  handleConversationIntent,
  formatIntentReply,
  buildDshPrompt,
  isExplicitCommand,
  shouldExtractChatIntent,
  isDataQuery,
  classifyDataQuery,
  queryRecords,
  answerDataQuery,
  parseContactProfileMessage,
  applyContactProfileMessage
};
