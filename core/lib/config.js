// 小鹈鹕核心 — 配置加载
// 统一从 config.json 读取配置并合并默认值。
'use strict';

const fs = require('fs');
const { getPaths } = require('./paths');

const DEFAULTS = {
  selfNicknames: [],
  pollMs: 700,
  debounceMs: 5000,
  minMatchLines: 2,
  inboxMaxLines: 500,
  relationCheck: { enabled: true, days: 7 },
  intent: {
    agent: 'intent',
    highConfidence: 0.85,
    mediumConfidence: 0.5,
    maxMessagesPerBatch: 50,
    agentTimeoutMs: 120000,
    minIntervalMinutes: 0
  },
  reminder: {
    deadlineLeadDays: [1],
    deadlineLeadHours: [2],
    scheduleLeadMinutes: 30
  },
  doNotDisturb: {
    enabled: true,
    start: '23:00',
    end: '08:00'
  },
  weixinPush: {
    enabled: false,
    notifyComplete: true,
    accountId: '',
    to: ''
  },
  engine: {
    provider: 'siliconflow',
    providers: {
      siliconflow: { baseUrl: 'https://api.siliconflow.cn/v1', apiKey: '', model: 'Qwen/Qwen3.5-9B' },
      openai: { baseUrl: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-4o-mini' },
      deepseek: { baseUrl: 'https://api.deepseek.com/v1', apiKey: '', model: 'deepseek-chat' },
      ollama: { baseUrl: 'http://127.0.0.1:11434/v1', apiKey: '', model: 'qwen3:8b' },
      custom: { baseUrl: '', apiKey: '', model: '' }
    },
    timeoutMs: 120000,
    retries: 2
  },
  proactivity: {
    level: 'L2'
  },
  capture: {
    enabled: false
  },
  heartbeat: {
    intervalSec: 30
  }
};

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// 深合并：对象递归合并，数组/标量以配置值为准
function deepMerge(base, patch) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const key of Object.keys(patch || {})) {
    const pv = patch[key];
    if (isPlainObject(pv) && isPlainObject(out[key])) {
      out[key] = deepMerge(out[key], pv);
    } else {
      out[key] = pv;
    }
  }
  return out;
}

function loadConfig(configPath) {
  const p = configPath || getPaths().config;
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {}
  return deepMerge(DEFAULTS, raw);
}

module.exports = { DEFAULTS, deepMerge, loadConfig };
