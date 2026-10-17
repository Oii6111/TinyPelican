import { api } from '../api.mjs';
import { el, empty, fmtTime } from '../ui.mjs';

const PAGE_SIZE = 10;

const TYPE_LABELS = {
  todo: '待办',
  reminder: '提醒',
  schedule: '日程'
};
const TYPE_ORDER = { todo: 0, reminder: 1, schedule: 2 };

function localDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function isoFromInput(value) {
  return value ? new Date(value).toISOString() : null;
}

export function mount(container, options = {}) {
  empty(container);
  container.className = 'view';
  let editingId = null;
  let modal = null;
  let page = 1;
  let refreshTimer = null;
  let searchTimer = null;
  let loadVersion = 0;
  let category = 'all';
  let query = '';
  let sort = 'latest';
  const selected = new Set();
  const expandedRows = new Set();
  const itemCache = new Map();

  const list = el('div', { class: 'task-table' });
  const pager = el('div', { class: 'list-pager' });
  const newBtn = el('button', { class: 'btn btn-primary', text: '＋ 新建事项' });
  const search = el('input', { class: 'task-search', placeholder: '搜索安排…', 'aria-label': '搜索安排' });
  const filters = el('div', { class: 'task-filters' });
  const batch = el('div', { class: 'task-batch', hidden: true });
  const sortSelect = el('select', { class: 'task-sort', 'aria-label': '排序方式' },
    el('option', { value: 'latest', text: '最新优先' }),
    el('option', { value: 'time', text: '时间优先' }),
    el('option', { value: 'title', text: '名称优先' })
  );
  const filterButtons = new Map();
  const filterOptions = [['all', '全部安排'], ['todo', '待办'], ['reminder', '提醒'], ['schedule', '日程'], ['open', '未完成'], ['done', '已完成']];
  for (const [value, label] of filterOptions) {
    const button = el('button', { class: 'chip' + (value === category ? ' active' : '') },
      el('span', { class: 'chip-label', text: label }),
      el('span', { class: 'chip-count', text: '0' })
    );
    filterButtons.set(value, button);
    button.onclick = () => {
      category = value;
      page = 1;
      selected.clear();
      updateBatch();
      filters.querySelectorAll('.chip').forEach((item) => item.classList.toggle('active', item === button));
      load();
    };
    filters.append(button);
  }
  search.oninput = () => {
    query = search.value.trim().toLowerCase();
    page = 1;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(load, 120);
  };
  sortSelect.onchange = () => { sort = sortSelect.value; page = 1; load(); };
  container.append(
    el('div', { class: 'board-head task-board-head' },
      el('div', {},
        el('h2', { text: '全部安排' }),
        el('div', { class: 'desc', text: '集中处理待办、提醒和日程。确认完成后，事项会保留在记录中。' })
      ),
      el('div', { class: 'task-head-actions' }, search, newBtn)
    ),
    el('div', { class: 'task-toolbar' }, filters, el('label', { class: 'task-sort-wrap' }, '排序：', sortSelect)),
    batch,
    list,
    pager
  );

  function itemKey(item) { return `${item._entity}:${item.id}`; }
  function updateBatch() {
    const count = selected.size;
    batch.hidden = count === 0;
    empty(batch);
    if (!count) return;
    const selectedItems = [...selected].map((key) => itemCache.get(key)).filter(Boolean);
    const hasCompletable = selectedItems.some((item) => item._entity === 'todo' && item.status !== 'done');
    batch.append(
      el('span', { class: 'task-batch-count', text: `已选 ${count} 项` }),
      el('button', { class: 'btn btn-confirm btn-sm', text: '批量完成', disabled: !hasCompletable, title: hasCompletable ? '' : '提醒和日程不能批量完成', onclick: bulkComplete }),
      el('button', { class: 'btn btn-danger btn-sm', text: '批量删除', onclick: bulkDelete }),
      el('button', { class: 'btn btn-ghost btn-sm', text: '清除选择', onclick: () => { selected.clear(); updateBatch(); load(); } })
    );
  }
  function selectionBox(item) {
    const checkbox = el('input', { type: 'checkbox', class: 'task-select', checked: selected.has(itemKey(item)), 'aria-label': `选择${item.title || '安排'}` });
    checkbox.onchange = () => { const key = itemKey(item); if (checkbox.checked) selected.add(key); else selected.delete(key); updateBatch(); };
    return checkbox;
  }
  function detailPanel(parts) {
    const panel = el('div', { class: 'task-expanded-detail', hidden: true });
    parts.filter(Boolean).forEach((part) => panel.append(part));
    return panel;
  }

  function rowWrap(row, panel, toggleButton, key) {
    row.setAttribute('tabindex', '0');
    row.setAttribute('aria-expanded', 'false');
    const setExpanded = (isExpanded) => {
      row.classList.toggle('is-expanded', isExpanded);
      panel.hidden = !isExpanded;
      row.setAttribute('aria-expanded', String(isExpanded));
      toggleButton.textContent = isExpanded ? '⌃' : '⋯';
      toggleButton.setAttribute('aria-label', isExpanded ? '收起详情' : '展开详情');
      if (isExpanded) expandedRows.add(key);
      else expandedRows.delete(key);
    };
    const toggle = () => setExpanded(!row.classList.contains('is-expanded'));
    setExpanded(expandedRows.has(key));
    row.onclick = (event) => {
      if (event.target.closest('button, input, select, textarea, a, .task-actions')) return;
      toggle();
    };
    row.onkeydown = (event) => {
      if ((event.key === 'Enter' || event.key === ' ') && event.target === row) {
        event.preventDefault();
        toggle();
      }
    };
    toggleButton.onclick = (event) => { event.stopPropagation(); toggle(); };
    return el('div', { class: 'task-row-wrap' }, row, panel);
  }

  function statusClass(item) {
    if (item.status === 'done' || item.status === 'completed') return 'done';
    if (item.executionStatus === 'queued' || item.executionStatus === 'running') return 'running';
    if (item.executionStatus === 'failed') return 'failed';
    return item._entity === 'schedule' ? 'scheduled' : 'open';
  }

  function buildModal(task = null, defaultDate = null) {
    editingId = task ? task.id : null;
    const title = el('input', { class: 'input', placeholder: '例如：整理实验数据' });
    const detail = el('textarea', { class: 'input', placeholder: '背景、要求或备注（可选）' });
    const executionMode = el('select', { class: 'select' },
      el('option', { value: 'manual', text: '我自己处理' }),
      el('option', { value: 'dsh', text: '可以由 AI 处理' })
    );
    const instruction = el('textarea', { class: 'input', placeholder: '告诉 AI 需要完成什么（可选）' });
    const scheduledStart = el('input', { class: 'input', type: 'datetime-local' });
    const scheduledEnd = el('input', { class: 'input', type: 'datetime-local' });
    const dueAt = el('input', { class: 'input', type: 'datetime-local' });
    const msg = el('span', { class: 'muted' });
    const saveBtn = el('button', { class: 'btn btn-primary', text: task ? '保存修改' : '创建待办' });
    const cancelBtn = el('button', { class: 'btn btn-ghost', text: '取消' });

    if (task) {
      title.value = task.title || '';
      detail.value = task.detail || '';
      executionMode.value = task.executionMode === 'dsh' ? 'dsh' : 'manual';
      instruction.value = (task.action && task.action.instruction) || '';
      scheduledStart.value = localDateTime(task.scheduledStartAt);
      scheduledEnd.value = localDateTime(task.scheduledEndAt);
      dueAt.value = localDateTime(task.dueAt);
    } else if (defaultDate) {
      const date = new Date(defaultDate);
      if (!isNaN(date.getTime())) {
        date.setHours(9, 0, 0, 0);
        scheduledStart.value = localDateTime(date.toISOString());
        date.setHours(10, 0, 0, 0);
        scheduledEnd.value = localDateTime(date.toISOString());
      }
    }

    function syncExecutionUI() {
      instruction.closest('.field').style.display = executionMode.value === 'dsh' ? '' : 'none';
    }
    executionMode.onchange = syncExecutionUI;

    function field(label, input) {
      return el('div', { class: 'field' }, el('label', { text: label }), input);
    }

    async function save() {
      const titleValue = title.value.trim();
      if (!titleValue) {
        msg.textContent = '待办标题不能为空';
        return;
      }
      const isDsh = executionMode.value === 'dsh';
      const payload = {
        type: 'todo',
        title: titleValue,
        detail: detail.value.trim(),
        executionMode: isDsh ? 'dsh' : 'manual',
        action: isDsh ? { capability: 'other', instruction: instruction.value.trim() || titleValue, inputs: {} } : null,
        scheduledStartAt: isoFromInput(scheduledStart.value),
        scheduledEndAt: isoFromInput(scheduledEnd.value),
        dueAt: isoFromInput(dueAt.value)
      };
      try {
        if (editingId) await api.tasks.update(editingId, payload);
        else await api.tasks.create(payload);
        close();
        window.dispatchEvent(new CustomEvent('tasks:changed'));
        load();
      } catch (e) {
        msg.textContent = '保存失败：' + e.message;
      }
    }

    const mask = el('div', { class: 'modal-mask' });
    mask.append(el('div', { class: 'modal' },
      el('h3', { text: task ? '编辑待办' : '新建待办' }),
      field('标题 *', title),
      field('详情', detail),
      field('处理方式', executionMode),
      field('AI 执行说明', instruction),
      field('安排开始时间（可选）', scheduledStart),
      field('安排结束时间（可选）', scheduledEnd),
      field('截止时间（可选）', dueAt),
      el('div', { class: 'hint', text: '待办可以一直不安排时间；只有设置安排时间后才会出现在日历中。' }),
      el('div', { class: 'row', style: 'justify-content:flex-end;margin-top:14px;' }, cancelBtn, saveBtn, ' ', msg)
    ));
    saveBtn.onclick = save;
    cancelBtn.onclick = close;
    mask.onclick = (e) => { if (e.target === mask) close(); };
    syncExecutionUI();
    document.body.append(mask);
    modal = mask;
  }

  function buildCreateModal(defaultDate = null) {
    close();
    const title = el('input', { class: 'input', placeholder: '例如：整理实验数据' });
    const detail = el('textarea', { class: 'input', placeholder: '背景、要求或备注（可选）' });
    const type = el('select', { class: 'select' },
      el('option', { value: 'todo', text: '待办事项' }),
      el('option', { value: 'reminder', text: '提醒' }),
      el('option', { value: 'schedule', text: '日程' })
    );
    const executionMode = el('select', { class: 'select' },
      el('option', { value: 'manual', text: '我自己处理' }),
      el('option', { value: 'dsh', text: '可以由 AI 处理' })
    );
    const instruction = el('textarea', { class: 'input', placeholder: '告诉 AI 需要完成什么（可选）' });
    const todoStart = el('input', { class: 'input', type: 'datetime-local' });
    const todoEnd = el('input', { class: 'input', type: 'datetime-local' });
    const todoDue = el('input', { class: 'input', type: 'datetime-local' });
    const reminderAt = el('input', { class: 'input', type: 'datetime-local' });
    const recurrence = el('select', { class: 'select' },
      el('option', { value: 'none', text: '一次性提醒' }),
      el('option', { value: 'workdays', text: '每个工作日' }),
      el('option', { value: 'daily', text: '每天' }),
      el('option', { value: 'custom', text: '自定义 Cron' })
    );
    const cron = el('input', { class: 'input', placeholder: '0 16 * * 1-5' });
    const scheduleStart = el('input', { class: 'input', type: 'datetime-local' });
    const scheduleEnd = el('input', { class: 'input', type: 'datetime-local' });
    const msg = el('span', { class: 'muted' });
    const saveBtn = el('button', { class: 'btn btn-primary', text: '创建事项' });
    const cancelBtn = el('button', { class: 'btn btn-ghost', text: '取消' });

    const field = (label, input) => el('div', { class: 'field' }, el('label', { text: label }), input);
    const executionField = field('处理方式', executionMode);
    const instructionField = field('AI 执行说明', instruction);
    const todoFields = el('div', {},
      executionField,
      instructionField,
      field('安排开始时间（可选）', todoStart),
      field('安排结束时间（可选）', todoEnd),
      field('截止时间（可选）', todoDue)
    );
    const reminderFields = el('div', {},
      field('提醒时间 *', reminderAt),
      field('重复方式', recurrence),
      field('Cron 表达式', cron)
    );
    const scheduleFields = el('div', {},
      field('开始时间 *', scheduleStart),
      field('结束时间（可选）', scheduleEnd)
    );

    const seed = defaultDate ? new Date(defaultDate) : new Date();
    if (!isNaN(seed.getTime())) {
      const start = new Date(seed);
      start.setHours(9, 0, 0, 0);
      const end = new Date(start);
      end.setHours(10, 0, 0, 0);
      const reminder = new Date(start);
      todoStart.value = localDateTime(start.toISOString());
      todoEnd.value = localDateTime(end.toISOString());
      reminderAt.value = localDateTime(reminder.toISOString());
      scheduleStart.value = localDateTime(start.toISOString());
      scheduleEnd.value = localDateTime(end.toISOString());
    }

    function syncTypeUI() {
      todoFields.style.display = type.value === 'todo' ? '' : 'none';
      reminderFields.style.display = type.value === 'reminder' ? '' : 'none';
      scheduleFields.style.display = type.value === 'schedule' ? '' : 'none';
      instructionField.style.display = type.value === 'todo' && executionMode.value === 'dsh' ? '' : 'none';
      cron.closest('.field').style.display = recurrence.value === 'custom' ? '' : 'none';
      saveBtn.textContent = type.value === 'todo' ? '创建待办' : type.value === 'reminder' ? '创建提醒' : '创建日程';
    }
    type.onchange = syncTypeUI;
    executionMode.onchange = syncTypeUI;
    recurrence.onchange = syncTypeUI;

    async function save() {
      const titleValue = title.value.trim();
      if (!titleValue) { msg.textContent = '标题不能为空'; return; }
      try {
        if (type.value === 'todo') {
          await api.tasks.create({
            type: 'todo',
            title: titleValue,
            detail: detail.value.trim(),
            executionMode: executionMode.value,
            action: executionMode.value === 'dsh'
              ? { capability: 'other', instruction: instruction.value.trim() || titleValue, inputs: {} }
              : null,
            scheduledStartAt: isoFromInput(todoStart.value),
            scheduledEndAt: isoFromInput(todoEnd.value),
            dueAt: isoFromInput(todoDue.value)
          });
        } else if (type.value === 'reminder') {
          if (!reminderAt.value) { msg.textContent = '提醒时间不能为空'; return; }
          const date = new Date(reminderAt.value);
          const minute = date.getMinutes();
          const hour = date.getHours();
          let kind = 'once';
          let cronValue = '';
          if (recurrence.value === 'workdays') { kind = 'cron'; cronValue = `${minute} ${hour} * * 1-5`; }
          if (recurrence.value === 'daily') { kind = 'cron'; cronValue = `${minute} ${hour} * * *`; }
          if (recurrence.value === 'custom') { kind = 'cron'; cronValue = cron.value.trim(); }
          if (kind === 'cron' && !cronValue) { msg.textContent = '请填写有效的 Cron 表达式'; return; }
          await api.tasks.create({
            type: 'reminder',
            title: titleValue,
            detail: detail.value.trim(),
            kind,
            dueAt: kind === 'once' ? isoFromInput(reminderAt.value) : null,
            cron: cronValue,
            action: null,
            executionMode: 'system'
          });
        } else {
          const startAt = isoFromInput(scheduleStart.value);
          const endAt = isoFromInput(scheduleEnd.value);
          if (!startAt) { msg.textContent = '日程开始时间不能为空'; return; }
          if (endAt && new Date(endAt) < new Date(startAt)) { msg.textContent = '结束时间不能早于开始时间'; return; }
          await api.schedules.create({ title: titleValue, detail: detail.value.trim(), startAt, endAt });
        }
        close();
        window.dispatchEvent(new CustomEvent('tasks:changed'));
        window.dispatchEvent(new CustomEvent('calendar:changed'));
        load();
      } catch (e) {
        msg.textContent = '保存失败：' + e.message;
      }
    }

    const mask = el('div', { class: 'modal-mask' });
    mask.append(el('div', { class: 'modal' },
      el('h3', { text: '新建事项' }),
      el('div', { class: 'hint', text: '先选择类型，再填写对应的时间和处理方式。' }),
      field('事项类型 *', type),
      field('标题 *', title),
      field('详情', detail),
      todoFields,
      reminderFields,
      scheduleFields,
      el('div', { class: 'hint', text: '待办可以不安排时间；提醒由系统触发；日程只展示在日历中。' }),
      el('div', { class: 'row', style: 'justify-content:flex-end;margin-top:14px;' }, cancelBtn, saveBtn, ' ', msg)
    ));
    saveBtn.onclick = save;
    cancelBtn.onclick = close;
    mask.onclick = (e) => { if (e.target === mask) close(); };
    syncTypeUI();
    document.body.append(mask);
    modal = mask;
  }

  function close() {
    if (modal && modal.parentNode) modal.parentNode.removeChild(modal);
    modal = null;
    editingId = null;
  }

  function timeText(task) {
    const parts = [];
    if (task.scheduledStartAt) parts.push('安排：' + fmtTime(task.scheduledStartAt));
    if (task.dueAt) parts.push('截止：' + fmtTime(task.dueAt));
    return parts.join(' · ') || '尚未安排时间';
  }

  function statusBadge(task) {
    if (task.status === 'done' || task.status === 'completed') return el('span', { class: 'badge success', text: '已完成' });
    if (task.executionStatus === 'queued' || task.executionStatus === 'running') return el('span', { class: 'badge info', text: '进行中' });
    if (task.executionStatus === 'failed') return el('span', { class: 'badge error', text: '执行失败' });
    return el('span', { class: 'badge warn', text: '待处理' });
  }

  function card(task) {
    const actions = el('div', { class: 'task-actions' });
    const running = task.executionStatus === 'queued' || task.executionStatus === 'running';
    if (running) {
      actions.append(el('button', { class: 'btn btn-ghost btn-sm', text: '进行中', disabled: true }));
    } else if (task.status === 'done' || task.status === 'completed') {
      actions.append(el('button', { class: 'btn btn-ghost btn-sm', text: '↩ 重开', onclick: () => reopen(task) }));
    } else if (task.executionMode === 'dsh' && task.action) {
      actions.append(el('button', { class: 'btn btn-primary btn-sm', text: '开始 AI 处理', onclick: () => start(task) }));
    } else {
      actions.append(el('button', { class: 'btn btn-confirm btn-sm', text: '完成', onclick: () => complete(task) }));
    }
    actions.append(el('button', { class: 'btn btn-edit btn-sm', text: '编辑', onclick: () => buildModal(task) }));
    actions.append(el('button', { class: 'btn btn-danger btn-sm', text: '删除', onclick: () => remove(task) }));
    const toggleButton = el('button', { class: 'task-more', type: 'button', text: '⋯', 'aria-label': '展开详情' });
    const panel = detailPanel([
      task.detail ? el('div', { class: 'task-expanded-line', text: task.detail }) : null,
      task.executionMode === 'dsh' ? el('div', { class: 'task-expanded-line', text: '可由 AI 处理' }) : null,
      task.executionError ? el('div', { class: 'task-expanded-line error-text', text: task.executionError }) : null,
      el('div', { class: 'task-expanded-actions' }, ...actions.childNodes)
    ]);
    const row = el('div', { class: 'task-row status-' + statusClass(task) },
      el('div', { class: 'task-main' },
        selectionBox(task),
        el('span', { class: 'task-type-dot todo' }),
        el('div', {},
          el('div', { class: 'task-title', text: task.title })
        )
      ),
      el('div', { class: 'task-time', text: timeText(task) }),
      el('div', { class: 'task-status' }, statusBadge(task)),
      toggleButton
    );
    return rowWrap(row, panel, toggleButton, itemKey(task));
  }

  function unifiedCard(item) {
    if (item._entity === 'todo') return card(item);
    const isReminder = item._entity === 'reminder';
    const done = item.status === 'done' || item.status === 'completed';
    const time = isReminder
      ? (item.kind === 'cron' ? `下次提醒：${fmtTime(item.nextAt)}` : `提醒时间：${fmtTime(item.dueAt)}`)
      : `开始时间：${fmtTime(item.startAt)}${item.endAt ? ` · 结束时间：${fmtTime(item.endAt)}` : ''}`;
    const actions = el('div', { class: 'task-actions' });
    if (isReminder) {
      actions.append(el('button', { class: 'btn btn-edit btn-sm', text: '编辑', onclick: () => options.onEdit && options.onEdit(item) }));
    } else if (!isReminder) {
      actions.append(el('button', { class: 'btn btn-edit btn-sm', text: '编辑', onclick: () => options.onEdit && options.onEdit(item) }));
    }
    if (done && item._entity === 'todo') actions.append(el('button', { class: 'btn btn-ghost btn-sm', text: '重开', onclick: () => reopen(item) }));
    if (isReminder && item.kind === 'cron') {
      actions.append(el('button', { class: 'btn btn-danger btn-sm', text: '删除', onclick: () => remove(item) }));
    }
    const toggleButton = el('button', { class: 'task-more', type: 'button', text: '⋯', 'aria-label': '展开详情' });
    const panel = detailPanel([
      item.detail ? el('div', { class: 'task-expanded-line', text: item.detail }) : null,
      el('div', { class: 'task-expanded-line', text: isReminder ? '由系统触发，不会调用 Agent' : '仅展示在日历，不会调用 Agent' }),
      el('div', { class: 'task-expanded-actions' }, ...actions.childNodes)
    ]);
    const row = el('div', { class: 'task-row status-' + statusClass(item) },
      el('div', { class: 'task-main' },
        selectionBox(item),
        el('span', { class: 'task-type-dot ' + (isReminder ? 'reminder' : 'schedule') }),
        el('div', {},
          el('div', { class: 'task-title' },
            el('span', { class: 'task-type-label', text: TYPE_LABELS[isReminder ? 'reminder' : 'schedule'] }),
            item.title
          )
        )
      ),
      el('div', { class: 'task-time', text: time }),
      el('div', { class: 'task-status' }, el('span', { class: 'badge ' + (done ? 'success' : isReminder ? 'warn' : 'info'), text: done ? '已完成' : isReminder && item.kind === 'cron' ? '周期提醒' : '已安排' })),
      toggleButton
    );
    return rowWrap(row, panel, toggleButton, itemKey(item));
  }

  async function bulkComplete() {
    const items = [...selected].map((key) => itemCache.get(key)).filter(Boolean);
    const todos = items.filter((item) => item._entity === 'todo' && item.status !== 'done' && item.status !== 'completed');
    try {
      await Promise.all(todos.map((item) => api.tasks.complete(item.id)));
      selected.clear();
      window.dispatchEvent(new CustomEvent('tasks:changed'));
      load();
    } catch (e) {
      alert('批量完成失败：' + e.message);
      load();
    }
  }

  async function bulkDelete() {
    const items = [...selected].map((key) => itemCache.get(key)).filter(Boolean);
    if (!items.length || !confirm(`确定删除已选的 ${items.length} 项安排？`)) return;
    try {
      await Promise.all(items.map((item) => item._entity === 'schedule' ? api.schedules.remove(item.id) : api.tasks.remove(item.id)));
      selected.clear();
      window.dispatchEvent(new CustomEvent('tasks:changed'));
      window.dispatchEvent(new CustomEvent('calendar:changed'));
      load();
    } catch (e) {
      alert('批量删除失败：' + e.message);
      load();
    }
  }

  async function load() {
    const version = ++loadVersion;
    let tasks = [];
    let schedules = [];
    try { tasks = await api.tasks.list(); } catch {}
    try { schedules = await api.schedules.list(); } catch {}
    if (version !== loadVersion) return;
    const items = [
      ...tasks.map((task) => ({ ...task, _entity: task.type === 'reminder' ? 'reminder' : 'todo' })),
      ...schedules.map((schedule) => ({ ...schedule, _entity: 'schedule' }))
    ];
    const counts = {
      all: items.filter((item) => item.status !== 'done' && item.status !== 'completed').length,
      todo: items.filter((item) => item._entity === 'todo' && item.status !== 'done' && item.status !== 'completed').length,
      reminder: items.filter((item) => item._entity === 'reminder' && item.status !== 'done' && item.status !== 'completed').length,
      schedule: items.filter((item) => item._entity === 'schedule' && item.status !== 'done' && item.status !== 'completed').length,
      open: items.filter((item) => item.status !== 'done' && item.status !== 'completed').length,
      done: items.filter((item) => item.status === 'done' || item.status === 'completed').length
    };
    for (const [value] of filterOptions) {
      const count = filterButtons.get(value)?.querySelector('.chip-count');
      if (count) count.textContent = String(counts[value] || 0);
    }
    itemCache.clear();
    items.forEach((item) => itemCache.set(itemKey(item), item));
    for (const key of selected) {
      if (!itemCache.has(key)) selected.delete(key);
    }
    for (const key of expandedRows) {
      if (!itemCache.has(key)) expandedRows.delete(key);
    }
    const filtered = items.filter((item) => {
      const isDone = item.status === 'done' || item.status === 'completed';
      const matchesCategory = category === 'done'
        ? isDone
        : !isDone && (category === 'all' || category === item._entity || category === 'open');
      const haystack = `${item.title || ''} ${item.detail || ''}`.toLowerCase();
      return matchesCategory && (!query || haystack.includes(query));
    });
    filtered.sort((a, b) => {
      if (TYPE_ORDER[a._entity] !== TYPE_ORDER[b._entity]) return TYPE_ORDER[a._entity] - TYPE_ORDER[b._entity];
      if (sort === 'title') return String(a.title || '').localeCompare(String(b.title || ''), 'zh-CN');
      if (sort === 'time') {
        const aTime = a.scheduledStartAt || a.startAt || a.dueAt || a.nextAt || a.createdAt || '';
        const bTime = b.scheduledStartAt || b.startAt || b.dueAt || b.nextAt || b.createdAt || '';
        return String(aTime).localeCompare(String(bTime));
      }
      if (a.status !== b.status) return a.status === 'done' || a.status === 'completed' ? 1 : -1;
      return String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt));
    });
    empty(list);
    if (!filtered.length) {
      list.append(el('div', { class: 'empty', text: category === 'done' ? '还没有已完成的安排' : '没有待处理的安排' }));
      empty(pager);
      updateBatch();
      return;
    }
    const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
    page = Math.min(page, totalPages);
    const start = (page - 1) * PAGE_SIZE;
    const pageItems = filtered.slice(start, start + PAGE_SIZE);
    const selectAll = el('input', { type: 'checkbox', class: 'task-select', checked: pageItems.length > 0 && pageItems.every((item) => selected.has(itemKey(item))), 'aria-label': '选择当前页全部安排' });
    selectAll.onchange = () => {
      for (const item of pageItems) {
        const key = itemKey(item);
        if (selectAll.checked) selected.add(key);
        else selected.delete(key);
      }
      updateBatch();
      load();
    };
    list.append(el('div', { class: 'task-table-head' },
      el('span', {}, selectAll, '事项'),
      el('span', { text: '时间' }),
      el('span', { text: '状态' }),
      el('span', { text: '操作' })
    ));
    let group = '';
    for (const item of pageItems) {
      if (item._entity !== group) {
        group = item._entity;
        list.append(el('div', { class: 'task-group-label', text: TYPE_LABELS[group] || '安排' }));
      }
      list.append(unifiedCard(item));
    }
    renderPager(filtered.length, totalPages);
    updateBatch();
  }

  function renderPager(total, totalPages) {
    empty(pager);
    if (total <= PAGE_SIZE) return;
    const prev = el('button', { class: 'btn btn-ghost btn-sm', text: '‹', disabled: page === 1 });
    const next = el('button', { class: 'btn btn-ghost btn-sm', text: '›', disabled: page === totalPages });
    prev.onclick = () => { page--; load(); };
    next.onclick = () => { page++; load(); };
    pager.append(prev, el('span', { class: 'list-pager-label', text: `${page} / ${totalPages} · 共 ${total} 项` }), next);
  }

  function startPolling() {
    if (!refreshTimer) refreshTimer = setInterval(load, 2000);
  }

  function stopPolling() {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = null;
  }

  async function start(task) {
    try {
      await api.tasks.start(task.id);
      window.dispatchEvent(new CustomEvent('tasks:changed'));
      load();
    } catch (e) {
      alert('启动 AI 处理失败：' + e.message);
    }
  }

  async function complete(task) {
    try {
      await api.tasks.complete(task.id);
      window.dispatchEvent(new CustomEvent('tasks:changed'));
      load();
    } catch (e) {
      alert('完成待办失败：' + e.message);
    }
  }

  async function reopen(task) {
    if (task._entity !== 'todo') return;
    try {
      await api.tasks.update(task.id, { status: 'open', executionStatus: 'not_started' });
      window.dispatchEvent(new CustomEvent('tasks:changed'));
      load();
    } catch (e) {
      alert('重新打开失败：' + e.message);
    }
  }

  async function remove(task) {
    if (!confirm('确定删除待办「' + task.title + '」？')) return;
    try {
      await api.tasks.remove(task.id);
      if (modal && editingId === task.id) close();
      window.dispatchEvent(new CustomEvent('tasks:changed'));
      load();
    } catch (e) {
      alert('删除失败：' + e.message);
    }
  }

  window.addEventListener('tasks:changed', load);
  newBtn.onclick = () => buildCreateModal();

  return {
    show() { startPolling(); load(); },
    hide() { stopPolling(); clearTimeout(searchTimer); close(); },
    openCreate(date) { buildCreateModal(date); },
    openEdit(task) { buildModal(task); }
  };
}
