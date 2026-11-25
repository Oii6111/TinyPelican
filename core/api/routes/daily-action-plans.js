'use strict';

module.exports = (router, ctx) => {
  router.post('/api/daily-actions/:id/plan', async (req, res, config, params) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.headers['sec-fetch-site'] === 'cross-site'
        || (req.headers.origin && req.headers.origin !== new URL('http://' + req.headers.host).origin)) {
      return ctx.json(res, 403, { error: '请从首页打开今日行动计划。' });
    }
    let body;
    try { body = JSON.parse((await ctx.readBody(req)) || '{}'); }
    catch { return ctx.json(res, 400, { error: '行动请求格式无效。' }); }
    if (!body || typeof body !== 'object' || Array.isArray(body) || (body.recreate !== undefined && typeof body.recreate !== 'boolean')) {
      return ctx.json(res, 400, { error: '行动请求格式无效。' });
    }
    const result = await require('../../social/daily-action-plan').open(params.id, { recreate: body.recreate === true });
    return ctx.json(res, result.status || 200, result);
  });
};
