// 主 Agent 会话管理器
// 负责：
//  - 应用启动时确保 DSH WebUI（3080）已启动；
//  - 把 conversations 中的主会话/微信会话映射到稳定的 DSH Web session；
//  - 每个会话内串行发送消息；运行中的微信会话允许 DSH steer 插话。
//  - 新 DSH Web 会话的首条消息注入「小鹈鹕人设 + 本地数据上下文」。
'use strict';

const dshWeb = require('./dsh-web-client');
const { buildReplyPrompt, formatContactContext, formatAttachmentContext, WEIXIN_MEDIA_INSTRUCTIONS } = require('./dsh-reply');
const { getContactContext, findMentionedContact } = require('./system-tools');

const queues = new Map(); // conversationKey -> tail Promise
const activeRuns = new Map();

function channelFor(sessionKey) {
  return String(sessionKey || '').startsWith('agent:main:weixin:') ? 'weixin' : 'webui';
}

function sessionIdForConversation(sessionKey, cwd = dshWeb.PROJECT_ROOT) {
  // 与 conversations 的 key 一一对应，例如：
  //   agent:main:webui:<id>  -> versioned stable session id
  //   agent:main:weixin:<user> -> versioned stable session id
  // salt = cwd，保证项目迁移后不继续复用旧目录的历史会话，也不会触发
  // “same sessionId + different cwd”的 DSH Web 冲突。
  return dshWeb.conversationSessionId(sessionKey, cwd, 'main');
}

async function ensureReady() {
  return dshWeb.launchWeb();
}

async function send({
  sessionKey,
  message,
  history = [],
  attachments = [],
  contact = '',
  cwd = dshWeb.PROJECT_ROOT,
  timeoutMs = 180000
} = {}) {
  const key = String(sessionKey || 'agent:main:webui:default');
  const sessionId = sessionIdForConversation(key, cwd);
  const msg = String(message || '').trim();
  const resolvedContact = contact || findMentionedContact(msg)?.name || '';
  let contactContext = '';
  if (resolvedContact) {
    try { contactContext = formatContactContext(getContactContext(resolvedContact)); } catch {}
  }
  const initialPrompt = buildReplyPrompt({
    message: msg,
    history,
    attachments,
    channel: channelFor(key),
    contact: resolvedContact || key,
    context: contactContext ? `当前联系人结构化上下文：\n${contactContext}` : ''
  });
  const promptMessage = contactContext ? `当前联系人结构化上下文（来自 SQLite）：\n${contactContext}\n\n用户消息：${msg}` : msg;
  const mediaPromptMessage = [channelFor(key) === 'weixin' ? WEIXIN_MEDIA_INSTRUCTIONS : '', formatAttachmentContext(attachments), promptMessage].filter(Boolean).join('\n\n');
  const previous = queues.get(key) || Promise.resolve();
  let resolveStarted;
  const run = { sessionId, cwd, accepting: true, started: false, ready: new Promise((resolve) => { resolveStarted = resolve; }) };
  run.resolveStarted = resolveStarted;
  if (!activeRuns.get(key)?.accepting) activeRuns.set(key, run);
  const job = previous.then(async () => {
    if (activeRuns.get(key) !== run) activeRuns.set(key, run);
    try {
      return await dshWeb.promptAndWait({
        sessionId,
        text: mediaPromptMessage,
        cwd,
        timeoutMs,
        initialPrompt,
        attachments,
        waitForTurnEnd: true,
        onPromptAccepted: () => {
          run.started = true;
          run.resolveStarted(true);
        },
        onEvent: (event) => {
          if (event && (event.type === 'turn/end' || event.type === 'session/error')) run.accepting = false;
        }
      });
    } finally {
      if (!run.started) run.resolveStarted(false);
      if (activeRuns.get(key) === run) activeRuns.delete(key);
    }
  });
  // 队列尾部吞掉错误，避免一条失败卡住后续消息
  queues.set(key, job.then(() => {}, () => {}));
  return job;
}

async function steer({ sessionKey, message, attachments = [], cwd = dshWeb.PROJECT_ROOT } = {}) {
  const key = String(sessionKey || 'agent:main:webui:default');
  const run = activeRuns.get(key);
  if (!run || !run.accepting) return { ok: false, error: '当前会话没有可插话的生成任务' };
  if ((!run.started && !(await run.ready)) || !run.accepting) return { ok: false, error: '当前会话没有可插话的生成任务' };
  const msg = String(message || '').trim();
  const mediaPromptMessage = [channelFor(key) === 'weixin' ? WEIXIN_MEDIA_INSTRUCTIONS : '', formatAttachmentContext(attachments), msg].filter(Boolean).join('\n\n');
  if (!mediaPromptMessage.trim()) return { ok: false, error: '插话内容不能为空' };
  const result = await dshWeb.sessionPrompt({
    sessionId: run.sessionId,
    text: mediaPromptMessage,
    attachments,
    mode: 'steer',
    cwd: run.cwd || cwd
  });
  if (!result.ok) run.accepting = false;
  return result;
}

// 流式版：同一会话内串行；新 DSH 事件通过 onEvent 实时推出。
async function sendStreaming({
  sessionKey,
  message,
  history = [],
  attachments = [],
  contact = '',
  cwd = dshWeb.PROJECT_ROOT,
  timeoutMs = 180000,
  onEvent = () => {}
} = {}) {
  const key = String(sessionKey || 'agent:main:webui:default');
  const sessionId = sessionIdForConversation(key, cwd);
  const msg = String(message || '').trim();
  const resolvedContact = contact || findMentionedContact(msg)?.name || '';
  let contactContext = '';
  if (resolvedContact) {
    try { contactContext = formatContactContext(getContactContext(resolvedContact)); } catch {}
  }
  const initialPrompt = buildReplyPrompt({
    message: msg,
    history,
    attachments,
    channel: channelFor(key),
    contact: resolvedContact || key,
    context: contactContext ? `当前联系人结构化上下文：\n${contactContext}` : ''
  });
  const promptMessage = contactContext ? `当前联系人结构化上下文（来自 SQLite）：\n${contactContext}\n\n用户消息：${msg}` : msg;
  const mediaPromptMessage = [channelFor(key) === 'weixin' ? WEIXIN_MEDIA_INSTRUCTIONS : '', formatAttachmentContext(attachments), promptMessage].filter(Boolean).join('\n\n');
  const previous = queues.get(key) || Promise.resolve();
  const job = previous.then(() => dshWeb.promptStreaming({
    sessionId,
    text: mediaPromptMessage,
    cwd,
    timeoutMs,
    onEvent,
    initialPrompt,
    attachments
  }));
  queues.set(key, job.then(() => {}, () => {}));
  return job;
}

function stop() {
  dshWeb.stopWeb();
}

module.exports = {
  ensureReady,
  send,
  steer,
  sendStreaming,
  stop,
  sessionIdForConversation
};
