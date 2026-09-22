// DSH WebUI 常驻进程客户端
// 通过 dsh web 暴露的 /api RPC 与同一个常驻 Agent/Session 交互，
// 避免每次任务都 spawn `dsh --profile headless` 子进程。
// 对接 dsh 0.1.5+ 的 WebUI：
//   1. 内置 BrowserAuth：/api 需要签名 cookie（令牌取自 `dsh web` 打印的 ?token=，见 dsh-web-auth.js）；
//   2. 接口是 Typert Remote 风格：路径 `<namespace>/<method>`，载荷 `payload.args = { <参数名>: request }`。
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { findDshBin, buildDshEnv } = require('./dsh-client');
const webAuth = require('./dsh-web-auth');
const { log } = require('../lib/log');
const { loadConfig } = require('../lib/config');

const DEFAULT_BASE = process.env.DSH_WEB_URL || 'http://127.0.0.1:3080';
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

const sessionCache = new Map();
const workspaceCache = new Map();
const paramNames = new Map();     // 'ns/method' -> 参数名（各控制器不统一：request / _request）

function normalizeBase(base) {
  return String(base || DEFAULT_BASE).replace(/\/+$/, '');
}

let rpcSeq = 0;
function nextRpcId() {
  rpcSeq += 1;
  return 'tinypelican-' + Date.now() + '-' + rpcSeq + '-' + crypto.randomBytes(2).toString('hex');
}

// 带鉴权的 POST：cookie 走缓存（或令牌兑换）；401 时兑换一次再重试。
// 网络层失败（DSH 还没起来 / 刚被重启）会先等它就绪再重试——这是「DSH 没拉起」最常见的表现：
// isReachable 探测通过、但真正请求时连接被拒（fetch failed）。
async function postJson(base, endpoint, message, { timeoutMs = 0, allowReload = true } = {}) {
  const url = `${normalizeBase(base)}/api/${endpoint}`;
  const send = () => {
    const headers = { 'Content-Type': 'application/json' };
    const cookie = webAuth.cookieFor(base);
    if (cookie) headers.Cookie = cookie;
    const init = { method: 'POST', headers, body: JSON.stringify(message) };
    if (timeoutMs > 0) {
      const ctrl = new AbortController();
      init.signal = ctrl.signal;
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      if (timer.unref) timer.unref();
    }
    return fetch(url, init);
  };

  let res;
  try {
    res = await send();
  } catch (e) {
    if (!allowReload) throw e;
    // 让 DSH 有机会起来（或等已经在后台启动中的那次完成），再重试一次
    await ensureWebReady({ base, waitMs: 60000 });
    res = await send();
  }
  if (res.status === 401) {
    const cookie = await webAuth.ensureCookie({ base, force: true });
    if (cookie) res = await send();
  }
  return res;
}

function envelopeV2(endpoint, request, param = 'request') {
  return {
    type: 'client-request',
    rpcId: nextRpcId(),
    method: endpoint,
    payload: { args: { [param]: request } }
  };
}

async function readEnvelope(res) {
  if (!res.ok) {
    let text = '';
    try { text = await res.text(); } catch {}
    if (res.status === 401) {
      return {
        ok: false,
        status: 401,
        error: `DSH Web API HTTP 401 unauthorized｜${webAuth.unauthorizedHint(res.url || '')}`
      };
    }
    return { ok: false, status: res.status, error: `DSH Web API HTTP ${res.status} ${text.slice(0, 200)}` };
  }
  const data = await res.json().catch(() => null);
  if (!data || data.type !== 'server-response') {
    return { ok: false, status: res.status, error: 'DSH Web API 返回了无法识别的响应' };
  }
  return data.result && data.result.ok
    ? { ok: true, status: res.status, value: data.result.value }
    : {
      ok: false,
      status: res.status,
      error: (data.result && data.result.error && (data.result.error.message || JSON.stringify(data.result.error))) || 'DSH Web API 业务失败'
    };
}

