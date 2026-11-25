'use strict';

const fs = require('fs');
const { listContactsMeta, contactFile, readContact, saveContact, updateContact, deleteContact, clearContactMessages, readContactRelationshipFields, saveContactRelationshipFields } = require('../../memory/stores/contacts');
const chatDb = require('../../memory/chat-db');
const memory = require('../../memory/chat-memory');
const { computeRelationshipMetrics } = require('../../memory/relationship-metrics');
const { loadConfig } = require('../../lib/config');
const { TEMPLATE, profileGaps } = require('../../memory/profile-template');

// 关系概览只统计最近这么多条消息：样本足够看模式，又不让大聊天记录把接口拖慢。
const RELATIONSHIP_MESSAGE_LIMIT = 500;

module.exports = (router, ctx) => {
  router.get('/api/profile-template', (req, res) => ctx.json(res, 200, TEMPLATE));
  // 只回联系人：群和「群里的陌生人」(kind='member') 不该出现在联系人页
  router.get('/api/contacts', (req, res, c, p, url) => ctx.json(res, 200,
    chatDb.listMembers(url.searchParams.get('q') || '').filter((member) => member.kind !== 'group' && member.kind !== 'member')));

  // 聊天记录里的图片/文件：字节存在 SQLite（message_attachment），这里直接回给前端。
  // 图片默认 inline 预览，?download=1 走下载；非图片一律按下载处理。
  router.get('/api/contacts/attachment/:id', (req, res, c, params, url) => {
    const record = chatDb.getAttachment(params.id);
    if (!record) return ctx.json(res, 404, { ok: false, error: '附件不存在' });
    if (!record.bytes) return ctx.json(res, 404, { ok: false, error: '附件文件已被清理' });
    const imageMimes = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp'];
    const inline = record.kind === 'image' && imageMimes.includes(record.mimeType) && url.searchParams.get('download') !== '1';
    res.writeHead(200, {
      'Content-Type': inline ? record.mimeType : (record.mimeType || 'application/octet-stream'),
      'Content-Length': record.bytes.length,
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="attachment"; filename*=UTF-8''${encodeURIComponent(record.name || 'attachment')}`,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cache-Control': 'private, max-age=86400',
      ...(record.sha256 ? { ETag: `"${record.sha256}"` } : {})
    });
    res.end(record.bytes);
  });

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

  // 关系概览：只描述「消息怎么流动」+ 用户自己填的维护字段（社交目的/阶段/备忘），
  // 不做关系判断、不给话术建议。群和群成员不是联系人，明确拒绝而不是静默当成联系人。
  router.get('/api/contacts/:name/relationship', (req, res, c, params) => {
    const member = chatDb.getMember(params.name);
    if (!member) return ctx.json(res, 404, { error: '联系人不存在' });
    if (member.kind === 'group' || member.kind === 'member') return ctx.json(res, 400, { error: '群和群成员不是联系人，没有关系概览' });
    const config = ctx.config || loadConfig();
    const social = readContactRelationshipFields(member);
    const rows = chatDb.messages(member.name, '', RELATIONSHIP_MESSAGE_LIMIT, false, '', 0, config)?.messages || [];
    const metrics = rows.length
      ? computeRelationshipMetrics(rows, {
        ownerNames: ['我', ...(Array.isArray(config.selfNicknames) ? config.selfNicknames : [])],
        contactNames: [member.name, member.remark].filter(Boolean)
      })
      : null;
    const lastMessageAt = String(member.updatedAt || '');
    const lastMs = lastMessageAt ? Date.parse(lastMessageAt.replace(/ (\d):/, ' 0$1:')) : NaN;
    return ctx.json(res, 200, {
      name: member.name,
      kind: member.kind || 'contact',
      socialGoal: social.socialGoal || member.socialGoal || '',
      stage: social.relationship,
      notes: social.notes,
      metrics,
      recent: {
        lastMessageAt,
        messages: Number(member.messages || 0),
        daysSinceLast: Number.isFinite(lastMs) ? Math.max(0, Math.floor((Date.now() - lastMs) / 86400000)) : null
      }
    });
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
    for (const [field, label] of [['relationship', '阶段'], ['stage', '阶段'], ['notes', '备忘']]) {
      if (body[field] !== undefined && typeof body[field] !== 'string') return ctx.json(res, 400, { error: label + '必须是文本' });
    }
    // 只改关系维护字段时不要动画像，避免把「来源：完整历史分析」改写成手动编辑
    const touchesProfile = ['profile', 'remark', 'important', 'profileMode', 'profileSkipped', 'profileMeta', 'socialGoal'].some((key) => body[key] !== undefined);
    const updated = touchesProfile ? chatDb.updateMember(params.name, body, { replaceProfile: body.profileMode === 'replace' }) : chatDb.getMember(params.name);
    if (!updated) return ctx.json(res, 404, { error: 'not found' });
    const hasRelationshipFields = body.relationship !== undefined || body.stage !== undefined || body.notes !== undefined;
    const social = hasRelationshipFields ? saveContactRelationshipFields(updated, { relationship: body.relationship ?? body.stage, notes: body.notes }) : readContactRelationshipFields(updated);
    return ctx.json(res, 200, { ok: true, profile: updated.profile, profileMeta: updated.profileMeta || {}, remark: updated.remark, important: updated.important, socialGoal: updated.socialGoal || '', stage: social?.relationship || '', notes: social?.notes || '' });
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
