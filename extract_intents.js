// 小鹈鹕 V3 — 意图识别
// 新聊天归档后由 watch-clipboard.ps1 触发（带冷却），调用 intent Agent（Qwen3.5-9B）识别任务/DDL/日程/事项/等待回复。
// 用法：node extract_intents.js
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { log } = require('./logger');

const V3 = __dirname;
const DATA_DIR = process.env.XIAOTIHU_DATA_DIR;
const CONTACTS = DATA_DIR ? path.join(DATA_DIR, 'contacts') : path.join(V3, 'contacts');
const CONFIG_PATH = DATA_DIR ? path.join(DATA_DIR, 'config.json') : path.join(V3, 'config.json');
const INTENTS_PATH = DATA_DIR ? path.join(DATA_DIR, 'intents.json') : path.join(V3, 'intents.json');
const STATE_PATH = DATA_DIR ? path.join(DATA_DIR, 'intent-state.json') : path.join(V3, 'intent-state.json');
const OPENCLAW_ENTRY = path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'openclaw', 'openclaw.mjs');

let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch {}
const intentCfg = cfg.intent || {};
const AGENT = intentCfg.agent || 'intent';
const HIGH_CONF = intentCfg.highConfidence !== undefined ? intentCfg.highConfidence : 0.85;
const MEDIUM_CONF = intentCfg.mediumConfidence !== undefined ? intentCfg.mediumConfidence : 0.5;
const MAX_MSGS = intentCfg.maxMessagesPerBatch || 50;
const AGENT_TIMEOUT_MS = intentCfg.agentTimeoutMs || 120000;
const push = cfg.weixinPush || {};

const INTENT_SYSTEM_PROMPT = `你是小鹈鹕的意图识别引擎。分析聊天记录，识别其中需要用户跟进的事情。

意图类型：
- task：需要执行的任务/委托，如“帮我查一下”
- deadline：有明确截止时间的任务，如“下周一之前交”
- schedule：日程/会议/约会/个人时间安排，如“周五下午三点开会”
- reminder：事项提醒/待办/自我提醒，如“记得明天买试剂”
- waiting_reply：有人在等回复，如“你昨天问我的事有结果了吗”

判断规则（必须遵守）：
1. 只要消息包含未来时间安排、待办、提醒、截止时间、委托、等待回复中的任意一种，就必须输出 JSON，不能输出 NO_TASK。
2. 别人明确告诉“你需要在 / 你要 / 你得 / 你必须 / 记得 / 别忘了”等，是给用户的安排/指令，必须识别。
3. 例如“明早八点你需要在医院签到打卡上班，下午四点需要签退” → 必须识别为 schedule 或 reminder。
4. 纯闲聊、寒暄、过去事实、观点解释、已完成的陈述 → 输出 NO_TASK。
5. 一条消息包含多个独立时间安排时，可以拆成多条意图。

输出格式：
- 无意图时只输出：NO_TASK
- 有意图时输出 JSON 数组，每个对象格式：
{"type":"task|deadline|schedule|reminder|waiting_reply","summary":"一句话标题","detail":"关键背景/原文摘录","deadline":"原文时间表达或null","people":["涉及的人"],"priority":"high|medium|low","confidence":0.85,"reason":"判定理由"}
只输出上述内容，不要解释，不要 Markdown 代码块。`;

function getIntentApi() {
  const fromCfg = (cfg.intent && cfg.intent.api) || {};
  if (fromCfg.apiKey && fromCfg.model) {
    return {
      baseUrl: fromCfg.baseUrl || 'https://api.siliconflow.cn/v1',
      apiKey: fromCfg.apiKey,
      model: fromCfg.model
    };
  }
  try {
    const ocPath = path.join(process.env.USERPROFILE || '', '.openclaw', 'openclaw.json');
    const oc = JSON.parse(fs.readFileSync(ocPath, 'utf8'));
    const p = oc.models && oc.models.providers && oc.models.providers.siliconflow;
    if (p && p.apiKey) {
      return {
        baseUrl: p.baseUrl || 'https://api.siliconflow.cn/v1',
        apiKey: p.apiKey,
        model: 'Qwen/Qwen3.5-9B'
      };
    }
  } catch {}
  return null;
}

