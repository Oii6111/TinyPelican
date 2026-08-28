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
      item.onclick = () => { selected = c.name; profileEdit = false; loadList(); loadDetail(); };
      listBox.append(item);
    }
  }

  const PROFILE_FIELDS = ['关系类型', '近况', '偏好', '重要承诺/待办', '敏感话题/注意点', '情绪趋势', '最近互动时间'];
  let profileEdit = false;

  function profileToText(profile) {
    const keys = PROFILE_FIELDS.concat(Object.keys(profile || {}).filter((k) => !PROFILE_FIELDS.includes(k)));
    return keys.map((k) => `${k}：${(profile && profile[k]) || ''}`).join('\n');
  }

  function parseProfileText(text) {
    const profile = {};
    for (const line of String(text || '').split(/\r?\n/)) {
      const idx = line.indexOf('：');
      const key = idx >= 0 ? line.slice(0, idx).trim() : '';
      if (!key) continue;
      const value = idx >= 0 ? line.slice(idx + 1).trim() : line.trim();
      profile[key] = value;
    }
    return profile;
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
    empty(detail);
    const card = el('div', { class: 'card' },
      el('h2', {},
        el('span', { text: c.name }),
        el('span', { class: 'contact-header-actions' },
          el('button', { class: 'star-btn' + (c.important ? ' on' : ''), text: c.important ? '★' : '☆', title: '特别关心（关系维护提醒）', onclick: toggleStar }),
          el('button', { class: 'btn btn-sm', text: '编辑画像', onclick: () => { profileEdit = true; loadDetail(); } })
        )
      )
    );
    if (c.important) card.append(el('div', { class: 'desc', style: 'color:var(--accent-text);', text: '⭐ 特别关心：长时间没联系会自动提醒你维护关系' }));

    const remarkInput = el('input', { class: 'input', value: c.remark || '' });
    card.append(el('div', { class: 'field' },
      el('label', { text: '备注' }),
      remarkInput
    ));

    const profileText = profileToText(c.profile || {});
    card.append(el('h3', { text: '画像' }));
    let profileBox;
    let saveProfileBtn;
    if (profileEdit) {
      const area = el('textarea', { class: 'input contact-profile-edit', rows: Math.max(8, profileText.split('\n').length + 2) });
      area.value = profileText;
      saveProfileBtn = el('button', { class: 'btn btn-primary btn-sm', text: '保存画像', onclick: () => saveProfile(c, remarkInput, area, saveMsg) });
      const cancelBtn = el('button', { class: 'btn btn-sm', text: '取消', onclick: () => { profileEdit = false; loadDetail(); } });
      profileBox = el('div', {}, area, el('div', { class: 'actions', style: 'margin-top:8px;' }, saveProfileBtn, cancelBtn));
    } else {
      profileBox = el('pre', { class: 'contact-profile-view', text: profileText || '(暂无画像)' });
    }
    card.append(profileBox);

    const saveMsg = el('span', { class: 'muted' });
    card.append(
      el('div', { class: 'actions', style: 'margin-top:16px;align-items:center;' },
        saveProfileBtn || el('button', { class: 'btn btn-primary btn-sm', text: '保存备注', onclick: () => saveRemark(c, remarkInput, saveMsg) }),
        saveMsg,
        el('button', { class: 'btn btn-edit btn-sm', text: '查看聊天记录 →', onclick: () => ctx.navigate('timeline', { contact: c.name }) }),
        el('button', { class: 'btn btn-sm', text: '清空聊天记录', onclick: clearMessages }),
        el('button', { class: 'btn btn-danger btn-sm', text: '删除联系人', onclick: deleteContact })
      )
    );
    detail.append(card);
  }

  async function saveRemark(c, remarkInput, saveMsg) {
    try {
      await api.contacts.save(c.name, { remark: remarkInput.value.trim() });
      saveMsg.textContent = '备注已保存 ✓';
      loadList();
      loadDetail();
    } catch (e) {
      saveMsg.textContent = '保存失败：' + e.message;
    }
  }

  async function saveProfile(c, remarkInput, area, saveMsg) {
    const profile = parseProfileText(area.value);
    try {
      await api.contacts.save(c.name, {
        remark: remarkInput.value.trim(),
        profile
      });
      profileEdit = false;
      saveMsg.textContent = '画像已保存 ✓';
      loadList();
      loadDetail();
    } catch (e) {
      saveMsg.textContent = '保存失败：' + e.message;
    }
  }

  async function clearMessages() {
    if (!selected) return;
    if (!confirm('确定清空「' + selected + '」的全部聊天记录？档案和画像会保留。')) return;
    try {
      await api.contacts.clearMessages(selected);
      loadList();
      loadDetail();
    } catch (e) {
      alert('清空失败：' + e.message);
    }
  }

  async function deleteContact() {
    if (!selected) return;
    if (!confirm('确定删除联系人「' + selected + '」？其档案和全部聊天记录都会被删除，且不可恢复。')) return;
    try {
      await api.contacts.remove(selected);
      selected = '';
      loadList();
      loadDetail();
    } catch (e) {
      alert('删除失败：' + e.message);
    }
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
