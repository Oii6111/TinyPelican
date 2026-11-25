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
const attachmentStore = require('../memory/attachment-store');
const { describeAttachment } = require('../memory/attachment-describe');
const { buildAttachments } = require('../capture/clipboard-media');
const { loadConfig } = require('../lib/config');
const { log } = require('../lib/log');

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

// 归属目标归一化：老调用方传字符串（联系人名），新调用方传 resolveBatchTarget 的结果。
//   { kind: 'contact' | 'group' | 'unknown', name, displayName, remark, members }
function normalizeTarget(target) {
  if (typeof target === 'string') {
    const name = String(target || '').trim();
    return { kind: 'contact', name, displayName: name, remark: '', members: [] };
  }
  if (!target || typeof target !== 'object') return { kind: 'unknown', name: '', displayName: '', remark: '', members: [] };
  const kind = target.kind === 'group' ? 'group' : (target.kind === 'unknown' ? 'unknown' : 'contact');
  const name = String(target.name || '').trim();
  return {
    kind,
    name,
    displayName: String(target.displayName || name).trim(),
    // 截图读到的显示名（微信里设了备注就是备注）：只写 remark，不参与身份。
    // 漏了这一行，备注永远写不进去——这是数据能进来、界面却看不到的唯一原因。
    remark: String(target.remark || '').trim(),
    members: Array.isArray(target.members) ? target.members : []
  };
}

// 批次归属的展示口径：群聊不能叫「联系人」。
// 采集链路上「这批是谁的」要一路透传到通知/建议，这里给出统一判断，
// 避免调用方各自用字符串拼文案、把群名当人名。
function describeTarget(target) {
  const t = normalizeTarget(target);
  const isGroup = t.kind === 'group';
  return { ...t, isGroup, label: isGroup ? '群聊' : '联系人' };
}

// 群先落到 member 行再入库：同一个群可能已经用别的显示名存在过，
// 按成员重合归并成一个，避免同一批人复制两次变成两个群。
function storageKeyFor(target) {
  if (target.kind !== 'group' || !target.name) return target.name;
  const group = chatDb.ensureGroup(target.name, { members: target.members, displayName: target.displayName, remark: target.remark });
  return group ? group.name : target.name;
}

// 通道实时入站：去重归档；opts.unread 用于把通道消息计入顶部未读数
function ingestMessages(msgs, target, opts = {}) {
  const t = normalizeTarget(target);
  const key = storageKeyFor(t) || 'inbox';
  const count = chatDb.ingestMessages(key, msgs, { kind: t.kind === 'group' ? 'group' : 'contact', remark: t.remark });
  if (count && t.kind === 'group' && t.members.length) chatDb.linkGroupMembers(key, t.members);
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

// 剪贴板批次的附件处理：配对 → 落盘 → 生成描述 → 入库。
// 描述只在「首次导入」时生成一次；之后 agent 回读读的是库里那份文字。
async function prepareAttachments(contact, msgs, media, allMsgs, cfg) {
  const withFiles = buildAttachments(msgs, allMsgs || msgs, media);
  const notes = { visionUnsupported: false, described: 0, failed: 0, saved: 0 };
  const out = [];
  for (const message of withFiles) {
    const files = Array.isArray(message.attachments) ? message.attachments : [];
    if (!files.length) { out.push(message); continue; }
    const stored = [];
    for (const file of files) {
      // 同一份内容已经在这段聊天里出现过：不重复落盘、更不重复花钱识图
      if (chatDb.attachmentExists(contact, file.sha256)) continue;
      let relative = '';
      try {
        relative = attachmentStore.save(file.bytes, file);
        notes.saved++;
      } catch (error) {
        notes.failed++;
        log('warn', 'capture', `附件落盘失败（${file.name}）：${(error && error.message) || error}`);
      }
      // 别处已经描述过同一张图：直接复用那段文字
      const cached = chatDb.descriptionForSha(file.sha256);
      const described = cached
        ? { description: cached.description, descriptionSource: cached.descriptionSource || 'vision', descriptionModel: cached.descriptionModel || '', descriptionError: '' }
        : await describeAttachment(file, cfg);
      if (described.visionUnsupported) notes.visionUnsupported = true;
      if (described.descriptionSource === 'vision') notes.described++;
      stored.push({
        kind: file.kind,
        name: file.name,
        mimeType: file.mimeType,
        size: file.size,
        sha256: file.sha256,
        path: relative,
        description: described.description,
        descriptionSource: described.descriptionSource,
        descriptionModel: described.descriptionModel || '',
        descriptionError: described.descriptionError || '',
        source: 'clipboard'
      });
    }
    out.push({ ...message, attachments: stored });
  }
  return { messages: out, notes };
}

// 带附件的批次入口（异步：要等落盘和描述）
// target 可以是联系人名字符串（老调用方），也可以是 resolveBatchTarget 的结果。
async function ingestCapturedBatch(msgs, target, { media = null, allMsgs = null, config = null } = {}) {
  const t = normalizeTarget(target);
  const key = storageKeyFor(t) || 'inbox';
  const cfg = config || loadConfig();
  let prepared = msgs;
  let notes = { visionUnsupported: false, described: 0, failed: 0, saved: 0 };
  if (media) {
    const result = await prepareAttachments(key, msgs, media, allMsgs, cfg);
    prepared = result.messages;
    notes = result.notes;
  }
  const count = chatDb.ingestMessages(key, prepared, { kind: t.kind === 'group' ? 'group' : 'contact', remark: t.remark });
  if (count) {
    if (t.kind === 'group' && t.members.length) chatDb.linkGroupMembers(key, t.members);
    for (const m of msgs) {
      if (m.type === '语音') voice.enqueue(key, m);
    }
  }
  return { added: count, kind: t.kind, name: key, ...notes };
}

// 语音回填：把转写文本写回 SQLite
function applyVoiceFill(p) {
  const key = p.contact || p.name || '';
  if (!key) return false;
  const updated = chatDb.updateMessageContent(p);

  return updated;
}

module.exports = { processBatchFile, processAllBatches, ingestMessages, ingestCapturedBatch, applyVoiceFill, normalizeTarget, storageKeyFor, describeTarget };
