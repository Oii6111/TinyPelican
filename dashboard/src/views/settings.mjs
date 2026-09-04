import { api } from '../api.mjs';
import { el, empty } from '../ui.mjs';
import { createWechatLogin } from '../components/wechat-login.mjs';

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

  // 通知渠道
  const NOTIFY_MODES = [
    ['weixin', '微信推送（默认）'],
    ['weixin-then-bark', '微信优先，不可用时 Bark 备用'],
    ['bark', '仅 Bark'],
    ['off', '关闭主动通知']
  ];
  const notifyModeSel = el('select', { class: 'select' }, ...NOTIFY_MODES.map(([v, l]) => el('option', { value: v, text: l })));
  const barkServerInput = el('input', { class: 'input', placeholder: 'https://api.day.app' });
  const barkKeyInput = el('input', { class: 'input', type: 'password', autocomplete: 'off', placeholder: 'Bark Key' });
  const notifyMsg = el('span', { class: 'muted' });
  const notifySaveBtn = el('button', { class: 'btn btn-primary', text: '保存通知设置' });
  const notifyTestBtn = el('button', { class: 'btn btn-edit', text: '发送测试通知' });

  // 模型服务
  const providerSel = el('select', { class: 'select' }, ...PROVIDERS.map(([v, l]) => el('option', { value: v, text: l })));
  const baseUrlInput = el('input', { class: 'input', placeholder: 'https://api.siliconflow.cn/v1' });
  const apiKeyInput = el('input', { class: 'input', type: 'password', autocomplete: 'off', placeholder: 'sk-...' });
  const modelInput = el('input', { class: 'input', placeholder: 'Qwen/Qwen3.5-9B' });
  const engineMsg = el('span', { class: 'muted' });
  const testBtn = el('button', { class: 'btn btn-edit', text: '测试连接' });
  const engineSaveBtn = el('button', { class: 'btn btn-primary', text: '保存模型设置' });
  const engineSaveMsg = el('span', { class: 'muted' });

  // 旧版推送（已弃用，仅兼容）
  const pushChk = el('input', { type: 'checkbox' });
  const completeChk = el('input', { type: 'checkbox' });
  const saveMsg = el('span', { class: 'muted' });

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

  container.append(
    el('div', { class: 'settings-page' },
      el('div', { class: 'card' },
        el('h2', { text: '模型服务（Agent 引擎）' }),
        el('div', { class: 'desc', text: '意图识别、提醒文案、关系建议、看板对话都走这里。支持任意 OpenAI 兼容接口，本地 Ollama 也可以。' }),
        field('服务商', providerSel),
        field('API 地址', baseUrlInput),
        field('API Key', apiKeyInput, '只保存在本地 config.json，不回显完整密钥。'),
        field('模型', modelInput),
        el('div', { class: 'field' }, testBtn, ' ', engineMsg, ' ', engineSaveBtn, ' ', engineSaveMsg)
      ),
      el('div', { class: 'card' },
        el('h2', { text: '微信通道（iLink 扫码登录）' }),
        el('div', { class: 'desc', text: '提醒与消息收发走微信官方 iLink 协议。扫码后凭据写入本地 config.toml，核心会自动重启。' }),
        wxLogin.el
      ),
      el('div', { class: 'card' },
        el('h2', { text: '通知渠道（主动提醒 / 备用推送）' }),
        el('div', { class: 'desc', text: '微信 iLink 的 context_token 需要用户入站消息刷新。选择“微信优先 + Bark 备用”后，微信不可用时重要提醒会转投 Bark。' }),
        field('主动通知模式', notifyModeSel),
        field('Bark Server', barkServerInput),
        field('Bark Key', barkKeyInput, '只保存在本地 config.json，不回显完整密钥。'),
        el('div', { class: 'field' }, notifyTestBtn, ' ', notifySaveBtn, ' ', notifyMsg)
      ),
      el('div', { class: 'card' },
        el('h2', { text: '旧版微信推送（已弃用）' }),
        el('div', { class: 'desc', text: '已被 iLink 通道替代，仅保留兼容开关。' }),
        switchField('启用微信推送', pushChk),
        switchField('导入完成后推送「吃饱啦」消息', completeChk),
        el('div', {}, el('button', { class: 'btn btn-primary', text: '保存', onclick: save }), ' ', saveMsg)
      )
    )
  );

  function enginePatch() {
    const name = providerSel.value;
    return {
      provider: name,
      providers: {
        [name]: {
          baseUrl: baseUrlInput.value.trim(),
          apiKey: apiKeyInput.value.trim(),
          model: modelInput.value.trim()
        }
      }
    };
  }

  // 合并当前配置，只覆盖当前选中的 provider，避免丢掉其它 provider 和 engine 其它字段
  function buildEnginePatch(cur) {
    const name = providerSel.value;
    const providers = { ...((cur && cur.engine && cur.engine.providers) || {}) };
    providers[name] = {
      ...(providers[name] || {}),
      baseUrl: baseUrlInput.value.trim(),
      apiKey: apiKeyInput.value.trim(),
      model: modelInput.value.trim()
    };
    return { provider: name, providers };
  }

  function fillProvider(p) {
    baseUrlInput.value = (p && p.baseUrl) || '';
    apiKeyInput.value = (p && p.apiKey) || '';
    modelInput.value = (p && p.model) || '';
  }

  providerSel.onchange = () => fillProvider(lastProviders[providerSel.value] || {});

  async function load() {
    try {
      const s = await api.settings.get();
      pushChk.checked = !!(s.weixinPush && s.weixinPush.enabled);
      completeChk.checked = !!(s.weixinPush && s.weixinPush.notifyComplete !== false);
      lastProviders = (s.engine && s.engine.providers) || {};
      providerSel.value = (s.engine && s.engine.provider) || 'siliconflow';
      fillProvider(lastProviders[providerSel.value] || {});
      const nt = s.notify || {};
      notifyModeSel.value = nt.mode || 'weixin';
      const bark = nt.bark || {};
      barkServerInput.value = bark.server || 'https://api.day.app';
      barkKeyInput.value = bark.key || '';
    } catch {}
    wxLogin.refresh();
  }

  async function saveEngine() {
    try {
      const cur = await api.settings.get();
      const r = await api.settings.save({ engine: buildEnginePatch(cur) });
      engineSaveMsg.textContent = r && r.restarting ? '已保存 ✓，服务即将自动重启' : '已保存 ✓';
      setTimeout(() => { engineSaveMsg.textContent = ''; }, 2500);
    } catch (e) {
      engineSaveMsg.textContent = '保存失败：' + e.message;
    }
  }

  async function save() {
    try {
      const cur = await api.settings.get();
      const r = await api.settings.save({
        engine: buildEnginePatch(cur),
        weixinPush: { ...(cur.weixinPush || {}), enabled: pushChk.checked, notifyComplete: completeChk.checked }
      });
      saveMsg.textContent = r && r.restarting ? '已保存 ✓，服务即将自动重启' : '已保存 ✓';
      setTimeout(() => { saveMsg.textContent = ''; }, 2500);
    } catch (e) {
      saveMsg.textContent = '保存失败：' + e.message;
    }
  }

  async function saveNotify(showMsg = true) {
    try {
      const cur = await api.settings.get();
      const r = await api.settings.save({
        notify: {
          mode: notifyModeSel.value,
          bark: {
            server: barkServerInput.value.trim() || 'https://api.day.app',
            key: barkKeyInput.value.trim()
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
  notifyTestBtn.onclick = testNotify;

  engineSaveBtn.onclick = saveEngine;
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
