'use strict';

const { getPaths } = require('../../lib/paths');
const { loadConfig } = require('../../lib/config');
const { readJson, writeJson } = require('../../lib/store');
const { maskConfig, restoreMaskedKeys } = require('../models');

const P = getPaths();

module.exports = (router, ctx) => {
  router.get('/api/settings', (req, res) => {
    // 未配置时也返回带默认值的完整结构，方便看板直接展示
    return ctx.json(res, 200, maskConfig(ctx.config || loadConfig()));
  });

  router.post('/api/settings', async (req, res) => {
    const cur = readJson(P.config, {});
    const patch = JSON.parse((await ctx.readBody(req)) || '{}');
    restoreMaskedKeys(cur, patch);
    const next = { ...cur, ...patch };
    writeJson(P.config, next);
    // 让正在运行的核心立即使用新配置（尤其是引擎模型设置）
    if (ctx) ctx.config = loadConfig();
    // 运行中的剪贴板监听器/回复建议/微信通道使用启动时配置，短期方案：保存后自动重启核心服务
    let restarting = false;
    if (ctx && typeof ctx.onRestart === 'function') {
      restarting = true;
      setTimeout(() => ctx.onRestart(), 800);
    }
    const masked = maskConfig(next);
    masked.restarting = restarting;
    return ctx.json(res, 200, masked);
  });
};
