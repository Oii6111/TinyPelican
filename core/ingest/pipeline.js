// 小鹈鹕核心 — 记忆输入管道
// 统一把「剪贴板批次 / 通道实时消息」归档进联系人档案 + 全量流水。
'use strict';

const fs = require('fs');
const path = require('path');
const { getPaths } = require('../lib/paths');
const { appendJsonl } = require('../lib/store');
const { readContact, addMessages, saveContact } = require('../memory/stores/contacts');
const { increment } = require('../memory/stores/unread');
const voice = require('../memory/stores/voice');

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
    const doc = readContact(contact);
    totalAdded += addMessages(doc, msgs).length;
    saveContact(doc);
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

// 通道实时入站：去重归档 + 写全量流水；opts.unread 用于把通道消息计入顶部未读数
function ingestMessages(msgs, contact, opts = {}) {
  const key = String(contact || '').trim() || 'inbox';
  const doc = readContact(key);
  const added = addMessages(doc, msgs);
  if (added.length) {
    saveContact(doc);
    for (const m of added) {
      appendJsonl(P.inbox, { ...m, contact: key });
      // 语音消息进入待回填队列
      if (m.type === '语音') voice.enqueue(key, m);
    }
    if (opts.unread) increment(added.length);
  }
  return added.length;
}

// 语音回填：把转写文本写回联系人档案与 inbox 流水
function applyVoiceFill(p) {
  const key = p.contact || p.name || '';
  if (!key) return false;
  let updated = false;
  const doc = readContact(key);
  for (const m of doc.messages) {
    if (m.name === p.name && m.ts === p.ts && m.type === p.type && m.content === '') {
      m.content = p.content;
      updated = true;
      break;
    }
  }
  if (updated) saveContact(doc);

  try {
    if (fs.existsSync(P.inbox)) {
      const lines = fs.readFileSync(P.inbox, 'utf8').split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].trim()) continue;
        try {
          const o = JSON.parse(lines[i]);
          if (o.name === p.name && o.ts === p.ts && o.type === p.type && o.content === '') {
            o.content = p.content;
            lines[i] = JSON.stringify(o);
            break;
          }
        } catch {}
      }
      fs.writeFileSync(P.inbox, lines.join('\n'), 'utf8');
    }
  } catch {}
  return updated;
}

module.exports = { processBatchFile, processAllBatches, ingestMessages, applyVoiceFill };
