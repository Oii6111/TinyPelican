import { api } from '../api.mjs';
import { el, empty } from '../ui.mjs';

export function mount(container) {
  empty(container);
  container.className = 'view';
  const sel = el('select', { class: 'select' });
  const search = el('input', { class: 'input', placeholder: '搜索关键词…' });
  const list = el('div');
  container.append(
    el('div', { class: 'card' },
      el('h2', { text: '聊天记录查看器' }),
      el('div', { class: 'desc', text: '按时间线查看与某位联系人的完整对话，支持关键词检索；导出功能后续版本接入。' }),
      el('div', { class: 'row', style: 'margin-bottom:14px;' },
        el('div', { class: 'field', style: 'margin:0;' }, sel),
        el('div', { class: 'field', style: 'margin:0;' }, search)
      ),
      list
    )
  );

  async function loadContacts() {
    let items = [];
    try { items = await api.contacts.list(); } catch {}
    empty(sel);
    sel.append(el('option', { value: '', text: '选择联系人…' }));
    for (const c of items) {
      sel.append(el('option', { value: c.name, text: c.name + (c.remark ? '（' + c.remark + '）' : '') }));
    }
  }

  async function render() {
    const name = sel.value;
    const kw = search.value.trim();
    empty(list);
    if (!name) {
      if (!kw) {
        list.append(el('div', { class: 'empty', text: '输入关键词可搜索全部联系人，或先选择联系人查看完整记录' }));
        return;
      }
      const results = await api.search(kw).catch(() => []);
      if (!results.length) {
        list.append(el('div', { class: 'empty', text: '没有匹配的消息' }));
        return;
      }
      for (const r of results) {
        const row = el('div', { class: 'msg', style: 'cursor:pointer;' },
          el('span', { class: 't', text: r.ts || '' }),
          el('span', {}, el('b', { text: r.contact + (r.remark ? '（' + r.remark + '）' : '') + ' · ' + (r.name || '') + '　' }), r.content)
        );
        row.onclick = async () => {
          sel.value = r.contact;
          await loadContacts();
          sel.value = r.contact;
          render();
        };
        list.append(row);
      }
      return;
    }
    let c = null;
    try { c = await api.contacts.get(name); } catch {}
    if (!c) {
      list.append(el('div', { class: 'empty', text: '加载失败' }));
      return;
    }
    const msgs = (c.messages || []).filter((m) => !kw || String(m.content || '').includes(kw)).slice().reverse();
    if (!msgs.length) {
      list.append(el('div', { class: 'empty', text: '没有匹配的消息' }));
      return;
    }
    for (const m of msgs) {
      const content = (m.type && m.type !== 'text' && !m.content) ? ('[' + m.type + ']') : (m.content || '');
      list.append(
        el('div', { class: 'msg' },
          el('span', { class: 't', text: m.ts || '' }),
          el('span', {}, el('b', { text: (m.name || '') + '　' }), content)
        )
      );
    }
  }

  sel.onchange = render;
  search.addEventListener('input', render);

  return {
    show(params) {
      loadContacts();
      if (params && params.contact) {
        sel.value = params.contact;
      }
      render();
    },
    hide() {}
  };
}
