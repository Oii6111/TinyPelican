// 回复建议内存状态：只保存当前一批建议，支持过期、新复制失效、乱序防护。
// 一批建议 = 多组「连贯消息方案」（plans）；用户点选某一组后进入顺序发送态（activePlan）。
'use strict';

const crypto = require('crypto');

let current = null;
let pending = null;
let generationToken = 0;
let consumeLockedId = null;

function createId() {
  return 'reply_' + Date.now() + '_' + crypto.randomBytes(3).toString('hex');
}

function now() {
  return Date.now();
}

function isExpired(s, at = now()) {
  if (!s) return true;
  return at >= s.expiresAt;
}

// 新捕获/新请求会使旧建议立即失效，并推进生成版本，让还在途中的旧模型请求作废。
function invalidate() {
  current = null;
  pending = null;
  consumeLockedId = null;
  generationToken++;
}

function replaceSuggestion(suggestion) {
  current = suggestion;
  pending = null;
  consumeLockedId = null;
  return current;
}

// 生成中状态：拉起浮窗用（先把窗口显示出来，填「思考中」，模型回来再换成内容）。
// meta = { contact, sourceMessage, sourceSpeaker, sourceIsSelf, mode, hint, targetWindow }
function setPending(meta) {
  pending = meta ? { ...meta, startedAt: new Date().toISOString() } : null;
  return pending;
}

function getPending() {
  return pending;
}

function clearPending() {
  pending = null;
}

// 顺序发送态：{ planIndex, tone, sent: [...], remaining: [...] }；传 null 回到方案选择态。
function setActivePlan(id, activePlan) {
  if (!current || current.id !== id) return null;
  current.activePlan = activePlan || null;
  return current.activePlan;
}

// 用户又复制了同一段聊天：把既有建议重新推给浮窗。
// showToken 自增后 Electron 会重新显示并重新定位（不必重新调模型），同时刷新有效期与目标窗口。
function reshow(id, { targetWindow = null, expiresAt = 0 } = {}) {
  if (!current || current.id !== id) return null;
  if (targetWindow) current.targetWindow = targetWindow;
  if (expiresAt) current.expiresAt = expiresAt;
  current.showToken = (Number(current.showToken) || 1) + 1;
  return current;
}

function getActivePlan(id) {
  if (!current || (id && current.id !== id)) return null;
  return current.activePlan || null;
}

// 重写这一组「还没发出去」的消息：只换 remaining，已发的 sent 保持不动
function replaceRemaining(id, messages, avoid = []) {
  if (!current || current.id !== id || !current.activePlan) return null;
  current.activePlan = {
    ...current.activePlan,
    remaining: (messages || []).slice(),
    avoid: (avoid || []).slice()
  };
  return current.activePlan;
}

function getCurrent() {
  if (!current) return null;
  if (isExpired(current)) {
    invalidate();
    return null;
  }
  return current;
}

function computeAnchor(tw) {
  if (!tw || !tw.bounds) return null;
  const left = Number(tw.bounds.left);
  const top = Number(tw.bounds.top);
  const right = Number(tw.bounds.right);
  const bottom = Number(tw.bounds.bottom);
  if (!Number.isFinite(left) || !Number.isFinite(top) ||
      !Number.isFinite(right) || !Number.isFinite(bottom) ||
      right <= left || bottom <= top) return null;
  const dpi = Number(tw.dpi) || 96;
  const scale = dpi / 96;
  if (!(scale > 0)) return null;
  // Win32 物理坐标按 dpi/96 换算成 Electron DIP；70/135 为经验偏移（微信输入框发送按钮附近）。
  return {
    x: Math.round((right - 70 * scale) / scale),
    y: Math.round((bottom - 135 * scale) / scale)
  };
}

function sanitize(s) {
  if (!s) return null;
  return {
    id: s.id,
    contact: s.contact,
    sourceMessage: s.sourceMessage,
    sourceSpeaker: s.sourceSpeaker || '',
    sourceIsSelf: !!s.sourceIsSelf,
    canPaste: !!(s.targetWindow && s.targetWindow.handle),
    anchor: computeAnchor(s.targetWindow),
    showToken: Number(s.showToken) || 1,
    hint: s.hint || '',
    plans: (s.plans || []).map((p) => ({
      tone: p.tone,
      messages: (p.messages || []).slice()
    })),
    activePlan: s.activePlan ? {
      planIndex: s.activePlan.planIndex,
      tone: s.activePlan.tone || '',
      sent: (s.activePlan.sent || []).slice(),
      remaining: (s.activePlan.remaining || []).slice()
    } : null,
    createdAt: s.createdAt
  };
}

// 生成中：给浮窗足够的信息先显示「思考中」（含定位锚点与来源消息）
function sanitizePending(p) {
  if (!p) return null;
  return {
    contact: p.contact || '',
    sourceMessage: p.sourceMessage || '',
    sourceSpeaker: p.sourceSpeaker || '',
    sourceIsSelf: !!p.sourceIsSelf,
    mode: p.mode || 'fast',
    hint: p.hint || '',
    startedAt: p.startedAt || '',
    canPaste: !!(p.targetWindow && p.targetWindow.handle),
    anchor: computeAnchor(p.targetWindow)
  };
}

function beginGeneration() {
  return ++generationToken;
}

function isLatestGeneration(token) {
  return token === generationToken;
}

function lock(id) {
  if (!current || current.id !== id || isExpired(current)) return false;
  // 任何已有锁（无论是否同 ID）都拒绝第二次申请，防止并发粘贴两次。
  if (consumeLockedId) return false;
  consumeLockedId = id;
  return true;
}

function unlock(id) {
  if (consumeLockedId === id) consumeLockedId = null;
  return true;
}

module.exports = {
  createId,
  invalidate,
  replaceSuggestion,
  getCurrent,
  setPending,
  getPending,
  clearPending,
  sanitizePending,
  setActivePlan,
  getActivePlan,
  replaceRemaining,
  reshow,
  sanitize,
  beginGeneration,
  isLatestGeneration,
  lock,
  unlock,
  isExpired
};
