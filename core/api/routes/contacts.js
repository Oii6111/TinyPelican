'use strict';

const fs = require('fs');
const { listContactsMeta, contactFile, readContact, saveContact, updateContact, deleteContact, clearContactMessages } = require('../../memory/stores/contacts');
const chatDb = require('../../memory/chat-db');
const memory = require('../../memory/chat-memory');
const { TEMPLATE, profileGaps } = require('../../memory/profile-template');

module.exports = (router, ctx) => {
  router.get('/api/profile-template', (req, res) => ctx.json(res, 200, TEMPLATE));
  router.get('/api/contacts', (req, res, c, p, url) => ctx.json(res, 200, chatDb.listMembers(url.searchParams.get('q') || '')));

  router.get('/api/contacts/:name', (req, res, c, params) => {
    const dbContact = chatDb.getMember(params.name);
    if (dbContact) return ctx.json(res, 200, dbContact);
    const fp = contactFile(params.name);
    if (!fs.existsSync(fp)) return ctx.json(res, 404, { error: 'not found' });
    return ctx.json(res, 200, JSON.parse(fs.readFileSync(fp, 'utf8')));
  });

  router.get('/api/contacts/:name/messages', (req, res, c, params, url) => {
    if (url.searchParams.get('archive') === '1') return ctx.json(res, 200, chatDb.archiveMessages(params.name, url.searchParams.get('before') || '', url.searchParams.get('limit') || 100, url.searchParams.get('beforeId') || 0) || { error: 'not found' });
    const dbMessages = chatDb.messages(params.name, url.searchParams.get('q') || '', url.searchParams.get('limit') || 100, true, url.searchParams.get('before') || '', url.searchParams.get('beforeId') || 0);
    if (dbMessages) return ctx.json(res, 200, dbMessages);
    const fp = contactFile(params.name);
    if (!fs.existsSync(fp)) return ctx.json(res, 404, { error: 'not found' });
    const query = String(url.searchParams.get('q') || '').trim();
    const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '100', 10) || 100, 1), 500);
    const doc = readContact(params.name);
    const messages = doc.messages.filter((m) => !query || String(m.content || '').includes(query));
    const page = messages.slice(Math.max(0, messages.length - limit));
    return ctx.json(res, 200, { contact: doc.name, total: messages.length, messages: page });
  });

  router.get('/api/contacts/:name/profile', (req, res, c, params) => {
    const contact = chatDb.getMember(params.name);
    if (!contact) return ctx.json(res, 404, { error: 'not found' });
    return ctx.json(res, 200, { name: contact.name, remark: contact.remark, important: contact.important, socialGoal: contact.socialGoal || '', profile: contact.profile || {}, profileMeta: contact.profileMeta || {}, profileSkipped: contact.profileSkipped || [], gaps: profileGaps(contact.profile, contact.profileSkipped), ...memory.getStatus(contact.name) });
  });

  router.post('/api/contacts/:name/profile', async (req, res, c, params) => {
    const body = JSON.parse((await ctx.readBody(req)) || '{}');
    if (body.profileMode !== undefined && !['merge', 'replace'].includes(body.profileMode)) return ctx.json(res, 400, { error: '画像保存模式无效' });
    if (body.profileMode === 'replace' && (!body.profile || typeof body.profile !== 'object' || Array.isArray(body.profile))) return ctx.json(res, 400, { error: '请提供完整画像对象，清空时使用空对象' });
    const updated = chatDb.updateMember(params.name, body, { replaceProfile: body.profileMode === 'replace' });
    if (!updated) return ctx.json(res, 404, { error: 'not found' });
    return ctx.json(res, 200, { ok: true, profile: updated.profile, profileMeta: updated.profileMeta || {}, remark: updated.remark, important: updated.important, socialGoal: updated.socialGoal || '' });
  });

  router.post('/api/contacts/:name/analyze-profile', (req, res, c, params) => {
    if (!chatDb.getMember(params.name)) return ctx.json(res, 404, { error: '联系人不存在' });
    try { return ctx.json(res, 202, { ok: true, ...memory.requestJob(params.name, 'profile') }); }
    catch (error) { return ctx.json(res, 400, { error: error.message }); }
  });

  router.get('/api/contacts/:name/chat-summary', (req, res, c, params) => {
    const result = memory.getStatus(params.name);
    return ctx.json(res, result ? 200 : 404, result || { error: '联系人不存在' });
  });

  router.post('/api/contacts/:name/chat-summary/rebuild', (req, res, c, params) => {
    if (!chatDb.getMember(params.name)) return ctx.json(res, 404, { error: '联系人不存在' });
    try { return ctx.json(res, 202, { ok: true, ...memory.requestJob(params.name) }); }
    catch (error) { return ctx.json(res, 400, { error: error.message }); }
  });

  router.post('/api/contacts/:name', async (req, res, c, params) => {
    const body = JSON.parse((await ctx.readBody(req)) || '{}');
    const doc = chatDb.updateMember(params.name, body) || updateContact(params.name, body);
    return ctx.json(res, 200, { ok: true, contact: doc });
  });

  router.post('/api/contacts/:name/important', async (req, res, c, params) => {
    const fp = contactFile(params.name);
    const body = JSON.parse((await ctx.readBody(req)) || '{}');
    const dbContact = chatDb.updateMember(params.name, { important: !!body.important });
    if (dbContact) return ctx.json(res, 200, { ok: true, important: dbContact.important });
    if (!fs.existsSync(fp)) return ctx.json(res, 404, { error: 'not found' });
    const doc = JSON.parse(fs.readFileSync(fp, 'utf8'));
    doc.important = !!body.important;
    saveContact(doc);
    return ctx.json(res, 200, { ok: true, important: doc.important });
  });

  router.delete('/api/contacts/:name', (req, res, c, params) => {
    const dbRemoved = chatDb.deleteMember(params.name);
    const result = deleteContact(params.name);
    if (!result.removed && !dbRemoved) return ctx.json(res, 404, { error: 'not found' });
    return ctx.json(res, 200, { ok: true, ...result });
  });

  router.delete('/api/contacts/:name/messages', (req, res, c, params) => {
    const existed = !!chatDb.getMember(params.name);
    const removed = chatDb.clearMemberMessages(params.name);
    const result = clearContactMessages(params.name);
    if (!existed && result.removed === 0 && !fs.existsSync(contactFile(params.name))) {
      return ctx.json(res, 404, { error: 'not found' });
    }
    return ctx.json(res, 200, { ok: true, ...result, removed: result.removed + removed });
  });
};