// Typert Remote 调用：参数名各控制器不统一（request / _request），按服务端提示自动纠正并记住
async function rpcV2(namespace, method, request = {}, base = DEFAULT_BASE) {
  const endpoint = `${namespace}/${method}`;
  const call = (param) => postJson(base, endpoint, envelopeV2(endpoint, request, param)).then(readEnvelope);

  let result = await call(paramNames.get(endpoint) || 'request');
  const missing = !result.ok && /missing "([_A-Za-z][\w]*)"/.exec(result.error || '');
  if (missing) {
    paramNames.set(endpoint, missing[1]);
    result = await call(missing[1]);
  }
  if (!result.ok && result.status === 404) {
    return { ...result, error: `${result.error}（DSH WebUI 接口不存在：请把 dsh 升级到 0.1.5 及以上）` };
  }
  return result;
}

// 会话 id 代次：同一条会话 key 永远映射同一个 id（会话历史靠它续上）。
// v2 那批会话的文件被从 DSH 外部清掉过，DSH 里仍记着这些 id 但落盘会 ENOENT，
// 所以整体换到 v3；以后再遇到「会话文件被绕过 DSH 删除」，把这一个常量 +1 即可。
const SESSION_GENERATION = 'v3';

function sessionIdForUser(userId, prefix = `tinypelican-wechat-${SESSION_GENERATION}`, salt = '') {
  const material = `${salt || ''}\n${String(userId || 'default')}`;
  const safe = crypto.createHash('sha1').update(material).digest('hex').slice(0, 12);
  return `session-${prefix}-${safe}`;
}

// 统一入口：kind = 'main'（看板/微信主会话）| 'wechat'（微信兜底回复）
function conversationSessionId(sessionKey, cwd, kind = 'main') {
  return sessionIdForUser(sessionKey, `tinypelican-${kind}-${SESSION_GENERATION}`, cwd);
}

// 确保项目目录已注册为 DSH Web workspace；对已存在路径幂等。
async function ensureWorkspace({ cwd = PROJECT_ROOT, base = DEFAULT_BASE } = {}) {
  const key = `${base}|${cwd}`;
  if (workspaceCache.has(key)) return { ok: true, value: { workspaceId: workspaceCache.get(key) } };

  const r = await rpcV2('workspace', 'create', { path: cwd }, base);
  if (r.ok && r.value && r.value.workspace && r.value.workspace.workspaceId) {
    workspaceCache.set(key, r.value.workspace.workspaceId);
    return { ok: true, value: { workspaceId: r.value.workspace.workspaceId } };
  }
  return r;
}

// 创建/复用会话。对同一 sessionId + workspace/cwd 是幂等恢复。
async function ensureSession({ sessionId, cwd = PROJECT_ROOT, base = DEFAULT_BASE } = {}) {
  const key = `${base}|${sessionId}|${cwd}`;
  if (sessionCache.has(key)) return { ok: true, value: { sessionId } };
  const createSession = (payload) => rpcV2('session', 'create', payload, base);

  // 先确保项目路径是 DSH Web workspace，再创建/恢复 session。
  const ws = await ensureWorkspace({ cwd, base });
  if (ws.ok) {
    const r = await createSession({
      sessionId,
      workspaceId: ws.value.workspaceId
    });
    if (r.ok) {
      sessionCache.set(key, r.value.sessionId || sessionId);
      return { ok: true, value: { sessionId: r.value.sessionId || sessionId } };
    }
    return r;
  }

  // workspace 注册失败时回退为 cwd 创建，尽量不中断。
  const fallback = await createSession({ sessionId, cwd });
  if (fallback.ok) sessionCache.set(key, fallback.value.sessionId || sessionId);
  return fallback;
}

