'use strict';

const fs = require('fs');
const { listContactsMeta, contactFile, readContact, saveContact, updateContact, deleteContact, clearContactMessages } = require('../../memory/stores/contacts');
const chatDb = require('../../memory/chat-db');

module.exports = (router, ctx) => {
  router.get('/api/contacts', (req, res, c, p, url) => ctx.json(res, 200, chatDb.listMembers(url.searchParams.get('q') || '')));

  router.get('/api/contacts/:name', (req, res, c, params) => {
    const dbContact = chatDb.getMember(params.name);
    if (dbContact) return ctx.json(res, 200, dbContact);
    const fp = contactFile(params.name);
    if (!fs.existsSync(fp)) return ctx.json(res, 404, { error: 'not found' });
    return ctx.json(res, 200, JSON.parse(fs.readFileSync(fp, 'utf8')));
  });

  router.get('/api/contacts/:name/messages', (req, res, c, params, url) => {
    const dbMessages = chatDb.messages(params.name, url.searchParams.get('q') || '', url.searchParams.get('limit') || 100);
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
    return ctx.json(res, 200, { name: contact.name, remark: contact.remark, important: contact.important, socialGoal: contact.socialGoal || '', profile: contact.profile || {} });
  });

  router.post('/api/contacts/:name/profile', async (req, res, c, params) => {
    const body = JSON.parse((await ctx.readBody(req)) || '{}');
    const updated = chatDb.updateMember(params.name, body);
    if (!updated) return ctx.json(res, 404, { error: 'not found' });
    return ctx.json(res, 200, { ok: true, profile: updated.profile, remark: updated.remark, important: updated.important, socialGoal: updated.socialGoal || '' });
  });

  router.post('/api/contacts/:name', async (req, res, c, params) => {
    const body = JSON.parse((await ctx.readBody(req)) || '{}');
    const doc = chatDb.updateMember(params.name, body) || updateContact(params.name, body);
    return ctx.json(res, 200, { ok: true, contact: doc });
  });

  router.post('/api/contacts/:name/important', async (req, res, c, params) => {
    const fp = contactFile(params.name);
    if (!fs.existsSync(fp)) return ctx.json(res, 404, { error: 'not found' });
    const body = JSON.parse((await ctx.readBody(req)) || '{}');
    const dbContact = chatDb.updateMember(params.name, { important: !!body.important });
    if (dbContact) return ctx.json(res, 200, { ok: true, important: dbContact.important });
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
    chatDb.clearMemberMessages(params.name);
    const result = clearContactMessages(params.name);
    if (result.removed === 0 && !fs.existsSync(contactFile(params.name))) {
      return ctx.json(res, 404, { error: 'not found' });
    }
    return ctx.json(res, 200, { ok: true, ...result });
  });
};
