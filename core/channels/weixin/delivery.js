'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { getPaths } = require('../../lib/paths');
const { MAX_MEDIA_BYTES, saveBuffer, publicAttachment } = require('./media');

function within(directory, file) {
  const relative = path.relative(directory, file);
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

function samePath(first, second) {
  return process.platform === 'win32' ? first.toLowerCase() === second.toLowerCase() : first === second;
}

async function protectedLocations(paths) {
  const locations = Object.entries(paths)
    .filter(([name]) => !['root', 'dataDir', 'weixinMedia'].includes(name))
    .map(([, location]) => location);
  locations.push(
    path.join(paths.dataDir, 'dsh-web-auth.json'),
    path.join(paths.dataDir, 'dsh-email.json'),
    process.env.DSH_HOME || path.join(paths.root, 'agent', 'dsh-home')
  );
  if (process.env.TINYPELICAN_EMAIL_CONFIG) locations.push(path.join(process.env.TINYPELICAN_EMAIL_CONFIG, 'dsh-email.json'));
  return Promise.all(locations.map(async location => {
    try { return await fs.realpath(location); } catch { return path.resolve(location); }
  }));
}

async function prepareReply(output, { allowedRoots, directory } = {}) {
  const paths = getPaths();
  const roots = allowedRoots || [paths.root, paths.dataDir];
  const resolvedRoots = await Promise.all(roots.map((root) => fs.realpath(root)));
  const protectedPaths = await protectedLocations(paths);
  const attachments = [];
  const errors = [];
  const lines = [];
  const seen = new Set();
  for (const line of String(output || '').split(/\r?\n/)) {
    const match = line.match(/^\s*MEDIA:\s*(.*?)\s*$/);
    if (!match) { lines.push(line); continue; }
    const file = match[1].replace(/^(["'])(.*)\1$/, '$2');
    if (seen.has(file)) continue;
    seen.add(file);
    try {
      if (attachments.length >= 10) throw new Error('单次最多发送 10 个附件');
      if (!path.isAbsolute(file)) throw new Error('附件需要使用绝对本地路径');
      const resolved = await fs.realpath(file);
      const root = resolvedRoots.find((entry) => within(entry, resolved));
      if (!root) throw new Error('附件不在应用工作目录内');
      const relative = path.relative(root, resolved);
      const segments = relative.split(path.sep);
      const protectedLocation = protectedPaths.some(location => samePath(location, resolved) || within(location, resolved));
      if (protectedLocation || segments.some((segment) => segment.startsWith('.') || /^(?:node_modules|logs|contacts|archives|dsh-home)$/i.test(segment))
          || /^(?:config|credentials|secrets|conversations|sessions|weixin-context|weixin-cursor|intents|tasks|schedules|dsh-web-auth|dsh-email)(?:[.-]|$)/i.test(path.basename(resolved))
          || /(?:^|[._-])(?:auth|credentials?|secrets?|tokens?)(?:[._-]|$)/i.test(path.basename(resolved))
          || /\.(?:(?:sqlite3?|db)(?:[-.](?:wal|shm|journal|backup|bak))?|pem|key|p12|pfx|jsonl|log)$/i.test(resolved)) {
        throw new Error('应用配置、凭据及内部记录不能作为自动回复附件发送');
      }
      const stat = await fs.stat(resolved);
      if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_MEDIA_BYTES) throw new Error('附件为空或超过 100 MB 限制');
      const buffer = await fs.readFile(resolved);
      attachments.push(await saveBuffer(buffer, { name: path.basename(resolved), direction: 'outbound', directory }));
    } catch (error) {
      errors.push(error.code ? '附件无法读取，请重新生成或检查文件' : error.message);
    }
  }
  const text = [lines.join('\n').trim(), errors.length ? `附件未能发送：${[...new Set(errors)].join('；')}` : ''].filter(Boolean).join('\n');
  return { text, attachments, errors };
}

async function deliverReply(channel, { to, text = '', attachments = [], contextToken = '' } = {}) {
  const delivered = [];
  let deliveredText = '';
  async function send(message) {
    const result = await channel.send({ to, ...message, contextToken });
    if (!result?.ok && result?.staleToken && contextToken) return channel.send({ to, ...message });
    return result;
  }
  if (text) {
    const result = await send({ text });
    if (!result?.ok) return { ok: false, text: '', attachments: delivered, error: result?.error || '微信消息发送失败' };
    deliveredText = text;
  }
  for (const attachment of attachments) {
    const result = await send({ attachment });
    if (!result?.ok) return { ok: false, text: deliveredText, attachments: delivered, error: result?.error || '微信附件发送失败' };
    delivered.push(publicAttachment(attachment));
  }
  return { ok: true, text: deliveredText, attachments: delivered };
}

module.exports = { prepareReply, deliverReply };
