// 小鹈鹕 Agent 事件工具
// 统一负责：事件 seq 归一化、超长工具结果裁剪、增量事件保留策略、任务摘要。
'use strict';

const MAX_EVENTS = 3000;
const MAX_TOOL_RESULT_LINES = 50;
const MAX_TOOL_RESULT_CHARS = 8000;
const MAX_TOOL_ARGS_CHARS = 4000;
const MAX_REASONING_CHARS = 12000;
const MAX_HISTORY_EVENTS = 300;
const HISTORY_EVENT_TYPES = new Set([
  'assistant/chunk',
  'assistant/message',
  'tool/call',
  'tool/result',
  'todo/write',
  'approval/asked',
  'approval/decided',
  'plan/mode'
]);

function blockText(block) {
  if (!block || typeof block !== 'object') return '';
  if (block.type === 'text' && typeof block.text === 'string') return block.text;
  if (block.content && Array.isArray(block.content)) {
    return block.content
      .filter((x) => x && x.type === 'text' && typeof x.text === 'string')
      .map((x) => x.text)
      .join('');
  }
  return '';
}

// 从 DSH 工具结果的 content 块里提取可展示文本
function extractToolResultText(content) {
  if (!Array.isArray(content)) return '';
  return content.map(blockText).filter((s) => s).join('\n');
}

function truncateText(text, maxLines, maxChars) {
  const originalLines = text.split('\n');
  const originalChars = text.length;
  let truncated = false;
  let previewLines = originalLines;
  if (originalLines.length > maxLines) {
    previewLines = originalLines.slice(0, maxLines);
    truncated = true;
  }
  let preview = previewLines.join('\n');
  if (preview.length > maxChars) {
    preview = preview.slice(0, maxChars);
    truncated = true;
  }
  if (truncated) {
    preview += `\n\n… 内容过长，已截断。原始 ${originalLines.length} 行 / ${originalChars} 字符，未写入聊天记录；如需完整内容请直接读取对应本地文件。`;
  }
  return { preview, truncated, fullLines: originalLines.length, fullChars: originalChars };
}

function sanitizeToolResult(ev) {
  const d = ev.data || {};
  const msg = d.message || {};
  const content = Array.isArray(msg.content) ? msg.content : [];
  const text = extractToolResultText(content);
  const isError = content.some((b) => b && b.isError) || Boolean(d.error);
  const { preview, truncated, fullLines, fullChars } = truncateText(text, MAX_TOOL_RESULT_LINES, MAX_TOOL_RESULT_CHARS);
  if (!truncated) {
    return { ...ev, data: { ...d, isError } };
  }
  return {
    ...ev,
    data: {
      ...d,
      isError,
      truncated: true,
      fullLines,
      fullChars,
      message: { ...msg, content: [{ type: 'text', text: preview }] }
    }
  };
}

function sanitizeToolCall(ev) {
  const d = ev.data || {};
  let args = d.arguments;
  if (typeof args !== 'string') {
    try { args = JSON.stringify(args); } catch { args = String(args || ''); }
  }
  if (args === undefined || args === null) {
    const raw = d.args !== undefined ? d.args : '';
    try { args = typeof raw === 'string' ? raw : JSON.stringify(raw); } catch { args = String(raw || ''); }
  }
  if (args.length > MAX_TOOL_ARGS_CHARS) {
    args = args.slice(0, MAX_TOOL_ARGS_CHARS) + `\n\n… 工具参数过长，已截断（原始 ${args.length} 字符）。`;
  }
  return { ...ev, data: { ...d, arguments: args } };
}

function sanitizeEvent(ev) {
  if (!ev || typeof ev !== 'object') return ev;
  switch (ev.type) {
    case 'tool/result':
      return sanitizeToolResult(ev);
    case 'tool/call':
      return sanitizeToolCall(ev);
    default:
      return ev;
  }
}

