// 回复建议 API：当前建议查询、应用、忽略
'use strict';

const store = require('../../reply/suggestion-store');
const { applySuggestion } = require('../../reply/window-paste');
const { getWindowRect } = require('../../capture/window-rect');

module.exports = (router, ctx) => {
  router.get('/api/reply-suggestions/current', (req, res) => {
    return ctx.json(res, 200, { suggestion: store.sanitize(store.getCurrent()) });
  });

  // 点击建议图标/卡片重新显示时调用：按保存的句柄重新读取窗口矩形，窗口移动后也能跟随。
  router.post('/api/reply-suggestions/current/refresh-position', async (req, res, c) => {
    const s = store.getCurrent();
    if (!s) return ctx.json(res, 200, { suggestion: null });

    const target = s.targetWindow;
    if (!target || !target.handle) {
      return ctx.json(res, 200, { suggestion: store.sanitize(s) });
    }

    // 只在微信窗口采用定位；其他软件复制的聊天文本仍回退屏幕右下角。
    const isWeChat = /^(wechat|weixin)(\.exe)?$/i.test(String(target.processName || '').trim());
    if (!isWeChat) {
      return ctx.json(res, 200, { suggestion: store.sanitize(s) });
    }

    const rect = await getWindowRect(target.handle);
    if (!rect) {
      // 句柄失效：清除定位信息，Electron 会回退到当前显示器右下角；句柄仍保留给粘贴尝试。
      target.bounds = null;
      target.dpi = 0;
      return ctx.json(res, 200, { suggestion: store.sanitize(s) });
    }

    // 句柄可能被系统复用指向其他窗口：刷新时 PID 必须与捕获时一致，否则不采用新矩形。
    if (target.pid && String(rect.pid) !== String(target.pid)) {
      target.bounds = null;
      target.dpi = 0;
      return ctx.json(res, 200, { suggestion: store.sanitize(s) });
    }

    target.bounds = rect.bounds;
    target.dpi = rect.dpi;
    return ctx.json(res, 200, { suggestion: store.sanitize(s) });
  });

  router.post('/api/reply-suggestions/:id/apply', async (req, res, c, params) => {
    let body = {};
    try {
      body = JSON.parse((await ctx.readBody(req)) || '{}');
    } catch {}
    const index = body.index;
    const result = await applySuggestion(params.id, index);
    if (result.ok) return ctx.json(res, 200, { ok: true, mode: result.mode });
    if (result.degraded) {
      return ctx.json(res, 200, { ok: false, degraded: true, mode: result.mode || 'clipboard', error: result.error });
    }
    return ctx.json(res, 400, { error: result.error || '建议无效' });
  });

  router.post('/api/reply-suggestions/:id/dismiss', (req, res, c, params) => {
    const ok = store.dismiss(params.id);
    return ctx.json(res, 200, { ok });
  });
};
