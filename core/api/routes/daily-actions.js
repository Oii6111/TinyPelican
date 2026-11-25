'use strict';

module.exports = (router, ctx, service = require('../../social/daily-actions')) => {
  const sameOrigin = req => {
    const headers = req.headers || {};
    return headers['sec-fetch-site'] !== 'cross-site'
      && (!headers.origin || headers.origin === new URL('http://' + headers.host).origin);
  };
  router.get('/api/daily-actions', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    return ctx.json(res, 200, service.list());
  });
  router.post('/api/daily-actions/generate', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!sameOrigin(req)) return ctx.json(res, 403, { error: '请从首页生成今日行动推荐。' });
    let body;
    try { body = JSON.parse((await ctx.readBody(req)) || '{}'); }
    catch { return ctx.json(res, 400, { error: '请求格式无效。' }); }
    const reshuffle = body?.reshuffle === true;
    const avoid = body?.avoid;
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || (body.contactName !== undefined && typeof body.contactName !== 'string')
      || (body.force !== undefined && typeof body.force !== 'boolean')
      || (body.reshuffle !== undefined && typeof body.reshuffle !== 'boolean')
      || (avoid !== undefined && (!Array.isArray(avoid) || avoid.length > 4 || avoid.some(title => typeof title !== 'string')))
      // 换一批允许不带联系人（整块重来）；单点强刷仍然要求指定联系人。
      || (body.force && !body.contactName && !reshuffle)) {
      return ctx.json(res, 400, { error: '请求格式无效，请从首页重试。' });
    }
    const result = service.generate({
      contactName: body.contactName || '',
      force: body.force === true || reshuffle,
      avoid: Array.isArray(avoid) ? avoid : []
    });
    return ctx.json(res, result.ok ? 202 : result.status || 400, result);
  });
  router.post('/api/daily-actions/:id/feedback', async (req, res, context, params) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!sameOrigin(req)) return ctx.json(res, 403, { error: '请从首页处理今日行动推荐。' });
    let body;
    try { body = JSON.parse((await ctx.readBody(req)) || '{}'); }
    catch { return ctx.json(res, 400, { error: '请求格式无效。' }); }
    const result = service.feedback(params.id, body?.status);
    return ctx.json(res, result.ok ? 200 : result.status || 400, result);
  });
};
