'use strict';

const fs = require('fs');
const { listContactsMeta, contactFile, saveContact, updateContact, deleteContact, clearContactMessages } = require('../../memory/stores/contacts');

module.exports = (router, ctx) => {
  router.get('/api/contacts', (req, res) => ctx.json(res, 200, listContactsMeta()));

  router.get('/api/contacts/:name', (req, res, c, params) => {
    const fp = contactFile(params.name);
    if (!fs.existsSync(fp)) return ctx.json(res, 404, { error: 'not found' });
    return ctx.json(res, 200, JSON.parse(fs.readFileSync(fp, 'utf8')));
  });

  router.post('/api/contacts/:name', async (req, res, c, params) => {
    const body = JSON.parse((await ctx.readBody(req)) || '{}');
    const doc = updateContact(params.name, body);
    return ctx.json(res, 200, { ok: true, contact: doc });
  });

  router.post('/api/contacts/:name/important', async (req, res, c, params) => {
    const fp = contactFile(params.name);
    if (!fs.existsSync(fp)) return ctx.json(res, 404, { error: 'not found' });
    const body = JSON.parse((await ctx.readBody(req)) || '{}');
    const doc = JSON.parse(fs.readFileSync(fp, 'utf8'));
    doc.important = !!body.important;
    saveContact(doc);
    return ctx.json(res, 200, { ok: true, important: doc.important });
  });

  router.delete('/api/contacts/:name', (req, res, c, params) => {
    const result = deleteContact(params.name);
    if (!result.removed) return ctx.json(res, 404, { error: 'not found' });
    return ctx.json(res, 200, { ok: true, ...result });
  });

  router.delete('/api/contacts/:name/messages', (req, res, c, params) => {
    const result = clearContactMessages(params.name);
    if (result.removed === 0 && !fs.existsSync(contactFile(params.name))) {
      return ctx.json(res, 404, { error: 'not found' });
    }
    return ctx.json(res, 200, { ok: true, ...result });
  });
};
