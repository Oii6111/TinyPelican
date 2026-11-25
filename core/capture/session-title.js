// 小鹈鹕核心 — 从窗口截图读出「当前正在和谁聊天」
//
// 为什么要这个：微信电脑版是单窗格，窗口标题恒为「微信」，剪贴板里也只有发言人昵称。
// 只靠「这一批出现了几个不同的发言人」判断群聊/私聊，会在一段群聊里只有一个人说话时
// 把它判成那个人和你的私聊——群里的内容会静默混进他的画像。
//
// 窗口顶部（右侧聊天区）显示的就是当前会话名，群聊还带人数。截那一条、交给视觉模型读，
// 就能把「这是哪个会话」补上。已经实测：缩到 25%、JPEG q60、轻微模糊都能读对；
// 裁切区域里没有会话名时模型会返回 unknown，不会瞎编。
//
// 边界：只截顶部标题条，不截消息正文；图片只在本机与模型之间走，不落盘、不留存。
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { chatCompletion } = require('../engine/client');
const { visionTarget } = require('../memory/attachment-describe');
const { log } = require('../lib/log');

const SCRIPT = path.join(__dirname, 'shot-window-strip.ps1');
const DEFAULT_STRIP_HEIGHT = 150;
const MAX_TITLE_BYTES = 4 * 1024 * 1024;

const TITLE_PROMPT = [
  '这是一张微信电脑版窗口最顶部的截图。',
  '请找出右侧聊天区顶部显示的**会话名**（当前正在和谁聊天：联系人名字，或群聊名称）。',
  '只输出 JSON，不要解释：',
  '{"name":"会话名原文","kind":"contact 或 group 或 unknown","memberCount":数字或0}',
  '规则：',
  '1) name 必须逐字照抄画面上的文字，不改写、不翻译、不补全；',
  '2) 群聊名字后面通常带「(人数)」，此时 memberCount 填该数字、kind 填 group；',
  '3) 看不到会话名就返回 {"name":"","kind":"unknown","memberCount":0}，绝对不要猜；',
  '4) 不要描述截图里的其他内容。'
].join('\n');

// 截窗口顶部一条。任何失败都返回 null——这只影响归属精度，不该挡住入库。
function captureStrip(handle, { stripHeight = DEFAULT_STRIP_HEIGHT, timeoutMs = 8000 } = {}) {
  return new Promise((resolve) => {
    const id = Number(handle);
    if (!Number.isFinite(id) || id <= 0) return resolve(null);
    const out = path.join(os.tmpdir(), `tinypelican-strip-${process.pid}-${Date.now()}.png`);
    const ps = process.platform === 'win32' ? 'powershell.exe' : '';
    if (!ps) return resolve(null);
    execFile(ps, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT,
      '-Handle', String(id), '-Out', out, '-StripHeight', String(stripHeight)],
    { timeout: timeoutMs, windowsHide: true }, (error, stdout) => {
      try {
        const ok = !error && /^OK /m.test(String(stdout || ''));
        if (!ok) {
          log('warn', 'capture', '截取标题条失败：' + String((error && error.message) || stdout || '').slice(0, 200));
          try { fs.unlinkSync(out); } catch {}
          return resolve(null);
        }
        const bytes = fs.readFileSync(out);
        resolve(bytes && bytes.length && bytes.length <= MAX_TITLE_BYTES ? bytes : null);
      } catch {
        resolve(null);
      } finally {
        try { fs.unlinkSync(out); } catch {}
      }
    });
  });
}

function normalizeTitle(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const name = String(payload.name || '').trim();
  if (!name) return null;
  const kind = payload.kind === 'group' ? 'group' : 'contact';
  const memberCount = Number.isFinite(Number(payload.memberCount)) ? Math.max(0, Math.floor(Number(payload.memberCount))) : 0;
  return { name: name.slice(0, 80), kind, memberCount };
}

function parseTitleJson(text) {
  const raw = String(text || '').replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
  try { return normalizeTitle(JSON.parse(raw)); } catch { return null; }
}

// 读窗口会话名。handle 无效 / 视觉模型不可用 / 读不出来都返回 null（视同 unknown），
// 调用方退回启发式。注意：截图要尽早做（复制那一刻微信还是前台），识别晚一点没关系——所以分成两步。
async function readTitleFromBytes(bytes, config) {
  if (!bytes || !bytes.length) return null;
  const target = visionTarget(config);
  if (!target.ok) return null;
  const result = await chatCompletion([{
    role: 'user',
    content: [
      { type: 'text', text: TITLE_PROMPT },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,' + bytes.toString('base64') } }
    ]
  }], {
    config,
    providerName: target.provider,
    model: target.model,
    retries: 0,
    thinking: false,
    timeoutMs: 20000,
    taskName: 'weixin-title'
  });
  if (!result.ok) {
    log('warn', 'capture', '读会话名失败：' + String(result.error || '').slice(0, 200));
    return null;
  }
  const parsed = parseTitleJson(result.text);
  if (!parsed) {
    // 记下原始返回：截到空白图 / 模型没看清时，这是唯一能复盘的东西
    log('warn', 'capture', '会话名没读出来，模型原始返回：' + String(result.text || '').slice(0, 160));
  }
  return parsed;
}

// 能不能读会话名：只看有没有可用的视觉模型。
// 采集侧要在**截屏之前**问这一句——截一次要起 PowerShell、写临时文件、等 400ms 左右，
// 没配视觉模型时先截再发现读不了，等于每批白付一次截图成本。
function canReadSessionTitle(config) {
  try {
    return !!visionTarget(config).ok;
  } catch {
    return false;
  }
}

// 便利入口：截 → 读。产品里走的是「复制时先截、稍后再读」两步，这里给调用方和测试用。
async function readSessionTitle(handle, config, { stripHeight = DEFAULT_STRIP_HEIGHT } = {}) {
  const bytes = await captureStrip(handle, { stripHeight });
  return readTitleFromBytes(bytes, config);
}

module.exports = {
  captureStrip, readTitleFromBytes, readSessionTitle, canReadSessionTitle, parseTitleJson, normalizeTitle,
  TITLE_PROMPT, DEFAULT_STRIP_HEIGHT
};
