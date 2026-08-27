'use strict';

const { loadConfig, deepMerge } = require('../../lib/config');
const { chatCompletion } = require('../../engine/client');
const { resolveProvider } = require('../../engine/providers');

module.exports = (router, ctx) => {
  router.post('/api/engine/test', async (req, res) => {
    let cfg = ctx.config || loadConfig();
    const body = JSON.parse((await ctx.readBody(req)) || '{}');
    if (body && body.engine) cfg = deepMerge(cfg, { engine: body.engine });
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
