// 回复建议内存状态：只保存当前一条建议，支持过期、新复制失效、乱序防护。
'use strict';

const crypto = require('crypto');

let current = null;
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
  consumeLockedId = null;
  generationToken++;
}

function replaceSuggestion(suggestion) {
  current = suggestion;
  consumeLockedId = null;
  return current;
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
    options: (s.options || []).map((o) => ({ tone: o.tone, text: o.text })),
    createdAt: s.createdAt
  };
}

function beginGeneration() {
  return ++generationToken;
}

function isLatestGeneration(token) {
  return token === generationToken;
}

function consume(id) {
  if (!current || current.id !== id || isExpired(current)) return false;
  if (consumeLockedId && consumeLockedId !== id) return false;
  current = null;
  consumeLockedId = null;
  return true;
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

function dismiss(id) {
  if (!current || current.id !== id) return false;
  current = null;
  consumeLockedId = null;
  return true;
}

module.exports = {
  createId,
  invalidate,
  replaceSuggestion,
  getCurrent,
  sanitize,
  beginGeneration,
  isLatestGeneration,
  consume,
  lock,
  unlock,
  dismiss,
  isExpired
};
