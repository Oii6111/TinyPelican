import { api } from '../api.mjs';
import { el, renderRichText } from '../ui.mjs';

const questions = {
  reply: '结合最近的聊天，帮我想想下一句怎么回复，给我几个自然的说法。',
  analysis: '帮我理解最近聊天中对方可能的感受，哪些是事实，哪些只是猜测？',
  review: '一起复盘最近的聊天：哪里沟通得不错，哪里可以调整，下一步可以怎么做？'
};

export function mount(container, ctx) {
  let relationships = [];
  let selected = '';
  let messages = [];
  let draft = '';
  let pending = '';
  let error = '';
  let loading = false;
  let sending = false;
  let visible = false;
  let revision = 0;
  const drafts = new Map();
  const handledParams = new WeakSet();

  function render() {
    if (!visible) return;
    const person = relationships.find(item => item.id === selected);
    const selector = el('select', { class: 'select', 'aria-label': '选择联系人', disabled: sending || loading, onchange: event => {
      drafts.set(selected, draft);
      selected = event.target.value;
      draft = drafts.get(selected) || '';
      loadHistory();
    } }, ...relationships.map(item => el('option', { value: item.id, selected: item.id === selected, text: item.label || item.contactName })));
    const transcript = el('div', { class: 'romance-chat-transcript', role: 'log', 'aria-label': '辅导对话', 'aria-live': 'polite' });
    if (loading) transcript.append(el('p', { class: 'romance-chat-empty-note', text: '正在读取对话…' }));
    else if (!messages.length && !pending) transcript.append(el('div', { class: 'romance-chat-welcome' },
      el('span', { class: 'romance-coach-orb', 'aria-hidden': 'true', text: '♡' }),
      el('h2', { text: person ? `关于${person.label || person.contactName}，你想聊些什么？` : '先选择一位你想了解的人' }),
      el('p', { text: person ? '我会结合已导入的聊天和关系档案，陪你一起理清思路。' : '创建关系后，就可以在这里开始对话。' }),
      person ? el('div', { class: 'romance-chat-prompts' }, ...[
        ['reply', '这句话怎么回？'], ['analysis', '帮我理解对方'], ['review', '复盘最近的聊天']
      ].map(([type, title]) => el('button', { class: 'btn', disabled: sending, text: title, onclick: () => send(questions[type]) }))) :
        el('button', { class: 'btn', text: '去创建关系', onclick: () => ctx.navigate('romance-home') })));
    for (const message of [...messages, ...(pending ? [{ role: 'user', text: pending }] : [])]) {
      const bubble = el('div', { class: 'romance-chat-bubble' });
      if (message.role === 'assistant') renderRichText(bubble, message.text);
      else bubble.textContent = message.text;
      transcript.append(el('article', { class: `romance-chat-message ${message.role === 'user' ? 'is-user' : 'is-assistant'}` },
        el('span', { class: 'romance-chat-role', text: message.role === 'user' ? '你' : '小鹈鹕' }), bubble));
    }
    if (sending) transcript.append(el('p', { class: 'romance-chat-empty-note', role: 'status', text: '正在结合你们的聊天思考…' }));
    if (error) transcript.append(el('div', { class: 'romance-chat-error', role: 'alert' },
      el('span', { text: error }), el('button', { class: 'btn btn-ghost btn-sm', text: pending ? '重试回复' : '重新加载', onclick: () => pending ? send(pending) : loadHistory() })));
    const input = el('textarea', { class: 'textarea', rows: '3', maxlength: '12000', 'aria-label': '给教练的消息', placeholder: '说说你的困惑，也可以补充具体消息或继续追问…', disabled: !person || loading || sending, text: draft,
      oninput: event => { draft = event.target.value; },
      onkeydown: event => {
        if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); send(); }
      }
    });
    container.replaceChildren(el('div', { class: 'romance-chat' },
      el('header', { class: 'romance-chat-header' }, el('div', {}, el('span', { class: 'romance-kicker', text: 'AI 教练' }), el('h1', { text: '好好聊聊，慢慢靠近' })), selector),
      transcript,
      el('div', { class: 'romance-chat-composer' }, input, el('div', { class: 'romance-chat-composer-foot' },
        el('span', { text: 'Enter 发送 · Shift + Enter 换行' }),
        el('button', { class: 'btn btn-primary', text: sending ? '正在回复…' : '发送', disabled: !person || loading || sending, onclick: () => send() })))));
    if (messages.length || pending) transcript.scrollTop = transcript.scrollHeight;
  }

  async function loadHistory() {
    const current = ++revision;
    loading = true;
    messages = [];
    pending = '';
    error = '';
    render();
    try { if (selected) {
      const result = await api.romance.coachHistory(selected);
      if (current !== revision) return;
      messages = result.messages || [];
    } } catch { if (current === revision) error = '暂时无法读取辅导历史，请重试。'; }
    finally { if (current === revision) { loading = false; render(); } }
  }

  async function send(value = draft) {
    const message = String(value || '').trim();
    if (!selected || !message || loading || sending) return;
    if (message.length > 12000) { error = '消息请控制在 12000 字以内。'; render(); return; }
    sending = true;
    pending = message;
    error = '';
    draft = '';
    render();
    try {
      const result = await api.romance.coachChat({ relationshipId: selected, message });
      messages = result.messages || [];
      pending = '';
      drafts.delete(selected);
    } catch (failure) {
      error = failure.status ? failure.message : '连接暂时中断，请重试。';
      draft = message;
    } finally { sending = false; render(); }
  }

  async function show(params = {}) {
    visible = true;
    if (sending) { render(); return; }
    if (handledParams.has(params)) params = {};
    else handledParams.add(params);
    try {
      const state = await api.romance.relationships.list();
      relationships = state.relationships || [];
      selected = [params.relationshipId, selected, state.primaryId].find(id => relationships.some(item => item.id === id)) || relationships[0]?.id || '';
      draft = drafts.get(selected) || '';
      await loadHistory();
      if (visible && params.type && questions[params.type] && !error) await send(questions[params.type]);
    } catch { error = '暂时无法读取关系，请返回首页后重试。'; render(); }
  }
  return { show, hide() { visible = false; drafts.set(selected, draft); } };
}
