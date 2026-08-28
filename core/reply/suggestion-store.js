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

// 新捕获/新请求会使旧建议立即失效
function invalidate() {
  current = null;
  consumeLockedId = null;
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

function sanitize(s) {
  if (!s) return null;
  return {
    id: s.id,
    contact: s.contact,
    sourceMessage: s.sourceMessage,
    canPaste: !!(s.targetWindow && s.targetWindow.handle),
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
  if (consumeLockedId && consumeLockedId !== id) return false;
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
