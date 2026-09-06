'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaotihu-agent-queue-'));
process.env.XIAOTIHU_DATA_DIR = tmp;

const queue = require('../core/agent/queue');
const { buildReplyPrompt } = require('../core/agent/dsh-reply');
const { buildQueueTaskPrompt } = require('../core/agent/queue-runner');
const { recurrenceForIntent } = require('../core/engine/intent-actions');
const { confirmIntent } = require('../core/engine/intent-actions');
const { isDataQuery, classifyDataQuery } = require('../core/engine/chat-intent');
const { readIntents, saveIntents } = require('../core/memory/stores/intents');
const taskStore = require('../core/memory/stores/tasks');
const { buildRelationDetail } = require('../core/memory/relations');

test('队列：入队/列出/认领/完成', () => {
  const item = queue.enqueueTask({
    type: 'task',
    summary: '扫描 contacts 并生成报告',
    detail: '需要读取本地文件',
    source: { contact: '张三' }
  });
  assert.ok(item);
  assert.strictEqual(item.status, 'pending');

  const list = queue.listQueue();
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].summary, '扫描 contacts 并生成报告');

  const claimed = queue.claimNext();
  assert.ok(claimed);
  assert.strictEqual(claimed.id, item.id);
  assert.strictEqual(claimed.status, 'running');
  assert.strictEqual(queue.listPending().length, 0);

  queue.completeTask(item.id, { output: '完成 ✅', taskId: 'agent_123' });
  const done = queue.getQueueItem(item.id);
  assert.strictEqual(done.status, 'completed');
  assert.strictEqual(done.output, '完成 ✅');
  assert.strictEqual(done.taskId, 'agent_123');
});

test('队列：失败与 stale 重置', () => {
  const item = queue.enqueueTask({ summary: '会失败的任务' });
  queue.claimNext();
  queue.failTask(item.id, new Error('执行失败'), 'agent_456');
  const failed = queue.getQueueItem(item.id);
  assert.strictEqual(failed.status, 'failed');
  assert.match(failed.error, /执行失败/);

  // running 且 startedAt 超过阈值 -> 重置回 pending
  const stale = queue.enqueueTask({ summary: 'stale task' });
  queue.claimNext();
  const staleItem = queue.getQueueItem(stale.id);
  staleItem.startedAt = new Date(Date.now() - 11 * 60 * 1000).toISOString();
  const pending = queue.resetStale(10 * 60 * 1000);
  assert.ok(pending.some((x) => x.id === stale.id));
});

test('回复/队列任务提示词包含关键信息', () => {
  const replyPrompt = buildReplyPrompt({
    message: '帮我看看本地文件',
    history: [{ role: 'user', text: '你好' }],
    channel: 'weixin',
    contact: '张三'
  });
  assert.ok(replyPrompt.includes('帮我看看本地文件'));
  assert.ok(replyPrompt.includes('weixin'));
  assert.ok(replyPrompt.includes('张三'));
  assert.ok(replyPrompt.includes('你好'));

  const taskPrompt = buildQueueTaskPrompt({
    type: 'task',
    summary: '生成报告',
    detail: '统计消息数',
    source: { contact: '李四' }
  });
  assert.ok(taskPrompt.includes('生成报告'));
  assert.ok(taskPrompt.includes('统计消息数'));
  assert.ok(taskPrompt.includes('李四'));

  const detail = buildRelationDetail({
    days: 8,
    profile: { 关系类型: '重要客户' },
    messages: [{ ts: '2026-01-01 10:00', name: '张三', content: '下次一起吃饭' }]
  });
  assert.ok(detail.includes('8 天'));
  assert.ok(detail.includes('重要客户'));
  assert.ok(detail.includes('下次一起吃饭'));
});

test('周期提醒：从结构化输入识别工作日 cron', () => {
  const recurrence = recurrenceForIntent({
    type: 'reminder',
    summary: '工作日每天下午4点提醒打卡签退',
    action: { inputs: { repeat: '工作日', reminder_time: '16:00' } }
  });
  assert.deepStrictEqual(recurrence, { cron: '0 16 * * 1-5', label: '工作日' });
});

