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
