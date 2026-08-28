'use strict';

const conversations = require('../../memory/stores/conversations');
const { startReplyTask } = require('../../agent/dsh-reply');
const { summarizeTask, sanitizeEventList, historyEventList } = require('../../agent/event-utils');

module.exports = (router, ctx) => {
  router.get('/api/history', (req, res, c, p, url) => {
    const session = url.searchParams.get('session') || 'agent:main:webui:default';
    const msgs = conversations.get(session);
    return ctx.json(res, 200, msgs.map((m) => ({
      role: m.role === 'bot' ? 'bot' : 'user',
      text: m.text,
      ...(Array.isArray(m.agentEvents) ? { agentEvents: sanitizeEventList(m.agentEvents) } : {}),
      ...(m.executionSummary ? { executionSummary: m.executionSummary } : {}),
      ...(m.taskId ? { taskId: m.taskId } : {})
    })));
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
    const task = startReplyTask({
      message,
      history: history.slice(0, -1).map((e) => ({ role: e.role, text: e.text })),
      channel: 'webui',
      contact: session,
      config: ctx.config || undefined,
      onFinish: (t) => {
        if (t.status === 'completed' && t.output) {
          conversations.append(session, {
            role: 'bot',
            text: t.output,
            taskId: t.id,
            agentEvents: historyEventList(t.events),
            executionSummary: summarizeTask(t)
          });
        }
      }
    });
    return ctx.json(res, 200, { ok: true, taskId: task.id, session, status: task.status });
  });
};
