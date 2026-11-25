'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { createDailyActionsService, localDate } = require('../core/social/daily-actions');
const { parseDailyActions } = require('../core/engine/prompts/daily-actions');

function fixture(context) {
  const db = new DatabaseSync(':memory:');
  context.after(() => db.close());
  let clock = new Date(2026, 10, 15, 12);
  const members = [
    { id: 1, name: '小夏', remark: '夏夏', profile: { 核心心理需求: { 情绪回应偏好: '希望先被倾听' } }, socialGoal: '想尽快约她出来看展', lastMessageId: 11 },
    { id: 2, name: '小林', profile: {}, socialGoal: '', lastMessageId: 22 },
    { id: 3, name: '本人', profile: {}, socialGoal: '' },
    { id: 4, name: 'inbox', profile: {}, socialGoal: '' },
    { id: 5, name: '未归属聊天', profile: {}, socialGoal: '' },
    { id: 6, name: '同学群', kind: 'group', profile: {}, socialGoal: '', lastMessageId: 30 },
    { id: 7, name: '群里的小雨', kind: 'member', profile: {}, socialGoal: '慢慢了解', lastMessageId: 31 }
  ];
  const messages = {
    小夏: [{ id: 11, sender: '小夏', ts: '2026-11-14 10:00', content: '周末想去看展', isOwner: false }],
    小林: [{ id: 22, sender: '小林', ts: '2026-11-14 12:00', content: '最近在准备考试', isOwner: false }]
  };
  const schedules = [
    { id: 'schedule-1', title: '看展', status: 'open', startAt: new Date(2026, 10, 15, 18).toISOString(), source: { contact: '小夏' } },
    { id: 'schedule-2', title: '小夏一起吃饭', status: 'open', startAt: new Date(2026, 10, 15, 19).toISOString() },
    { id: 'schedule-3', title: '考试', status: 'open', startAt: new Date(2026, 10, 16, 9).toISOString(), source: { contact: '小林' } }
  ];
  const calls = [];
  let respond = input => ({ actions: [{ kind: 'topic', title: `关心${input.contact.name}分享的事情`, summary: '从最近分享的话题问一个开放式问题。', reason: '对方主动分享了近况，可以先倾听。', evidenceIds: [input.evidenceSources.find(source => source.type === 'message')?.id || input.evidenceSources[0].id] }] });
  const dependencies = {
    chatDb: {
      db, listMembers: () => members,
      getMember: name => members.find(member => member.name === name),
      contactContext: name => ({ recentMessages: messages[name] || [], messageCoverage: { totalCount: (messages[name] || []).length, previewIsPartial: false }, chatSummary: {} })
    },
    schedules: { listSchedules: () => schedules },
    getConfig: () => ({ selfNicknames: ['本人'], userPersona: '希望自然沟通' }),
    now: () => new Date(clock),
    runTask: async (taskName, input, options) => {
      calls.push({ taskName, input, options });
      const payload = await respond(input);
      if (payload.ok === false) return payload;
      return parseDailyActions(JSON.stringify(payload), input);
    }
  };
  return { service: createDailyActionsService(dependencies), db, dependencies, members, messages, schedules, calls,
    setClock: value => { clock = value; }, setRespond: value => { respond = value; } };
}

