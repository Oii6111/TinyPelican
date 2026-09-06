'use strict';

const schedules = require('../../memory/stores/schedules');

module.exports = (router, ctx) => {
  router.get('/api/schedules', (req, res, c, p, url) => {
    const status = url.searchParams.get('status') || '';
    return ctx.json(res, 200, schedules.listSchedules(status ? { status } : {}));
  });

  router.post('/api/schedules', async (req, res) => {
    const body = JSON.parse((await ctx.readBody(req)) || '{}');
    const schedule = schedules.createSchedule(body);
    if (!schedule) return ctx.json(res, 400, { ok: false, error: '日程标题和开始时间不能为空' });
    return ctx.json(res, 201, { ok: true, schedule });
  });

  router.post('/api/schedules/:id', async (req, res, c, params) => {
    const body = JSON.parse((await ctx.readBody(req)) || '{}');
    const schedule = schedules.updateSchedule(params.id, body);
    if (!schedule) return ctx.json(res, 404, { ok: false, error: '日程不存在或缺少开始时间' });
    return ctx.json(res, 200, { ok: true, schedule });
  });

  router.delete('/api/schedules/:id', (req, res, c, params) => {
    const ok = schedules.deleteSchedule(params.id);
    if (!ok) return ctx.json(res, 404, { ok: false, error: '日程不存在' });
    return ctx.json(res, 200, { ok: true });
  });
};
