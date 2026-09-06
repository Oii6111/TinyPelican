import { api } from '../api.mjs';
import { el, empty, renderRichText } from '../ui.mjs';
import {
  createStreamAnswerCard,
  appendAnswerEvents,
  createSummaryAnswerCard,
  createHistoryAnswerCard
} from '../components/agent-events.mjs';

export function mount(container, ctx = {}) {
  empty(container);
  container.className = 'view padless';

  const convList = el('div', { class: 'wechat-contact-list' });
  const convSearch = el('input', { class: 'wechat-search', placeholder: '⌕  搜索会话' });
  const title = el('strong', { class: 'wechat-chat-title-name', text: '小鹈鹕' });
  const log = el('div', { class: 'wechat-chat-log agent-chat-log' });
  const input = el('textarea', { class: 'wechat-compose-input', placeholder: '和小鹈鹕说点什么…（Enter 发送）', rows: 1 });
  const sendBtn = el('button', { class: 'wechat-send-btn', text: '发送' });

  container.append(
    el('div', { class: 'wechat-contacts-layout agent-chat-layout' },
      el('aside', { class: 'wechat-sidebar agent-chat-sidebar' },
        el('div', { class: 'wechat-search-wrap agent-search-wrap' },
          convSearch,
          el('button', { class: 'wechat-new-chat-btn', title: '新对话', text: '＋', onclick: newConversation })
        ),
        convList
      ),
      el('section', { class: 'wechat-chat-main' },
        el('header', { class: 'wechat-chat-head' },
          el('div', { class: 'wechat-chat-title' }, title, el('small', { text: '与小鹈鹕的对话' })),
          el('div', { class: 'wechat-head-actions' }, el('button', { class: 'wechat-head-icon', text: '⋯', title: '会话选项' }))
        ),
        log,
        el('div', { class: 'wechat-composer agent-composer' }, input, sendBtn)
      )
    )
  );

  let session = null;
  let sending = false;
  let firstShow = true;
  let pollTimer = null;

  function stopPoll() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  async function ensureSession() {
    if (session) return;
    try {
      const d = await api.chat.create();
      session = d.key;
    } catch {
      session = 'agent:main:webui:' + Date.now();
    }
  }

  async function loadConvs() {
    let convs = [];
    try { convs = await api.chat.conversations(); } catch {}
    empty(convList);
    const query = convSearch.value.trim().toLowerCase();
    const filteredConvs = query ? convs.filter((c) => String(c.title || '').toLowerCase().includes(query)) : convs;
    if (!filteredConvs.length) {
      convList.append(el('div', { class: 'empty', text: '暂无会话' }));
    } else {
      for (const c of filteredConvs) {
        const item = el('div', { class: 'wechat-contact-item' + (c.key === session ? ' active' : ''), role: 'button', tabindex: '0' },
          el('span', { class: 'wechat-contact-copy' },
            el('strong', { text: c.title || '新对话' }),
            el('small', { text: c.count + ' 条消息' })
          ),
          el('button', { class: 'agent-conv-delete', title: '删除会话', text: '×', onclick: (e) => { e.stopPropagation(); removeConv(c.key); } })
        );
        item.onclick = () => { stopPoll(); session = c.key; loadConvs(); loadHistory(); };
        convList.append(item);
      }
    }
    const cur = convs.find((c) => c.key === session);
    title.textContent = cur ? cur.title : '';
  }

  async function loadHistory() {
    empty(log);
    if (!session) {
      log.append(el('div', { class: 'wechat-msg-row incoming' }, el('div', { class: 'wechat-msg-body' }, el('div', { class: 'wechat-bubble' , text: '新的对话，说点什么吧～' }))));
      return;
    }
    let msgs = [];
    try { msgs = await api.chat.history(session); } catch {}
    if (!msgs.length) {
      log.append(el('div', { class: 'wechat-msg-row incoming' }, el('div', { class: 'wechat-msg-body' }, el('div', { class: 'wechat-bubble', text: '新的对话，说点什么吧～' }))));
    } else {
      for (const m of msgs) {
        if (m.role === 'user') {
          log.append(el('div', { class: 'wechat-msg-row outgoing' }, el('div', { class: 'wechat-msg-body' }, el('div', { class: 'wechat-bubble', text: m.text }))));
        } else if (m.role === 'bot' && Array.isArray(m.agentEvents) && m.agentEvents.length) {
          try {
            log.append(createHistoryAnswerCard({ text: m.text, events: m.agentEvents }));
          } catch {
            log.append(el('div', { class: 'wechat-msg-row incoming' }, el('div', { class: 'wechat-msg-body' }, el('div', { class: 'wechat-bubble', text: m.text }))));
          }
        } else if (m.role === 'bot' && m.executionSummary) {
          const card = createSummaryAnswerCard({ text: m.text, summary: m.executionSummary }); card.classList.add('agent-answer-incoming'); log.append(card);
        } else {
          const answer = el('div', { class: 'wechat-msg-row incoming' });
          const body = el('div', { class: 'wechat-msg-body' });
          const bubble = el('div', { class: 'wechat-bubble' });
          renderRichText(bubble, m.text);
          body.append(bubble); answer.append(body); log.append(answer);
        }
      }
    }
    log.scrollTop = log.scrollHeight;
  }

  async function newConversation() {
    stopPoll();
    try {
      const d = await api.chat.create();
      session = d.key;
      loadConvs();
      loadHistory();
    } catch {}
  }

  async function removeConv(key) {
    if (!confirm('删除这个会话？该操作不可撤销。')) return;
    stopPoll();
    await api.chat.remove(key);
    if (session === key) {
      session = null;
      await ensureSession();
      empty(log);
      log.append(el('div', { class: 'wechat-msg-row incoming' }, el('div', { class: 'wechat-msg-body' }, el('div', { class: 'wechat-bubble', text: '新的对话，说点什么吧～' }))));
    }
    loadConvs();
    loadHistory();
  }

  async function send() {
    const msg = input.value.trim();
    if (!msg || sending) return;
    input.value = '';
    log.append(el('div', { class: 'wechat-msg-row outgoing' }, el('div', { class: 'wechat-msg-body' }, el('div', { class: 'wechat-bubble', text: msg }))));
    sending = true;
    sendBtn.disabled = true;

    const answerCard = createStreamAnswerCard({ running: true, text: '' });
    log.append(answerCard);
    log.scrollTop = log.scrollHeight;
    let lastSeq = 0;

    let settled = false;
    const finishSend = () => {
      if (settled) return;
      settled = true;
      sending = false;
      sendBtn.disabled = false;
      input.focus();
      setTimeout(() => { log.scrollTop = log.scrollHeight; }, 50);
    };

    try {
      const d = await api.chat.send(msg, session);
      if (!d.ok) {
        appendAnswerEvents(answerCard, [], { running: false, done: true, error: d.error || 'DSH 启动失败' });
        finishSend();
        return;
      }
      // MainAgentSession 已同步返回最终回复（无 taskId/事件流）。
      if (d.text) {
        appendAnswerEvents(answerCard, d.agentEvents || [], { running: false, done: true, finalText: d.text });
        loadConvs();
        log.scrollTop = log.scrollHeight;
        finishSend();
        return;
      }
      if (!d.taskId) {
        appendAnswerEvents(answerCard, [], { running: false, done: true, error: d.error || 'DSH 启动失败' });
        finishSend();
        return;
      }

      pollTimer = setInterval(async () => {
        try {
          const d2 = await api.agent.get(d.taskId, lastSeq);
          const t = d2.task;
          const events = t.events || [];
          const isDone = t.status === 'completed' || t.status === 'failed';
          appendAnswerEvents(answerCard, events, {
            running: !isDone,
            done: isDone,
            finalText: isDone ? (t.output || null) : null,
            error: isDone && t.status === 'failed' ? (t.error || '未知') : ''
          });
          if (typeof t.lastSeq === 'number') lastSeq = t.lastSeq;
          if (events.length) log.scrollTop = log.scrollHeight;
          if (isDone) {
            stopPoll();
            loadConvs();
            log.scrollTop = log.scrollHeight;
            finishSend();
          }
        } catch {}
      }, 300);
    } catch (e) {
      appendAnswerEvents(answerCard, [], { running: false, done: true, error: '请求失败：' + e.message });
      finishSend();
    }
  }

  sendBtn.onclick = send;
  convSearch.addEventListener('input', () => loadConvs());
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });

  return {
    async show() {
      await ensureSession();
      if (firstShow) {
        firstShow = false;
        empty(log);
        log.append(el('div', { class: 'bubble bot', text: '新的对话，说点什么吧～' }));
      } else {
        loadHistory();
      }
      loadConvs();
      input.focus();
      api.unread.read().catch(() => {});
    },
    hide() { stopPoll(); }
  };
}
