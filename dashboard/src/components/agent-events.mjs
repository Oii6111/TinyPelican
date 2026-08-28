import { el, fmtTime, renderRichText } from '../ui.mjs';

// 把 DSH session/event 渲染成一条可视卡片，供 Agent 任务页和对话页共用。
export function renderEvent(ev) {
  const time = ev.time || ev.receivedAt || '';
  const meta = el('div', { class: 'dsh-event-meta', text: fmtTime(time) + ' · ' + (ev.type || '') });
  let body;

  switch (ev.type) {
    case 'turn/start':
      body = el('div', { class: 'dsh-event-body', text: '开始一轮 Agent 回合' });
      break;
    case 'turn/end':
      body = el('div', { class: 'dsh-event-body', text: '结束 Agent 回合：' + ((ev.data && ev.data.reason && ev.data.reason.kind) || '') });
      break;
    case 'step/start':
      body = el('div', { class: 'dsh-event-body', text: '进入新的 Agent 步骤' });
      break;
    case 'step/end':
      body = el('div', { class: 'dsh-event-body', text: 'Agent 步骤完成' });
      break;
    case 'assistant/chunk': {
      const chunk = (ev.data && ev.data.chunk) || {};
      const kind = chunk.type === 'reasoning-delta' ? '🤔 思考' : chunk.type === 'tool-call-delta' ? '🔧 工具参数' : '💬 输出';
      body = el('div', { class: 'dsh-event-body dsh-think', text: (kind + ' ' + (chunk.text || chunk.argumentsDelta || '')) || '(空白片段)' });
      break;
    }
    case 'assistant/message': {
      const blocks = (ev.data && ev.data.message && ev.data.message.content) || [];
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('');
      const reasoning = blocks.filter((b) => b.type === 'reasoning').map((b) => b.text).join('');
      body = el('div', { class: 'dsh-event-body' },
        reasoning ? el('div', { class: 'dsh-think', text: '🤔 ' + reasoning }) : null,
        el('div', { text: text || '(空消息)' })
      );
      break;
    }
    case 'tool/call': {
      const name = (ev.data && ev.data.name) || (ev.data && ev.data.tool) || 'tool';
      const args = (ev.data && ev.data.arguments) || (ev.data && ev.data.args) || '';
      body = el('div', { class: 'dsh-event-body dsh-tool' },
        el('div', { class: 'dsh-tool-name', text: '🔧 ' + name }),
        el('pre', { text: typeof args === 'string' ? args : JSON.stringify(args, null, 2) })
      );
      break;
    }
    case 'tool/result': {
      const msg = (ev.data && ev.data.message) || {};
      const blocks = (msg.content) || [];
      const out = blocks
        .flatMap((b) => b.type === 'text' ? [b.text] : b.content ? b.content.filter((x) => x.type === 'text').map((x) => x.text) : [])
        .join('\n');
      const isError = blocks.some((b) => b.isError) || (ev.data && ev.data.error);
      body = el('div', { class: 'dsh-event-body dsh-tool-result' },
        el('div', { class: 'dsh-tool-name', text: '📄 工具结果' + (isError ? '（失败）' : '') }),
        el('pre', { text: out || JSON.stringify(ev.data && ev.data.meta || ev.data && ev.data.error || {}, null, 2) })
      );
      break;
    }
    case 'user/message': {
      const blocks = (ev.data && ev.data.message && ev.data.message.content) || [];
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('');
      body = el('div', { class: 'dsh-event-body', text: '👤 ' + (text || '(用户消息)') });
      break;
    }
    case 'approval/asked':
      body = el('div', { class: 'dsh-event-body', text: '🔐 请求用户审批：' + JSON.stringify(ev.data || {}) });
      break;
    case 'approval/decided':
      body = el('div', { class: 'dsh-event-body', text: '🔐 审批结果：' + JSON.stringify(ev.data || {}) });
      break;
    case 'todo/write': {
      const todos = (ev.data && ev.data.todos) || [];
      body = el('div', { class: 'dsh-event-body' },
        el('div', { text: '📋 待办更新' }),
        el('pre', { text: todos.map((t) => `[${t.status}] ${t.content}`).join('\n') || '(空)' })
      );
      break;
    }
    case 'plan/mode':
      body = el('div', { class: 'dsh-event-body', text: '📐 计划模式：' + JSON.stringify(ev.data || {}) });
      break;
    default:
      body = el('div', { class: 'dsh-event-body', text: JSON.stringify(ev.data || {}) });
  }

  return el('div', { class: 'dsh-event' }, meta, body);
}

