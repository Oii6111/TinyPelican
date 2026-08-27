// 小鹈鹕核心 — 看板对话记录（替代 OpenClaw 会话文件）
'use strict';

const { getPaths } = require('../../lib/paths');
const { readJson, writeJson } = require('../../lib/store');

const P = getPaths();
const FILE = P.conversations;

function all() {
  return readJson(FILE, {});
}

function get(key) {
  const m = all();
  return m[key] || [];
}

function append(key, entry) {
  const m = all();
  if (!m[key]) m[key] = [];
  m[key].push({ ts: new Date().toISOString(), ...entry });
  writeJson(FILE, m);
}

function remove(key) {
  const m = all();
  delete m[key];
  writeJson(FILE, m);
}

function list() {
  return Object.entries(all()).map(([key, msgs]) => {
    const first = msgs.find((x) => x.role === 'user');
    const last = msgs[msgs.length - 1];
    return {
      key,
      title: first ? String(first.text || '').replace(/\s+/g, ' ').slice(0, 40) : '新对话',
      count: msgs.length,
      updatedAt: last ? last.ts : ''
    };
  }).sort((a, b) => (String(b.updatedAt) < String(a.updatedAt) ? -1 : String(b.updatedAt) > String(a.updatedAt) ? 1 : 0));
}

module.exports = { all, get, append, remove, list };
