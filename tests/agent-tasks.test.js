'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { createTask, getTask, listTasks } = require('../core/agent/tasks');
const { parseEventLine } = require('../core/agent/dsh-client');

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

test('parseEventLine 解析 DSH 事件流 JSONL', () => {
  const line = '@@DSH_EVENT@@ {"type":"tool/call","seq":3,"data":{"tool":"read_file"}}';
  const ev = parseEventLine(line);
  assert.ok(ev);
  assert.strictEqual(ev.type, 'tool/call');
  assert.strictEqual(ev.data.tool, 'read_file');

  assert.strictEqual(parseEventLine('普通输出行'), null);
  assert.strictEqual(parseEventLine('@@DSH_EVENT@@ 不是JSON'), null);
});

test('createTask 空任务直接失败', () => {
  const t = createTask('   ', { runner: async () => ({ ok: true, text: '' }) });
  assert.strictEqual(t.status, 'failed');
  assert.match(t.error, /不能为空/);
});

test('Agent 任务：runner 事件进入 task.events 且最终输出保存', async () => {
  const fakeRunner = async ({ task, onEvent, onOutput }) => {
    onEvent({ type: 'turn/start', data: {} });
    onEvent({ type: 'tool/call', data: { tool: 'read_file', args: { path: 'a.txt' } } });
    onOutput('中间日志');
    return { ok: true, text: '完成 ✅', events: [] };
  };

  const t = createTask('测试任务', { runner: fakeRunner });
  assert.strictEqual(t.status, 'running');

  // 等待异步 runner 完成
  for (let i = 0; i < 50; i++) {
    if (t.status === 'completed' || t.status === 'failed') break;
    await delay(10);
  }

  assert.strictEqual(t.status, 'completed');
  assert.strictEqual(t.output, '完成 ✅');
  assert.strictEqual(t.events.length, 2);
  assert.strictEqual(t.events[1].data.tool, 'read_file');
  assert.ok(t.finishedAt);

  const fetched = getTask(t.id);
  assert.ok(fetched);
  assert.strictEqual(fetched.status, 'completed');

  const after = getTask(t.id, 1);
  assert.strictEqual(after.events.length, 1);
  assert.strictEqual(after.events[0].seq, 2);
  assert.strictEqual(after.lastSeq, 2);

  const list = listTasks();
  assert.ok(list.some((x) => x.id === t.id));
});

test('Agent 任务：runner 抛错进入 failed', async () => {
  const failingRunner = async () => {
    const err = new Error('DSH 启动失败');
    err.stderr = 'stderr detail';
    throw err;
  };

  const t = createTask('会失败的任务', { runner: failingRunner });
  for (let i = 0; i < 50; i++) {
    if (t.status === 'completed' || t.status === 'failed') break;
    await delay(10);
  }

  assert.strictEqual(t.status, 'failed');
  assert.match(t.error, /DSH 启动失败/);
  assert.match(t.error, /stderr detail/);
});
