'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { createDailyActionsService, gapFor, intervalOf, intervalForGoal, dayDifference, INTERVAL_META,
  signalsFrom, adjustInterval, recentMessageCount } = require('../core/social/daily-actions');
const { INTERVALS, RULES } = require('../core/social/goal-interval');
const { ADJUSTMENTS, buildCadenceEvidence, clampIntervalDays, WEIGHTS } = require('../core/social/cadence');
const { parseDailyActions } = require('../core/engine/prompts/daily-actions');

function fixture(context, options = {}) {
  const db = new DatabaseSync(':memory:');
  context.after(() => db.close());
  let clock = new Date(options.now || new Date(2026, 10, 15, 12));
  const members = options.members || [
    { id: 1, name: '小夏', remark: '夏夏', profile: {}, profileMeta: {}, socialGoal: '慢慢了解彼此的兴趣', lastMessageId: 11 },
    { id: 2, name: '小林', profile: {}, profileMeta: {}, socialGoal: '', lastMessageId: 22 }
  ];
  const messages = options.messages || {
    小夏: [{ id: 11, sender: '我', ts: '2026-11-05 10:00', content: '周末想去看展吗', isOwner: true }],
    小林: [{ id: 22, sender: '小林', ts: '2026-11-14 12:00', content: '最近在准备考试', isOwner: false }]
  };
  const schedules = options.schedules || [];
  const calls = [];
  const respond = input => ({ actions: [{ kind: 'topic', title: `关心${input.contact.name}`, summary: '问一个开放式问题。', reason: '对方分享了近况。', evidenceIds: [input.evidenceSources.find(source => source.type === 'message')?.id || input.evidenceSources[0].id] }] });
  const dependencies = {
    chatDb: {
      db, listMembers: () => members,
      getMember: name => members.find(member => member.name === name),
      contactContext: name => ({ recentMessages: messages[name] || [], messageCoverage: { totalCount: (messages[name] || []).length, previewIsPartial: false }, chatSummary: {} })
    },
    schedules: { listSchedules: () => schedules },
    getConfig: () => ({ selfNicknames: [], userPersona: '' }),
    now: () => new Date(clock),
    runTask: async (taskName, input, opts) => {
      calls.push({ taskName, input, opts });
      return parseDailyActions(JSON.stringify(respond(input)), input);
    }
  };
  const build = () => createDailyActionsService(dependencies);
  const service = build();
  return { service, build, db, dependencies, members, messages, schedules, calls,
    setClock: value => { clock = value; } };
}

function goalOf(state, name, value) {
  state.members.find(member => member.name === name).socialGoal = value;
}

test('interval comes from the social goal and nothing else', () => {
  assert.equal(intervalForGoal('').id, 'unset');
  assert.equal(intervalForGoal('').days, null);
  assert.equal(intervalForGoal('想尽快约她出来').id, 'pursue');
  assert.equal(intervalForGoal('慢慢了解彼此').id, 'build');
  assert.equal(intervalForGoal('保持老朋友的日常问候').id, 'maintain');
  assert.equal(intervalForGoal('先放一放，暂停').id, 'pause');
  assert.equal(intervalForGoal('随便写点别的').id, 'build');
  assert.equal(intervalForGoal('想尽快约她，但也先放一放').id, 'pause');
  assert.equal(INTERVALS.pause.days, null);
  assert.deepEqual(INTERVAL_META.map(item => item.id), ['pursue', 'build', 'maintain', 'pause']);
  for (const rule of RULES) assert.ok(rule.re instanceof RegExp);
});

test('member profile fields never influence the interval', () => {
  const goal = '慢慢了解彼此的兴趣';
  const decorated = { socialGoal: goal, profile: { 核心心理需求: { 情绪回应偏好: '希望先被倾听' } }, profileMeta: { updatedAt: '2026-11-14' }, remark: '夏夏', important: true };
  const bare = { socialGoal: goal };
  assert.equal(intervalOf(decorated).id, intervalOf(bare).id);
  assert.equal(intervalOf(decorated).id, 'build');
  assert.equal(intervalOf(bare).days, 2);
  assert.equal(intervalOf({ socialGoal: '保持老朋友的日常问候' }).id, 'maintain');
});

