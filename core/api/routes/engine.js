'use strict';

const { loadConfig, deepMerge } = require('../../lib/config');
const { chatCompletion } = require('../../engine/client');
const { resolveProvider } = require('../../engine/providers');
const { restoreMaskedKeys } = require('../models');

module.exports = (router, ctx) => {
  router.post('/api/engine/test', async (req, res) => {
    let cfg = ctx.config || loadConfig();
    const body = JSON.parse((await ctx.readBody(req)) || '{}');
    if (body && body.engine) {
      // 兼容旧前端：如果传进来的是掩码串（sk-****439d），换成已保存的真 Key 再测试，
      // 否则会拿掩码去请求、必然 401，看起来像「Key 无效」。
      const providerName = body.engine.provider || cfg.engine.provider;
      const rawKey = body.engine.providers && body.engine.providers[providerName]
        ? String(body.engine.providers[providerName].apiKey || '')
        : '';
      restoreMaskedKeys(cfg, { engine: body.engine });
      const effectiveKey = body.engine.providers && body.engine.providers[providerName]
        ? String(body.engine.providers[providerName].apiKey || '')
        : '';
      if (providerName !== 'ollama' && rawKey.includes('****') && (!effectiveKey || effectiveKey.includes('****'))) {
        return ctx.json(res, 400, {
          ok: false,
          error: 'API Key 还是掩码占位（' + (rawKey || effectiveKey) + '）：请把完整 Key 粘贴到输入框后再测试'
        });
      }
      cfg = deepMerge(cfg, { engine: body.engine });
    }
    try {
      resolveProvider(cfg);
      const startAt = Date.now();
      const r = await chatCompletion([{ role: 'user', content: '回复两个字：正常' }], { config: cfg, timeoutMs: 30000 });
      if (!r.ok) return ctx.json(res, 400, { ok: false, error: r.error });
      return ctx.json(res, 200, { ok: true, latencyMs: Date.now() - startAt, model: r.model });
    } catch (e) {
      return ctx.json(res, 400, { ok: false, error: String((e && e.message) || e) });
    }
  });
};
