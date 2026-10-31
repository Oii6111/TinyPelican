// 小鹈鹕核心 — 剪贴板聊天记录里的附件（图片/视频/文件）
//
// 微信「复制」带图片的聊天时，图片不是位图，而是：
//   1. CF_HDROP 里一个指向 RWTemp 的解密后明文文件；
//   2. 私有格式 x-xwechat-multiselect-copy 里的 item 数组，带 file 的 item
//      与文本里的第 i 条消息一一对应。
// 这里只做两件事：把「哪个文件属于哪条消息」配好，再把字节读出来交给
// chat-db 存进 SQLite。不读微信数据库、不解密 .dat、不依赖临时目录长期存在。
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { log } = require('../lib/log');

const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;

// chat-parser 的结构化类型里只有这三种会带真实文件
const FILE_TYPES = { 图片: 'image', 视频: 'video', 文件: 'file' };

const MIME_BY_EXT = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp', '.heic': 'image/heic',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.avi': 'video/x-msvideo',
  '.pdf': 'application/pdf', '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.zip': 'application/zip', '.rar': 'application/vnd.rar', '.7z': 'application/x-7z-compressed',
  '.txt': 'text/plain', '.csv': 'text/csv', '.json': 'application/json'
};

function messageKey(m) {
  return `${m && m.name}|${m && m.ts}|${m && m.type}|${m && m.content}`;
}

function safeName(name, fallback) {
  const cleaned = String(name || '')
    .replace(/\\/g, '/').split('/').pop()
    .replace(/[<>:"|?*\x00-\x1f\x7f]/g, '_').replace(/[. ]+$/g, '').trim().slice(0, 180);
  return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : fallback;
}

// 只认图片魔数：扩展名可能是 .jpg 但内容是别的，或者干脆没扩展名。
// 顺带取宽高：没有视觉模型时，尺寸是元数据描述里最有信息量的一项。
function imageSize(buffer, kind) {
  try {
    if (kind === 'png') return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
    if (kind === 'gif') return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
    if (kind === 'bmp') return { width: buffer.readInt32LE(18), height: Math.abs(buffer.readInt32LE(22)) };
    if (kind === 'jpg') {
      // 逐段扫到 SOFn，拿宽高
      let offset = 2;
      while (offset + 9 < buffer.length) {
        if (buffer[offset] !== 0xff) { offset += 1; continue; }
        const marker = buffer[offset + 1];
        const length = buffer.readUInt16BE(offset + 2);
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
        }
        offset += 2 + length;
      }
    }
  } catch {}
  return null;
}

function sniffImage(buffer) {
  if (!buffer || buffer.length < 12) return null;
  let result = null;
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) result = { extension: '.png', mimeType: 'image/png', kind: 'png' };
  else if (buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) result = { extension: '.jpg', mimeType: 'image/jpeg', kind: 'jpg' };
  else if (/^GIF8[79]a$/.test(buffer.subarray(0, 6).toString('ascii'))) result = { extension: '.gif', mimeType: 'image/gif', kind: 'gif' };
  else if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') result = { extension: '.webp', mimeType: 'image/webp', kind: 'webp' };
  else if (buffer.subarray(0, 2).toString('ascii') === 'BM') result = { extension: '.bmp', mimeType: 'image/bmp', kind: 'bmp' };
  if (!result) return null;
  const size = imageSize(buffer, result.kind);
  return { extension: result.extension, mimeType: result.mimeType, width: size ? size.width : 0, height: size ? size.height : 0 };
}

// PDF：数一下页面对象（/Type /Page），抽正文留到以后再说
function pdfPageCount(buffer) {
  try {
    const text = buffer.toString('latin1');
    const match = text.match(/\/Type\s*\/Pages\b[^]*?\/Count\s+(\d+)/);
    if (match) return Number(match[1]) || 0;
    const pages = text.match(/\/Type\s*\/Page(?![s\w])/g);
    return pages ? pages.length : 0;
  } catch { return 0; }
}

function mimeFromName(name) {
  return MIME_BY_EXT[String(path.extname(String(name || '')).toLowerCase())] || 'application/octet-stream';
}

// 微信文本里给的名字才是人真正看得懂的名字（临时目录里的文件是哈希名）
function displayNameFromItem(item) {
  const text = String((item && item.text) || '');
  const match = text.match(/\[(文件|视频|图片)\]\s*(.+?)\s*$/m);
  return match ? match[2].trim() : '';
}