test('daily generation isolates each contact, preserves social goals and bounds evidence to matched records', async context => {
  const state = fixture(context);
  const initial = state.service.list();
  // 群和「群里还没加联系人的人」都不是可以维护的社交对象，不能进今日行动。
  assert.deepEqual(initial.contacts.map(contact => contact.contactName), ['小夏']);
  assert.equal(initial.goalMissing.count, 1);
  assert.deepEqual(initial.goalMissing.contacts.map(contact => contact.contactName), ['小林']);
  assert.equal(initial.contacts[0].status, 'missing');
  assert.equal(state.calls.length, 0);
  const queued = state.service.generate();
  assert.equal(queued.contacts.every(contact => contact.status === 'queued'), true);
  await state.service.whenIdle();
  assert.equal(state.calls.length, 2);
  const first = state.calls.find(call => call.input.contact.name === '小夏');
  const second = state.calls.find(call => call.input.contact.name === '小林');
  assert.equal(first.taskName, 'daily_actions');
  assert.equal(first.options.timeoutMs, 60000);
  assert.equal(first.options.retries, 0);
  assert.equal(first.input.goal, '想尽快约她出来看展');
  assert.equal(first.input.contact.name, '小夏');
  // 没有额外的关系档案：语境只来自联系人资料本身
  assert.equal('relationship' in first.input, false);
  assert.deepEqual(first.input.schedules.map(schedule => schedule.id), ['schedule-1']);
  assert.equal(first.input.recentMessages.some(message => message.id === 22), false);
  assert.equal(second.input.missingGoal, true);
  const result = state.service.list();
  assert.ok(result.contacts.every(contact => contact.status === 'ready' && !contact.hasNewData));
  assert.equal(result.contacts[0].actions[0].evidence[0].text, '周末想去看展');
  assert.equal(result.contacts[0].actions[0].evidence[0].messageId, 11);
  assert.equal(state.service.getAction(result.contacts[0].actions[0].id).contactName, '小夏');
});

test('generation is single flight per day and serial across contacts', async context => {
  const state = fixture(context);
  let release;
  let active = 0;
  let maximum = 0;
  state.setRespond(async input => {
    active++;
    maximum = Math.max(maximum, active);
    await new Promise(resolve => { release = resolve; });
    active--;
    return { actions: [], emptyReason: `等待${input.contact.name}的更多近况` };
  });
  state.service.generate();
  state.service.generate();
  await new Promise(setImmediate);
  assert.equal(state.calls.length, 1);
  state.service.generate({ contactName: '小夏', force: true });
  release();
  await new Promise(setImmediate);
  assert.equal(state.calls.length, 2);
  release();
  await state.service.whenIdle();
  assert.equal(maximum, 1);
  state.service.generate();
  await state.service.whenIdle();
  assert.equal(state.calls.length, 2);
});

test('a contact queued while the previous drain settles starts without another request', async context => {
  const state = fixture(context);
  state.members.find(member => member.name === '小林').socialGoal = '慢慢了解他的兴趣';
  let release;
  state.setRespond(async input => {
    if (input.contact.name === '小夏') await new Promise(resolve => { release = resolve; });
    return { actions: [], emptyReason: '等待更多近况' };
  });
  state.service.generate({ contactName: '小夏' });
  await new Promise(setImmediate);
  release();
  queueMicrotask(() => queueMicrotask(() => state.service.generate({ contactName: '小林' })));
  await state.service.whenIdle();
  assert.equal(state.calls.length, 2);
  const after = state.service.list();
  assert.deepEqual(after.contacts.map(contact => contact.status), ['ready', 'ready']);
  assert.deepEqual(after.goalMissing.contacts, []);
});

test('same-day cache survives refreshes, completed suggestions persist and only manual updates use new data', async context => {
  const state = fixture(context);
  state.service.generate();
  await state.service.whenIdle();
  const action = state.service.list().contacts[0].actions[0];
  assert.equal(state.service.feedback(action.id, 'done').ok, true);
  state.messages.小夏.push({ id: 12, sender: '小夏', content: '周末可能要加班', ts: '2026-11-15 13:00' });
  const cached = state.service.list().contacts[0];
  assert.equal(cached.hasNewData, true);
  assert.equal(cached.actions[0].id, action.id);
  assert.equal(cached.actions[0].status, 'done');
  state.service.generate();
  await state.service.whenIdle();
  assert.equal(state.calls.length, 2);
  state.setRespond(input => ({ actions: [
    { kind: action.kind, title: action.title, summary: action.summary, reason: action.reason, evidenceIds: ['message:11'] },
    { kind: 'pause', title: '先留出忙碌的空间', summary: '今天不催问周末安排。', reason: '对方刚补充了加班的可能性。', evidenceIds: ['message:12'] }
  ] }));
  state.service.generate({ contactName: '小夏', force: true });
  await state.service.whenIdle();
  assert.equal(state.calls.length, 3);
  assert.equal(state.calls[2].input.previousActions[0].status, 'done');
  const fresh = state.service.list().contacts[0];
  assert.equal(fresh.hasNewData, false);
  assert.equal(fresh.actions.length, 2);
  assert.equal(fresh.actions.find(item => item.id === action.id).status, 'done');
  assert.equal(fresh.actions.filter(item => item.status === 'pending')[0].kind, 'pause');
  assert.equal(state.service.feedback(action.id, 'pending').action.status, 'pending');
  assert.equal(state.service.feedback(action.id, 'unexpected').status, 400);
});

