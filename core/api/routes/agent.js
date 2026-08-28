'use strict';

const { createTask, getTask, listTasks } = require('../../agent/tasks');
const queue = require('../../agent/queue');

module.exports = (router, ctx) => {
  router.get('/api/agent/queue', (req, res) => {
    const status = (new URL(req.url, 'http://local')).searchParams.get('status') || '';
    return ctx.json(res, 200, queue.listQueue(status ? { status } : {}));
  });

  router.post('/api/agent/queue', async (req, res) => {
    const body = JSON.parse((await ctx.readBody(req)) || '{}');
    const item = queue.enqueueTask({
      type: body.type || 'task',
      summary: body.summary || '',
      detail: body.detail || '',
      payload: body.payload || {},
      source: body.source || {}
    });
    if (!item) return ctx.json(res, 400, { ok: false, error: 'summary 不能为空' });
    return ctx.json(res, 201, { ok: true, item });
  });

  router.get('/api/agent/tasks', (req, res) => {
    const limit = parseInt((new URL(req.url, 'http://local')).searchParams.get('limit') || '50', 10);
    return ctx.json(res, 200, listTasks(Math.min(Math.max(limit, 1), 200)));
  });

  router.post('/api/agent/tasks', async (req, res) => {
    const body = JSON.parse((await ctx.readBody(req)) || '{}');
    const taskText = String(body.task || '').trim();
    if (!taskText) {
      return ctx.json(res, 400, { ok: false, error: 'task 不能为空' });
    }
    const task = createTask(taskText, { cwd: body.cwd || null, config: ctx.config || undefined });
    return ctx.json(res, 201, { ok: true, task });
  });

  router.get('/api/agent/tasks/:id', (req, res, c, params, url) => {
    const afterSeq = parseInt(url.searchParams.get('afterSeq') || '0', 10);
    const task = getTask(params.id, Number.isFinite(afterSeq) ? afterSeq : 0);
    if (!task) return ctx.json(res, 404, { ok: false, error: 'not found' });
    return ctx.json(res, 200, { ok: true, task });
  });
};
