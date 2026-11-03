// 意图识别的触发调度与高置信度自动落库
// 回归点：
//  - 连续复制多条消息只跑一轮扫描（静默合并），不会一条一次；
//  - 两轮之间遵守 intent.minIntervalMinutes 冷却，冷却期内的触发排队到点再跑，不丢；
//  - 扫描进行中来的触发，结束后补一轮，而不是并发再扫；
//  - 高置信度（intent.highConfidence）真的会建成正式任务；需要 Agent 执行的仍进待确认。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaotihu-intent-scheduler-'));
process.env.XIAOTIHU_DATA_DIR = tmp;

const chatDb = require('../core/memory/chat-db');
const { readIntents } = require('../core/memory/stores/intents');
const tasksStore = require('../core/memory/stores/tasks');
const {
  requestIntentExtraction,
  flushIntentExtraction,
  resetIntentScheduler,
  intentSchedulerState,
  schedulerTiming
} = require('../core/engine/intent-runner');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const daysFromNow = (n) => new Date(Date.now() + n * 86400000).toISOString();

function config(extra = {}) {
  return {
    selfNicknames: ['六壹'],
    notify: { mode: 'off' },
    intent: {
      provider: 'deepseek',
      model: 'mock',
      mediumConfidence: 0.5,
      highConfidence: 0.85,
      staleDeadlineDays: 2,
      debounceMs: 40,
      minIntervalMinutes: 0,
      ...extra
    },
    engine: { providers: { deepseek: { baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'test-key', model: 'mock' } } }
  };
}

const silent = async () => ({ ok: true, text: 'NO_TASK', array: null });

test('默认参数：静默 2.5 秒、冷却 1 分钟，且能被配置覆盖', () => {
  assert.deepStrictEqual(schedulerTiming({ intent: {} }), { debounceMs: 2500, cooldownMinutes: 1, minIntervalMs: 60000 });
  assert.deepStrictEqual(schedulerTiming({ intent: { debounceMs: 0, minIntervalMinutes: 5 } }), { debounceMs: 0, cooldownMinutes: 5, minIntervalMs: 300000 });
});

test('连续触发（复制多条消息）只合并成一轮扫描', async () => {
  resetIntentScheduler();
  chatDb.ingestMessages('合并联系人', [
    { name: '合并联系人', ts: '2026-09-22 09:00', type: 'text', content: '第一条' },
    { name: '合并联系人', ts: '2026-09-22 09:01', type: 'text', content: '第二条' },
    { name: '合并联系人', ts: '2026-09-22 09:02', type: 'text', content: '第三条' }
  ]);
  let calls = 0;
  const runTask = async () => { calls += 1; return silent(); };
  const cfg = config({ debounceMs: 60, minIntervalMinutes: 0 });
  for (let i = 0; i < 5; i++) {
    requestIntentExtraction({ config: cfg, runTask });
    await sleep(10);
  }
  assert.equal(calls, 0, '静默期内不应开始扫描');
  assert.equal(intentSchedulerState().pending, true);
  await sleep(220);
  assert.equal(calls, 1, '连续 5 次触发只应扫描一轮');
  assert.equal(intentSchedulerState().pending, false);
  chatDb.deleteMember('合并联系人');
});

test('冷却期内的触发排队到点再跑，不会丢掉', async () => {
  resetIntentScheduler();
  chatDb.ingestMessages('冷却联系人', [{ name: '冷却联系人', ts: '2026-09-22 09:00', type: 'text', content: '冷却测试' }]);
  let calls = 0;
  const runTask = async () => { calls += 1; return silent(); };
  await flushIntentExtraction({ config: config({ debounceMs: 0, minIntervalMinutes: 0 }), runTask });
  assert.equal(calls, 1);
  const finishedAt = intentSchedulerState().lastRunFinishedAt;
  assert.ok(finishedAt > 0, '扫描结束后应记录时间，冷却由它起算');

  // 冷却 0.005 分钟 = 300 毫秒；这期间又复制了一条新消息
  chatDb.ingestMessages('冷却联系人', [{ name: '冷却联系人', ts: '2026-09-22 09:30', type: 'text', content: '冷却期间的又一条' }]);
  const cooling = config({ debounceMs: 0, minIntervalMinutes: 0.005 });
  const scheduled = requestIntentExtraction({ config: cooling, runTask });
  assert.ok(scheduled.delayMs >= 200, '冷却期内的触发应排队，实际延迟：' + scheduled.delayMs);
  await sleep(120);
  assert.equal(calls, 1, '冷却未到不应扫描');
  await sleep(320);
  assert.equal(calls, 2, '冷却到点应补跑一轮');
  chatDb.deleteMember('冷却联系人');
});