test('周期提醒：优先使用模型返回的合法 cron', () => {
  const recurrence = recurrenceForIntent({
    type: 'reminder',
    summary: '工作日提醒',
    recurrence: { cron: '15 17 * * 1-5', label: '工作日17:15' }
  });
  assert.deepStrictEqual(recurrence, { cron: '15 17 * * 1-5', label: '工作日17:15' });
});

test('确认周期提醒：直接创建 cron，不派发 DSH 队列', () => {
  const id = 'intent_test_periodic_' + Date.now();
  const before = readIntents();
  saveIntents([...before, {
    id,
    type: 'reminder',
    summary: '工作日 16:00 打卡提醒',
    detail: '提醒我打卡签退',
    action: { inputs: { repeat: '工作日', reminder_time: '16:00' } },
    dueAt: null,
    dueText: '',
    source: { contact: '测试' },
    status: 'pending_confirm'
  }]);

  const result = confirmIntent(id);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.target.kind, 'cron');
  assert.strictEqual(result.target.cron, '0 16 * * 1-5');
  assert.strictEqual(result.target.action, null);
  assert.strictEqual(result.queued, null);
  assert.strictEqual(taskStore.getTask(result.target.id).status, 'open');
});

test('确认 AI 待办只入正式列表，手动开始后才进入 DSH 队列', () => {
  const id = 'intent_test_ai_todo_' + Date.now();
  const before = queue.listQueue().length;
  saveIntents([...readIntents(), {
    id,
    type: 'todo',
    summary: '整理实验数据',
    detail: '整理本地实验数据并输出汇总',
    action: { capability: 'data_organize', instruction: '整理实验数据', inputs: {} },
    execution: { mode: 'dsh', capability: 'data_organize', instruction: '整理实验数据', inputs: {} },
    status: 'pending_confirm',
    source: { contact: '测试' }
  }]);

  const confirmed = confirmIntent(id);
  assert.strictEqual(confirmed.ok, true);
  assert.strictEqual(confirmed.queued, null);
  assert.strictEqual(confirmed.target.type, 'todo');
  assert.strictEqual(confirmed.target.executionStatus, 'not_started');
  assert.strictEqual(queue.listQueue().length, before);

  const started = taskStore.startTask(confirmed.target.id);
  assert.strictEqual(started.ok, true);
  assert.strictEqual(started.task.executionStatus, 'queued');
  assert.strictEqual(queue.listQueue().length, before + 1);
});

test('旧版无动作 cron 条目归一为系统提醒', () => {
  const reminder = taskStore.normalizeTask({
    id: 'legacy_cron_reminder',
    category: 'ai_task',
    kind: 'cron',
    cron: '0 16 * * 1-5',
    action: null
  });
  assert.strictEqual(reminder.type, 'reminder');
  assert.strictEqual(reminder.kind, 'cron');
  assert.strictEqual(reminder.executionMode, 'system');
});

test('待办查询走数据查询路由，不识别为创建指令', () => {
  assert.strictEqual(isDataQuery('现在有啥待办事项'), true);
  assert.strictEqual(classifyDataQuery('现在有啥待办事项'), 'todo');
  assert.strictEqual(isDataQuery('我有哪些提醒'), true);
  assert.strictEqual(classifyDataQuery('我有哪些提醒'), 'reminder');
  assert.strictEqual(isDataQuery('今天有什么日程'), true);
  assert.strictEqual(classifyDataQuery('今天有什么日程'), 'schedule');
  assert.strictEqual(isDataQuery('今天有什么提醒和日程'), true);
  assert.strictEqual(classifyDataQuery('今天有什么提醒和日程'), 'reminder_schedule');
  assert.strictEqual(isDataQuery('帮我创建一个待办'), false);
  assert.strictEqual(isDataQuery('工作日16点提醒我打卡'), false);
});
