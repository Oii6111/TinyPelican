import { api } from '../api.mjs';
import { el, empty } from '../ui.mjs';
import { createWechatLogin } from '../components/wechat-login.mjs';
import { memorySettings } from '../components/memory-settings.mjs';

const PROVIDERS = [
  ['siliconflow', 'SiliconFlow（硅基流动）'],
  ['openai', 'OpenAI'],
  ['deepseek', 'DeepSeek'],
  ['ollama', 'Ollama（本地）'],
  ['custom', '自定义（OpenAI 兼容）']
];

// 设置板块的归属：一个用户问题 = 一个分组（导航按这个顺序渲染）。
// 板块自己声明 id，分组用 id 列表引用；新增板块必须挂进某个分组，否则会被兜底到「其他」并告警。
const GROUPS = [
  { label: '连接与账号', ids: ['model', 'channels', 'web-search'] },
  { label: '记忆与画像', ids: ['capture', 'contacts'] },
  { label: '回复与表达', ids: ['reply-suggestions'] },
  { label: '主动与提醒', ids: ['proactive'] },
  { label: '高级与排障', ids: ['advanced'] }
];

// 子页面直达：外部入口与旧链接用「子页面 id」跳转，落到对应的「板块 + 子页」
const SUBPAGE_ALIASES = {
  wechat: ['channels', 'wechat'],
  email: ['channels', 'email'],
  notify: ['channels', 'notify'],
  persona: ['reply-suggestions', 'persona'],
  'profile-update': ['contacts', null]
};

const PROACTIVITY_LEVELS = [
  ['L0', 'L0 · 静默准备'],
  ['L1', 'L1 · 提示'],
  ['L2', 'L2 · 建议'],
  ['L3', 'L3 · 确认后执行'],
  ['L4', 'L4 · 自动执行']
];

