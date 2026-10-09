import { api } from '../api.mjs';
import { el, empty, fmtTime, toast } from '../ui.mjs';
import { memoryPanel } from '../components/contact-memory.mjs';

const PROFILE_SECTIONS = ['基础身份', '沟通偏好', '商业价值', '生命周期', '行为意向', '风险', '社交目的及策略'];

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
  let stopMemory = () => {};

  function fieldsToText(fields) {
    return Object.entries(fields || {}).map(([key, value]) => `${key}：${value ?? ''}`).join('\n');
  }
  function parseFields(text) {
    const out = {};
    for (const line of String(text || '').split(/\r?\n/)) {
      const i = line.search(/[：:]/);
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
    stopMemory();
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
      const result = await api.contacts.messages(selected, q, 100);
      const messages = result.messages || [];
      if (!messages.length) chatLog.append(el('div', { class: 'wechat-empty', text: q ? '没有匹配的聊天记录' : '暂无聊天记录' }));
      const messageRow = (m) => {
        const outgoing = m.isOwner === true || (!('isOwner' in m) && m.name && m.name !== contact.name);
        return el('div', { class: 'wechat-msg-row ' + (outgoing ? 'outgoing' : 'incoming') },
          el('div', { class: 'wechat-msg-body' }, el('time', { text: fmtTime(m.ts) }), el('div', { class: 'wechat-bubble', text: m.content || `[${m.type || '消息'}]` }))
        );
      };
      messages.forEach((m) => chatLog.append(messageRow(m)));
      chatLog.scrollTop = chatLog.scrollHeight;
      if (result.hasMore || (result.hasArchive && !q)) {
        const more = el('button', { class: 'btn btn-block', text: '查看更多聊天记录' });
        let oldestHot = messages[0] || null;
        let hasMoreHot = !!result.hasMore;
        let archiveBefore = '';
        let archiveBeforeId = 0;
        let hasMoreArchive = !!result.hasArchive && !q;
        more.onclick = async () => {
          more.disabled = true;
          more.textContent = '加载中…';
          try {
            let older;
            if (hasMoreHot) {
              older = await api.contacts.messages(contact.name, q, 100, oldestHot.ts, oldestHot.id);
              hasMoreHot = !!older.hasMore;
              if (older.messages?.length) oldestHot = older.messages[0];
            } else {
              older = await api.contacts.archiveMessages(contact.name, archiveBefore, 100, archiveBeforeId);
              if (older.messages?.length) { archiveBefore = older.messages[0].ts; archiveBeforeId = older.messages[0].id; }
              hasMoreArchive = (older.messages || []).length === 100;
            }
            const addedRows = (older.messages || []).map(messageRow);
            more.after(...addedRows);
            addedRows.at(-1)?.scrollIntoView({ block: 'end' });
            if (!hasMoreHot && !hasMoreArchive) more.remove();
          } catch (e) { toast('历史记录加载失败：' + e.message, false); }
          finally { more.disabled = false; more.textContent = '查看更多聊天记录'; }
        };
        chatLog.prepend(more);
      }
    } catch { chatLog.append(el('div', { class: 'wechat-empty', text: '聊天记录加载失败' })); }
    renderProfile(contact);
  }

  function renderProfile(contact) {
    stopMemory();
    profilePane.replaceChildren();
    profilePane.classList.toggle('open', profileOpen);
    if (!profileOpen) { profilePane.replaceChildren(); return; }
    const remark = el('input', { class: 'input', value: contact.remark || '' });
    const profile = contact.profile || {};
    const editors = new Map();
    const sections = PROFILE_SECTIONS.map((section) => {
      const fields = section === '社交目的及策略'
        ? { '社交目的': contact.socialGoal || profile['社交目标'] || '', '互动策略': '', ...(profile[section] || {}) }
        : profile[section] || {};
      const area = el('textarea', { class: 'input wechat-profile-editor', rows: Math.max(3, Math.min(8, Object.keys(fields).length + 1)), placeholder: section === '社交目的及策略' ? '社交目的：希望建立怎样的关系\n互动策略：当前适合怎样沟通和推进' : '每行填写一个字段，如：沟通风格：直接' });
      area.value = fieldsToText(fields);
      editors.set(section, area);
      return el('details', { class: 'wechat-profile-section' }, el('summary', { text: section }), area);
    });
    const legacy = Object.fromEntries(Object.entries(profile).filter(([key]) => !PROFILE_SECTIONS.includes(key)));
    if (Object.keys(legacy).length) {
      const area = el('textarea', { class: 'input wechat-profile-editor', rows: Math.max(3, Object.keys(legacy).length + 1) });
      area.value = fieldsToText(legacy);
      editors.set('其他信息', area);
      sections.push(el('details', { class: 'wechat-profile-section' }, el('summary', { text: '其他信息' }), area));
    }
    const meta = contact.profileMeta || {};
    const metaText = [meta.updatedAt && `更新于 ${fmtTime(meta.updatedAt)}`, meta.source && `来源：${meta.source === 'full_history_analysis' ? '完整历史分析' : meta.source === 'manual' ? '手动编辑' : meta.source}`, Number.isFinite(Number(meta.confidence)) && meta.confidence !== undefined && `置信度：${Math.round(Number(meta.confidence) * 100)}%`].filter(Boolean).join(' · ');
    const save = el('button', { class: 'btn btn-primary btn-block', text: '保存画像' });
    save.onclick = async () => {
      save.disabled = true;
      save.textContent = '保存中…';
      const updatedProfile = {};
      for (const [section, area] of editors) {
        if (section === '其他信息') Object.assign(updatedProfile, parseFields(area.value));
        else updatedProfile[section] = Object.fromEntries(Object.entries(parseFields(area.value)).filter(([field, value]) => value || Object.prototype.hasOwnProperty.call(profile[section] || {}, field)));
      }
      try { await api.contacts.saveProfile(contact.name, { remark: remark.value.trim(), profile: updatedProfile, profileMode: 'replace' }); toast('画像已保存'); loadList(); loadChat(); }
      catch (e) { toast('保存失败：' + e.message, false); }
      finally { save.disabled = false; save.textContent = '保存画像'; }
    };
    const remove = el('button', { class: 'btn btn-danger btn-block', text: '删除联系人' });
    remove.onclick = async () => { if (confirm(`确定删除联系人「${contact.name}」？`)) { await api.contacts.remove(contact.name); selected = ''; profileOpen = false; loadList(); loadChat(); } };
    const clear = el('button', { class: 'btn btn-block', text: '清空聊天记录' });
    clear.onclick = async () => { if (confirm(`确定清空「${contact.name}」的聊天记录？`)) { await api.contacts.clearMessages(contact.name); toast('聊天记录已清空'); loadList(); loadChat(); } };
    const memory = memoryPanel(contact);
    stopMemory = memory.stop;
    const fields = el('details', { class: 'wechat-profile-section wechat-profile-group' }, el('summary', { text: '具体画像' }), el('div', { class: 'wechat-profile-children' }, ...sections));
    const actions = el('div', { class: 'wechat-profile-actions' }, save, memory.rebuild, memory.analyze, clear, remove, memory.state);
    profilePane.append(el('div', { class: 'wechat-profile-head' }, el('strong', { text: '联系人画像' }), el('button', { class: 'wechat-close-btn', text: '×', onclick: () => { profileOpen = false; loadChat(); } })), el('div', { class: 'wechat-profile-name', text: contact.name }), el('label', { class: 'wechat-profile-label', text: '备注' }), remark, fields, memory.panel, actions, metaText ? el('footer', { class: 'wechat-profile-meta wechat-profile-footer', text: metaText }) : null);
  }

  let searchTimer;
  search.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { loadList(); if (selected) loadChat(); }, 220); });
  loadList();
  return { show() { loadList(); if (selected) loadChat(); }, hide() { stopMemory(); } };
}
