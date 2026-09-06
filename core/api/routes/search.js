'use strict';

const chatDb = require('../../memory/chat-db');

// 全局消息检索：不选联系人、直接按关键词搜全部联系人档案
module.exports = (router, ctx) => {
  router.get('/api/search', (req, res, c, p, url) => {
    const q = String(url.searchParams.get('q') || '').trim();
    if (!q) return ctx.json(res, 200, []);
    const contact = String(url.searchParams.get('contact') || '').trim();
    const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '200', 10) || 200, 1), 500);
    return ctx.json(res, 200, chatDb.searchMessages(q, { contact, limit }));
  });
};
