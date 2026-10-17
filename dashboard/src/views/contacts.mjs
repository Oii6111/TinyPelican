import { api } from '../api.mjs';
import { el, empty, fmtTime, toast } from '../ui.mjs';
import { memoryPanel } from '../components/contact-memory.mjs';
import { contactIcon, setContactButton } from '../components/contact-visuals.mjs';
import { renderWeixinAttachments } from '../components/weixin-media.mjs';

const PROFILE_SECTIONS = ['基础身份', '沟通偏好', '商业价值', '生命周期', '行为意向', '风险', '社交目的及策略'];

export function mount(container) {
  empty(container);
  container.className = 'view padless';
  const search = el('input', { class: 'wechat-search', placeholder: '⌕  搜索联系人或聊天记录' });
  const list = el('div', { class: 'wechat-contact-list' });
  const sidebar = el('aside', { class: 'wechat-sidebar' }, el('div', { class: 'wechat-search-wrap' }, search), list);
  const chatHead = el('header', { class: 'wechat-chat-head' });
  const chatLog = el('div', { class: 'wechat-chat-log' });
  const dateFilter = el('select', { class: 'contact-date-filter', 'aria-label': '按日期筛选已加载聊天记录', title: '筛选当前已加载的聊天记录' }, el('option', { value: '', text: '全部日期' }));
  const loadedCount = el('span', { class: 'contact-loaded-count' });
  const toolbar = el('div', { class: 'contact-chat-toolbar', hidden: true },
    el('strong', {}, contactIcon('chat'), el('span', { text: '聊天记录' }), loadedCount),
    el('label', { class: 'contact-date-control' }, contactIcon('calendar'), dateFilter)
  );
  const exportButton = el('button', { class: 'contact-export-button', disabled: true, title: '导出当前已加载并筛选的聊天记录' }, contactIcon('export'), el('span', { text: '导出记录' }));
  const composer = el('div', { class: 'wechat-composer contact-readonly-footer' },
    el('div', { class: 'contact-readonly-bar' }, el('span', {}, contactIcon('lock'), el('span', { text: '聊天记录仅供查看' })), exportButton)
  );
  const chatMain = el('section', { class: 'wechat-chat-main', 'aria-label': '联系人聊天记录' }, chatHead, toolbar, chatLog, composer);
  const profilePane = el('aside', { class: 'wechat-profile-pane', 'aria-label': '联系人画像' });
  container.append(el('div', { class: 'wechat-contacts-layout contact-workspace' }, sidebar, chatMain, profilePane));

  let selected = '';
  let profileOpen = false;
  let contacts = [];
  let stopMemory = () => {};
  let chatVersion = 0;
  let listVersion = 0;
  let activeContact = null;
  let loadedMessages = [];
  let moreButton = null;
  let visible = true;
  let syncProfileToggle = () => {};

  function messageDate(message) {
    const date = new Date(message.ts);
    if (Number.isNaN(date.getTime())) return '';
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }

  function isOutgoing(message) {
    return message.isOwner === true || (!('isOwner' in message) && message.name && message.name !== activeContact?.name);
  }

  function filteredMessages() {
    return loadedMessages.filter((message) => !dateFilter.value || messageDate(message) === dateFilter.value);
  }

  function renderMessages() {
    const selectedDate = dateFilter.value;
    const dates = [...new Set(loadedMessages.map(messageDate).filter(Boolean))].sort().reverse();
    dateFilter.replaceChildren(el('option', { value: '', text: '全部日期' }), ...dates.map((date) => el('option', { value: date, text: date.replaceAll('-', '/') })));
    dateFilter.value = dates.includes(selectedDate) ? selectedDate : '';
    dateFilter.disabled = !dates.length;
    chatLog.replaceChildren();
    if (moreButton) chatLog.append(moreButton);
    const messages = filteredMessages();
    loadedCount.textContent = dateFilter.value ? `${messages.length} / ${loadedMessages.length} 条` : `已加载 ${loadedMessages.length} 条`;
    exportButton.disabled = !messages.length;
    if (!messages.length) chatLog.append(el('div', { class: 'wechat-empty', text: search.value.trim() ? '没有匹配的聊天记录' : '暂无聊天记录' }));
    let previous = null;
    for (const message of messages) {
      const day = messageDate(message);
      const sameDay = previous && day === messageDate(previous);
      const outgoing = isOutgoing(message);
      const sameSender = previous && outgoing === isOutgoing(previous) && (message.name || message.sender) === (previous.name || previous.sender);
      if (day && !sameDay) chatLog.append(el('div', { class: 'contact-date-divider' }, el('time', { datetime: day, text: new Date(message.ts).toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' }) })));
      const showTime = !sameDay || !sameSender || Math.abs(new Date(message.ts) - new Date(previous.ts)) >= 300000;
      const bubble = el('div', { class: 'wechat-bubble' });
      if (Array.isArray(message.attachments) && message.attachments.length) {
        if (message.content) bubble.append(el('div', { text: message.content }));
        bubble.append(renderWeixinAttachments(message.attachments));
      } else if (['image', '图片'].includes(message.type) || /^\[(图片|image)\]$/i.test(message.content || '')) {
        bubble.className += ' contact-image-placeholder';
        bubble.append(contactIcon('image'), el('span', {}, el('strong', { text: '图片' }), el('small', { text: '原图暂不可用' })));
      } else bubble.textContent = message.content || `[${message.type || '消息'}]`;
      const timestamp = new Date(message.ts);
      const body = el('div', { class: 'wechat-msg-body' },
        showTime && message.ts ? el('time', { datetime: message.ts, title: fmtTime(message.ts), text: Number.isNaN(timestamp.getTime()) ? String(message.ts) : timestamp.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }) }) : null,
        bubble
      );
      chatLog.append(el('div', { class: `wechat-msg-row ${outgoing ? 'outgoing' : 'incoming'}${sameDay && sameSender && !showTime ? ' continued' : ''}` }, body));
      previous = message;
    }
  }

  dateFilter.onchange = () => { renderMessages(); chatLog.scrollTop = 0; };
  exportButton.onclick = () => {
    if (!activeContact) return;
    const content = filteredMessages().map((message) => `${fmtTime(message.ts)} ${message.name || message.sender || (isOutgoing(message) ? '我' : activeContact.name)}\n${message.content || `[${message.type || '消息'}]`}`).join('\n\n');
    const url = URL.createObjectURL(new Blob(['\uFEFF' + content], { type: 'text/plain;charset=utf-8' }));
    const link = el('a', { href: url, download: `${activeContact.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')}-聊天记录.txt` });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast(`已导出当前加载的 ${filteredMessages().length} 条记录`);
  };

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
    const version = ++listVersion;
    let result;
    try { result = await api.contacts.list(); } catch { result = []; }
    if (version !== listVersion || !visible) return;
    contacts = result;
    const q = search.value.trim();
    const matched = new Set();
    if (q) { try { (await api.search(q)).forEach((m) => matched.add(m.contact)); } catch {} }
    if (version !== listVersion || !visible) return;
    empty(list);
    const filtered = contacts.filter((c) => !q || c.name.toLowerCase().includes(q.toLowerCase()) || String(c.remark || '').toLowerCase().includes(q.toLowerCase()) || matched.has(c.name));
    if (!filtered.length) { list.append(el('div', { class: 'wechat-empty', text: q ? '没有找到相关聊天' : '暂无联系人' })); return; }
    filtered.forEach((c) => {
      const latest = c.updatedAt ? new Date(c.updatedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '';
      const item = el('button', { class: 'wechat-contact-item' + (c.name === selected ? ' active' : '') },
        el('span', { class: 'wechat-contact-copy' }, el('strong', { text: (c.important ? '★ ' : '') + (c.remark || c.name) }), c.remark ? el('small', { text: c.name }) : el('small', { text: `${c.messages || 0} 条消息` })),
        el('time', { text: latest })
      );
      item.onclick = () => { selected = c.name; loadList(); loadChat(); };
      list.append(item);
    });
  }

  async function loadChat() {
    const version = ++chatVersion;
    stopMemory();
    loadedMessages = [];
    moreButton = null;
    activeContact = null;
    toolbar.hidden = !selected;
    exportButton.disabled = true;
    dateFilter.value = '';
    dateFilter.disabled = true;
    loadedCount.textContent = '';
    profilePane.classList.toggle('open', false);
    profilePane.replaceChildren();
    chatLog.replaceChildren(el('div', { class: 'wechat-empty', text: selected ? '正在加载聊天记录…' : '选择联系人，查看聊天记录与画像' }));
    if (!selected) { chatHead.replaceChildren(el('div', { class: 'contact-no-selection', text: '联系人聊天记录' })); return; }
    chatHead.replaceChildren(el('div', { class: 'contact-no-selection', text: '正在加载联系人…' }));
    let contact;
    try { contact = await api.contacts.get(selected); }
    catch { if (version === chatVersion && visible) chatLog.replaceChildren(el('div', { class: 'wechat-empty', text: '联系人加载失败，请重新选择' })); return; }
    if (version !== chatVersion || !visible) return;
    activeContact = contact;
    const q = search.value.trim();
    chatHead.replaceChildren();
    chatHead.append(el('div', { class: 'contact-chat-identity' }, el('div', { class: 'wechat-chat-title' },
      el('strong', { text: contact.remark || contact.name, title: contact.name }), el('small', { text: `${contact.messages || 0} 条消息 · 微信聊天记录` })
    )));
    const profileBtn = el('button', { class: 'wechat-head-btn', title: '查看联系人画像', 'aria-label': '联系人画像', 'aria-expanded': String(profileOpen) }, contactIcon('profile'), el('span', { text: '画像' }));
    syncProfileToggle = () => { profileBtn.classList.toggle('on', profileOpen); profileBtn.setAttribute('aria-expanded', String(profileOpen)); };
    profileBtn.onclick = () => { profileOpen = !profileOpen; syncProfileToggle(); renderProfile(contact); };
    const starBtn = el('button', { class: 'wechat-head-icon' + (contact.important ? ' on' : ''), title: '特别关心', 'aria-label': '特别关心', 'aria-pressed': String(!!contact.important) }, contactIcon('star'));
    starBtn.onclick = async () => {
      starBtn.disabled = true;
      try {
        await api.contacts.setImportant(contact.name, !contact.important);
        contact.important = !contact.important;
        starBtn.classList.toggle('on', contact.important);
        starBtn.setAttribute('aria-pressed', String(contact.important));
        loadList();
      } catch (error) { toast('设置失败：' + error.message, false); }
      finally { starBtn.disabled = false; }
    };
    const searchButton = el('button', { class: 'wechat-head-icon', title: '搜索聊天记录', 'aria-label': '搜索聊天记录', onclick: () => search.focus() }, contactIcon('search'));
    chatHead.append(el('div', { class: 'wechat-head-actions' }, starBtn, searchButton, profileBtn));
    syncProfileToggle();
    renderProfile(contact);
    chatLog.replaceChildren();
    try {
      const result = await api.contacts.messages(contact.name, q, 100);
      if (version !== chatVersion || !visible) return;
      const messages = result.messages || [];
      loadedMessages = messages;
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
            if (version !== chatVersion || !visible) return;
            const oldHeight = chatLog.scrollHeight;
            const oldTop = chatLog.scrollTop;
            loadedMessages = [...(older.messages || []), ...loadedMessages];
            if (!hasMoreHot && !hasMoreArchive) moreButton = null;
            renderMessages();
            chatLog.scrollTop = oldTop + chatLog.scrollHeight - oldHeight;
          } catch (e) { toast('历史记录加载失败：' + e.message, false); }
          finally { more.disabled = false; more.textContent = '查看更多聊天记录'; }
        };
        moreButton = more;
      }
      renderMessages();
      chatLog.scrollTop = chatLog.scrollHeight;
    } catch { if (version === chatVersion && visible) chatLog.replaceChildren(el('div', { class: 'wechat-empty', text: '聊天记录加载失败，请重新选择联系人重试' })); }
  }

  function renderProfile(contact) {
    stopMemory();
    profilePane.replaceChildren();
    profilePane.classList.toggle('open', profileOpen);
    if (!profileOpen) { profilePane.replaceChildren(); return; }
    const remark = el('input', { id: 'contact-profile-remark', class: 'input', value: contact.remark || '', placeholder: '添加备注，方便下次找到' });
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
    const metaText = [meta.updatedAt && `更新时间 ${fmtTime(meta.updatedAt)}`, meta.source && `来源：${meta.source === 'full_history_analysis' ? '完整历史分析' : meta.source === 'manual' ? '手动编辑' : meta.source}`].filter(Boolean).join(' · ');
    const save = el('button', { class: 'btn btn-primary btn-block', 'aria-label': '保存画像' });
    setContactButton(save, 'save', '保存画像');
    save.onclick = async () => {
      save.disabled = true;
      setContactButton(save, 'save', '保存中…');
      const updatedProfile = {};
      for (const [section, area] of editors) {
        if (section === '其他信息') Object.assign(updatedProfile, parseFields(area.value));
        else updatedProfile[section] = Object.fromEntries(Object.entries(parseFields(area.value)).filter(([field, value]) => value || Object.prototype.hasOwnProperty.call(profile[section] || {}, field)));
      }
      try { await api.contacts.saveProfile(contact.name, { remark: remark.value.trim(), profile: updatedProfile, profileMode: 'replace' }); toast('画像已保存'); loadList(); if (selected === contact.name) loadChat(); }
      catch (e) { toast('保存失败：' + e.message, false); }
      finally { save.disabled = false; setContactButton(save, 'save', '保存画像'); }
    };
    const remove = el('button', { class: 'btn btn-danger btn-block', text: '删除联系人' });
    setContactButton(remove, 'trash', '删除联系人');
    remove.onclick = async () => {
      if (!confirm(`确定删除联系人「${contact.name}」？`)) return;
      remove.disabled = true;
      try {
        await api.contacts.remove(contact.name);
        if (selected === contact.name) { selected = ''; profileOpen = false; loadChat(); }
        loadList();
      } catch (error) { toast('删除失败：' + error.message, false); }
      finally { remove.disabled = false; }
    };
    const clear = el('button', { class: 'btn btn-block', text: '清空聊天记录' });
    setContactButton(clear, 'trash', '清空聊天记录');
    clear.onclick = async () => {
      if (!confirm(`确定清空「${contact.name}」的聊天记录？`)) return;
      clear.disabled = true;
      try { await api.contacts.clearMessages(contact.name); toast('聊天记录已清空'); loadList(); if (selected === contact.name) loadChat(); }
      catch (error) { toast('清空失败：' + error.message, false); }
      finally { clear.disabled = false; }
    };
    const emailList = el('div', { class: 'contact-email-list' });
    const emailInput = el('input', { class: 'input', type: 'email', placeholder: 'contact@example.com' });
    const emailAdd = el('button', { class: 'btn btn-ghost btn-sm', text: '添加邮箱' });
    const emailPanel = el('details', { class: 'wechat-profile-section contact-email-panel' },
      el('summary', { text: '邮箱关联' }),
      el('div', { class: 'hint', text: '仅精确匹配邮箱地址。一个地址对应多个联系人时需要手动选择。' }),
      emailList,
      el('div', { class: 'row' }, emailInput, emailAdd)
    );
    async function loadContactEmails() {
      empty(emailList);
      try {
        const result = await api.contacts.emails(contact.name);
        const emails = Array.isArray(result) ? result : (result?.emails || result?.items || []);
        if (!emails.length) { emailList.append(el('div', { class: 'empty', text: '暂无已关联邮箱。' })); return; }
        emails.forEach((item) => {
          const address = typeof item === 'string' ? item : (item.address || item.email || '');
          if (!address) return;
          const removeLink = el('button', { class: 'btn btn-danger btn-sm', text: '解除' });
          removeLink.onclick = async () => {
            removeLink.disabled = true;
            try { await api.contacts.unlinkEmail(contact.name, address); await loadContactEmails(); }
            catch (error) { toast('解除邮箱失败：' + error.message, false); removeLink.disabled = false; }
          };
          emailList.append(el('div', { class: 'row', style: 'align-items:center;justify-content:space-between;' }, el('span', { text: address }), removeLink));
        });
      } catch (error) {
        emailList.append(el('div', { class: 'empty', text: '邮箱关联不可用：' + error.message }));
      }
    }
    emailAdd.onclick = async () => {
      const address = emailInput.value.trim();
      if (!address) return;
      emailAdd.disabled = true;
      try { await api.contacts.linkEmail(contact.name, address); emailInput.value = ''; await loadContactEmails(); }
      catch (error) { toast('关联邮箱失败：' + error.message, false); }
      finally { emailAdd.disabled = false; }
    };
    const memory = memoryPanel(contact);
    stopMemory = memory.stop;
    const preview = el('div', { class: 'contact-profile-preview' });
    for (const [section, area] of editors) {
      const values = Object.entries(parseFields(area.value)).filter(([, value]) => value);
      if (!values.length) continue;
      preview.append(el('div', { class: 'contact-profile-facts' }, el('h4', { text: section }),
        el('dl', {}, ...values.map(([field, value]) => el('div', {}, el('dt', { text: field }), el('dd', { text: value }))))
      ));
    }
    if (!preview.children.length) preview.append(memory.profileEmpty);
    const editorPanel = el('div', { id: 'contact-profile-editors', class: 'wechat-profile-children', hidden: true }, ...sections);
    const edit = el('button', { class: 'contact-profile-edit-toggle', 'aria-label': '编辑画像', 'aria-expanded': 'false', 'aria-controls': 'contact-profile-editors' }, contactIcon('edit'), el('span', { text: '编辑' }));
    edit.onclick = () => {
      editorPanel.hidden = !editorPanel.hidden;
      preview.hidden = !editorPanel.hidden;
      edit.setAttribute('aria-expanded', String(!editorPanel.hidden));
      setContactButton(edit, 'edit', editorPanel.hidden ? '编辑' : '收起');
      if (!editorPanel.hidden && sections[0]) sections[0].open = true;
    };
    const fields = el('section', { class: 'wechat-profile-card contact-profile-card' },
      el('div', { class: 'contact-card-head' }, el('h3', { text: '具体画像' }), el('div', { class: 'contact-card-tools' }, edit, memory.profileStatus)),
      preview, editorPanel
    );
    if (meta.confidence !== undefined && meta.confidence !== null && Number.isFinite(Number(meta.confidence))) {
      const confidence = Math.max(0, Math.min(100, Math.round(Number(meta.confidence) * 100)));
      memory.panel.append(el('div', { class: 'contact-confidence' }, el('span', { text: '画像置信度' }), el('strong', { text: confidence + '%' }), el('progress', { max: 100, value: confidence, 'aria-label': '画像置信度' })));
    }
    if (metaText) memory.panel.append(el('footer', { class: 'wechat-profile-meta wechat-profile-footer', text: metaText }));
    const actions = el('div', { class: 'wechat-profile-actions' }, save, memory.rebuild, memory.analyze, memory.state);
    const danger = el('section', { class: 'contact-data-management', 'aria-label': '数据管理' },
      el('div', { class: 'contact-data-heading', text: '数据管理' }), el('div', { class: 'contact-data-actions' }, clear, remove)
    );
    const close = el('button', { class: 'wechat-close-btn', 'aria-label': '关闭联系人画像', title: '关闭联系人画像', onclick: () => { profileOpen = false; syncProfileToggle(); stopMemory(); profilePane.classList.toggle('open', false); } }, contactIcon('close'));
    profilePane.append(
      el('div', { class: 'wechat-profile-head' }, el('div', { class: 'contact-profile-heading' }, el('strong', { text: '联系人画像' }), el('span', { class: 'contact-ai-badge', text: 'AI' })), close),
      el('div', { class: 'contact-profile-identity' }, el('div', { class: 'wechat-profile-name', text: contact.remark || contact.name }), el('p', { text: contact.remark ? contact.name + ' · 基于聊天记录生成' : '基于聊天记录生成' })),
      el('label', { class: 'wechat-profile-label', for: 'contact-profile-remark', text: '备注' }), remark,
      fields, memory.panel, actions, emailPanel, danger
    );
    loadContactEmails();
  }

  let searchTimer;
  search.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { loadList(); if (selected) loadChat(); }, 220); });
  loadList();
  loadChat();
  return {
    show() { visible = true; loadList(); if (selected) loadChat(); },
    hide() { visible = false; chatVersion++; listVersion++; clearTimeout(searchTimer); stopMemory(); }
  };
}
