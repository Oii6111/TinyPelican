// 小鹈鹕 Agent — 小模型产出任务队列
// 心跳意图识别/潜意识等小模型模块只负责把“具体任务”写入这里；
// DSH 大模型 Worker 从队列拉取任务并执行，结果写回队列。
'use strict';

const fs = require('fs');
const crypto = require('crypto');
const { getPaths } = require('../lib/paths');

let cache = null;

function loadQueue() {
  if (cache) return cache;
  const fp = getPaths().agentQueue;
  const items = [];
  if (fs.existsSync(fp)) {
    for (const line of fs.readFileSync(fp, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      try { items.push(JSON.parse(line)); } catch {}
    }
  }
  cache = items;
  return items;
}

function saveQueue() {
  const fp = getPaths().agentQueue;
  fs.mkdirSync(require('path').dirname(fp), { recursive: true });
  const lines = (cache || []).map((x) => JSON.stringify(x));
  fs.writeFileSync(fp, lines.join('\n') + (lines.length ? '\n' : ''), 'utf8');
}

function enqueueTask({ type = 'task', summary, detail = '', payload = {}, source = {} }) {
  const items = loadQueue();
  const item = {
    id: 'q_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex'),
    type: String(type || 'task'),
    summary: String(summary || '').trim(),
    detail: String(detail || ''),
    payload,
    source,
    status: 'pending',
    taskId: '',
    output: '',
    error: '',
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null
  };
  if (!item.summary) return null;
  items.push(item);
  saveQueue();
  return { ...item };
}

function listQueue(opts = {}) {
  const items = loadQueue().slice().sort((a, b) => (String(a.createdAt) < String(b.createdAt) ? -1 : 1));
  if (opts.status) return items.filter((x) => x.status === opts.status);
  return items;
}

function listPending() {
  return listQueue({ status: 'pending' });
}

function getQueueItem(id) {
  return loadQueue().find((x) => x.id === id) || null;
}

function claimNext() {
  const items = loadQueue();
  const item = items.find((x) => x.status === 'pending');
  if (!item) return null;
  item.status = 'running';
  item.startedAt = new Date().toISOString();
  saveQueue();
  return { ...item };
}

function updateTask(id, patch) {
  const items = loadQueue();
  const item = items.find((x) => x.id === id);
  if (!item) return null;
  Object.assign(item, patch);
  saveQueue();
  return { ...item };
}

function completeTask(id, result = {}) {
  return updateTask(id, {
    status: 'completed',
    output: String(result.output || result.text || '').trim(),
    taskId: result.taskId || '',
    error: '',
    finishedAt: new Date().toISOString()
  });
}

function failTask(id, error, taskId = '') {
  return updateTask(id, {
    status: 'failed',
    error: String((error && error.message) || error || '未知错误'),
    taskId,
    finishedAt: new Date().toISOString()
  });
}

// 启动时把上次异常中断的 running 任务重置回 pending
function resetStale(maxRunningMs = 10 * 60 * 1000) {
  const items = loadQueue();
  let changed = false;
  const now = Date.now();
  for (const item of items) {
    if (item.status === 'running' && item.startedAt) {
      const t = new Date(item.startedAt).getTime();
      if (isNaN(t) || now - t > maxRunningMs) {
        item.status = 'pending';
        item.startedAt = null;
        changed = true;
      }
    }
  }
  if (changed) saveQueue();
  return loadQueue().filter((x) => x.status === 'pending');
}

module.exports = {
  enqueueTask,
  listQueue,
  listPending,
  getQueueItem,
  claimNext,
  completeTask,
  failTask,
  resetStale
};
