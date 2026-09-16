// 微信聊天记录批量导入
//
// 场景：微信「导出聊天记录 / 转发到其他应用」会把聊天记录交给我们（通常是 ZIP 或 TXT）。
// 这里负责：识别文件 → 解码 → 解析成统一消息 → 归档进 SQLite（按联系人、自动去重）。
//
// 支持的输入：
//   - .zip：内存内解压（core/import/zip.js），逐个文本条目解析；不落盘、防 zip-slip / 解压炸弹
//   - 文本：.txt / .csv / .json / .jsonl / .md / .log
// 支持的消息格式（按顺序尝试）：
//   1. 微信「复制」格式（昵称 / 时间 / 内容，消息间空行）——与剪贴板捕获同一套解析器
//   2. 「昵称 日期 时间 内容」单行格式（同上解析器）
//   3. CSV / JSON / JSONL（导出工具常用，字段名容忍 name/sender、ts/timestamp、content/text）
//   4. 宽松行格式：[2024-01-01 10:00] 昵称: 内容  /  2024-01-01 10:00:05 昵称: 内容
//   5. 微信 4.x「转发到其他应用」导出：每条消息一行、行首 `·`、无昵称无时间戳，媒体用 [类型] 占位
'use strict';

const fs = require('fs');
const path = require('path');
const { parseBlockFormat, parseLineFormat, getBatchContact, classifyContent } = require('../lib/chat-parser');
const { loadConfig } = require('../lib/config');
const { log } = require('../lib/log');
const chatDb = require('../memory/chat-db');
const { readEntries } = require('./zip');

const TEXT_EXT = new Set(['.txt', '.csv', '.json', '.jsonl', '.ndjson', '.md', '.log', '.tsv']);
const MAX_FILES = 500;
const MAX_FILE_BYTES = 512 * 1024 * 1024;
const MAX_PREVIEW_LINES = 5;

// ── 解码 ────────────────────────────────────────────────────────────────────
function decodeText(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return '';
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.slice(3).toString('utf8');
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(buffer.slice(2));
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(buffer.slice(2));
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {}
  // 老导出工具常见 GBK/GB18030
  for (const enc of ['gb18030', 'gbk']) {
    try {
      return new TextDecoder(enc).decode(buffer);
    } catch {}
  }
  return buffer.toString('utf8');
}

function normalizeTs(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const m = text.match(/^(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})日?[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (m) {
    const pad = (v) => String(Number(v)).padStart(2, '0');
    return `${m[1]}-${pad(m[2])}-${pad(m[3])} ${pad(m[4])}:${m[5]}`;
  }
  return text;
}

function normalizeMessage(raw) {
  const name = String(raw.name || raw.sender || raw.senderName || raw.nickname || '').trim();
  const content = String(raw.content ?? raw.text ?? raw.message ?? '').trim();
  const ts = normalizeTs(raw.ts || raw.timestamp || raw.time || raw.date);
  const typeRaw = String(raw.type || '').trim();
  const cls = typeRaw && typeRaw !== 'text' ? { type: typeRaw, content } : classifyContent(content);
  return { name, ts, type: cls.type, content: cls.content };
}

// ── 各格式解析 ──────────────────────────────────────────────────────────────
// 微信 4.x 转发导出的 聊天记录.txt：一行一条消息，行首 `·`（U+00B7），不含昵称与时间。
// 例：·[文件] 简历.pdf / ·[图片] 微信图片_2026.jpg / ·[链接] 标题 https://… / ·普通文本 / ·[语音] 1"
const MEDIA_LINE_RE = /^\[(文件|图片|视频|语音|动画表情|链接|小程序|名片|位置|转账|红包|引用|聊天记录)\]\s*(.*)$/;

function parseWechatForwardExport(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) return [];
  const dotted = lines.filter((l) => l.startsWith('·')).length;
  if (dotted / lines.length < 0.8) return [];

  const out = [];
  for (const line of lines) {
    const body = line.replace(/^·\s*/, '').trim();
    if (!body) continue;
    const media = body.match(MEDIA_LINE_RE);
    if (media) {
      // 媒体消息：把文件名/标题留在 content 里（附件本身在压缩包的「聊天记录内的图片、视频和文件/」下）
      out.push({ name: '', ts: '', type: media[1], content: media[2].trim() });
      continue;
    }
    out.push({ name: '', ts: '', type: 'text', content: body });
  }
  return out;
}

