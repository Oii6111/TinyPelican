// 回复建议 API：当前建议查询、换一批 / 按用户描述重写、顺序回填、忽略
'use strict';

const store = require('../../reply/suggestion-store');
const { applyPlan, applyNext, resetSequence } = require('../../reply/window-paste');
const { generateReplySuggestions, regenerateRemaining } = require('../../reply/suggestions');
const { getWindowRect } = require('../../capture/window-rect');
const { loadConfig } = require('../../lib/config');
const { log } = require('../../lib/log');

async function readJsonBody(ctx, req) {
  try {
    return JSON.parse((await ctx.readBody(req)) || '{}') || {};
  } catch {
    return {};
  }
}

module.exports = (router, ctx) => {
  // 当前建议 + 生成中状态：pending 让浮窗在模型还没返回时就能先弹出来显示「思考中」
  router.get('/api/reply-suggestions/current', (req, res) => {
    return ctx.json(res, 200, {
      suggestion: store.sanitize(store.getCurrent()),
      pending: store.sanitizePending(store.getPending())
    });
  });

  // 点击建议时的重新定位：按保存的句柄重新读取窗口矩形，窗口移动后也能跟随。
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

  // 换一批 / 按用户描述重写 / 深度思考：body { hint?: string, rotate?: boolean, deep?: boolean }
  // 都复用上一批建议的同一段聊天上下文，只是换参数重新问一次模型。
  router.post('/api/reply-suggestions/current/regenerate', async (req, res, c) => {
    const body = await readJsonBody(ctx, req);
    const hint = typeof body.hint === 'string' ? body.hint.slice(0, 200) : '';
    const rotate = !!body.rotate || !hint.trim();
    const deep = !!body.deep;

    const result = await generateReplySuggestions({
      hint,
      rotate,
      deep,
      config: loadConfig()
    });

    if (!result || !result.ok) {
      const error = (result && result.error) || '生成失败';
      log('warn', 'reply', '重新生成回复建议失败：' + error);
      return ctx.json(res, 200, { ok: false, error, suggestion: store.sanitize(store.getCurrent()), pending: null });
    }
    return ctx.json(res, 200, { ok: true, suggestion: result.suggestion, pending: null });
  });

  // 顺序发送中「换一批 / 深度思考」：只重写这一组还没发出去的那几条（带上已发的做上下文）
  router.post('/api/reply-suggestions/:id/continue', async (req, res, c, params) => {
    const body = await readJsonBody(ctx, req);
    const current = store.getCurrent();
    if (!current || current.id !== params.id) {
      return ctx.json(res, 400, { ok: false, error: '建议不存在或已失效', suggestion: null, pending: null });
    }

    const result = await regenerateRemaining({ deep: !!body.deep, config: loadConfig() });
    if (!result || !result.ok) {
      const error = (result && result.error) || '重写失败';
      log('warn', 'reply', '重写剩余消息失败：' + error);
      return ctx.json(res, 200, { ok: false, error, suggestion: store.sanitize(store.getCurrent()), pending: null });
    }
    return ctx.json(res, 200, { ok: true, suggestion: result.suggestion, pending: null });
  });

  // 点选某一组方案：填入第一条，并返回该组剩余的连贯消息
  router.post('/api/reply-suggestions/:id/apply', async (req, res, c, params) => {
    const body = await readJsonBody(ctx, req);
    const planIndex = Number.isInteger(body.plan) ? body.plan : body.index;
    const result = await applyPlan(params.id, planIndex);
    return ctx.json(res, result.ok || result.degraded ? 200 : 400, {
      ...result,
      suggestion: store.sanitize(store.getCurrent())
    });
  });

  // 顺序发送下一条
  router.post('/api/reply-suggestions/:id/next', async (req, res, c, params) => {
    const result = await applyNext(params.id);
    return ctx.json(res, result.ok || result.degraded ? 200 : 400, {
      ...result,
      suggestion: store.sanitize(store.getCurrent())
    });
  });

  // 放弃顺序发送，回到方案选择态
  router.post('/api/reply-suggestions/:id/reset', (req, res, c, params) => {
    const result = resetSequence(params.id);
    return ctx.json(res, result.ok ? 200 : 400, {
      ...result,
      suggestion: store.sanitize(store.getCurrent())
    });
  });
};
