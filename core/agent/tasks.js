// 小鹈鹕 Agent 任务管理 — 内存版任务队列与事件记录
'use strict';

const crypto = require('crypto');
const { runDshTask } = require('./dsh-client');
const { appendEvent, lastSeq } = require('./event-utils');

const tasks = new Map();

function createTask(taskText, opts = {}) {
  const id = 'agent_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex');
  const task = {
    id,
    task: String(taskText || '').trim(),
    cwd: opts.cwd || null,
    status: 'queued',
    events: [],
    output: '',
    error: '',
    stderr: '',
    config: opts.config || null,
    _onFinish: opts.onFinish || null,
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null
  };
  tasks.set(id, task);

  if (!task.task) {
    task.status = 'failed';
    task.error = '任务文本不能为空';
    task.finishedAt = new Date().toISOString();
    return task;
  }

  const runner = opts.runner || runDshTask;

  // 异步执行，不阻塞 API
  runAgentTask(task, runner).catch(() => {});

  return task;
}

async function runAgentTask(task, runner = runDshTask) {
  task.status = 'running';
  task.startedAt = new Date().toISOString();

  const outputChunks = [];
  try {
    const result = await runner({
      task: task.task,
      cwd: task.cwd || undefined,
      config: task.config || undefined,
      onEvent: (ev) => {
        appendEvent(task.events, { ...ev, receivedAt: new Date().toISOString() });
      },
      onOutput: (line) => outputChunks.push(line)
    });
    task.output = result.text || outputChunks.join('\n').trim();
    task.stderr = result.stderr || '';
    task.status = 'completed';
  } catch (e) {
    const msg = String((e && e.message) || e);
    task.error = (e && e.stderr && !msg.includes(e.stderr)) ? msg + '\n' + e.stderr : msg;
    task.status = 'failed';
  } finally {
    task.finishedAt = new Date().toISOString();
    if (typeof task._onFinish === 'function') {
      try { task._onFinish(task); } catch {}
    }
  }
}

function getTask(id, afterSeq = null) {
  const t = tasks.get(id);
  if (!t) return null;
  const events = (t.events || []).filter((ev) => {
    if (!afterSeq) return true;
    return typeof ev.seq === 'number' ? ev.seq > afterSeq : false;
  });
  return { ...t, events, lastSeq: lastSeq(t.events || []) };
}

function waitForTask(id, timeoutMs = 300000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      const t = getTask(id);
      if (!t) {
        clearInterval(timer);
        return reject(new Error('任务不存在：' + id));
      }
      if (t.status === 'completed' || t.status === 'failed') {
        clearInterval(timer);
        return resolve(t);
      }
      if (Date.now() - start > timeoutMs) {
        clearInterval(timer);
        return reject(new Error('等待 Agent 任务超时：' + id));
      }
    }, 150);
  });
}

async function runTaskAndWait(taskText, opts = {}) {
  const t = createTask(taskText, opts);
  if (t.status === 'failed') return t;
  return waitForTask(t.id, opts.waitTimeoutMs || 300000);
}

function listTasks(limit = 50) {
  return [...tasks.values()]
    .sort((a, b) => (String(b.createdAt) < String(a.createdAt) ? -1 : 1))
    .slice(0, limit)
    .map((t) => ({
      id: t.id,
      task: t.task,
      status: t.status,
      events: t.events.length,
      output: t.output,
      error: t.error,
      createdAt: t.createdAt,
      startedAt: t.startedAt,
      finishedAt: t.finishedAt
    }));
}

module.exports = { createTask, getTask, listTasks, waitForTask, runTaskAndWait };
