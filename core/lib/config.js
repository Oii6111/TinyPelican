// 小鹈鹕核心 — 配置加载
// 统一从 config.json 读取配置并合并默认值。
'use strict';

const fs = require('fs');
const { getPaths } = require('./paths');

const DEFAULTS = {
  selfNicknames: [],
  // 剪贴板轮询间隔：调小能让建议回复更快感知到复制（300ms 只比 700ms 多约 1% 单核）
  pollMs: 400,
  minMatchLines: 2,
  relationCheck: { enabled: true, days: 7 },
  intent: {
    agent: 'intent',
    provider: 'deepseek',
    model: '',
    chatTimeoutMs: 120000,
    highConfidence: 0.85,
    mediumConfidence: 0.5,
    maxMessagesPerBatch: 50,
    // 截止时间已经过去这么多天、且模型没说仍然未完成的，不再生成待确认事项
    staleDeadlineDays: 2,
    agentTimeoutMs: 120000,
    minIntervalMinutes: 0,
    scanIntervalMs: 0
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
    // 默认服务商 = DeepSeek：产品的默认模型、内置 DSH 的 llm-deepseek 路由、
    // 意图识别默认（intent.provider=deepseek）都是它，默认值不该是硅基流动的 Qwen。
    provider: 'deepseek',
    providers: {
      siliconflow: { baseUrl: 'https://api.siliconflow.cn/v1', apiKey: '', model: 'Qwen/Qwen3.5-9B' },
      openai: { baseUrl: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-4o-mini' },
      deepseek: { baseUrl: 'https://api.deepseek.com/v1', apiKey: '', model: 'deepseek-chat' },
      ollama: { baseUrl: 'http://127.0.0.1:11434/v1', apiKey: '', model: 'qwen3:8b' },
      custom: { baseUrl: '', apiKey: '', model: '' }
    },
    timeoutMs: 120000,
    retries: 2,
    smallModel: ''
  },
  agent: {
    reply: {
      enabled: true,
      profile: 'tinypelican',
      maxHistory: 12,
      timeoutMs: 180000
    },
    queue: {
      enabled: true,
      intervalMs: 10000,
      maxConcurrent: 1,
      profile: 'tinypelican',
      timeoutMs: 300000
    },
    // DSH WebUI（dsh web）内置鉴权的登录令牌：留空也能用——
    // 由本程序拉起 dsh web 时会自动从启动日志抓取；用户自己启动时，把日志里的 ?token= 填到这里（认证一次即可，cookie 会落盘复用）
    dsh: {
      webToken: ''
    }
  },
  proactivity: {
    level: 'L2'
  },
  capture: {
    enabled: false,
    replySuggestions: {
      enabled: true,
      optionCount: 3,
      // 快速模式（默认，关模型思考）：每组最多 4 条、每条不超过 40 字
      maxMessagesPerPlan: 4,
      maxMessageChars: 40,
      // 深度思考模式（卡片上的 🧠 按钮）：允许更多条、更长内容，也更慢
      deepMaxMessagesPerPlan: 8,
      deepMaxMessageChars: 120,
      deepTimeoutMs: 120000,
      maxHistoryMessages: 24,
      expireSeconds: 300,
      maxOptionChars: 120,
      timeoutMs: 30000
    }
  },
  heartbeat: {
    intervalSec: 30
  },
  notify: {
    mode: 'weixin', // weixin | weixin-then-bark | bark | off
    bark: {
      server: 'https://api.day.app',
      key: '',
      group: '小鹈鹕',
      subtitle: '',
      level: 'active', // active | timeSensitive | passive | critical
      sound: '',
      icon: 'https://cdn.jsdelivr.net/gh/Oii6111/TinyPelican@main/logo2.png',
      badge: 0,
      url: '',
      copy: '',
      autoCopy: false,
      call: false,
      isArchive: true
    }
  },
  auth: {
    enabled: false,
    username: 'admin',
    password: ''
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
