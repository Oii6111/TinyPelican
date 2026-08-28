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

  const convList = el('div', { class: 'conv-list' });
  const title = el('span', { class: 'muted' });
  const log = el('div', { class: 'chat-log' });
  const input = el('input', { class: 'input', placeholder: '和小鹈鹕说点什么…（Enter 发送）' });
  const sendBtn = el('button', { class: 'btn btn-primary', text: '发送' });

  container.append(
    el('div', { class: 'chat-layout' },
      el('aside', { class: 'chat-convs' },
        el('button', { class: 'btn btn-ghost btn-sm btn-block', text: '＋ 新对话', onclick: newConversation }),
        convList
      ),
      el('section', { class: 'chat-main' },
        el('div', { class: 'chat-head' }, title),
        log,
        el('div', { class: 'chat-input' }, input, sendBtn)
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
    if (!convs.length) {
      convList.append(el('div', { class: 'empty', text: '暂无会话' }));
    } else {
      for (const c of convs) {
        const item = el('div', { class: 'conv-item' + (c.key === session ? ' active' : '') },
          el('div', { class: 't', text: c.title }),
          el('div', { class: 's', text: c.count + ' 条' }),
          el('button', { class: 'del', text: '🗑', onclick: (e) => { e.stopPropagation(); removeConv(c.key); } })
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
      log.append(el('div', { class: 'bubble bot', text: '新的对话，说点什么吧～' }));
      return;
    }
    let msgs = [];
    try { msgs = await api.chat.history(session); } catch {}
    if (!msgs.length) {
      log.append(el('div', { class: 'bubble bot', text: '新的对话，说点什么吧～' }));
    } else {
      for (const m of msgs) {
        if (m.role === 'user') {
          log.append(el('div', { class: 'bubble user', text: m.text }));
        } else if (m.role === 'bot' && Array.isArray(m.agentEvents) && m.agentEvents.length) {
          try {
            log.append(createHistoryAnswerCard({ text: m.text, events: m.agentEvents }));
          } catch {
            log.append(el('div', { class: 'bubble bot', text: m.text }));
          }
        } else if (m.role === 'bot' && m.executionSummary) {
          log.append(createSummaryAnswerCard({ text: m.text, summary: m.executionSummary }));
        } else {
          const answer = el('div', { class: 'bubble bot' });
          renderRichText(answer, m.text);
          log.append(answer);
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
      log.append(el('div', { class: 'bubble bot', text: '新的对话，说点什么吧～' }));
    }
    loadConvs();
    loadHistory();
  }

  async function send() {
    const msg = input.value.trim();
    if (!msg || sending) return;
    input.value = '';
    log.append(el('div', { class: 'bubble user', text: msg }));
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
      if (!d.ok || !d.taskId) {
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
