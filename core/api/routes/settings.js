'use strict';

const { getPaths } = require('../../lib/paths');
const { loadConfig, deepMerge } = require('../../lib/config');
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
    if (patch.profileAutoUpdate) {
      if (patch.profileAutoUpdate.days !== undefined && ![7, 30].includes(patch.profileAutoUpdate.days)) return ctx.json(res, 400, { error: '画像周期只能选择 7 天或 30 天' });
      if (patch.profileAutoUpdate.scope !== undefined && !['all', 'important'].includes(patch.profileAutoUpdate.scope)) return ctx.json(res, 400, { error: '联系人范围无效' });
    }
    if (typeof patch.userPersona === 'string') patch.userPersona = patch.userPersona.trim().slice(0, 12000);
    if (patch.webSearch) {
      const search = patch.webSearch;
      if (search.provider !== undefined && !['searxng', 'moonshot'].includes(search.provider)) return ctx.json(res, 400, { error: '搜索主服务无效' });
      if (search.fallback !== undefined && !['', 'searxng', 'moonshot'].includes(search.fallback)) return ctx.json(res, 400, { error: '搜索备用服务无效' });
      if (search.timeoutMs !== undefined && (!Number.isInteger(search.timeoutMs) || search.timeoutMs < 1000 || search.timeoutMs > 180000)) return ctx.json(res, 400, { error: '搜索超时需为 1 至 180 秒' });
      if (search.maxResults !== undefined && (!Number.isInteger(search.maxResults) || search.maxResults < 1 || search.maxResults > 10)) return ctx.json(res, 400, { error: '搜索结果数量需为 1 至 10' });
      for (const service of ['searxng', 'moonshot']) {
        if (search[service]?.baseUrl && !require('../../channels/web-search').validUrl(search[service].baseUrl)) return ctx.json(res, 400, { error: '搜索地址必须是有效的 HTTP(S) 地址' });
      }
    }
    if (patch.email) {
      const email = patch.email;
      for (const key of ['enabled', 'importantPush']) if (email[key] !== undefined && typeof email[key] !== 'boolean') return ctx.json(res, 400, { error: '邮件开关必须是布尔值' });
      if (email.initialDays !== undefined && (!Number.isInteger(email.initialDays) || email.initialDays < 1 || email.initialDays > 3650)) return ctx.json(res, 400, { error: '邮件初次同步天数无效' });
      for (const protocol of ['imap', 'smtp']) {
        const value = email[protocol]; if (!value) continue;
        if (value.port !== undefined && (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535)) return ctx.json(res, 400, { error: '邮件端口无效' });
        for (const key of ['secure', 'rejectUnauthorized']) if (value[key] !== undefined && typeof value[key] !== 'boolean') return ctx.json(res, 400, { error: '邮件 TLS 配置无效' });
      }
    }
    for (const settings of [patch.webSearch, patch.profileAutoUpdate]) {
      if (settings?.enabled !== undefined && typeof settings.enabled !== 'boolean') return ctx.json(res, 400, { error: '启用状态必须为布尔值' });
    }
    for (const provider of Object.values(patch.engine?.providers || {})) {
      for (const key of ['thinkingBody', 'noThinkingBody']) {
        const value = provider?.[key];
        if (value != null && (typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((name) => ['model', 'messages', 'stream', '__proto__', 'constructor', 'prototype'].includes(name)))) return ctx.json(res, 400, { error: '思考参数必须是 JSON 对象，不能覆盖模型、消息或流式输出设置' });
      }
    }
    restoreMaskedKeys(cur, patch);
    if (patch.weixinPush && typeof patch.weixinPush.enabled === 'boolean') {
      const notifyPatch = patch.notify && typeof patch.notify === 'object' ? patch.notify : {};
      if (notifyPatch.mode === undefined) {
        const currentMode = cur.notify && cur.notify.mode;
        notifyPatch.mode = patch.weixinPush.enabled
          ? (currentMode && currentMode !== 'off' ? currentMode : 'weixin')
          : 'off';
      }
      if (patch.weixinPush.notifyComplete !== undefined) {
        notifyPatch.events = {
          ...(notifyPatch.events || {}),
          captureComplete: patch.weixinPush.notifyComplete === true
        };
      }
      patch.notify = notifyPatch;
    }
    const next = deepMerge(cur, patch);
    writeJson(P.config, next);
    // 让正在运行的核心立即使用新配置（尤其是引擎模型设置）
    if (ctx) ctx.config = loadConfig();
    // 运行中的剪贴板监听器/回复建议/微信通道使用启动时配置，短期方案：保存后自动重启核心服务
    let restarting = false;
    if (ctx && typeof ctx.onRestart === 'function') {
      restarting = true;
      setTimeout(() => ctx.onRestart(), 800);
    }
    if (ctx?.emailService && typeof ctx.emailService.reconfigure === 'function') {
      ctx.emailService.reconfigure(ctx.config).catch(() => {});
    }
    const masked = maskConfig(next);
    masked.restarting = restarting;
    return ctx.json(res, 200, masked);
  });
};
