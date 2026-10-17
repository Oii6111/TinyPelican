import { api } from '../api.mjs';
import { el, empty } from '../ui.mjs';

const RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_RECENT_EVENTS = 5;

const INTENT_STATUS = {
  pending_confirm: { title: '识别到待确认意图', status: '待你确认', tone: 'intent', icon: '?' },
  confirmed: { title: '已确认安排', status: '已确认', tone: 'done', icon: '✓' },
  ignored: { title: '已忽略意图', status: '已忽略', tone: 'muted', icon: '×' },
  auto_added: { title: '已自动添加安排', status: '已添加', tone: 'schedule', icon: '＋' },
  auto_created: { title: '已自动添加安排', status: '已添加', tone: 'schedule', icon: '＋' }
};

function dateOf(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function pad(value) { return String(value).padStart(2, '0'); }

function activityTime(value) {
  const date = dateOf(value);
  if (!date) return '';
  return `${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function activityRange(start, end) {
  const begin = dateOf(start);
  if (!begin) return '';
  const startText = `${begin.getMonth() + 1}月${begin.getDate()}日 ${pad(begin.getHours())}:${pad(begin.getMinutes())}`;
  const finish = dateOf(end);
  if (!finish) return startText;
  const finishText = begin.toDateString() === finish.toDateString()
    ? `${pad(finish.getHours())}:${pad(finish.getMinutes())}`
    : `${finish.getMonth() + 1}月${finish.getDate()}日 ${pad(finish.getHours())}:${pad(finish.getMinutes())}`;
  return `${startText} – ${finishText}`;
}

function quote(value) {
  const text = String(value || '').trim();
  return text ? `“${text}”` : '';
}

function eventSearchText(event) {
  return [event.title, event.quote, event.detail, event.status].filter(Boolean).join(' ').toLowerCase();
}

function makeIntentEvent(intent) {
  const memoryUpdate = intent.type === 'profile_update' && intent.status === 'confirmed';
  const state = memoryUpdate
    ? { title: '已保存到记忆', status: '已保存', tone: 'memory', icon: '◇' }
    : (INTENT_STATUS[intent.status] || INTENT_STATUS.pending_confirm);
  const timestamp = intent.updatedAt || intent.createdAt;
  const detail = intent.dueText || activityRange(intent.dueAt, intent.endAt);
  const summary = intent.summary || (intent.source && intent.source.contact) || '';
  return {
    id: `intent:${intent.id}`,
    timestamp,
    tone: state.tone,
    icon: state.icon,
    title: state.title,
    quote: quote(summary),
    detail,
    status: state.status,
    search: eventSearchText({ ...state, quote: summary, detail })
  };
}

function makeTaskEvent(task) {
  const isReminder = task.type === 'reminder';
  const completed = task.status === 'done';
  const notified = isReminder && task.lastNotifiedAt;
  const timestamp = isReminder
    ? (notified || (completed && task.lastCompletedAt) || task.createdAt || task.updatedAt)
    : completed
      ? (task.lastCompletedAt || task.updatedAt || task.createdAt)
      : (task.createdAt || task.updatedAt);
  const title = isReminder ? (notified || completed ? '发送提醒' : '已创建提醒') : completed ? '已完成待办' : '已创建待办';
  const tone = isReminder ? 'reminder' : completed ? 'done' : 'task';
  const status = isReminder ? (notified || completed ? '已发送' : '进行中') : completed ? '已完成' : '进行中';
  const detail = task.dueText || activityRange(task.scheduledStartAt || task.dueAt, task.scheduledEndAt) || String(task.detail || '').trim();
  return {
    id: `task:${task.id}`,
    timestamp,
    tone,
    icon: completed ? '✓' : isReminder ? '!' : '•',
    title,
    quote: quote(task.title),
    detail,
    status,
    search: eventSearchText({ title, quote: task.title, detail, status })
  };
}

function makeScheduleEvent(schedule) {
  const completed = schedule.status === 'done' || schedule.status === 'completed';
  const title = completed ? '已完成日程' : '已创建日程';
  const detail = activityRange(schedule.startAt, schedule.endAt);
  return {
    id: `schedule:${schedule.id}`,
    timestamp: schedule.createdAt || schedule.updatedAt || schedule.startAt,
    tone: completed ? 'done' : 'schedule',
    icon: completed ? '✓' : '□',
    title,
    quote: quote(schedule.title),
    detail,
    status: completed ? '已完成' : '',
    search: eventSearchText({ title, quote: schedule.title, detail })
  };
}

function eventDate(event) {
  const date = dateOf(event.timestamp);
  return date ? date.getTime() : 0;
}

function renderEvent(event) {
  const detail = event.detail ? el('div', { class: 'activity-event-detail', text: event.detail }) : null;
  const status = event.status ? el('div', { class: 'activity-event-status', text: event.status }) : null;
  return el('article', { class: `activity-event activity-event-${event.tone}` },
    el('div', { class: 'activity-event-marker', 'aria-hidden': 'true' }, el('span', { class: 'activity-event-icon', text: event.icon })),
    el('div', { class: 'activity-event-card' },
      el('div', { class: 'activity-event-time', text: activityTime(event.timestamp) }),
      el('div', { class: 'activity-event-title', text: event.title }),
      event.quote ? el('div', { class: 'activity-event-quote', text: event.quote }) : null,
      detail,
      status
    )
  );
}

export function mount(container) {
  empty(container);
  container.className = 'view activity-view';
  let allEvents = [];
  let showAll = false;
  let query = '';

  const list = el('div', { class: 'activity-timeline' });
  const allList = el('div', { class: 'activity-all-list', hidden: true });
  const subtitle = el('span', { class: 'activity-subtitle', text: '最近 7 天' });
  const viewAll = el('button', { class: 'activity-view-all', type: 'button', text: '查看全部 →' });
  const search = el('input', { class: 'input activity-search', placeholder: '搜索活动…', 'aria-label': '搜索活动', hidden: true });
  const emptyRecent = el('div', { class: 'activity-empty', text: '最近 7 天暂无活动' });

  viewAll.onclick = () => {
    showAll = !showAll;
    viewAll.textContent = showAll ? '收起全部 ↑' : '查看全部 →';
    subtitle.textContent = showAll ? '全部活动' : '最近 7 天';
    search.hidden = !showAll;
    list.hidden = showAll;
    emptyRecent.hidden = showAll;
    allList.hidden = !showAll;
    if (showAll) renderAll();
    else renderRecent();
  };
  search.oninput = () => { query = search.value.trim().toLowerCase(); renderAll(); };

  const card = el('section', { class: 'activity-card' },
    el('div', { class: 'activity-head' },
      el('div', { class: 'activity-heading' },
        el('div', { class: 'activity-title-row' }, el('h2', { text: 'Agent 活动' }), subtitle),
        el('div', { class: 'activity-description', text: '只展示 Agent 对安排、提醒和意图做出的实际处理。' })
      ),
      el('div', { class: 'activity-head-actions' }, search, viewAll)
    ),
    el('div', { class: 'activity-list-wrap' }, list, emptyRecent, allList)
  );
  container.append(card);

  function renderRecent() {
    empty(list);
    const now = Date.now();
    const recent = allEvents.filter((event) => {
      const time = eventDate(event);
      return time > 0 && now - time <= RECENT_WINDOW_MS && time <= now;
    }).slice(0, MAX_RECENT_EVENTS);
    emptyRecent.hidden = recent.length > 0 || showAll;
    if (!recent.length) return;
    list.append(...recent.map(renderEvent));
  }

  function renderAll() {
    empty(allList);
    const shown = allEvents.filter((event) => !query || event.search.includes(query));
    if (!shown.length) {
      allList.append(el('div', { class: 'activity-empty', text: query ? '没有匹配的活动' : '暂无活动' }));
      return;
    }
    allList.append(...shown.map(renderEvent));
  }

  async function load() {
    let intents = [];
    let tasks = [];
    let schedules = [];
    try { intents = await api.intents.list(); } catch {}
    try { tasks = await api.tasks.list(); } catch {}
    try { schedules = await api.schedules.list(); } catch {}
    allEvents = [
      ...intents.filter((item) => item && item.id).map(makeIntentEvent),
      ...tasks.filter((item) => item && item.id).map(makeTaskEvent),
      ...schedules.filter((item) => item && item.id).map(makeScheduleEvent)
    ].filter((event) => eventDate(event) > 0).sort((a, b) => eventDate(b) - eventDate(a));
    renderRecent();
    if (showAll) renderAll();
  }

  return { show: load, hide() {} };
}
