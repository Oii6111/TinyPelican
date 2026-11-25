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
// 同时返回 matchedLines（参与匹配的原始行数）：一条块格式消息 = 3 行起，
// 让「最少匹配行数」按行判定，复制单条消息时不会被「不足 2 条」拦掉。
function parseBlockDetail(text) {
  const messages = [];
  let matchedLines = 0;
  let block = [];
  const flush = () => {
    // 微信在跨天处会多插一行「日期 时间」分隔行；选中范围跨天时它会贴在第一条消息前面，
    // 先把它去掉再解析，否则这条消息会整条丢掉。
    const message = block.length >= 4 && TS_LINE_RE.test(block[0].trim()) ? block.slice(1) : block;
    if (message.length >= 3) {
      const m = toMsg(message);
      if (m) {
        messages.push(m);
        matchedLines += block.length;
      }
    }
    block = [];
  };
  for (const raw of String(text).split(/\r?\n/)) {
    const ln = raw.trimEnd();
    if (ln.trim() === '') flush();
    else block.push(ln);
  }
  flush();
  return { messages, matchedLines };
}

function parseBlockFormat(text) {
  return parseBlockDetail(text).messages;
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

// 解析详情：messages + 本次匹配到的行数。
// 只有 1 个块时不能直接丢掉：单行格式也要先试一遍（避免把「昵称 日期 时间 内容」这种
// 一行一条的格式误判成块格式），两者都没有才认为这条块格式消息就是全部内容。
function parseChatDetail(text) {
  const block = parseBlockDetail(text);
  if (block.messages.length >= 2) return block;
  const lines = parseLineFormat(text);
  if (lines.length) return { messages: lines, matchedLines: lines.length };
  return block;
}

function parseChatText(text) {
  return parseChatDetail(text).messages;
}

// 是否像聊天记录（至少有一行「日期 时间」或「昵称 日期 时间 内容」）。
// 用于避免把没解析出消息的聊天文本误当成语音转写文本回填到语音队列。
function looksLikeChatText(text) {
  return String(text || '').split(/\r?\n/).some((raw) => {
    const ln = raw.trim();
    return !!ln && (TS_LINE_RE.test(ln) || LINE_RE.test(ln));
  });
}

// 一次复制中，非自己昵称只有 1 个 -> 私聊归属；>=2 个 -> 群聊（无归属，留待群聊模型）
function getBatchContact(msgs, selfNicknames = []) {
  const names = [...new Set(msgs.map((m) => String(m.name || '')))];
  const nonSelf = names.filter((n) => !selfNicknames.includes(n));
  return nonSelf.length === 1 ? nonSelf[0] : '';
}

// 群显示名：取识别到的发言人前三个；超过三个补「等 N 人」。
// 只做显示用。群实体的身份走 member.platform_id，换一批人复制回来会按成员重合归并
// （见 chatDb.ensureGroup / findGroupByMembers），不会因为名字不同裂成两个群。
function groupDisplayName(members = [], total = null) {
  const names = (Array.isArray(members) ? members : [])
    .map((n) => String(n || '').trim()).filter(Boolean);
  if (!names.length) return '';
  const head = names.slice(0, 3).join('、');
  const count = Number(total) > names.length ? Number(total) : names.length;
  return names.length > 3 ? `${head} 等 ${count} 人` : head;
}

// 归属判定（剪贴板批次 / 导入都走这里）：返回 { kind, name, displayName, remark, members, source }
//   kind='contact' -> 私聊，name 是对方
//   kind='group'   -> 群聊，name 是群的身份名，members 是本批识别到的发言人
//   kind='unknown' -> 判不出来（自己昵称没配、或只有空白消息）
//
// session 是截屏 + 视觉模型读出来的窗口会话名（可选）：
//   { name, kind: 'contact'|'group'|'unknown', memberCount }
// 它比「数发言人有几个」可靠得多——群里只有一个人说话时，名字数启发式会把群判成私聊，
// 而窗口上显示的就是群名。
//
// 分工：截图读到的是微信里**显示的名字**（设了备注就是备注），所以它进 remark，不改 name。
// name 是稳定标识（联系人的消息原文名 / 群按发言人拼出来的名字），用来去重和关联；
// remark 是给人看的名字。
function resolveBatchTarget(msgs, selfNicknames = [], { session = null } = {}) {
  const list = Array.isArray(msgs) ? msgs : [];
  const names = [...new Set(list.map((m) => String(m.name || '').trim()).filter(Boolean))];
  const self = new Set((Array.isArray(selfNicknames) ? selfNicknames : [])
    .map((n) => String(n || '').trim()).filter(Boolean));
  const others = names.filter((n) => !self.has(n));

  if (session && session.name) {
    const sessionName = String(session.name).trim();
    if (session.kind === 'group') {
      // 群的身份名仍然按发言人拼（用户定的规则）；截图里的真群名放进 remark。
      const identity = others.length ? groupDisplayName(others) : sessionName;
      return {
        kind: 'group', name: identity, displayName: sessionName, remark: sessionName,
        // 群里发言人可能少于成员数，members 仍然只放本批真的说过话的人
        members: others, memberCount: Number(session.memberCount) || 0, source: 'window'
      };
    }
    // 私聊：剪贴板里的发言人是从消息原文里来的，比窗口标题更可靠（标题可能被截断）。
    // 窗口这边用来确认「这不是群」，顺便把显示名（可能是备注）带上。
    const name = others.length === 1 ? others[0] : sessionName;
    return { kind: 'contact', name, displayName: sessionName, remark: sessionName, members: [], source: 'window' };
  }

  if (others.length === 1) return { kind: 'contact', name: others[0], displayName: others[0], members: [], source: 'speakers' };
  if (others.length < 1) return { kind: 'unknown', name: '', displayName: '', members: [], source: 'speakers' };
  const display = groupDisplayName(others);
  return { kind: 'group', name: display, displayName: display, members: others, source: 'speakers' };
}

module.exports = { classifyContent, parseBlockFormat, parseLineFormat, parseChatText, parseChatDetail, looksLikeChatText, getBatchContact, groupDisplayName, resolveBatchTarget, STRUCTURAL_TYPES };
