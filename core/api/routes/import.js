// 聊天记录导入 API
// 供「分享目标 shim / SendTo 包装脚本 / 看板」把导出的 ZIP/TXT 交进来：
//   POST /api/import/archive  { paths: ["C:\\...\\微信聊天记录.zip"], dryRun?: false, intents?: false }
//   POST /api/import/content  { mode, filename, text, selfNickname }  前端直接把文件内容交进来
// 只接受本机路径（核心本身跑在用户机器上，网络侧仍受 auth 保护）。
'use strict';

const { importChatArchives, parseAny } = require('../../import/chat-archive');
const { loadConfig } = require('../../lib/config');
const { log } = require('../../lib/log');
const chatDb = require('../../memory/chat-db');
const { getBatchContact } = require('../../lib/chat-parser');
const { getPaths } = require('../../lib/paths');
const { readJson, writeJson } = require('../../lib/store');

const MAX_IMPORT_BYTES = 16 * 1024 * 1024;

// 文件由前端读成文本后 POST 过来：请求体是 JSON，正文上限 16 MB。
async function readImportBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_IMPORT_BYTES) throw Object.assign(new Error('导入内容超过 16 MB，请拆分后导入'), { status: 413 });
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

module.exports = (router, ctx) => {
  router.post('/api/import/content', async (req, res) => {
    try {
      const body = await readImportBody(req);
      const nickname = String(body.selfNickname || '').trim();
      if (body.mode === 'clipboard' && !nickname) return ctx.json(res, 400, { error: '请先填写自己的微信昵称' });
      const filename = String(body.filename || '微信聊天.txt');
      if (!/\.(jsonl|txt|json)$/i.test(filename)) return ctx.json(res, 400, { error: '请选择 JSONL 或 TXT 聊天文件' });
      const parsed = parseAny(String(body.text || ''), filename);
      if (!parsed.messages.length) return ctx.json(res, 400, { error: '未识别到聊天消息，请检查文件格式或重新批量复制微信消息' });
      const cfg = loadConfig();
      const nicknames = nickname.split(/[,，;；\n]+/).map(name => name.trim()).filter(Boolean);
      const owners = [...new Set([...(cfg.selfNicknames || []), ...(parsed.ownerNames || []), ...nicknames].filter(Boolean))];
      const identifiedPeer = parsed.messages.find(message => message.isOwner === false);
      const contact = identifiedPeer?.name || getBatchContact(parsed.messages, owners) || parsed.contactHint;
      if (!contact || (!identifiedPeer && owners.includes(contact))) return ctx.json(res, 400, { error: '无法确定聊天对象，请填写正确的本人昵称，并导入与同一个对象的聊天记录' });
      // 自昵称是后续剪贴板导入 / 归属判断的依据：确认有效后合并落盘。
      const current = readJson(getPaths().config, {});
      writeJson(getPaths().config, { ...current, selfNicknames: owners });
      ctx.config = loadConfig();
      const messages = parsed.messages.map(message => {
        if (typeof message.isOwner === 'boolean' || !nicknames.length) return message;
        if (nicknames.includes(message.name)) return { ...message, isOwner: true };
        if (message.name === contact) return { ...message, isOwner: false };
        return message;
      });
      const added = chatDb.ingestMessages(contact, messages);
      return ctx.json(res, 200, { ok: true, contacts: { [contact]: added }, added, messages: parsed.messages.length, format: parsed.format });
    } catch (error) {
      const status = error.status || 400;
      return ctx.json(res, status, { error: error.message || '导入失败，请检查聊天格式' });
    }
  });
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
      // 走统一的排队入口：导入一大批时不会逐条触发，冷却内的请求合并成一轮
      if (body.intents && !body.dryRun && summary.added > 0) {
        try {
          const { requestIntentExtraction } = require('../../engine/intent-runner');
          requestIntentExtraction({ config: cfg, reason: 'import' });
        } catch {}
      }
      return ctx.json(res, summary.ok ? 200 : 400, summary);
    } catch (e) {
      log('error', 'ingest', '聊天记录导入异常：' + String((e && e.message) || e));
      return ctx.json(res, 500, { ok: false, error: String((e && e.message) || e) });
    }
  });
};
