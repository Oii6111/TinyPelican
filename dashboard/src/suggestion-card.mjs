// 回复建议卡片（Electron 浮窗）：
//  1. 复制聊天后浮窗立刻弹出来放「思考中」，模型返回后再把内容填进去；
//  2. 最多 3 组方案，每组是 1~N 条按顺序发送的连贯消息（快速模式限 4 条以内）；
//  3. 点某组 = 先填入第一条，之后卡片停在该组的「下一条」上，逐条按顺序填入微信；
//     这时「换一批」只重写这一组还没发出去的几条（会把已发的带成上下文）；
//  4. 底部一行输入框：写下自己想表达什么，回车/点 ↵ 让模型按你的描述重写；
//  5. 🧠 深度思考 = 打开模型思考过程重来，允许更多条、更长内容（更慢）。
import { api } from './api.mjs';
import { el, empty } from './ui.mjs';

const root = document.getElementById('card');
const CARD_WIDTH = 340;

let currentId = null;
let stateKey = '';
let busy = false;
let hintDraft = '';
let statusText = '';
let statusKind = '';
let inputFocused = false;
let lastReportedHeight = 0;
let lastSuggestion = null;

function bridge() {
  return window.suggestionsBridge || null;
}

function setStatus(text, kind = '') {
  statusText = text || '';
  statusKind = kind;
  const node = root.querySelector('.actions .status');
  if (!node) return;
  node.textContent = statusText;
  node.className = 'status' + (statusKind ? ' ' + statusKind : '');
}

function reportSize() {
  const height = Math.ceil(root.getBoundingClientRect().height);
  if (!height || Math.abs(height - lastReportedHeight) < 2) return;
  lastReportedHeight = height;
  const b = bridge();
  if (b && b.resize) b.resize(CARD_WIDTH, height + 4);
}

function snapshotKey(s, pending) {
  return JSON.stringify({
    id: s && s.id,
    token: s && s.showToken,
    plans: s && s.plans,
    active: s && s.activePlan,
    hint: s && s.hint,
    canPaste: s && s.canPaste,
    pending: pending ? [pending.startedAt, pending.mode, pending.contact] : null
  });
}

async function refresh(force = false) {
  let data;
  try {
    data = await api.replySuggestions.current();
  } catch {
    return;
  }
  const s = data && data.suggestion;
  const pending = data && data.pending;
  if (!s && !pending) {
    if (currentId || lastSuggestion) {
      currentId = null;
      stateKey = '';
      lastSuggestion = null;
      empty(root);
    }
    return;
  }
  const key = snapshotKey(s, pending);
  if (!force && key === stateKey) return;
  stateKey = key;
  currentId = s ? s.id : currentId;
  lastSuggestion = s || lastSuggestion;
  render(lastSuggestion, pending);
}

function messageRow(index, text, className = '') {
  return el('div', { class: 'msg' + (className ? ' ' + className : '') },
    el('span', { class: 'idx', text: String(index) }),
    el('span', { class: 'msg-text', text })
  );
}

function planCard(plan, index) {
  const card = el('div', { class: 'plan' + (plan.messages.length > 1 ? ' multi' : '') });
  card.append(el('div', { class: 'tone' },
    el('span', { class: 'tone-name', text: plan.tone }),
    el('span', { class: 'tone-count', text: plan.messages.length > 1 ? `连着发 ${plan.messages.length} 条` : '发 1 条' })
  ));
  plan.messages.forEach((m, i) => card.append(messageRow(i + 1, m)));
  if (plan.messages.length > 1) {
    card.append(el('div', { class: 'plan-tip', text: '点一下先填第 1 条，剩下的按顺序跟着点' }));
  }
  card.addEventListener('click', () => choosePlan(index));
  return card;
}

