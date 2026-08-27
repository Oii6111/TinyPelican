'use strict';

const voice = require('../../memory/stores/voice');

module.exports = (router, ctx) => {
  router.get('/api/voice-pending', (req, res) => ctx.json(res, 200, voice.list()));

  router.delete('/api/voice-pending', (req, res, c, p, url) => {
    const idx = parseInt(url.searchParams.get('index') || '0', 10);
    return voice.skip(idx)
      ? ctx.json(res, 200, { ok: true })
      : ctx.json(res, 400, { error: 'bad index' });
  });
};