function isCoalescable(a, b) {
  if (!a || !b || a.type !== 'assistant/chunk' || b.type !== 'assistant/chunk') return false;
  const ca = a.data && a.data.chunk;
  const cb = b.data && b.data.chunk;
  if (!ca || !cb) return false;
  return ca.index === cb.index
    && (ca.type === 'text-delta' && cb.type === 'text-delta'
      || ca.type === 'reasoning-delta' && cb.type === 'reasoning-delta')
    && typeof ca.text === 'string'
    && typeof cb.text === 'string';
}

// 追加一个事件到任务事件数组；返回新数组长度。
// 同时做：seq 归一化、超长裁剪、连续 delta 合并、总量上限。
function appendEvent(list, rawEvent) {
  const last = list[list.length - 1];
  const fallbackSeq = last && typeof last.seq === 'number' ? last.seq + 1 : list.length + 1;
  const seq = typeof rawEvent.seq === 'number' ? rawEvent.seq : fallbackSeq;
  const ev = sanitizeEvent({ ...rawEvent, seq });
  if (isCoalescable(last, ev)) {
    last.data.chunk.text += ev.data.chunk.text;
    last.seq = seq;
    return list;
  }
  list.push(ev);
  if (list.length > MAX_EVENTS) {
    list.splice(0, list.length - MAX_EVENTS);
  }
  return list;
}

function lastSeq(events) {
  let max = 0;
  for (const ev of events || []) {
    if (typeof ev.seq === 'number' && ev.seq > max) max = ev.seq;
  }
  return max;
}

function summarizeTask(t) {
  const events = t.events || [];
  const toolNames = [];
  const seen = new Set();
  let tools = 0;
  let truncatedResults = 0;
  for (const ev of events) {
    if (ev.type === 'tool/call') {
      tools++;
      const name = (ev.data && (ev.data.name || ev.data.tool)) || 'tool';
      if (!seen.has(name)) {
        seen.add(name);
        toolNames.push(name);
      }
    }
    if (ev.type === 'tool/result' && ev.data && ev.data.truncated) truncatedResults++;
  }
  const durationMs = t.startedAt && t.finishedAt
    ? Math.max(0, Date.parse(t.finishedAt) - Date.parse(t.startedAt))
    : null;
  return {
    status: t.status || 'unknown',
    eventCount: events.length,
    tools,
    toolNames,
    truncatedResults,
    durationMs
  };
}

function sanitizeEventList(events) {
  return (events || []).map((ev) => sanitizeEvent(ev));
}

function sanitizeHistoryEvent(ev) {
  const clean = sanitizeEvent(ev);
  if (!clean || !clean.data) return clean;
  if (clean.type === 'assistant/chunk') {
    const chunk = clean.data.chunk || {};
    if (chunk.type !== 'reasoning-delta') return null;
    const text = String(chunk.text || '');
    return {
      ...clean,
      data: { ...clean.data, chunk: { ...chunk, text: text.slice(0, MAX_REASONING_CHARS) } }
    };
  }
  if (clean.type === 'assistant/message') {
    const message = clean.data.message || {};
    const content = Array.isArray(message.content)
      ? message.content.filter((block) => block && (block.type === 'reasoning' || block.type === 'tool-call')).map((block) => {
        if (block.type !== 'reasoning') return block;
        return { ...block, text: String(block.text || '').slice(0, MAX_REASONING_CHARS) };
      })
      : [];
    if (!content.length) return null;
    return { ...clean, data: { ...clean.data, message: { ...message, content } } };
  }
  return clean;
}

function historyEventList(events) {
  return (events || [])
    .filter((ev) => ev && HISTORY_EVENT_TYPES.has(ev.type))
    .map(sanitizeHistoryEvent)
    .filter(Boolean)
    .slice(-MAX_HISTORY_EVENTS);
}

module.exports = { appendEvent, lastSeq, summarizeTask, sanitizeEventList, historyEventList, MAX_EVENTS };
