// 小鹈鹕核心 — context_token 持久化
// 按「账号 + 用户」保存最近有效 token，保证重启后仍能主动推送。
// token 仅在收到该用户的新入站消息时由 iLink 刷新；旧 token 失效后应清理并提示用户重新激活。
'use strict';

const { getPaths } = require('../../lib/paths');
const { readJson, writeJson } = require('../../lib/store');

const P = getPaths();

function loadContexts() {
  const m = readJson(P.weixinContext, {});
  return m && typeof m === 'object' ? m : {};
}

function normalizeEntry(v) {
  if (v && typeof v === 'object' && typeof v.token === 'string') {
    return { token: v.token, updatedAt: v.updatedAt || null };
  }
  // 兼容旧版纯字符串 token
  return { token: String(v || ''), updatedAt: null };
}

function getContextInfo(accountId, userId) {
  if (!accountId || !userId) return { token: '', updatedAt: null };
  const m = loadContexts();
  return normalizeEntry((m[accountId] || {})[userId]);
}

function getContext(accountId, userId) {
  return getContextInfo(accountId, userId).token;
}

function setContext(accountId, userId, token) {
  if (!accountId || !userId || !token) return;
  const m = loadContexts();
  if (!m[accountId]) m[accountId] = {};
  m[accountId][userId] = {
    token,
    updatedAt: new Date().toISOString()
  };
  writeJson(P.weixinContext, m);
}

function clearContext(accountId, userId) {
  if (!accountId || !userId) return;
  const m = loadContexts();
  if (m[accountId] && Object.prototype.hasOwnProperty.call(m[accountId], userId)) {
    delete m[accountId][userId];
    writeJson(P.weixinContext, m);
  }
}

module.exports = { getContext, setContext, clearContext, getContextInfo, loadContexts };
