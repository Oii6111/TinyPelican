import { api } from '../api.mjs';
import { el, empty, fmtTime } from '../ui.mjs';

const WEEK_LABELS = ['日', '一', '二', '三', '四', '五', '六'];
const MONTHS = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];
const TODO_PAGE_SIZE = 4;

function pad(n) { return String(n).padStart(2, '0'); }
function keyOf(year, month, day) { return `${year}-${pad(month + 1)}-${pad(day)}`; }
function keyOfDate(d) { return keyOf(d.getFullYear(), d.getMonth(), d.getDate()); }
function localDateTimeAt(date, hours, minutes) {
  const d = new Date(date);
  d.setHours(hours, minutes, 0, 0);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function localDateTime(iso) {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '' : localDateTimeAt(d, d.getHours(), d.getMinutes());
}
function isoFromInput(value) { return value ? new Date(value).toISOString() : null; }
function dateLabel(key) {
  const parts = key.split('-').map(Number);
  const date = new Date(parts[0], parts[1] - 1, parts[2]);
  return `${parts[0]}年${parts[1]}月${parts[2]}日 周${WEEK_LABELS[date.getDay()]}`;
}

export function mount(container, options = {}) {
  empty(container);
  const now = new Date();
  let viewYear = now.getFullYear();
  let viewMonth = now.getMonth();
  let selectedKey = keyOfDate(now);
  let panelTab = 'todo';
  let todoPage = 1;
  let itemMap = {};
  let todos = [];
  let reminderModal = null;
  let scheduleModal = null;

  const title = el('span', { class: 'cal-title' });
  const monthMeta = el('span', { class: 'cal-month-meta' });
  const prevBtn = el('button', { class: 'cal-nav', text: '‹' });
  const nextBtn = el('button', { class: 'cal-nav', text: '›' });
  const todayBtn = el('button', { class: 'btn btn-ghost btn-sm', text: '今天' });
  const grid = el('div', { class: 'cal-grid' });
  const sideTitle = el('strong');
  const sideMeta = el('span', { class: 'muted' });
  const sideContent = el('div', { class: 'cal-side-content' });
  const sideFooter = el('div', { class: 'cal-side-footer' });
  const todoTab = el('button', { class: 'cal-side-tab active', text: '待办' });
  const scheduleTab = el('button', { class: 'cal-side-tab', text: '日程' });
  const sidePanel = el('aside', { class: 'cal-side' },
    el('div', { class: 'cal-side-head' },
      el('div', {}, sideTitle, sideMeta),
      el('div', { class: 'cal-side-tabs' }, todoTab, scheduleTab)
    ),
    sideContent,
    sideFooter
  );
  const createItemBtn = el('button', { class: 'btn btn-primary btn-sm', text: '＋ 新建事项' });
  const calMain = el('div', { class: 'cal-main' },
    el('div', { class: 'cal-week' }, ...WEEK_LABELS.map((w) => el('span', { class: 'cal-week-cell', text: w }))),
    grid
  );
  let sideHeightObserver = null;

  container.append(el('div', { class: 'calendar-card' },
    el('div', { class: 'cal-head' },
      el('div', { class: 'cal-title-wrap' }, prevBtn, el('div', { class: 'cal-title-block' }, title, monthMeta), nextBtn, todayBtn),
      el('div', { class: 'cal-head-actions' },
        el('span', { class: 'muted cal-legend' },
          el('span', { class: 'cal-dot schedule' }), '日程',
          el('span', { class: 'cal-dot reminder' }), '提醒',
          el('span', { class: 'cal-dot todo' }), '待办'
        ),
        createItemBtn
      )
    ),
    el('div', { class: 'cal-layout' }, calMain, sidePanel)
  ));

  function monthLabel() { return `${viewYear}年${MONTHS[viewMonth]}`; }

  function syncSideHeight() {
    requestAnimationFrame(() => {
      if (window.matchMedia && window.matchMedia('(max-width: 900px)').matches) {
        sidePanel.style.height = '';
        return;
      }
      const height = Math.round(calMain.getBoundingClientRect().height);
      if (height > 0) sidePanel.style.height = `${height}px`;
    });
  }

  function observeCalendarHeight() {
    if (typeof ResizeObserver !== 'function' || sideHeightObserver) return;
    sideHeightObserver = new ResizeObserver(syncSideHeight);
    sideHeightObserver.observe(calMain);
  }

  async function loadItems() {
    let tasks = [];
    let schedules = [];
    try { tasks = await api.tasks.list(); } catch {}
    try { schedules = await api.schedules.list('open'); } catch {}
    todos = tasks.filter((task) => task.type !== 'reminder');
    const map = {};
    const add = (item, iso, entity) => {
      if (!iso) return;
      const d = new Date(iso);
      if (isNaN(d.getTime())) return;
      const key = keyOfDate(d);
      if (!map[key]) map[key] = [];
      map[key].push({ ...item, _entity: entity, _time: iso });
    };
    for (const task of tasks) {
      if (task.status !== 'open') continue;
      if (task.type === 'reminder') add(task, task.kind === 'cron' ? task.nextAt : task.dueAt, 'reminder');
      else if (task.scheduledStartAt) add(task, task.scheduledStartAt, 'todo');
    }
    for (const schedule of schedules) add(schedule, schedule.startAt, 'schedule');
    for (const key of Object.keys(map)) map[key].sort((a, b) => a._time < b._time ? -1 : a._time > b._time ? 1 : 0);
    itemMap = map;
    render();
  }

  function render() {
    title.textContent = monthLabel();
    const count = Object.keys(itemMap)
      .filter((key) => key.startsWith(`${viewYear}-${pad(viewMonth + 1)}-`))
      .reduce((sum, key) => sum + itemMap[key].length, 0);
    monthMeta.textContent = count ? `${count} 项安排` : '本月暂无安排';
    empty(grid);
    const first = new Date(viewYear, viewMonth, 1);
    const startPad = first.getDay();
    const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
    const total = Math.ceil((startPad + daysInMonth) / 7) * 7;
    const todayKey = keyOfDate(new Date());
    for (let i = 0; i < total; i++) {
      const day = i - startPad + 1;
      const dt = new Date(viewYear, viewMonth, day);
      const inMonth = day >= 1 && day <= daysInMonth;
      const key = keyOf(dt.getFullYear(), dt.getMonth(), dt.getDate());
      const items = inMonth ? (itemMap[key] || []) : [];
      const cell = el('div', {
        class: 'cal-cell' + (inMonth ? '' : ' dim') + (key === todayKey ? ' today' : '') + (key === selectedKey ? ' selected' : ''),
        role: 'gridcell',
        tabindex: inMonth ? '0' : '-1',
        'aria-selected': key === selectedKey ? 'true' : 'false',
        'aria-label': `${key}${items.length ? `，${items.length} 项安排` : ''}`
      });
      cell.onclick = () => { if (inMonth) selectDay(key); };
      cell.onkeydown = (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          if (inMonth) selectDay(key);
        }
      };
      cell.append(el('span', { class: 'cal-day-num', text: String(dt.getDate()) }));
      if (inMonth) {
        for (const item of items.slice(0, 3)) {
          const time = new Date(item._time);
          const typeClass = item._entity === 'schedule' ? 'schedule' : item._entity === 'reminder' ? 'reminder' : 'todo';
          const timeText = isNaN(time.getTime()) ? '' : `${pad(time.getHours())}:${pad(time.getMinutes())}`;
          cell.append(el('button', {
            class: 'cal-task ' + typeClass,
            title: item.title,
            'aria-label': `编辑：${item.title}`,
            type: 'button',
            onclick: (e) => {
              e.stopPropagation();
              selectDay(key);
              if (item._entity === 'schedule') openScheduleModal(item);
              else if (item._entity === 'reminder') openReminderModal(item);
              else if (typeof options.onEdit === 'function') options.onEdit(item);
            }
          },
            el('span', { class: 'cal-task-dot' }),
            el('span', { class: 'cal-task-time', text: timeText }),
            el('span', { class: 'cal-task-text', text: item.title })
          ));
        }
        if (items.length > 3) cell.append(el('div', { class: 'cal-more', text: `+${items.length - 3} 项` }));
      }
      grid.append(cell);
    }
    renderSide();
    syncSideHeight();
  }

  function renderSide() {
    todoTab.classList.toggle('active', panelTab === 'todo');
    scheduleTab.classList.toggle('active', panelTab === 'schedule');
    sideTitle.textContent = panelTab === 'todo' ? '全部待办' : dateLabel(selectedKey);
    sideMeta.textContent = panelTab === 'todo' ? `${todos.length} 项` : `${(itemMap[selectedKey] || []).length} 项安排`;
    empty(sideContent);
    sideContent.scrollTop = 0;
    empty(sideFooter);
    if (panelTab === 'todo') renderTodos();
    else renderDaySchedule();
  }

  function renderTodos() {
    const sorted = todos.slice().sort((a, b) => {
      if (a.status !== b.status) return a.status === 'done' ? 1 : -1;
      return String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt));
    });
    if (!sorted.length) {
      sideContent.append(el('div', { class: 'empty cal-detail-empty', text: '还没有待办事项。' }));
      return;
    }
    const totalPages = Math.max(1, Math.ceil(sorted.length / TODO_PAGE_SIZE));
    todoPage = Math.min(Math.max(todoPage, 1), totalPages);
    const start = (todoPage - 1) * TODO_PAGE_SIZE;
    for (const task of sorted.slice(start, start + TODO_PAGE_SIZE)) {
      const running = task.executionStatus === 'queued' || task.executionStatus === 'running';
      const card = el('div', { class: 'cal-todo-item' },
        el('div', { class: 'cal-todo-head' },
          el('span', { class: 'cal-todo-title', text: task.title }),
          el('span', { class: 'badge ' + (task.status === 'done' ? 'success' : running ? 'info' : 'warn'), text: task.status === 'done' ? '已完成' : running ? '进行中' : '待处理' })
        ),
        el('div', { class: 'meta', text: task.scheduledStartAt ? '安排：' + fmtTime(task.scheduledStartAt) : task.dueAt ? '截止：' + fmtTime(task.dueAt) : '尚未安排时间' })
      );
      const actions = el('div', { class: 'cal-todo-actions' });
      if (running) actions.append(el('button', { class: 'btn btn-ghost btn-sm', text: '进行中', disabled: true }));
      else if (task.status === 'done') actions.append(el('button', { class: 'btn btn-ghost btn-sm', text: '重开', onclick: () => updateTodo(task, { status: 'open', executionStatus: 'not_started' }) }));
      else if (task.executionMode === 'dsh' && task.action) actions.append(el('button', { class: 'btn btn-primary btn-sm', text: '开始 AI 处理', onclick: () => startTodo(task) }));
      else actions.append(el('button', { class: 'btn btn-confirm btn-sm', text: '完成', onclick: () => completeTodo(task) }));
      actions.append(el('button', { class: 'btn btn-edit btn-sm', text: '编辑', onclick: () => options.onEdit && options.onEdit(task) }));
      card.append(actions);
      sideContent.append(card);
    }
    if (totalPages > 1) {
      const prev = el('button', { class: 'btn btn-ghost btn-sm', text: '‹', disabled: todoPage === 1 });
      const next = el('button', { class: 'btn btn-ghost btn-sm', text: '›', disabled: todoPage === totalPages });
      prev.onclick = () => { todoPage--; renderSide(); };
      next.onclick = () => { todoPage++; renderSide(); };
      sideFooter.append(el('div', { class: 'cal-side-pager' },
        prev,
        el('span', { class: 'list-pager-label', text: `${todoPage} / ${totalPages} · 共 ${sorted.length} 项` }),
        next
      ));
    }
  }

  function renderDaySchedule() {
    const items = itemMap[selectedKey] || [];
    if (!items.length) {
      sideContent.append(el('div', { class: 'empty cal-detail-empty', text: '这一天还没有日程或提醒。' }));
      return;
    }
    for (const item of items) {
      const time = new Date(item._time);
      const label = item._entity === 'schedule' ? '日程' : item._entity === 'reminder' ? '提醒' : '待办';
      const badge = item._entity === 'schedule' ? 'success' : item._entity === 'reminder' ? 'warn' : 'info';
      const button = el('button', { class: 'item-card cal-detail-item', type: 'button' },
        el('span', { class: 'badge ' + badge, text: label }),
        ' ' + item.title + (isNaN(time.getTime()) ? '' : ` · ${pad(time.getHours())}:${pad(time.getMinutes())}`),
        item.detail ? el('div', { class: 'meta', text: item.detail }) : null
      );
      button.onclick = () => {
        if (item._entity === 'schedule') openScheduleModal(item);
        else if (item._entity === 'reminder') openReminderModal(item);
        else if (options.onEdit) options.onEdit(item);
      };
      sideContent.append(button);
    }
  }

  async function updateTodo(task, patch) {
    try {
      await api.tasks.update(task.id, patch);
      window.dispatchEvent(new CustomEvent('tasks:changed'));
      loadItems();
    } catch (e) { alert('更新待办失败：' + e.message); }
  }
  async function completeTodo(task) { await updateTodo(task, { status: 'done', executionStatus: 'completed' }); }
  async function startTodo(task) {
    try {
      await api.tasks.start(task.id);
      window.dispatchEvent(new CustomEvent('tasks:changed'));
      loadItems();
    } catch (e) { alert('启动 AI 处理失败：' + e.message); }
  }

  function selectDay(key) {
    selectedKey = key;
    panelTab = 'schedule';
    render();
  }
  function goPrev() { viewMonth--; if (viewMonth < 0) { viewMonth = 11; viewYear--; } selectedKey = keyOf(viewYear, viewMonth, 1); render(); }
  function goNext() { viewMonth++; if (viewMonth > 11) { viewMonth = 0; viewYear++; } selectedKey = keyOf(viewYear, viewMonth, 1); render(); }
  function goToday() { const d = new Date(); viewYear = d.getFullYear(); viewMonth = d.getMonth(); selectedKey = keyOfDate(d); render(); }

  todoTab.onclick = () => { panelTab = 'todo'; todoPage = 1; renderSide(); };
  scheduleTab.onclick = () => { panelTab = 'schedule'; renderSide(); };
  prevBtn.onclick = goPrev;
  nextBtn.onclick = goNext;
  todayBtn.onclick = goToday;
  createItemBtn.onclick = () => options.onCreate && options.onCreate(new Date(selectedKey));
  const handleWindowResize = () => syncSideHeight();
  let resizeListening = false;
  window.addEventListener('tasks:changed', loadItems);
  window.addEventListener('calendar:changed', loadItems);

  let touchX = null;
  grid.addEventListener('touchstart', (e) => { touchX = e.touches[0].clientX; }, { passive: true });
  grid.addEventListener('touchend', (e) => {
    if (touchX === null) return;
    const dx = e.changedTouches[0].clientX - touchX;
    touchX = null;
    if (Math.abs(dx) >= 40) dx > 0 ? goPrev() : goNext();
  }, { passive: true });

  function openReminderModal(reminder, defaultDate) {
    closeReminderModal();
    const titleInput = el('input', { class: 'input', placeholder: '例如：打卡签退' });
    const detailInput = el('textarea', { class: 'input', placeholder: '提醒内容（可选）' });
    const remindAt = el('input', { class: 'input', type: 'datetime-local' });
    const recurrence = el('select', { class: 'select' },
      el('option', { value: 'none', text: '一次性提醒' }),
      el('option', { value: 'workdays', text: '每个工作日' }),
      el('option', { value: 'daily', text: '每天' }),
      el('option', { value: 'custom', text: '自定义 Cron' })
    );
    const cron = el('input', { class: 'input', placeholder: '0 16 * * 1-5' });
    const msg = el('span', { class: 'muted' });
    const saveBtn = el('button', { class: 'btn btn-primary', text: reminder ? '保存修改' : '创建提醒' });
    const cancelBtn = el('button', { class: 'btn btn-ghost', text: '取消' });
    const deleteBtn = reminder ? el('button', { class: 'btn btn-danger', text: '删除提醒' }) : null;
    const field = (label, input) => el('div', { class: 'field' }, el('label', { text: label }), input);

    titleInput.value = reminder ? reminder.title || '' : '';
    detailInput.value = reminder ? reminder.detail || '' : '';
    remindAt.value = reminder ? localDateTime(reminder.kind === 'cron' ? reminder.nextAt : reminder.dueAt) : localDateTimeAt(defaultDate || new Date(), 9, 0);
    cron.value = reminder ? reminder.cron || '' : '';
    if (reminder && reminder.kind === 'cron') {
      if (reminder.cron === '0 16 * * 1-5') recurrence.value = 'workdays';
      else if (reminder.cron.endsWith(' * * *')) recurrence.value = 'daily';
      else recurrence.value = 'custom';
    }
    function syncRecurrence() {
      const custom = recurrence.value === 'custom';
      cron.closest('.field').style.display = custom ? '' : 'none';
    }
    recurrence.onchange = syncRecurrence;

    async function save() {
      const title = titleInput.value.trim();
      if (!title || !remindAt.value) { msg.textContent = '标题和提醒时间不能为空'; return; }
      const d = new Date(remindAt.value);
      const minute = d.getMinutes();
      const hour = d.getHours();
      let kind = 'once';
      let cronValue = '';
      if (recurrence.value === 'workdays') { kind = 'cron'; cronValue = `${minute} ${hour} * * 1-5`; }
      if (recurrence.value === 'daily') { kind = 'cron'; cronValue = `${minute} ${hour} * * *`; }
      if (recurrence.value === 'custom') { kind = 'cron'; cronValue = cron.value.trim(); }
      const payload = { type: 'reminder', title, detail: detailInput.value.trim(), kind, dueAt: kind === 'once' ? isoFromInput(remindAt.value) : null, cron: cronValue, action: null, executionMode: 'system' };
      try {
        if (reminder) await api.tasks.update(reminder.id, payload);
        else await api.tasks.create(payload);
        closeReminderModal();
        window.dispatchEvent(new CustomEvent('tasks:changed'));
        loadItems();
      } catch (e) { msg.textContent = '保存失败：' + e.message; }
    }
    const mask = el('div', { class: 'modal-mask' });
    mask.append(el('div', { class: 'modal' },
      el('h3', { text: reminder ? '编辑提醒' : '新建提醒' }),
      field('标题 *', titleInput),
      field('提醒时间 *', remindAt),
      field('重复方式', recurrence),
      field('Cron 表达式', cron),
      field('内容', detailInput),
      el('div', { class: 'hint', text: '提醒只负责在时间点通知你，不会调用 Agent。' }),
      el('div', { class: 'row', style: 'justify-content:flex-end;margin-top:14px;' }, deleteBtn, cancelBtn, saveBtn, ' ', msg)
    ));
    saveBtn.onclick = save;
    cancelBtn.onclick = closeReminderModal;
    if (deleteBtn) deleteBtn.onclick = async () => {
      if (!confirm('确定删除提醒「' + reminder.title + '」？')) return;
      try { await api.tasks.remove(reminder.id); closeReminderModal(); window.dispatchEvent(new CustomEvent('tasks:changed')); loadItems(); } catch (e) { msg.textContent = '删除失败：' + e.message; }
    };
    mask.onclick = (e) => { if (e.target === mask) closeReminderModal(); };
    syncRecurrence();
    document.body.append(mask);
    reminderModal = mask;
  }

  function closeReminderModal() {
    if (reminderModal && reminderModal.parentNode) reminderModal.parentNode.removeChild(reminderModal);
    reminderModal = null;
  }

  function openScheduleModal(schedule, defaultDate) {
    closeScheduleModal();
    const titleInput = el('input', { class: 'input', placeholder: '例如：产品评审会议' });
    const detailInput = el('textarea', { class: 'input', placeholder: '地点、参与人或备注（可选）' });
    const startInput = el('input', { class: 'input', type: 'datetime-local' });
    const endInput = el('input', { class: 'input', type: 'datetime-local' });
    titleInput.value = schedule ? schedule.title || '' : '';
    detailInput.value = schedule ? schedule.detail || '' : '';
    startInput.value = schedule ? localDateTime(schedule.startAt) : localDateTimeAt(defaultDate || new Date(), 9, 0);
    endInput.value = schedule && schedule.endAt ? localDateTime(schedule.endAt) : localDateTimeAt(defaultDate || new Date(), 10, 0);
    const msg = el('span', { class: 'muted' });
    const saveBtn = el('button', { class: 'btn btn-primary', text: schedule ? '保存修改' : '创建日程' });
    const cancelBtn = el('button', { class: 'btn btn-ghost', text: '取消' });
    const deleteBtn = schedule ? el('button', { class: 'btn btn-danger', text: '删除日程' }) : null;
    const field = (label, input) => el('div', { class: 'field' }, el('label', { text: label }), input);
    async function save() {
      const payload = { title: titleInput.value.trim(), detail: detailInput.value.trim(), startAt: isoFromInput(startInput.value), endAt: isoFromInput(endInput.value) };
      if (!payload.title || !payload.startAt) { msg.textContent = '标题和开始时间不能为空'; return; }
      try {
        if (schedule) await api.schedules.update(schedule.id, payload);
        else await api.schedules.create(payload);
        closeScheduleModal();
        window.dispatchEvent(new CustomEvent('calendar:changed'));
        loadItems();
      } catch (e) { msg.textContent = '保存失败：' + e.message; }
    }
    const mask = el('div', { class: 'modal-mask' });
    mask.append(el('div', { class: 'modal' },
      el('h3', { text: schedule ? '编辑日程' : '新建日程' }),
      field('标题 *', titleInput),
      field('详情', detailInput),
      field('开始时间 *', startInput),
      field('结束时间', endInput),
      el('div', { class: 'row', style: 'justify-content:flex-end;margin-top:14px;' }, deleteBtn, cancelBtn, saveBtn, ' ', msg)
    ));
    saveBtn.onclick = save;
    cancelBtn.onclick = closeScheduleModal;
    if (deleteBtn) deleteBtn.onclick = async () => {
      if (!confirm('确定删除日程「' + schedule.title + '」？')) return;
      try { await api.schedules.remove(schedule.id); closeScheduleModal(); window.dispatchEvent(new CustomEvent('calendar:changed')); loadItems(); } catch (e) { msg.textContent = '删除失败：' + e.message; }
    };
    mask.onclick = (e) => { if (e.target === mask) closeScheduleModal(); };
    document.body.append(mask);
    scheduleModal = mask;
  }

  function closeScheduleModal() {
    if (scheduleModal && scheduleModal.parentNode) scheduleModal.parentNode.removeChild(scheduleModal);
    scheduleModal = null;
  }

  return {
    show() {
      panelTab = 'todo';
      todoPage = 1;
      if (!resizeListening) {
        window.addEventListener('resize', handleWindowResize);
        resizeListening = true;
      }
      observeCalendarHeight();
      loadItems();
    },
    hide() {
      if (sideHeightObserver) sideHeightObserver.disconnect();
      sideHeightObserver = null;
      if (resizeListening) {
        window.removeEventListener('resize', handleWindowResize);
        resizeListening = false;
      }
      sidePanel.style.height = '';
      closeReminderModal();
      closeScheduleModal();
    },
    openEdit(item) {
      if (item && (item._entity === 'reminder' || item.type === 'reminder')) openReminderModal(item);
      else if (item) openScheduleModal(item);
    }
  };
}
