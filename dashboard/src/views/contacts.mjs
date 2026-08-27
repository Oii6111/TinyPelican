import { api } from '../api.mjs';
import { el, empty } from '../ui.mjs';

export function mount(container, ctx) {
  empty(container);
  container.className = 'view padless';

  const listBox = el('aside', { class: 'contact-list' });
  const detail = el('div', { class: 'contact-detail' });
  container.append(el('div', { class: 'contacts-layout' }, listBox, detail));

  let selected = '';

  async function loadList() {
    let items = [];
    try { items = await api.contacts.list(); } catch {}
    empty(listBox);
    if (!items.length) {
      listBox.append(el('div', { class: 'empty', text: '暂无档案' }));
      return;
    }
    for (const c of items) {
      const item = el('div', { class: 'contact-item' + (c.name === selected ? ' active' : '') },
        el('div', { class: 'name', text: (c.important ? '⭐ ' : '') + c.name + (c.remark ? '（' + c.remark + '）' : '') }),
        el('div', { class: 'sub', text: c.messages + ' 条消息' })
      );
      item.onclick = () => { selected = c.name; loadList(); loadDetail(); };
      listBox.append(item);
    }
  }

  async function loadDetail() {
    if (!selected) {
      empty(detail);
      detail.append(el('div', { class: 'empty', text: '选择左侧联系人查看档案' }));
      return;
    }
    let c = null;
    try { c = await api.contacts.get(selected); } catch {}
    if (!c) {
      empty(detail);
      detail.append(el('div', { class: 'empty', text: '加载失败' }));
      return;
    }
    const profileRows = Object.entries(c.profile || {}).filter(([, v]) => v && String(v).trim() && v !== '未知');
    empty(detail);
    const card = el('div', { class: 'card' },
      el('h2', {},
        el('span', { text: c.name }),
        el('button', { class: 'star-btn' + (c.important ? ' on' : ''), text: c.important ? '★' : '☆', title: '特别关心（关系维护提醒）', onclick: toggleStar })
      )
    );
    if (c.remark) card.append(el('div', { class: 'desc', text: '备注：' + c.remark }));
    if (c.important) card.append(el('div', { class: 'desc', style: 'color:var(--accent-text);', text: '⭐ 特别关心：长时间没联系会自动提醒你维护关系' }));
    if (profileRows.length) {
      card.append(el('h3', { text: '画像' }));
      card.append(el('ul', {}, ...profileRows.map(([k, v]) => el('li', {}, el('b', { text: k + '：' }), ' ' + v))));
    } else {
      card.append(el('div', { class: 'empty', style: 'padding:20px 0;', text: '暂无画像，可手动补充或在「记忆输入」中开启自动提取' }));
    }
    card.append(
      el('div', { class: 'actions', style: 'margin-top:16px;' },
        el('button', { class: 'btn btn-edit btn-sm', text: '查看聊天记录 →', onclick: () => ctx.navigate('timeline', { contact: c.name }) })
      )
    );
    detail.append(card);
  }

  async function toggleStar() {
    if (!selected) return;
    try {
      const c = await api.contacts.get(selected);
      await api.contacts.setImportant(selected, !c.important);
      loadList();
      loadDetail();
    } catch {}
  }

  return {
    show() { loadList(); if (selected) loadDetail(); },
    hide() {}
  };
}