test('failed regeneration preserves prior results and no read or automatic ensure silently retries', async context => {
  const state = fixture(context);
  state.service.generate();
  await state.service.whenIdle();
  const before = state.service.list().contacts[0];
  state.setRespond(() => ({ actions: [{ kind: 'topic', title: '无效引用', summary: '错误输出', reason: '不能使用另一个人的消息', evidenceIds: ['message:999'] }] }));
  state.service.generate({ contactName: '小夏', force: true });
  await state.service.whenIdle();
  const failed = state.service.list().contacts[0];
  assert.equal(failed.status, 'error');
  assert.match(failed.error, /校验/);
  assert.deepEqual(failed.actions, before.actions);
  assert.equal(failed.generatedAt, before.generatedAt);
  state.service.list();
  state.service.generate();
  await state.service.whenIdle();
  assert.equal(state.calls.length, 3);
});

test('feedback on a replaced recommendation is rejected while its action stays readable', async context => {
  const state = fixture(context);
  state.service.generate({ contactName: '小夏' });
  await state.service.whenIdle();
  const previous = state.service.list().contacts[0].actions[0];
  state.setRespond(() => ({ actions: [{ kind: 'care', title: '关注近况里的具体需要', summary: '先听完分享，再问是否需要帮忙。', reason: '根据已有交流偏好提供支持。', evidenceIds: ['message:11'] }] }));
  state.service.generate({ contactName: '小夏', force: true });
  await state.service.whenIdle();
  assert.ok(state.service.getAction(previous.id));
  const rejected = state.service.feedback(previous.id, 'done');
  assert.equal(rejected.status, 409);
  assert.match(rejected.error, /推荐已更新/);
  assert.equal(state.service.getAction(previous.id).status, 'pending');
  const current = state.service.list().contacts[0].actions;
  assert.equal(current.length, 1);
  assert.notEqual(current[0].id, previous.id);
  assert.equal(current[0].status, 'pending');
});

test('daily state persists across service reconstruction and resets on the local calendar day', async context => {
  const state = fixture(context);
  state.setClock(new Date(2026, 10, 15, 23, 59));
  state.service.generate();
  await state.service.whenIdle();
  const action = state.service.list().contacts[0].actions[0];
  state.service.feedback(action.id, 'dismissed');
  const restored = createDailyActionsService(state.dependencies);
  restored.generate();
  await restored.whenIdle();
  assert.equal(state.calls.length, 2);
  assert.equal(restored.list().contacts[0].actions[0].status, 'dismissed');
  state.setClock(new Date(2026, 10, 16, 0, 1));
  assert.equal(restored.list().date, '2026-11-16');
  assert.equal(restored.list().contacts[0].status, 'missing');
  assert.equal(restored.feedback(action.id, 'done').status, 409);
  restored.generate();
  await restored.whenIdle();
  assert.equal(state.calls.length, 4);
  assert.notEqual(restored.list().contacts[0].actions[0].id, action.id);
  const nextDay = state.calls.find(call => call.input.contact.name === '小夏' && call.input.date === '2026-11-16');
  assert.equal(nextDay.input.previousActions[0].status, 'dismissed');
  assert.equal(localDate(new Date(2026, 10, 16, 0, 1)), '2026-11-16');
});

