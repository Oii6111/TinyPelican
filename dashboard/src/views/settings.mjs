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

export function mount(container) {
  empty(container);
  container.className = 'view';
  let lastProviders = {};
  const wxLogin = createWechatLogin();
  const captureChk = el('input', { type: 'checkbox' });
  const replyChk = el('input', { type: 'checkbox' });
  const selfInput = el('input', { class: 'input', placeholder: '多个昵称用逗号分隔' });
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
  const advancedMemory = memorySettings(section, field, switchField);

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

  function section(title, description, ...content) {
    return el('details', { class: 'card settings-section' },
      el('summary', {}, el('span', { class: 'settings-section-title', text: title }), el('span', { class: 'settings-section-description', text: description })),
      el('div', { class: 'settings-section-content' }, ...content)
    );
  }

  container.append(
    el('h2', { text: '设置' }),
    el('p', { class: 'desc', text: '点击板块展开配置，每个板块单独保存。收起不会清除当前填写的内容。' }),
    el('div', { class: 'settings-page' },
      section('模型服务', '服务商、模型、API 密钥与连接测试',
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
      ),
      section('记忆输入与回复建议', '剪贴板捕获、本人昵称和回复浮窗',
        switchField('启用剪贴板捕获', captureChk, '复制聊天记录后自动解析、去重并录入记忆。'),
        field('我的微信昵称', selfInput, '多个用逗号分隔，用于区分你与联系人。'),
        switchField('复制聊天后生成回复建议', replyChk, '需启用剪贴板捕获；建议只填入输入框，由你确认发送。'),
        el('div', { class: 'field' }, captureSaveBtn, ' ', captureMsg)
      ),
      ...advancedMemory.panels,
      section('我的人设与表达风格', '用于思考模式回复与关系维护问候',
        el('div', { class: 'desc', text: '思考模式结合人设与累计聊天总结；快速模式仅使用画像和近期聊天。留空使用默认自然口吻。' }),
        field('人设描述', personaInput, '写下你的身份、常用语气、表达习惯和需要避开的表达；不要填写 API Key 等敏感信息。'),
        el('div', { class: 'field' }, personaSaveBtn, ' ', personaMsg)
      ),
      section('微信渠道', '扫码登录、账号状态与退出登录',
        el('div', { class: 'desc', text: '提醒与消息收发走微信官方 iLink 协议。扫码后凭据写入本地 config.toml，核心会自动重启。' }),
        wxLogin.el
      ),
      section('通知设置', '推送渠道、通知类型与 Bark 备用推送',
        el('div', { class: 'desc', text: '这里统一管理通知。微信 iLink 支持收发消息，Bark 负责单向推送；选择“关闭通知”即可停止通知推送。' }),
        field('通知模式', notifyModeSel),
        switchField('聊天记录录入完成后通知', captureCompleteChk, '默认关闭；重要提醒和待确认事项仍会按当前渠道推送。'),
        switchField('待确认事项通知', intentNotifyChk),
        switchField('提醒通知', reminderNotifyChk),
        switchField('关系维护通知', relationNotifyChk),
        barkSettings,
        el('div', { class: 'field' }, notifyTestBtn, ' ', notifySaveBtn, ' ', notifyMsg)
      ),
    )
  );

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

  providerSel.onchange = () => fillProvider(lastProviders[providerSel.value] || {});

  async function load() {
    try {
      const s = await api.settings.get();
      advancedMemory.load(s);
      captureChk.checked = !!s.capture?.enabled;
      replyChk.checked = s.capture?.replySuggestions?.enabled !== false;
      selfInput.value = (s.selfNicknames || []).join(', ');
      personaInput.value = String(s.userPersona || '');
      lastProviders = (s.engine && s.engine.providers) || {};
      providerSel.value = (s.engine && s.engine.provider) || 'deepseek';
      fillProvider(lastProviders[providerSel.value] || {});
      renderDshModel(s.engine);
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
    } catch {}
    wxLogin.refresh();
  }

  async function saveEngine() {
    try {
      const cur = await api.settings.get();
      const r = await api.settings.save({ engine: buildEnginePatch(cur) });
      engineSaveMsg.textContent = r && r.restarting ? '已保存 ✓，服务即将自动重启' : '已保存 ✓';
      renderDshModel(r && r.engine);
      setTimeout(() => { engineSaveMsg.textContent = ''; }, 2500);
    } catch (e) {
      engineSaveMsg.textContent = '保存失败：' + e.message;
    }
  }

  async function savePersona() {
    try {
      const r = await api.settings.save({ userPersona: personaInput.value.trim() });
      personaMsg.textContent = r && r.restarting ? '已保存 ✓，服务即将自动重启' : '已保存 ✓';
      setTimeout(() => { personaMsg.textContent = ''; }, 2500);
    } catch (e) {
      personaMsg.textContent = '保存失败：' + e.message;
    }
  }

  async function saveNotify(showMsg = true) {
    try {
      const cur = await api.settings.get();
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
        notifyMsg.textContent = r && r.restarting ? '已保存 ✓，服务即将自动重启' : '已保存 ✓';
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

  notifySaveBtn.onclick = () => saveNotify(true);
  captureSaveBtn.onclick = async () => {
    captureSaveBtn.disabled = true;
    try {
      const result = await api.settings.save({
        selfNicknames: [...new Set(selfInput.value.split(/[,，\n]/).map((name) => name.trim()).filter(Boolean))],
        capture: { enabled: captureChk.checked, replySuggestions: { enabled: replyChk.checked } }
      });
      captureMsg.textContent = result.restarting ? '已保存，服务即将重启' : '已保存';
    } catch (error) {
      captureMsg.textContent = '保存失败：' + error.message;
    } finally {
      captureSaveBtn.disabled = false;
    }
  };
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
    show() { load(); },
    hide() { wxLogin.stop(); }
  };
}
