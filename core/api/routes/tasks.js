'use strict';

const tasks = require('../../memory/stores/tasks');

module.exports = (router, ctx) => {
  router.get('/api/tasks', (req, res, c, p, url) => {
    const status = url.searchParams.get('status') || '';
    const items = tasks.listTasks(status ? { status } : {});
    return ctx.json(res, 200, items);
  });

  router.post('/api/tasks', async (req, res) => {
    const body = JSON.parse((await ctx.readBody(req)) || '{}');
    const task = tasks.createTask(body);
    if (!task) return ctx.json(res, 400, { ok: false, error: '任务标题不能为空' });
    return ctx.json(res, 201, { ok: true, task });
  });

  router.post('/api/tasks/:id', async (req, res, c, params) => {
    const body = JSON.parse((await ctx.readBody(req)) || '{}');
    const task = tasks.updateTask(params.id, body);
    if (!task) return ctx.json(res, 404, { ok: false, error: '任务不存在' });
    return ctx.json(res, 200, { ok: true, task });
  });

  router.post('/api/tasks/:id/complete', (req, res, c, params) => {
    const task = tasks.completeTask(params.id);
    if (!task) return ctx.json(res, 404, { ok: false, error: '任务不存在' });
    return ctx.json(res, 200, { ok: true, task });
  });

  router.delete('/api/tasks/:id', (req, res, c, params) => {
    const ok = tasks.deleteTask(params.id);
    if (!ok) return ctx.json(res, 404, { ok: false, error: '任务不存在' });
    return ctx.json(res, 200, { ok: true });
  });
};
