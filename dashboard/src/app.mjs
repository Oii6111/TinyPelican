import { api } from './api.mjs';
import { el } from './ui.mjs';
import { mount as chat } from './views/chat.mjs';
import { mount as channels } from './views/channels.mjs';
import { mount as contacts } from './views/contacts.mjs';
import { mount as timeline } from './views/timeline.mjs';
import { mount as knowledge } from './views/knowledge.mjs';
import { mount as memoryInput } from './views/memory-input.mjs';
import { mount as proactive } from './views/proactive.mjs';
import { mount as pending } from './views/pending.mjs';
import { mount as tasks } from './views/tasks.mjs';
import { mount as records } from './views/records.mjs';
import { mount as strategy } from './views/strategy.mjs';
import { mount as mcp } from './views/mcp.mjs';
import { mount as skills } from './views/skills.mjs';
import { mount as workflows } from './views/workflows.mjs';
import { mount as settings } from './views/settings.mjs';

const NAV = [
  {
    id: 'msg', group: '消息渠道', icon: '📨',
    items: [
      { id: 'channels', label: '渠道列表', mount: channels }
    ]
  },
  {
    id: 'mem', group: '记忆', icon: '🧠',
    items: [
      { id: 'contacts', label: '联系人', mount: contacts },
      { id: 'timeline', label: '聊天记录查看器', mount: timeline },
      { id: 'knowledge', label: '个人知识库', mount: knowledge },
      { id: 'memory-input', label: '记忆输入', mount: memoryInput }
    ]
  },
  {
    id: 'pro', group: '主动', icon: '🔥',
    items: [
      { id: 'proactive', label: '主动仪表盘', mount: proactive },
      { id: 'tasks', label: '任务', mount: tasks },
      { id: 'pending', label: '待确认意图', mount: pending },
      { id: 'records', label: '思考和行动记录', mount: records },
      { id: 'strategy', label: '策略配置', mount: strategy }
    ]
  },
  {
    id: 'agt', group: 'Agent 功能', icon: '🛠️',
    items: [
      { id: 'mcp', label: 'MCP 工具', mount: mcp },
      { id: 'skills', label: 'Skill 管理', mount: skills },
      { id: 'workflows', label: 'Workflow', mount: workflows }
    ]
  }
];

const nav = document.getElementById('nav');
const viewBox = document.getElementById('view');
const foot = document.getElementById('sidebar-foot');
const instances = {};
const viewParams = {};
let currentId = null;

const ctx = { navigate: (id, params) => show(id, params) };

function mountView(id, mount, params) {
  const sec = el('section', { class: 'view', 'data-view': id, style: 'display:none;' });
  viewBox.append(sec);
  try {
    instances[id] = mount(sec, ctx);
  } catch (e) {
    sec.append(el('div', { class: 'empty', text: '视图加载失败：' + ((e && e.message) || e) }));
    instances[id] = { show() {}, hide() {} };
  }
  if (params) viewParams[id] = params;
}

// ---------- 顶部：对话板块（独立，默认启动页） ----------
const chatBtn = el('button', { class: 'nav-item nav-standalone', 'data-view': 'chat' },
  el('span', { text: '💬' }),
  el('span', { text: '对话' })
);
chatBtn.onclick = () => show('chat');
nav.append(chatBtn);
mountView('chat', chat);

// ---------- 中部：四个可折叠板块 ----------
for (const g of NAV) {
  const sub = el('div', { class: 'nav-sub' });
  const btn = el('button', { class: 'nav-group-btn', 'data-group': g.id },
    el('span', { text: g.icon }),
    el('span', { text: g.group }),
    el('span', { class: 'caret', text: '▸' })
  );
  for (const item of g.items) {
    const ibtn = el('button', { class: 'nav-item', 'data-view': item.id }, el('span', { text: item.label }));
    ibtn.onclick = () => show(item.id);
    sub.append(ibtn);
    mountView(item.id, item.mount);
  }
  btn.onclick = () => toggleGroup(g.id);
  nav.append(el('div', { class: 'nav-group' }, btn, sub));
  g._sub = sub;
  g._btn = btn;
}