test('a response crossing local midnight is saved only to its original day', async context => {
  const state = fixture(context);
  state.setClock(new Date(2026, 10, 15, 23, 59));
  let release;
  state.setRespond(async input => {
    if (input.date === '2026-11-15') await new Promise(resolve => { release = resolve; });
    return { actions: [{ kind: 'topic', title: '聊聊最近分享的事情', summary: '询问对方最近提到的展览。', reason: '接续对方分享的兴趣。', evidenceIds: ['message:11'] }] };
  });
  state.service.generate({ contactName: '小夏' });
  await new Promise(setImmediate);
  state.setClock(new Date(2026, 10, 16, 0, 1));
  state.service.generate({ contactName: '小夏' });
  release();
  await state.service.whenIdle();
  assert.equal(state.calls.length, 2);
  const current = state.service.list();
  assert.equal(current.date, '2026-11-16');
  assert.equal(current.contacts[0].status, 'ready');
  assert.equal(current.contacts[0].actions[0].date, '2026-11-16');
  const history = state.db.prepare('SELECT id,local_date FROM social_daily_actions WHERE member_id=1 ORDER BY local_date').all();
  assert.deepEqual(history.map(item => item.local_date), ['2026-11-15', '2026-11-16']);
  assert.notEqual(history[0].id, history[1].id);
});

test('oversized previews explicitly mark truncation', async context => {
  const state = fixture(context);
  state.schedules.length = 0;
  // 没填社交目的的联系人不再生成今日行动，所以这里给小林一个目的，只验证截断标记。
  state.members.find(member => member.name === '小林').socialGoal = '保持老朋友的日常问候';
  state.messages.小林 = Array.from({ length: 90 }, (_, index) => ({ id: index + 100, sender: '小林', content: '内容'.repeat(1000), ts: '2026-11-15 10:00' }));
  state.service.generate();
  await state.service.whenIdle();
  const call = state.calls.find(item => item.input.contact.name === '小林');
  assert.ok(call, '小林应当被生成');
  const input = call.input;
  assert.ok(input.recentMessages.length <= 80);
  assert.ok(input.recentMessages.reduce((total, item) => total + item.content.length, 0) <= 12000);
  assert.equal(input.messageCoverage.inputTruncated, true);
  assert.equal(input.recentMessages.at(-1).id, 189);
});

test('removed contacts invalidate stored action access and new contacts receive their own daily result', async context => {
  const state = fixture(context);
  state.service.generate();
  await state.service.whenIdle();
  const action = state.service.list().contacts[0].actions[0];
  state.members.splice(0, 1);
  assert.equal(state.service.getAction(action.id), null);
  assert.equal(state.service.feedback(action.id, 'done').status, 404);
  state.members.push({ id: 8, name: '新联系人', socialGoal: '先了解兴趣', profile: {} });
  state.service.generate();
  await state.service.whenIdle();
  assert.equal(state.calls.length, 3);
  assert.equal(state.service.list().contacts.find(item => item.contactName === '新联系人').status, 'ready');
});

test('daily action routes validate mutations and never trigger generation on GET', async () => {
  const handlers = new Map();
  const calls = [];
  const service = {
    list: () => ({ date: '2026-11-15', contacts: [] }),
    generate: options => { calls.push(options); return { ok: true, contacts: [] }; },
    feedback: (id, status) => ({ ok: true, action: { id, status } })
  };
  require('../core/api/routes/daily-actions')({
    get: (url, handler) => handlers.set(`GET ${url}`, handler),
    post: (url, handler) => handlers.set(`POST ${url}`, handler)
  }, { readBody: async request => request.body, json: (response, status, body) => ({ status, body }) }, service);
  const response = { setHeader() {} };
  assert.equal(handlers.get('GET /api/daily-actions')({}, response).status, 200);
  assert.equal(calls.length, 0);
  const generate = handlers.get('POST /api/daily-actions/generate');
  assert.equal((await generate({ body: '{}', headers: { 'sec-fetch-site': 'cross-site' } }, response)).status, 403);
  assert.equal((await generate({ body: '{}', headers: { host: 'localhost:18791', origin: 'https://example.com' } }, response)).status, 403);
  for (const body of ['bad-json', 'null', '[]', '12', '{"force":true}', '{"contactName":23}', '{"force":"true"}']) {
    assert.equal((await generate({ body }, response)).status, 400);
  }
  assert.equal((await generate({ body: '{"contactName":"小夏","force":true}' }, response)).status, 202);
  assert.deepEqual(calls, [{ contactName: '小夏', force: true, avoid: [] }]);
  const feedback = handlers.get('POST /api/daily-actions/:id/feedback');
  assert.equal((await feedback({ body: '{"status":"done"}' }, response, {}, { id: 'action-1' })).body.action.id, 'action-1');
});