test('扫描进行中来的触发会在结束后补一轮，而不是并发扫描', async () => {
  resetIntentScheduler();
  chatDb.ingestMessages('忙联系人', [{ name: '忙联系人', ts: '2026-09-22 09:00', type: 'text', content: '扫描中再来一条' }]);
  let calls = 0;
  let concurrent = 0;
  let maxConcurrent = 0;
  const runTask = async () => {
    calls += 1;
    concurrent += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    // 第一轮扫描期间又有新消息入库（用户又复制了一条）
    if (calls === 1) chatDb.ingestMessages('忙联系人', [{ name: '忙联系人', ts: '2026-09-22 09:10', type: 'text', content: '扫描期间复制的消息' }]);
    await sleep(60);
    concurrent -= 1;
    return silent();
  };
  const cfg = config({ debounceMs: 20, minIntervalMinutes: 0 });
  requestIntentExtraction({ config: cfg, runTask });
  await sleep(40); // 第一轮已在跑
  assert.equal(intentSchedulerState().running, true);
  requestIntentExtraction({ config: cfg, runTask });
  await sleep(300);
  assert.equal(maxConcurrent, 1, '不允许两轮扫描并发');
  assert.equal(calls, 2, '扫描期间的触发应在结束后补一轮');
  chatDb.deleteMember('忙联系人');
});

test('高置信度意图直接建成正式任务；低置信度与需要 Agent 执行的仍进待确认', async () => {
  resetIntentScheduler();
  chatDb.ingestMessages('高置信联系人', [{ name: '高置信联系人', ts: '2026-09-22 09:00', type: 'text', content: '这周五把报告给我' }]);
  const runTask = async () => ({
    ok: true,
    text: '[…]',
    array: [
      { type: 'todo', summary: '交周五报告', detail: '这周五把报告给我', deadline: daysFromNow(2), confidence: 0.93 },
      { type: 'todo', summary: '随口一提的小事', detail: '这周五把报告给我', deadline: daysFromNow(2), confidence: 0.6 },
      {
        type: 'todo',
        summary: '帮我发周报邮件',
        detail: '这周五把报告给我',
        confidence: 0.95,
        action: { capability: 'email', instruction: '发送周报' }
      }
    ]
  });

  const result = await flushIntentExtraction({ config: config({ debounceMs: 0, minIntervalMinutes: 0 }), runTask });
  assert.equal(result.autoCreated, 1, '只有高置信度那条自动创建');

  const intents = readIntents();
  const auto = intents.find((item) => item.summary === '交周五报告');
  assert.equal(auto.status, 'auto_created');
  assert.ok(auto.targetId, '应记录生成的正式事项 id');
  assert.ok(tasksStore.getTask(auto.targetId), '任务应真的写进任务库');

  assert.equal(intents.find((item) => item.summary === '随口一提的小事').status, 'pending_confirm');
  assert.equal(intents.find((item) => item.summary === '帮我发周报邮件').status, 'pending_confirm', '需要 Agent 执行的动作必须留待确认');

  // 同一批再扫一次不会重复建任务（游标和去重都要起作用）
  const before = tasksStore.listTasks().length;
  const again = await flushIntentExtraction({ config: config({ debounceMs: 0, minIntervalMinutes: 0 }), runTask });
  assert.equal(again.autoCreated, 0);
  assert.equal(tasksStore.listTasks().length, before);
  chatDb.deleteMember('高置信联系人');
});

test('阈值可调：调高后同一批内容只进待确认', async () => {
  resetIntentScheduler();
  chatDb.ingestMessages('阈值联系人', [{ name: '阈值联系人', ts: '2026-09-22 10:00', type: 'text', content: '下周一交材料' }]);
  const runTask = async () => ({
    ok: true,
    text: '[…]',
    array: [{ type: 'todo', summary: '交材料', detail: '下周一交材料', deadline: daysFromNow(5), confidence: 0.9 }]
  });
  const result = await flushIntentExtraction({ config: config({ debounceMs: 0, minIntervalMinutes: 0, highConfidence: 0.95 }), runTask });
  assert.equal(result.autoCreated, 0);
  assert.equal(readIntents().find((item) => item.summary === '交材料').status, 'pending_confirm');
  chatDb.deleteMember('阈值联系人');
});
