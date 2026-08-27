// 小鹈鹕核心 — context_token 持久化
// 按「账号 + 用户」保存最近有效 token，保证重启后仍能主动推送。
'use strict';

const { getPaths } = require('../../lib/paths');
const { readJson, writeJson } = require('../../lib/store');

const P = getPaths();

function loadContexts() {
  const m = readJson(P.weixinContext, {});
  return m && typeof m === 'object' ? m : {};
}

function getContext(accountId, userId) {
  if (!accountId || !userId) return '';
  const m = loadContexts();
  return (m[accountId] && m[accountId][userId]) || '';
}

function setContext(accountId, userId, token) {
  if (!accountId || !userId || !token) return;
  const m = loadContexts();
  if (!m[accountId]) m[accountId] = {};
  m[accountId][userId] = token;
  writeJson(P.weixinContext, m);
}

module.exports = { getContext, setContext, loadContexts };