// ---------- 左下角：设置（独立入口） ----------
const settingsBtn = document.getElementById('nav-settings');
settingsBtn.onclick = () => show('settings');
mountView('settings', settings);

function setGroupOpen(g, open) {
  g._sub.classList.toggle('open', open);
  g._btn.classList.toggle('open', open);
  g._btn.querySelector('.caret').textContent = open ? '▾' : '▸';
}

function toggleGroup(id) {
  const g = NAV.find((x) => x.id === id);
  const wasOpen = g._sub.classList.contains('open');
  for (const other of NAV) setGroupOpen(other, false);
  if (wasOpen) {
    show('chat');
  } else {
    setGroupOpen(g, true);
    show(g.items[0].id);
  }
}

function show(id, params) {
  if (params) viewParams[id] = params;
  // 打开所属分组
  const g = NAV.find((x) => x.items.some((it) => it.id === id));
  if (g && !g._sub.classList.contains('open')) {
    for (const other of NAV) setGroupOpen(other, false);
    setGroupOpen(g, true);
  }

  if (currentId && instances[currentId] && instances[currentId].hide) {
    instances[currentId].hide();
  }
  const prev = viewBox.querySelector('[data-view="' + currentId + '"]');
  if (prev) prev.style.display = 'none';

  currentId = id;
  nav.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === id));

  const sec = viewBox.querySelector('[data-view="' + id + '"]');
  if (sec) sec.style.display = '';
  if (instances[id] && instances[id].show) instances[id].show(viewParams[id]);
}

// ---------- 顶部状态栏 ----------
const hbDot = document.getElementById('hb-dot');
const hbText = document.getElementById('hb-text');
const hbLast = document.getElementById('hb-last');
const hbLevel = document.getElementById('hb-level');
const unreadCount = document.getElementById('unread-count');
const unreadBtn = document.getElementById('unread-btn');
const pushStatusEl = document.getElementById('push-status');
unreadBtn.onclick = () => show('chat');

async function refreshStatus() {
  try {
    const s = await api.status();
    const on = !!(s.heartbeat && s.heartbeat.online);
    hbDot.classList.toggle('on', on);
    hbText.textContent = on ? 'Agent 在线' : 'Agent 离线';
    hbLast.textContent = s.heartbeat && s.heartbeat.lastBeatAt
      ? new Date(s.heartbeat.lastBeatAt).toLocaleTimeString('zh-CN', { hour12: false })
      : '--';
    hbLevel.textContent = '主动级别 ' + ((s.proactivity && s.proactivity.level) || 'L2');
    const n = (s.unread && s.unread.count) || 0;
    unreadCount.textContent = n;
    unreadBtn.classList.toggle('has', n > 0);

    const wp = s.weixin && s.weixin.push;
    if (!wp || !wp.configured) {
      pushStatusEl.style.display = 'none';
      pushStatusEl.classList.remove('push-ok', 'push-warn');
    } else if (wp.ready) {
      pushStatusEl.style.display = '';
      pushStatusEl.textContent = '微信推送 可用';
      pushStatusEl.title = wp.updatedAt
        ? '最近激活：' + new Date(wp.updatedAt).toLocaleString('zh-CN', { hour12: false })
        : '微信主动推送可用';
      pushStatusEl.classList.remove('push-warn');
      pushStatusEl.classList.add('push-ok');
    } else {
      pushStatusEl.style.display = '';
      pushStatusEl.textContent = '微信推送 需激活';
      pushStatusEl.title = wp.reason || '请给 bot 发一条消息重新激活';
      pushStatusEl.classList.remove('push-ok');
      pushStatusEl.classList.add('push-warn');
    }
  } catch {}
}

setInterval(refreshStatus, 5000);
refreshStatus();

(async () => {
  try {
    const h = await api.health();
    foot.textContent = '核心 v' + (h.version || '') + ' 在线';
  } catch {
    foot.textContent = '核心未连接';
  }
})();

// 默认启动：空的新对话
show('chat');
