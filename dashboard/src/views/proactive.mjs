import { api } from '../api.mjs';
import { el, empty, fmtTime } from '../ui.mjs';
import { mount as calendarMount } from './calendar.mjs';
import { mount as tasksMount } from './tasks.mjs';
import { mount as pendingMount } from './pending.mjs';
import { mount as recordsMount } from './records.mjs';

const TABS = [
  { id: 'tasks', label: '📌 待办' },
  { id: 'pending', label: '🔍 待确认意图' },
  { id: 'records', label: '🧾 思考与行动记录' }
];

export function mount(container, ctx) {
  empty(container);
  container.className = 'view proactive-dashboard';

  // 顶部状态
  const heartbeatBox = el('div', { class: 'card proactive-heart' });
  const statGrid = el('div', { class: 'stat-grid' });
  const calendarBox = el('div', { class: 'proactive-calendar' });

  // Tab 容器
  const tabBtns = el('div', { class: 'proactive-tabs' });
  const panes = {};
  const taskBox = el('div', { class: 'pane' });
  const pendingBox = el('div', { class: 'pane' });
  const recordsBox = el('div', { class: 'pane' });
  panes.tasks = taskBox;
  panes.pending = pendingBox;
  panes.records = recordsBox;

  // 日历直接放在主页面，不放进子 Tab
  let calendarView = null;
  const taskView = tasksMount(taskBox, {
    onEdit(item) { if (calendarView && calendarView.openEdit) calendarView.openEdit(item); }
  });
  calendarView = calendarMount(calendarBox, {
    onCreate(date) { taskView.openCreate(date); },
    onEdit(task) { taskView.openEdit(task); }
  });
  const pendingView = pendingMount(pendingBox);
  const recordsView = recordsMount(recordsBox);
  taskBox.classList.add('pane');
  pendingBox.classList.add('pane');
  recordsBox.classList.add('pane');

  container.append(
    el('div', { class: 'proactive-hero' },
      el('div', {},
        el('h2', { text: '主动仪表盘' }),
        el('div', { class: 'desc', text: '先在日历查看安排，再在下方统一处理待办、待确认意图和思考/行动记录。' })
      ),
      heartbeatBox
    ),
    el('div', { class: 'proactive-stats' }, statGrid),
    calendarBox,
    el('div', { class: 'card proactive-tab-card' },
      tabBtns,
      el('div', { class: 'proactive-panels' }, taskBox, pendingBox, recordsBox)
    )
  );

  function switchTab(id) {
    for (const t of TABS) {
      const show = t.id === id;
      panes[t.id].style.display = show ? 'block' : 'none';
    }
    for (const btn of tabBtns.children) {
      btn.classList.toggle('active', btn.dataset.tab === id);
    }
    if (id === 'tasks' && taskView && typeof taskView.show === 'function') taskView.show();
    if (id === 'pending' && pendingView && typeof pendingView.show === 'function') pendingView.show();
    if (id === 'records' && recordsView && typeof recordsView.show === 'function') recordsView.show();
  }

  for (const t of TABS) {
    const btn = el('button', { class: 'proactive-tab', 'data-tab': t.id, text: t.label });
    btn.onclick = () => switchTab(t.id);
    tabBtns.append(btn);
  }

  async function loadHeartbeat() {
    let st = null;
    try { st = await api.status(); } catch {}
    const on = !!(st && st.heartbeat && st.heartbeat.online);
    empty(heartbeatBox);
    heartbeatBox.append(
      el('div', { class: 'hb-line' },
        el('span', { class: 'hb-dot' + (on ? ' on' : '') }),
        el('span', { class: 'strong', text: on ? 'Agent 在线' : 'Agent 离线' }),
        el('span', { class: 'muted', text: ' · 主动级别 ' + ((st && st.proactivity && st.proactivity.level) || 'L2') })
      ),
      el('div', { class: 'meta', text: '最后心跳 ' + (st && st.heartbeat.lastBeatAt ? fmtTime(st.heartbeat.lastBeatAt) : '--') })
    );
  }

  async function loadStats() {
    let tasks = [];
    let intents = [];
    let schedules = [];
    try { tasks = await api.tasks.list(); } catch {}
    try { intents = await api.intents.list(); } catch {}
    try { schedules = await api.schedules.list('open'); } catch {}
    const openTodos = tasks.filter((t) => t.type !== 'reminder' && t.status === 'open').length;
    const reminders = tasks.filter((t) => t.type === 'reminder' && t.status === 'open').length;
    const done = tasks.filter((t) => t.status === 'done').length;
    const pending = intents.filter((t) => t.status === 'pending_confirm').length;
    empty(statGrid);
    const cards = [
      ['📌 待办', openTodos],
      ['🔔 提醒', reminders],
      ['📅 日程', schedules.length],
      ['✅ 已完成', done],
      ['🔍 待确认意图', pending]
    ];
    for (const [label, val] of cards) {
      statGrid.append(
        el('div', { class: 'stat-card proactive-stat' },
          el('div', { class: 'stat-val', text: String(val) }),
          el('div', { class: 'stat-label', text: label })
        )
      );
    }
  }

  function loadAll() {
    loadHeartbeat();
    loadStats();
    if (calendarView && typeof calendarView.show === 'function') calendarView.show();
    switchTab('tasks');
  }

  window.addEventListener('tasks:changed', loadStats);
  window.addEventListener('intents:changed', loadStats);
  window.addEventListener('calendar:changed', loadStats);

  return {
    show() { loadAll(); },
    hide() {
      if (calendarView && typeof calendarView.hide === 'function') calendarView.hide();
      if (taskView && typeof taskView.hide === 'function') taskView.hide();
      if (pendingView && typeof pendingView.hide === 'function') pendingView.hide();
      if (recordsView && typeof recordsView.hide === 'function') recordsView.hide();
    }
  };
}
