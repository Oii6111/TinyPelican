'use strict';

const fs = require('fs');
const path = require('path');
const { getPaths } = require('../../lib/paths');
const { listJsonFiles } = require('../../lib/store');

const P = getPaths();

// 全局消息检索：不选联系人、直接按关键词搜全部联系人档案
module.exports = (router, ctx) => {
  router.get('/api/search', (req, res, c, p, url) => {
    const q = String(url.searchParams.get('q') || '').trim();
    if (!q) return ctx.json(res, 200, []);
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '200', 10), 500);
    const out = [];
    for (const f of listJsonFiles(P.contacts)) {
      let doc;
      try {
        doc = JSON.parse(fs.readFileSync(path.join(P.contacts, f), 'utf8'));
      } catch {
        continue;
      }
      for (const m of doc.messages || []) {
        if (String(m.content || '').includes(q)) {
          out.push({
            contact: doc.name,
            remark: doc.remark || '',
            name: m.name,
            ts: m.ts,
            type: m.type,
            content: m.content
          });
          if (out.length >= limit) break;
        }
      }
      if (out.length >= limit) break;
    }
    return ctx.json(res, 200, out);
  });
};
