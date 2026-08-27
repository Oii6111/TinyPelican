// 小鹈鹕 V3 — 主动提醒引擎
// 消费 intents.json，对已确认/自动添加且带 dueAt 的意图做 DDL/日程/事项提醒。
// 用法：node remind.js（建议配合 cron 每 15 分钟执行）
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { log } = require('./logger');

const V3 = __dirname;
const DATA_DIR = process.env.XIAOTIHU_DATA_DIR;
const INTENTS_PATH = DATA_DIR ? path.join(DATA_DIR, 'intents.json') : path.join(V3, 'intents.json');
const CONFIG_PATH = DATA_DIR ? path.join(DATA_DIR, 'config.json') : path.join(V3, 'config.json');
const OPENCLAW_ENTRY = path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'openclaw', 'openclaw.mjs');

let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch {}
const reminderCfg = cfg.reminder || {};
const push = cfg.weixinPush || {};
const dndCfg = cfg.doNotDisturb || {};
const DRY_RUN = process.argv.includes('--dry-run');

function parseHM(str) {
  const m = String(str || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return { h, min };
}

function isInDoNotDisturb(now = new Date()) {
  if (!dndCfg.enabled) return false;
  const start = parseHM(dndCfg.start);
  const end = parseHM(dndCfg.end);
  if (!start || !end) return false;
  const cur = now.getHours() * 60 + now.getMinutes();
  const s = start.h * 60 + start.min;
  const e = end.h * 60 + end.min;
  if (s === e) return false;
  if (s < e) return cur >= s && cur < e;
  // 跨天，如 23:00 - 08:00
  return cur >= s || cur < e;
}

function readIntents() {
  try {
    if (fs.existsSync(INTENTS_PATH)) {
      const data = JSON.parse(fs.readFileSync(INTENTS_PATH, 'utf8'));
      return Array.isArray(data) ? data : [];
    }
  } catch {}
  return [];
}

function saveIntents(items) {
  fs.writeFileSync(INTENTS_PATH, JSON.stringify(items, null, 2) + '\n', 'utf8');
}

function sendWeixin(message) {
  return new Promise((resolve) => {
    if (DRY_RUN) {
      console.log('[remind][dry-run]', message);
      return resolve(true);
    }
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

function typeLabel(type) {
  const map = { task: '任务', deadline: 'DDL', schedule: '日程', reminder: '事项提醒', waiting_reply: '等待回复' };
  return map[type] || type;
}

// ---------- 按需调用小模型生成提醒文案 ----------
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
      if (code !== 0) resolve({ ok: false, error: stderr.trim() || ('exit ' + code), out: stdout, err: stderr, text });
      else resolve({ ok: true, out: stdout, err: stderr, text });
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
          if (b && b.type === 'text' && typeof b.text === 'string' && b.text.trim()) text = b.text.trim();
        }
      }
    } catch {}
  }
  return text;
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

async function callModelForText(taskPrompt, timeoutMs = 60000) {
  const mainKey = 'agent:main:remind-spawn-' + Date.now();
  const r = await runOpenclaw([
    'agent',
    '--session-key', mainKey,
    '--message', taskPrompt,
    '--thinking', 'off',
    '--json',
    '--timeout', '30'
  ], 45000);

  let mainSessionFile = null;
  try {
    const p = JSON.parse(r.out || '');
    mainSessionFile = p?.result?.meta?.agentMeta?.sessionFile || null;
  } catch {}
  if (!mainSessionFile) mainSessionFile = getSessionFileByKey(mainKey);
  if (!mainSessionFile || !fs.existsSync(mainSessionFile)) return '';

  const childKey = extractChildKey(mainSessionFile);
  if (!childKey) return '';
  const childFile = await waitForChildFile(childKey, 30000);
  if (!childFile) return '';

  const okWait = await waitForSubagent(childKey, childFile, timeoutMs);
  if (!okWait) return '';
  return extractFinalText(childFile);
}