// 读会话历史：session/page 需要先要一个游标（取事件的当前序号）
// 注意 maxMessages 要小：page 是「从末尾往回数 N 条消息」，N 大一次能拉回上兆字节
// （一个会话里 request/context、assistant/message 这类事件都很胖），轮询时会把 DSH 拖慢。
async function sessionHistory({ sessionId, maxMessages = 4, base = DEFAULT_BASE } = {}) {
  const cursor = await sessionCursor({ sessionId, base });
  if (cursor < 0) return { ok: true, value: { events: [] } };
  const page = await rpcV2('session', 'page', {
    address: { kind: 'session', sessionId },
    throughSeq: cursor,
    maxMessages
  }, base);
  if (!page.ok) return page;
  const records = (page.value && page.value.records) || [];
  // 统一成 { events: [{ event }] }，上层的事件解析逻辑与旧接口保持一致
  return { ok: true, value: { events: records.map((r) => ({ event: r.event })) } };
}

// 会话当前事件游标：用一次「故意越界」的 page 问出来——服务端会回
// `through seq N is past cursor C`，比 session/list（一次返回全部 50+ 会话、近百 KB）轻得多。
async function sessionCursor({ sessionId, base = DEFAULT_BASE } = {}) {
  const probe = await rpcV2('session', 'page', {
    address: { kind: 'session', sessionId },
    throughSeq: Number.MAX_SAFE_INTEGER,
    maxMessages: 1
  }, base);
  const m = /past cursor (-?\d+)/.exec((probe && probe.error) || '');
  return m ? Number(m[1]) : -1;
}

// 发消息：新版必须带 requestId。
// 会话在 DSH 侧被清掉/删除时（比如用户手动清了对话），这里自动重建一次再重试，
// 否则那条消息会直接失败、而且要等核心重启才能恢复。
async function sessionPrompt({ sessionId, text, mode = 'queue', base = DEFAULT_BASE, cwd = '' } = {}) {
  const content = [{ type: 'text', text }];
  const request = {
    requestId: nextRpcId(),
    sessionId,
    mode,
    content
  };
  const first = await rpcV2('session', 'prompt', request, base);
  if (first.ok || !/not.?found|no such session|unknown session/i.test(first.error || '')) return first;

  const recreated = await rpcV2('session', 'create', cwd ? { sessionId, cwd } : { sessionId }, base);
  if (!recreated.ok) return first;
  log('info', 'agent', `DSH 会话 ${sessionId} 不存在，已重建后重发消息`);
  return rpcV2('session', 'prompt', { ...request, requestId: nextRpcId() }, base);
}

