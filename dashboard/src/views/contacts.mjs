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
  // 联系人排序：默认走接口原有顺序（重要联系人 + 最近消息），其余按关系概览里的指标排。
  const sortSelect = el('select', { class: 'select contact-sort', 'aria-label': '联系人排序', title: '按关系指标排序', style: 'height:30px;padding:0 6px;font-size:12px;min-width:0;flex:1;' },
    el('option', { value: '', text: '默认排序' }),
    el('option', { value: 'recent', text: '最近联系' }),
    el('option', { value: 'messages', text: '消息量' }),
    el('option', { value: 'initiation', text: '发起比例' }),
    el('option', { value: 'latency', text: '回复延迟' })
  );
  const sortRow = el('label', { class: 'contact-sort-row', title: '切换排序会先拉取联系人的关系概览', style: 'display:flex;align-items:center;gap:8px;margin-top:10px;font-size:12px;color:#858b94;' },
    el('span', { text: '排序' }), sortSelect);
  const list = el('div', { class: 'wechat-contact-list' });
  const sidebar = el('aside', { class: 'wechat-sidebar' }, el('div', { class: 'wechat-search-wrap' }, search, sortRow), list);
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
  let profileCollapsed = false;
  let summaryCollapsed = false;
  let contacts = [];
  let stopMemory = () => {};
  let chatVersion = 0;
  let listVersion = 0;
  let activeContact = null;
  let loadedMessages = [];
  let moreButton = null;
  let visible = true;
  let syncProfileToggle = () => {};
  let sortKey = '';
  let relationshipCollapsed = false;
  // 关系概览按联系人缓存：切换排序要读所有联系人的指标，不能每次点击都重新统计。
  const relationshipCache = new Map();

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

  // 排序要用到的指标来自关系概览接口；只为还没缓存过的联系人补请求，
  // 并发压到 4 个，联系人很多时不至于一次性打满本地服务。
  async function ensureRelationships() {
    const queue = contacts.filter((contact) => contact?.name && !relationshipCache.has(contact.name));
    if (!queue.length) return;
    const worker = async () => {
      while (queue.length) {
        const contact = queue.shift();
        try { relationshipCache.set(contact.name, await api.contacts.relationship(contact.name)); }
        catch { relationshipCache.set(contact.name, null); }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker));
  }

  function relationshipSortValue(key, contact) {
    const data = relationshipCache.get(contact.name);
    if (!data) return null;
    if (key === 'recent') {
      const time = Date.parse(String(data.recent?.lastMessageAt || '').replace(/ (\d):/, ' 0$1:'));
      return Number.isFinite(time) ? time : null;
    }
    if (key === 'messages') return Number(data.recent?.messages ?? 0);
    if (key === 'initiation') {
      const share = data.metrics?.initiation?.ownerShare;
      return typeof share === 'number' && Number.isFinite(share) ? share : null;
    }
    if (key === 'latency') {
      const median = data.metrics?.replyLatency?.contact?.medianMs;
      return typeof median === 'number' && Number.isFinite(median) ? median : null;
    }
    return null;
  }

  // 没有指标的联系人统一排到最后，不去猜它该在第几；默认排序完全保持接口顺序。
  function sortedForList(items) {
    if (!sortKey) return items;
    const direction = sortKey === 'latency' ? 1 : -1;
    return items.slice().sort((left, right) => {
      const a = relationshipSortValue(sortKey, left);
      const b = relationshipSortValue(sortKey, right);
      if (a === null && b === null) return 0;
      if (a === null) return 1;
      if (b === null) return -1;
      return (a - b) * direction;
    });
  }

  async function loadList() {
    const version = ++listVersion;
    let result;
    try { result = await api.contacts.list(); } catch { result = []; }
    if (version !== listVersion || !visible) return;
    contacts = result;
    if (sortKey) {
      await ensureRelationships();
      if (version !== listVersion || !visible) return;
    }
    const q = search.value.trim();
    const matched = new Set();
    if (q) { try { (await api.search(q)).forEach((m) => matched.add(m.contact)); } catch {} }
    if (version !== listVersion || !visible) return;
    empty(list);
    const filtered = contacts.filter((c) => !q || c.name.toLowerCase().includes(q.toLowerCase()) || String(c.remark || '').toLowerCase().includes(q.toLowerCase()) || matched.has(c.name));
    if (!filtered.length) { list.append(el('div', { class: 'wechat-empty', text: q ? '没有找到相关聊天' : '暂无联系人' })); return; }
    sortedForList(filtered).forEach((c) => {
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

  function relationshipPercent(value) {
    return typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 100) + '%' : '—';
  }

  function relationshipLatency(stats) {
    const median = stats?.medianMs;
    if (typeof median !== 'number' || !Number.isFinite(median)) return '—';
    if (median < 60000) return Math.round(median / 1000) + ' 秒';
    if (median < 3600000) return Math.round(median / 60000) + ' 分钟';
    if (median < 86400000) return (median / 3600000).toFixed(1) + ' 小时';
    return (median / 86400000).toFixed(1) + ' 天';
  }

  function relationshipRecentText(recent) {
    const lastMessageAt = String(recent?.lastMessageAt || '');
    if (!lastMessageAt) return '暂无聊天记录';
    const days = Number(recent?.daysSinceLast);
    const relative = Number.isFinite(days) ? (days <= 0 ? '今天' : days + ' 天前') : '';
    return fmtTime(lastMessageAt) + (relative ? `（${relative}）` : '');
  }

  function factRow(label, value) {
    return el('div', {}, el('dt', { text: label }), el('dd', { text: value }));
  }

  // 「关系概览」：互动指标（只描述消息怎么流动）+ 用户自己写的社交目的/阶段/备忘。
  // 这里不给关系结论，也不做话术建议；阶段与备忘可编辑，保存走联系人画像接口。
  function relationshipPanel(contact) {
    const facts = el('div', { class: 'contact-profile-facts contact-relationship-facts' });
    const maintenance = el('div', { class: 'contact-profile-facts contact-relationship-maintenance' });
    const state = el('div', { class: 'hint contact-relationship-state', role: 'status', 'aria-live': 'polite', style: 'min-height:12px;margin-top:6px;font-size:11px;color:#929aa3;' });
    const stageInput = el('input', { class: 'input contact-relationship-stage', 'aria-label': '阶段', placeholder: '例如：同事、老同学、刚认识' });
    const notesArea = el('textarea', { class: 'input contact-relationship-notes', rows: 3, 'aria-label': '备忘', placeholder: '值得记住的小事：约好的事、忌讳、下次聊什么' });
    const save = el('button', { class: 'btn btn-primary btn-block contact-relationship-save', 'aria-label': '保存阶段与备忘', text: '保存' });
    const editor = el('div', { class: 'contact-relationship-editor', hidden: true },
      el('label', { class: 'wechat-profile-label', text: '阶段' }), stageInput,
      el('label', { class: 'wechat-profile-label', text: '备忘' }), notesArea,
      save, state
    );
    const status = el('span', { class: 'contact-status', text: '加载中' });
    const refresh = el('button', { class: 'contact-card-refresh', title: '重新统计关系概览', 'aria-label': '刷新关系概览' }, contactIcon('refresh'));
    const collapse = el('button', { class: 'contact-card-collapse', 'aria-label': '收起关系概览', 'aria-expanded': 'true', 'aria-controls': 'contact-relationship-body' }, contactIcon('chevron'));
    const body = el('div', { id: 'contact-relationship-body', class: 'contact-relationship-body' }, facts, maintenance, editor);
    const card = el('section', { class: 'wechat-profile-card contact-relationship-card' },
      el('div', { class: 'contact-card-head' }, el('h3', { text: '关系概览' }), el('div', { class: 'contact-card-tools' }, refresh, collapse, status)), body
    );
    function setCollapsed(value) {
      relationshipCollapsed = value;
      body.hidden = value;
      card.classList.toggle('collapsed', value);
      collapse.classList.toggle('collapsed', value);
      collapse.setAttribute('aria-expanded', String(!value));
      collapse.setAttribute('aria-label', value ? '展开关系概览' : '收起关系概览');
      collapse.setAttribute('title', value ? '展开关系概览' : '收起关系概览');
    }
    setCollapsed(!!relationshipCollapsed);
    collapse.onclick = () => setCollapsed(!relationshipCollapsed);

    function render(data) {
      const metrics = data?.metrics || null;
      const recent = data?.recent || {};
      status.textContent = data ? '已加载' : '暂不可用';
      status.className = 'contact-status' + (data ? ' complete' : ' error');
      facts.replaceChildren(
        el('h4', { text: '互动数据' }),
        el('dl', {},
          factRow('最近联系', relationshipRecentText(recent)),
          factRow('消息量', Number(recent.messages || 0) + ' 条'),
          factRow('发起比例', metrics ? `我 ${relationshipPercent(metrics.initiation?.ownerShare)} · 对方 ${relationshipPercent(metrics.initiation?.contactShare)}（${metrics.sample?.totalSessions ?? 0} 段会话）` : '—'),
          factRow('回复延迟中位数', metrics ? `对方 ${relationshipLatency(metrics.replyLatency?.contact)} · 我 ${relationshipLatency(metrics.replyLatency?.owner)}` : '—')
        ),
        el('small', { class: 'contact-relationship-note', style: 'display:block;margin-top:10px;color:#a0a6ad;font-size:10px;line-height:1.7;', text: metrics
          ? `仅统计最近 ${metrics.sample?.includedRows ?? 0} 条消息；回复延迟是相邻消息的时间间隔，不代表已读。`
          : '暂无聊天记录：录到消息后这里会自动统计。' })
      );
      maintenance.replaceChildren(
        el('h4', { text: '关系维护' }),
        el('dl', {},
          factRow('社交目的', data?.socialGoal || '未填写（在「社交目的及策略」里补）'),
          factRow('阶段', data?.stage || '未填写'),
          factRow('备忘', data?.notes || '未填写')
        )
      );
      stageInput.value = data.stage || '';
      notesArea.value = data.notes || '';
      editor.hidden = false;
    }

    async function load(force = false) {
      const cached = relationshipCache.get(contact.name);
      if (!force && cached) { render(cached); return; }
      facts.replaceChildren(el('div', { class: 'hint', text: '正在统计互动数据…' }));
      status.textContent = '加载中';
      status.className = 'contact-status';
      try {
        const data = await api.contacts.relationship(contact.name);
        relationshipCache.set(contact.name, data);
        if (selected !== contact.name) return;
        render(data);
      } catch (error) {
        if (selected !== contact.name) return;
        status.textContent = '暂不可用';
        status.className = 'contact-status error';
        facts.replaceChildren(el('div', { class: 'hint', text: '关系概览加载失败：' + error.message }));
        maintenance.replaceChildren();
        editor.hidden = true;
      }
    }

    refresh.onclick = () => load(true);
    save.onclick = async () => {
      save.disabled = true;
      state.textContent = '保存中…';
      try {
        const saved = await api.contacts.saveProfile(contact.name, { relationship: stageInput.value, notes: notesArea.value });
        const current = relationshipCache.get(contact.name) || {};
        const patch = { ...current, stage: saved?.stage ?? stageInput.value.trim(), notes: saved?.notes ?? notesArea.value.trim() };
        relationshipCache.set(contact.name, patch);
        render(patch);
        state.textContent = '已保存';
        toast('阶段与备忘已保存');
      } catch (error) {
        state.textContent = '保存失败：' + error.message;
        toast('保存失败：' + error.message, false);
      } finally { save.disabled = false; }
    };
    load();
    return card;
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
    const memory = memoryPanel(contact, { collapsed: summaryCollapsed, onCollapseChange: (value) => { summaryCollapsed = value; } });
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
    const cardBody = el('div', { id: 'contact-profile-body', class: 'contact-profile-body' }, preview, editorPanel);
    const edit = el('button', { class: 'contact-profile-edit-toggle', 'aria-label': '编辑画像', 'aria-expanded': 'false', 'aria-controls': 'contact-profile-editors' }, contactIcon('edit'), el('span', { text: '编辑' }));
    const collapse = el('button', { class: 'contact-card-collapse', 'aria-label': '收起具体画像', 'aria-expanded': 'true', 'aria-controls': 'contact-profile-body' }, contactIcon('chevron'));
    // 卡片整体可折叠：先只留标题行，点开再显示字段或编辑区
    function setCollapsed(collapsed) {
      profileCollapsed = collapsed;
      cardBody.hidden = collapsed;
      fields.classList.toggle('collapsed', collapsed);
      collapse.classList.toggle('collapsed', collapsed);
      collapse.setAttribute('aria-expanded', String(!collapsed));
      collapse.setAttribute('aria-label', collapsed ? '展开具体画像' : '收起具体画像');
      collapse.setAttribute('title', collapsed ? '展开具体画像' : '收起具体画像');
    }
    collapse.onclick = () => setCollapsed(!profileCollapsed);
    edit.onclick = () => {
      if (profileCollapsed) setCollapsed(false);
      editorPanel.hidden = !editorPanel.hidden;
      preview.hidden = !editorPanel.hidden;
      edit.setAttribute('aria-expanded', String(!editorPanel.hidden));
      setContactButton(edit, 'edit', editorPanel.hidden ? '编辑' : '收起');
      if (!editorPanel.hidden && sections[0]) sections[0].open = true;
    };
    const fields = el('section', { class: 'wechat-profile-card contact-profile-card' },
      el('div', { class: 'contact-card-head' }, el('h3', { text: '具体画像' }), el('div', { class: 'contact-card-tools' }, collapse, edit, memory.profileStatus)),
      cardBody
    );
    setCollapsed(profileCollapsed);
    if (meta.confidence !== undefined && meta.confidence !== null && Number.isFinite(Number(meta.confidence))) {
      const confidence = Math.max(0, Math.min(100, Math.round(Number(meta.confidence) * 100)));
      memory.body.append(el('div', { class: 'contact-confidence' }, el('span', { text: '画像置信度' }), el('strong', { text: confidence + '%' }), el('progress', { max: 100, value: confidence, 'aria-label': '画像置信度' })));
    }
    if (metaText) memory.body.append(el('footer', { class: 'wechat-profile-meta wechat-profile-footer', text: metaText }));
    const actions = el('div', { class: 'wechat-profile-actions' }, save, memory.rebuild, memory.analyze, memory.state);
    const danger = el('section', { class: 'contact-data-management', 'aria-label': '数据管理' },
      el('div', { class: 'contact-data-heading', text: '数据管理' }), el('div', { class: 'contact-data-actions' }, clear, remove)
    );
    const close = el('button', { class: 'wechat-close-btn', 'aria-label': '关闭联系人画像', title: '关闭联系人画像', onclick: () => { profileOpen = false; syncProfileToggle(); stopMemory(); profilePane.classList.toggle('open', false); } }, contactIcon('close'));
    profilePane.append(
      el('div', { class: 'wechat-profile-head' }, el('div', { class: 'contact-profile-heading' }, el('strong', { text: '联系人画像' }), el('span', { class: 'contact-ai-badge', text: 'AI' })), close),
      el('div', { class: 'contact-profile-identity' }, el('div', { class: 'wechat-profile-name', text: contact.remark || contact.name }), el('p', { text: contact.remark ? contact.name + ' · 基于聊天记录生成' : '基于聊天记录生成' })),
      el('label', { class: 'wechat-profile-label', for: 'contact-profile-remark', text: '备注' }), remark,
      relationshipPanel(contact), fields, memory.panel, actions, emailPanel, danger
    );
    loadContactEmails();
  }

  let searchTimer;
  sortSelect.onchange = async () => {
    sortKey = sortSelect.value;
    // 排序指标要先拿到关系概览；先取数再重排，避免列表先跳到「没数据」的顺序。
    if (sortKey) await ensureRelationships();
    if (!visible) return;
    loadList();
  };
  search.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { loadList(); if (selected) loadChat(); }, 220); });
  loadList();
  loadChat();
  return {
    show() { visible = true; loadList(); if (selected) loadChat(); },
    hide() { visible = false; chatVersion++; listVersion++; clearTimeout(searchTimer); stopMemory(); }
  };
}
