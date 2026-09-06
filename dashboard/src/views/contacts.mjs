import { api } from '../api.mjs';
import { el, empty, fmtTime, toast } from '../ui.mjs';

const PROFILE_FIELDS = ['关系类型', '社交目标', '近况', '偏好', '重要承诺/待办', '敏感话题/注意点', '情绪趋势', '最近互动时间'];

export function mount(container) {
  empty(container);
  container.className = 'view padless';
  const search = el('input', { class: 'wechat-search', placeholder: '⌕  搜索联系人或聊天记录' });
  const list = el('div', { class: 'wechat-contact-list' });
  const sidebar = el('aside', { class: 'wechat-sidebar' }, el('div', { class: 'wechat-search-wrap' }, search), list);
  const chatHead = el('header', { class: 'wechat-chat-head' });
  const chatLog = el('div', { class: 'wechat-chat-log' });
  const composer = el('div', { class: 'wechat-composer' }, el('textarea', { class: 'wechat-compose-input', placeholder: '聊天记录为只读', disabled: true }));
  const chatMain = el('section', { class: 'wechat-chat-main' }, chatHead, chatLog, composer);
  const profilePane = el('aside', { class: 'wechat-profile-pane' });
  container.append(el('div', { class: 'wechat-contacts-layout' }, sidebar, chatMain, profilePane));

  let selected = '';
  let profileOpen = false;
  let contacts = [];

  function profileToText(profile) {
    const keys = PROFILE_FIELDS.concat(Object.keys(profile || {}).filter((k) => !PROFILE_FIELDS.includes(k)));
    return keys.map((k) => `${k}：${(profile && profile[k]) || ''}`).join('\n');
  }
  function parseProfileText(text) {
    const out = {};
    for (const line of String(text || '').split(/\r?\n/)) {
      const i = line.indexOf('：');
      if (i >= 0 && line.slice(0, i).trim()) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    return out;
  }

  async function loadList() {
    try { contacts = await api.contacts.list(); } catch { contacts = []; }
    const q = search.value.trim();
    const matched = new Set();
    if (q) { try { (await api.search(q)).forEach((m) => matched.add(m.contact)); } catch {} }
    empty(list);
    const filtered = contacts.filter((c) => !q || c.name.toLowerCase().includes(q.toLowerCase()) || String(c.remark || '').toLowerCase().includes(q.toLowerCase()) || matched.has(c.name));
    if (!filtered.length) { list.append(el('div', { class: 'wechat-empty', text: q ? '没有找到相关聊天' : '暂无联系人' })); return; }
    filtered.forEach((c) => {
      const latest = c.updatedAt ? new Date(c.updatedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '';
      const item = el('button', { class: 'wechat-contact-item' + (c.name === selected ? ' active' : '') },
        el('span', { class: 'wechat-contact-copy' }, el('strong', { text: (c.important ? '⭐ ' : '') + (c.remark || c.name) }), c.remark ? el('small', { text: c.name }) : el('small', { text: `${c.messages || 0} 条消息` })),
        el('time', { text: latest })
      );
      item.onclick = () => { selected = c.name; profileOpen = false; loadList(); loadChat(); };
      list.append(item);
    });
  }

  async function loadChat() {
    if (!selected) { chatHead.replaceChildren(el('div', { class: 'wechat-no-selection', text: '选择联系人开始查看聊天' })); chatLog.replaceChildren(); profilePane.replaceChildren(); return; }
    let contact;
    try { contact = await api.contacts.get(selected); } catch { return; }
    const q = search.value.trim();
    chatHead.replaceChildren();
    chatHead.append(el('div', { class: 'wechat-chat-title' }, el('strong', { text: contact.remark || contact.name }), contact.remark ? el('small', { text: contact.name }) : null));
    const profileBtn = el('button', { class: 'wechat-head-btn', title: '查看联系人画像', text: profileOpen ? '收起画像' : '👤 画像', onclick: () => { profileOpen = !profileOpen; loadChat(); } });
    const starBtn = el('button', { class: 'wechat-head-icon' + (contact.important ? ' on' : ''), title: '特别关心', text: contact.important ? '★' : '☆' });
    starBtn.onclick = async () => { await api.contacts.setImportant(selected, !contact.important); loadList(); loadChat(); };
    chatHead.append(el('div', { class: 'wechat-head-actions' }, starBtn, profileBtn));
    chatLog.replaceChildren();
    try {
      const result = await api.contacts.messages(selected, q, 300);
      const messages = result.messages || [];
      if (!messages.length) chatLog.append(el('div', { class: 'wechat-empty', text: q ? '没有匹配的聊天记录' : '暂无聊天记录' }));
      const visibleMessages = messages.slice(-80);
      visibleMessages.forEach((m) => {
        const outgoing = m.isOwner === true || (!('isOwner' in m) && m.name && m.name !== contact.name);
        chatLog.append(el('div', { class: 'wechat-msg-row ' + (outgoing ? 'outgoing' : 'incoming') },
          el('div', { class: 'wechat-msg-body' }, el('time', { text: fmtTime(m.ts) }), el('div', { class: 'wechat-bubble', text: m.content || `[${m.type || '消息'}]` }))
        ));
      });
      chatLog.scrollTop = chatLog.scrollHeight;
    } catch { chatLog.append(el('div', { class: 'wechat-empty', text: '聊天记录加载失败' })); }
    renderProfile(contact);
  }

  function renderProfile(contact) {
    profilePane.classList.toggle('open', profileOpen);
    if (!profileOpen) { profilePane.replaceChildren(); return; }
    const remark = el('input', { class: 'input', value: contact.remark || '' });
    const area = el('textarea', { class: 'input wechat-profile-editor', rows: 12 }); area.value = profileToText(contact.profile || {});
    const save = el('button', { class: 'btn btn-primary btn-block', text: '保存画像' });
    save.onclick = async () => { try { await api.contacts.save(contact.name, { remark: remark.value.trim(), profile: parseProfileText(area.value) }); toast('画像已保存'); loadList(); loadChat(); } catch (e) { toast('保存失败：' + e.message, false); } };
    const remove = el('button', { class: 'btn btn-danger btn-block', text: '删除联系人' });
    remove.onclick = async () => { if (confirm(`确定删除联系人「${contact.name}」？`)) { await api.contacts.remove(contact.name); selected = ''; profileOpen = false; loadList(); loadChat(); } };
    const clear = el('button', { class: 'btn btn-block', text: '清空聊天记录' });
    clear.onclick = async () => { if (confirm(`确定清空「${contact.name}」的聊天记录？`)) { await api.contacts.clearMessages(contact.name); toast('聊天记录已清空'); loadList(); loadChat(); } };
    profilePane.append(el('div', { class: 'wechat-profile-head' }, el('strong', { text: '联系人画像' }), el('button', { class: 'wechat-close-btn', text: '×', onclick: () => { profileOpen = false; loadChat(); } })), el('div', { class: 'wechat-profile-name', text: contact.name }), el('label', { class: 'wechat-profile-label', text: '备注' }), remark, el('label', { class: 'wechat-profile-label', text: '画像与社交目标' }), area, save, clear, remove);
  }

  let searchTimer;
  search.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { loadList(); if (selected) loadChat(); }, 220); });
  loadList();
  return { show() { loadList(); if (selected) loadChat(); }, hide() {} };
}
