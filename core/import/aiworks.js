// 思必驰（AIWorks）云笔记导入：录音转写 → 聊天消息
// 设计上分三层：
//   - 纯函数（transcript / toMessages）：把转写文本切成发言段、按说话人身份映射成消息，便于单测；
//   - createAiworks：云端接口封装（fetch 可注入，测试不访问外网）与本地授权码存取；
//   - 路由层（core/api/routes/aiworks.js）：HTTP 壳和聊天库写入。
// 授权码在 Windows 上用 DPAPI 加密后落盘（只有当前 Windows 用户能解）；
// 其他平台只放内存，重启后需要重新连接。
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { getPaths } = require('../lib/paths');

const API = 'https://aiworks.cn/aitablet/api/skill/v2';
const PAGE_SIZE = 20;
const MAX_TEXT = 120000;

function failure(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

async function request(token, endpoint, fetchImpl) {
  let response;
  let result;
  try {
    response = await fetchImpl(API + endpoint, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      redirect: 'error', signal: AbortSignal.timeout(12000)
    });
    result = await response.json();
  } catch {
    throw failure('暂时无法读取思必驰云端，请检查网络后重试。', 502);
  }
  switch (String(result?.code)) {
    case '202400': case '202401': case '202402': case '202403':
      throw failure('思必驰授权已失效，请在开放平台获取授权后重新连接。', 422);
    case '202404':
      throw failure('此授权缺少笔记读取权限（NOTE_READ）。', 403);
    case '202405':
      throw failure('思必驰请求过于频繁，请稍后重试。', 429);
  }
  if (!response.ok || String(result?.code) !== '0' || !result.data) {
    throw failure('思必驰暂时无法返回笔记，请重试。', 502);
  }
  return result.data;
}

