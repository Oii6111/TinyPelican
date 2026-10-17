'use strict';

const fs = require('node:fs');
const { WeChatClient } = require('../../channels/weixin/client');
const { readCredentials } = require('../../channels/weixin/login');
const { getContext, clearContext } = require('../../channels/weixin/context');
const { MAX_MEDIA_BYTES, saveBuffer, getMedia, publicAttachment } = require('../../channels/weixin/media');
const conversations = require('../../memory/stores/conversations');

function readBinaryBody(req, limit = MAX_MEDIA_BYTES) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let size = 0;
    let finished = false;
    const fail = (message, status = 400) => {
      if (finished) return;
      finished = true;
      chunks = [];
      const error = new Error(message);
      error.status = status;
      reject(error);
    };
    if (Number(req.headers['content-length']) > limit) fail('文件超过 100 MB 限制', 413);
    req.on('data', (chunk) => {
      if (finished) return;
      size += chunk.length;
      if (size > limit) return fail('文件超过 100 MB 限制', 413);
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (finished) return;
      finished = true;
      if (!size) return reject(new Error('请选择非空文件'));
      resolve(Buffer.concat(chunks, size));
    });
    req.on('error', () => fail('文件上传中断'));
    req.on('aborted', () => fail('文件上传中断'));
  });
}

function registerWechatMedia(router, ctx) {
  router.post('/api/wechat/media', async (req, res) => {
    try {
      const name = decodeURIComponent(String(req.headers['x-filename'] || 'file.bin'));
      const buffer = await readBinaryBody(req);
      const record = await saveBuffer(buffer, { name, direction: 'outbound' });
      return ctx.json(res, 201, { ok: true, attachment: publicAttachment(record) });
    } catch (error) {
      return ctx.json(res, error.status || 400, { ok: false, error: error.code ? '文件保存失败，请检查应用数据目录' : error.message });
    }
  });

  router.get('/api/wechat/media/:id', async (req, res, context, params, url) => {
    const record = await getMedia(params.id);
    if (!record) return ctx.json(res, 404, { ok: false, error: '附件不存在或已被移除' });
    const inline = record.kind === 'image' && ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(record.mimeType) && url.searchParams.get('download') !== '1';
    const stream = fs.createReadStream(record.path);
    stream.once('error', () => {
      if (res.headersSent) res.destroy();
      else ctx.json(res, 404, { ok: false, error: '附件文件无法读取' });
    });
    stream.once('open', () => {
      res.writeHead(200, {
        'Content-Type': inline ? record.mimeType : 'application/octet-stream',
        'Content-Length': record.size,
        'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="attachment"; filename*=UTF-8''${encodeURIComponent(record.name)}`,
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'Cache-Control': 'private, no-store'
      });
      stream.pipe(res);
    });
    res.once('close', () => stream.destroy());
  });

  router.post('/api/wechat/send', async (req, res) => {
    try {
      const body = JSON.parse((await ctx.readBody(req)) || '{}');
      const creds = readCredentials();
      if (!creds?.user_id) return ctx.json(res, 409, { ok: false, error: '微信尚未登录，请先在设置中扫码登录' });
      const to = String(body.to || creds.user_id);
      const record = await getMedia(String(body.attachmentId || ''));
      if (!record) return ctx.json(res, 404, { ok: false, error: '请先上传图片或文件' });
      const client = new WeChatClient(creds);
      const contextToken = getContext(client.accountId, to);
      if (!contextToken) return ctx.json(res, 409, { ok: false, error: '请先从微信给机器人发一条消息，建立发送会话' });
      const text = String(body.text || '').trim();
      if (text.length > 4000) return ctx.json(res, 400, { ok: false, error: '附件说明最多 4000 个字符' });
      const result = await client.sendMedia(to, record, contextToken, { text });
      if (!result.ok && result.staleToken && getContext(client.accountId, to) === contextToken) clearContext(client.accountId, to);
      if (result.ok || result.textSent) {
        conversations.append('agent:main:weixin:' + to, {
          role: 'bot', text: result.textSent ? text : '',
          ...(result.ok ? { attachments: [publicAttachment(record)] } : {})
        });
      }
      return ctx.json(res, result.ok ? 200 : 502, {
        ok: result.ok, error: result.ok ? undefined : result.error, textSent: !!result.textSent,
        ...(result.ok ? { attachment: publicAttachment(record) } : {})
      });
    } catch (error) {
      return ctx.json(res, 400, { ok: false, error: error.code ? '微信附件发送失败' : error.message });
    }
  });
}

module.exports = { registerWechatMedia, readBinaryBody };