test('helpers expose day maths and a stable gap summary', () => {
  assert.equal(dayDifference('2026-11-01', '2026-11-21'), 20);
  assert.equal(dayDifference('not-a-date', '2026-11-21'), null);
  const gap = gapFor([
    { id: 1, ts: '2026-11-01 09:00', content: 'a', isOwner: true },
    { id: 2, ts: '2026-11-05 10:00', content: 'b', isOwner: false }
  ], '2026-11-15', '小夏');
  assert.deepEqual(gap, { known: true, daysSinceLastMessage: 10, lastMessageAt: '2026-11-05 10:00',
    lastSpeaker: '小夏', ownerSpokeLast: false, datedMessageCount: 2 });
  assert.equal(gapFor([], '2026-11-15', '小夏').known, false);
});

test('同一天补填社交目的后，过期的「还没填目的」休息理由不再挂着，并且会重新生成', async context => {
  const state = fixture(context);
  const find = name => state.service.list().contacts.find(item => item.contactName === name)
    || state.service.list().goalMissing.contacts.find(item => item.contactName === name);

  // 上午：小夏还没填社交目的 → 落一条「还没填目的」的休息
  goalOf(state, '小夏', '');
  state.service.generate();
  await state.service.whenIdle();
  const before = state.service.list().goalMissing.contacts.find(item => item.contactName === '小夏');
  assert.equal(before.status, 'resting');
  assert.match(before.emptyReason, /还没填社交目的/);

  // 下午：用户把目的填上了，旧理由描述的状态已经不存在
  goalOf(state, '小夏', '慢慢了解彼此的兴趣');
  const after = state.service.list().contacts.find(item => item.contactName === '小夏');
  assert.ok(after, '填了目的就该回到行动列表');
  assert.equal(after.interval, 'build');
  assert.equal(after.status, 'missing', '过期的休息理由要当成还没生成');
  assert.equal(after.emptyReason, '');
  assert.equal(after.hasNewData, true);

  // 页面看到 missing 会自己补生成，这一步不能被「已有队列」挡掉
  state.service.generate();
  await state.service.whenIdle();
  assert.equal(find('小夏').status, 'ready');
});

test('a 了解 goal rests the next day and resumes on the day after', async context => {
  const state = fixture(context);
  const statusOf = () => state.service.list().contacts.find(item => item.contactName === '小夏').status;
  state.setClock(new Date(2026, 10, 15, 12));
  state.service.generate();
  await state.service.whenIdle();
  assert.equal(statusOf(), 'ready');
  const firstInput = state.calls.find(call => call.input.contact.name === '小夏').input;
  assert.equal(firstInput.interval.id, 'build');
  assert.equal(firstInput.interval.days, 2);
  assert.equal(firstInput.gap.daysSinceLastMessage, 10);

  state.setClock(new Date(2026, 10, 16, 12));
  state.service.generate();
  await state.service.whenIdle();
  const resting = state.service.list().contacts.find(item => item.contactName === '小夏');
  assert.equal(resting.status, 'resting');
  assert.match(resting.emptyReason, /每 2 天/);
  assert.equal(resting.hasNewData, false);
  assert.equal(resting.intervalDays, 2);
  assert.deepEqual(resting.actions, []);
  const nobody = state.service.list().goalMissing.contacts.find(item => item.contactName === '小林');
  assert.equal(nobody.status, 'resting');
  assert.equal(nobody.interval, 'unset');
  assert.match(nobody.emptyReason, /还没填社交目的/);
  assert.equal(state.calls.some(call => call.input.contact.name === '小林'), false);

  state.setClock(new Date(2026, 10, 17, 12));
  state.service.generate();
  await state.service.whenIdle();
  assert.equal(statusOf(), 'ready');
});