function assistantText(entry) {
  const ev = entry && entry.event ? entry.event : entry;
  if (!ev) return null;
  if (ev.type === 'assistant/chunk') {
    const chunk = ev.data && ev.data.chunk;
    if (!chunk || !chunk.text || String(chunk.type || '').includes('reasoning')) return null;
    return String(chunk.text).trim() || null;
  }
  if (ev.type !== 'assistant/message') return null;
  const data = ev.data || {};
  const msg = data.message || {};
  const blocks = Array.isArray(msg.content) ? msg.content : [];
  const parts = blocks
    .filter((b) => b && ['text', 'output_text', 'markdown'].includes(b.type) && b.text)
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

// 从事件里挖「这一轮为什么没回复」的原因：模型报错/重试/流中断都会挂在事件里，
// 直接透给用户比干等到超时有用得多。
function failureFromEvent(ev) {
  if (!ev || !ev.data) return '';
  const d = ev.data;
  // 本轮以错误收尾（例如会话日志文件被删：ENOENT）——DSH 把原因放在 turn/end.reason.error
  if (ev.type === 'turn/end' && d.reason && d.reason.kind === 'error') {
    const message = (d.reason.error && d.reason.error.message) || d.reason.message;
    if (message) return message;
  }
  if (ev.type === 'llm/retry' && d.failure && d.failure.message) {
    return `模型调用失败，正在重试（第 ${d.retry || '?'}/${d.maxRetries || '?'} 次）：${d.failure.message}`;
  }
  if (ev.type === 'assistant/attempt' && Array.isArray(d.stream)) {
    for (const item of d.stream) {
      const reason = item && item.chunk && item.chunk.finish && item.chunk.finish.reason;
      const message = reason && reason.kind === 'error' && reason.failure && reason.failure.message;
      if (message) return `模型调用失败：${message}`;
    }
  }
  if (ev.type === 'error' && (d.message || d.error)) return `DSH 报错：${d.message || d.error}`;
  return '';
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
  const before = await sessionHistory({ sessionId, base });
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

  const sent = await sessionPrompt({ sessionId, text: promptText, base, cwd });
  if (!sent.ok) {
    return { ok: false, error: sent.error || 'DSH Web prompt 发送失败' };
  }

  const startedAt = Date.now();
  const eventMap = new Map(); // seq -> raw event object
  let candidateText = null;
  let candidateAt = 0;
  let lastEventAt = 0;
  let chunkText = '';
  let failure = '';
  while (Date.now() - startedAt < timeoutMs) {
    const h = await sessionHistory({ sessionId, base });
    if (h.ok && Array.isArray(h.value.events)) {
      let foundText = null;
      let turnEnded = false;
      for (const entry of h.value.events) {
        const ev = entry && entry.event ? entry.event : entry;
        if (!ev || typeof ev.seq !== 'number' || ev.seq <= beforeSeq || eventMap.has(ev.seq)) continue;
        eventMap.set(ev.seq, ev);
        lastEventAt = Date.now();
        if (ev.type === 'turn/end' || ev.type === 'session/error') turnEnded = true;
        const why = failureFromEvent(ev);
        if (why) failure = why;
        if (ev.type === 'assistant/chunk') {
          const piece = assistantText(entry);
          if (piece) { chunkText += piece; candidateText = chunkText; candidateAt = Date.now(); }
        } else if (ev.type === 'assistant/message') {
          const textOut = assistantText(entry);
          if (textOut) {
            foundText = textOut;
            candidateText = textOut;
            candidateAt = Date.now();
          }
        }
      }
      if (candidateText && Date.now() - Math.max(candidateAt, lastEventAt) >= 2500) {
        const events = [...eventMap.values()].sort((a, b) => a.seq - b.seq);
        return { ok: true, text: candidateText, sessionId, mode: 'dsh-web', events };
      }
      // 这一轮已经结束却没有回复：说明模型侧失败了，立刻报错，别让用户干等
      if (turnEnded && !candidateText) {
        return { ok: false, error: failure ? `DSH 这一轮没有产出回复：${failure}` : 'DSH 这一轮没有产出回复（模型侧没有返回内容）', sessionId, failed: true };
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

  const before = await sessionHistory({ sessionId, base });
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

  const sent = await sessionPrompt({ sessionId, text: promptText, base, cwd });
  if (!sent.ok) return { ok: false, error: sent.error || 'DSH Web prompt 发送失败' };

  const startedAt = Date.now();
  const seen = new Set();
  let candidateText = null;
  let candidateAt = 0;
  let lastEventAt = 0;
  let chunkText = '';
  let failure = '';
  while (Date.now() - startedAt < timeoutMs) {
    const h = await sessionHistory({ sessionId, base });
    if (h.ok && Array.isArray(h.value.events)) {
      let foundText = null;
      let turnEnded = false;
      for (const entry of h.value.events) {
        const ev = entry && entry.event ? entry.event : entry;
        if (!ev || typeof ev.seq !== 'number' || ev.seq <= beforeSeq || seen.has(ev.seq)) continue;
        seen.add(ev.seq);
        lastEventAt = Date.now();
        if (ev.type === 'turn/end' || ev.type === 'session/error') turnEnded = true;
        const why = failureFromEvent(ev);
        if (why) failure = why;
        try { onEvent(ev); } catch {}
        if (ev.type === 'assistant/chunk') {
          const piece = assistantText(ev);
          if (piece) { chunkText += piece; candidateText = chunkText; candidateAt = Date.now(); }
        } else if (ev.type === 'assistant/message') {
          const textOut = assistantText(ev);
          if (textOut) {
            foundText = textOut;
            candidateText = textOut;
            candidateAt = Date.now();
          }
        }
      }
      if (candidateText && Date.now() - Math.max(candidateAt, lastEventAt) >= 2500) {
        return { ok: true, text: candidateText, sessionId, mode: 'dsh-web-stream' };
      }
      if (turnEnded && !candidateText) {
        return { ok: false, error: failure ? `DSH 这一轮没有产出回复：${failure}` : 'DSH 这一轮没有产出回复（模型侧没有返回内容）', sessionId, failed: true };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  return { ok: false, error: 'DSH Web 回复超时', sessionId };
}

// 微信/任务统一入口：userId 用来派生稳定会话；cwd 默认项目工作区。
async function ask({ userId, text, cwd = PROJECT_ROOT, timeoutMs = 180000, base = DEFAULT_BASE, initialPrompt = '' } = {}) {
  const sessionId = conversationSessionId(userId, cwd, 'wechat');
  return promptAndWait({ sessionId, text, cwd, timeoutMs, base, initialPrompt });
}

let webChild = null;

// 是否已有 DSH WebUI 在跑。注意：返回 401 也算「在线」——
// 新版 DSH 只是要鉴权，不能因此判定它没启动、再拉一个起来（会抢端口）。
async function isReachable(base = DEFAULT_BASE, timeoutMs = 1500) {
  try {
    // 探测本身不要再触发「拉起 DSH」，否则会递归
    const res = await postJson(base, 'session/list', envelopeV2('session/list', {}), { timeoutMs, allowReload: false });
    if (res.status === 200 || res.status === 401 || res.status === 403) return true;
    return false;
  } catch {
    return false;
  }
}

// DSH 在这台机器上实测要 ~40 秒才真正监听（插件/鉴权门初始化很慢），所以：
//   1. 启动改成后台进行，不阻塞核心启动（微信通道、剪贴板监听先跑起来）；
//   2. 等待窗口放宽到 120 秒；
//   3. 谁先需要 DSH，谁 await ensureWebReady()，共享同一次启动。
const DSH_START_TIMEOUT_MS = 120000;
let webLaunchPromise = null;
// 供 /api/status 与日志使用的最近一次 DSH 状态（排障用：另一台机器上 DSH 起不来时能看到原因）
let webState = { ok: null, bin: '', home: '', pid: null, exitCode: null, error: '', output: '', at: '' };

function rememberWebState(patch) {
  webState = { ...webState, ...patch, at: new Date().toISOString() };
}

function dshStatus() {
  return { ...webState };
}

// DSH 子进程输出同时落一份文件：打包机器上起不来时，用户直接把 <数据目录>/dsh.log 发过来即可
function appendDshLog(text) {
  try {
    const { getPaths } = require('../lib/paths');
    const fs = require('fs');
    const file = require('path').join(getPaths().dataDir, 'dsh.log');
    fs.appendFileSync(file, text, 'utf8');
  } catch {}
}

function spawnDshWeb(base, port) {
  const bin = findDshBin();
  // 打包分发时 Electron 壳会把 DSH_HOME 指到用户数据目录（首次运行由 DSH 自己生成 profile）。
  // 这时把「设置里的模型」写进该 home，并把 API Key 通过环境变量传给 DSH，
  // 用户装完就能直接用，不必再去 DSH 界面里配一遍。
  let env = process.env;
  const dshHome = String(process.env.DSH_HOME || '').trim();
  if (dshHome) {
    try {
      env = buildDshEnv(dshHome, loadConfig());
    } catch {}
  }
  rememberWebState({ ok: null, bin, home: dshHome, exitCode: null, error: '', output: '' });
  log('info', 'agent', `启动 DSH：bin=${bin} DSH_HOME=${dshHome || '(默认 ~/.dsh)'} runner=${process.execPath}`);
  // --expose-internals：DSH 的 web profile 默认 patchReload: live，它的 HMR 插件要求这个 flag，
  //   否则 DSH 会在启动阶段直接崩（--expose-internals is required for HMR service）：全新机器上就是这样。
  // --no-open：不自动弹浏览器；stdout/stderr 保留下来，用于抓取带鉴权令牌的地址
  webChild = spawn(process.execPath, ['--expose-internals', bin, 'web', '--port', String(port), '--no-open'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env
  });
  rememberWebState({ pid: webChild.pid });
  webChild.on('error', (e) => {
    const message = String((e && e.message) || e);
    rememberWebState({ ok: false, error: 'spawn 失败：' + message });
    log('error', 'agent', 'DSH 子进程启动失败：' + message);
  });
  webChild.on('exit', (code) => {
    const failed = code !== 0;
    rememberWebState({ ok: !failed, exitCode: code, ...(failed ? { error: `DSH 进程退出（code=${code}）` } : {}) });
    appendDshLog(`\n[DSH 进程退出 code=${code}]\n`);
    // 退出码 + 最后一段输出一定要落日志：打包机器上 DSH 起不来时，这是唯一的线索
    log(failed ? 'error' : 'info', 'agent', `DSH 进程退出：code=${code}${webState.output ? '｜输出：' + webState.output : ''}`);
  });
  const onOutput = (chunk) => {
    const text = String(chunk || '');
    webState.output = (webState.output + text).slice(-800);
    appendDshLog(text);
    webAuth.scanLaunchOutput(base, chunk);
  };
  webChild.stdout.setEncoding('utf8');
  webChild.stdout.on('data', onOutput);
  if (webChild.stderr) {
    webChild.stderr.setEncoding('utf8');
    webChild.stderr.on('data', onOutput);
  }
  return webChild;
}

async function waitForWeb(base, waitMs) {
  const deadline = Date.now() + Math.max(0, waitMs);
  while (Date.now() < deadline) {
    if (await isReachable(base, 800)) {
      // 起来了就用刚抓到的令牌换一次 cookie
      await webAuth.ensureCookie({ base, force: true });
      rememberWebState({ ok: true, error: '' });
      return true;
    }
    // 子进程已经退出就别再等了，直接带着它的输出报错
    if (webChild && webChild.exitCode !== null) {
      rememberWebState({ ok: false, error: `DSH 进程已退出（code=${webChild.exitCode}）` });
      return false;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  rememberWebState({ ok: false, error: `等待 ${Math.round(waitMs / 1000)} 秒后仍不可达` });
  return false;
}

// 确保 DSH WebUI 可用：已在跑就直接返回；否则拉起一次（单飞，多个调用共享）。
async function ensureWebReady({ port = 3080, base = DEFAULT_BASE, waitMs = DSH_START_TIMEOUT_MS } = {}) {
  if (await isReachable(base, 1200)) return { ok: true, started: false };
  if (!webLaunchPromise) {
    try {
      spawnDshWeb(base, port);
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
    webLaunchPromise = waitForWeb(base, DSH_START_TIMEOUT_MS);
  }
  const started = await Promise.race([
    webLaunchPromise,
    new Promise((resolve) => setTimeout(() => resolve(false), Math.max(0, waitMs)))
  ]);
  if (started) {
    webLaunchPromise = null;
    return { ok: true, started: true };
  }
  // 还没起来：保留后台启动，让调用方先失败，稍后再试
  const detail = webState.error || webState.output || '';
  return {
    ok: false,
    pending: true,
    error: `DSH WebUI 启动中（已等待 ${Math.round(waitMs / 1000)} 秒，可稍后重试）${detail ? '｜' + detail : ''}`
  };
}

// 兼容旧调用方（core/index.js 启动时调用）：后台拉起，不长时间阻塞；带 waitMs 时才等。
async function launchWeb({ port = 3080, base = DEFAULT_BASE, waitMs = 5000 } = {}) {
  const result = await ensureWebReady({ port, base, waitMs });
  return result.ok ? { ok: true, started: result.started, pid: webChild ? webChild.pid : null } : result;
}

function stopWeb() {
  if (webChild) {
    try { webChild.kill(); } catch {}
    webChild = null;
  }
}


module.exports = {
  sessionPrompt,
  promptAndWait,
  promptStreaming,
  ask,
  conversationSessionId,
  launchWeb,
  stopWeb,
  dshStatus,
  PROJECT_ROOT,
  DEFAULT_BASE
};
