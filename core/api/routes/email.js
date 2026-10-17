'use strict';

const { EmailService } = require('../../email/service');
const chatDb = require('../../memory/chat-db');
const { loadConfig, deepMerge } = require('../../lib/config');

function serviceFor(ctx) {
  if (ctx.emailService) return ctx.emailService;
  ctx.emailService = new EmailService({ config: ctx.config, resolveContact: (address) => {
    return chatDb.findMembersByEmail(address);
  } });
  return ctx.emailService;
}

module.exports = (router, ctx) => {
  router.get('/api/email/status', (req, res) => ctx.json(res, 200, serviceFor(ctx).status()));
  router.post('/api/email/test', async (req, res) => {
    try {
      const body = JSON.parse((await ctx.readBody(req)) || '{}');
      const service = Object.keys(body).length ? new EmailService({ config: deepMerge(ctx.config || loadConfig(), { email: body }), databasePath: ':memory:', resolveContact: () => '' }) : serviceFor(ctx);
      const result = await service.test();
      if (service !== ctx.emailService) await service.stop();
      return ctx.json(res, result.ok ? 200 : 502, result);
    }
    catch (error) { return ctx.json(res, 400, { ok: false, error: error.message }); }
  });
  router.post('/api/email/sync', async (req, res) => {
    try {
      const service = serviceFor(ctx); if (!service.running) await service.start();
      const result = await service.syncNow();
      return ctx.json(res, result?.ok ? 202 : 502, result);
    }
    catch (error) { return ctx.json(res, 502, { ok: false, error: error.message }); }
  });
  router.get('/api/email/messages', (req, res, c, p, url) => {
    const service = serviceFor(ctx); const beforeDate = url.searchParams.get('beforeDate'); const beforeId = url.searchParams.get('beforeId');
    const result = service.db.listMessages({ category: url.searchParams.get('category') || '', status: url.searchParams.get('status') || '', important: url.searchParams.get('important'), contact: url.searchParams.get('contact') || '', contactStatus: url.searchParams.get('contactStatus') || '', q: url.searchParams.get('q') || '', limit: url.searchParams.get('limit') || 30, before: beforeDate ? { date: beforeDate, id: beforeId } : null });
    return ctx.json(res, 200, result);
  });
  router.get('/api/email/messages/:id', (req, res, c, params) => {
    const message = serviceFor(ctx).db.getMessage(params.id); return message ? ctx.json(res, 200, message) : ctx.json(res, 404, { error: '邮件不存在' });
  });
  router.post('/api/email/drafts', async (req, res) => {
    let body;
    try { body = JSON.parse((await ctx.readBody(req)) || '{}'); }
    catch { return ctx.json(res, 400, { error: 'invalid JSON body' }); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return ctx.json(res, 400, { error: 'invalid JSON body' });
    if (!String(body.to || '').trim() || !String(body.subject || '').trim()) return ctx.json(res, 400, { error: '收件人和主题不能为空' });
    return ctx.json(res, 200, { ok: true, draft: { to: String(body.to), cc: String(body.cc || ''), subject: String(body.subject), text: String(body.text || ''), html: String(body.html || '') } });
  });
  router.post('/api/email/send', async (req, res) => {
    try { const body = JSON.parse((await ctx.readBody(req)) || '{}'); return ctx.json(res, 200, await serviceFor(ctx).send(body)); }
    catch (error) { return ctx.json(res, 400, { ok: false, error: error.message }); }
  });
  router.get('/api/contacts/:name/emails', (req, res, c, params) => {
    const list = chatDb.listMemberEmails(params.name); return list ? ctx.json(res, 200, { contact: params.name, emails: list }) : ctx.json(res, 404, { error: '联系人不存在' });
  });
  router.post('/api/contacts/:name/email-links', async (req, res, c, params) => {
    let body;
    try { body = JSON.parse((await ctx.readBody(req)) || '{}'); }
    catch { return ctx.json(res, 400, { error: 'invalid JSON body' }); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return ctx.json(res, 400, { error: 'invalid JSON body' });
    const linked = chatDb.linkMemberEmail(params.name, body.address, { source: body.source || 'manual', verified: body.verified === true });
    return linked ? ctx.json(res, 200, { ok: true, link: linked }) : ctx.json(res, 400, { error: '邮箱地址或联系人无效' });
  });
  router.delete('/api/contacts/:name/email-links/:address', (req, res, c, params) => {
    const ok = chatDb.unlinkMemberEmail(params.name, params.address); return ctx.json(res, ok ? 200 : 404, { ok, error: ok ? undefined : '邮箱关联不存在' });
  });
};