function parseLooseLines(text) {
  const out = [];
  const patterns = [
    /^\[(\d{4}[-/年]\d{1,2}[-/月]\d{1,2}日?[ T]+\d{1,2}:\d{2}(?::\d{2})?)\]\s*([^:：]{1,40})[:：]\s*(.*)$/,
    /^(\d{4}[-/年]\d{1,2}[-/月]\d{1,2}日?[ T]+\d{1,2}:\d{2}(?::\d{2})?)\s+([^:：]{1,40})[:：]\s*(.*)$/
  ];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    for (const re of patterns) {
      const m = line.match(re);
      if (!m) continue;
      const msg = normalizeMessage({ name: m[2], ts: m[1], content: m[3] });
      if (msg.name && msg.content) out.push(msg);
      break;
    }
  }
  return out;
}

function splitCsvLine(line) {
  const cells = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else quoted = false;
      } else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { cells.push(cur); cur = ''; }
    else cur += ch;
  }
  cells.push(cur);
  return cells.map((c) => c.trim());
}

function parseCsv(text) {
  const lines = String(text || '').split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const header = splitCsvLine(lines[0]).map((h) => h.toLowerCase());
  const hasHeader = header.some((h) => ['name', 'sender', 'nickname', '内容', 'content', 'text', 'ts', 'timestamp', '时间'].includes(h));
  if (!hasHeader) return [];
  const idx = (...keys) => header.findIndex((h) => keys.includes(h));
  const iName = idx('name', 'sender', 'nickname', '昵称', '发送者');
  const iTs = idx('ts', 'timestamp', 'time', 'date', '时间');
  const iContent = idx('content', 'text', 'message', '内容');
  const iType = idx('type', '类型');
  if (iContent < 0) return [];
  const out = [];
  for (const line of lines.slice(1)) {
    const cells = splitCsvLine(line);
    const msg = normalizeMessage({
      name: iName >= 0 ? cells[iName] : '',
      ts: iTs >= 0 ? cells[iTs] : '',
      type: iType >= 0 ? cells[iType] : '',
      content: cells[iContent]
    });
    if (msg.content) out.push(msg);
  }
  return out;
}

function parseStructured(text, filename) {
  const trimmed = String(text || '').trim();
  const looksJson = trimmed.startsWith('[') || trimmed.startsWith('{');
  const looksJsonl = /\.(jsonl|ndjson)$/i.test(filename);
  if (!looksJson && !looksJsonl) return [];
  const rows = [];
  if (looksJsonl) {
    for (const line of trimmed.split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      try {
        const obj = JSON.parse(t);
        if (obj && typeof obj === 'object') rows.push(obj);
      } catch {}
    }
  } else {
    try {
      const data = JSON.parse(trimmed);
      if (Array.isArray(data)) rows.push(...data);
      else if (data && Array.isArray(data.messages)) rows.push(...data.messages);
      else if (data && typeof data === 'object') rows.push(data);
    } catch {
      return [];
    }
  }
  return rows
    .filter((r) => r && typeof r === 'object')
    .map((r) => normalizeMessage(r))
    .filter((m) => m.content);
}

// 依次尝试各种格式，返回 { messages, format }
// 注意：这里直接调 block/line 两个解析器（而不是 parseChatText）——
// parseChatText 对「只有一条消息」的文件会返回空，而导出文件里单聊一条也很常见。
function parseAny(text, filename = '') {
  const forward = parseWechatForwardExport(text);
  if (forward.length) return { messages: forward, format: 'wechat-forward' };

  const block = parseBlockFormat(text);
  const line = parseLineFormat(text);
  const wechat = block.length >= line.length ? block : line;
  if (wechat.length) return { messages: wechat.map((m) => normalizeMessage(m)), format: 'wechat' };

  const structured = parseStructured(text, filename);
  if (structured.length) return { messages: structured, format: 'json' };

  const csv = parseCsv(text);
  if (csv.length) return { messages: csv, format: 'csv' };

  const loose = parseLooseLines(text);
  if (loose.length) return { messages: loose, format: 'lines' };

  return { messages: [], format: '' };
}

// ── 联系人推断 ──────────────────────────────────────────────────────────────
function contactFromName(filename, selfNicknames = []) {
  let base = path.basename(String(filename || ''), path.extname(String(filename || '')));
  base = base.replace(/[（(]\d+[)）]$/, '').trim();
  // 先剥掉「导出时间」尾巴（_20260916_233405 / -20260916），否则通用名会被当成联系人
  const withoutStamp = base.replace(/([_\-\s]*\d{4,}){1,2}$/, '').trim() || base;
  const stripped = withoutStamp
    .replace(/^与/, '')
    .replace(/(的)?(聊天记录|聊天|消息记录|消息|导出记录|记录)$/, '')
    .replace(/^(chat|wechat|weixin|message|messages)[_\-\s]*/i, '')
    .trim();
  const candidate = stripped || withoutStamp;
  if (!candidate) return '';
  if (selfNicknames.includes(candidate)) return '';
  // 微信「转发到其他应用」导出的文件名是「聊天记录_20260916_233405」这类通用名，不是联系人
  if (/^(微信|weixin|wechat)?(聊天)?(记录|导出|messages?|export|数据|全部)?$/i.test(candidate)) return '';
  if (/^[\d\-_\s]+$/.test(candidate)) return '';
  return candidate;
}