function protect(value, decrypt = false) {
  const script = decrypt
    ? '$bytes=[Convert]::FromBase64String([Console]::In.ReadToEnd()); [Console]::Write([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)))'
    : '$bytes=[Convert]::FromBase64String([Console]::In.ReadToEnd()); [Console]::Write([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)))';
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; ${script}`], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'], timeout: 6000
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stdin.on('error', reject);
    child.on('error', reject);
    child.on('close', code => code === 0 && output.trim() ? resolve(output.trim()) : reject(new Error('DPAPI failed')));
    child.stdin.end(value);
  });
}

function createTokenStore() {
  const file = path.join(getPaths().dataDir, 'credentials.aiworks');
  let temporaryToken = '';
  return {
    async read() {
      if (process.platform !== 'win32') return temporaryToken;
      try {
        const encrypted = await fs.readFile(file, 'utf8');
        return Buffer.from(await protect(encrypted, true), 'base64').toString('utf8');
      } catch (error) {
        if (error.code === 'ENOENT') return '';
        throw failure('无法读取思必驰授权，请重新连接。', 422);
      }
    },
    async save(token) {
      if (process.platform !== 'win32') { temporaryToken = token; return; }
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        const encrypted = await protect(Buffer.from(token, 'utf8').toString('base64'));
        await fs.writeFile(temporary, encrypted, { mode: 0o600 });
        await fs.rename(temporary, file);
      } catch {
        throw failure('无法保存思必驰授权，请检查 Windows 用户目录后重试。', 500);
      } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
    },
    async clear() {
      temporaryToken = '';
      if (process.platform === 'win32') await fs.rm(file, { force: true });
    },
    persistent: process.platform === 'win32'
  };
}

// 云端时间可能是毫秒时间戳，也可能是不带时区的北京时间字符串。
function noteTime(value) {
  const text = String(value ?? '');
  if (/^\d{13}$/.test(text)) return Number(text);
  return Date.parse(/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(text) ? text.replace(' ', 'T') + '+08:00' : text);
}

// 把一段转写切成 [{speaker,time,text}]。两种来源：
//   - 云端笔记：整段文本，只有「说话人N：」这类标签才切；
//   - 用户粘贴：更宽松，任何「名字：」都当说话人标签（否则多人转写多半不能识别）。
function transcript(value, { pasted = false } = {}) {
  if (typeof value !== 'string' || !value.trim()) throw failure('这条笔记暂无转写，请在思必驰 App 中完成转写并同步后再试。', 422);
  if (value.length > MAX_TEXT) throw failure('这份转写太长，请在思必驰 App 中分段后导入。', 413);
  const segments = [];
  let pending = [];
  for (const line of value.split(/\r?\n/)) {
    const text = line.trim();
    if (!text) continue;
    const clock = /^(?:\[?(\d{1,3}:\d{2}(?::\d{2})?(?:\.\d{1,3})?)\]?\s*)?(.*)$/.exec(text);
    const match = (pasted || clock[1] ? /^([^:：\n]{1,32})\s*[:：]\s*(.*)$/ : /^((?:说话人|发言人|讲者|Speaker)\s*[\p{L}\p{N}_-]*)\s*[:：]\s*(.*)$/iu).exec(clock[2]);
    if (!match && !clock[1]) { pending.push(text); continue; }
    if (pending.length && !segments.length) segments.push({ speaker: '', time: '', text: pending.join('\n') });
    else if (pending.length) segments.at(-1).text += '\n' + pending.join('\n');
    pending = [];
    segments.push({ speaker: match ? match[1].trim() : '', time: clock[1] || '', text: match ? match[2] : clock[2] });
  }
  if (pending.length && segments.length) segments.at(-1).text += '\n' + pending.join('\n');
  else if (pending.length) segments.push({ speaker: '', time: '', text: pending.join('\n') });
  const usable = segments.filter(segment => segment.text.trim());
  if (usable.length > 2000) throw failure('这份转写分段过多，请分批导入。', 413);
  return usable;
}

// roles: { 说话人标签: 'self' | 'contact' | 'skip' }；只保留「我」和选定联系人的发言。
// externalId 由 [录音标识, 段指纹, 出现次数] 组成：同一条笔记重复导入时稳定不变，
// 即使开始时间被修改过也能认出来（前提是聊天库按 externalId 去重，见 chat-db 的 source 支持）。
function toMessages(segments, roles, contact, startedAt, recordingId) {
  const start = noteTime(startedAt);
  if (!Number.isFinite(start)) throw failure('请选择录音的开始时间。');
  if (!roles || typeof roles !== 'object' || Array.isArray(roles)) throw failure('请确认每位说话人的身份。');
  const messages = [];
  const occurrences = new Map();
  let at = start;
  for (const segment of segments) {
    const role = Object.hasOwn(roles, segment.speaker) ? roles[segment.speaker] : '';
    if (!['self', 'contact', 'skip'].includes(role)) throw failure('请确认每位说话人的身份，或将其标记为跳过。');
    if (segment.time) {
      const seconds = segment.time.split(':').reduce((total, part) => total * 60 + Number(part), 0);
      at = start + Math.round(seconds * 1000);
    }
    const signature = fingerprint(JSON.stringify([segment.time, segment.speaker, segment.text]));
    const occurrence = (occurrences.get(signature) || 0) + 1;
    occurrences.set(signature, occurrence);
    if (role === 'skip') continue;
    messages.push({
      name: role === 'self' ? '我' : contact,
      ts: new Date(at).toISOString(),
      type: 'text',
      source: 'aiworks',
      isOwner: role === 'self',
      externalId: JSON.stringify([recordingId, signature, occurrence]),
      content: segment.text
    });
  }
  if (!messages.length) throw failure('请至少保留一段发言。');
  return messages;
}

function createAiworks({ tokens = createTokenStore(), fetchImpl = fetch } = {}) {
  async function credential() {
    const token = await tokens.read();
    if (!token) throw failure('请先连接思必驰账号。', 422);
    return token;
  }
  async function notes(token, page) {
    const data = await request(token, `/note/list?pageNum=${page}&pageSize=${PAGE_SIZE}`, fetchImpl);
    if (!Array.isArray(data.list)) throw failure('思必驰返回的笔记列表格式异常。', 502);
    return {
      notes: data.list.filter(item => typeof item?.noteUid === 'string').map(item => ({ uid: item.noteUid, title: item.title, createdAt: item.createTime })),
      page, hasMore: page * PAGE_SIZE < Number(data.total)
    };
  }
  return {
    async status() {
      try { return { connected: !!await tokens.read(), persistent: tokens.persistent }; }
      catch (error) { return { connected: false, persistent: tokens.persistent, error: error.message }; }
    },
    async connect(value) {
      const token = typeof value === 'string' ? value.trim() : '';
      if (!/^[!-~]{1,2048}$/.test(token)) throw failure('请输入有效的思必驰授权码。');
      await notes(token, 1);
      await tokens.save(token);
      return { connected: true, persistent: tokens.persistent };
    },
    async disconnect() { await tokens.clear(); return { connected: false }; },
    async list(page) { return notes(await credential(), page); },
    async preview(uid) {
      if (typeof uid !== 'string' || !uid.trim() || uid.length > 160 || /[/\\\u0000-\u001f]/.test(uid) || ['.', '..'].includes(uid)) throw failure('笔记编号无效。');
      const data = await request(await credential(), '/note/' + encodeURIComponent(uid), fetchImpl);
      if (data.noteUid && data.noteUid !== uid) throw failure('思必驰返回了不同的笔记，请重新选择。', 502);
      const segments = transcript(data.asrContent);
      const created = noteTime(data.createTime);
      return {
        uid, title: data.title, createdAt: Number.isFinite(created) ? new Date(created).toISOString() : '',
        segments, version: fingerprint(data.asrContent), raw: data.asrContent
      };
    }
  };
}

function fingerprint(value) {
  return createHash('sha256').update(value).digest('hex');
}

module.exports = { createAiworks, createTokenStore, failure, transcript, toMessages, fingerprint };
