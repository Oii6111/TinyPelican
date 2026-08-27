'use strict';

const { getPaths } = require('../../lib/paths');
const { readJson, writeJson } = require('../../lib/store');

const P = getPaths();

function readVoicePending() {
  const data = readJson(P.voicePending, []);
  return Array.isArray(data) ? data : data ? [data] : [];
}

module.exports = (router, ctx) => {
  router.get('/api/voice-pending', (req, res) => ctx.json(res, 200, readVoicePending()));

  router.delete('/api/voice-pending', (req, res, c, p, url) => {
    const idx = parseInt(url.searchParams.get('index') || '0', 10);
    const items = readVoicePending();
    if (idx >= 0 && idx < items.length) {
      items.splice(idx, 1);
      writeJson(P.voicePending, items);
      return ctx.json(res, 200, { ok: true });
    }
    return ctx.json(res, 400, { error: 'bad index' });
  });
};
