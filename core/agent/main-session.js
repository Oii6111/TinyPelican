// 主 Agent 会话管理器
// 负责：
//  - 应用启动时确保 DSH WebUI（3080）已启动；
//  - 把 conversations 中的主会话/微信会话映射到稳定的 DSH Web session；
//  - 每个会话内串行发送消息，避免同一 session 并发乱序。
//  - 新 DSH Web 会话的首条消息注入「小鹈鹕人设 + 本地数据上下文」。
'use strict';

const dshWeb = require('./dsh-web-client');
const { buildReplyPrompt } = require('./dsh-reply');

const queues = new Map(); // conversationKey -> tail Promise

function channelFor(sessionKey) {
  return String(sessionKey || '').startsWith('agent:main:weixin:') ? 'weixin' : 'webui';
}

function sessionIdForConversation(sessionKey, cwd = dshWeb.PROJECT_ROOT) {
  // 与 conversations 的 key 一一对应，例如：
  //   agent:main:webui:<id>  -> session-xiaotihu-main-<hash(会话+项目目录)>
  //   agent:main:weixin:<user>  -> session-xiaotihu-main-<hash(会话+项目目录)>
  // salt = cwd，保证项目迁移后不继续复用旧目录的历史会话，也不会触发
  // “same sessionId + different cwd”的 DSH Web 冲突。
  return dshWeb.sessionIdForUser(sessionKey, 'xiaotihu-main', cwd);
}

async function ensureReady() {
  return dshWeb.launchWeb();
}

async function send({
  sessionKey,
  message,
  history = [],
  cwd = dshWeb.PROJECT_ROOT,
  timeoutMs = 180000
} = {}) {
  const key = String(sessionKey || 'agent:main:webui:default');
  const sessionId = sessionIdForConversation(key, cwd);
  const msg = String(message || '').trim();
  const initialPrompt = buildReplyPrompt({
    message: msg,
    history,
    channel: channelFor(key),
    contact: key
  });
  const previous = queues.get(key) || Promise.resolve();
  const job = previous.then(() => dshWeb.promptAndWait({
    sessionId,
    text: msg,
    cwd,
    timeoutMs,
    initialPrompt
  }));
  // 队列尾部吞掉错误，避免一条失败卡住后续消息
  queues.set(key, job.then(() => {}, () => {}));
  return job;
}

// 流式版：同一会话内串行；新 DSH 事件通过 onEvent 实时推出。
async function sendStreaming({
  sessionKey,
  message,
  history = [],
  cwd = dshWeb.PROJECT_ROOT,
  timeoutMs = 180000,
  onEvent = () => {}
} = {}) {
  const key = String(sessionKey || 'agent:main:webui:default');
  const sessionId = sessionIdForConversation(key, cwd);
  const msg = String(message || '').trim();
  const initialPrompt = buildReplyPrompt({
    message: msg,
    history,
    channel: channelFor(key),
    contact: key
  });
  const previous = queues.get(key) || Promise.resolve();
  const job = previous.then(() => dshWeb.promptStreaming({
    sessionId,
    text: msg,
    cwd,
    timeoutMs,
    onEvent,
    initialPrompt
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
  sendStreaming,
  stop,
  sessionIdForConversation
};
