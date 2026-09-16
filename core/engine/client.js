// 小鹈鹕核心 — 引擎统一入口（直连大模型 API）
// 所有"调用模型"的业务都走这里：按用户配置的 Provider 发请求，带超时与有限重试。
'use strict';

const { loadConfig } = require('../lib/config');
const { log } = require('../lib/log');
const { resolveProvider, normalizeChatUrl } = require('./providers');

// 关闭「思考过程」的请求体：不同服务商参数名不同。
// 思考型模型（DeepSeek 混合模型等）在「直接产出 JSON」的任务上会先吐几百上千 token 的思考，
// 实测同一个建议提示词 5.5s -> 1.0s，所以这类任务显式关掉。
function noThinkingBody(provider, engine = {}) {
  const custom = engine.noThinkingBody;
  if (custom && typeof custom === 'object') return custom;
  const hay = `${(provider && provider.name) || ''} ${(provider && provider.baseUrl) || ''}`.toLowerCase();
  if (hay.includes('deepseek')) return { thinking: { type: 'disabled' } };
  if (hay.includes('siliconflow')) return { enable_thinking: false };
  return {};
}

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
  if (opts.thinking === false) Object.assign(body, noThinkingBody(provider, engine));

  let lastErr = null;
  for (let i = 0; i <= maxRetries; i++) {
    const startedAt = Date.now();
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal });
      clearTimeout(timer);
      if (res.ok) {
        const data = await res.json();
        const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
        if (typeof content === 'string' && content.trim()) {
          const usage = (data && data.usage) || {};
          // 记一条耗时：以后判断「慢」是模型慢还是本地慢，看日志就够了
          log('info', 'engine', `${provider.model} ${Date.now() - startedAt}ms in=${usage.prompt_tokens || '?'} out=${usage.completion_tokens || '?'}${opts.taskName ? ' task=' + opts.taskName : ''}`);
          return { ok: true, text: content.trim(), raw: data, model: data.model || provider.model, usage };
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
    taskName,
    ...(smallModel && !opts.model ? { model: smallModel } : {})
  });
  if (!r.ok) return r;
  return task.parse(r.text, context) || { ok: false, error: '模型输出无法解析' };
}

module.exports = { chatCompletion, runTask, noThinkingBody };
