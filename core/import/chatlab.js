// ChatLab 聊天记录格式解析器
// 支持两种形态：
//   1) 单个 JSON 文档：{ chatlab, meta, members, messages }
//   2) JSONL：首行 {_type:"header"} + 若干 {_type:"member"} / {_type:"message"} 行
// 秒级时间戳；说话人显示名优先 accountName，其次 member 表，最后回退 sender。
// 返回 null 表示「不是 ChatLab」，交给 chat-archive.js 的其他解析器。
'use strict';

const TYPES = { 0: 'text', 1: 'image', 2: 'voice', 3: 'video', 4: 'file', 5: 'emoji', 7: 'link', 8: 'location', 80: 'system', 81: 'recall' };

function parseChatLab(text) {
  const trimmed = String(text || '').replace(/^\uFEFF/, '').trim();
  let document;
  let rows;
  try { document = JSON.parse(trimmed); } catch {}
  if (document?.chatlab && document?.meta && Array.isArray(document.messages)) {
    rows = document.messages;
  } else {
    const lines = trimmed.split(/\r?\n/).filter(line => line.trim() && !line.trim().startsWith('#'));
    const records = lines.map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
    const header = records[0];
    if (header?._type !== 'header' || !header.chatlab || !header.meta) return null;
    document = { ...header, members: records.filter(row => row._type === 'member') };
    rows = records.filter(row => row._type === 'message');
  }
  const members = new Map((document.members || []).map(member => [String(member.platformId), member]));
  const ownerNames = new Set();
  const messages = rows.map(row => {
    const member = members.get(String(row.sender));
    const name = String(row.accountName || member?.accountName || row.sender || '').trim();
    if (document.meta.ownerId && String(row.sender) === String(document.meta.ownerId)) ownerNames.add(name);
    const stamp = Number(row.timestamp);
    const date = new Date(stamp * 1000);
    const type = TYPES[row.type] || 'other';
    const identified = document.meta.ownerId != null && row.sender != null && String(document.meta.ownerId) !== '';
    const owner = identified && String(row.sender) === String(document.meta.ownerId);
    return {
      name,
      ...(identified && (owner || document.meta.type === 'private') ? { isOwner: owner } : {}),
      ts: Number.isFinite(stamp) && !isNaN(date.getTime()) ? date.toISOString() : '',
      type,
      content: String(row.content ?? (type === 'text' ? '' : `[${type}]`))
    };
  }).filter(message => message.name && message.ts && message.content);
  const owner = members.get(String(document.meta.ownerId));
  if (owner?.accountName) ownerNames.add(owner.accountName);
  return { messages, format: 'chatlab', contactHint: document.meta.name || '', ownerNames: [...ownerNames] };
}

module.exports = { parseChatLab };
