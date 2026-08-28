// 小鹈鹕核心 — 引擎统一入口（直连大模型 API）
// 所有"调用模型"的业务都走这里：按用户配置的 Provider 发请求，带超时与有限重试。
'use strict';

const { loadConfig } = require('../lib/config');
const { resolveProvider, normalizeChatUrl } = require('./providers');

async function chatCompletion(messages, opts = {}) {
  const cfg = opts.config || loadConfig();
  const engine = (cfg && cfg.engine) || {};
  let provider;
  try {
    provider = resolveProvider(cfg);
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }

  const timeoutMs = opts.timeoutMs || engine.timeoutMs || 120000;
  const maxRetries = opts.retries !== undefined ? opts.retries : (engine.retries !== undefined ? engine.retries : 2);
  const url = normalizeChatUrl(provider.baseUrl);
  const headers = { 'Content-Type': 'application/json' };
  if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;

  const body = {
    model: opts.model || provider.model,
    messages,
    temperature: opts.temperature !== undefined ? opts.temperature : 0.2
  };

  let lastErr = null;
  for (let i = 0; i <= maxRetries; i++) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal });
      clearTimeout(timer);
      if (res.ok) {
        const data = await res.json();
        const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
        if (typeof content === 'string' && content.trim()) {
          return { ok: true, text: content.trim(), raw: data, model: data.model || provider.model };
        }
        lastErr = new Error('模型服务返回了空内容');
      } else {
        const text = await res.text().catch(() => '');
        lastErr = new Error(`模型服务返回 ${res.status}：${String(text).slice(0, 200)}`);
        // 4xx（如密钥错误）不重试
        if (res.status >= 400 && res.status < 500) break;
      }
    } catch (e) {
      lastErr = e;
    }
    if (i < maxRetries) await new Promise((r) => setTimeout(r, 500 * (i + 1)));
  }
  return { ok: false, error: lastErr ? String(lastErr.message || lastErr) : '未知错误' };
}

// 按任务执行：取提示词 -> 调用模型 -> 解析输出
async function runTask(taskName, context, opts = {}) {
  const { getTask } = require('./tasks');
  const task = getTask(taskName);
  if (!task) return { ok: false, error: `未知任务：${taskName}` };
  const prompt = task.buildPrompt(context);
  const smallModel = (opts.config && opts.config.engine && opts.config.engine.smallModel) || '';
  const r = await chatCompletion([{ role: 'user', content: prompt }], {
    ...(task.opts || {}),
    ...opts,
    ...(smallModel && !opts.model ? { model: smallModel } : {})
  });
  if (!r.ok) return r;
  return task.parse(r.text, context) || { ok: false, error: '模型输出无法解析' };
}

module.exports = { chatCompletion, runTask };