export function renderEventList(box, events, options = {}) {
  box.innerHTML = '';
  if (!events.length) {
    box.append(el('div', { class: 'dsh-empty', text: '等待 DSH Agent 开始…' }));
    return;
  }
  for (const ev of events) {
    // 对话页里文本增量由单独的流式气泡展示，活动卡片里不再重复输出文本片段
    if (options.skipTextChunks && ev.type === 'assistant/chunk' && ev.data && ev.data.chunk && (ev.data.chunk.type === 'text' || ev.data.chunk.type === 'text-delta')) continue;
    box.append(renderEvent(ev));
  }
  box.scrollTop = box.scrollHeight;
}

// 从事件流里累计出一段“最终文本”的实时增量（用于对话页的流式回复气泡）。
export function collectStreamText(events) {
  let text = '';
  let sawDelta = false;
  for (const ev of events || []) {
    const chunk = ev.data && ev.data.chunk;
    if (chunk && (chunk.type === 'text-delta' || chunk.type === 'text') && chunk.text) {
      text += chunk.text;
      sawDelta = true;
    }
  }
  // 没有流式 delta 时，回退到完整的消息/块文本，避免漏掉或重复
  if (!sawDelta) {
    for (const ev of events || []) {
      if (ev.type === 'assistant/message' && ev.data && ev.data.message && Array.isArray(ev.data.message.content)) {
        text += ev.data.message.content
          .filter((b) => b.type === 'text' && b.text)
          .map((b) => b.text)
          .join('');
      }
      const chunk = ev.data && ev.data.chunk;
      if (ev.type === 'assistant/chunk' && chunk && chunk.type === 'block-end' && chunk.block && chunk.block.type === 'text' && chunk.block.text) {
        text += chunk.block.text;
      }
    }
  }
  return text.trim();
}

// 把原始 DSH 事件流整理成适合对话页展示的精简卡片列表。
// 参考 DSH WebUI 的做法：不展示每个增量 token，也不展示 lifecycle 噪音；
// 只聚合“思考过程”、“工具调用/结果”、待办/审批等关键节点。
export function buildChatEventItems(events) {
  const items = [];
  let reasoning = '';
  let reasoningFromChunks = false;

  for (const ev of events || []) {
    const d = ev.data || {};
    switch (ev.type) {
      case 'assistant/chunk': {
        const chunk = d.chunk || {};
        if (chunk.type === 'reasoning-delta' && chunk.text) {
          reasoning += chunk.text;
          reasoningFromChunks = true;
        }
        // text delta 不放进活动卡片，由流式回复气泡展示
        break;
      }
      case 'assistant/message': {
        const blocks = (d.message && d.message.content) || [];
        const r = blocks.filter((b) => b.type === 'reasoning' && b.text).map((b) => b.text).join('');
        if (r && !reasoningFromChunks) reasoning += r;
        // text 由最终回复气泡展示
        break;
      }
      case 'tool/call': {
        const name = d.name || d.tool || 'tool';
        const args = d.arguments || d.args || '';
        items.push({ kind: 'tool', name, args: typeof args === 'string' ? args : JSON.stringify(args, null, 2) });
        break;
      }
      case 'tool/result': {
        const msg = d.message || {};
        const blocks = msg.content || [];
        const out = blocks
          .flatMap((b) => b.type === 'text' ? [b.text] : b.content ? b.content.filter((x) => x.type === 'text').map((x) => x.text) : [])
          .join('\n');
        const isError = blocks.some((b) => b.isError) || d.error;
        items.push({ kind: 'tool-result', isError, out: out || JSON.stringify(d.meta || d.error || {}, null, 2) });
        break;
      }
      case 'todo/write': {
        const todos = d.todos || [];
        items.push({ kind: 'todo', todos });
        break;
      }
      case 'approval/asked':
        items.push({ kind: 'approval', text: '请求用户审批：' + JSON.stringify(d) });
        break;
      case 'approval/decided':
        items.push({ kind: 'approval', text: '审批结果：' + JSON.stringify(d) });
        break;
      case 'plan/mode':
        items.push({ kind: 'plan', text: JSON.stringify(d) });
        break;
      default:
        // turn/start、step/start、user/message、assistant/text chunk 等噪音直接忽略
        break;
    }
  }

  if (reasoning.trim()) {
    items.unshift({ kind: 'reasoning', text: reasoning.trim() });
  }
  return items;
}

