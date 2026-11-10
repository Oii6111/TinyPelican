'use strict';

const relationships = require('../../memory/stores/romance-relationships');
const chatDb = require('../../memory/chat-db');
const schedules = require('../../memory/stores/schedules');
const coach = require('../../agent/romance-coach');

function daysSince(value) {
  const stamp = Date.parse(String(value || ''));
  return Number.isFinite(stamp) ? Math.max(0, Math.floor((Date.now() - stamp) / 86400000)) : null;
}

function enrich(item) {
  const contact = chatDb.getMember(item.contactName);
  const recent = contact ? chatDb.messages(item.contactName, '', 20, false)?.messages || [] : [];
  const lastMessageAt = recent.length ? recent[recent.length - 1].ts : '';
  return { ...item, contactExists: !!contact, messageCount: contact?.messages || recent.length || 0, lastMessageAt };
}

function home() {
  const state = relationships.list();
  const items = state.relationships.map(enrich);
  const primary = items.find(item => item.id === state.primaryId) || items[0] || null;
  const openSchedules = schedules.listSchedules({ status: 'open' }).sort((a, b) => String(a.startAt).localeCompare(String(b.startAt)));
  const pending = [];
  if (!primary) pending.push({ id: 'create-relationship', title: '建立第一段关系档案', detail: '选择一个对象，开始记录你们的相处目标。', tone: 'warm' });
  if (primary && !primary.goal) pending.push({ id: 'set-goal', title: '写下近期关系目标', detail: '一个清晰的小目标，比猜测更容易带来行动。', tone: 'info' });
  if (primary?.lastMessageAt && daysSince(primary.lastMessageAt) >= 3) pending.push({ id: 'check-in', title: '关系需要一次轻联系', detail: `已有 ${daysSince(primary.lastMessageAt)} 天没有新的聊天记录。`, tone: 'warn' });
  const today = new Date().toISOString().slice(0, 10);
  const todaySchedule = openSchedules.find(item => String(item.startAt || '').slice(0, 10) === today);
  return {
    primary,
    relationships: items,
    status: primary ? { label: primary.status || '需要关注', stage: primary.stage || '了解中', summary: primary.goal || '给关系留一点真实而温柔的空间。' } : { label: '还没有关系档案', stage: '从这里开始', summary: '先记录一个你在意的人，AI 教练会陪你梳理下一步。' },
    pending,
    todaySuggestion: todaySchedule ? `今天安排：${todaySchedule.title}` : primary?.goal ? `围绕“${primary.goal}”完成一个小行动` : '写下一句你真正想表达的话',
    schedules: openSchedules.slice(0, 5),
    shortcuts: ['reply-coach', 'relationship-review', 'schedule', 'messages']
  };
}

module.exports = (router, ctx) => {
  router.get('/api/romance/home', (req, res) => ctx.json(res, 200, home()));
  router.get('/api/romance/coach/:id', (req, res, c, params) => {
    const item = relationships.get(params.id);
    if (!item) return ctx.json(res, 404, { error: '这段关系不存在，请重新选择。' });
    return ctx.json(res, 200, { messages: coach.history(item.contactName) });
  });
  router.post('/api/romance/coach/chat', async (req, res) => {
    let body;
    try { body = JSON.parse((await ctx.readBody(req)) || '{}'); }
    catch { return ctx.json(res, 400, { error: '消息格式无效。' }); }
    const item = relationships.get(String(body.relationshipId || ''));
    if (!item) return ctx.json(res, 404, { error: '请先选择一段关系。' });
    const message = String(body.message || '').trim();
    if (!message || message.length > 12000) return ctx.json(res, 400, { error: '请输入 1 至 12000 字的问题。' });
    const contact = chatDb.getMember(item.contactName);
    if (!contact) return ctx.json(res, 404, { error: '联系人不存在，请重新选择。' });
    const result = await coach.send({ relationship: item, contact, recentMessages: chatDb.messages(item.contactName, '', 40, false)?.messages || [], message });
    return ctx.json(res, result.status || 200, result);
  });
  router.get('/api/romance/relationships', (req, res) => {
    const state = relationships.list();
    return ctx.json(res, 200, { primaryId: state.primaryId, relationships: state.relationships.map(enrich) });
  });
  router.post('/api/romance/relationships', async (req, res) => {
    let body = {}; try { body = JSON.parse((await ctx.readBody(req)) || '{}'); } catch {}
    if (!String(body.contactName || '').trim() && String(body.newContactName || '').trim()) {
      chatDb.ingestMessages(String(body.newContactName).trim(), []);
      body.contactName = String(body.newContactName).trim();
    }
    const contact = chatDb.getMember(String(body.contactName || '').trim());
    if (!contact) return ctx.json(res, 400, { ok: false, error: '请选择联系人或填写新联系人姓名' });
    const item = relationships.create(body);
    return ctx.json(res, item ? 201 : 400, item ? { ok: true, relationship: enrich(item) } : { ok: false, error: '关系信息不完整' });
  });
  router.post('/api/romance/relationships/:id', async (req, res, c, params) => {
    let body = {}; try { body = JSON.parse((await ctx.readBody(req)) || '{}'); } catch {}
    if (!String(body.contactName || '').trim() && String(body.newContactName || '').trim()) {
      chatDb.ingestMessages(String(body.newContactName).trim(), []);
      body.contactName = String(body.newContactName).trim();
    }
    if (body.contactName && !chatDb.getMember(String(body.contactName).trim())) return ctx.json(res, 400, { ok: false, error: '联系人不存在' });
    const item = relationships.update(params.id, body);
    return ctx.json(res, item ? 200 : 404, item ? { ok: true, relationship: enrich(item) } : { ok: false, error: '关系不存在或信息不完整' });
  });
  router.delete('/api/romance/relationships/:id', (req, res, c, params) => {
    const ok = relationships.remove(params.id);
    return ctx.json(res, ok ? 200 : 404, { ok });
  });
  router.post('/api/romance/relationships/:id/primary', (req, res, c, params) => {
    const item = relationships.setPrimary(params.id);
    return ctx.json(res, item ? 200 : 404, item ? { ok: true, primaryId: item.id } : { ok: false, error: '关系不存在' });
  });
  router.post('/api/romance/coach', async (req, res) => {
    let body = {}; try { body = JSON.parse((await ctx.readBody(req)) || '{}'); } catch {}
    const item = relationships.get(String(body.relationshipId || ''));
    if (!item) return ctx.json(res, 404, { ok: false, error: '请先选择关系' });
    const contact = chatDb.getMember(item.contactName);
    if (!contact) return ctx.json(res, 400, { ok: false, error: '关系关联的联系人不存在' });
    const history = chatDb.messages(item.contactName, '', 40, false)?.messages || [];
    const type = ['reply', 'analysis', 'review'].includes(body.type) ? body.type : 'reply';
    const task = type === 'reply' ? '请给出三种自然、不操控、符合边界的回复方案，并说明适用场景。' : type === 'analysis' ? '请分析最近互动中的情绪、需求、误解和可以温和尝试的下一步。' : '请复盘这段对话，指出做得好的地方、风险点和下一次可执行的小行动。';
    const result = await coach.send({ relationship: item, contact, recentMessages: history, message: task });
    return ctx.json(res, result.status || 200, { ...result, text: result.messages?.at(-1)?.text || '', coachType: type, relationshipId: item.id });
  });
};