test('a 推进 goal keeps generating every day', async context => {
  const state = fixture(context);
  goalOf(state, '小夏', '想尽快约她出来看展');
  const statusOf = () => state.service.list().contacts.find(item => item.contactName === '小夏').status;
  for (const day of [15, 16, 17]) {
    state.setClock(new Date(2026, 10, day, 12));
    state.service.generate();
    await state.service.whenIdle();
    assert.equal(statusOf(), 'ready');
  }
});

test('a 维持 goal waits about a week', async context => {
  const state = fixture(context, {
    messages: { 小夏: [{ id: 11, sender: '我', ts: '2026-11-14 10:00', content: '最近怎么样', isOwner: true }] }
  });
  goalOf(state, '小夏', '保持老朋友的日常问候');
  const statusOf = () => state.service.list().contacts.find(item => item.contactName === '小夏').status;
  state.setClock(new Date(2026, 10, 15, 12));
  state.service.generate();
  await state.service.whenIdle();
  assert.equal(statusOf(), 'ready');
  state.setClock(new Date(2026, 10, 20, 12));
  state.service.generate();
  await state.service.whenIdle();
  assert.equal(statusOf(), 'resting');
  state.setClock(new Date(2026, 10, 21, 12));
  state.service.generate();
  await state.service.whenIdle();
  assert.equal(statusOf(), 'ready');
});

test('a schedule within three days overrides the interval so promises are never skipped', async context => {
  const state = fixture(context, {
    schedules: [{ id: 'schedule-1', title: '看展', status: 'open', startAt: new Date(2026, 10, 16, 18).toISOString(), source: { contact: '小夏' } }]
  });
  state.service.generate();
  await state.service.whenIdle();
  state.setClock(new Date(2026, 10, 16, 9));
  state.service.generate();
  await state.service.whenIdle();
  const day16 = state.calls.filter(call => call.input.contact.name === '小夏' && call.input.date === '2026-11-16');
  assert.equal(day16.length, 1);
  assert.ok(day16[0].input.schedules.some(item => item.id === 'schedule-1'));
  assert.equal(state.service.list().contacts.find(item => item.contactName === '小夏').status, 'ready');
});

test('a 暂停 goal generates nothing on its own but still reacts to a schedule', async context => {
  const silent = fixture(context);
  goalOf(silent, '小夏', '先放一放，暂停一阵');
  silent.service.generate();
  await silent.service.whenIdle();
  assert.equal(silent.calls.some(call => call.input.contact.name === '小夏'), false);
  const xia = silent.service.list().contacts.find(item => item.contactName === '小夏');
  assert.equal(xia.status, 'resting');
  assert.match(xia.emptyReason, /暂停/);

  const scheduled = fixture(context, {
    schedules: [{ id: 'schedule-1', title: '生日', status: 'open', startAt: new Date(2026, 10, 16, 9).toISOString(), source: { contact: '小夏' } }]
  });
  goalOf(scheduled, '小夏', '先放一放，暂停一阵');
  scheduled.service.generate();
  await scheduled.service.whenIdle();
  assert.equal(scheduled.calls.some(call => call.input.contact.name === '小夏'), true);
});

test('a manual force refresh ignores the interval', async context => {
  const state = fixture(context);
  state.service.generate();
  await state.service.whenIdle();
  const before = state.calls.length;
  state.setClock(new Date(2026, 10, 16, 9));
  state.service.generate({ contactName: '小夏', force: true });
  await state.service.whenIdle();
  assert.equal(state.calls.length, before + 1);
  assert.equal(state.service.list().contacts.find(item => item.contactName === '小夏').status, 'ready');
});

