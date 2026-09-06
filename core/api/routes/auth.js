'use strict';

const auth = require('../../auth');
const { loadConfig } = require('../../lib/config');

function sendJson(res, code, data, headers = {}) {
  const h = { 'Content-Type': 'application/json; charset=utf-8', ...headers };
  res.writeHead(code, h);
  res.end(JSON.stringify(data));
}

module.exports = (router, ctx) => {
  router.post('/api/auth/login', async (req, res) => {
    let body = {};
    try {
      body = JSON.parse((await ctx.readBody(req)) || '{}');
    } catch {}
    const cfg = ctx.config || loadConfig();
    if (!auth.isEnabled(cfg)) {
      return sendJson(res, 403, { ok: false, error: 'WebUI 未开启登录保护' });
    }
    if (!auth.verify({ username: body.username, password: body.password }, cfg)) {
      return sendJson(res, 401, { ok: false, error: '用户名或密码错误' });
    }
    const token = auth.createSession(String(body.username || '').trim());
    return sendJson(res, 200, { ok: true, username: String(body.username || '').trim() }, {
      'Set-Cookie': auth.sessionCookie(token)
    });
  });

  router.post('/api/auth/logout', (req, res) => {
    auth.destroySession(auth.tokenFromRequest(req));
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': auth.clearCookie() });
  });

  router.get('/api/auth/status', (req, res) => {
    const ok = auth.checkRequest(req);
    return sendJson(res, 200, { ok });
  });
};
