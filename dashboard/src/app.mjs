import { api } from './api.mjs';
import { el } from './ui.mjs';
import { mount as chat } from './views/chat.mjs';
import { mount as channels } from './views/channels.mjs';
import { mount as contacts } from './views/contacts.mjs';
import { mount as email } from './views/email.mjs';
import { mount as scheduleDashboard } from './views/proactive.mjs';
import { mount as settings } from './views/settings.mjs';
document.documentElement.classList.toggle('desktop-shell', /Windows/.test(navigator.userAgent) && /Electron\//.test(navigator.userAgent));

const NAV_ICONS = {
  channels: '<svg viewBox="0 0 24 24"><path d="M5 5.5h14v10H9l-4 3v-13Z"/><path d="M8 9h8M8 12h5"/></svg>',
  memory: '<svg viewBox="0 0 24 24"><path d="M12 4a7.5 7.5 0 0 0-7.2 9.5L4 18l4.2-.8A7.5 7.5 0 1 0 12 4Z"/><circle cx="12" cy="11.5" r="2.2"/><path d="M12 8v1"/></svg>',
  agent: '<svg viewBox="0 0 24 24"><path d="M14.3 6.5a4.5 4.5 0 0 0-5.6 5.6L3.6 17.2a2.2 2.2 0 0 0 3.2 3.2l5.1-5.1a4.5 4.5 0 0 0 5.6-5.6l-3.2 3.2-3.2-3.2Z"/><path d="m17.5 3 .6 2.4L20.5 6l-2.4.6-.6 2.4-.6-2.4L14.5 6l2.4-.6ZM5 3v4M3 5h4"/></svg>',
  chat: '<svg viewBox="0 0 24 24"><path d="M5 18.5 4 21l3.3-1.3A8 8 0 1 0 5 18.5Z"/></svg>',
  calendar: '<svg viewBox="0 0 24 24"><rect x="4" y="5.5" width="16" height="15" rx="2"/><path d="M8 3.5v4M16 3.5v4M4 10h16M8 14h2M14 14h2M8 17.5h2"/></svg>'
};

function navIcon(name) {
  return el('span', { class: 'nav-icon', 'aria-hidden': 'true', html: NAV_ICONS[name] || '' });
}

const NAV = [
  {
    id: 'msg', group: '消息渠道', icon: 'channels',
    items: [
      { id: 'channels', label: '渠道列表', mount: channels }
    ]
  },
  {
    id: 'mem', group: '记忆', icon: 'memory',
    items: [
      { id: 'contacts', label: '联系人', mount: contacts }
    ]
  }
];

NAV.find((group) => group.id === 'mem').items.push({ id: 'email', label: '邮件', mount: email });

const nav = document.getElementById('nav');
const channelNavigation = NAV.find(group => group.id === 'msg');
NAV.splice(NAV.indexOf(channelNavigation), 1);
const viewBox = document.getElementById('view');
const foot = document.getElementById('sidebar-foot');
const instances = {};
const viewParams = {};
let currentId = null;

const ctx = { navigate: (id, params) => id === 'settings' ? openSettings(params) : show(id, params), closeSettings: () => closeSettings() };

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
const chatBtn = el('button', { class: 'nav-item nav-standalone chat-nav-toggle', 'data-view': 'chat', 'aria-expanded': 'true', 'aria-controls': 'dsh-sidebar-panel' },
  navIcon('chat'),
  el('span', { text: '对话' }),
  el('span', { class: 'caret', 'aria-hidden': 'true', html: '<svg viewBox="0 0 16 16"><path d="m6 4 4 4-4 4"/></svg>' })
);
const chatSidebarStatus = el('div', { class: 'chat-sidebar-status', text: '正在连接对话…', role: 'status' });
const chatSidebarHost = el('div', { id: 'dsh-sidebar-host' });
const chatSidebarPanel = el('div', { id: 'dsh-sidebar-panel', class: 'chat-sidebar-panel' }, chatSidebarStatus, chatSidebarHost);
const chatNavGroup = el('div', { class: 'chat-nav-group open' }, chatBtn, chatSidebarPanel);
let chatExpanded = true;
function setChatExpanded(open) {
  chatExpanded = open;
  chatNavGroup.classList.toggle('open', open);
  chatSidebarPanel.hidden = !open;
  chatBtn.setAttribute('aria-expanded', String(open));
}
chatSidebarHost.addEventListener('dsh-sidebar-ready', () => { chatSidebarStatus.hidden = true; });
chatSidebarHost.addEventListener('dsh-sidebar-disconnected', () => { chatSidebarStatus.hidden = false; });
chatSidebarHost.addEventListener('dsh-sidebar-error', (event) => {
  chatSidebarStatus.hidden = false;
  chatSidebarStatus.textContent = event.detail || '连接暂不可用，请在右侧重试';
});
chatBtn.onclick = () => {
  if (currentId === 'chat') setChatExpanded(!chatExpanded);
  else show('chat');
};
nav.append(chatNavGroup);
mountView('chat', chat);

const scheduleBtn = el('button', { class: 'nav-item nav-standalone', 'data-view': 'schedule-dashboard' },
  navIcon('calendar'),
  el('span', { text: '日历与日程' })
);
scheduleBtn.onclick = () => show('schedule-dashboard');
nav.append(scheduleBtn);
mountView('schedule-dashboard', scheduleDashboard);

const channelsBtn = el('button', { class: 'nav-item nav-standalone', 'data-view': 'channels' },
  navIcon('channels'),
  el('span', { text: channelNavigation.group })
);
channelsBtn.onclick = () => show('channels');
nav.append(channelsBtn);
mountView('channels', channels);

for (const g of NAV) {
  const sub = el('div', { class: 'nav-sub', id: 'nav-sub-' + g.id });
  const btn = el('button', { class: 'nav-group-btn', 'data-group': g.id, 'aria-expanded': 'false', 'aria-controls': 'nav-sub-' + g.id },
    navIcon(g.icon),
    el('span', { text: g.group }),
    el('span', { class: 'caret', 'aria-hidden': 'true', html: '<svg viewBox="0 0 16 16"><path d="m6 4 4 4-4 4"/></svg>' })
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
settingsBtn.onclick = () => openSettings();
mountView('settings', settings);

let settingsOpen = false;
function openSettings(params) {
  if (params) viewParams.settings = params;
  const sec = viewBox.querySelector('[data-view="settings"]');
  if (!sec) return;
  settingsOpen = true;
  sec.style.display = '';
  settingsBtn.classList.add('active');
  settingsBtn.setAttribute('aria-expanded', 'true');
  instances.settings?.show?.(params);
}

function closeSettings() {
  if (!settingsOpen) return;
  settingsOpen = false;
  instances.settings?.hide?.();
  const sec = viewBox.querySelector('[data-view="settings"]');
  if (sec) sec.style.display = 'none';
  settingsBtn.classList.remove('active');
  settingsBtn.removeAttribute('aria-expanded');
}

function setGroupOpen(g, open) {
  g._sub.classList.toggle('open', open);
  g._btn.classList.toggle('open', open);
  g._btn.setAttribute('aria-expanded', String(open));
}

function toggleGroup(id) {
  const g = NAV.find((x) => x.id === id);
  const wasOpen = g._sub.classList.contains('open');
  for (const other of NAV) setGroupOpen(other, false);
  if (!wasOpen) {
    setGroupOpen(g, true);
    show(g.items[0].id);
  }
}

function show(id, params) {
  if (settingsOpen) closeSettings();
  if (params) viewParams[id] = params;
  setChatExpanded(id === 'chat');
  if (id === 'chat') for (const group of NAV) setGroupOpen(group, false);
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
  document.querySelectorAll('.sidebar .nav-item').forEach((button) => {
    const active = button.dataset.view === id;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });

  const sec = viewBox.querySelector('[data-view="' + id + '"]');
  if (sec) sec.style.display = '';
  if (instances[id] && instances[id].show) instances[id].show(viewParams[id]);
}

(async () => {
  try {
    const h = await api.health();
    foot.textContent = '核心 v' + (h.version || '') + ' 在线';
    const editionDialog = el('div', { class: 'edition-dialog-backdrop', hidden: true },
      el('div', { class: 'edition-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'edition-dialog-title' },
        el('div', { class: 'edition-dialog-kicker', text: '\u5c0f\u9e48\u9e55 / EDITIONS' }),
        el('h2', { id: 'edition-dialog-title', text: '\u5207\u6362\u4e13\u5c5e\u7248\u672c' }),
        el('p', { class: 'edition-dialog-copy', text: '\u8f93\u5165\u7248\u672c\u9884\u8bbe\u7801\uff0c\u52a0\u8f7d\u5bf9\u5e94\u7684\u5c0f\u9e48\u9e55\u5de5\u4f5c\u7a7a\u95f4\u3002' }),
        el('input', { class: 'edition-code-input', type: 'text', placeholder: '\u4f8b\u5982 TINYPELICAN-ROMANCE', autocomplete: 'off', spellcheck: 'false' }),
        el('div', { class: 'edition-dialog-status', role: 'status' }),
        el('div', { class: 'edition-dialog-actions' },
          el('button', { class: 'edition-dialog-cancel', type: 'button', text: '\u53d6\u6d88' }),
          el('button', { class: 'edition-dialog-confirm', type: 'button', text: '\u52a0\u8f7d\u7248\u672c' })
        )
      )
    );
    const input = editionDialog.querySelector('.edition-code-input');
    const status = editionDialog.querySelector('.edition-dialog-status');
    const closeEditionDialog = () => { editionDialog.hidden = true; status.textContent = ''; };
    editionDialog.querySelector('.edition-dialog-cancel').addEventListener('click', closeEditionDialog);
    editionDialog.addEventListener('click', event => { if (event.target === editionDialog) closeEditionDialog(); });
    editionDialog.querySelector('.edition-dialog-confirm').addEventListener('click', async () => {
      const code = input.value.trim();
      if (!code) { status.textContent = '\u8bf7\u5148\u8f93\u5165\u9884\u8bbe\u7801'; return; }
      status.textContent = '\u6b63\u5728\u9a8c\u8bc1...';
      try {
        await api.edition.activate(code);
        status.textContent = '\u7248\u672c\u5df2\u52a0\u8f7d\uff0c\u6b63\u5728\u91cd\u542f...';
      } catch (error) {
        status.textContent = error.message || '\u9884\u8bbe\u7801\u65e0\u6548';
      }
    });
    const editionButton = el('button', { class: 'sidebar-edition-button', type: 'button' },
      el('span', { class: 'edition-button-mark', html: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5 14 8l4.5 2-4.5 2-2 4.5-2-4.5-4.5-2 4.5-2 2-4.5Z"/><path d="m19 15 .8 1.7 1.7.8-1.7.8-.8 1.7-.8-1.7-1.7-.8 1.7-.8L19 15Z"/></svg>' }),
      el('span', { text: '\u5207\u6362\u7248\u672c' })
    );
    editionButton.addEventListener('click', () => { editionDialog.hidden = false; input.focus(); });
    foot.append(editionButton);
    document.body.append(editionDialog);
  } catch {
    foot.textContent = '核心未连接';
  }
})();

// 默认启动：空的新对话
show('chat');