test('changing the social goal changes the interval on the spot', async context => {
  const state = fixture(context);
  const statusOf = () => state.service.list().contacts.find(item => item.contactName === '小夏').status;
  state.service.generate();
  await state.service.whenIdle();
  state.setClock(new Date(2026, 10, 16, 9));
  state.service.generate();
  await state.service.whenIdle();
  assert.equal(statusOf(), 'resting');
  goalOf(state, '小夏', '想尽快约她出来看展');
  const relaxed = state.service.list().contacts.find(item => item.contactName === '小夏');
  assert.equal(relaxed.interval, 'pursue');
  assert.equal(relaxed.status, 'resting');
  state.service.generate({ contactName: '小夏', force: true });
  await state.service.whenIdle();
  assert.equal(statusOf(), 'ready');
});

test('a model-declared resting day is stored without inventing actions', async context => {
  const state = fixture(context);
  state.dependencies.runTask = async (taskName, input) => parseDailyActions(JSON.stringify({ actions: [], emptyReason: '刚聊完，今天不用再找她。', resting: true }), input);
  const service = state.build();
  service.generate();
  await service.whenIdle();
  const xia = service.list().contacts.find(item => item.contactName === '小夏');
  assert.equal(xia.status, 'resting');
  assert.match(xia.emptyReason, /刚聊完/);
  assert.deepEqual(xia.actions, []);
});

test('restart drops never-started batches and only reports interrupted ones', async context => {
  const state = fixture(context);
  state.service.generate();
  await state.service.whenIdle();
  state.db.prepare("UPDATE social_daily_batches SET status='queued' WHERE member_id=1").run();
  state.db.prepare("UPDATE social_daily_batches SET status='running' WHERE member_id=2").run();
  const restarted = state.build();
  const rows = state.db.prepare('SELECT member_id,status FROM social_daily_batches ORDER BY member_id').all();
  assert.deepEqual(rows.map(row => [row.member_id, row.status]), [[2, 'error']]);
  assert.equal(restarted.list().contacts.find(item => item.contactName === '小夏').status, 'missing');
  restarted.generate({ contactName: '小夏' });
  await restarted.whenIdle();
  assert.equal(restarted.list().contacts.find(item => item.contactName === '小夏').status, 'ready');
});

test('objective signals adjust the base interval and none of them come from AI state', () => {
  const base = { id: 'build', label: '了解', days: 2 };
  assert.equal(adjustInterval(base, {}).days, 2);
  assert.deepEqual(adjustInterval(base, {}).reasons, []);
  assert.equal(adjustInterval(base, { awaitingReply: true }).days, 1);
  assert.equal(adjustInterval(base, { longSilence: true }).days, 4);
  assert.equal(adjustInterval(base, { activeChat: true, ignored: true }).days, 5);
  assert.equal(adjustInterval(base, { adopted: true }).days, 2);
  const both = adjustInterval(base, { awaitingReply: true, adopted: true });
  assert.equal(both.days, 1);
  assert.deepEqual(both.reasons, ['对方最后一句还没回', '最近采纳过建议']);
  assert.equal(adjustInterval({ id: 'pursue', label: '推进', days: 1 }, { awaitingReply: true, adopted: true }).days, 1);
  assert.ok(adjustInterval({ id: 'maintain', label: '维持', days: 6 }, { longSilence: true, activeChat: true, ignored: true }).days <= 30);
  const paused = adjustInterval({ id: 'pause', label: '暂停', days: null }, { awaitingReply: true });
  assert.equal(paused.days, null);
  assert.deepEqual(paused.reasons, []);
  assert.deepEqual(Object.keys(ADJUSTMENTS), ['awaitingReply', 'adopted', 'activeChat', 'ignored', 'longSilence']);
});

