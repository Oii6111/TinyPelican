// 小鹈鹕核心 — 极简路由表（METHOD + /path/:param）
'use strict';

function createRouter() {
  const table = [];

  function register(method, pattern, handler) {
    const parts = String(pattern).split('/').filter(Boolean);
    table.push({ method: method.toUpperCase(), parts, handler });
  }

  // 匹配成功则调用 handler 并返回 true
  async function match(req, res, ctx) {
    const url = new URL(req.url, 'http://local');
    const parts = url.pathname.split('/').filter(Boolean);
    for (const route of table) {
      if (route.method !== req.method) continue;
      if (route.parts.length !== parts.length) continue;
      const params = {};
      let ok = true;
      for (let i = 0; i < parts.length; i++) {
        const rp = route.parts[i];
        if (rp.startsWith(':')) params[rp.slice(1)] = decodeURIComponent(parts[i]);
        else if (rp !== parts[i]) { ok = false; break; }
      }
      if (!ok) continue;
      await route.handler(req, res, ctx, params, url);
      return true;
    }
    return false;
  }

  return {
    register,
    get: (p, h) => register('GET', p, h),
    post: (p, h) => register('POST', p, h),
    delete: (p, h) => register('DELETE', p, h),
    match
  };
}

module.exports = { createRouter };
