import { api } from '../api.mjs';
import { el, empty, fmtTime } from '../ui.mjs';

const PAGE_SIZE = 10;

const TYPE_LABELS = {
  todo: '📌 待办',
  reminder: '🔔 提醒',
  schedule: '📅 日程'
};

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

  const list = el('div', { class: 'todo-list' });
  const pager = el('div', { class: 'list-pager' });
  const newBtn = el('button', { class: 'btn btn-primary', text: '＋ 新建事项' });
  container.append(
    el('div', { class: 'board-head' },
      el('div', {},
        el('h2', { text: '待办与安排' }),
        el('div', { class: 'desc', text: '这里集中展示每一条待办、提醒和日程。列表较长时可以翻页查看，点击编辑可回到对应的编辑面板。' })
      ),
      newBtn
    ),
    list,
    pager
  );

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
    if (task.status === 'done') return el('span', { class: 'badge success', text: '已完成' });
    if (task.executionStatus === 'queued' || task.executionStatus === 'running') return el('span', { class: 'badge info', text: '进行中' });
    if (task.executionStatus === 'failed') return el('span', { class: 'badge error', text: '执行失败' });
    return el('span', { class: 'badge warn', text: '待处理' });
  }

  function card(task) {
    const actions = el('div', { class: 'task-actions' });
    const running = task.executionStatus === 'queued' || task.executionStatus === 'running';
    if (running) {
      actions.append(el('button', { class: 'btn btn-ghost btn-sm', text: '进行中', disabled: true }));
    } else if (task.status === 'done') {
      actions.append(el('button', { class: 'btn btn-ghost btn-sm', text: '↩ 重开', onclick: () => reopen(task) }));
    } else if (task.executionMode === 'dsh' && task.action) {
      actions.append(el('button', { class: 'btn btn-primary btn-sm', text: '开始 AI 处理', onclick: () => start(task) }));
    } else {
      actions.append(el('button', { class: 'btn btn-confirm btn-sm', text: '完成', onclick: () => complete(task) }));
    }
    actions.append(el('button', { class: 'btn btn-edit btn-sm', text: '编辑', onclick: () => buildModal(task) }));
    actions.append(el('button', { class: 'btn btn-danger btn-sm', text: '删除', onclick: () => remove(task) }));

    return el('div', { class: 'task-card' },
      el('div', { class: 'task-card-head' },
        el('div', { class: 'task-title', text: task.title }),
        statusBadge(task)
      ),
      task.executionMode === 'dsh' ? el('div', { class: 'meta', text: '🤖 可由 AI 处理' }) : null,
      task.detail ? el('div', { class: 'meta', text: task.detail }) : null,
      el('div', { class: 'meta', text: timeText(task) }),
      task.executionError ? el('div', { class: 'meta error-text', text: task.executionError }) : null,
      actions
    );
  }

  function unifiedCard(item) {
    if (item._entity === 'todo') return card(item);
    const isReminder = item._entity === 'reminder';
    const done = item.status === 'done';
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
    return el('div', { class: 'task-card unified-item-card' },
      el('div', { class: 'task-card-head' },
        el('div', { class: 'task-title' },
          el('span', { class: 'badge info unified-type-badge', text: TYPE_LABELS[isReminder ? 'reminder' : 'schedule'] }),
          ' ', item.title
        ),
        el('span', { class: 'badge ' + (done ? 'success' : isReminder ? 'warn' : 'info'), text: done ? '已完成' : isReminder && item.kind === 'cron' ? '周期提醒' : '已安排' })
      ),
      item.detail ? el('div', { class: 'meta', text: item.detail }) : null,
      el('div', { class: 'meta', text: time }),
      isReminder ? el('div', { class: 'meta', text: '提醒由系统触发，不会调用 Agent。' }) : el('div', { class: 'meta', text: '日程仅展示在日历，不会调用 Agent。' }),
      actions
    );
  }

  async function load() {
    let tasks = [];
    let schedules = [];
    try { tasks = await api.tasks.list(); } catch {}
    try { schedules = await api.schedules.list(); } catch {}
    const items = [
      ...tasks.map((task) => ({ ...task, _entity: task.type === 'reminder' ? 'reminder' : 'todo' })),
      ...schedules.map((schedule) => ({ ...schedule, _entity: 'schedule' }))
    ];
    items.sort((a, b) => {
      if (a.status !== b.status) return a.status === 'done' || a.status === 'completed' ? 1 : -1;
      return String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt));
    });
    empty(list);
    if (!items.length) {
      list.append(el('div', { class: 'empty', text: '还没有待办、提醒或日程' }));
      empty(pager);
      return;
    }
    const totalPages = Math.ceil(items.length / PAGE_SIZE);
    page = Math.min(page, totalPages);
    const start = (page - 1) * PAGE_SIZE;
    for (const item of items.slice(start, start + PAGE_SIZE)) list.append(unifiedCard(item));
    renderPager(items.length, totalPages);
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
    hide() { stopPolling(); close(); },
    openCreate(date) { buildCreateModal(date); },
    openEdit(task) { buildModal(task); }
  };
}
