// 小鹈鹕核心 — 聊天附件落盘
//
// 图片/文件不再塞进 SQLite：写到 <数据目录>/media/chat/ 下，按 sha256 命名
// （同一份内容只存一次），数据库里只留相对路径。这样库小、备份/迁移也直观。
'use strict';

const fs = require('fs');
const path = require('path');
const { getPaths } = require('../lib/paths');

const EXT_BY_MIME = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'image/heic': '.heic',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'application/pdf': '.pdf',
  'application/zip': '.zip',
  'text/plain': '.txt'
};

const SAFE_EXT = /^\.[a-z0-9]{1,8}$/i;

function rootDir() {
  return path.join(getPaths().dataDir, 'media', 'chat');
}

function extensionFor({ name, mimeType }) {
  const fromName = path.extname(String(name || '')).toLowerCase();
  if (SAFE_EXT.test(fromName)) return fromName;
  return EXT_BY_MIME[String(mimeType || '').toLowerCase()] || '.bin';
}

// 库里存相对路径（统一正斜杠），换机器/换盘符都不至于整库失效
function relativePath(sha256, { name, mimeType } = {}) {
  return `media/chat/${sha256}${extensionFor({ name, mimeType })}`;
}

function absolutePath(relative) {
  const rel = String(relative || '').replace(/\\/g, '/');
  if (!rel) return '';
  return path.join(getPaths().dataDir, ...rel.split('/'));
}

// 写入（幂等）：同样内容已经存在就直接复用
function save(buffer, { sha256, name, mimeType } = {}) {
  const hash = String(sha256 || '').trim();
  if (!hash) throw new Error('附件缺少 sha256，无法落盘');
  const rel = relativePath(hash, { name, mimeType });
  const target = absolutePath(rel);
  if (fs.existsSync(target)) {
    const stat = fs.statSync(target);
    if (stat.size === buffer.length) return rel;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, buffer, { mode: 0o600 });
  fs.renameSync(temporary, target);
  return rel;
}

function read(relative) {
  const target = absolutePath(relative);
  if (!target || !fs.existsSync(target)) return null;
  return fs.readFileSync(target);
}

function exists(relative) {
  const target = absolutePath(relative);
  return !!target && fs.existsSync(target);
}

function remove(relative) {
  const target = absolutePath(relative);
  if (!target) return false;
  try { fs.unlinkSync(target); return true; } catch { return false; }
}

module.exports = { rootDir, extensionFor, relativePath, absolutePath, save, read, exists, remove };
