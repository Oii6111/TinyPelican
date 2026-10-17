'use strict';

const crypto = require('node:crypto');

function cleanText(value) {
  return String(value || '')
    .replace(/\r/g, '')
    .replace(/^[ \t]*>.*$/gm, '')
    .replace(/\n?-----Original Message-----[\s\S]*$/i, '')
    .replace(/\n?On .{0,160}wrote:[\s\S]*$/i, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 200000);
}

function cleanHtml(value) {
  return String(value || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^ >]+)/gi, '')
    .replace(/(href|src)\s*=\s*(["'])\s*javascript:[^"']*\2/gi, '$1="#"')
    .slice(0, 500000);
}

function address(value) {
  if (!value) return {};
  if (typeof value === 'string') return { address: value };
  return { name: String(value.name || ''), address: String(value.address || '') };
}

function addresses(value) {
  if (!value) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.map(address).filter((item) => item.address);
}

function isoDate(...values) {
  for (const value of values) {
    if (value === undefined || value === null || value === '') continue;
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isFinite(date.getTime())) return date.toISOString();
  }
  return new Date().toISOString();
}

async function parseRawEmail(raw, metadata = {}) {
  let simpleParser;
  try { ({ simpleParser } = require('mailparser')); } catch (error) { throw new Error('邮件解析依赖未安装，请运行 npm install'); }
  const parsed = await simpleParser(raw);
  const text = cleanText(parsed.text || parsed.htmlToText?.() || '');
  const html = cleanHtml(parsed.html || '');
  const attachments = (parsed.attachments || []).map((item) => ({ filename: String(item.filename || ''), contentType: String(item.contentType || ''), size: Number(item.size || item.content?.length || 0), checksum: item.checksum || '' }));
  const messageId = String(parsed.messageId || metadata.messageId || '');
  const contentHash = crypto.createHash('sha256').update(`${messageId}\n${parsed.subject || ''}\n${text}`).digest('hex');
  return {
    accountId: metadata.accountId, folder: metadata.folder || 'INBOX', uidValidity: Number(metadata.uidValidity || 0), uid: Number(metadata.uid || 0),
    messageId, contentHash, threadId: String(parsed.inReplyTo || parsed.references?.[0] || messageId || ''),
    from: address(parsed.from?.value?.[0] || parsed.from?.text || ''), to: addresses(parsed.to?.value), cc: addresses(parsed.cc?.value),
    subject: String(parsed.subject || ''), date: isoDate(parsed.date, metadata.internalDate),
    text, html, snippet: text.replace(/\s+/g, ' ').slice(0, 600), attachments
  };
}

module.exports = { cleanText, cleanHtml, parseRawEmail };