function readJson(file, fallback) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {}
  return fallback;
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function loadIntents() {
  const data = readJson(INTENTS_PATH, []);
  return Array.isArray(data) ? data : [];
}

function saveIntents(items) {
  writeJson(INTENTS_PATH, items);
}

function loadState() {
  const data = readJson(STATE_PATH, {});
  return (data && typeof data === 'object' && !Array.isArray(data)) ? data : {};
}

function saveState(state) {
  writeJson(STATE_PATH, state);
}

function runOpenclaw(args, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [OPENCLAW_ENTRY, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch {}
      resolve({ ok: false, error: 'timeout', out: stdout, err: stderr });
    }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, error: String(e.message || e), out: stdout, err: stderr });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const text = extractAgentText(stdout);
      if (code !== 0) {
        resolve({ ok: false, error: stderr.trim() || ('exit ' + code), out: stdout, err: stderr, text });
      } else {
        resolve({ ok: true, out: stdout, err: stderr, text });
      }
    });
  });
}

function extractAgentText(stdout) {
  try {
    const p = JSON.parse(stdout);
    const text = (p?.result?.payloads || []).map((x) => x.text).filter(Boolean).join('\n').trim();
    if (text) return text;
  } catch {}
  return stdout.trim();
}

function extractJsonArray(text) {
  if (!text) return null;
  // 去掉可能的 Markdown 代码块
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  // 直接尝试解析
  try {
    const arr = JSON.parse(cleaned);
    return Array.isArray(arr) ? arr : null;
  } catch {}
  // 尝试从文本中截取第一个 [ ... ] 或 { ... }
  const match = cleaned.match(/\[[\s\S]*\]/);
  if (match) {
    try {
      const arr = JSON.parse(match[0]);
      return Array.isArray(arr) ? arr : null;
    } catch {}
  }
  const objMatch = cleaned.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try {
      const obj = JSON.parse(objMatch[0]);
      return Array.isArray(obj) ? obj : [obj];
    } catch {}
  }
  return null;
}

function getSessionsIndex(agentId) {
  const p = path.join(process.env.USERPROFILE || '', '.openclaw', 'agents', agentId, 'sessions', 'sessions.json');
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; }
}

function getSessionFileByKey(key) {
  for (const agentId of ['main', 'intent']) {
    const idx = getSessionsIndex(agentId);
    const entry = idx[key];
    if (entry && entry.sessionFile) return entry.sessionFile;
  }
  return null;
}

function getSubagentStatus(key) {
  for (const agentId of ['main', 'intent']) {
    const entry = getSessionsIndex(agentId)[key];
    if (entry) return entry.status;
  }
  return null;
}

function extractChildKey(mainSessionFile) {
  try {
    const raw = fs.readFileSync(mainSessionFile, 'utf8');
    const m = raw.match(/"childSessionKey"\s*:\s*"([^"]+)"/);
    return m ? m[1] : null;
  } catch { return null; }
}

function extractFinalText(sessionFile) {
  if (!fs.existsSync(sessionFile)) return '';
  const lines = fs.readFileSync(sessionFile, 'utf8').split(/\r?\n/);
  let text = '';
  for (const line of lines) {
    try {
      const rec = JSON.parse(line);
      const msg = rec.message;
      if (msg && msg.role === 'assistant' && Array.isArray(msg.content)) {
        for (const b of msg.content) {
          if (b && b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
            text = b.text.trim();
          }
        }
      }
    } catch {}
  }
  return text;
}

function waitForSubagent(childKey, childFile, timeoutMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    const timer = setInterval(() => {
      const status = getSubagentStatus(childKey);
      const text = extractFinalText(childFile);
      if (text || status === 'done' || status === 'failed') {
        clearInterval(timer);
        return resolve(true);
      }
      if (Date.now() - start > timeoutMs) {
        clearInterval(timer);
        return resolve(false);
      }
    }, 2000);
  });
}