export function mount(container, ctx = {}) {
  empty(container);
  container.className = 'settings-modal-host';
  let lastProviders = {};
  // 挂载完成前，子页签的自动选中会回调到这里；用这个门闩避免在变量初始化前访问它们
  let ready = false;
  const wxLogin = createWechatLogin();
  const selfInput = el('input', { class: 'input', placeholder: '多个昵称用逗号分隔' });
  const captureChk = el('input', { type: 'checkbox' });
  const captureMsg = el('span', { class: 'muted', role: 'status' });
  const captureSaveBtn = el('button', { class: 'btn btn-primary', text: '保存记忆输入设置' });

  const personaInput = el('textarea', {
    class: 'input',
    rows: 6,
    maxlength: '12000',
    placeholder: '例如：我是一个说话直接但友善的人，习惯短句，偶尔使用“哈哈”，不喜欢夸张和客套。'
  });
  const personaMsg = el('span', { class: 'muted' });
  const personaSaveBtn = el('button', { class: 'btn btn-primary', text: '保存人设' });

  // 回复建议：只在复制聊天后生成草稿，参数决定一次给几组、每组多长、浮窗留多久。
  const replyEnabledChk = el('input', { type: 'checkbox' });
  const replyCount = el('input', { class: 'input', type: 'number', min: '1', max: '4', placeholder: '3' });
  const replyPerPlan = el('input', { class: 'input', type: 'number', min: '1', max: '12', placeholder: '4' });
  const replyMsgChars = el('input', { class: 'input', type: 'number', min: '8', max: '400', placeholder: '40' });
  const replyOptionChars = el('input', { class: 'input', type: 'number', min: '20', max: '400', placeholder: '120' });
  const replyExpire = el('input', { class: 'input', type: 'number', min: '30', max: '3600', placeholder: '300' });
  const replyHistory = el('input', { class: 'input', type: 'number', min: '6', max: '40', placeholder: '24' });
  const replyFastTimeout = el('input', { class: 'input', type: 'number', min: '5', max: '600', placeholder: '30' });
  const replyDeepTimeout = el('input', { class: 'input', type: 'number', min: '5', max: '600', placeholder: '120' });
  const replyMsg = el('span', { class: 'muted' });
  const replySaveBtn = el('button', { class: 'btn btn-primary', text: '保存回复建议设置' });

  // 通知渠道
  const NOTIFY_MODES = [
    ['weixin', '微信推送（默认）'],
    ['weixin-then-bark', '微信优先，不可用时 Bark 备用'],
    ['bark', '仅 Bark'],
    ['off', '关闭通知']
  ];
  const notifyModeSel = el('select', { class: 'select' }, ...NOTIFY_MODES.map(([v, l]) => el('option', { value: v, text: l })));
  const barkServerInput = el('input', { class: 'input', placeholder: 'https://api.day.app' });
  const barkKeyInput = el('input', { class: 'input', type: 'password', autocomplete: 'off', placeholder: 'Bark Key' });
  const barkGroupInput = el('input', { class: 'input', placeholder: '小鹈鹕' });
  const barkSubtitleInput = el('input', { class: 'input', placeholder: '通知副标题（可选）' });
  const BARK_LEVELS = [
    ['active', 'active · 普通'],
    ['timeSensitive', 'timeSensitive · 时效性'],
    ['passive', 'passive · 静默'],
    ['critical', 'critical · 强提醒（慎用）']
  ];
  const barkLevelSel = el('select', { class: 'select' }, ...BARK_LEVELS.map(([v, l]) => el('option', { value: v, text: l })));
  const barkSoundInput = el('input', { class: 'input', placeholder: '默认 / minuet / alarm 等' });
  const barkIconInput = el('input', { class: 'input', placeholder: 'https://.../icon.png（可选）' });
  const barkBadgeInput = el('input', { class: 'input', type: 'number', min: '0', placeholder: '0' });
  const barkUrlInput = el('input', { class: 'input', placeholder: '点击通知跳转 URL（可选）' });
  const barkCopyInput = el('input', { class: 'input', placeholder: '长按复制的文本（可选）' });
  const barkAutoCopyChk = el('input', { type: 'checkbox' });
  const barkCallChk = el('input', { type: 'checkbox' });
  const barkArchiveChk = el('input', { type: 'checkbox' });
  const notifyMsg = el('span', { class: 'muted' });
  const notifySaveBtn = el('button', { class: 'btn btn-primary', text: '保存通知设置' });
  const notifyTestBtn = el('button', { class: 'btn btn-edit', text: '发送测试通知' });
  const captureCompleteChk = el('input', { type: 'checkbox' });
  const intentNotifyChk = el('input', { type: 'checkbox' });
  const reminderNotifyChk = el('input', { type: 'checkbox' });
  const relationNotifyChk = el('input', { type: 'checkbox' });
  // Email channel (IMAP receive / SMTP send)
  const emailEnabledChk = el('input', { type: 'checkbox' });
  const emailImportantNotifyChk = el('input', { type: 'checkbox' });
  const emailAddressInput = el('input', { class: 'input', type: 'email', autocomplete: 'off', placeholder: 'you@example.com' });
  const emailUsernameInput = el('input', { class: 'input', autocomplete: 'off', placeholder: 'IMAP / SMTP 用户名' });
  const emailPasswordInput = el('input', { class: 'input', type: 'password', autocomplete: 'off', placeholder: '留空表示保留已保存的授权码' });
  const emailImapHostInput = el('input', { class: 'input', placeholder: 'imap.example.com' });
  const emailImapPortInput = el('input', { class: 'input', type: 'number', min: '1', max: '65535', placeholder: '993' });
  const emailSmtpHostInput = el('input', { class: 'input', placeholder: 'smtp.example.com' });
  const emailSmtpPortInput = el('input', { class: 'input', type: 'number', min: '1', max: '65535', placeholder: '465' });
  const emailTlsChk = el('input', { type: 'checkbox' });
  const emailInitialDaysInput = el('input', { class: 'input', type: 'number', min: '1', max: '3650', placeholder: '30' });
  const emailMsg = el('span', { class: 'muted', role: 'status' });
  const emailSaveBtn = el('button', { class: 'btn btn-primary', text: '保存邮件设置' });
  const emailTestBtn = el('button', { class: 'btn btn-edit', text: '连接测试' });
  const emailSyncBtn = el('button', { class: 'btn btn-ghost', text: '立即同步' });
  const barkSettings = el('details', { class: 'settings-detail notify-bark-settings' },
    el('summary', { text: 'Bark 详细设置' }),
    field('Bark Server', barkServerInput),
    field('Bark Key', barkKeyInput, '只保存在本地 config.json，不回显完整密钥。'),
    field('分组（group）', barkGroupInput, '通知在手机上的分组名。'),
    field('副标题（subtitle）', barkSubtitleInput),
    field('提醒级别（level）', barkLevelSel, 'critical 会强制响铃，请谨慎使用。'),
    field('铃声（sound）', barkSoundInput, '留空为系统默认；可选 minuet、alarm、anticipate 等。'),
    field('图标 URL（icon）', barkIconInput, '仅 iOS 15+ 支持。'),
    field('角标数（badge）', barkBadgeInput),
    field('点击跳转 URL', barkUrlInput),
    field('长按复制内容（copy）', barkCopyInput),
    switchField('自动复制（autoCopy）', barkAutoCopyChk, '收到通知后自动把 copy 内容写入剪贴板。'),
    switchField('持续响铃 30 秒（call）', barkCallChk),
    switchField('保存到通知历史（isArchive）', barkArchiveChk, '默认开启，可在 Bark App 里回看。')
  );

  // 模型服务
  const providerSel = el('select', { class: 'select' }, ...PROVIDERS.map(([v, l]) => el('option', { value: v, text: l })));
  const baseUrlInput = el('input', { class: 'input', placeholder: 'https://api.siliconflow.cn/v1' });
  const apiKeyInput = el('input', { class: 'input', type: 'password', autocomplete: 'off', placeholder: 'sk-...' });
  const modelInput = el('input', { class: 'input', placeholder: 'Qwen/Qwen3.5-9B' });
  const engineMsg = el('span', { class: 'muted' });
  const testBtn = el('button', { class: 'btn btn-edit', text: '测试连接' });
  const engineSaveBtn = el('button', { class: 'btn btn-primary', text: '保存模型设置' });
  const engineSaveMsg = el('span', { class: 'muted' });
  const dshModelHint = el('div', { class: 'hint' });
  const thinkingParams = el('textarea', { class: 'input', rows: 3, placeholder: '{"thinking":{"type":"enabled"}}' });
  const fastParams = el('textarea', { class: 'input', rows: 3, placeholder: '{"thinking":{"type":"disabled"}}' });

  // 提醒与主动（原先只存在于一个没有任何入口的 strategy 页里，这里搬出来）
  const levelSel = el('select', { class: 'select' }, ...PROACTIVITY_LEVELS.map(([v, l]) => el('option', { value: v, text: l })));
  const hbSec = el('input', { class: 'input', type: 'number', min: '5', step: '5', placeholder: '30' });
  const relationChk = el('input', { type: 'checkbox' });
  const relationDays = el('input', { class: 'input', type: 'number', min: '1', max: '365' });
  const dndChk = el('input', { type: 'checkbox' });
  const dndStart = el('input', { class: 'input', type: 'time' });
  const dndEnd = el('input', { class: 'input', type: 'time' });
  const ddlDays = el('input', { class: 'input', placeholder: '如 1,2' });
  const ddlHours = el('input', { class: 'input', placeholder: '如 2' });
  const schedLead = el('input', { class: 'input', type: 'number', min: '0' });
  const proactiveMsg = el('span', { class: 'muted' });
  const proactiveSaveBtn = el('button', { class: 'btn btn-primary', text: '保存提醒与主动设置' });

  // 高级与排障：以前只能改 config.json 的几组旋钮
  const intentHigh = el('input', { class: 'input', type: 'number', min: '0.5', max: '1', step: '0.05', placeholder: '0.85' });
  const intentMedium = el('input', { class: 'input', type: 'number', min: '0.1', max: '0.9', step: '0.05', placeholder: '0.5' });
  const intentBatch = el('input', { class: 'input', type: 'number', min: '1', max: '500', placeholder: '50' });
  const intentScanSec = el('input', { class: 'input', type: 'number', min: '0', placeholder: '0' });
  const pollMsInput = el('input', { class: 'input', type: 'number', min: '100', max: '5000', placeholder: '700' });
  const minMatchLinesInput = el('input', { class: 'input', type: 'number', min: '1', max: '20', placeholder: '2' });
  const replyTimeoutInput = el('input', { class: 'input', type: 'number', min: '10', max: '1800', placeholder: '180' });
  const queueIntervalInput = el('input', { class: 'input', type: 'number', min: '1', max: '600', placeholder: '10' });
  const queueConcurrentInput = el('input', { class: 'input', type: 'number', min: '1', max: '8', placeholder: '1' });
  const queueTimeoutInput = el('input', { class: 'input', type: 'number', min: '10', max: '3600', placeholder: '300' });
  const dshTokenInput = el('input', { class: 'input', type: 'password', autocomplete: 'off', placeholder: '留空表示不修改' });
  const advancedMsg = el('span', { class: 'muted' });
  const advancedSaveBtn = el('button', { class: 'btn btn-primary', text: '保存高级设置' });

  const advancedMemory = memorySettings({ section, field, switchField, createSubTabs });

  // 板块内部的子页面：一组子页签 + 若干面板，一次只显示一张。
  // 双向渠道（微信/邮件/通知）与记忆输入（微信聊天记录）各用一组，互不影响。
  function createSubTabs(tabs, onSelect = () => {}) {
    let current = tabs[0].id;
    let initialized = false;
    const buttons = new Map();
    const panes = new Map();
    const nav = el('div', { class: 'settings-subnav', role: 'tablist' },
      ...tabs.map(({ id, label }) => {
        const button = el('button', { class: 'settings-subtab', type: 'button', role: 'tab', 'data-subtab': id, text: label, onclick: () => select(id) });
        buttons.set(id, button);
        return button;
      })
    );
    function select(tabId) {
      const id = tabs.some((tab) => tab.id === tabId) ? tabId : current;
      current = id;
      for (const [key, pane] of panes) pane.hidden = key !== id;
      for (const [key, button] of buttons) {
        const active = key === id;
        button.classList.toggle('active', active);
        if (active) button.setAttribute('aria-current', 'page');
        else button.removeAttribute('aria-current');
      }
      onSelect(id);
    }
    return {
      nav,
      select,
      current: () => current,
      pane(tabId, ...content) {
        const pane = el('div', { class: 'settings-subpane', 'data-subpane': tabId, role: 'tabpanel' }, ...content);
        panes.set(tabId, pane);
        // 第一张子页面自动选中：组件（如记忆/联系人）不用记得手动初始化，也不会出现「有子页签但一个都没选中」
        if (!initialized) {
          initialized = true;
          select(tabId);
        }
        return pane;
      }
    };
  }

  function field(label, inputEl, hint = '') {
    return el('div', { class: 'field' },
      el('label', { text: label }),
      inputEl,
      hint ? el('div', { class: 'hint', text: hint }) : null
    );
  }
  function switchField(label, inputEl, hint = '') {
    return el('div', { class: 'field' },
      el('label', { class: 'switch' }, inputEl, ' ' + label),
      hint ? el('div', { class: 'hint', text: hint }) : null
    );
  }

  // 板块 id 由各板块自己声明（不再靠标题反查），供分组导航与外部跳转（渠道页/邮件页）使用
  function section(id, title, description, ...content) {
    return el('section', { class: 'card settings-section', 'data-settings-section': id, 'aria-labelledby': 'settings-title-' + id },
      el('header', { class: 'settings-section-heading' }, el('span', { class: 'settings-section-title', id: 'settings-title-' + id, text: title }), el('span', { class: 'settings-section-description', text: description })),
      el('div', { class: 'settings-section-content' }, ...content)
    );
  }

  const modelPanel = section('model', '模型服务', '服务商、模型、API 密钥与连接测试',
    el('div', { class: 'desc', text: '意图识别、提醒文案、关系建议、看板对话都走这里。支持任意 OpenAI 兼容接口，本地 Ollama 也可以。' }),
    field('服务商', providerSel),
    field('API 地址', baseUrlInput),
    field('API Key', apiKeyInput, '只保存在本地 config.json，不回显完整密钥。'),
    field('模型', modelInput),
    el('p', { class: 'hint', text: '快速和思考回复均使用此模型。DeepSeek、SiliconFlow、Ollama 已适配思考开关；其他兼容服务需按服务文档配置下方参数，不支持思考的模型请使用快速模式。' }),
    field('思考模式请求参数（可选 JSON）', thinkingParams, '留空使用内置适配。参数随当前服务保存。'),
    field('快速模式请求参数（可选 JSON）', fastParams, '不支持思考的普通模型可留空；混合模型需明确配置关闭思考。'),
    el('div', { class: 'field' }, testBtn, ' ', engineMsg, ' ', engineSaveBtn, ' ', engineSaveMsg),
    dshModelHint
  );

  // 回复建议：生成参数和「我的人设与表达风格」都是为了让建议更像本人说的，合成一个板块 + 两个子页面。
  const replyTabs = createSubTabs([
    { id: 'generation', label: '生成设置' },
    { id: 'persona', label: '我的人设与表达风格' }
  ]);
  const replyPanel = section('reply-suggestions', '回复建议', '生成设置与表达风格',
    replyTabs.nav,
    replyTabs.pane('generation',
      el('div', { class: 'desc', text: '依赖「记忆输入 → 微信聊天记录」中的剪贴板自动识别。生成结果仅填入输入框，确认后发送。' }),
      switchField('复制聊天后生成回复建议', replyEnabledChk),
      el('div', { class: 'row' }, field('方案组数', replyCount, '1–4，默认 3'), field('每组最多几条消息', replyPerPlan, '1–12，默认 4')),
      el('div', { class: 'row' }, field('每条消息字数上限', replyMsgChars, '8–400，默认 40'), field('每组总字数上限', replyOptionChars, '20–400，默认 120')),
      el('div', { class: 'row' }, field('浮窗有效期（秒）', replyExpire, '30–3600，默认 300'), field('参考的最近聊天条数', replyHistory, '6–40，默认 24')),
      el('div', { class: 'row' }, field('快速模式生成超时（秒）', replyFastTimeout, '默认 30'), field('思考模式生成超时（秒）', replyDeepTimeout, '默认 120')),
      el('div', { class: 'field' }, replySaveBtn, ' ', replyMsg)
    ),
    replyTabs.pane('persona',
      el('div', { class: 'desc', text: '思考模式结合人设与累计聊天总结；快速模式仅使用画像和近期聊天。留空使用默认自然口吻。' }),
      field('人设描述', personaInput, '写下你的身份、常用语气、表达习惯和需要避开的表达；不要填写 API Key 等敏感信息。'),
      el('div', { class: 'field' }, personaSaveBtn, ' ', personaMsg)
    )
  );

  // 双向渠道：微信 / 邮件 / 通知原来各占一个导航项，三件事都属于「渠道」，合成一个板块 + 三个子页面。
  const channelTabs = createSubTabs([
    { id: 'wechat', label: '微信' },
    { id: 'email', label: '邮件' },
    { id: 'notify', label: '通知' }
  ], () => updateWechatStatus());
  const wechatPane = channelTabs.pane('wechat',
    el('div', { class: 'desc', text: '提醒与消息收发走微信官方 iLink 协议。扫码后凭据写入本地 config.toml，核心会自动重启。' }),
    wxLogin.el
  );
  const emailPane = channelTabs.pane('email',
    el('div', { class: 'desc', text: '邮件会先保存到独立数据库再进行分析。广告和噪声仍保留在记忆中，但不会推送提醒。' }),
    switchField('启用邮件收取', emailEnabledChk),
    switchField('推送重要邮件通知', emailImportantNotifyChk, '使用已配置的微信 / Bark 通知渠道。'),
    field('邮箱地址', emailAddressInput),
    field('用户名', emailUsernameInput),
    field('密码 / 应用专用密码', emailPasswordInput, '凭据只保存在本地，接口不会返回完整内容。'),
    el('div', { class: 'row' }, field('IMAP 地址', emailImapHostInput), field('IMAP 端口', emailImapPortInput)),
    el('div', { class: 'row' }, field('SMTP 地址', emailSmtpHostInput), field('SMTP 端口', emailSmtpPortInput)),
    switchField('启用 TLS 并校验证书', emailTlsChk),
    field('首次同步天数', emailInitialDaysInput, '仅在该邮箱没有同步游标时生效。'),
    el('div', { class: 'field' }, emailTestBtn, ' ', emailSyncBtn, ' ', emailSaveBtn, ' ', emailMsg)
  );
  const notifyPane = channelTabs.pane('notify',
    el('div', { class: 'desc', text: '这里统一管理通知。微信 iLink 支持收发消息，Bark 负责单向推送；选择“关闭通知”即可停止通知推送。' }),
    field('通知模式', notifyModeSel),
    switchField('聊天记录录入完成后通知', captureCompleteChk, '默认关闭；重要提醒和待确认事项仍会按当前渠道推送。'),
    switchField('待确认事项通知', intentNotifyChk),
    switchField('提醒通知', reminderNotifyChk),
    switchField('关系维护通知', relationNotifyChk),
    el('p', { class: 'hint', text: '「推送重要邮件通知」在「双向渠道 → 邮件」子页面里设置。' }),
    barkSettings,
    el('div', { class: 'field' }, notifyTestBtn, ' ', notifySaveBtn, ' ', notifyMsg)
  );
  const channelsPanel = section('channels', '双向渠道', '微信 · 邮件 · 通知，一个渠道一个子页面',
    channelTabs.nav,
    wechatPane,
    emailPane,
    notifyPane
  );

  // 记忆输入：目前只有「微信聊天记录」一个子页面（本人昵称 + 剪贴板自动识别导入）。
  // 以后有别的录入方式（语音、文件）就往这里加子页面，不用再占用导航项。
  const memoryTabs = createSubTabs([{ id: 'wechat-chat', label: '微信聊天记录' }]);
  const capturePanel = section('capture', '记忆输入', '聊天记录的来源、识别与自动录入',
    memoryTabs.nav,
    memoryTabs.pane('wechat-chat',
      el('div', { class: 'desc', text: '复制微信聊天记录后，核心按「我的微信昵称」区分你与联系人，自动解析、去重并录入记忆。' }),
      field('我的微信昵称', selfInput, '多个名称以逗号分隔；修改后需重新复制一次聊天记录方可生效。'),
      switchField('启用剪贴板自动识别导入', captureChk, '启用后复制聊天记录将自动解析、去重并录入；关闭后仍可手动导入。'),
      el('div', { class: 'field' }, captureSaveBtn, ' ', captureMsg)
    )
  );

  const proactivePanel = section('proactive', '提醒与主动', '主动程度、提醒时机与免打扰策略',
    el('div', { class: 'desc', text: '设定 Agent 的主动程度、提醒时机与免打扰时段。保存后核心重启一次并生效。' }),
    el('div', { class: 'row' },
      field('全局主动级别', levelSel, 'L0 只准备不打扰 · L2 给建议 · L4 自动执行'),
      field('心跳间隔（秒）', hbSec, '默认 30 秒，扫描环境并更新在线状态')
    ),
    el('div', { class: 'row' }, field('DDL 提前天数', ddlDays, '逗号分隔，如 1,2'), field('DDL 提前小时', ddlHours, '逗号分隔，如 2')),
    field('日程提前分钟', schedLead, '日程开始前多少分钟提醒'),
    switchField('启用免打扰', dndChk, '免打扰时段内不推送主动提醒，结束后补推。'),
    el('div', { class: 'row' }, field('免打扰开始', dndStart), field('免打扰结束', dndEnd, '支持跨天，如 23:00 - 08:00')),
    switchField('启用关系维护提醒', relationChk, '对标记 ⭐ 的联系人，超过“冷落天数”没联系时推送问候建议。'),
    field('冷落天数', relationDays, '例如 7 表示 7 天没联系就提醒。'),
    el('div', { class: 'field' }, proactiveSaveBtn, ' ', proactiveMsg)
  );

  const advancedPanel = section('advanced', '高级与排障', '意图识别阈值、扫描与心跳以外的调度参数、登录令牌',
    el('div', { class: 'desc', text: '以下参数一般无需修改。改动保存后核心重启一次；不确定时请保持默认值。' }),
    el('h3', { text: '待确认意图识别' }),
    el('div', { class: 'row' }, field('高置信度阈值', intentHigh, '≥ 该值直接记为正式事项，默认 0.85'), field('中置信度阈值', intentMedium, '≥ 该值进入待确认，默认 0.5')),
    el('div', { class: 'row' }, field('每批消息上限', intentBatch, '一次送进模型的聊天条数，默认 50'), field('定时扫描间隔（秒）', intentScanSec, '0 = 不主动扫描，只处理新入库消息')),
    el('h3', { text: '剪贴板与调度' }),
    el('div', { class: 'row' }, field('剪贴板轮询间隔（毫秒）', pollMsInput, '默认 700；调小更灵敏、更耗 CPU'), field('最少匹配行数', minMatchLinesInput, '判定为一段聊天的行数门槛，默认 2')),
    el('div', { class: 'row' }, field('回复等待超时（秒）', replyTimeoutInput, '默认 180'), field('任务队列间隔（秒）', queueIntervalInput, '默认 10')),
    el('div', { class: 'row' }, field('队列并发数', queueConcurrentInput, '默认 1'), field('队列任务超时（秒）', queueTimeoutInput, '默认 300')),
    el('h3', { text: '登录令牌' }),
    field('DSH Web 登录令牌', dshTokenInput, '一般留空：核心自己拉起 DSH 时会自动抓取。用户自己启动 DSH 时才需要填日志里的 ?token=。'),
    el('div', { class: 'field' }, advancedSaveBtn, ' ', advancedMsg)
  );

  container.append(
    el('h2', { text: '设置' }),
    el('p', { class: 'desc', text: '设置按用途分为 5 类：连接与账号、记忆与画像、回复与表达、主动与提醒、高级与排障。各板块独立保存；保存后核心将短暂重启（约数秒），会话与看板会自动重连。' }),
    el('div', { class: 'settings-page' },
      modelPanel,
      channelsPanel,
      advancedMemory.panels[0],
      capturePanel,
      advancedMemory.panels[1],
      replyPanel,
      proactivePanel,
      advancedPanel
    )
  );
  const settingsContent = el('div', { class: 'settings-modal-content' });
  const modelSection = modelPanel;
  if (modelSection) {
    const modelContent = modelSection.querySelector('.settings-section-content');
    const advanced = el('details', { class: 'settings-detail' }, el('summary', { text: '高级：思考与快速模式参数' }));
    for (const field of Array.from(modelContent.children)) {
      if (field.querySelector?.('textarea')) advanced.append(field);
    }
    modelContent.append(advanced);
    modelContent.append(el('p', { class: 'hint settings-shared-model', text: '模型提供者、API 地址、密钥和模型统一在这里配置；内置 DSH 与系统共用此配置，无需重复填写。' }));
  }
  settingsContent.append(...Array.from(container.children));
  const settingsNav = el('nav', { class: 'settings-modal-nav', 'aria-label': '设置分类' });
  const settingSections = Array.from(settingsContent.querySelectorAll('.settings-section'));
  // 按钮按分组顺序生成，和 DOM 里的板块顺序不一定一致，所以按 id 对应而不是下标
  const buttonById = new Map();
  let selectedSection = settingSections[0];
  let selectedAgentId = null;
  let agentButtons = [];
  let settingsVisible = false;
  const agentTitle = el('span', { class: 'settings-section-title', text: '对话与 Agent' });
  const agentSettingsHost = el('div', { id: 'dsh-settings-host' });
  const agentPanel = el('section', { class: 'settings-agent-panel', hidden: true },
    el('header', { class: 'settings-section-heading' }, agentTitle), agentSettingsHost);
  const agentNav = el('div', { class: 'settings-agent-nav' });
  const agentStatus = el('p', { class: 'settings-agent-status', text: '正在连接对话配置…', role: 'status' });
  settingsContent.append(agentPanel);
  // 板块 id → 该板块的子页签组（供 selectSection 的子页面直达用）
  const SUBPAGE_TAB_GROUPS = {
    channels: channelTabs,
    'reply-suggestions': replyTabs
  };
  function selectSection(sectionId) {
    // 旧链接与外部入口用子页面 id 直接跳转
    const alias = SUBPAGE_ALIASES[sectionId];
    if (alias) {
      const [targetSection, targetTab] = alias;
      const tabs = SUBPAGE_TAB_GROUPS[targetSection];
      if (tabs && targetTab) tabs.select(targetTab);
      sectionId = targetSection;
    }
    if (sectionId === 'agent:models') sectionId = 'model';
    if (sectionId?.startsWith('agent:')) selectedAgentId = sectionId.slice(6);
    else if (sectionId) selectedAgentId = null;
    selectedSection = settingSections.find((setting) => setting.getAttribute('data-settings-section') === sectionId) || selectedSection;
    settingSections.forEach((setting) => {
      const active = !selectedAgentId && setting === selectedSection;
      setting.hidden = !active;
      const button = buttonById.get(setting.getAttribute('data-settings-section'));
      if (!button) return;
      button.classList.toggle('active', active);
      if (active) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
    agentPanel.hidden = !selectedAgentId;
    for (const item of agentButtons) {
      const active = selectedAgentId === item.id;
      item.button.classList.toggle('active', active);
      if (active) {
        item.button.setAttribute('aria-current', 'page');
        agentTitle.textContent = item.label;
      } else item.button.removeAttribute('aria-current');
    }
    agentSettingsHost.dispatchEvent(new CustomEvent('dsh-settings-select', { detail: settingsVisible ? selectedAgentId : null }));
    if (settingsVisible) updateWechatStatus();
    settingsContent.scrollTop = 0;
  }
  // 分组导航：按 GROUPS 声明的顺序渲染；任何没被分组的板块集中兜底并告警（防止新增板块静默消失）
  const sectionIds = settingSections.map((setting) => setting.getAttribute('data-settings-section'));
  const grouped = new Set(GROUPS.flatMap((group) => group.ids));
  const ungrouped = sectionIds.filter((id) => !grouped.has(id));
  if (ungrouped.length) {
    console.warn('[settings] 这些板块没有归入分组，已放到「其他」：', ungrouped.join(', '));
    GROUPS.push({ label: '其他', ids: ungrouped });
  }
  const panelById = new Map(settingSections.map((setting) => [setting.getAttribute('data-settings-section'), setting]));
  for (const group of GROUPS) {
    const box = el('div', { class: 'settings-nav-group' });
    box.append(el('div', { class: 'settings-nav-group-label', text: group.label }));
    for (const id of group.ids) {
      const panel = panelById.get(id);
      if (!panel) continue;
      const label = panel.querySelector('.settings-section-title')?.textContent || '设置';
      const button = el('button', { class: 'settings-modal-nav-item', type: 'button', text: label });
      button.onclick = () => selectSection(id);
      buttonById.set(id, button);
      box.append(button);
    }
    settingsNav.append(box);
  }
  settingsNav.append(el('div', { class: 'settings-nav-group-label', text: '对话与 Agent' }), agentNav, agentStatus);
  container.addEventListener('dsh-settings-sections', (event) => {
    const labels = { general: '对话偏好', models: 'Agent 模型', plugins: 'Agent 插件' };
    const rows = Array.isArray(event.detail) ? event.detail.filter(row => typeof row.id === 'string' && typeof row.label === 'string' && !['models', 'super-injector-plugins'].includes(row.id)) : [];
    agentButtons = rows.map(row => {
      const label = labels[row.id] || row.label;
      const button = el('button', { class: 'settings-modal-nav-item', type: 'button', text: label, 'data-agent-settings': row.id, onclick: () => selectSection('agent:' + row.id) });
      return { id: row.id, label, button };
    });
    agentNav.replaceChildren(...agentButtons.map(item => item.button));
    agentStatus.hidden = rows.length > 0;
    selectSection();
  });
  container.addEventListener('dsh-settings-open', (event) => ctx.navigate?.('settings', { section: 'agent:' + event.detail }));
  container.addEventListener('dsh-settings-close', () => ctx.closeSettings?.());
  ready = true;
  channelTabs.select('wechat');
  replyTabs.select('generation');
  memoryTabs.select('wechat-chat');
  selectSection();
  const settingsBody = el('div', { class: 'settings-modal-main' }, settingsNav, settingsContent);
  const close = () => ctx.closeSettings?.();
  const closeButton = el('button', { class: 'settings-modal-close', type: 'button', title: '关闭设置', 'aria-label': '关闭设置', text: '×', onclick: close });
  const modal = el('div', { class: 'settings-modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'settings-modal-title' },
    el('header', { class: 'settings-modal-header' },
      el('h2', { id: 'settings-modal-title', text: '设置' }),
      closeButton
    ),
    settingsBody
  );
  container.replaceChildren(modal);
  container.addEventListener('click', (event) => { if (event.target === container) close(); });
  container.addEventListener('keydown', (event) => { if (event.key === 'Escape') close(); });

  function enginePatch() {
    const name = providerSel.value;
    // 输入框留空 = 不修改已保存的 Key（绝不能把掩码当 Key 发出去）
    const apiKey = apiKeyInput.value.trim();
    return {
      provider: name,
      providers: {
        [name]: {
          baseUrl: baseUrlInput.value.trim(),
          ...(apiKey ? { apiKey } : {}),
          model: modelInput.value.trim()
        }
      }
    };
  }

  function updateBarkVisibility() {
    barkSettings.style.display = notifyModeSel.value === 'bark' || notifyModeSel.value === 'weixin-then-bark' ? '' : 'none';
  }

  // 合并当前配置，只覆盖当前选中的 provider，避免丢掉其它 provider 和 engine 其它字段
  // 内置 DSH 用的是「成套」的 provider 配置：模型、地址、Key 缺一不可。
  // 这里提前把它会在 DSH 里用的模型显示出来——不然出现「DSH 里还是上一个模型 / 报 API 密钥无效」很难查。
  function renderDshModel(engine) {
    const providers = (engine && engine.providers) || {};
    const read = (name) => {
      const p = providers[name];
      if (!p) return null;
      const model = String(p.model || '').trim();
      const baseUrl = String(p.baseUrl || '').trim();
      const apiKey = String(p.apiKey || '').trim();
      if (!model || !baseUrl) return null;
      return { name, model, apiKey };
    };
    // 与后端 effectiveEngineProvider 同一套规则：选中的 provider 里 Ollama 不需要 Key；
    // 回退到别的 provider 时必须真的填了 Key（否则会退到没配过的本地 Ollama）
    const picked = read(engine && engine.provider);
    const selected = picked && (picked.apiKey || picked.name === 'ollama') ? picked : null;
    let hit = selected;
    if (!hit) {
      for (const name of ['deepseek', ...Object.keys(providers).filter((n) => n !== 'deepseek')]) {
        const candidate = read(name);
        if (candidate && candidate.apiKey) { hit = candidate; break; }
      }
    }
    if (!hit) {
      dshModelHint.textContent = '⚠ 内置 DSH 还没有可用模型：请至少给一个服务商填好「地址 + 模型 + API Key」，否则在 DSH 里发消息会报「API 密钥无效」。';
      return;
    }
    const fromOther = selected ? '' : `（当前选中的「${(engine && engine.provider) || '未选'}」没有 Key，暂时用它）`;
    dshModelHint.textContent = `内置 DSH 使用：${hit.name} / ${hit.model}${fromOther}`;
  }

  function buildEnginePatch(cur) {
    const name = providerSel.value;
    const providers = { ...((cur && cur.engine && cur.engine.providers) || {}) };
    const apiKey = apiKeyInput.value.trim();
    providers[name] = {
      ...(providers[name] || {}),
      baseUrl: baseUrlInput.value.trim(),
      ...(apiKey ? { apiKey } : {}),
      model: modelInput.value.trim(),
      thinkingBody: parseParams(thinkingParams.value),
      noThinkingBody: parseParams(fastParams.value)
    };
    return { provider: name, providers };
  }

  function fillProvider(p) {
    baseUrlInput.value = (p && p.baseUrl) || '';
    // 不回填掩码串：留空表示沿用已保存的 Key，需要更换时重新粘贴即可
    apiKeyInput.value = '';
    apiKeyInput.placeholder = (p && p.apiKey) ? `已保存（${p.apiKey}）· 留空表示不修改` : 'sk-...';
    modelInput.value = (p && p.model) || '';
    thinkingParams.value = p?.thinkingBody ? JSON.stringify(p.thinkingBody) : '';
    fastParams.value = p?.noThinkingBody ? JSON.stringify(p.noThinkingBody) : '';
  }
  function parseParams(text) {
    if (!text.trim()) return null;
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('思考请求参数必须是 JSON 对象');
    return value;
  }
  function num(inputEl, fallback) {
    const value = Number(String(inputEl.value).trim());
    return Number.isFinite(value) ? value : fallback;
  }
  function listOf(inputEl, fallback) {
    const numbers = String(inputEl.value || '').split(/[,，]/).map((x) => parseInt(x.trim(), 10)).filter((n) => !isNaN(n) && n >= 0);
    return numbers.length ? numbers : fallback;
  }

  providerSel.onchange = () => fillProvider(lastProviders[providerSel.value] || {});

  function updateWechatStatus() {
    if (!ready) return;
    const onWechat = settingsVisible && !selectedAgentId
      && selectedSection?.getAttribute('data-settings-section') === 'channels'
      && channelTabs.current() === 'wechat';
    if (onWechat) wxLogin.refresh();
    else wxLogin.stop();
  }

  async function load() {
    try {
      const s = await api.settings.get();
      advancedMemory.load(s);
      captureChk.checked = !!s.capture?.enabled;
      selfInput.value = (s.selfNicknames || []).join(', ');
      personaInput.value = String(s.userPersona || '');
      lastProviders = (s.engine && s.engine.providers) || {};
      providerSel.value = (s.engine && s.engine.provider) || 'deepseek';
      fillProvider(lastProviders[providerSel.value] || {});
      renderDshModel(s.engine);

      const rs = s.capture?.replySuggestions || {};
      replyEnabledChk.checked = rs.enabled !== false;
      replyCount.value = rs.optionCount ?? 3;
      replyPerPlan.value = rs.maxMessagesPerPlan ?? 4;
      replyMsgChars.value = rs.maxMessageChars ?? 40;
      replyOptionChars.value = rs.maxOptionChars ?? 120;
      replyExpire.value = rs.expireSeconds ?? 300;
      replyHistory.value = rs.maxHistoryMessages ?? 24;
      replyFastTimeout.value = Math.round((rs.timeoutMs ?? 30000) / 1000);
      replyDeepTimeout.value = Math.round((rs.deepTimeoutMs ?? 120000) / 1000);

      levelSel.value = (s.proactivity && s.proactivity.level) || 'L2';
      hbSec.value = (s.heartbeat && s.heartbeat.intervalSec) != null ? s.heartbeat.intervalSec : 30;
      dndChk.checked = !!(s.doNotDisturb && s.doNotDisturb.enabled);
      dndStart.value = (s.doNotDisturb && s.doNotDisturb.start) || '23:00';
      dndEnd.value = (s.doNotDisturb && s.doNotDisturb.end) || '08:00';
      relationChk.checked = !!(s.relationCheck && s.relationCheck.enabled !== false);
      relationDays.value = (s.relationCheck && s.relationCheck.days) || 7;
      const r = s.reminder || {};
      ddlDays.value = (r.deadlineLeadDays || [1]).join(',');
      ddlHours.value = (r.deadlineLeadHours || [2]).join(',');
      schedLead.value = r.scheduleLeadMinutes !== undefined ? r.scheduleLeadMinutes : 30;

      const it = s.intent || {};
      intentHigh.value = it.highConfidence ?? 0.85;
      intentMedium.value = it.mediumConfidence ?? 0.5;
      intentBatch.value = it.maxMessagesPerBatch ?? 50;
      intentScanSec.value = Math.round((it.scanIntervalMs || 0) / 1000);
      pollMsInput.value = s.pollMs ?? 700;
      minMatchLinesInput.value = s.minMatchLines ?? 2;
      const agentCfg = s.agent || {};
      replyTimeoutInput.value = Math.round((agentCfg.reply?.timeoutMs ?? 180000) / 1000);
      queueIntervalInput.value = Math.round((agentCfg.queue?.intervalMs ?? 10000) / 1000);
      queueConcurrentInput.value = agentCfg.queue?.maxConcurrent ?? 1;
      queueTimeoutInput.value = Math.round((agentCfg.queue?.timeoutMs ?? 300000) / 1000);
      dshTokenInput.value = '';
      dshTokenInput.placeholder = agentCfg.dsh?.webToken ? '已保存令牌 · 留空表示不修改' : '留空表示不修改';

      const nt = s.notify || {};
      notifyModeSel.value = nt.mode || 'off';
      updateBarkVisibility();
      captureCompleteChk.checked = !!(nt.events && nt.events.captureComplete);
      intentNotifyChk.checked = nt.events ? nt.events.intent !== false : true;
      reminderNotifyChk.checked = nt.events ? nt.events.reminder !== false : true;
      relationNotifyChk.checked = nt.events ? nt.events.relation !== false : true;
      const bark = nt.bark || {};
      barkServerInput.value = bark.server || 'https://api.day.app';
      barkKeyInput.value = bark.key || '';
      barkGroupInput.value = bark.group || '小鹈鹕';
      barkSubtitleInput.value = bark.subtitle || '';
      barkLevelSel.value = bark.level || 'active';
      barkSoundInput.value = bark.sound || '';
      barkIconInput.value = bark.icon || '';
      barkBadgeInput.value = bark.badge || '';
      barkUrlInput.value = bark.url || '';
      barkCopyInput.value = bark.copy || '';
      barkAutoCopyChk.checked = !!bark.autoCopy;
      barkCallChk.checked = !!bark.call;
      barkArchiveChk.checked = bark.isArchive !== false;
      const email = s.email || {};
      emailEnabledChk.checked = !!email.enabled;
      emailImportantNotifyChk.checked = !!(email.importantPush ?? email.notifyImportant ?? email.importantNotify ?? email.notifications?.important ?? nt.events?.emailImportant);
      emailAddressInput.value = email.address || email.email || '';
      emailUsernameInput.value = email.username || email.imap?.username || email.smtp?.username || '';
      emailPasswordInput.value = '';
      emailPasswordInput.placeholder = (email.imap?.password || email.smtp?.password || email.password || email.passwordConfigured) ? '已保存授权码（留空保持不变）' : '应用专用密码';
      const imap = email.imap || {};
      const smtp = email.smtp || {};
      emailImapHostInput.value = imap.host || email.imapHost || '';
      emailImapPortInput.value = imap.port || email.imapPort || 993;
      emailSmtpHostInput.value = smtp.host || email.smtpHost || '';
      emailSmtpPortInput.value = smtp.port || email.smtpPort || 465;
      emailTlsChk.checked = email.tls !== false && imap.secure !== false && smtp.secure !== false;
      emailInitialDaysInput.value = email.initialDays || email.initialSyncDays || 30;
    } catch {}
    updateWechatStatus();
  }

  async function saveEngine() {
    try {
      const cur = await api.settings.get();
      const r = await api.settings.save({ engine: buildEnginePatch(cur) });
      engineSaveMsg.textContent = r && r.restarting ? '已保存 ✓，核心正在重启' : '已保存 ✓';
      renderDshModel(r && r.engine);
      setTimeout(() => { engineSaveMsg.textContent = ''; }, 2500);
    } catch (e) {
      engineSaveMsg.textContent = '保存失败：' + e.message;
    }
  }

  async function savePersona() {
    try {
      const r = await api.settings.save({ userPersona: personaInput.value.trim() });
      personaMsg.textContent = r && r.restarting ? '已保存 ✓，核心正在重启' : '已保存 ✓';
      setTimeout(() => { personaMsg.textContent = ''; }, 2500);
    } catch (e) {
      personaMsg.textContent = '保存失败：' + e.message;
    }
  }

  async function saveReplySuggestions() {
    replySaveBtn.disabled = true;
    try {
      const r = await api.settings.save({
        capture: {
          replySuggestions: {
            enabled: replyEnabledChk.checked,
            optionCount: num(replyCount, 3),
            maxMessagesPerPlan: num(replyPerPlan, 4),
            maxMessageChars: num(replyMsgChars, 40),
            maxOptionChars: num(replyOptionChars, 120),
            expireSeconds: num(replyExpire, 300),
            maxHistoryMessages: num(replyHistory, 24),
            timeoutMs: num(replyFastTimeout, 30) * 1000,
            deepTimeoutMs: num(replyDeepTimeout, 120) * 1000
          }
        }
      });
      replyMsg.textContent = r && r.restarting ? '已保存 ✓，核心正在重启' : '已保存 ✓';
      setTimeout(() => { replyMsg.textContent = ''; }, 2500);
    } catch (e) {
      replyMsg.textContent = '保存失败：' + e.message;
    } finally {
      replySaveBtn.disabled = false;
    }
  }

  async function saveProactive() {
    proactiveSaveBtn.disabled = true;
    try {
      const days = parseInt(relationDays.value, 10);
      const r = await api.settings.save({
        proactivity: { level: levelSel.value },
        heartbeat: { intervalSec: Math.max(5, num(hbInput, 30)) },
        doNotDisturb: { enabled: dndChk.checked, start: dndStart.value || '23:00', end: dndEnd.value || '08:00' },
        relationCheck: { enabled: relationChk.checked, days: days > 0 ? days : 7 },
        reminder: {
          deadlineLeadDays: listOf(ddlDays, [1]),
          deadlineLeadHours: listOf(ddlHours, [2]),
          scheduleLeadMinutes: Math.max(0, num(schedLead, 30))
        }
      });
      proactiveMsg.textContent = r && r.restarting ? '已保存 ✓，核心正在重启' : '已保存 ✓';
      setTimeout(() => { proactiveMsg.textContent = ''; }, 2500);
    } catch (e) {
      proactiveMsg.textContent = '保存失败：' + e.message;
    } finally {
      proactiveSaveBtn.disabled = false;
    }
  }

  async function saveAdvanced() {
    advancedSaveBtn.disabled = true;
    try {
      const token = dshTokenInput.value.trim();
      const r = await api.settings.save({
        intent: {
          highConfidence: Math.min(1, Math.max(0.5, num(intentHigh, 0.85))),
          mediumConfidence: Math.min(0.9, Math.max(0.1, num(intentMedium, 0.5))),
          maxMessagesPerBatch: Math.max(1, Math.round(num(intentBatch, 50))),
          scanIntervalMs: Math.max(0, Math.round(num(intentScanSec, 0) * 1000))
        },
        pollMs: Math.max(100, Math.round(num(pollMsInput, 700))),
        minMatchLines: Math.max(1, Math.round(num(minMatchLinesInput, 2))),
        agent: {
          reply: { timeoutMs: Math.max(10, num(replyTimeoutInput, 180)) * 1000 },
          queue: {
            intervalMs: Math.max(1, num(queueIntervalInput, 10)) * 1000,
            maxConcurrent: Math.max(1, Math.round(num(queueConcurrentInput, 1))),
            timeoutMs: Math.max(10, num(queueTimeoutInput, 300)) * 1000
          },
          ...(token ? { dsh: { webToken: token } } : {})
        }
      });
      advancedMsg.textContent = r && r.restarting ? '已保存 ✓，核心正在重启' : '已保存 ✓';
      if (token) { dshTokenInput.value = ''; dshTokenInput.placeholder = '已保存令牌 · 留空表示不修改'; }
      setTimeout(() => { advancedMsg.textContent = ''; }, 2500);
    } catch (e) {
      advancedMsg.textContent = '保存失败：' + e.message;
    } finally {
      advancedSaveBtn.disabled = false;
    }
  }

  async function saveNotify(showMsg = true) {
    try {
      const cur = await api.settings.get();
      // 「推送重要邮件通知」只归「双向渠道 → 邮件」管，这里不写 email.importantPush / notify.events.emailImportant
      const r = await api.settings.save({
        notify: {
          mode: notifyModeSel.value,
          events: {
            captureComplete: captureCompleteChk.checked,
            intent: intentNotifyChk.checked,
            reminder: reminderNotifyChk.checked,
            relation: relationNotifyChk.checked
          },
          bark: {
            server: barkServerInput.value.trim() || 'https://api.day.app',
            key: barkKeyInput.value.trim(),
            group: barkGroupInput.value.trim(),
            subtitle: barkSubtitleInput.value.trim(),
            level: barkLevelSel.value,
            sound: barkSoundInput.value.trim(),
            icon: barkIconInput.value.trim(),
            badge: parseInt(barkBadgeInput.value, 10) || 0,
            url: barkUrlInput.value.trim(),
            copy: barkCopyInput.value.trim(),
            autoCopy: barkAutoCopyChk.checked,
            call: barkCallChk.checked,
            isArchive: barkArchiveChk.checked
          }
        }
      });
      if (showMsg) {
        notifyMsg.textContent = r && r.restarting ? '已保存 ✓，核心正在重启' : '已保存 ✓';
        setTimeout(() => { notifyMsg.textContent = ''; }, 2500);
      }
      return r;
    } catch (e) {
      notifyMsg.textContent = '保存失败：' + e.message;
      return null;
    }
  }

  async function testNotify() {
    notifyMsg.textContent = '保存并发送测试…';
    const r = await saveNotify(false);
    if (!r) return;
    try {
      const d = await api.notify.test();
      notifyMsg.textContent = d.ok
        ? '测试通知已发送（' + d.channel + '）✓'
        : '测试失败：' + (d.error || '未知');
      setTimeout(() => { notifyMsg.textContent = ''; }, 5000);
    } catch (e) {
      notifyMsg.textContent = '测试失败：' + e.message;
    }
  }

  function emailPatch() {
    const password = emailPasswordInput.value.trim();
    return {
      enabled: emailEnabledChk.checked,
      importantPush: emailImportantNotifyChk.checked,
      address: emailAddressInput.value.trim(),
      initialDays: Number(emailInitialDaysInput.value) || 30,
      imap: {
        host: emailImapHostInput.value.trim(),
        port: Number(emailImapPortInput.value) || 993,
        secure: emailTlsChk.checked,
        rejectUnauthorized: emailTlsChk.checked,
        username: emailUsernameInput.value.trim(),
        ...(password ? { password } : {})
      },
      smtp: {
        host: emailSmtpHostInput.value.trim(),
        port: Number(emailSmtpPortInput.value) || 465,
        secure: emailTlsChk.checked,
        rejectUnauthorized: emailTlsChk.checked,
        username: emailUsernameInput.value.trim(),
        ...(password ? { password } : {})
      }
    };
  }

  async function saveEmail(showMessage = true) {
    try {
      // 重要邮件通知的唯一写入点：核心同时读 email.importantPush（邮件服务是否推送）
      // 与 notify.events.emailImportant（通知渠道是否放行），两个键必须一起写、保持一致。
      const result = await api.settings.save({
        email: emailPatch(),
        notify: { events: { emailImportant: emailImportantNotifyChk.checked } }
      });
      if (showMessage) {
        emailMsg.textContent = result?.restarting ? '已保存，核心将重新连接。' : '邮件设置已保存。';
        setTimeout(() => { emailMsg.textContent = ''; }, 3500);
      }
      return result;
    } catch (error) {
      emailMsg.textContent = '保存失败：' + error.message;
      return null;
    }
  }

  emailSaveBtn.onclick = () => saveEmail(true);
  emailTestBtn.onclick = async () => {
    emailTestBtn.disabled = true;
    emailMsg.textContent = '正在测试 IMAP / SMTP…';
    try {
      const result = await api.email.test(emailPatch());
      emailMsg.textContent = result?.ok ? 'IMAP / SMTP 连接成功。' : (result?.error || '连接测试失败。');
    } catch (error) { emailMsg.textContent = '连接测试失败：' + error.message; }
    finally { emailTestBtn.disabled = false; }
  };
  emailSyncBtn.onclick = async () => {
    emailSyncBtn.disabled = true;
    emailMsg.textContent = '正在启动邮件同步…';
    try {
      const result = await api.email.sync();
      emailMsg.textContent = result?.queued || result?.ok ? '邮件同步已启动。' : (result?.error || '无法启动同步。');
    } catch (error) { emailMsg.textContent = '同步失败：' + error.message; }
    finally { emailSyncBtn.disabled = false; }
  };

  notifySaveBtn.onclick = () => saveNotify(true);
  captureSaveBtn.onclick = async () => {
    captureSaveBtn.disabled = true;
    try {
      const result = await api.settings.save({
        selfNicknames: [...new Set(selfInput.value.split(/[,，\n]/).map((name) => name.trim()).filter(Boolean))],
        capture: { enabled: captureChk.checked }
      });
      captureMsg.textContent = result.restarting ? '已保存，核心正在重启' : '已保存';
    } catch (error) {
      captureMsg.textContent = '保存失败：' + error.message;
    } finally {
      captureSaveBtn.disabled = false;
    }
  };
  replySaveBtn.onclick = saveReplySuggestions;
  proactiveSaveBtn.onclick = saveProactive;
  advancedSaveBtn.onclick = saveAdvanced;
  notifyTestBtn.onclick = testNotify;
  notifyModeSel.onchange = updateBarkVisibility;

  engineSaveBtn.onclick = saveEngine;
  personaSaveBtn.onclick = savePersona;
  testBtn.onclick = async () => {
    engineMsg.textContent = '测试中…';
    try {
      const d = await api.engine.test(enginePatch());
      engineMsg.textContent = d.ok
        ? '连接正常 ✓（' + (d.model || '') + ' · ' + d.latencyMs + 'ms）'
        : '失败：' + (d.error || '未知');
    } catch (e) {
      engineMsg.textContent = '失败：' + e.message;
    }
  };

  return {
    show(params = {}) {
      settingsVisible = true;
      const requestedSection = params.section || sessionStorage.getItem('settings-section');
      sessionStorage.removeItem('settings-section');
      selectSection(requestedSection);
      load();
    },
    hide() {
      settingsVisible = false;
      wxLogin.stop();
      agentSettingsHost.dispatchEvent(new CustomEvent('dsh-settings-select', { detail: null }));
    }
  };
}
