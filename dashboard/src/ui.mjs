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

function appendInlineMarkdown(node, text) {
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let offset = 0;
  for (const match of String(text).matchAll(pattern)) {
    if (match.index > offset) node.append(document.createTextNode(text.slice(offset, match.index)));
    const token = match[0];
    if (token.startsWith('**')) node.append(el('strong', { text: token.slice(2, -2) }));
    else node.append(el('code', { text: token.slice(1, -1) }));
    offset = match.index + token.length;
  }
  if (offset < text.length) node.append(document.createTextNode(text.slice(offset)));
}

export function renderRichText(node, text) {
  empty(node);
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  let list = null;
  for (const raw of lines) {
    const line = raw.trimEnd();
    const item = line.match(/^\s*[-*]\s+(.+)$/);
    if (item) {
      if (!list) {
        list = el('ul');
        node.append(list);
      }
      const li = el('li');
      appendInlineMarkdown(li, item[1]);
      list.append(li);
      continue;
    }
    list = null;
    if (!line.trim()) {
      node.append(el('div', { class: 'rich-spacer' }));
      continue;
    }
    const heading = line.match(/^#{1,3}\s+(.+)$/);
    const block = el(heading ? 'strong' : 'div');
    appendInlineMarkdown(block, heading ? heading[1] : line);
    node.append(block);
  }
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
