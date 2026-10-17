import { api } from '../api.mjs';
import { el, empty } from '../ui.mjs';

export function mount(container) {
  empty(container);
  container.className = 'view padless dsh-chat-view';

  const frame = el('iframe', { class: 'dsh-chat-frame', title: '小鹈鹕对话', referrerpolicy: 'no-referrer', hidden: true });
  const title = el('strong', { text: '正在连接对话…' });
  const detail = el('p', { text: '首次启动可能需要一些时间，连接完成后自动显示对话。' });
  const retry = el('button', { class: 'btn', text: '重新连接', hidden: true, onclick: connect });
  const status = el('div', { class: 'dsh-chat-status', role: 'status', 'aria-live': 'polite' }, title, detail, retry);
  container.append(status, frame);

  let connecting = false;
  let initialized = false;
  let loadTimer = null;

  function failed(message) {
    clearTimeout(loadTimer);
    connecting = false;
    initialized = false;
    frame.hidden = true;
    status.hidden = false;
    title.textContent = '暂时无法打开对话';
    detail.textContent = message;
    retry.hidden = false;
    document.getElementById('dsh-sidebar-host')?.dispatchEvent(new CustomEvent('dsh-sidebar-error', { detail: message }));
  }

  document.getElementById('dsh-sidebar-host')?.addEventListener('dsh-sidebar-ready', () => {
    clearTimeout(loadTimer);
    connecting = false;
    initialized = true;
    status.hidden = true;
    frame.hidden = false;
  });
  frame.addEventListener('load', () => {
    if (!connecting || !frame.getAttribute('src')) return;
    try {
      if (!frame.contentWindow.__TP_EMBED__) failed(frame.contentDocument.body.textContent.slice(0,300) || '对话页面加载失败，请重试。');
    } catch { failed('对话页面来源不匹配，请重新连接。'); }
  });
  frame.addEventListener('error', () => failed('页面加载失败，请重新连接。'));

  async function connect() {
    if (connecting) return;
    connecting = true;
    status.hidden = false;
    retry.hidden = true;
    frame.hidden = true;
    title.textContent = '正在连接对话…';
    detail.textContent = '首次启动可能需要一些时间，连接完成后自动显示对话。';
    try {
      const connection = await api.agent.webui();
      const url = new URL(connection.url);
      if (url.origin !== location.origin || url.pathname !== '/dsh/') {
        throw new Error('DSH 返回的页面地址与当前应用不匹配。');
      }
      loadTimer = setTimeout(() => failed('对话页面加载超时，请重新连接。'), 60000);
      frame.setAttribute('src', url.href);
    } catch (error) {
      failed(error.message || '连接失败，请稍后重试。');
    }
  }

  return {
    show() {
      if (!initialized) connect();
      api.unread.read().catch(() => {});
    },
    hide() {}
  };
}
