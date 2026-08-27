// 小鹈鹕核心 — 语音待回填队列（原由旧 PowerShell 监听器维护，现并入 Node 核心）
'use strict';

const { getPaths } = require('../../lib/paths');
const { readJson, writeJson } = require('../../lib/store');

const P = getPaths();

function list() {
  const data = readJson(P.voicePending, []);
  return Array.isArray(data) ? data : data ? [data] : [];
}

function save(items) {
  writeJson(P.voicePending, items);
}

// 捕获到【语音】消息时入队，等待回填转写文本
function enqueue(contact, m) {
  const items = list();
  items.push({
    seq: items.length + 1,
    contact: String(contact || m.name || ''),
    name: m.name,
    ts: m.ts,
    type: m.type,
    content: ''
  });
  save(items);
}

// 用一段纯文本回填队首并出队；返回被回填的条目（无可回填时返回 null）
function fillFirst(text) {
  const items = list();
  const content = String(text || '').trim();
  if (!items.length || !content) return null;
  const p = items[0];
  p.content = content;
  save(items.slice(1));
  return p;
}

function skip(index) {
  const items = list();
  if (index < 0 || index >= items.length) return false;
  items.splice(index, 1);
  save(items);
  return true;
}

module.exports = { list, save, enqueue, fillFirst, skip };
