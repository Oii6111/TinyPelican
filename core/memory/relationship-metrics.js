'use strict';

// 联系人的互动度量（描述性统计）。
//
// 只回答「消息是怎么流动的」：谁发起会话、句长、表情/图片、回复间隔分位、
// 消息量是否对称。它不回答「对方是不是喜欢我」「关系到什么阶段」——
// 这些结论需要多次互动证据，并且只能是待观察假设，不能作为产品结论输出。
//
// 8 小时会话切分：同一联系人连续消息间隔超过 8 小时就算新的一段会话，
// 避免把隔天回复算成同一次对话里的延迟。

const DEFAULT_SESSION_GAP_MS = 8 * 60 * 60 * 1000;

function asNames(value) {
  const values = Array.isArray(value) ? value : [value];
  return new Set(values.map(item => String(item || '').normalize('NFKC').trim()).filter(Boolean));
}

function messageTime(message) {
  const value = message?.ts ?? message?.timestamp ?? message?.date;
  const parsed = value instanceof Date ? value.getTime() : Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : NaN;
}

function messageText(message) {
  return String(message?.content ?? message?.text ?? message?.body ?? '').trim();
}

function emojiCount(text) {
  return [...String(text || '').matchAll(/\p{Extended_Pictographic}/gu)].length;
}

function roleOf(message, ownerNames, contactNames) {
  if (message?.isOwner === null) return '';
  if (message?.isOwner === true) return 'owner';
  if (message?.isOwner === false && contactNames.size) return 'contact';
  const sender = String(message?.sender ?? message?.senderName ?? message?.name ?? '').normalize('NFKC').trim();
  if (ownerNames.has(sender)) return 'owner';
  if (contactNames.has(sender)) return 'contact';
  return '';
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const position = (ordered.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return Math.round(ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower));
}

function latencyStats(values) {
  return {
    sampleCount: values.length,
    meanMs: values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : null,
    medianMs: percentile(values, 0.5),
    p90Ms: percentile(values, 0.9),
    minMs: values.length ? Math.min(...values) : null,
    maxMs: values.length ? Math.max(...values) : null
  };
}

function participantStats() {
  return {
    messageCount: 0,
    readableChars: 0,
    readableLines: 0,
    emojiCount: 0,
    stickerCount: 0,
    imageCount: 0,
    otherAttachmentCount: 0,
    sessionInitiations: 0,
    turnCount: 0,
    averageTurnChars: null
  };
}

