// 小鹈鹕核心 — 联系人档案存储（一人一档）
'use strict';

const fs = require('fs');
const path = require('path');
const { getPaths } = require('../../lib/paths');
const { readJson, writeJson, listJsonFiles } = require('../../lib/store');

const P = getPaths();

const EMPTY_PROFILE = {
  '关系类型': '未知',
  '近况': '',
  '偏好': '',
  '重要承诺/待办': '',
  '敏感话题/注意点': '',
  '情绪趋势': '',
  '最近互动时间': ''
};

function sanitize(name) {
  return String(name).replace(/[\\/:*?"<>|]/g, '').replace(/^[\s.]+|[\s.]+$/g, '') || 'contact';
}

function contactFile(contact) {
  return path.join(P.contacts, sanitize(contact) + '.json');
}

function defaultDoc(contact) {
  return { name: String(contact), remark: '', updatedAt: '', messages: [], profile: Object.assign({}, EMPTY_PROFILE) };
}

function readContact(contact) {
  const doc = readJson(contactFile(contact), null) || defaultDoc(contact);
  if (!Array.isArray(doc.messages)) doc.messages = [];
  if (!doc.profile || typeof doc.profile !== 'object') doc.profile = Object.assign({}, EMPTY_PROFILE);
  if (doc.remark === undefined || doc.remark === null) doc.remark = '';
  return doc;
}

function saveContact(doc) {
  fs.mkdirSync(P.contacts, { recursive: true });
  writeJson(contactFile(doc.name), doc);
}

function msgKey(m) {
  return `${m.name}|${m.ts}|${m.type}|${m.content}`;
}

// 把新消息去重追加进档案，返回真正新增的消息数组
function addMessages(doc, msgs) {
  const seen = new Set(doc.messages.map(msgKey));
  const added = [];
  for (const m of msgs || []) {
    const norm = {
      name: String(m.name || ''),
      ts: String(m.ts || ''),
      type: String(m.type || 'text'),
      content: String(m.content || '')
    };
    const key = msgKey(norm);
    if (seen.has(key)) continue;
    seen.add(key);
    doc.messages.push(norm);
    added.push(norm);
  }
  if (added.length) {
    doc.messages.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
    doc.updatedAt = new Date().toISOString();
  }
  return added;
}

function listContactsMeta() {
  return listJsonFiles(P.contacts).map((f) => {
    const c = readContact(f.replace(/\.json$/, ''));
    return {
      name: c.name,
      remark: c.remark || '',
      messages: Array.isArray(c.messages) ? c.messages.length : 0,
      updatedAt: c.updatedAt || '',
      important: !!c.important
    };
  });
}

module.exports = { sanitize, contactFile, readContact, saveContact, addMessages, msgKey, listContactsMeta, EMPTY_PROFILE };
