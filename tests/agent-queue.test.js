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