test('signals come only from chat facts and user feedback', () => {
  assert.deepEqual(signalsFrom({ gap: { known: true, daysSinceLastMessage: 20, ownerSpokeLast: false }, recentCount: 30, feedback: { done: 0, dismissed: 3 } }),
    { awaitingReply: true, adopted: false, activeChat: true, ignored: true, longSilence: true });
  assert.deepEqual(signalsFrom({ gap: { known: true, daysSinceLastMessage: 2, ownerSpokeLast: true }, recentCount: 3, feedback: { done: 2, dismissed: 5 } }),
    { awaitingReply: false, adopted: true, activeChat: false, ignored: false, longSilence: false });
  assert.deepEqual(signalsFrom({ gap: { known: false }, recentCount: 0, feedback: {} }),
    { awaitingReply: false, adopted: false, activeChat: false, ignored: false, longSilence: false });
  assert.equal(recentMessageCount([{ id: 1, ts: '2026-11-14 10:00' }, { id: 2, ts: '2026-10-01 10:00' }], '2026-11-15', 7), 1);
  assert.equal(recentMessageCount([], '2026-11-15', 7), 0);
});

test('an unanswered message tightens a weekly goal to a shorter cycle', async context => {
  const state = fixture(context, {
    messages: { 小夏: [{ id: 11, sender: '小夏', ts: '2026-11-14 20:00', content: '你周末有空吗', isOwner: false }] }
  });
  goalOf(state, '小夏', '保持老朋友的日常问候');
  const xiaOf = () => state.service.list().contacts.find(item => item.contactName === '小夏');
  state.service.generate();
  await state.service.whenIdle();
  assert.equal(xiaOf().status, 'ready');
  assert.equal(xiaOf().intervalBaseDays, 6);
  assert.equal(xiaOf().intervalDays, 3);
  assert.ok(xiaOf().intervalReasons.includes('对方最后一句还没回'));
  state.setClock(new Date(2026, 10, 18, 12));
  state.service.generate();
  await state.service.whenIdle();
  assert.equal(xiaOf().status, 'ready');
});

test('parsing accepts a resting payload and rejects one that carries actions', () => {
  const payloadContext = { evidenceSources: [{ id: 'message:1', type: 'message', text: '想去看展' }] };
  const resting = parseDailyActions(JSON.stringify({ actions: [], emptyReason: '今天不必行动。', resting: true }), payloadContext);
  assert.equal(resting.ok, true);
  assert.deepEqual(resting.actions, []);
  assert.equal(resting.emptyReason, '今天不必行动。');
  assert.equal(resting.resting, true);
  const plain = parseDailyActions(JSON.stringify({ actions: [], emptyReason: '资料不足。' }), payloadContext);
  assert.equal(plain.ok, true);
  assert.deepEqual(plain.actions, []);
  assert.equal(plain.resting, undefined);
  // 模型说「今天别打扰」也算休息，即使没写 resting
  const veto = parseDailyActions(JSON.stringify({ shouldGenerate: false, actions: [], cadenceReason: '对方刚说在忙' }), payloadContext);
  assert.equal(veto.ok, true);
  assert.equal(veto.shouldGenerate, false);
  assert.equal(veto.emptyReason, '对方刚说在忙', '休息的理由可以只写在 cadenceReason');
  const conflict = parseDailyActions(JSON.stringify({ actions: [{ kind: 'topic', title: 't', summary: 's', reason: 'r', evidenceIds: ['message:1'] }], emptyReason: '', resting: true }), payloadContext);
  assert.equal(conflict.ok, false);
});

test('「尽快约出来」这类社交目的必须判成推进，不能落到默认的「了解」', () => {
  for (const goal of ['想尽快约她出来', '这周约一次见面', '主动联系一下', '约个饭聊聊', '找机会单独见面']) {
    const iv = intervalForGoal(goal);
    assert.equal(iv.id, 'pursue', `${goal} 应该判成推进，实际 ${iv.id}`);
    assert.equal(iv.matched, 'pursue');
  }
  // 维持类不能被推进规则误伤
  assert.equal(intervalForGoal('维持老朋友的关系').id, 'maintain');
  assert.equal(intervalForGoal('先暂停一段时间').id, 'pause');
});