function sequenceView(s) {
  const active = s.activePlan;
  const box = el('div', { class: 'sequence' });
  const total = active.sent.length + active.remaining.length;
  box.append(el('div', { class: 'seq-head', text: `这一组共 ${total} 条 · 已填入 ${active.sent.length} 条` }));
  if (active.sent.length) {
    box.append(el('div', { class: 'seq-sent', text: '✓ ' + active.sent.join(' ／ ') }));
  }
  box.append(el('div', { class: 'seq-label', text: '接下来（点第一条填入）' }));

  active.remaining.forEach((m, i) => {
    const row = messageRow(active.sent.length + i + 1, m, i === 0 ? 'next' : 'preview');
    if (i === 0) row.addEventListener('click', sendNext);
    box.append(row);
  });
  if (active.remaining.length > 1) {
    box.append(el('div', { class: 'plan-tip', text: `后面还有 ${active.remaining.length - 1} 条，发完这条再点下一条` }));
  } else {
    box.append(el('div', { class: 'plan-tip', text: '先把上一条发出去（Enter），再点这一条' }));
  }
  box.append(el('div', {
    class: 'plan-tip',
    text: '对剩下的不满意？点下面的「🎲 换一批」只会重写这几条，已发的会带成上下文'
  }));
  const back = el('button', { class: 'link', text: '↺ 重新选一组', onclick: resetSequence });
  box.append(el('div', { class: 'row' }, back));
  return box;
}

function loadingView(pending, suggestion) {
  const box = el('div', { class: 'loading' });
  box.append(el('div', { class: 'loading-label', text: pending && pending.mode === 'deep' ? '深度思考中…' : '正在想怎么回…' }));
  for (const w of [78, 92, 64]) {
    box.append(el('div', { class: 'shimmer' }, el('span', { style: `width:${w}%` })));
  }
  if (suggestion && suggestion.activePlan && suggestion.activePlan.sent.length) {
    box.append(el('div', {
      class: 'loading-tip',
      text: `已发出去的 ${suggestion.activePlan.sent.length} 条会带进上下文，接着往下写`
    }));
  }
  return box;
}

function render(s, pending) {
  const focusBack = inputFocused && document.activeElement === root.querySelector('.hint');
  empty(root);

  const contact = (pending && pending.contact) || (s && s.contact) || '';
  const sourceMessage = (pending && pending.sourceMessage) || (s && s.sourceMessage) || '';
  const sourceIsSelf = pending ? !!pending.sourceIsSelf : !!(s && s.sourceIsSelf);
  const hint = (s && s.hint) || '';
  const inSequence = !!(s && s.activePlan && !pending);

  root.append(
    el('div', { class: 'card-head' },
      el('span', { class: 'title', text: '💬 回复建议' }),
      el('span', { class: 'contact', text: '· ' + contact }),
      el('button', {
        class: 'close',
        text: '✕',
        title: '收起（再复制一次这段聊天就会重新弹出）',
        onclick: collapse
      })
    ),
    el('div', { class: 'source', text: (sourceIsSelf ? '你最后说：' : '对方最后说：') + sourceMessage })
  );

  if (hint) {
    root.append(el('div', { class: 'hint-chip', text: '已按你的描述重写：' + hint }));
  }

  const body = el('div', { class: 'body' });
  if (pending) {
    body.append(loadingView(pending, s));
  } else if (inSequence) {
    body.append(sequenceView(s));
  } else if (s && s.plans) {
    s.plans.forEach((plan, i) => body.append(planCard(plan, i)));
  }
  root.append(body);

  const input = el('input', {
    class: 'hint',
    type: 'text',
    value: hintDraft,
    placeholder: '想怎么回？说说你的想法…',
    maxlength: '200'
  });
  input.addEventListener('input', () => { hintDraft = input.value; });
  input.addEventListener('focus', () => { inputFocused = true; });
  input.addEventListener('blur', () => { inputFocused = false; });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      regenerate(input.value, !input.value.trim(), false);
    }
  });

  root.append(
    el('div', { class: 'compose' },
      input,
      el('button', {
        class: 'hint-btn',
        title: '按你的描述重新生成',
        text: '↵',
        onclick: () => regenerate(input.value, !input.value.trim(), false)
      })
    ),
    el('div', { class: 'actions' },
      el('button', {
        class: 'ghost',
        text: '🎲 换一批',
        title: inSequence ? '只重写这一组还没发出去的几条' : '同一段聊天换几种说法',
        onclick: () => regenerate('', true, false)
      }),
      el('button', {
        class: 'ghost deep',
        text: '🧠 深度思考',
        title: '打开模型思考过程重来：允许更多条、更长内容，但更慢',
        onclick: () => regenerate(hintDraft, !hintDraft.trim(), true)
      }),
      el('span', { class: 'status' + (statusKind ? ' ' + statusKind : ''), text: statusText })
    )
  );

  // 生成中（服务端 pending 或本地刚点的操作）都禁用交互，避免重复触发
  root.classList.toggle('busy', busy || !!pending);
  if (focusBack) {
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }
  reportSize();
}