function waitForChildFile(childKey, timeoutMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    const timer = setInterval(() => {
      const file = getSessionFileByKey(childKey);
      if (file && fs.existsSync(file)) {
        clearInterval(timer);
        return resolve(file);
      }
      if (Date.now() - start > timeoutMs) {
        clearInterval(timer);
        return resolve(null);
      }
    }, 1000);
  });
}

async function callIntentAgent(chatText, sourceLabel) {
  const prompt = [
    '请使用 sessions_spawn 调用 intent Agent（model: intent），任务：',
    '分析下面这段聊天记录，识别其中需要小鹈鹕跟进的事情。',
    '',
    '意图类型：',
    '- task：需要执行的任务/委托，如“帮我查一下”',
    '- deadline：有明确截止时间的任务，如“下周一之前交”',
    '- schedule：日程/会议/约会/个人时间安排，如“周五下午三点开会”',
    '- reminder：事项提醒/待办/自我提醒，如“记得明天买试剂”',
    '- waiting_reply：有人在等回复，如“你昨天问我的事有结果了吗”',
    '',
    '判断规则（必须遵守）：',
    '1. 只要消息包含未来时间安排、待办、提醒、截止时间、委托、等待回复中的任意一种，就必须输出 JSON，不能输出 NO_TASK。',
    '2. 别人明确告诉“你需要在 / 你要 / 你得 / 你必须 / 记得 / 别忘了”等，是给用户的安排/指令，必须识别。',
    '3. 例如“明早八点你需要在医院签到打卡上班，下午四点需要签退” → 必须识别为 schedule 或 reminder。',
    '4. 纯闲聊、寒暄、过去事实、观点解释、已完成的陈述 → 输出 NO_TASK。',
    '5. 一条消息包含多个独立时间安排时，可以拆成多条意图。',
    '',
    '来源：' + sourceLabel,
    '聊天记录：',
    chatText,
    '',
    '只返回 intent Agent 的原始输出（NO_TASK 或 JSON 数组），不要解释。'
  ].join('\n');
  const mainKey = 'agent:main:intent-spawn-' + Date.now();
  const r = await runOpenclaw([
    'agent',
    '--session-key', mainKey,
    '--message', prompt,
    '--thinking', 'off',
    '--json',
    '--timeout', '60'
  ], 70000);

  let mainSessionFile = null;
  try {
    const p = JSON.parse(r.out || '');
    mainSessionFile = p?.result?.meta?.agentMeta?.sessionFile || null;
  } catch {}
  if (!mainSessionFile) {
    // 等待 sessions.json 中出现 main session 记录
    for (let i = 0; i < 15 && !mainSessionFile; i++) {
      mainSessionFile = getSessionFileByKey(mainKey);
      if (!mainSessionFile) await new Promise((res) => setTimeout(res, 1000));
    }
  }
  if (!mainSessionFile || !fs.existsSync(mainSessionFile)) {
    return { ok: false, error: 'main session file not found: ' + (r.error || '') };
  }

  // 等待 main session 文件里出现 childSessionKey
  let childKey = extractChildKey(mainSessionFile);
  for (let i = 0; i < 15 && !childKey; i++) {
    await new Promise((res) => setTimeout(res, 1000));
    childKey = extractChildKey(mainSessionFile);
  }
  if (!childKey) {
    return { ok: false, error: 'child session key not found: ' + (r.error || '') };
  }
  const childFile = await waitForChildFile(childKey, 30000);
  if (!childFile) {
    return { ok: false, error: 'child session file not found' };
  }

  const okWait = await waitForSubagent(childKey, childFile, AGENT_TIMEOUT_MS);
  if (!okWait) {
    return { ok: false, error: 'intent subagent timeout' };
  }
  const text = extractFinalText(childFile);
  return { ok: true, text };
}

