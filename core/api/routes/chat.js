'use strict';

const conversations = require('../../memory/stores/conversations');
const mainSession = require('../../agent/main-session');
const { createTask } = require('../../agent/tasks');
const { sanitizeEventList, historyEventList } = require('../../agent/event-utils');

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

    const full = conversations.get(session);
    const history = full.slice(-20, -1).map((e) => ({
      role: e.role === 'bot' ? 'bot' : 'user',
      text: e.text
    }));

    // WebUI 与微信统一走 MainAgentSession（DSH WebUI 常驻会话）。
    // 用 createTask 包装成异步任务：DSH Web 事件实时进入 task.events，前端轮询展示。
    const task = createTask(message, {
      config: ctx.config || undefined,
      runner: async ({ onEvent }) => {
        const r = await mainSession.sendStreaming({
          sessionKey: session,
          message,
          history,
          onEvent: (ev) => onEvent({ ...ev })
        });
        if (!r.ok) throw new Error(r.error || 'DSH Web 回复失败');
        return { ok: true, text: r.text };
      },
      onFinish: (t) => {
        if (t.status === 'completed' && t.output) {
          conversations.append(session, {
            role: 'bot',
            text: t.output,
            agentEvents: historyEventList(t.events || [])
          });
        }
      }
    });

    return ctx.json(res, 200, { ok: true, taskId: task.id, session, status: task.status });
  });
};