export function renderChatEventList(box, events, options = {}) {
  const items = buildChatEventItems(events);
  const wasOpen = box.querySelector('.dsh-think-details') ? box.querySelector('.dsh-think-details').open : false;
  box.innerHTML = '';
  if (!items.length) {
    box.append(el('div', { class: 'dsh-empty', text: options.emptyText || '等待 DSH Agent 开始…' }));
    return;
  }
  for (const item of items) {
    if (item.kind === 'reasoning') {
      const d = el('details', { class: 'dsh-think-details' },
        el('summary', { text: '🤔 思考过程' }),
        el('pre', { text: item.text })
      );
      if (wasOpen) d.open = true;
      box.append(d);
    } else if (item.kind === 'tool') {
      box.append(el('div', { class: 'dsh-event dsh-tool' },
        el('div', { class: 'dsh-tool-name', text: '🔧 ' + item.name }),
        el('pre', { text: item.args })
      ));
    } else if (item.kind === 'tool-result') {
      box.append(el('div', { class: 'dsh-event dsh-tool-result' },
        el('div', { class: 'dsh-tool-name', text: '📄 工具结果' + (item.isError ? '（失败）' : '') }),
        el('pre', { text: item.out })
      ));
    } else if (item.kind === 'todo') {
      box.append(el('div', { class: 'dsh-event' },
        el('div', { class: 'dsh-tool-name', text: '📋 待办更新' }),
        el('pre', { text: item.todos.map((t) => `[${t.status}] ${t.content}`).join('\n') || '(空)' })
      ));
    } else {
      box.append(el('div', { class: 'dsh-event' }, el('div', { class: 'dsh-event-body', text: item.text || item.kind })));
    }
  }
  box.scrollTop = box.scrollHeight;
}

// 从事件流里提取“思考 + 工具 + 最终文本”，用于附着在正式回复气泡上。
export function extractAnswerParts(events) {
  const items = buildChatEventItems(events);
  const reasoning = (items.find((i) => i.kind === 'reasoning') || {}).text || '';
  const tools = items.filter((i) => i.kind === 'tool' || i.kind === 'tool-result');
  return { reasoning, tools, text: collectStreamText(events) };
}

export function createAnswerCard({ reasoning = '', tools = [], text = '', running = false } = {}) {
  const card = el('div', { class: 'dsh-message-group dsh-answer-card' });
  const processBody = el('div', { class: 'dsh-process-body' });
  const process = el('details', { class: 'dsh-process-collapse' },
    el('summary', {},
      el('span', { text: '⚙️ 执行过程' }),
      el('span', { class: 'dsh-process-badge', text: tools.length ? `${tools.length} 项` : '' })
    ),
    processBody
  );
  if (reasoning) {
    processBody.append(el('details', { class: 'dsh-reasoning-collapse' },
      el('summary', { text: '🤔 思考过程' }),
      el('pre', { text: reasoning })
    ));
  }
  for (const tool of tools) {
    processBody.append(el('details', { class: 'dsh-tool-details' },
      el('summary', {}, el('span', { class: 'dsh-answer-tool-name', text: tool.kind === 'tool' ? '🔧 ' + tool.name : '📄 工具结果' })),
      el('pre', { class: 'dsh-tool-args', text: tool.kind === 'tool' ? tool.args : tool.out })
    ));
  }
  const answer = el('div', { class: 'bubble bot dsh-answer-text' });
  renderRichText(answer, text || (running ? '…' : '(空回复)'));
  if (reasoning || tools.length) card.append(process);
  card.append(answer);
  return card;
}

export function updateAnswerCard(card, { text = '', running = false } = {}) {
  const textEl = card.querySelector('.dsh-answer-text');
  if (textEl) {
    if (running) textEl.textContent = text || '…';
    else renderRichText(textEl, text || '(空回复)');
  }
}

// ── 增量流式回答卡片（推荐，配合 afterSeq 增量接口使用）──────────────────
function answerState(card) {
  if (!card.__answerState) {
    card.__answerState = {
      reasoning: '',
      text: '',
      lastSeq: 0,
      tools: new Map(),
      lastToolKey: null,
      processItems: new Map(),
      toolCount: 0
    };
  }
  return card.__answerState;
}

function extractToolText(content) {
  return (content || [])
    .flatMap((b) => {
      if (!b) return [];
      if (b.type === 'text') return [b.text || ''];
      if (Array.isArray(b.content)) return b.content.filter((x) => x && x.type === 'text').map((x) => x.text || '');
      return [];
    })
    .join('\n');
}

