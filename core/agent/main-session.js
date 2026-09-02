// 主 Agent 会话管理器
// 负责：
//  - 应用启动时确保 DSH WebUI（3080）已启动；
//  - 把 conversations 中的主会话/微信会话映射到稳定的 DSH Web session；
//  - 每个会话内串行发送消息，避免同一 session 并发乱序。
'use strict';

const dshWeb = require('./dsh-web-client');

const queues = new Map(); // conversationKey -> tail Promise

function sessionIdForConversation(sessionKey) {
  // 与 conversations 的 key 一一对应，例如：
  //   agent:main:webui:default  -> session-xiaotihu-main-<hash>
  //   agent:main:weixin:<user>  -> session-xiaotihu-main-<hash>
  return dshWeb.sessionIdForUser(sessionKey, 'xiaotihu-main');
}

async function ensureReady() {
  return dshWeb.launchWeb();
}

async function send({ sessionKey, message, cwd = dshWeb.PROJECT_ROOT, timeoutMs = 180000 } = {}) {
  const key = String(sessionKey || 'agent:main:webui:default');
  const sessionId = sessionIdForConversation(key);
  const previous = queues.get(key) || Promise.resolve();
  const job = previous.then(() => dshWeb.promptAndWait({
    sessionId,
    text: String(message || '').trim(),
    cwd,
    timeoutMs
  }));
  // 队列尾部吞掉错误，避免一条失败卡住后续消息
  queues.set(key, job.then(() => {}, () => {}));
  return job;
}

// 流式版：同一会话内串行；新 DSH 事件通过 onEvent 实时推出。
async function sendStreaming({
  sessionKey,
  message,
  cwd = dshWeb.PROJECT_ROOT,
  timeoutMs = 180000,
  onEvent = () => {}
} = {}) {
  const key = String(sessionKey || 'agent:main:webui:default');
  const sessionId = sessionIdForConversation(key);
  const previous = queues.get(key) || Promise.resolve();
  const job = previous.then(() => dshWeb.promptStreaming({
    sessionId,
    text: String(message || '').trim(),
    cwd,
    timeoutMs,
    onEvent
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