// 配对：返回与 msgs 等长的数组，每项是 null 或 { kind, source, name }
// media 形如 { files: [{ path, name }], wechat: [{ file?, text }] }
function planAttachments(msgs, media = {}) {
  const list = Array.isArray(msgs) ? msgs : [];
  const files = (Array.isArray(media && media.files) ? media.files : [])
    .map((file) => (typeof file === 'string' ? { path: file } : file))
    .filter((file) => file && String(file.path || '').trim());
  const wechat = Array.isArray(media && media.wechat) ? media.wechat : [];
  const plan = new Array(list.length).fill(null);
  if (!files.length || !list.length) return plan;

  // 1) 首选微信自己的映射：第 i 个 item 对应第 i 条消息，只有带 file 的 item 有附件。
  //    这条路径也是唯一能区分「多张图里哪张是哪条消息」的可靠依据。
  if (wechat.length === list.length) {
    wechat.forEach((item, i) => {
      const kind = FILE_TYPES[list[i] && list[i].type];
      const file = item && typeof item.file === 'string' ? item.file.trim() : '';
      if (!kind || !file) return;
      const display = displayNameFromItem(item) || safeName(path.basename(file), `${kind}-${i}`);
      plan[i] = { kind, source: file, name: display };
    });
    if (plan.some(Boolean)) return plan;
  }

  // 2) 兜底：没有私有格式（或条目数对不上）时，按顺序把文件发给按顺序出现的
  //    图片/视频/文件类消息。数量不一致时以少的一方为准，多余的忽略。
  const mediaIndexes = list.map((_, i) => i).filter((i) => FILE_TYPES[list[i] && list[i].type]);
  files.forEach((file, n) => {
    const target = mediaIndexes[n];
    if (target === undefined) return;
    const source = String(file.path);
    plan[target] = { kind: FILE_TYPES[list[target].type], source, name: safeName(file.name || path.basename(source), `${FILE_TYPES[list[target].type]}-${n}`) };
  });
  return plan;
}

// 读字节并整理成可入库的附件。文件已被微信清掉时抛错，由调用方决定是否跳过。
function readAttachment(entry) {
  if (!entry || !entry.source) return null;
  const stat = fs.statSync(entry.source);
  if (!stat.isFile() || stat.size <= 0) return null;
  if (stat.size > MAX_ATTACHMENT_BYTES) throw new Error(`附件超过 ${MAX_ATTACHMENT_BYTES} 字节上限`);
  const bytes = fs.readFileSync(entry.source);
  const image = entry.kind === 'image' ? sniffImage(bytes) : null;
  const kind = image ? 'image' : (entry.kind === 'image' ? 'file' : entry.kind);
  let name = safeName(entry.name, kind === 'image' ? '图片' : '文件');
  // 微信给图片起的名字一律是 .dat（占位），换回真实扩展名才像个文件
  if (image && /\.dat$/i.test(name)) name = name.replace(/\.dat$/i, image.extension);
  const mimeType = image ? image.mimeType : mimeFromName(name);
  return {
    kind,
    name,
    mimeType,
    size: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    width: image ? image.width : 0,
    height: image ? image.height : 0,
    pages: /pdf/i.test(mimeType) ? pdfPageCount(bytes) : 0,
    bytes
  };
}

// 给「本次新增的这批消息」挂上附件：配对按整段聊天（all）算，避免同一段里
// 部分消息已入库时索引错位；输出只覆盖 fresh。
function buildAttachments(fresh, all, media) {
  const list = Array.isArray(fresh) ? fresh : [];
  if (!list.length || !media) return list;
  const source = Array.isArray(all) && all.length ? all : list;
  const plan = planAttachments(source, media);
  if (!plan.some(Boolean)) return list;

  const byKey = new Map();
  plan.forEach((entry, i) => { if (entry) byKey.set(messageKey(source[i]), entry); });

  const out = [];
  for (const msg of list) {
    if (Array.isArray(msg.attachments) && msg.attachments.length) { out.push(msg); continue; }
    const entry = byKey.get(messageKey(msg));
    if (!entry) { out.push(msg); continue; }
    try {
      const attachment = readAttachment(entry);
      out.push(attachment ? { ...msg, attachments: [attachment] } : msg);
    } catch (error) {
      // 临时目录被清理 / 文件被占用：消息照常入库，只是没有图
      log('warn', 'capture', `附件读取失败（${entry.source}）：${(error && error.message) || error}`);
      out.push(msg);
    }
  }
  return out;
}

module.exports = {
  planAttachments,
  readAttachment,
  buildAttachments,
  messageKey,
  sniffImage,
  imageSize,
  pdfPageCount,
  MAX_ATTACHMENT_BYTES,
  FILE_TYPES
};
