// 最小 ZIP 读取器（内存内解压）
// 核心不引第三方运行时依赖，所以自己解析中央目录 + zlib.inflateRawSync。
// 只做「读」：支持 store(0) / deflate(8)，拒绝加密条目与 ZIP64，带解压炸弹防护。
// 注意：本模块永远不往磁盘写文件，压缩包里的路径只当作标签用（仍会拦 `..` 之类，防患于未然）。
'use strict';

const zlib = require('zlib');

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const ZIP64_SENTINEL = 0xffffffff;

const DEFAULTS = {
  maxEntries: 500,
  maxEntryBytes: 64 * 1024 * 1024,      // 单个条目解压后上限
  maxTotalBytes: 512 * 1024 * 1024      // 整包解压后上限
};

function findEndOfCentralDirectory(buf) {
  const minPos = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= minPos; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  }
  return -1;
}

function safeEntryName(name) {
  const normalized = String(name || '').replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) return null;
  if (normalized.split('/').some((seg) => seg === '..')) return null;
  return normalized;
}

// 解析 ZIP 目录；返回 [{ name, size, isDirectory, read() }]
// read() 返回 Buffer（解压后的内容），只在调用时才真正解压。
function readEntries(buffer, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) throw new Error('不是有效的 ZIP（文件过小）');

  const eocd = findEndOfCentralDirectory(buffer);
  if (eocd < 0) throw new Error('不是有效的 ZIP（找不到中央目录）');

  const total = buffer.readUInt16LE(eocd + 10);
  const cdOffsetRaw = buffer.readUInt32LE(eocd + 16);
  if (total === 0xffff || cdOffsetRaw === ZIP64_SENTINEL) throw new Error('暂不支持 ZIP64 格式的压缩包');
  if (total > opts.maxEntries) throw new Error(`压缩包条目过多（${total} > ${opts.maxEntries}）`);

  const entries = [];
  let cursor = cdOffsetRaw;
  let totalUncompressed = 0;

  for (let i = 0; i < total; i++) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== SIG_CENTRAL) {
      throw new Error('ZIP 中央目录损坏');
    }
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const crc = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLen = buffer.readUInt16LE(cursor + 28);
    const extraLen = buffer.readUInt16LE(cursor + 30);
    const commentLen = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const rawName = buffer.slice(cursor + 46, cursor + 46 + nameLen).toString('utf8');
    cursor += 46 + nameLen + extraLen + commentLen;

    const name = safeEntryName(rawName);
    const isDirectory = rawName.endsWith('/');
    if (!name) continue;                                   // 路径不安全：直接忽略
    if (isDirectory) continue;
    if (compressedSize === ZIP64_SENTINEL || uncompressedSize === ZIP64_SENTINEL || localOffset === ZIP64_SENTINEL) {
      throw new Error(`条目 ${name} 使用 ZIP64 扩展，暂不支持`);
    }
    if (flags & 0x1) throw new Error(`压缩包已加密，无法读取（${name}）`);
    if (![0, 8].includes(method)) throw new Error(`条目 ${name} 使用了不支持的压缩方式（method=${method}）`);
    if (uncompressedSize > opts.maxEntryBytes) throw new Error(`条目过大：${name}（${uncompressedSize} 字节）`);
    totalUncompressed += uncompressedSize;
    if (totalUncompressed > opts.maxTotalBytes) throw new Error('压缩包解压后体积过大，已中止导入');

    entries.push({
      name,
      size: uncompressedSize,
      compressedSize,
      method,
      read() {
        if (buffer.readUInt32LE(localOffset) !== SIG_LOCAL) throw new Error(`条目 ${name} 的本地头损坏`);
        const localNameLen = buffer.readUInt16LE(localOffset + 26);
        const localExtraLen = buffer.readUInt16LE(localOffset + 28);
        const start = localOffset + 30 + localNameLen + localExtraLen;
        const raw = buffer.slice(start, start + compressedSize);
        const out = method === 0 ? raw : zlib.inflateRawSync(raw, { maxOutputLength: opts.maxEntryBytes });
        if (typeof zlib.crc32 === 'function' && uncompressedSize > 0) {
          const actual = zlib.crc32(out);
          if (actual !== crc) throw new Error(`条目 ${name} CRC 校验失败（文件可能损坏）`);
        }
        return out;
      }
    });
  }

  return entries;
}

module.exports = { readEntries, safeEntryName };
