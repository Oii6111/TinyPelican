'use strict';

const {
  startLogin, stepStart, stepCheck, stepConfirm, readCredentials, clearCredentials
} = require('../../channels/weixin/login');

module.exports = (router, ctx) => {
  router.get('/api/wechat/status', (req, res) => {
    const creds = readCredentials();
    return ctx.json(res, 200, {
      configured: !!creds,
      accountId: creds ? creds.account_id : '',
      userId: creds ? creds.user_id : ''
    });
  });

  router.post('/api/wechat/login/start', async (req, res) => {
    const key = startLogin();
    const r = await stepStart(key);
    if (!r.ok) return ctx.json(res, 400, r);
    return ctx.json(res, 200, { ok: true, sessionKey: r.sessionKey, qrcodeUrl: r.qrcodeUrl });
  });

  router.get('/api/wechat/login/check', async (req, res, c, p, url) => {
    const r = await stepCheck(url.searchParams.get('session') || '');
    return ctx.json(res, r.ok ? 200 : 400, r);
  });

  router.post('/api/wechat/login/confirm', async (req, res) => {
    const body = JSON.parse((await ctx.readBody(req)) || '{}');
    const r = await stepConfirm(String(body.session || ''));
    if (!r.ok) return ctx.json(res, 400, r);
    if (ctx.onRestart) setTimeout(() => ctx.onRestart(), 800);
    return ctx.json(res, 200, { ok: true, status: 'confirmed', restarting: true });
  });

  router.post('/api/wechat/logout', async (req, res) => {
    clearCredentials();
    if (ctx.onRestart) setTimeout(() => ctx.onRestart(), 800);
    return ctx.json(res, 200, { ok: true, restarting: true });
  });
};
