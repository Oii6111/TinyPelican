'use strict';

const { getStatus } = require('../../status');
const { markRead } = require('../../memory/stores/unread');

module.exports = (router, ctx) => {
  router.get('/api/status', (req, res) => {
    const cfg = ctx.config || require('../../lib/config').loadConfig();
    return ctx.json(res, 200, {
      version: ctx.version,
      ...getStatus(cfg),
      // DSH 后端状态：装了没起来时，这一条能直接告诉用户/客服原因（bin 路径、DSH_HOME、退出码、子进程输出）
      dsh: require('../../agent/dsh-web-client').dshStatus()
    });
  });

  router.post('/api/unread/read', (req, res) => {
    markRead();
    return ctx.json(res, 200, { ok: true });
  });
};
