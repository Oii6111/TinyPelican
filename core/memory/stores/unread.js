// 小鹈鹕核心 — 未读消息计数（用于顶部状态栏）
'use strict';

const { getPaths } = require('../../lib/paths');
const { readJson, writeJson } = require('../../lib/store');

const P = getPaths();

function read() {
  const d = readJson(P.unread, {});
  return {
    count: Number((d && d.count) || 0),
    updatedAt: (d && d.updatedAt) || '',
    lastReadAt: (d && d.lastReadAt) || ''
  };
}

function increment(n = 1) {
  const s = read();
  s.count += n;
  s.updatedAt = new Date().toISOString();
  writeJson(P.unread, s);
}

function markRead() {
  const s = read();
  s.count = 0;
  s.lastReadAt = new Date().toISOString();
  writeJson(P.unread, s);
}

function getUnread() {
  return read();
}

module.exports = { increment, markRead, getUnread };
