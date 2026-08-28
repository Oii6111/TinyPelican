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
    return ctx.json(res, 200, maskConfig(next));
  });
};