export function createStreamAnswerCard({ running = true, text = '' } = {}) {
  const card = el('div', { class: 'dsh-message-group dsh-answer-card' });
  answerState(card);
  const process = el('details', { class: 'dsh-process-collapse' },
    el('summary', {},
      el('span', { text: '⚙️ 执行过程' }),
      el('span', { class: 'dsh-process-badge', text: '' }),
      el('span', { class: 'dsh-answer-status', text: running ? '处理中…' : '' })
    ),
    el('div', { class: 'dsh-process-body' })
  );
  process.open = running;
  card.append(process);
  card.append(el('div', { class: 'bubble bot dsh-answer-text', text: text || '…' }));
  return card;
}

export function appendAnswerEvents(card, events = [], { running = true, done = false, finalText = null, error = '' } = {}) {
  const st = answerState(card);
  const statusEl = card.querySelector('.dsh-answer-status');
  const details = card.querySelector('.dsh-process-collapse');
  const body = details.querySelector('.dsh-process-body');
  const textEl = card.querySelector('.dsh-answer-text');
  const badge = details.querySelector('.dsh-process-badge');

  const setReasoning = (text) => {
    let rd = body.querySelector('.dsh-reasoning-collapse');
    if (!rd) {
      rd = el('details', { class: 'dsh-reasoning-collapse' },
        el('summary', { text: '🤔 思考过程' }),
        el('pre', { text: '' })
      );
      body.prepend(rd);
    }
    rd.querySelector('pre').textContent = text.trim();
  };

  const ensureTool = (key, { name = 'tool', args = '' }) => {
    key = String(key);
    let item = st.tools.get(key);
    if (!item) {
      item = el('details', { class: 'dsh-tool-details' },
        el('summary', {},
          el('span', { class: 'dsh-answer-tool-name', text: '🔧 ' + name }),
          el('span', { class: 'dsh-tool-state', text: '…' })
        ),
        el('pre', { class: 'dsh-tool-args', text: args || '' })
      );
      st.tools.set(key, item);
      body.append(item);
      st.toolCount++;
    } else {
      const summary = item.querySelector('.dsh-answer-tool-name');
      if (name && summary) summary.textContent = '🔧 ' + name;
      const argsEl = item.querySelector('.dsh-tool-args');
      if (argsEl) argsEl.textContent = args || argsEl.textContent;
    }
    st.lastToolKey = key;
  };

  const setToolResult = (key, out, isError = false, data = {}) => {
    key = String(key || st.lastToolKey || '');
    let item = st.tools.get(key);
    if (!item && st.lastToolKey) item = st.tools.get(String(st.lastToolKey));
    if (!item) {
      item = el('details', { class: 'dsh-tool-details' },
        el('summary', {}, el('span', { class: 'dsh-answer-tool-name', text: '📄 工具结果' })),
        el('pre', { class: 'dsh-tool-args', text: '' })
      );
      st.tools.set(key, item);
      body.append(item);
      st.toolCount++;
    }
    const old = item.querySelector('.dsh-tool-result');
    if (old) old.remove();
    const head = el('div', { class: 'dsh-tool-result-head' },
      el('span', { text: '📄 工具结果' + (isError ? '（失败）' : '') }),
      data.truncated
        ? el('span', { class: 'dsh-tool-truncated', text: `已截断（${data.fullLines} 行 / ${data.fullChars} 字符）` })
        : null
    );
    item.append(el('div', { class: 'dsh-tool-result' + (isError ? ' dsh-tool-error' : '') }, head, el('pre', { text: out || '(无输出)' })));
    const state = item.querySelector('.dsh-tool-state');
    if (state) state.textContent = '✓';
  };

  const addProcessItem = (key, label, content) => {
    key = String(key);
    if (st.processItems.has(key)) return;
    const row = el('div', { class: 'dsh-process-item' },
      el('div', { class: 'dsh-process-item-label', text: label }),
      el('pre', { text: content || '' })
    );
    st.processItems.set(key, row);
    body.append(row);
  };

  for (const ev of events || []) {
    const seq = typeof ev.seq === 'number' ? ev.seq : st.lastSeq + 1;
    if (seq > st.lastSeq) st.lastSeq = seq;
    const d = ev.data || {};
    const chunk = d.chunk || {};

    switch (ev.type) {
      case 'assistant/chunk': {
        if ((chunk.type === 'text-delta' || chunk.type === 'text') && chunk.text) {
          st.text += chunk.text;
          textEl.textContent = st.text || '…';
        } else if (chunk.type === 'reasoning-delta' && chunk.text) {
          st.reasoning += chunk.text;
          setReasoning(st.reasoning);
        } else if (chunk.type === 'block-end' && chunk.block) {
          if (chunk.block.type === 'text' && typeof chunk.block.text === 'string') {
            st.text = chunk.block.text;
            textEl.textContent = st.text;
          } else if (chunk.block.type === 'reasoning' && typeof chunk.block.text === 'string') {
            st.reasoning = chunk.block.text;
            setReasoning(st.reasoning);
          }
        }
        break;
      }
      case 'assistant/message': {
        const blocks = (d.message && d.message.content) || [];
        const text = blocks.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('');
        const reasoning = blocks.filter((b) => b && b.type === 'reasoning' && typeof b.text === 'string').map((b) => b.text).join('');
        if (text) { st.text = text; textEl.textContent = st.text; }
        if (reasoning) { st.reasoning = reasoning; setReasoning(st.reasoning); }
        for (const b of blocks.filter((x) => x && x.type === 'tool-call')) {
          ensureTool(b.id || seq, { name: b.name || 'tool', args: b.arguments || '' });
        }
        break;
      }
      case 'tool/call': {
        const name = d.name || d.tool || 'tool';
        const args = typeof d.arguments === 'string' ? d.arguments : JSON.stringify(d.arguments ?? d.args ?? '');
        ensureTool(d.id || seq, { name, args });
        break;
      }
      case 'tool/result': {
        const msg = d.message || {};
        const blocks = msg.content || [];
        const out = extractToolText(blocks);
        const isError = d.isError || blocks.some((b) => b && b.isError) || Boolean(d.error);
        setToolResult(d.id || seq, out, isError, d);
        break;
      }
      case 'todo/write':
        addProcessItem(seq, '📋 待办更新', (d.todos || []).map((t) => `[${t.status}] ${t.content}`).join('\n') || '(空)');
        break;
      case 'approval/asked':
        addProcessItem(seq, '🔐 请求审批', JSON.stringify(d));
        break;
      case 'approval/decided':
        addProcessItem(seq, '🔐 审批结果', JSON.stringify(d));
        break;
      case 'plan/mode':
        addProcessItem(seq, '📐 计划模式', JSON.stringify(d));
        break;
      default:
        break;
    }
  }

  if (done) {
    if (finalText !== null && finalText !== undefined) st.text = finalText;
    else if (error) st.text = error;
    renderRichText(textEl, st.text || '(空回复)');
    if (statusEl) statusEl.textContent = error ? '失败' : '已完成';
    details.open = false;
    const stateEl = details.querySelector('.dsh-tool-state');
    if (stateEl) stateEl.textContent = '✓';
  } else if (running) {
    if (statusEl) statusEl.textContent = '处理中…';
    textEl.textContent = st.text || '…';
  }

  badge.textContent = st.toolCount ? `${st.toolCount} 个工具` : '';
}