function pad(n) { return String(n).padStart(2, '0'); }

function toLocalDate(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function parseMsgTs(ts) {
  const m = String(ts || '').match(/^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{1,2})$/);
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], 0, 0);
}

function addDays(d, n) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

function nextWeekday(base, targetDay, nextWeek) {
  // targetDay: 0=周日, 1=周一 ... 6=周六
  const d = new Date(base);
  d.setHours(0, 0, 0, 0);
  let diff = targetDay - d.getDay();
  if (nextWeek) diff += 7;
  else if (diff <= 0) diff += 7;
  return addDays(d, diff);
}

function parseDeadline(text, msgTs) {
  if (!text || !msgTs) return null;
  const t = String(text);
  const base = parseMsgTs(msgTs);
  if (!base) return null;
  const datePart = toLocalDate(base);
  let target = null;

  if (/(今天|今晚)/.test(t)) target = base;
  else if (/明天/.test(t)) target = addDays(base, 1);
  else if (/后天/.test(t)) target = addDays(base, 2);
  else if (/大后天/.test(t)) target = addDays(base, 3);
  else if (/月底/.test(t)) {
    target = new Date(base.getFullYear(), base.getMonth() + 1, 0, 23, 59, 0, 0);
  } else if (/(\d{1,2})月(\d{1,2})日/.test(t)) {
    const mm = parseInt(RegExp.$1, 10);
    const dd = parseInt(RegExp.$2, 10);
    let y = base.getFullYear();
    let d = new Date(y, mm - 1, dd, 23, 59, 0, 0);
    if (d < base) d = new Date(y + 1, mm - 1, dd, 23, 59, 0, 0);
    target = d;
  } else if (/(\d{1,2})月/.test(t) && /(?:号|日)/.test(t)) {
    // 已在上面的分支处理
  } else if (/下?周([一二三四五六日天])/.test(t)) {
    const map = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 0, '天': 0 };
    const day = map[RegExp.$1];
    const nextWeek = /下周/.test(t);
    target = nextWeekday(base, day, nextWeek);
    target.setHours(23, 59, 0, 0);
  } else if (/周([一二三四五六日天])/.test(t)) {
    const map = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 0, '天': 0 };
    const day = map[RegExp.$1];
    target = nextWeekday(base, day, false);
    target.setHours(23, 59, 0, 0);
  } else if (/(\d{1,2})天后/.test(t)) {
    target = addDays(base, parseInt(RegExp.$1, 10));
  } else if (/(\d{1,2})[:：](\d{1,2})/.test(t)) {
    const h = parseInt(RegExp.$1, 10);
    const min = parseInt(RegExp.$2, 10);
    target = new Date(base.getFullYear(), base.getMonth(), base.getDate(), h, min, 0, 0);
    if (target <= base) target = addDays(target, 1);
  } else if (/(上午|中午|下午|晚上)?\s*(\d{1,2})点/.test(t)) {
    let h = parseInt(RegExp.$2, 10);
    const period = RegExp.$1;
    if (period === '下午' || period === '晚上') { if (h < 12) h += 12; }
    if (period === '中午' && h < 12) h = 12;
    target = new Date(base.getFullYear(), base.getMonth(), base.getDate(), h, 0, 0, 0);
    if (target <= base) target = addDays(target, 1);
  }

  if (!target) return null;
  return target.toISOString();
}

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
    status: conf >= HIGH_CONF ? 'auto_added' : 'pending_confirm',
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

function typeLabel(type) {
  const map = {
    task: '任务',
    deadline: 'DDL',
    schedule: '日程',
    reminder: '事项提醒',
    waiting_reply: '等待回复'
  };
  return map[type] || type;
}

