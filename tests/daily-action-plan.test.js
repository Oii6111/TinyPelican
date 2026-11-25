'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { createPlanService } = require('../core/social/daily-action-plan');
const { parseDailyActionPlan } = require('../core/engine/prompts/daily-actions');

function fixture(context) {
  const db = new DatabaseSync(':memory:');
  context.after(() => db.close());
  const actions = new Map([
    ['first', { id: 'first', contactName: '小雨', date: '2026-11-15', title: '轻松聊聊考试', summary: '询问考试结束后的感受', reason: '对方刚考完试。', evidence: [{ messageId: 8 }] }],
    ['second', { id: 'second', contactName: '小夏', date: '2026-11-15', title: '准备见面话题' }]
  ]);
  const calls = [];
  const schedules = [];
  let latest = '考试已经结束';
  let failNext = false;
  let gate = null;
  const dependencies = {
    db,
    getAction: id => actions.get(id),
    schedules: { listSchedules: () => schedules },
    chatDb: {
      getMember: name => ({ name }),
      contactContext: name => ({ contact: name, recentMessages: [{ id: 8, content: latest }], messageCoverage: { previewIsPartial: true } })
    },
    runTask: async (taskName, payload, options) => {
      calls.push({ taskName, payload, options });
      if (gate) await gate;
      if (failNext) { failNext = false; return { ok: false, error: '模型暂不可用' }; }
      return parseDailyActionPlan(JSON.stringify({
        steps: [
          { title: '选时机', detail: `结合近况：${payload.contactContext.recentMessages[0].content}`, say: '考完啦？' },
          { title: '接话题', detail: '问一个开放式问题，不急着给建议。' },
          { title: '收尾', detail: '对方忙就停，留出下次再聊的空间。' }
        ],
        branches: [{ when: '对方主动展开', how: '顺着对方说的内容多问一句。' }],
        cautions: ['不连发消息。']
      }));
    },
    now: () => new Date('2026-11-15T04:00:00Z')
  };
  return {
    db, actions, schedules, calls, dependencies,
    service: createPlanService(dependencies),
    restart: () => createPlanService(dependencies),
    setLatest: value => { latest = value; },
    failNext: () => { failNext = true; },
    setGate: value => { gate = value; }
  };
}

test('detailed plan is generated once, cached, and reused without a second model call', async context => {
  const state = fixture(context);
  const first = await state.service.open('first');
  assert.equal(first.ok, true);
  assert.equal(first.cached, false);
  assert.equal(first.plan.steps.length, 3);
  assert.equal(first.contactName, '小雨');
  assert.equal(state.calls.length, 1);
  assert.equal(state.calls[0].taskName, 'daily_action_plan');
  assert.equal(state.calls[0].payload.action.title, '轻松聊聊考试');
  assert.equal(state.calls[0].options.timeoutMs, 60000);
  assert.equal(state.calls[0].options.retries, 0);

  const cached = await state.service.open('first');
  assert.equal(cached.ok, true);
  assert.equal(cached.cached, true);
  assert.deepEqual(cached.plan, first.plan);
  assert.equal(state.calls.length, 1);

  const other = await state.service.open('second');
  assert.equal(other.ok, true);
  assert.equal(other.cached, false);
  assert.equal(state.calls.length, 2);
  assert.equal(state.calls[1].payload.action.title, '准备见面话题');
});

test('recreate regenerates the plan with the latest context instead of serving the cache', async context => {
  const state = fixture(context);
  await state.service.open('first');
  state.setLatest('新的聊天情况');
  const recreated = await state.service.open('first', { recreate: true });
  assert.equal(recreated.cached, false);
  assert.equal(state.calls.length, 2);
  assert.equal(state.calls[1].payload.contactContext.recentMessages[0].content, '新的聊天情况');
  assert.equal(recreated.plan.steps[0].detail, '结合近况：新的聊天情况');
});

test('concurrent clicks share one plan generation', async context => {
  const state = fixture(context);
  let release;
  state.setGate(new Promise(resolve => { release = resolve; }));
  const first = state.service.open('first');
  const second = state.service.open('first');
  assert.equal(first, second);
  await new Promise(setImmediate);
  assert.equal(state.calls.length, 1);
  release();
  assert.deepEqual(await first, await second);
  assert.equal(state.calls.length, 1);
});

test('missing actions and model failures never create a fake plan', async context => {
  const state = fixture(context);
  const missing = await state.service.open('unknown');
  assert.equal(missing.status, 404);
  assert.equal(state.calls.length, 0);

  state.failNext();
  const failed = await state.service.open('first');
  assert.equal(failed.status, 502);
  assert.match(failed.error, /无法生成/);
  assert.equal(state.calls.length, 1);

  const retried = await state.service.open('first');
  assert.equal(retried.ok, true);
  assert.equal(state.calls.length, 2);
  const row = state.db.prepare('SELECT state FROM social_daily_plan WHERE action_id=?').get('first');
  assert.equal(row.state, 'done');

  state.actions.delete('first');
  assert.equal((await state.service.open('first')).status, 404);
});

test('plan uses the latest schedule state and never leaks another contact', async context => {
  const state = fixture(context);
  state.actions.get('first').evidence = ['deleted', 'done', 'cancelled', 'other', 'unlinked'].map(scheduleId => ({
    type: 'schedule', scheduleId, timestamp: '2026-11-15T18:00:00+08:00', text: '原有安排'
  }));
  state.schedules.push(
    { id: 'done', title: '已经见面', startAt: '2026-11-15T18:00:00+08:00', status: 'done', source: { contact: '小雨' } },
    { id: 'cancelled', title: '已经取消', startAt: '2026-11-15T18:00:00+08:00', status: 'cancelled', source: { contact: '小雨' } },
    { id: 'other', title: '另一个联系人的秘密行程', startAt: '2026-11-15T18:00:00+08:00', status: 'open', source: { contact: '小夏' } },
    { id: 'unlinked', title: '无法确认对象的安排', startAt: '2026-11-15T18:00:00+08:00', status: 'open', source: null }
  );
  const opened = await state.service.open('first');
  assert.equal(opened.ok, true);
  const payload = state.calls.at(-1).payload;
  assert.deepEqual(payload.scheduleEvidenceStatus.map(item => [item.scheduleId, item.state]), [
    ['deleted', 'deleted'], ['done', 'completed'], ['cancelled', 'cancelled'], ['other', 'unattributed'], ['unlinked', 'unattributed']
  ]);
  assert.deepEqual(payload.latestSchedules.map(item => item.id), ['done', 'cancelled']);
  const serialized = JSON.stringify(payload);
  assert.doesNotMatch(serialized, /另一个联系人的秘密行程|无法确认对象的安排/);
});

test('plan cache survives service reconstruction', async context => {
  const state = fixture(context);
  const first = await state.service.open('first');
  const restarted = state.restart();
  const again = await restarted.open('first');
  assert.equal(again.cached, true);
  assert.deepEqual(again.plan, first.plan);
  assert.equal(state.calls.length, 1);
});
