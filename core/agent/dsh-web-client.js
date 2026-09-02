// DSH WebUI 常驻进程客户端
// 通过 dsh --profile web 暴露的 /api RPC 与同一个常驻 Agent/Session 交互，
// 避免每次任务都 spawn `dsh --profile headless` 子进程。
'use strict';

const crypto = require('crypto');
const path = require('path');
const { spawn } = require('child_process');
const { findDshBin } = require('./dsh-client');

const DEFAULT_BASE = process.env.DSH_WEB_URL || 'http://127.0.0.1:3080';
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

const sessionCache = new Map();
const workspaceCache = new Map();

let rpcSeq = 0;
function nextRpcId() {
  rpcSeq += 1;
  return 'xiaotihu-' + Date.now() + '-' + rpcSeq + '-' + crypto.randomBytes(2).toString('hex');
}

async function rpc(method, payload = {}, base = DEFAULT_BASE) {
  const res = await fetch(`${base.replace(/\/+$/, '')}/api/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: nextRpcId(),
      method,
      payload
    })
  });
  if (!res.ok) {
    let text = '';
    try { text = await res.text(); } catch {}
    return { ok: false, error: `DSH Web API HTTP ${res.status} ${text.slice(0, 200)}` };
  }
  const data = await res.json().catch(() => null);
  if (!data || data.type !== 'server-response') {
    return { ok: false, error: 'DSH Web API 返回了无法识别的响应' };
  }
  return data.result && data.result.ok
    ? { ok: true, value: data.result.value }
    : { ok: false, error: (data.result && data.result.error && (data.result.error.message || JSON.stringify(data.result.error))) || 'DSH Web API 业务失败' };
}

function sessionIdForUser(userId, prefix = 'xiaotihu-wechat', salt = '') {
  const material = `${salt || ''}\n${String(userId || 'default')}`;
  const safe = crypto.createHash('sha1').update(material).digest('hex').slice(0, 12);
  return `session-${prefix}-${safe}`;
}

// 确保项目目录已注册为 DSH Web workspace；workspace.create 对已存在路径幂等。
async function ensureWorkspace({ cwd = PROJECT_ROOT, base = DEFAULT_BASE } = {}) {
  const key = `${base}|${cwd}`;
  if (workspaceCache.has(key)) return { ok: true, value: { workspaceId: workspaceCache.get(key) } };
  const r = await rpc('workspace.create', { path: cwd }, base);
  if (r.ok && r.value && r.value.workspace && r.value.workspace.workspaceId) {
    workspaceCache.set(key, r.value.workspace.workspaceId);
    return { ok: true, value: { workspaceId: r.value.workspace.workspaceId } };
  }
  return r;
}

// 创建/复用会话。session.create 对同一 sessionId + workspace/cwd 是幂等恢复。
async function ensureSession({ sessionId, cwd = PROJECT_ROOT, base = DEFAULT_BASE } = {}) {
  const wsKey = `${base}|${cwd}`;
  const key = `${base}|${sessionId}|${cwd}`;
  if (sessionCache.has(key)) return { ok: true, value: { sessionId } };

  // 先确保项目路径是 DSH Web workspace，再创建/恢复 session。
  const ws = await ensureWorkspace({ cwd, base });
  if (ws.ok) {
    const r = await rpc('session.create', {
      sessionId,
      workspaceId: ws.value.workspaceId
    }, base);
    if (r.ok) {
      sessionCache.set(key, r.value.sessionId || sessionId);
      return { ok: true, value: { sessionId: r.value.sessionId || sessionId } };
    }
    return r;
  }

  // workspace 注册失败时回退为 cwd 创建，尽量不中断。
  const fallback = await rpc('session.create', { sessionId, cwd }, base);
  if (fallback.ok) sessionCache.set(key, fallback.value.sessionId || sessionId);
  return fallback;
}

function assistantText(entry) {
  const ev = entry && entry.event ? entry.event : entry;
  if (!ev || ev.type !== 'assistant/message') return null;
  const data = ev.data || {};
  const msg = data.message || {};
  const blocks = Array.isArray(msg.content) ? msg.content : [];
  const parts = blocks
    .filter((b) => b && b.type === 'text' && b.text)
    .map((b) => String(b.text).trim())
    .filter(Boolean);
  return parts.length ? parts.join('\n').trim() : null;
}

function historyHasUserMessage(result) {
  if (!result || !result.ok || !result.value || !Array.isArray(result.value.events)) return false;
  return result.value.events.some((entry) => {
    const ev = entry && entry.event ? entry.event : entry;
    return !!ev && ev.type === 'user/message';
  });
}

async function promptAndWait({
  sessionId,
  text,
  cwd = PROJECT_ROOT,
  timeoutMs = 180000,
  pollMs = 600,
  base = DEFAULT_BASE,
  initialPrompt = ''
} = {}) {
  const ensured = await ensureSession({ sessionId, cwd, base });
  if (!ensured.ok) return { ok: false, error: `DSH Web 会话不可用：${ensured.error || ''}` };

  // 记录发送前最新 seq，之后只认新产生的事件。
  const before = await rpc('session.history', { sessionId, maxMessages: 100 }, base);
  let beforeSeq = -1;
  if (before.ok && before.value && Array.isArray(before.value.events)) {
    for (const entry of before.value.events) {
      const ev = entry && entry.event ? entry.event : entry;
      if (ev && typeof ev.seq === 'number' && ev.seq > beforeSeq) beforeSeq = ev.seq;
    }
  }

  // 新会话第一次发言时把「小鹈鹕人设 + 上下文」作为完整 prompt 注入；
  // 之后该 DSH Web 会话已有历史，只发送用户原话，避免重复膨胀。
  const hasUser = historyHasUserMessage(before);
  const promptText = String((initialPrompt && !hasUser ? initialPrompt : text) || '').trim();
  if (!promptText) return { ok: false, error: 'DSH Web 空消息' };

  const sent = await rpc('session.prompt', {
    sessionId,
    mode: 'queue',
    content: [{ type: 'text', text: promptText }]
  }, base);
  if (!sent.ok) {
    return { ok: false, error: sent.error || 'DSH Web prompt 发送失败' };
  }

  const startedAt = Date.now();
  const eventMap = new Map(); // seq -> raw event object
  while (Date.now() - startedAt < timeoutMs) {
    const h = await rpc('session.history', { sessionId, maxMessages: 100 }, base);
    if (h.ok && Array.isArray(h.value.events)) {
      let foundText = null;
      for (const entry of h.value.events) {
        const ev = entry && entry.event ? entry.event : entry;
        if (!ev || typeof ev.seq !== 'number' || ev.seq <= beforeSeq) continue;
        eventMap.set(ev.seq, ev);
        if (ev.type === 'assistant/message') {
          const textOut = assistantText(entry);
          if (textOut) foundText = textOut;
        }
      }
      if (foundText) {
        const events = [...eventMap.values()].sort((a, b) => a.seq - b.seq);
        return { ok: true, text: foundText, sessionId, mode: 'dsh-web', events };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  return { ok: false, error: 'DSH Web 回复超时', sessionId };
}

// 流式版：一边轮询 DSH Web history，一边把新事件通过 onEvent 推给调用方。
async function promptStreaming({
  sessionId,
  text,
  cwd = PROJECT_ROOT,
  timeoutMs = 180000,
  pollMs = 400,
  base = DEFAULT_BASE,
  onEvent = () => {},
  initialPrompt = ''
} = {}) {
  const ensured = await ensureSession({ sessionId, cwd, base });
  if (!ensured.ok) return { ok: false, error: `DSH Web 会话不可用：${ensured.error || ''}` };

  const before = await rpc('session.history', { sessionId, maxMessages: 100 }, base);
  let beforeSeq = -1;
  if (before.ok && before.value && Array.isArray(before.value.events)) {
    for (const entry of before.value.events) {
      const ev = entry && entry.event ? entry.event : entry;
      if (ev && typeof ev.seq === 'number' && ev.seq > beforeSeq) beforeSeq = ev.seq;
    }
  }

  const hasUser = historyHasUserMessage(before);
  const promptText = String((initialPrompt && !hasUser ? initialPrompt : text) || '').trim();
  if (!promptText) return { ok: false, error: 'DSH Web 空消息' };

  const sent = await rpc('session.prompt', {
    sessionId,
    mode: 'queue',
    content: [{ type: 'text', text: promptText }]
  }, base);
  if (!sent.ok) return { ok: false, error: sent.error || 'DSH Web prompt 发送失败' };

  const startedAt = Date.now();
  const seen = new Set();
  while (Date.now() - startedAt < timeoutMs) {
    const h = await rpc('session.history', { sessionId, maxMessages: 100 }, base);
    if (h.ok && Array.isArray(h.value.events)) {
      let foundText = null;
      for (const entry of h.value.events) {
        const ev = entry && entry.event ? entry.event : entry;
        if (!ev || typeof ev.seq !== 'number' || ev.seq <= beforeSeq || seen.has(ev.seq)) continue;
        seen.add(ev.seq);
        try { onEvent(ev); } catch {}
        if (ev.type === 'assistant/message') {
          const textOut = assistantText(ev);
          if (textOut) foundText = textOut;
        }
      }
      if (foundText) return { ok: true, text: foundText, sessionId, mode: 'dsh-web-stream' };
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  return { ok: false, error: 'DSH Web 回复超时', sessionId };
}

// 微信/任务统一入口：userId 用来派生稳定会话；cwd 默认项目工作区。
async function ask({ userId, text, cwd = PROJECT_ROOT, timeoutMs = 180000, base = DEFAULT_BASE, initialPrompt = '' } = {}) {
  const sessionId = sessionIdForUser(userId, 'xiaotihu-wechat', cwd);
  return promptAndWait({ sessionId, text, cwd, timeoutMs, base, initialPrompt });
}

let webChild = null;

async function isReachable(base = DEFAULT_BASE, timeoutMs = 1500) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${base.replace(/\/+$/, '')}/api/host.describe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: nextRpcId(), method: 'host.describe', payload: {} }),
      signal: ctrl.signal
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// 启动 dsh web（只在 3080 未就绪时拉起）；返回是否由本次启动。
async function launchWeb({ port = 3080, base = DEFAULT_BASE } = {}) {
  if (await isReachable(base, 1200)) return { ok: true, started: false, child: null };
  const bin = findDshBin();
  webChild = spawn(process.execPath, [bin, 'web', '--port', String(port)], {
    stdio: 'ignore',
    windowsHide: true
  });
  webChild.on('error', () => {});
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (await isReachable(base, 800)) return { ok: true, started: true, child: webChild };
    await new Promise((r) => setTimeout(r, 500));
  }
  try { webChild.kill(); } catch {}
  webChild = null;
  return { ok: false, error: 'DSH WebUI 启动超时' };
}

function stopWeb() {
  if (webChild) {
    try { webChild.kill(); } catch {}
    webChild = null;
  }
}


module.exports = {
  rpc,
  ensureSession,
  ensureWorkspace,
  promptAndWait,
  promptStreaming,
  ask,
  sessionIdForUser,
  assistantText,
  isReachable,
  launchWeb,
  stopWeb,
  PROJECT_ROOT,
  DEFAULT_BASE
};