function sendWeixin(message) {
  return new Promise((resolve) => {
    if (!push.enabled || !push.to || !push.accountId) return resolve(false);
    const child = spawn(process.execPath, [
      OPENCLAW_ENTRY, 'message', 'send',
      '--channel', 'openclaw-weixin',
      '--account', push.accountId,
      '--target', push.to,
      '--message', message
    ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve(code === 0));
    child.on('error', () => resolve(false));
    setTimeout(() => { try { child.kill(); } catch {} resolve(false); }, 30000).unref();
  });
}

async function notifyNewIntents(intents) {
  if (!push.enabled) return;
  let changed = false;
  for (const intent of intents) {
    if (intent.notified) continue;
    if (intent.status === 'auto_added') {
      const ok = await sendWeixin(`✅ 已添加${typeLabel(intent.type)}：${intent.summary}（来自 ${intent.source.contact || '未知'}${intent.dueText ? '，' + intent.dueText : ''}）`);
      if (ok) { intent.notified = true; intent.updatedAt = new Date().toISOString(); changed = true; log('info', 'weixin', `已推送意图通知：${intent.summary}`); }
      else log('error', 'weixin', `意图通知推送失败：${intent.summary}`);
    } else if (intent.status === 'pending_confirm' && intent.confidence >= MEDIUM_CONF) {
      const ok = await sendWeixin(`🔍 发现疑似${typeLabel(intent.type)}：${intent.summary}（来自 ${intent.source.contact || '未知'}）。请在 Dashboard「意图」页确认或忽略。`);
      if (ok) { intent.notified = true; intent.updatedAt = new Date().toISOString(); changed = true; log('info', 'weixin', `已推送待确认意图：${intent.summary}`); }
      else log('error', 'weixin', `待确认意图推送失败：${intent.summary}`);
    }
    // 低置信度不推送，只进 Dashboard
  }
  if (changed) saveIntents(intents);
}

async function main() {
  if (!fs.existsSync(CONTACTS)) {
    console.log('无联系人目录，跳过');
    return;
  }
  const intents = loadIntents();
  const state = loadState();
  const files = fs.readdirSync(CONTACTS).filter((f) => f.endsWith('.json')).sort();
  let totalNew = 0;

  for (const file of files) {
    let c;
    try { c = JSON.parse(fs.readFileSync(path.join(CONTACTS, file), 'utf8')); } catch { continue; }
    const key = c.name || file.replace(/\.json$/, '');
    const since = state[key] || '';
    const newMsgs = (c.messages || []).filter((m) =>
      m && m.ts && m.ts > since && m.type === 'text' && m.content && String(m.content).trim()
    );
    if (!newMsgs.length) continue;
    const batch = newMsgs.slice(-MAX_MSGS);
    const chatText = batch.map((m) => `${m.ts} ${m.name}: ${m.content}`).join('\n');
    const sourceLabel = key;
    console.log(`[intent] 扫描 ${key}，新增 ${newMsgs.length} 条`);
    log('info', 'intent', `扫描 ${key}，新增 ${newMsgs.length} 条`);

    const result = await callIntentAgent(chatText, sourceLabel);
    if (!result.ok) {
      console.log(`[intent] ${key} 调用失败：${result.error || 'unknown'}，下次重试`);
      log('error', 'intent', `${key} 调用失败：${result.error || 'unknown'}，下次重试`);
      continue;
    }
    if (!result.text || !result.text.trim()) {
      console.log(`[intent] ${key} 输出为空，保留待重试`);
      log('warn', 'intent', `${key} 输出为空，保留待重试`);
      continue;
    }
    if (result.text.trim().toUpperCase() === 'NO_TASK') {
      console.log(`[intent] ${key} 无意图`);
      log('info', 'intent', `${key} 无意图`);
    } else {
      const arr = extractJsonArray(result.text);
      if (!arr) {
        console.log(`[intent] ${key} 输出无法解析，保留待重试：${result.text.slice(0, 200)}`);
        log('error', 'intent', `${key} 输出无法解析，保留待重试：${result.text.slice(0, 200)}`);
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
  await notifyNewIntents(intents);
  console.log('[intent] 完成');
  log('info', 'intent', '完成');
}

main().catch((e) => {
  console.error('[intent] 异常', e);
  process.exit(1);
});
