'use strict';

module.exports = (router, ctx) => {
  router.get('/api/health', (req, res) => {
    return ctx.json(res, 200, {
      ok: true,
      name: 'xiaotihu-core',
      version: ctx.version,
      time: new Date().toISOString()
    });
  });
};
