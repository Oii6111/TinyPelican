'use strict';

// 「查看详细行动」：按需为一条今日行动生成 3–5 步的可执行计划。
//
// 这不是常驻的 AI 教练会话：不建独立工作区、不做性格/关系分析、不加长期记忆，
// 只围绕用户点开的这一条建议，把时机、做法、话术、分支与边界说清楚。
// 结果按行动 id 缓存，重复点开直接返回，不重复消耗模型调用；用户点「重新生成」才重算。

function currentScheduleContext(action, schedules, contactName) {
  const items = schedules.listSchedules();
  const byId = new Map(items.map(item => [item.id, item]));
  const evidence = (action.evidence || []).filter(item => item.type === 'schedule' && typeof item.scheduleId === 'string');
  const referenced = new Set(evidence.map(item => item.scheduleId));
  const scheduleEvidenceStatus = evidence.map(snapshot => {
    const current = byId.get(snapshot.scheduleId);
    if (!current) return { scheduleId: snapshot.scheduleId, state: 'deleted' };
    if (current.source?.contact !== contactName) return { scheduleId: snapshot.scheduleId, state: 'unattributed' };
    const status = current.status || 'open';
    const state = ['done', 'completed'].includes(status) ? 'completed'
      : ['cancelled', 'canceled'].includes(status) ? 'cancelled' : status === 'open' ? 'open' : 'inactive';
    const currentText = current.title + (current.detail ? `：${current.detail}` : '');
    return { scheduleId: snapshot.scheduleId, state, status,
      changed: snapshot.timestamp !== current.startAt || (snapshot.text !== undefined && snapshot.text !== currentText) };
  });
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 7);
  const related = items.filter(item => item.source?.contact === contactName);
  const upcoming = related.filter(item => item.status === 'open' && !referenced.has(item.id)
    && Date.parse(item.endAt || item.startAt) >= start.getTime() && Date.parse(item.startAt) < end.getTime())
    .sort((left, right) => String(left.startAt).localeCompare(String(right.startAt))).slice(0, 10);
  const latestSchedules = [...related.filter(item => referenced.has(item.id)), ...upcoming].map(item => ({
    id: item.id, title: String(item.title || '').slice(0, 160), detail: String(item.detail || '').slice(0, 1000),
    startAt: item.startAt, endAt: item.endAt || null, status: item.status || 'open', updatedAt: item.updatedAt || ''
  }));
  return { latestSchedules, scheduleEvidenceStatus };
}

function planPayload(action, contactContext, scheduleContext = {}) {
  const now = new Date();
  return {
    requestedAt: now.toISOString(),
    localTime: now.toLocaleString('zh-CN', { hour12: false }),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    action, contactContext, ...scheduleContext
  };
}

function createPlanService({ db, getAction, chatDb, schedules, runTask, now = () => new Date() }) {
  db.exec(`CREATE TABLE IF NOT EXISTS social_daily_plan (
    action_id TEXT PRIMARY KEY, contact_name TEXT NOT NULL,
    plan_json TEXT NOT NULL DEFAULT '', prompt TEXT NOT NULL DEFAULT '',
    state TEXT NOT NULL DEFAULT 'pending', error TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL
  )`);
  const active = new Map();
  const read = id => db.prepare('SELECT * FROM social_daily_plan WHERE action_id=?').get(id);
  const unavailable = () => ({ ok: false, status: 502, error: '详细计划暂时无法生成，请稍后重试。' });

  function cached(record) {
    if (!record || record.state !== 'done' || !record.plan_json) return null;
    try { return JSON.parse(record.plan_json); } catch { return null; }
  }

  async function open(id, { recreate = false } = {}) {
    const action = await getAction(id);
    if (!action) return { ok: false, status: 404, error: '这条行动已不存在，请刷新首页。' };
    const member = chatDb.getMember(action.contactName);
    if (!member) return { ok: false, status: 404, error: '行动关联的联系人已不存在。' };
    let record = read(id);
    if (record && record.contact_name !== member.name) return { ok: false, status: 409, error: '行动关联的联系人已改变，请刷新首页。' };
    const previous = cached(record);
    if (previous && !recreate) {
      return { ok: true, contactName: member.name, plan: previous, cached: true, generatedAt: record.updated_at };
    }
    const contactContext = chatDb.contactContext(member.name, { limit: 80, hotOnly: false }) || {};
    const payload = planPayload(action, contactContext, currentScheduleContext(action, schedules, member.name));
    const stamp = new Date(now()).toISOString();
    db.prepare(`INSERT INTO social_daily_plan(action_id,contact_name,plan_json,prompt,state,error,updated_at)
      VALUES(?,?,'',?,'running','',?) ON CONFLICT(action_id) DO UPDATE SET
      contact_name=excluded.contact_name,prompt=excluded.prompt,state='running',error='',updated_at=excluded.updated_at`)
      .run(id, member.name, JSON.stringify(payload), stamp);
    let result;
    try {
      result = await runTask('daily_action_plan', payload, { timeoutMs: 60000, retries: 0 });
    } catch {
      result = null;
    }
    if (!result?.ok || !result.plan) {
      const message = '详细计划暂时无法生成，请稍后重试。';
      db.prepare("UPDATE social_daily_plan SET state='error',error=?,updated_at=? WHERE action_id=?")
        .run(message, new Date(now()).toISOString(), id);
      return { ok: false, status: 502, error: message };
    }
    const doneAt = new Date(now()).toISOString();
    db.prepare("UPDATE social_daily_plan SET state='done',plan_json=?,error='',updated_at=? WHERE action_id=?")
      .run(JSON.stringify(result.plan), doneAt, id);
    return { ok: true, contactName: member.name, plan: result.plan, cached: false, generatedAt: doneAt };
  }

  return {
    open(id, options) {
      if (active.has(id)) return active.get(id);
      const operation = Promise.resolve().then(() => open(id, options)).catch(() => unavailable()).finally(() => active.delete(id));
      active.set(id, operation);
      return operation;
    }
  };
}

let service;
function open(id, options) {
  if (!service) {
    const chatDb = require('../memory/chat-db');
    service = createPlanService({
      db: chatDb.db,
      chatDb,
      getAction: name => require('./daily-actions').getAction(name),
      schedules: require('../memory/stores/schedules'),
      runTask: require('../engine/client').runTask
    });
  }
  return service.open(id, options);
}

module.exports = { open, createPlanService, planPayload, currentScheduleContext };