function computeRelationshipMetrics(rows, options = {}) {
  const ownerNames = asNames(options.ownerNames ?? options.ownerName);
  const contactNames = asNames(options.contactNames ?? options.contactName);
  const sessionGapMs = Number.isFinite(Number(options.sessionGapMs)) && Number(options.sessionGapMs) > 0
    ? Number(options.sessionGapMs) : DEFAULT_SESSION_GAP_MS;
  const maxReplyGapMs = Number.isFinite(Number(options.maxReplyGapMs)) && Number(options.maxReplyGapMs) > 0
    ? Number(options.maxReplyGapMs) : sessionGapMs;
  const inputRows = Array.isArray(rows) ? rows : [];
  const excluded = { unknownSender: 0, invalidTimestamp: 0, emptyContent: 0 };
  const validRows = [];
  inputRows.forEach((message, inputIndex) => {
    const role = roleOf(message, ownerNames, contactNames);
    const timestamp = messageTime(message);
    if (!role) { excluded.unknownSender += 1; return; }
    if (!Number.isFinite(timestamp)) { excluded.invalidTimestamp += 1; return; }
    const content = messageText(message);
    const type = String(message?.type || 'text').toLowerCase();
    if (!content && type === 'text') excluded.emptyContent += 1;
    validRows.push({ message, role, timestamp, content, type, inputIndex });
  });
  validRows.sort((left, right) => left.timestamp - right.timestamp || left.inputIndex - right.inputIndex);
  const participants = { owner: participantStats(), contact: participantStats() };
  const replyLatencies = { owner: [], contact: [] };
  const sessions = [];
  let currentSession = null;
  let previous = null;
  for (const entry of validRows) {
    const startsSession = !currentSession || entry.timestamp - previous.timestamp > sessionGapMs;
    if (startsSession) {
      currentSession = { index: sessions.length, startedAt: entry.timestamp, endedAt: entry.timestamp, messageCount: 0, roles: new Set(), initiatedBy: entry.role };
      sessions.push(currentSession);
      participants[entry.role].sessionInitiations += 1;
    }
    currentSession.endedAt = entry.timestamp;
    currentSession.messageCount += 1;
    currentSession.roles.add(entry.role);
    const stats = participants[entry.role];
    const readableContent = entry.type === 'text' ? entry.content : '';
    stats.messageCount += 1;
    stats.readableChars += [...readableContent].length;
    stats.readableLines += readableContent ? readableContent.split(/\r?\n/).length : 0;
    stats.emojiCount += emojiCount(readableContent);
    if (entry.type === 'sticker' || entry.type === 'emoji') stats.stickerCount += 1;
    else if (entry.type === 'image' || entry.type === 'photo') stats.imageCount += 1;
    else if (entry.type !== 'text' && entry.type !== 'file') stats.otherAttachmentCount += 1;
    const changedRole = previous && previous.role !== entry.role;
    const responseGap = previous ? entry.timestamp - previous.timestamp : NaN;
    if (changedRole && responseGap >= 0 && responseGap <= maxReplyGapMs) replyLatencies[entry.role].push(responseGap);
    previous = entry;
  }
  const turnChars = { owner: [], contact: [] };
  for (let index = 0; index < validRows.length; index += 1) {
    const entry = validRows[index];
    if (index === 0 || validRows[index - 1].role !== entry.role || entry.timestamp - validRows[index - 1].timestamp > sessionGapMs) {
      participants[entry.role].turnCount += 1;
      let chars = entry.type === 'text' ? [...entry.content].length : 0;
      for (let nextIndex = index + 1; nextIndex < validRows.length; nextIndex += 1) {
        const next = validRows[nextIndex];
        if (next.role !== entry.role || next.timestamp - entry.timestamp > sessionGapMs) break;
        if (next.type === 'text') chars += [...next.content].length;
        if (nextIndex + 1 < validRows.length && validRows[nextIndex + 1].role !== entry.role) break;
      }
      turnChars[entry.role].push(chars);
    }
  }
  for (const role of ['owner', 'contact']) {
    participants[role].averageTurnChars = turnChars[role].length
      ? Math.round(turnChars[role].reduce((sum, value) => sum + value, 0) / turnChars[role].length) : null;
  }
  const sessionCounts = { owner: 0, contact: 0 };
  for (const session of sessions) sessionCounts[session.initiatedBy] += 1;
  const totalMessages = validRows.length;
  const totalSessions = sessions.length;
  const ownerMessages = participants.owner.messageCount;
  const contactMessages = participants.contact.messageCount;
  return {
    version: 1,
    parameters: { sessionGapMs, maxReplyGapMs },
    sample: {
      inputRows: inputRows.length,
      includedRows: validRows.length,
      totalSessions,
      excluded,
      sufficientForInteraction: totalSessions >= 3 && ownerMessages > 0 && contactMessages > 0,
      limitation: '回复间隔来自相邻消息的时间戳，只表示消息间隔，不代表已读或真实等待时间；主动比例和语言指标需要结合样本量解读。'
    },
    participants,
    initiation: {
      ownerCount: sessionCounts.owner,
      contactCount: sessionCounts.contact,
      ownerShare: totalSessions ? sessionCounts.owner / totalSessions : null,
      contactShare: totalSessions ? sessionCounts.contact / totalSessions : null
    },
    messageBalance: {
      ownerToContactCountRatio: contactMessages ? ownerMessages / contactMessages : null,
      ownerToContactReadableCharRatio: participants.contact.readableChars ? participants.owner.readableChars / participants.contact.readableChars : null,
      ownerCount: ownerMessages,
      contactCount: contactMessages,
      totalMessages
    },
    replyLatency: {
      owner: latencyStats(replyLatencies.owner),
      contact: latencyStats(replyLatencies.contact)
    },
    sessions: sessions.map(session => ({ index: session.index, startedAt: new Date(session.startedAt).toISOString(), endedAt: new Date(session.endedAt).toISOString(), messageCount: session.messageCount, initiatedBy: session.initiatedBy, twoSided: session.roles.size === 2 })),
    interpretationGuardrails: [
      '指标只描述互动模式，不判定对方的好感、态度或关系地位。',
      '任何关于关系性质的判断都必须由多次互动证据支持，并明确标注为待观察假设，不能作为结论输出。',
      '图片、表情包和短回复的意义依赖上下文，不把单一词语或性格测试结果当作诊断。'
    ]
  };
}

module.exports = { computeRelationshipMetrics, latencyStats, percentile, DEFAULT_SESSION_GAP_MS };
