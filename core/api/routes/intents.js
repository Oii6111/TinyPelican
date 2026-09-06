'use strict';

const { readIntents, saveIntents } = require('../../memory/stores/intents');
const { confirmIntent } = require('../../engine/intent-actions');

module.exports = (router, ctx) => {
  router.get('/api/intents', (req, res, c, p, url) => {
    const items = readIntents();
    const status = url.searchParams.get('status');
    return ctx.json(res, 200, status ? items.filter((x) => x.status === status) : items);
  });

  router.post('/api/intents/:id/confirm', async (req, res, c, params) => {
    const result = confirmIntent(params.id);
    return ctx.json(res, result.status || 200, result.ok ? result : { ok: false, error: result.error });
  });

  router.post('/api/intents/:id', async (req, res, c, params) => {
    const body = JSON.parse((await ctx.readBody(req)) || '{}');
    const items = readIntents();
    const target = items.find((x) => x.id === params.id);
    if (!target) return ctx.json(res, 404, { error: 'not found' });
    if (body.status) target.status = body.status;
    if (body.summary !== undefined) target.summary = String(body.summary).trim();
    if (body.type && ['todo', 'task', 'deadline', 'schedule', 'reminder', 'waiting_reply'].includes(body.type)) {
      target.type = ['task', 'deadline', 'waiting_reply'].includes(body.type) ? 'todo' : body.type;
    }
    if (body.detail !== undefined) target.detail = String(body.detail);
    if (body.dueAt !== undefined) target.dueAt = body.dueAt;
    if (body.endAt !== undefined) target.endAt = body.endAt;
    if (body.dueText !== undefined) target.dueText = String(body.dueText);
    if (body.recurrence !== undefined) target.recurrence = body.recurrence && typeof body.recurrence === 'object' ? body.recurrence : null;
    if (body.execution !== undefined) target.execution = body.execution && typeof body.execution === 'object' ? body.execution : null;
    target.updatedAt = new Date().toISOString();
    saveIntents(items);
    return ctx.json(res, 200, { ok: true, intent: target });
  });
};
