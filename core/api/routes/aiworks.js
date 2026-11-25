// 思必驰（AIWorks）云笔记导入 API
//   GET    /api/import/aiworks                 连接状态
//   POST   /api/import/aiworks/connect         { token }
//   POST   /api/import/aiworks/disconnect
//   GET    /api/import/aiworks/notes?page=N    云端笔记列表
//   GET    /api/import/aiworks/notes/:uid      单条笔记转写预览
//   POST   /api/import/aiworks/preview-text    { text } 粘贴转写的分段预览
//   POST   /api/import/aiworks/commit          把预览结果确认说话人后写入聊天库
// 所有 POST 只收同源 JSON；token 只进本地凭据，不出现在任何响应里。
'use strict';

const { createAiworks, failure, transcript, toMessages, fingerprint } = require('../../import/aiworks');

module.exports = (router, ctx, { aiworks = createAiworks(), chatDb = require('../../memory/chat-db') } = {}) => {
  const root = '/api/import/aiworks';
  const json = handler => async (req, res, config, params, url) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      if (req.headers['sec-fetch-site'] === 'cross-site' ||
          (req.headers.origin && !['http://', 'https://'].some(scheme => req.headers.origin === scheme + req.headers.host))) {
        throw failure('请从小鹈鹕界面发起操作。', 403);
      }
      let body = {};
      if (req.method === 'POST') {
        if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw failure('请提交 JSON 数据。', 415);
        try { body = JSON.parse(await ctx.readBody(req)); }
        catch { throw failure('请求格式无效。'); }
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw failure('请求格式无效。');
      }
      return ctx.json(res, 200, await handler(body, params, url));
    } catch (error) {
      return ctx.json(res, error.status || 500, { error: error.status ? error.message : '思必驰录音操作失败，请重试。' });
    }
  };
  router.get(root, json(() => aiworks.status()));
  router.post(root + '/connect', json(body => aiworks.connect(body.token)));
  router.post(root + '/disconnect', json(() => aiworks.disconnect()));
  router.get(root + '/notes', json((body, params, url) => {
    const page = Number(url.searchParams.get('page') || 1);
    if (!Number.isInteger(page) || page < 1 || page > 10000) throw failure('页码无效。');
    return aiworks.list(page);
  }));
  router.get(root + '/notes/:uid', json((body, params) => aiworks.preview(params.uid)));
  router.post(root + '/commit', json(async body => {
    const name = typeof body.contact === 'string' ? body.contact.trim() : '';
    if (!name || name.length > 120 || /[\u0000-\u001f]/.test(name) || name === '我') throw failure('请选择或填写有效的联系人姓名。');
    let segments, recordingId;
    if (body.uid) {
      const preview = await aiworks.preview(body.uid);
      if (body.version !== preview.version) throw failure('云端转写已更新，请重新打开这条笔记确认。', 409);
      segments = preview.segments;
      recordingId = 'note:' + preview.uid;
    } else {
      segments = transcript(body.text, { pasted: true });
      recordingId = 'text:' + fingerprint(JSON.stringify([body.startedAt, segments]));
    }
    const contact = chatDb.listMembers().find(member => member.name === name)?.name;
    if (!contact && Buffer.byteLength(name) > 100) throw failure('新联系人的姓名过长，请缩短后重试。');
    const target = contact || name;
    // 消息上的 source/externalId 由 chat-db 用来做稳定去重；旧的 chat-db 会按
    // 「联系人 + 发送者 + 时间 + 类型 + 内容」哈希兜底，重复导入同样不会翻倍。
    const messages = toMessages(segments, body.roles, target, body.startedAt, recordingId);
    const added = chatDb.ingestMessages(target, messages);
    return { contact: target, added, messages: messages.length };
  }));
  router.post(root + '/preview-text', json(body => ({ segments: transcript(body.text, { pasted: true }) })));
};