function withBusy(fn) {
  if (busy) return;
  busy = true;
  root.classList.add('busy');
  Promise.resolve()
    .then(fn)
    .catch(() => {})
    .finally(() => {
      busy = false;
      root.classList.remove('busy');
    });
}

function choosePlan(index) {
  if (!currentId) return;
  withBusy(async () => {
    setStatus('正在填入微信…');
    try {
      const r = await api.replySuggestions.apply(currentId, index);
      if (r && r.ok) {
        setStatus(r.done ? '已填入 ✓（这一组发完了）' : '已填入第 1 条 ✓ 接着点下一条');
      } else {
        setStatus((r && r.error) || '已复制，请手动粘贴', 'warn');
      }
      await refresh(true);
    } catch (e) {
      setStatus(String((e && e.message) || e), 'err');
    }
  });
}

function sendNext() {
  if (!currentId) return;
  withBusy(async () => {
    setStatus('正在填入下一条…');
    try {
      const r = await api.replySuggestions.next(currentId);
      if (r && r.ok) {
        setStatus(r.done ? '这一组发完了 ✓' : '已填入 ✓ 继续点下一条');
      } else {
        setStatus((r && r.error) || '已复制，请手动粘贴', 'warn');
      }
      await refresh(true);
    } catch (e) {
      setStatus(String((e && e.message) || e), 'err');
    }
  });
}

function resetSequence() {
  if (!currentId) return;
  withBusy(async () => {
    try {
      await api.replySuggestions.reset(currentId);
      setStatus('');
      await refresh(true);
    } catch (e) {
      setStatus(String((e && e.message) || e), 'err');
    }
  });
}

// 一组里已经点过前几条时，「换一批 / 深度思考」只重写这一组剩下的几条
function regenerate(hint, rotate = false, deep = false) {
  if (!currentId) return;
  const text = String(hint || '').trim();
  const inSequence = !!(lastSuggestion && lastSuggestion.activePlan);
  const modeLabel = deep ? '深度思考中' : '正在想怎么回';
  const targetLabel = inSequence ? '剩下的几条' : '建议';

  withBusy(async () => {
    setStatus(`${modeLabel}…`);
    // 立刻切到「思考中」，不用等模型返回
    stateKey = '';
    render(lastSuggestion, { startedAt: 'local', mode: deep ? 'deep' : 'fast', contact: lastSuggestion && lastSuggestion.contact });
    try {
      const r = inSequence
        ? await api.replySuggestions.continuePlan(currentId, deep)
        : await api.replySuggestions.regenerate(text, rotate, deep);
      if (r && r.ok) {
        if (!inSequence) hintDraft = '';
        setStatus(deep ? `已深度思考，重写${targetLabel} ✓` : `${targetLabel}已更新 ✓`);
      } else {
        setStatus((r && r.error) || '重新生成失败', 'err');
      }
      await refresh(true);
    } catch (e) {
      setStatus(String((e && e.message) || e), 'err');
      await refresh(true);
    }
  });
}

// ✕ / Esc = 收起浮窗（不是丢弃建议）：服务端那批建议仍然保留，
// 用户再复制一次同一段聊天就会重新弹出来（showToken 变化 -> Electron 重新显示）。
function collapse() {
  const b = bridge();
  if (b && b.hideCard) b.hideCard();
}

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') collapse();
});

const b = bridge();
if (b && b.onShown) b.onShown(() => refresh(true));

setInterval(refresh, 500);
refresh();
