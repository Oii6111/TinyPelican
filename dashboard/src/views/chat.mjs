import { api } from '../api.mjs';
import { el, empty } from '../ui.mjs';

export function mount(container) {
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
        item.onclick = () => { session = c.key; loadConvs(); loadHistory(); };
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
        log.append(el('div', { class: 'bubble ' + (m.role === 'user' ? 'user' : 'bot'), text: m.text }));
      }
    }
    log.scrollTop = log.scrollHeight;
  }

  async function newConversation() {
    try {
      const d = await api.chat.create();
      session = d.key;
      loadConvs();
      loadHistory();
    } catch {}
  }

  async function removeConv(key) {
    if (!confirm('删除这个会话？该操作不可撤销。')) return;
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
    const thinking = el('div', { class: 'bubble bot', text: '思考中…' });
    log.append(thinking);
    log.scrollTop = log.scrollHeight;
    try {
      const d = await api.chat.send(msg, session);
      thinking.remove();
      if (d.ok) log.append(el('div', { class: 'bubble bot', text: d.reply || '(空回复)' }));
      else log.append(el('div', { class: 'bubble bot error', text: '出错了：' + (d.error || '未知') }));
      loadConvs();
    } catch (e) {
      thinking.remove();
      log.append(el('div', { class: 'bubble bot error', text: '请求失败：' + e.message }));
    } finally {
      sending = false;
      sendBtn.disabled = false;
      input.focus();
    }
    log.scrollTop = log.scrollHeight;
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
      // 打开对话即视为已读
      api.unread.read().catch(() => {});
    },
    hide() {}
  };
}
