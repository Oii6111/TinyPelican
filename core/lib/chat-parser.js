// 小鹈鹕核心 — 微信聊天文本解析（JavaScript 参考实现）
// 与 watch-clipboard.ps1 的解析逻辑保持一致，供测试与 Node 版捕获/通道复用。
'use strict';

const STRUCTURAL_TYPES = ['动画表情', '图片', '语音', '视频', '文件', '链接', '位置', '转账', '红包', '小程序', '名片', '引用'];
const TS_LINE_RE = /^(\d{4}年\d{1,2}月\d{1,2}日)\s+(\d{1,2}:\d{2})$/;
const LINE_RE = /^(?<name>.+?)\s+(?<date>\d{4}年\d{1,2}月\d{1,2}日)\s+(?<time>\d{1,2}:\d{2})(?:\s+(?<content>.*))?$/;

// 结构占位符（非文本消息类型）；emoji 如 [愉快]/[坏笑]/[捂脸] 不属于此列，保留为文本
function classifyContent(content) {
  const text = String(content || '');
  const m = text.match(new RegExp('^\\[(' + STRUCTURAL_TYPES.join('|') + ')\\]'));
  if (m) return { type: m[1], content: '' };
  return { type: 'text', content: text };
}

function normalizeTs(date, time) {
  return date.replace('年', '-').replace('月', '-').replace('日', '') + ' ' + time;
}

// 把一块（[昵称, 时间, 内容...]）转成消息对象；不合法返回 null
function toMsg(block) {
  if (block.length < 3) return null;
  const name = block[0].trim();
  const tsLine = block[1].trim();
  const m = tsLine.match(TS_LINE_RE);
  if (!m) return null;
  const ts = normalizeTs(m[1], m[2]);
  const content = block.slice(2).map((x) => x.trim()).join(' ');
  const cls = classifyContent(content);
  return { name, ts, type: cls.type, content: cls.content };
}

// 块格式（微信实际输出）：昵称 / 时间 / 内容 各占一行，消息之间空行分隔
function parseBlockFormat(text) {
  const out = [];
  let block = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const ln = raw.trimEnd();
    if (ln.trim() === '') {
      if (block.length >= 3) {
        const m = toMsg(block);
        if (m) out.push(m);
      }
      block = [];
    } else {
      block.push(ln);
    }
  }
  if (block.length >= 3) {
    const m = toMsg(block);
    if (m) out.push(m);
  }
  return out;
}

// 单行格式：昵称 日期 时间 内容
function parseLineFormat(text) {
  const out = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const ln = raw.trimEnd();
    if (!ln) continue;
    const m = ln.match(LINE_RE);
    if (!m) continue;
    const content = (m.groups.content || '').trim();
    const cls = classifyContent(content);
    out.push({ name: m.groups.name.trim(), ts: normalizeTs(m.groups.date, m.groups.time), type: cls.type, content: cls.content });
  }
  return out;
}

function parseChatText(text) {
  const blocks = parseBlockFormat(text);
  if (blocks.length >= 2) return blocks;
  return parseLineFormat(text);
}

// 一次复制中，非自己昵称只有 1 个 -> 私聊归属；>=2 个 -> 群聊（无归属，留待群聊模型）
function getBatchContact(msgs, selfNicknames = []) {
  const names = [...new Set(msgs.map((m) => String(m.name || '')))];
  const nonSelf = names.filter((n) => !selfNicknames.includes(n));
  return nonSelf.length === 1 ? nonSelf[0] : '';
}

module.exports = { classifyContent, parseBlockFormat, parseLineFormat, parseChatText, getBatchContact, STRUCTURAL_TYPES };
