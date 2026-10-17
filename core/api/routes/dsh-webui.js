'use strict';

const dshWeb = require('../../agent/dsh-web-client');
const webAuth = require('../../agent/dsh-web-auth');

module.exports = (router, ctx) => {
  router.post('/api/agent/webui', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const pageUrl = new URL('http://' + req.headers.host);
    if (req.headers['sec-fetch-site'] === 'cross-site'
        || (req.headers.origin && req.headers.origin !== pageUrl.origin)) {
      return ctx.json(res, 403, { error: '请从小鹈鹕对话页面连接 DSH。' });
    }
    const target = new URL(dshWeb.DEFAULT_BASE);
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password
        || target.hostname !== pageUrl.hostname) {
      return ctx.json(res, 400, { error: '请使用与 DSH 相同的本机地址打开小鹈鹕（默认 http://127.0.0.1:18791）。' });
    }
    try {
      const ready = await dshWeb.launchWeb({ waitMs: 120000 });
      if (!ready.ok) return ctx.json(res, 503, { error: 'DSH 尚未就绪，请稍后重试。' });
      let cookie = await webAuth.ensureCookie({ base: dshWeb.DEFAULT_BASE, config: ctx.config });
      const check = () => fetch(target, {
        headers: cookie ? { Cookie: cookie } : {},
        redirect: 'manual',
        signal: AbortSignal.timeout(10000)
      });
      let response = await check();
      if (response.status === 401) {
        await response.body?.cancel();
        cookie = await webAuth.ensureCookie({ base: dshWeb.DEFAULT_BASE, config: ctx.config, force: true });
        response = await check();
      }
      await response.body?.cancel();
      if (response.status === 401 || response.status === 403) {
        return ctx.json(res, 503, { error: 'DSH 登录已失效，请检查 DSH 登录令牌或重启小鹈鹕后重试。' });
      }
      if (response.status !== 200) return ctx.json(res, 503, { error: 'DSH 页面暂时不可用，请稍后重试。' });
      if (cookie) {
        if (!/^dsh-auth-[A-Za-z0-9_-]+=[A-Za-z0-9._-]+$/.test(cookie)) {
          return ctx.json(res, 503, { error: 'DSH 登录凭据格式异常，请重启小鹈鹕后重试。' });
        }
        res.setHeader('Set-Cookie', cookie + '; Path=/; HttpOnly; SameSite=Strict');
      }
      return ctx.json(res, 200, { url: new URL('/dsh/', pageUrl).href });
    } catch {
      return ctx.json(res, 503, { error: '无法连接 DSH，请确认服务正常后重试。' });
    }
  });
};
