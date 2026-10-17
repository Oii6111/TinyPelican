import { api } from '../api.mjs';
import { el, empty } from '../ui.mjs';
import { createWeixinMediaSender } from '../components/weixin-media.mjs';

const FUTURE_CHANNELS = [
  { id: 'web', art: 'web', name: '网页', type: 'Web Chat', description: '面向浏览器访客的对话入口。' },
  { id: 'api', art: 'api', name: 'API', type: 'Webhook', description: '通过 API 接入外部系统。' },
  { id: 'slack', art: 'slack', name: 'Slack', type: 'App', description: '连接 Slack 工作区消息。' },
  { id: 'feishu', art: 'feishu', name: '飞书', type: 'App', description: '连接飞书组织消息。' }
];

function navigateSettings(ctx, section) {
  if (typeof sessionStorage !== 'undefined') sessionStorage.setItem('settings-section', section);
  if (ctx && typeof ctx.navigate === 'function') ctx.navigate('settings');
}

function statusBadge(status) {
  return el('span', { class: 'badge ' + (status.tone || ''), text: status.label });
}

function channelIcon(channel, detail = false) {
  return el('span', {
    class: (detail ? 'channel-detail-icon' : 'channel-index-icon') + ' channel-art channel-art-' + channel.art,
    'aria-hidden': 'true'
  });
}

function formatTime(value) {
  if (!value) return '尚未同步';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('zh-CN', { hour12: false });
}

