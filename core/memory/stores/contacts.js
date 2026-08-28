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

// 从全量流水 inbox.jsonl 中移除某联系人的所有记录（含删除联系人时使用）
function removeInboxForContact(contact) {
  if (!fs.existsSync(P.inbox)) return 0;
  const name = String(contact || '');
  if (!name) return 0;
  const safe = sanitize(name);
  const lines = fs.readFileSync(P.inbox, 'utf8').split(/\r?\n/);
  const kept = [];
  let removed = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line);
      const c = String(o.contact || o.name || '');
      if (c === name || c === safe) {
        removed++;
        continue;
      }
    } catch {}
    kept.push(line);
  }
  fs.writeFileSync(P.inbox, kept.join('\n'), 'utf8');
  return removed;
}

// 更新联系人档案（备注/画像/重要标记），可新建也可更新已有档案
function updateContact(contact, patch = {}) {
  const doc = readContact(contact);
  if (patch.remark !== undefined) doc.remark = String(patch.remark);
  if (patch.important !== undefined) doc.important = !!patch.important;
  if (patch.profile && typeof patch.profile === 'object') {
    for (const [k, v] of Object.entries(patch.profile)) {
      doc.profile[k] = typeof v === 'string' ? v : String(v == null ? '' : v);
    }
  }
  doc.updatedAt = new Date().toISOString();
  saveContact(doc);
  return doc;
}

// 删除联系人：移除档案文件 + 从全量流水中移除该联系人的聊天记录
function deleteContact(contact) {
  const name = String(contact || '');
  const fp = contactFile(name);
  let removed = false;
  if (fs.existsSync(fp)) {
    fs.unlinkSync(fp);
    removed = true;
  }
  const inboxRemoved = removeInboxForContact(name);
  return { removed, inboxRemoved };
}

// 清空某联系人的聊天记录：保留档案/画像，只清 messages 与全量流水
function clearContactMessages(contact) {
  const name = String(contact || '');
  const fp = contactFile(name);
  if (!fs.existsSync(fp)) return { removed: 0, inboxRemoved: 0 };
  const doc = readContact(name);
  const removed = Array.isArray(doc.messages) ? doc.messages.length : 0;
  doc.messages = [];
  doc.updatedAt = new Date().toISOString();
  saveContact(doc);
  const inboxRemoved = removeInboxForContact(name);
  return { removed, inboxRemoved };
}

module.exports = {
  sanitize,
  contactFile,
  readContact,
  saveContact,
  addMessages,
  msgKey,
  listContactsMeta,
  updateContact,
  deleteContact,
  clearContactMessages,
  EMPTY_PROFILE
};
