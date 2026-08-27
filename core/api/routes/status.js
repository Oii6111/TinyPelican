'use strict';

const { getStatus } = require('../../status');
const { markRead } = require('../../memory/stores/unread');

module.exports = (router, ctx) => {
  router.get('/api/status', (req, res) => {
    const cfg = ctx.config || require('../../lib/config').loadConfig();
    return ctx.json(res, 200, {
      version: ctx.version,
      ...getStatus(cfg)
    });
  });

  router.post('/api/unread/read', (req, res) => {
    markRead();
    return ctx.json(res, 200, { ok: true });
  });
};
