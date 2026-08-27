// 轻量 DOM 工具

export function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

export function empty(node) {
  node.replaceChildren();
}

export function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return isNaN(d.getTime()) ? String(ts) : d.toLocaleString('zh-CN', { hour12: false });
}

export function toast(msg, ok = true) {
  const box = document.getElementById('toast');
  if (!box) return;
  box.textContent = msg;
  box.className = 'toast ' + (ok ? 'ok' : 'err');
  box.style.opacity = '1';
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { box.style.opacity = '0'; }, 2200);
}

export function placeholder(title, desc) {
  return el('div', { class: 'card' },
    el('h2', { text: title }),
    el('div', { class: 'desc', text: desc }),
    el('div', { class: 'empty', text: '该能力将在后续版本接入' })
  );
}