async function generateReminderMessage(intent) {
  const prompt = [
    '请根据以下事项生成一条微信提醒消息。',
    '要求：口语化、自然、不超过50字、不要解释、不要JSON、不要NO_TASK，直接输出提醒文本。',
    '',
    `事项：${intent.summary}`,
    intent.dueText ? `时间：${intent.dueText}` : '',
    intent.source && intent.source.contact ? `来源：${intent.source.contact}` : '',
    '',
    '提醒消息：'
  ].filter(Boolean).join('\n');
  let text = '';
  try {
    text = await callModelForText(prompt);
  } catch (e) {
    console.log('[remind] 模型生成提醒失败，使用模板：' + (e && e.message ? e.message : e));
  }
  if (text && text.trim()) return text.trim();
  // 失败兜底：用模板
  return `⏰ ${typeLabel(intent.type)}提醒：${intent.summary}${intent.dueText ? '（' + intent.dueText + '）' : ''}`;
}

function getReminderPoints(intent) {
  const type = intent.type || 'task';
  const dueText = intent.dueText ? `（${intent.dueText}）` : '';
  if (type === 'deadline') {
    const points = [];
    const leadDays = reminderCfg.deadlineLeadDays !== undefined ? reminderCfg.deadlineLeadDays : [1];
    const leadHours = reminderCfg.deadlineLeadHours !== undefined ? reminderCfg.deadlineLeadHours : [2];
    for (const d of leadDays) points.push({ minutes: d * 1440, label: `提前${d}天` + dueText });
    for (const h of leadHours) points.push({ minutes: h * 60, label: `提前${h}小时` + dueText });
    points.push({ minutes: 0, label: '已到期' + dueText });
    return points;
  }
  if (type === 'schedule') {
    const lead = reminderCfg.scheduleLeadMinutes !== undefined ? reminderCfg.scheduleLeadMinutes : 30;
    return [
      { minutes: lead, label: `提前${lead}分钟` + dueText },
      { minutes: 0, label: '日程开始' + dueText }
    ];
  }
  if (type === 'reminder') {
    return [{ minutes: 0, label: '事项提醒' + dueText }];
  }
  // task 或其它带 dueAt 的类型：默认到期提醒
  return [{ minutes: 0, label: '到期提醒' + dueText }];
}

async function main() {
  const intents = readIntents();
  if (!intents.length) {
    console.log('[remind] 无意图，跳过');
    log('info', 'remind', '无意图，跳过');
    return;
  }
  let changed = false;
  const now = Date.now();

  for (const intent of intents) {
    if (!['auto_added', 'confirmed'].includes(intent.status)) continue;
    if (!intent.dueAt) continue;
    const due = new Date(intent.dueAt).getTime();
    if (isNaN(due)) continue;
    if (!Array.isArray(intent.reminders)) intent.reminders = [];

    const points = getReminderPoints(intent);
    const passed = points
      .filter((p) => now >= due - p.minutes * 60000 && !intent.reminders.includes(String(p.minutes)))
      .sort((a, b) => a.minutes - b.minutes);
    if (!passed.length) continue;

    // 只推送“最接近当前时间”的已到达提醒点，避免把提前1天/2小时/到期一次性全推
    const point = passed[0];

    // 免打扰时段不推送，也不标记已提醒，等结束后的下一轮再补推
    if (isInDoNotDisturb()) {
      console.log(`[remind] ${intent.id} 处于免打扰时段，延后提醒 ${point.label}`);
      log('warn', 'remind', `${intent.id} 处于免打扰时段，延后提醒 ${point.label}`);
      continue;
    }

    const msg = await generateReminderMessage(intent);
    const ok = await sendWeixin(msg);
    if (ok) {
      intent.reminders.push(String(point.minutes));
      intent.updatedAt = new Date().toISOString();
      changed = true;
      console.log(`[remind] 已提醒 ${intent.id} ${point.label}`);
      log('info', 'remind', `已提醒 ${intent.id} ${point.label}`);
    } else {
      console.log(`[remind] 推送失败 ${intent.id} ${point.label}`);
      log('error', 'remind', `推送失败 ${intent.id} ${point.label}`);
    }
  }

  if (changed) saveIntents(intents);
  console.log('[remind] 完成');
  log('info', 'remind', '完成');
}

main().catch((e) => {
  console.error('[remind] 异常', e);
  process.exit(1);
});
