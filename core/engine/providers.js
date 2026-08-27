// 小鹈鹕核心 — 模型服务商（Provider）配置
// 内置常用预设，也支持任意 OpenAI 兼容端点；未配置时兼容旧版 intent.api / OpenClaw 配置。
'use strict';

const fs = require('fs');
const path = require('path');

const PRESETS = {
  siliconflow: { baseUrl: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen3.5-9B' },
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  deepseek: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  ollama: { baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen3:8b' },
  custom: { baseUrl: '', model: '' }
};

// 兼容旧配置：intent.api（直接配置）或 ~/.openclaw/openclaw.json 里的 siliconflow
function legacyApi(cfg) {
  const fromCfg = (cfg.intent && cfg.intent.api) || {};
  if (fromCfg.apiKey && fromCfg.model) {
    return {
      baseUrl: fromCfg.baseUrl || 'https://api.siliconflow.cn/v1',
      apiKey: fromCfg.apiKey,
      model: fromCfg.model
    };
  }
  try {
    const ocPath = path.join(process.env.USERPROFILE || '', '.openclaw', 'openclaw.json');
    const oc = JSON.parse(fs.readFileSync(ocPath, 'utf8'));
    const p = oc.models && oc.models.providers && oc.models.providers.siliconflow;
    if (p && p.apiKey) {
      return {
        baseUrl: p.baseUrl || 'https://api.siliconflow.cn/v1',
        apiKey: p.apiKey,
        model: 'Qwen/Qwen3.5-9B'
      };
    }
  } catch {}
  return null;
}

function resolveProvider(cfg) {
  const engine = (cfg && cfg.engine) || {};
  const name = engine.provider || 'siliconflow';
  const user = (engine.providers && engine.providers[name]) || {};
  const preset = PRESETS[name] || {};
  const p = {
    name,
    baseUrl: String(user.baseUrl || preset.baseUrl || ''),
    apiKey: String(user.apiKey || ''),
    model: String(user.model || preset.model || '')
  };
  // 只有该服务商完全没有用户配置（地址/密钥/模型都为空）时才回退旧配置，
  // 避免"显式选了服务商但没填 Key"时悄悄用旧 OpenClaw 密钥联网。
  const hasUserConfig = !!(user.baseUrl || user.apiKey || user.model);
  if (!p.apiKey && !hasUserConfig) {
    const legacy = legacyApi(cfg);
    if (legacy) {
      if (!p.baseUrl) p.baseUrl = legacy.baseUrl;
      p.apiKey = legacy.apiKey;
      if (!p.model) p.model = legacy.model;
    }
  }
  if (!p.baseUrl) throw new Error(`模型服务「${name}」未配置 API 地址，请在设置页配置`);
  if (!p.apiKey && name !== 'ollama') throw new Error(`模型服务「${name}」未配置 API Key，请在设置页配置`);
  if (!p.model) throw new Error(`模型服务「${name}」未配置模型名，请在设置页配置`);
  return p;
}

function normalizeChatUrl(baseUrl) {
  let u = String(baseUrl).replace(/\/+$/, '');
  if (!/\/chat\/completions$/.test(u)) u += '/chat/completions';
  return u;
}

module.exports = { PRESETS, resolveProvider, normalizeChatUrl, legacyApi };
