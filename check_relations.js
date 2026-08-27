// 小鹈鹕 — 关系维护检查（可被 cron / 心跳定时调用）
// 读 contacts/*.json -> 找「特别关心 + 冷落」的联系人 -> 读近期聊天生成维护建议 -> 微信推送
// 用法：node check_relations.js   （配合 openclaw cron 定时执行）
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { log } = require('./logger');

const V3 = __dirname;
const DATA_DIR = process.env.XIAOTIHU_DATA_DIR;
const CONTACTS = DATA_DIR ? path.join(DATA_DIR, 'contacts') : path.join(V3, 'contacts');
const CONFIG_PATH = DATA_DIR ? path.join(DATA_DIR, 'config.json') : path.join(V3, 'config.json');
const PUSHED_STATE = DATA_DIR ? path.join(DATA_DIR, 'relation-pushed.json') : path.join(V3, 'relation-pushed.json');

let cfg = { weixinPush: {}, relationCheck: {} };
try { cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch {}
const push = cfg.weixinPush || {};
const daysThreshold = (cfg.relationCheck && cfg.relationCheck.days) || 7;
const OPENCLAW_ENTRY = path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'openclaw', 'openclaw.mjs');

function daysBetween(a, b) { return Math.floor((b - a) / 86400000); }

function lastInteractionMs(c) {
  let max = 0;
  for (const m of (c.messages || [])) {
    const t = new Date(String(m.ts || '').replace(' ', 'T')).getTime();
    if (!isNaN(t) && t > max) max = t;
  }
  return max;
}

function runOpenclaw(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [OPENCLAW_ENTRY, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('close', (code) => resolve({ code, out: out.trim() }));
    child.on('error', (e) => resolve({ code: -1, out: String(e.message || e) }));
  });
}

// 生成维护建议（LLM 读近期聊天生成，失败回退模板）
async function genSuggestion(c) {
  const recent = (c.messages || []).slice(-3)
    .map((m) => (m.name || '?') + '：' + (m.content || '[' + (m.type || 'text') + ']')).join('\n');
  const prompt = '为维护人际关系，给微信联系人「' + (c.remark || c.name) + '」生成一条发给TA的问候消息。\n'
    + '背景：你们已经 ' + c.days + ' 天没联系了。\n最近聊天：\n' + recent + '\n'
    + (c.profile && c.profile['近况'] ? 'TA的近况：' + c.profile['近况'] + '\n' : '')
    + '要求：一条自然、简短（50字内）、口语化的微信问候，能自然开启话题。只输出问候语本身，不要解释。';
  const r = await runOpenclaw(['agent', '--session-key', 'agent:main:relation-check', '--message', prompt, '--thinking', 'off', '--json']);
  try {
    const p = JSON.parse(r.out);
    const text = (p?.result?.payloads || []).map((x) => x.text).filter(Boolean).join('\n').trim();
    if (text) return text;
  } catch {}
  const first = (recent.split('\n')[0] || '上次聊天').slice(0, 40);
  return '最近怎么样？上次聊到「' + first + '」，好久没联系了，想着问候一下～';
}

async function sendWeixin(message) {
  if (!push.enabled || !push.to || !push.accountId) return false;
  const r = await runOpenclaw(['message', 'send', '--channel', 'openclaw-weixin', '--account', push.accountId, '--target', push.to, '--message', message]);
  return r.code === 0;
}

async function main() {
  if (!cfg.relationCheck || cfg.relationCheck.enabled === false) {
    console.log('relationCheck 未启用，跳过'); log('info', 'relation', '未启用，跳过'); return;
  }
  if (!fs.existsSync(CONTACTS)) { console.log('无档案目录，跳过'); log('warn', 'relation', '无档案目录，跳过'); return; }

  let pushed = {};
  if (fs.existsSync(PUSHED_STATE)) { try { pushed = JSON.parse(fs.readFileSync(PUSHED_STATE, 'utf8')); } catch {} }

  const cold = [];
  for (const f of fs.readdirSync(CONTACTS).filter((x) => x.endsWith('.json'))) {
    let c;
    try { c = JSON.parse(fs.readFileSync(path.join(CONTACTS, f), 'utf8')); } catch { continue; }
    if (!c.important) continue; // 只检查「特别关心」
    const last = lastInteractionMs(c);
    if (!last) continue;
    const days = daysBetween(last, Date.now());
    if (days < daysThreshold) continue; // 还没冷落
    const lp = pushed[c.name] || 0;
    if (lp && daysBetween(lp, Date.now()) < daysThreshold) continue; // 刚提醒过
    cold.push({ name: c.name, remark: c.remark || '', days, messages: c.messages || [], profile: c.profile || {} });
  }

  if (!cold.length) { console.log('没有需要维护的关系'); log('info', 'relation', '没有需要维护的关系'); return; }
  console.log('发现 ' + cold.length + ' 个冷落联系人：' + cold.map((c) => c.remark || c.name).join('、'));
  log('info', 'relation', '发现 ' + cold.length + ' 个冷落联系人：' + cold.map((c) => c.remark || c.name).join('、'));

  for (const c of cold) {
    const suggestion = await genSuggestion(c);
    const msg = '🦩 关系维护提醒\n你和「' + (c.remark || c.name) + '」已经 ' + c.days + ' 天没联系了。\n\n💬 可以发：' + suggestion;
    const ok = await sendWeixin(msg);
    if (ok) { pushed[c.name] = Date.now(); console.log('已推送：' + (c.remark || c.name)); log('info', 'relation', '已推送：' + (c.remark || c.name)); }
    else { console.log('推送失败：' + (c.remark || c.name)); log('error', 'relation', '推送失败：' + (c.remark || c.name)); }
  }
  fs.writeFileSync(PUSHED_STATE, JSON.stringify(pushed, null, 2), 'utf8');
}

main();
