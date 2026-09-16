// 聊天记录导入 API
// 供「分享目标 shim / SendTo 包装脚本 / 看板」把导出的 ZIP/TXT 交进来：
//   POST /api/import/archive  { paths: ["C:\\...\\微信聊天记录.zip"], dryRun?: false, intents?: false }
// 只接受本机路径（核心本身跑在用户机器上，网络侧仍受 auth 保护）。
'use strict';

const { importChatArchives } = require('../../import/chat-archive');
const { loadConfig } = require('../../lib/config');
const { log } = require('../../lib/log');

module.exports = (router, ctx) => {
  router.post('/api/import/archive', async (req, res) => {
    let body = {};
    try {
      body = JSON.parse((await ctx.readBody(req)) || '{}');
    } catch {}

    const paths = (Array.isArray(body.paths) ? body.paths : [body.path])
      .map((p) => String(p || '').trim())
      .filter(Boolean);
    if (!paths.length) return ctx.json(res, 400, { ok: false, error: '缺少 paths' });

    const cfg = ctx.config || loadConfig();
    try {
      const summary = await importChatArchives({
        paths,
        config: cfg,
        dryRun: !!body.dryRun
      });
      // 导入后可选触发一次意图识别（把新消息里的待办/DDL 提取出来）
      if (body.intents && !body.dryRun && summary.added > 0) {
        try {
          const { runIntentExtraction } = require('../../engine/intent-runner');
          runIntentExtraction({ config: cfg }).catch((e) =>
            log('warn', 'ingest', '导入后意图识别失败：' + String((e && e.message) || e)));
        } catch {}
      }
      return ctx.json(res, summary.ok ? 200 : 400, summary);
    } catch (e) {
      log('error', 'ingest', '聊天记录导入异常：' + String((e && e.message) || e));
      return ctx.json(res, 500, { ok: false, error: String((e && e.message) || e) });
    }
  });
};
