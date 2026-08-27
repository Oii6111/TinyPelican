'use strict';

const conversations = require('../../memory/stores/conversations');
const { chatCompletion } = require('../../engine/client');

module.exports = (router, ctx) => {
  router.get('/api/history', (req, res, c, p, url) => {
    const session = url.searchParams.get('session') || 'agent:main:webui:default';
    const msgs = conversations.get(session);
    return ctx.json(res, 200, msgs.map((m) => ({ role: m.role === 'bot' ? 'bot' : 'user', text: m.text })));
  });

  router.get('/api/conversations', (req, res) => ctx.json(res, 200, conversations.list()));

  router.post('/api/conversations', (req, res) => {
    return ctx.json(res, 200, { key: 'agent:main:webui:' + Date.now() });
  });

  router.delete('/api/conversations', (req, res, c, p, url) => {
    const key = url.searchParams.get('session') || '';
    if (key) conversations.remove(key);
    return ctx.json(res, 200, { ok: true });
  });

  router.post('/api/chat', async (req, res) => {
    const body = JSON.parse((await ctx.readBody(req)) || '{}');
    const message = String(body.message || '').trim();
    const session = String(body.session || 'agent:main:webui:' + Date.now()).trim();
    if (!message) return ctx.json(res, 400, { ok: false, error: 'empty message' });
    conversations.append(session, { role: 'user', text: message });
    const history = conversations.get(session).slice(-20);
    const messages = history.map((e) => ({ role: e.role === 'bot' ? 'assistant' : 'user', content: e.text }));
    const r = await chatCompletion(messages);
    if (!r.ok) return ctx.json(res, 200, { ok: false, error: r.error });
    conversations.append(session, { role: 'bot', text: r.text });
    return ctx.json(res, 200, { ok: true, reply: r.text, session });
  });
};