export function createSummaryAnswerCard({ text = '', summary = {} } = {}) {
  const card = el('div', { class: 'dsh-message-group dsh-answer-card' });
  const lines = [];
  if (summary.tools) lines.push(`调用工具 ${summary.tools} 个`);
  if (summary.toolNames && summary.toolNames.length) lines.push('工具：' + summary.toolNames.join('、'));
  if (typeof summary.durationMs === 'number') lines.push('耗时 ' + (summary.durationMs / 1000).toFixed(1) + ' 秒');
  if (summary.truncatedResults) lines.push(`${summary.truncatedResults} 个结果过长已截断`);
  card.append(el('details', { class: 'dsh-process-collapse' },
    el('summary', {}, el('span', { text: '⚙️ 执行过程' }), el('span', { class: 'dsh-process-badge', text: summary.tools ? `${summary.tools} 个工具` : '' })),
    el('div', { class: 'dsh-process-body' },
      el('div', { class: 'dsh-answer-summary', text: lines.join('\n') || '无过程记录' })
    )
  ));
  const answer = el('div', { class: 'bubble bot dsh-answer-text' });
  renderRichText(answer, text || '(空回复)');
  card.append(answer);
  return card;
}

export function createHistoryAnswerCard({ text = '', events = [] } = {}) {
  const card = createStreamAnswerCard({ running: false, text: '' });
  appendAnswerEvents(card, events, { running: false, done: true, finalText: text });
  return card;
}
