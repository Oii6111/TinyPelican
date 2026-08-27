'use strict';

const fs = require('fs');
const { getPaths } = require('../../lib/paths');

const P = getPaths();

function readLogs(limit = 200) {
  try {
    if (!fs.existsSync(P.activityLog)) return [];
    const lines = fs.readFileSync(P.activityLog, 'utf8').split(/\r?\n/).filter(Boolean);
    const out = [];
    for (const line of lines.slice(-Math.min(Math.max(limit, 1), 500))) {
      try { out.push(JSON.parse(line)); } catch {}
    }
    return out;
  } catch {
    return [];
  }
}

module.exports = (router, ctx) => {
  router.get('/api/logs', (req, res, c, p, url) => {
    const limit = parseInt(url.searchParams.get('limit') || '200', 10);
    return ctx.json(res, 200, readLogs(limit));
  });
};