// 从「聊天记录_20260916_233405.zip」这类文件名里取出导出时间（用于给无时间戳的消息排序/去重）
function exportTimeFromName(filename) {
  const m = String(filename || '').match(/(\d{4})(\d{2})(\d{2})[-_]?(\d{2})(\d{2})(\d{2})?/);
  if (!m) return '';
  return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}`;
}

// ── 导入 ────────────────────────────────────────────────────────────────────
function collectFiles(inputs, depth = 0, out = []) {
  for (const input of inputs) {
    let stat;
    try {
      stat = fs.statSync(input);
    } catch (e) {
      out.push({ path: input, error: '文件不存在或无法访问：' + String((e && e.message) || e) });
      continue;
    }
    if (stat.isDirectory()) {
      if (depth > 3) continue;
      const children = fs.readdirSync(input).map((f) => path.join(input, f));
      collectFiles(children, depth + 1, out);
      continue;
    }
    if (!stat.isFile()) continue;
    if (stat.size > MAX_FILE_BYTES) {
      out.push({ path: input, error: `文件过大（${Math.round(stat.size / 1048576)}MB）` });
      continue;
    }
    out.push({ path: input });
    if (out.length >= MAX_FILES) return out;
  }
  return out;
}

function previewOf(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, MAX_PREVIEW_LINES)
    .join(' / ')
    .slice(0, 400);
}

function looksLikeSqlite(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length > 16 && buffer.slice(0, 15).toString('utf8') === 'SQLite format 3';
}

// 导入一批文件/目录；config 决定 selfNicknames 等
async function importChatArchives({ paths = [], config = null, dryRun = false, contact = '' } = {}) {
  const cfg = config || loadConfig();
  const selfNicknames = Array.isArray(cfg.selfNicknames) ? cfg.selfNicknames : [];
  const importCfg = cfg.import || {};
  // 微信「转发到其他应用」的导出不含昵称与时间，无法自动归属联系人；
  // 统一放进一个可见的容器里（可改配置），消息时间用导出时间，保证可排序、重复导入可去重。
  const unassignedContact = String(importCfg.unassignedContact || '微信导出（未归属）').trim() || '微信导出（未归属）';
  const unlabeledSender = '未标注';
  const contactOverride = String(contact || '').trim();
  const summary = {
    ok: true,
    dryRun: !!dryRun,
    files: [],
    contacts: {},
    attachments: [],
    messages: 0,
    added: 0,
    skipped: 0
  };

  const targets = collectFiles(paths);
  if (!targets.length) {
    summary.ok = false;
    summary.error = '没有可导入的文件';
    return summary;
  }

  const ingest = (contact, msgs) => {
    summary.messages += msgs.length;
    if (dryRun) return msgs.length;
    const added = chatDb.ingestMessages(contact, msgs);
    summary.contacts[contact] = (summary.contacts[contact] || 0) + added;
    return added;
  };

  const handleText = (label, text, contactHint, opts = {}) => {
    const { messages, format } = parseAny(text, label);
    if (!messages.length) {
      summary.skipped++;
      summary.files.push({ file: label, status: 'unparsed', preview: previewOf(text) });
      return;
    }
    // 一个文件 = 一段会话：联系优先取消息里唯一的「非自己昵称」，
    // 拿不到再用文件名推断（「与张三的聊天记录.txt」）。
    const derived = getBatchContact(messages, selfNicknames);
    const isForwardExport = format === 'wechat-forward';
    const resolved = derived || contactHint || '';
    const finalContact = contactOverride || resolved || (isForwardExport ? unassignedContact : '');
    if (!finalContact) {
      summary.skipped++;
      summary.files.push({ file: label, status: 'no-contact', messages: messages.length, preview: previewOf(text) });
      return;
    }
    const prepared = isForwardExport
      ? messages.map((m) => ({ ...m, name: m.name || unlabeledSender, ts: m.ts || opts.exportTs || '' }))
      : messages;
    const added = ingest(finalContact, prepared);
    summary.files.push({
      file: label,
      status: 'imported',
      format,
      contact: finalContact,
      messages: prepared.length,
      added,
      ...(isForwardExport && !contactOverride ? { note: '该导出不含昵称与时间戳，已按导出时间归档到「' + finalContact + '」' } : {})
    });
  };

  for (const target of targets) {
    if (target.error) {
      summary.ok = false;
      summary.files.push({ file: target.path, status: 'error', error: target.error });
      continue;
    }
    const ext = path.extname(target.path).toLowerCase();
    try {
      const buffer = fs.readFileSync(target.path);
      if (looksLikeSqlite(buffer)) {
        summary.skipped++;
        summary.files.push({ file: target.path, status: 'unsupported', error: '这是一个 SQLite 数据库，暂不支持直接导入（请导出为 TXT/ZIP）' });
        continue;
      }
      if (ext === '.zip') {
        const entries = readEntries(buffer);
        const texts = entries.filter((e) => TEXT_EXT.has(path.extname(e.name).toLowerCase()));
        // 微信转发导出的附件（图片/视频/文件）就在包里，这里只登记，不落盘
        for (const entry of entries) {
          if (TEXT_EXT.has(path.extname(entry.name).toLowerCase())) continue;
          summary.attachments.push({ name: entry.name, size: entry.size, from: path.basename(target.path) });
        }
        if (!texts.length) {
          summary.skipped++;
          summary.files.push({ file: target.path, status: 'unsupported', error: `压缩包里没有可识别的文本（${entries.length} 个条目）` });
          continue;
        }
        const exportTs = exportTimeFromName(target.path) || new Date().toISOString().slice(0, 16).replace('T', ' ');
        for (const entry of texts) {
          const label = `${path.basename(target.path)} → ${entry.name}`;
          try {
            handleText(
              label,
              decodeText(entry.read()),
              contactFromName(entry.name, selfNicknames) || contactFromName(target.path, selfNicknames),
              { exportTs }
            );
          } catch (e) {
            summary.skipped++;
            summary.files.push({ file: label, status: 'error', error: String((e && e.message) || e) });
          }
        }
        continue;
      }
      if (!TEXT_EXT.has(ext)) {
        summary.skipped++;
        summary.files.push({ file: target.path, status: 'unsupported', error: `不支持的文件类型 ${ext || '(无扩展名)'}` });
        continue;
      }
      handleText(target.path, decodeText(buffer), contactFromName(target.path, selfNicknames), {
        exportTs: exportTimeFromName(target.path) || new Date().toISOString().slice(0, 16).replace('T', ' ')
      });
    } catch (e) {
      summary.skipped++;
      summary.files.push({ file: target.path, status: 'error', error: String((e && e.message) || e) });
    }
  }

  summary.added = Object.values(summary.contacts).reduce((a, b) => a + b, 0);
  log('info', 'ingest', `聊天记录导入：${summary.files.filter((f) => f.status === 'imported').length} 个文件 / ${summary.messages} 条消息 / 新增 ${summary.added} 条（${dryRun ? 'dry-run' : '已入库'}）`);
  return summary;
}

module.exports = {
  importChatArchives,
  parseAny,
  parseWechatForwardExport,
  decodeText,
  contactFromName,
  exportTimeFromName,
  normalizeTs
};

// ── CLI：node core/import/chat-archive.js <文件或目录...> [--dry-run] [--json] [--contact 名字] ──
if (require.main === module) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const asJson = args.includes('--json');
  const contactIdx = args.findIndex((a) => a === '--contact');
  const contact = contactIdx >= 0 ? args[contactIdx + 1] || '' : '';
  const paths = args.filter((a, i) => !a.startsWith('--') && (contactIdx < 0 || i !== contactIdx + 1));
  importChatArchives({ paths, dryRun, contact })
    .then((summary) => {
      if (asJson) return console.log(JSON.stringify(summary, null, 2));
      console.log(`导入${summary.dryRun ? '（试运行）' : ''}：${summary.files.length} 个文件，解析 ${summary.messages} 条消息，新增 ${summary.added} 条`);
      for (const f of summary.files) {
        const tail = f.status === 'imported' ? `${f.format} / ${f.messages} 条 / 新增 ${f.added}` : (f.error || f.preview || '');
        console.log(`  [${f.status}] ${f.file}${tail ? '  —  ' + tail : ''}`);
      }
      if (!summary.ok) process.exitCode = 1;
    })
    .catch((e) => {
      console.error('导入失败：' + String((e && e.message) || e));
      process.exitCode = 1;
    });
}
