import { api } from '../api.mjs';
import { el, empty, fmtTime } from '../ui.mjs';

const TYPE_MAP = { todo: '待办', task: '待办', deadline: '待办', schedule: '日程', reminder: '提醒', waiting_reply: '待办' };
const STATUS_MAP = { pending_confirm: '待确认', confirmed: '已处理', ignored: '已忽略' };
const PAGE_SIZE = 8;

// 待确认意图：AI 只负责“看懂聊天”，不自动创建任务；用户确认后才转为正式任务。
export function mount(container) {
  empty(container);
  container.className = 'view';
  let filter = 'pending_confirm';
  let page = 1;
  let modal = null;
  let query = '';
  let sort = 'latest';
  let searchTimer = null;
  let loadVersion = 0;
  const selected = new Set();
  const itemCache = new Map();

  const list = el('div', { class: 'pending-table' });
  const pager = el('div', { class: 'list-pager' });
  const chips = el('div', { class: 'task-filters pending-filters' });
  const search = el('input', { class: 'task-search pending-search', placeholder: '搜索待确认意图…', 'aria-label': '搜索待确认意图' });
  const sortSelect = el('select', { class: 'pending-sort', 'aria-label': '排序方式' },
    el('option', { value: 'latest', text: '最新优先' }),
    el('option', { value: 'confidence', text: '置信度优先' }),
    el('option', { value: 'oldest', text: '最早优先' })
  );
  const batch = el('div', { class: 'pending-batch', hidden: true });
  const filterButtons = new Map();
  for (const [val, label] of [['pending_confirm', '待确认'], ['confirmed', '已确认'], ['', '全部']]) {
    const chip = el('button', { class: 'chip' + (val === filter ? ' active' : '') },
      el('span', { class: 'chip-label', text: label }), el('span', { class: 'chip-count', text: '0' }));
    filterButtons.set(val, chip);
    chip.onclick = () => {
      filter = val;
      page = 1;
      selected.clear();
      updateBatch();
      chips.querySelectorAll('.chip').forEach((x) => x.classList.remove('active'));
      chip.classList.add('active');
      load();
    };
    chips.append(chip);
  }
  search.oninput = () => {
    query = search.value.trim().toLowerCase();
    page = 1;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(load, 120);
  };
  sortSelect.onchange = () => { sort = sortSelect.value; page = 1; load(); };

  container.append(
    el('div', { class: 'board-head pending-board-head' },
      el('div', {}, el('h2', { text: '待确认意图' }), el('div', { class: 'desc', text: '从聊天中识别出的事项，确认后再加入待办、提醒或日程。' })),
      search
    ),
    el('div', { class: 'task-toolbar pending-toolbar' }, chips, el('label', { class: 'pending-sort-wrap' }, '排序：', sortSelect)),
    batch,
    list,
    pager
  );

  function itemKey(item) { return String(item.id); }

  function updateBatch() {
    empty(batch);
    batch.hidden = selected.size === 0;
    if (!selected.size) return;
    const pendingCount = [...selected]
      .map((id) => itemCache.get(id))
      .filter((item) => item && item.status === 'pending_confirm').length;
    batch.append(
      el('span', { class: 'pending-batch-count', text: `已选 ${selected.size} 项` }),
      el('button', { class: 'btn btn-confirm btn-sm', text: '批量确认', disabled: pendingCount === 0, onclick: bulkConfirm }),
      el('button', { class: 'btn btn-danger btn-sm', text: '批量忽略', onclick: bulkIgnore }),
      el('button', { class: 'btn btn-ghost btn-sm', text: '清除选择', onclick: () => { selected.clear(); updateBatch(); load(); } })
    );
  }

  function toggleRow(row, panel, toggleButton) {
    const expanded = row.classList.toggle('is-expanded');
    panel.hidden = !expanded;
    row.setAttribute('aria-expanded', String(expanded));
    toggleButton.textContent = expanded ? '⌃' : '⋯';
    toggleButton.setAttribute('aria-label', expanded ? '收起详情' : '展开详情');
  }

  async function bulkConfirm() {
    const items = [...selected].map((id) => itemCache.get(id)).filter((item) => item && item.status === 'pending_confirm');
    if (!items.length) return;
    try {
      const results = await Promise.all(items.map((item) => api.intents.confirm(item.id)));
      selected.clear();
      window.dispatchEvent(new CustomEvent('intents:changed'));
      if (results.some((result) => result.targetType === 'schedule')) window.dispatchEvent(new CustomEvent('calendar:changed'));
      window.dispatchEvent(new CustomEvent('tasks:changed'));
      load();
    } catch (e) {
      alert('批量确认失败：' + ((e && e.message) || e));
      load();
    }
  }

  async function bulkIgnore() {
    const ids = [...selected];
    if (!ids.length || !confirm(`确定忽略已选的 ${ids.length} 条意图？`)) return;
    try {
      await Promise.all(ids.map((id) => api.intents.update(id, { status: 'ignored' })));
      selected.clear();
      window.dispatchEvent(new CustomEvent('intents:changed'));
      load();
    } catch (e) {
      alert('批量忽略失败：' + ((e && e.message) || e));
      load();
    }
  }

  async function load() {
    const version = ++loadVersion;
    let items = [];
    try { items = await api.intents.list(''); } catch {}
    if (version !== loadVersion) return;
    const visible = items.filter((it) => it.status !== 'ignored');
    itemCache.clear();
    visible.forEach((item) => itemCache.set(itemKey(item), item));
    for (const id of selected) {
      if (!itemCache.has(id)) selected.delete(id);
    }
    const counts = {
      pending_confirm: visible.filter((it) => it.status === 'pending_confirm').length,
      confirmed: visible.filter((it) => it.status === 'confirmed').length,
      '': visible.length
    };
    for (const [value, button] of filterButtons) {
      const count = button.querySelector('.chip-count');
      if (count) count.textContent = String(counts[value] || 0);
    }
    const shown = visible.filter((it) => (filter === '' || it.status === filter) && (!query || `${it.summary || ''} ${it.detail || ''} ${it.contact || ''}`.toLowerCase().includes(query)));
    shown.sort((a, b) => {
      const statusOrder = { pending_confirm: 0, confirmed: 1 };
      if (filter === '') {
        const statusDiff = (statusOrder[a.status] ?? 2) - (statusOrder[b.status] ?? 2);
        if (statusDiff) return statusDiff;
      }
      if (sort === 'confidence') return (b.confidence || 0) - (a.confidence || 0) || String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
      const timeDiff = String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
      return sort === 'oldest' ? -timeDiff : timeDiff;
    });
    empty(list);
    if (!shown.length) {
      list.append(el('div', { class: 'empty', text: filter === 'confirmed' ? '还没有已确认的意图' : '没有待确认的行动 🎉' }));
      empty(pager);
      updateBatch();
      return;
    }
    const totalPages = Math.ceil(shown.length / PAGE_SIZE);
    page = Math.min(page, totalPages);
    const start = (page - 1) * PAGE_SIZE;
    const selectAll = el('input', { type: 'checkbox', class: 'pending-select', checked: shown.slice(start, start + PAGE_SIZE).every((item) => selected.has(itemKey(item))), 'aria-label': '选择当前页全部意图' });
    selectAll.onchange = () => {
      for (const item of shown.slice(start, start + PAGE_SIZE)) {
        if (selectAll.checked) selected.add(itemKey(item));
        else selected.delete(itemKey(item));
      }
      updateBatch();
      load();
    };
    list.append(el('div', { class: 'pending-table-head' },
      el('span', {}, selectAll, '事项'), el('span', { text: '置信度' }), el('span', { text: '来源' }), el('span', { text: '时间' }), el('span', { text: '操作' })
    ));
    let group = '';
    for (const it of shown.slice(start, start + PAGE_SIZE)) {
      const conf = Math.round((it.confidence || 0) * 100);
      const actions = [];
      if (it.status === 'pending_confirm') {
        actions.push(el('button', { class: 'btn btn-confirm btn-sm', text: confirmLabel(it), onclick: () => confirmIntent(it) }));
      }
      actions.push(el('button', { class: 'btn btn-danger btn-sm', text: '忽略', onclick: () => update(it.id, { status: 'ignored' }) }));
      if (it.status === 'pending_confirm') {
        actions.push(el('button', { class: 'btn btn-edit btn-sm', text: '修改', onclick: () => edit(it) }));
      }

      const detailParts = [
          it.detail ? el('div', { class: 'pending-expanded-line', text: it.detail }) : null,
          it.action && it.action.instruction ? el('div', { class: 'pending-expanded-line', text: '可由 AI 处理：' + it.action.instruction }) : null,
          it.dueText ? el('div', { class: 'pending-expanded-line', text: '时间：' + it.dueText + (it.dueAt ? ' → ' + fmtTime(it.dueAt) : '') }) : null,
          it.type === 'profile_update' ? el('div', { class: 'pending-expanded-line', text: '画像候选：' + (it.contact || '未知联系人') }) : null,
          it.type === 'profile_update' ? el('div', { class: 'pending-expanded-line' }, ...Object.entries(it.profilePatch || {}).flatMap(([section, fields]) => fields && typeof fields === 'object' ? Object.entries(fields).map(([field, value]) => el('span', { text: `${section} / ${field} → ${String(value ?? '')}` })) : [el('span', { text: `${section} → ${String(fields ?? '')}` })])) : null,
          el('div', { class: 'pending-expanded-line', text: '来自 ' + (it.contact || (it.source && it.source.contact) || '未知') + ' · ' + fmtTime(it.createdAt) + (it.reason ? ' · 理由：' + it.reason : '') }),
          it.source && it.source.channel === 'email' ? el('div', { class: 'pending-expanded-line email-intent-source' },
            `邮件：${it.source.subject || '无主题'} · ${it.source.sender || it.source.from || ''}`,
            it.source.messageId ? el('span', { class: 'muted', text: ` · ${it.source.messageId}` }) : null
          ) : null,
      ];
      const actionBar = el('div', { class: 'pending-expanded-actions' }, ...actions);
      const toggleButton = el('button', { class: 'pending-more', type: 'button', text: '⋯', 'aria-label': '展开详情' });
      const panel = el('div', { class: 'pending-expanded-detail', hidden: true }, ...detailParts.filter(Boolean), actionBar);
      const checkbox = el('input', { type: 'checkbox', class: 'pending-select', checked: selected.has(itemKey(it)), 'aria-label': `选择${it.summary || '意图'}` });
      checkbox.onchange = () => { if (checkbox.checked) selected.add(itemKey(it)); else selected.delete(itemKey(it)); updateBatch(); };
      const row = el('div', { class: 'pending-row status-' + (it.status === 'confirmed' ? 'confirmed' : 'pending') },
        el('div', { class: 'pending-main' }, checkbox, el('span', { class: 'pending-type-dot' }), el('div', {}, el('div', { class: 'pending-title', text: it.summary || '未命名事项' }), el('span', { class: 'pending-type', text: TYPE_MAP[it.type] || it.type }))),
        el('div', { class: 'pending-confidence' }, el('span', { class: 'confidence-value', text: `${conf}%` })),
        el('div', { class: 'pending-source', text: it.contact || (it.source && it.source.contact) || '未知来源' }),
        el('div', { class: 'pending-time', text: fmtTime(it.createdAt) }),
        el('div', { class: 'pending-row-actions' }, toggleButton)
      );
      const toggle = () => toggleRow(row, panel, toggleButton);
      toggleButton.onclick = (event) => { event.stopPropagation(); toggle(); };
      row.onclick = (event) => { if (event.target.closest('button, input, select, textarea, a')) return; toggle(); };
      row.onkeydown = (event) => { if ((event.key === 'Enter' || event.key === ' ') && event.target === row) { event.preventDefault(); toggle(); } };
      row.setAttribute('tabindex', '0');
      row.setAttribute('aria-expanded', 'false');
      if (it.status !== group) {
        group = it.status;
        list.append(el('div', { class: 'pending-group-label', text: STATUS_MAP[it.status] || '待处理' }));
      }
      list.append(el('div', { class: 'pending-row-wrap' }, row, panel));
    }
    renderPager(totalPages, shown.length);
    updateBatch();
  }

  function renderPager(totalPages, total) {
    empty(pager);
    if (total <= PAGE_SIZE) return;
    const prev = el('button', { class: 'btn btn-ghost btn-sm', text: '‹', disabled: page === 1 });
    const next = el('button', { class: 'btn btn-ghost btn-sm', text: '›', disabled: page === totalPages });
    prev.onclick = () => { page--; load(); };
    next.onclick = () => { page++; load(); };
    pager.append(prev, el('span', { class: 'list-pager-label', text: `${page} / ${totalPages} · 共 ${total} 项` }), next);
  }

  async function update(id, patch) {
    try {
      await api.intents.update(id, patch);
      selected.delete(String(id));
      window.dispatchEvent(new CustomEvent('intents:changed'));
    } catch (e) {
      alert('保存意图失败：' + ((e && e.message) || e));
    }
    load();
  }

  async function confirmIntent(it) {
    try {
      const result = await api.intents.confirm(it.id);
      selected.delete(itemKey(it));
      window.dispatchEvent(new CustomEvent('intents:changed'));
      window.dispatchEvent(new CustomEvent(result.targetType === 'schedule' ? 'calendar:changed' : 'tasks:changed'));
      load();
    } catch (e) {
      alert('确认失败：' + ((e && e.message) || e));
    }
  }

  async function edit(it) {
    closeModal();
    if (it.type === 'profile_update') return editProfile(it);
    const summary = el('input', { class: 'input', value: it.summary || '', placeholder: '一句话概括要做什么' });
    const detail = el('textarea', { class: 'input', placeholder: '背景、要求或执行细节（可选）' });
    detail.value = it.detail || '';
    const type = el('select', { class: 'select' },
      el('option', { value: 'todo', text: '待办事项' }),
      el('option', { value: 'reminder', text: '提醒' }),
      el('option', { value: 'schedule', text: '日程' })
    );
    type.value = ['todo', 'reminder', 'schedule'].includes(it.type) ? it.type : 'todo';
    const dueAt = el('input', { class: 'input', type: 'datetime-local' });
    if (it.dueAt) dueAt.value = localDateTime(it.dueAt);
    const dueText = el('input', { class: 'input', value: it.dueText || '', placeholder: '例如：下周五下午三点' });
    const endAt = el('input', { class: 'input', type: 'datetime-local' });
    if (it.endAt) endAt.value = localDateTime(it.endAt);
    const msg = el('span', { class: 'muted' });
    const saveBtn = el('button', { class: 'btn btn-primary', text: '保存修改' });
    const cancelBtn = el('button', { class: 'btn btn-ghost', text: '取消' });
    const field = (label, input) => el('div', { class: 'field' }, el('label', { text: label }), input);

    async function save() {
      const summaryValue = summary.value.trim();
      if (!summaryValue) {
        msg.textContent = '标题不能为空';
        return;
      }
      const patch = {
        summary: summaryValue,
        detail: detail.value.trim(),
        type: type.value,
        dueAt: dueAt.value ? new Date(dueAt.value).toISOString() : null,
        dueText: dueText.value.trim(),
        endAt: endAt.value ? new Date(endAt.value).toISOString() : null
      };
      try {
        await api.intents.update(it.id, patch);
        closeModal();
        window.dispatchEvent(new CustomEvent('intents:changed'));
        load();
      } catch (e) {
        msg.textContent = '保存失败：' + ((e && e.message) || e);
      }
    }

    const mask = el('div', { class: 'modal-mask' });
    mask.append(el('div', { class: 'modal' },
      el('h3', { text: '修改待确认意图' }),
      el('div', { class: 'hint', text: '先修改识别结果，再决定加入待办、创建提醒或加入日历；待办中的 AI 处理需要之后手动启动。' }),
      field('标题 *', summary),
      field('详情', detail),
      field('条目类型', type),
      field('具体时间', dueAt),
      field('日程结束时间（仅日程）', endAt),
      field('原始时间表达', dueText),
      el('div', { class: 'row', style: 'justify-content:flex-end;margin-top:14px;' }, cancelBtn, saveBtn, ' ', msg)
    ));
    saveBtn.onclick = save;
    cancelBtn.onclick = closeModal;
    mask.onclick = (e) => { if (e.target === mask) closeModal(); };
    document.body.append(mask);
    modal = mask;
  }

  function editProfile(it) {
    const fields = [];
    const rows = [];
    for (const [section, value] of Object.entries(it.profilePatch || {})) {
      const entries = value && typeof value === 'object' ? Object.entries(value) : [['', value]];
      for (const [name, current] of entries) {
        const include = el('input', { type: 'checkbox', checked: true });
        const input = el('textarea', { class: 'input', rows: 2 });
        input.value = String(current ?? '');
        fields.push({ section, name, include, input });
        rows.push(el('div', { class: 'field' }, el('label', {}, include, ' ' + section + (name ? ' / ' + name : '')), input));
      }
    }
    const msg = el('span', { class: 'muted' });
    const parse = () => {
      const patch = {};
      for (const { section, name, include, input } of fields) {
        if (!include.checked) continue;
        if (name) { patch[section] ||= {}; patch[section][name] = input.value.trim(); }
        else patch[section] = input.value.trim();
      }
      return patch;
    };
    const saveBtn = el('button', { class: 'btn btn-primary', text: '保存修改' });
    const cancelBtn = el('button', { class: 'btn btn-ghost', text: '取消' });
    const mask = el('div', { class: 'modal-mask' });
    mask.append(el('div', { class: 'modal' }, el('h3', { text: '修改联系人画像候选' }), el('div', { class: 'hint', text: '逐项修改内容，取消勾选可移除该项候选。保存后再确认；同板块其他手工字段会保留。' }), ...rows, el('div', { class: 'row', style: 'justify-content:flex-end;margin-top:14px;' }, cancelBtn, saveBtn, ' ', msg)));
    saveBtn.onclick = async () => { try { await api.intents.update(it.id, { profilePatch: parse() }); closeModal(); load(); } catch (e) { msg.textContent = '保存失败：' + ((e && e.message) || e); } };
    cancelBtn.onclick = closeModal;
    mask.onclick = (e) => { if (e.target === mask) closeModal(); };
    document.body.append(mask); modal = mask;
  }

  function localDateTime(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function closeModal() {
    if (modal && modal.parentNode) modal.parentNode.removeChild(modal);
    modal = null;
  }

  function confirmLabel(item) {
    if (item.type === 'profile_update') return '确认画像';
    if (item.type === 'schedule') return '加入日程';
    if (item.type === 'reminder') return '创建提醒';
    return '加入待办';
  }

  return { show: load, hide() { clearTimeout(searchTimer); closeModal(); } };
}