export function mount(container, ctx = {}) {
  empty(container);
  container.className = 'view channels-page';

  const index = el('aside', { class: 'channel-index', 'aria-label': '渠道列表' });
  const detail = el('section', { class: 'channel-detail', 'aria-live': 'polite' });
  const workspace = el('div', { class: 'channel-workspace' }, index, detail);
  container.append(
    el('header', { class: 'channels-page-head' },
      el('div', {},
        el('h1', { text: '消息渠道' }),
        el('p', { text: '管理 TinyPelican 的信息入口、接收规则与连接状态。' })
      ),
      el('button', { class: 'btn btn-primary', type: 'button', text: '+ 添加渠道', onclick: () => renderDetail('add') })
    ),
    workspace
  );

  const state = { selected: 'wechat', channels: new Map(), loaded: false };

  function settingAction(section, label = '打开设置') {
    return el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: label, onclick: () => navigateSettings(ctx, section) });
  }

  function configureAction(section, label = '配置渠道') {
    return el('button', {
      class: 'btn btn-primary btn-sm channel-config-action',
      type: 'button',
      text: label,
      title: '打开该渠道的配置面板',
      onclick: () => navigateSettings(ctx, section)
    });
  }

  function channelStatus(id) {
    return state.channels.get(id) || { tone: 'warn', label: '未配置', meta: '等待配置' };
  }

  function addIndexItem(channel, enabledList, disabledList) {
    const status = channelStatus(channel.id);
    const item = el('div', {
      class: 'channel-index-item' + (state.selected === channel.id ? ' active' : ''),
    });
    const main = el('button', {
      class: 'channel-index-main',
      type: 'button',
      'aria-pressed': state.selected === channel.id,
      onclick: () => { state.selected = channel.id; renderIndex(); renderDetail(channel.id); }
    },
      channelIcon(channel),
      el('span', { class: 'channel-index-copy' },
        el('strong', { text: channel.name }),
        el('small', { text: status.meta || channel.type })
      )
    );
    const actions = el('span', { class: 'channel-index-actions' }, statusBadge(status));
    if (['wechat', 'email', 'search'].includes(channel.id)) {
      const test = el('button', { class: 'channel-index-action', type: 'button', title: '测试连接', 'aria-label': `${channel.name}测试连接`, text: '✓', onclick: async (event) => {
        event?.stopPropagation?.();
        test.disabled = true;
        test.textContent = '…';
        try {
          if (channel.id === 'wechat') await api.wechat.status();
          else if (channel.id === 'email') await api.email.test();
          else await api.webSearch.test();
          test.title = '连接测试成功';
        } catch (error) {
          test.title = error.message || '连接测试失败';
        } finally {
          test.disabled = false;
          test.textContent = '✓';
        }
      } });
      actions.append(test);
      const section = channel.id === 'wechat' ? 'wechat' : channel.id === 'email' ? 'email' : 'web-search';
      actions.append(el('button', { class: 'channel-index-action', type: 'button', title: '打开配置', 'aria-label': `${channel.name}配置`, text: '⚙', onclick: (event) => { event?.stopPropagation?.(); navigateSettings(ctx, section); } }));
    }
    item.append(main, actions);
    item.setAttribute('data-channel-id', channel.id);
    (status.enabled ? enabledList : disabledList).append(item);
  }

  function renderIndex() {
    empty(index);
    const title = el('div', { class: 'channel-index-head' },
      el('div', {}, el('strong', { text: '渠道' }), el('span', { text: `${state.channels.size} 个渠道` })),
      el('button', { class: 'channel-refresh-btn', type: 'button', title: '刷新状态', 'aria-label': '刷新状态', text: '↻', onclick: load })
    );
    const enabledList = el('div', { class: 'channel-index-list-enabled' });
    const disabledList = el('div', { class: 'channel-index-list-disabled' });
    index.append(title,
      el('div', { class: 'channel-index-section' }, el('div', { class: 'channel-index-section-title', text: '已启用' }), enabledList),
      el('div', { class: 'channel-index-section' }, el('div', { class: 'channel-index-section-title', text: '未启用' }), disabledList)
    );
    const all = [
      { id: 'wechat', art: 'wechat', name: '微信', type: 'iLink 个人号 · 双向消息' },
      { id: 'email', art: 'email', name: '邮件', type: 'IMAP 收取 / SMTP 发送' },
      { id: 'search', art: 'search', name: '联网搜索', type: 'SearXNG / Kimi · 新鲜话题来源' },
      ...FUTURE_CHANNELS
    ];
    all.forEach(channel => addIndexItem(channel, enabledList, disabledList));
  }

  function detailHeader(channel, status, actions = []) {
    const actionBar = el('div', { class: 'channel-detail-actions' }, ...actions);
    return el('header', { class: 'channel-detail-head' },
      el('div', { class: 'channel-detail-title' },
        channelIcon(channel, true),
        el('div', {}, el('h2', { text: channel.name }), el('p', { text: channel.type }))
      ),
      el('div', { class: 'channel-detail-status' }, statusBadge(status), actionBar)
    );
  }

  function tabs() {
    const nav = el('nav', { class: 'channel-detail-tabs', 'aria-label': '渠道设置分区' });
    const panes = el('div', { class: 'channel-detail-panes' });
    const names = [['basic', '基本设置'], ['rules', '接收规则'], ['advanced', '高级设置']];
    const paneById = new Map();
    names.forEach(([id, label], index) => {
      const button = el('button', { type: 'button', class: 'channel-detail-tab' + (index === 0 ? ' active' : ''), text: label, 'aria-selected': index === 0 });
      const pane = el('div', { class: 'channel-detail-pane', 'data-channel-pane': id, hidden: index !== 0 });
      button.onclick = () => {
        nav.querySelectorAll('.channel-detail-tab').forEach(item => { item.classList.toggle('active', item === button); item.setAttribute('aria-selected', item === button ? 'true' : 'false'); });
        paneById.forEach((value, key) => { value.hidden = key !== id; });
      };
      nav.append(button); panes.append(pane); paneById.set(id, pane);
    });
    return { nav, panes, paneById };
  }

  function keyValue(label, value) {
    return el('div', { class: 'channel-detail-row' }, el('span', { text: label }), el('strong', { text: value || '未设置' }));
  }

  function renderWechat() {
    const channel = { id: 'wechat', art: 'wechat', name: '微信', type: 'iLink 个人号 · 双向消息' };
    const status = channelStatus('wechat');
    const { nav, panes, paneById } = tabs();
    const test = el('button', { class: 'btn btn-sm', type: 'button', text: '测试连接' });
    const message = el('span', { class: 'channel-inline-status', role: 'status' });
    test.onclick = async () => { message.textContent = '正在读取连接状态…'; test.disabled = true; try { const result = await api.wechat.status(); message.textContent = result?.configured ? '微信连接正常' : '微信尚未登录'; } catch (error) { message.textContent = error.message; } finally { test.disabled = false; } };
    detail.append(detailHeader(channel, status, [test, configureAction('wechat', '配置渠道')]), nav, panes);
    paneById.get('basic').append(
      el('div', { class: 'channel-section-intro' }, el('h3', { text: '微信连接' }), el('p', { text: '使用 iLink 个人号接收和发送消息。' })),
      keyValue('连接状态', status.label), keyValue('账号', status.account || '扫码登录后显示'), keyValue('最近同步', status.lastSync || '实时连接'),
      el('div', { class: 'channel-inline-actions' }, message)
    );
    paneById.get('rules').append(
      el('div', { class: 'channel-section-intro' }, el('h3', { text: '接收规则' }), el('p', { text: '媒体会沿用当前微信渠道的安全限制，并进入统一消息处理流程。' })),
      el('label', { class: 'channel-rule-row' }, el('input', { type: 'checkbox', checked: true, disabled: true }), el('span', {}, el('strong', { text: '文字消息' }), el('small', { text: '接收并交给 Agent 处理' }))),
      el('label', { class: 'channel-rule-row' }, el('input', { type: 'checkbox', checked: true, disabled: true }), el('span', {}, el('strong', { text: '图片与文件' }), el('small', { text: '保留媒体元数据并支持发送' }))),
      el('label', { class: 'channel-rule-row' }, el('input', { type: 'checkbox', checked: true, disabled: true }), el('span', {}, el('strong', { text: '语音转写' }), el('small', { text: '转写后进入消息上下文' })))
    );
    paneById.get('advanced').append(
      el('div', { class: 'channel-section-intro' }, el('h3', { text: '媒体发送测试' }), el('p', { text: '在这里验证图片与文件是否能通过当前微信连接发送。' })),
      createWeixinMediaSender(status.raw || {})
    );
  }

  function renderEmail() {
    const channel = { id: 'email', art: 'email', name: '邮件', type: 'IMAP 收取 / SMTP 发送' };
    const status = channelStatus('email');
    const { nav, panes, paneById } = tabs();
    const test = el('button', { class: 'btn btn-sm', type: 'button', text: '测试连接' });
    const sync = el('button', { class: 'btn btn-sm btn-primary', type: 'button', text: '立即同步' });
    const message = el('span', { class: 'channel-inline-status', role: 'status' });
    test.onclick = async () => { test.disabled = true; message.textContent = '正在测试 IMAP / SMTP…'; try { const result = await api.email.test(); message.textContent = result?.ok ? 'IMAP / SMTP 连接成功' : (result?.error || '连接测试失败'); } catch (error) { message.textContent = error.message; } finally { test.disabled = false; } };
    sync.onclick = async () => { sync.disabled = true; message.textContent = '同步任务已提交…'; try { const result = await api.email.sync(); message.textContent = result?.queued || result?.ok ? '邮件同步已启动' : (result?.error || '无法启动同步'); } catch (error) { message.textContent = error.message; } finally { sync.disabled = false; } };
    detail.append(detailHeader(channel, status, [test, sync, configureAction('email', '配置渠道')]), nav, panes);
    paneById.get('basic').append(
      el('div', { class: 'channel-section-intro' }, el('h3', { text: '邮件账户' }), el('p', { text: '邮件单独保存并分析，重要邮件可按通知设置推送。' })),
      keyValue('连接状态', status.label), keyValue('账户', status.account || '未配置'), keyValue('最近成功同步', status.lastSync || '尚未同步'),
      el('div', { class: 'channel-inline-actions' }, message)
    );
    paneById.get('rules').append(
      el('div', { class: 'channel-section-intro' }, el('h3', { text: '接收规则' }), el('p', { text: '所有邮件都会保存；广告、推广和噪声不会推送。' })),
      el('label', { class: 'channel-rule-row' }, el('input', { type: 'checkbox', checked: status.enabled !== false, disabled: true }), el('span', {}, el('strong', { text: '启用收信与分析' }), el('small', { text: '使用 IMAP 增量同步并调用 Agent 分类' }))),
      el('label', { class: 'channel-rule-row' }, el('input', { type: 'checkbox', checked: status.importantPush !== false, disabled: true }), el('span', {}, el('strong', { text: '推送重要邮件' }), el('small', { text: '由通知渠道设置共同控制' })))
    );
    paneById.get('advanced').append(
      el('div', { class: 'channel-section-intro' }, el('h3', { text: '同步信息' }), el('p', { text: '断线后会根据同步游标补齐邮件，重复同步不会重复分析。' })),
      keyValue('同步游标', status.cursor || '未开始'), keyValue('分析队列', status.queue || '暂无队列'), keyValue('当前错误', status.error || '无'), status.errorAt ? keyValue('错误时间', status.errorAt) : null
    );
  }

  function renderSearch() {
    const channel = { id: 'search', art: 'search', name: '联网搜索', type: 'SearXNG / Kimi · 新鲜话题来源' };
    const status = channelStatus('search');
    const { nav, panes, paneById } = tabs();
    const test = el('button', { class: 'btn btn-sm', type: 'button', text: '测试连接' });
    const message = el('span', { class: 'channel-inline-status', role: 'status', text: '用于“聊点新鲜的”方向' });
    test.onclick = async () => { test.disabled = true; message.textContent = '正在搜索测试…'; try { const result = await api.webSearch.test(); message.textContent = result?.results ? `连接成功 · ${result.results.length} 条来源` : '连接测试成功'; } catch (error) { message.textContent = error.message; } finally { test.disabled = false; } };
    detail.append(detailHeader(channel, status, [test, configureAction('web-search', '配置渠道')]), nav, panes);
    paneById.get('basic').append(
      el('div', { class: 'channel-section-intro' }, el('h3', { text: '搜索服务' }), el('p', { text: '为新话题提供近期公开内容与可查看来源。' })),
      keyValue('启用状态', status.label), keyValue('当前服务', status.provider || 'SearXNG'), keyValue('最近测试', status.lastTest || '尚未测试'),
      el('div', { class: 'channel-inline-actions' }, message)
    );
    paneById.get('rules').append(
      el('div', { class: 'channel-section-intro' }, el('h3', { text: '使用规则' }), el('p', { text: '查询不包含联系人姓名、聊天原文和私人经历；结果会去重并保留来源编号。' })),
      el('label', { class: 'channel-rule-row' }, el('input', { type: 'checkbox', checked: status.enabled !== false, disabled: true }), el('span', {}, el('strong', { text: '允许调用联网搜索' }), el('small', { text: '仅在用户选择“聊点新鲜的”时调用' }))),
      el('label', { class: 'channel-rule-row' }, el('input', { type: 'checkbox', checked: true, disabled: true }), el('span', {}, el('strong', { text: '显示来源' }), el('small', { text: '生成卡片时显示标题、摘要和链接' })))
    );
    paneById.get('advanced').append(
      el('div', { class: 'channel-section-intro' }, el('h3', { text: '高级服务设置' }), el('p', { text: '主服务、备用服务、超时和结果数量在设置页统一配置。' })),
      keyValue('缓存策略', '同一查询缓存 15 分钟'), keyValue('时间范围', '默认最近 7 天'), settingAction('web-search', '打开高级设置')
    );
  }

  function renderFuture(id) {
    const channel = FUTURE_CHANNELS.find(item => item.id === id) || FUTURE_CHANNELS[0];
    const status = { tone: 'muted', label: '未接入', enabled: false, meta: '规划中' };
    const { nav, panes, paneById } = tabs();
    detail.append(detailHeader(channel, status, [el('button', { class: 'btn btn-sm', type: 'button', text: '暂未开放', disabled: true })]), nav, panes);
    paneById.get('basic').append(el('div', { class: 'channel-empty-state' }, el('strong', { text: `${channel.name} 正在规划中` }), el('p', { text: channel.description + ' 当前版本先保留入口，接入后会在这里提供连接测试和接收规则。' })));
  }

  function renderAdd() {
    empty(detail);
    detail.append(
      el('div', { class: 'channel-add-state' },
        el('span', { class: 'channel-add-icon', text: '+' }),
        el('h2', { text: '添加消息渠道' }),
        el('p', { text: '选择一个渠道后，填写凭据并完成连接测试即可启用。' }),
        el('div', { class: 'channel-add-options' },
          el('button', { class: 'channel-add-option', type: 'button', onclick: () => { state.selected = 'wechat'; renderIndex(); renderDetail('wechat'); } }, channelIcon({ art: 'wechat' }), el('strong', { text: '微信' }), el('small', { text: 'iLink 个人号' })),
          el('button', { class: 'channel-add-option', type: 'button', onclick: () => { state.selected = 'email'; renderIndex(); renderDetail('email'); } }, channelIcon({ art: 'email' }), el('strong', { text: '邮件' }), el('small', { text: 'IMAP / SMTP' })),
          el('button', { class: 'channel-add-option', type: 'button', onclick: () => { state.selected = 'search'; renderIndex(); renderDetail('search'); } }, channelIcon({ art: 'search' }), el('strong', { text: '联网搜索' }), el('small', { text: 'SearXNG / Kimi' }))
        )
      )
    );
  }

  function renderDetail(id = state.selected) {
    empty(detail);
    if (id === 'add') return renderAdd();
    if (id === 'wechat') return renderWechat();
    if (id === 'email') return renderEmail();
    if (id === 'search') return renderSearch();
    return renderFuture(id);
  }

  async function load() {
    const [wxResult, emailResult, searchResult] = await Promise.allSettled([api.wechat.status(), api.email.status(), api.webSearch.status()]);
    const wx = wxResult.status === 'fulfilled' ? (wxResult.value || {}) : {};
    const email = emailResult.status === 'fulfilled' ? (emailResult.value || {}) : {};
    const search = searchResult.status === 'fulfilled' ? (searchResult.value || {}) : {};
    const account = email.account || email.config || {};
    const sync = email.sync || {};
    const emailError = email.error || account.last_error || sync.last_error || '';
    const emailConfigured = !!(email.configured || email.ready || email.connected || account.status === 'connected');
    const emailEnabled = email.enabled === true;
    const emailOnline = email.connected === true && !emailError;
    const emailLabel = emailError ? '连接异常' : emailOnline ? '已连接' : emailEnabled && emailConfigured ? '待连接' : emailEnabled ? '待配置' : '已关闭';
    const emailTone = emailError ? 'error' : emailOnline ? 'info' : emailEnabled ? 'warn' : 'muted';
    const searchEnabled = search.enabled === true;
    state.channels = new Map([
      ['wechat', { enabled: !!wx.configured, tone: wx.configured ? 'info' : 'warn', label: wx.configured ? '已连接' : '未配置', meta: wx.configured ? `账号 ${wx.accountId || '已登录'}` : '扫码登录后收发消息', account: wx.accountId, lastSync: '实时连接', raw: wx }],
      ['email', { enabled: emailEnabled, tone: emailTone, label: emailLabel, meta: emailError || (email.lastSyncAt || sync.last_sync_at ? `最近成功同步于 ${formatTime(email.lastSyncAt || sync.last_sync_at)}` : '尚未同步'), account: account.address || email.address, lastSync: formatTime(email.lastSyncAt || sync.last_sync_at), enabled: emailEnabled, importantPush: email.importantPush, cursor: sync.cursor, queue: email.queue, error: emailError, errorAt: emailError && account.updated_at ? formatTime(account.updated_at) : '' }],
      ['search', { enabled: searchEnabled, tone: search.ready ? 'info' : (searchEnabled ? 'warn' : 'muted'), label: search.ready ? '已启用' : (searchEnabled ? '待配置' : '已关闭'), meta: search.provider === 'moonshot' ? '当前服务 Kimi' : '当前服务 SearXNG', provider: search.provider === 'moonshot' ? 'Kimi' : 'SearXNG', lastTest: search.lastTest?.at ? formatTime(search.lastTest.at) : '尚未测试' }]
    ]);
    FUTURE_CHANNELS.forEach(channel => state.channels.set(channel.id, { enabled: false, tone: 'muted', label: '未接入', meta: '规划中' }));
    state.loaded = true;
    renderIndex();
    renderDetail(state.selected);
  }

  load();
  return { show: load, hide() {} };
}
