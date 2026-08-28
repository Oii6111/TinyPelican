// 回复建议 API：当前建议查询、应用、忽略
'use strict';

const store = require('../../reply/suggestion-store');
const { applySuggestion } = require('../../reply/window-paste');

module.exports = (router, ctx) => {
  router.get('/api/reply-suggestions/current', (req, res) => {
    return ctx.json(res, 200, { suggestion: store.sanitize(store.getCurrent()) });
  });

  router.post('/api/reply-suggestions/:id/apply', async (req, res, c, params) => {
    let body = {};
    try {
      body = JSON.parse((await ctx.readBody(req)) || '{}');
    } catch {}
    const index = body.index;
    const result = await applySuggestion(params.id, index);
    if (result.ok) return ctx.json(res, 200, { ok: true, mode: result.mode });
    if (result.degraded) {
      return ctx.json(res, 200, { ok: false, degraded: true, mode: result.mode || 'clipboard', error: result.error });
    }
    return ctx.json(res, 400, { error: result.error || '建议无效' });
  });

  router.post('/api/reply-suggestions/:id/dismiss', (req, res, c, params) => {
    const ok = store.dismiss(params.id);
    return ctx.json(res, 200, { ok });
  });
};
