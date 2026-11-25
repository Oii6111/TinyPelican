'use strict';

// 今日行动「换一批」：
// - 整体换一批：重新生成今天的全部建议，避开当前在显示的那些标题
// - 单条换一批：只把这一条换掉，其余尽量保持
// 模型经常把同一句话原样再给一遍，所以 avoid 必须真的参与过滤，
// 并且「一条新的都没换出来」时要保留原来那批，不能把用户正在看的建议清空。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { createDailyActionsStore, titleKey } = require('../core/memory/stores/daily-actions');
const { createDailyActionsService } = require('../core/social/daily-actions');
const { parseDailyActions } = require('../core/engine/prompts/daily-actions');

const DATE = '2026-11-15';

test('avoid 按标题过滤，且没换出新的就保留原来那批', (context) => {
  const db = new DatabaseSync(':memory:');
  context.after(() => db.close());
  const store = createDailyActionsStore(db);
  const payload = actions => ({ actions, emptyReason: '' });
  const original = [{ kind: 'topic', title: '聊聊看展', summary: '问她最近想看什么', reason: '刚聊到' }];

  store.saveResult(1, DATE, payload(original), 'fp1', 'now');
  assert.deepEqual(store.actions(1, DATE).map(action => action.title), ['聊聊看展']);

  // 模型原样再给一遍：不能把原来的清掉，要如实告诉调用方「这次没换成」
  const same = store.saveResult(1, DATE, payload(original), 'fp2', 'now', { avoid: ['聊聊看展'] });
  assert.equal(same.reused, true);
  assert.deepEqual(store.actions(1, DATE).map(action => action.title), ['聊聊看展']);

  // 标题里的空格与大小写不影响判断
  const spaced = store.saveResult(1, DATE, payload(original), 'fp2', 'now', { avoid: [' 聊聊 看展 '] });
  assert.equal(spaced.reused, true);

  // 给出新标题就替换掉
  const fresh = [{ kind: 'care', title: '问她展览里最喜欢哪件', summary: '接着问细节', reason: '她对展览有兴趣' }];
  const replaced = store.saveResult(1, DATE, payload(fresh), 'fp3', 'now', { avoid: ['聊聊看展'] });
  assert.equal(replaced.reused, false);
  assert.deepEqual(store.actions(1, DATE).map(action => action.title), ['问她展览里最喜欢哪件']);

  assert.equal(titleKey('  聊聊 看展 '), '聊聊看展');
});

function fixture(context, options = {}) {
  const db = new DatabaseSync(':memory:');
  context.after(() => db.close());
  const clock = new Date(2026, 10, 15, 12);
  const members = options.members || [
    { id: 1, name: '小夏', remark: '夏夏', profile: {}, socialGoal: '想尽快约她出来看展', lastMessageId: 11 }
  ];
  const messages = { 小夏: [{ id: 11, sender: '我', ts: '2026-11-14 10:00', content: '周末想去看展吗', isOwner: true }] };
  const calls = [];
  const titles = options.titles || ['第一次建议'];
  let round = 0;
  const dependencies = {
    chatDb: {
      db, listMembers: () => members,
      getMember: name => members.find(member => member.name === name),
      contactContext: name => ({ recentMessages: messages[name] || [], messageCoverage: { totalCount: (messages[name] || []).length, previewIsPartial: false }, chatSummary: {} })
    },
    schedules: { listSchedules: () => options.schedules || [] },
    getConfig: () => ({ selfNicknames: [], userPersona: '' }),
    now: () => new Date(clock),
    runTask: async (taskName, input) => {
      calls.push({ taskName, input });
      const title = titles[Math.min(round, titles.length - 1)];
      round += 1;
      return parseDailyActions(JSON.stringify({
        actions: [{ kind: 'topic', title, summary: '从最近聊到的话题接着问。', reason: '对方刚分享了近况。', evidenceIds: [input.evidenceSources[0].id] }]
      }), input);
    }
  };
  return { service: createDailyActionsService(dependencies), db, calls, members };
}

test('整体换一批把当前标题作为 avoid 传给模型，并换掉旧建议', async (context) => {
  const state = fixture(context, { titles: ['聊聊看展', '问她想看的展览是哪一场'] });
  state.service.generate();
  await state.service.whenIdle();
  const before = state.service.list().contacts[0].actions.map(action => action.title);
  assert.deepEqual(before, ['聊聊看展']);

  state.service.generate({ force: true, avoid: before });
  await state.service.whenIdle();
  assert.deepEqual(state.calls.at(-1).input.avoidSuggestions, before);

  const after = state.service.list().contacts[0].actions.map(action => action.title);
  assert.deepEqual(after, ['问她想看的展览是哪一场']);
});

test('单条换一批只避开那一条', async (context) => {
  const state = fixture(context, { titles: ['聊聊看展', '换个方向问问周末安排'] });
  state.service.generate();
  await state.service.whenIdle();
  const action = state.service.list().contacts[0].actions[0];
  state.service.generate({ contactName: '小夏', force: true, avoid: [action.title] });
  await state.service.whenIdle();
  assert.deepEqual(state.calls.at(-1).input.avoidSuggestions, ['聊聊看展']);
  assert.deepEqual(state.service.list().contacts[0].actions.map(item => item.title), ['换个方向问问周末安排']);
});

test('没有社交目的的联系人换一批也不调模型', async (context) => {
  const state = fixture(context);
  state.members.find(member => member.name === '小夏').socialGoal = '';
  state.service.generate({ force: true });
  await state.service.whenIdle();
  assert.equal(state.calls.length, 0);
  const contact = state.service.list().goalMissing.contacts[0];
  assert.equal(contact.status, 'resting');
  assert.match(contact.emptyReason, /社交目的/);
});

test('换一批的路由：允许不带联系人，校验 avoid', async () => {
  const handlers = new Map();
  const calls = [];
  const service = {
    list: () => ({ date: DATE, contacts: [] }),
    generate: options => { calls.push(options); return { ok: true }; },
    feedback: (id, status) => ({ ok: true, action: { id, status } })
  };
  require('../core/api/routes/daily-actions')({
    get: (url, handler) => handlers.set(`GET ${url}`, handler),
    post: (url, handler) => handlers.set(`POST ${url}`, handler)
  }, { readBody: async request => request.body, json: (res, code, data) => ({ status: code, data }) }, service);
  const generate = handlers.get('POST /api/daily-actions/generate');
  const response = { setHeader() {} };
  const send = body => generate({ body, headers: { host: 'localhost:18791' } }, response);

  assert.equal((await send('{"reshuffle":true}')).status, 202);
  assert.deepEqual(calls.at(-1), { contactName: '', force: true, avoid: [] });

  assert.equal((await send('{"reshuffle":true,"avoid":["甲","乙"]}')).status, 202);
  assert.deepEqual(calls.at(-1).avoid, ['甲', '乙']);

  assert.equal((await send('{"contactName":"小夏","reshuffle":true,"avoid":["甲"]}')).status, 202);
  assert.deepEqual(calls.at(-1), { contactName: '小夏', force: true, avoid: ['甲'] });

  for (const body of ['{"avoid":"x"}', '{"avoid":["a","b","c","d","e"]}', '{"avoid":[1]}', '{"reshuffle":"yes"}', '{"force":true}']) {
    assert.equal((await send(body)).status, 400, body);
  }
});
