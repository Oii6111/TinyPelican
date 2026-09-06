// 小鹈鹕核心 — 记忆输入管道
// 统一把剪贴板批次和通道消息归档进 SQLite。
'use strict';

const fs = require('fs');
const path = require('path');
const { getPaths } = require('../lib/paths');
const { readContact } = require('../memory/stores/contacts');
const { increment } = require('../memory/stores/unread');
const voice = require('../memory/stores/voice');
const chatDb = require('../memory/chat-db');

const P = getPaths();

// 处理一个批次文件：按 contact 分组建档 -> 成功后删除批次
function processBatchFile(file) {
  const fp = path.join(P.batches, file);
  const lines = fs.readFileSync(fp, 'utf8').split(/\r?\n/).filter((l) => l.trim());
  const byContact = new Map();
  for (const line of lines) {
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    const key = (m.contact && String(m.contact).trim()) ? String(m.contact).trim() : String(m.name || '');
    if (!key) continue;
    if (!byContact.has(key)) byContact.set(key, []);
    byContact.get(key).push(m);
  }
  let totalAdded = 0;
  for (const [contact, msgs] of byContact) {
    totalAdded += chatDb.ingestMessages(contact, msgs);
  }
  fs.unlinkSync(fp);
  return totalAdded;
}

function processAllBatches() {
  if (!fs.existsSync(P.batches)) return 0;
  const files = fs.readdirSync(P.batches).filter((f) => f.endsWith('.jsonl')).sort();
  let total = 0;
  for (const f of files) {
    try {
      total += processBatchFile(f);
    } catch (e) {
      console.error('[pipeline] 批次处理失败：' + f, e);
    }
  }
  return total;
}

// 通道实时入站：去重归档；opts.unread 用于把通道消息计入顶部未读数
function ingestMessages(msgs, contact, opts = {}) {
  const key = String(contact || '').trim() || 'inbox';
  const count = chatDb.ingestMessages(key, msgs);
  const added = count ? msgs : [];
  if (count) {
    for (const m of msgs) {
      // 语音消息进入待回填队列
      if (m.type === '语音') voice.enqueue(key, m);
    }
    if (opts.unread) increment(count);
  }
  return count;
}

// 语音回填：把转写文本写回 SQLite
function applyVoiceFill(p) {
  const key = p.contact || p.name || '';
  if (!key) return false;
  const updated = chatDb.updateMessageContent(p);

  return updated;
}

module.exports = { processBatchFile, processAllBatches, ingestMessages, applyVoiceFill };
