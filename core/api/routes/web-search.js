'use strict';

const webSearch = require('../../channels/web-search');
const { loadConfig } = require('../../lib/config');

module.exports = (router, ctx) => {
  let lastTest = null;
  router.get('/api/web-search/status', (req, res) => ctx.json(res, 200, { ...webSearch.status(ctx.config || loadConfig()), lastTest }));
  router.post('/api/web-search/test', async (req, res) => {
    const body = JSON.parse(await ctx.readBody(req) || '{}');
    try {
      const result = await webSearch.search(String(body.query || '最近七天有趣的科技文化新闻').slice(0, 300), ctx.config || loadConfig(), { bypassCache: true });
      lastTest = { ok: true, at: new Date().toISOString() };
      return ctx.json(res, 200, { ok: true, ...result });
    } catch (error) { lastTest = { ok: false, at: new Date().toISOString(), error: error.message }; return ctx.json(res, 502, { error: error.message }); }
  });
};
