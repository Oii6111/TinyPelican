'use strict';

const { loadConfig } = require('../../lib/config');
const { notifyUser } = require('../../notify');

module.exports = (router, ctx) => {
  router.post('/api/notify/test', async (req, res) => {
    const cfg = ctx.config || loadConfig();
    const r = await notifyUser({
      title: '小鹈鹕测试通知',
      message: '如果你看到这条消息，说明当前通知渠道配置可用。',
      config: cfg
    });
    return ctx.json(res, r.ok ? 200 : 400, {
      ok: r.ok,
      channel: r.channel,
      error: r.error || ''
    });
  });
};
