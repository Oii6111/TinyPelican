'use strict';

const { readIntents, saveIntents } = require('../../memory/stores/intents');

module.exports = (router, ctx) => {
  router.get('/api/intents', (req, res, c, p, url) => {
    const items = readIntents();
    const status = url.searchParams.get('status');
    return ctx.json(res, 200, status ? items.filter((x) => x.status === status) : items);
  });

  router.post('/api/intents/:id', async (req, res, c, params) => {
    const body = JSON.parse((await ctx.readBody(req)) || '{}');
    const items = readIntents();
    const target = items.find((x) => x.id === params.id);
    if (!target) return ctx.json(res, 404, { error: 'not found' });
    if (body.status) target.status = body.status;
    if (body.summary) target.summary = String(body.summary);
    if (body.dueAt !== undefined) target.dueAt = body.dueAt;
    if (body.dueText !== undefined) target.dueText = String(body.dueText);
    target.updatedAt = new Date().toISOString();
    saveIntents(items);
    return ctx.json(res, 200, { ok: true, intent: target });
  });
};
