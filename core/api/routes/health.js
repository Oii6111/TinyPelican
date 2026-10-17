'use strict';

module.exports = (router, ctx) => {
  router.get('/api/health', (req, res) => {
    return ctx.json(res, 200, {
      ok: true,
      name: 'xiaotihu-core',
      version: ctx.version,
      projectRoot: require('path').resolve(__dirname, '../../..'),
      dataDir: require('../../lib/paths').getPaths().dataDir,
      pid: process.pid,
      time: new Date().toISOString()
    });
  });
};