test('社交目的没被任何关键词命中时 matched 为 null（公式只当兜底基准）', () => {
  const iv = intervalForGoal('随便看看吧');
  assert.equal(iv.id, 'build');
  assert.equal(iv.matched, null, '兜底档必须能和「按目的算出来的」区分开');
});

test('推进档 + 聊得勤：基准 1 天 ×1.5 四舍五入成 2 天', () => {
  const base = intervalForGoal('想尽快约她出来');
  const result = adjustInterval(base, signalsFrom({ gap: { known: true, daysSinceLastMessage: 1 }, recentCount: 80, feedback: { done: 0, dismissed: 0 } }));
  assert.equal(result.days, 2);
  assert.equal(result.baseDays, 1);
  assert.deepEqual(result.reasons, ['最近聊得很勤']);
});

// ── 节奏决策：证据包 + 护栏 ──────────────────────────────────────────────

test('证据包只装客观来源，权重齐备', () => {
  const evidence = buildCadenceEvidence({
    goal: '想尽快约她出来',
    gap: { known: true, daysSinceLastMessage: 3, lastSpeaker: '我', ownerSpokeLast: true },
    messageStats: { messages7d: 42, messages30d: 180, ownerShare: 0.6 },
    feedback: { done: 1, dismissed: 0 },
    schedules: [{ title: '看展', at: '2026-11-26T10:00:00Z', inDays: 1 }],
    previous: { days: 2, decidedAt: '2026-11-24T00:00:00Z', reason: '刚聊完' }
  });
  assert.deepEqual(Object.keys(evidence.weights).sort(), ['cadence', 'feedback', 'goal', 'schedule']);
  assert.equal(evidence.weights.goal, WEIGHTS.goal);
  assert.equal(evidence.sources.goal.text, '想尽快约她出来');
  assert.equal(evidence.sources.cadence.messages7d, 42);
  assert.equal(evidence.sources.schedule.upcoming[0].inDays, 1);
  assert.equal(evidence.previous.intervalDays, 2);
  // 描述性判断（推断出的关系状态、画像结论）不应出现在证据包里
  const text = JSON.stringify(evidence);
  assert.ok(!/relationshipStage|relationshipAnalysis|画像结论/.test(text), '节奏决策不能吃模型自己推断的描述');
});

test('证据包对缺失字段给 null，不让模型去猜', () => {
  const evidence = buildCadenceEvidence({ goal: '', gap: { known: false } });
  assert.equal(evidence.sources.cadence.daysSinceLastMessage, null);
  assert.equal(evidence.sources.cadence.ownerShare, null);
  assert.equal(evidence.previous, null);
});

test('间隔护栏：1–30 天，且单次变动不超过 2 倍', () => {
  // 上下界
  assert.equal(clampIntervalDays(99, null).days, 30);
  assert.equal(clampIntervalDays(0, null).days, 1);
  assert.equal(clampIntervalDays(3, null).days, 3);
  // ±2 倍：上一版 2 天，最多到 4 天、最少 1 天
  assert.equal(clampIntervalDays(10, 2).days, 4);
  assert.equal(clampIntervalDays(1, 2).days, 1);
  assert.equal(clampIntervalDays(3, 2).days, 3);
  // 上一版 6 天：3–12 天
  assert.equal(clampIntervalDays(30, 6).days, 12);
  assert.equal(clampIntervalDays(1, 6).days, 3);
  // 没给天数沿用上一版
  const fallback = clampIntervalDays(null, 5);
  assert.equal(fallback.days, 5);
  assert.equal(fallback.clamped, true);
  // 被夹住时要留下说明，能写进决策日志
  assert.match(clampIntervalDays(10, 2).note, /2 倍/);
});

test('边界：一直判最小值不会被夹住来回弹', () => {
  let days = 2;
  for (let i = 0; i < 5; i += 1) days = clampIntervalDays(1, days).days;
  assert.equal(days, 1);
});
