'use strict';

const { listEditions, resolveEdition, saveActiveEdition, editionDataDir } = require('../../lib/editions');

module.exports = (router, ctx) => {
  router.get('/api/edition', (req, res) => ctx.json(res, 200, {
    active: ctx.publicEdition(ctx.edition),
    editions: listEditions(ctx.projectRoot),
    restartRequired: true
  }));

  router.post('/api/edition/activate', async (req, res) => {
    let body;
    try { body = JSON.parse((await ctx.readBody(req)) || '{}'); } catch { return ctx.json(res, 400, { error: '预设码格式无效' }); }
    const manifest = resolveEdition(ctx.projectRoot, body.code || body.editionId);
    if (!manifest) return ctx.json(res, 400, { error: '预设码无效或版本包不存在' });
    if (manifest.id === ctx.edition.id) return ctx.json(res, 200, { ok: true, active: ctx.publicEdition(manifest), restarting: false });
    saveActiveEdition(ctx.stableUserData, manifest);
    if (typeof ctx.onEditionChange === 'function') ctx.onEditionChange(manifest);
    return ctx.json(res, 200, { ok: true, active: ctx.publicEdition(manifest), dataDir: editionDataDir(ctx.stableUserData, manifest), restarting: true });
  });
};
