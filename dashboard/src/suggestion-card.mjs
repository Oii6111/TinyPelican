// 回复建议卡片：轮询当前建议，点击后调用 apply API，成功后通知 Electron 关闭浮窗
import { api } from './api.mjs';
import { el, empty } from './ui.mjs';

const root = document.getElementById('card');
let currentId = null;
let busy = false;

async function refresh() {
  if (!root || busy) return;
  let data;
  try {
    data = await api.replySuggestions.current();
  } catch {
    return;
  }
  const s = data && data.suggestion;
  if (!s) {
    if (currentId) {
      empty(root);
      currentId = null;
    }
    return;
  }
  if (s.id === currentId) return;
  currentId = s.id;
  render(s);
}

function render(s) {
  empty(root);

  const head = el('div', { class: 'card-head' },
    el('span', { class: 'title', text: '💬 回复建议' }),
    el('span', { class: 'contact', text: '· ' + s.contact }),
    el('button', { class: 'close', text: '✕', title: '关闭', onclick: () => dismiss(s.id) })
  );
  const source = el('div', { class: 'source', text: '对方最后说：' + (s.sourceMessage || '') });
  const optionsBox = el('div', { class: 'options' });

  s.options.forEach((o, i) => {
    const status = el('div', { class: 'status' });
    const option = el('div', { class: 'option' },
      el('div', { class: 'tone', text: o.tone }),
      el('div', { class: 'text', text: o.text }),
      status
    );
    option.onclick = () => apply(option, status, s, i);
    optionsBox.append(option);
  });

  root.append(head, source, optionsBox);
}

async function apply(optionEl, statusEl, s, index) {
  if (busy) return;
  busy = true;
  optionEl.classList.add('disabled');
  statusEl.textContent = '正在填入微信...';
  try {
    const r = await api.replySuggestions.apply(s.id, index);
    if (r && r.ok) {
      statusEl.textContent = '已填入 ✓';
      if (window.suggestionsBridge && window.suggestionsBridge.applyDone) {
        setTimeout(() => window.suggestionsBridge.applyDone(), 400);
      }
    } else if (r && r.degraded) {
      statusEl.textContent = '已复制，请手动粘贴';
      busy = false;
      optionEl.classList.remove('disabled');
    } else {
      statusEl.textContent = '失败：' + ((r && r.error) || '未知错误');
      busy = false;
      optionEl.classList.remove('disabled');
    }
  } catch (e) {
    statusEl.textContent = '失败：' + (e.message || e);
    busy = false;
    optionEl.classList.remove('disabled');
  }
}

async function dismiss(id) {
  try { await api.replySuggestions.dismiss(id); } catch {}
  currentId = null;
  empty(root);
  if (window.suggestionsBridge && window.suggestionsBridge.hideCard) {
    window.suggestionsBridge.hideCard();
  }
}

setInterval(refresh, 800);
refresh();
