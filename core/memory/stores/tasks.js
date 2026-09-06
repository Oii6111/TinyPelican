// 小鹈鹕核心 — 正式任务存储（与意图建议分离）
// 任务分为：
//   once     一次性任务：dueAt 到期提醒/执行
//   cron     周期性定时任务：cron 表达式 + nextAt 下次触发时间
'use strict';

const crypto = require('crypto');
const { getPaths } = require('../../lib/paths');
const { readJson, writeJson } = require('../../lib/store');
const { nextCronAfter } = require('../../lib/cron');

const P = getPaths();

function nowIso() {
  return new Date().toISOString();
}

function normalizeTask(t) {
  const task = t && typeof t === 'object' ? t : {};
  const legacyTodoType = ['task', 'deadline', 'waiting_reply'].includes(task.type);
  const type = task.type === 'reminder' || task.category === 'reminder' ||
    (task.kind === 'cron' && !task.action && !legacyTodoType)
    ? 'reminder'
    : 'todo';
  const action = type === 'todo' && task.action && typeof task.action === 'object' ? task.action : null;
  const kind = type === 'reminder' && task.kind === 'cron' ? 'cron' : 'once';
  return {
    id: task.id || 'task_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex'),
    title: String(task.title || '').trim(),
    detail: String(task.detail || ''),
    type,
    category: type,
    action,
    executionMode: type === 'reminder' ? 'system' : (task.executionMode || (action ? 'dsh' : 'manual')),
    kind,
    dueAt: task.dueAt || null,
    scheduledStartAt: task.scheduledStartAt || null,
    scheduledEndAt: task.scheduledEndAt || null,
    cron: kind === 'cron' ? String(task.cron || '').trim() : '',
    nextAt: task.nextAt || null,
    status: task.status || 'open',
    sourceIntentId: task.sourceIntentId || '',
    source: task.source || null,
    lastNotifiedAt: task.lastNotifiedAt || null,
    lastQueuedAt: task.lastQueuedAt || null,
    executionStatus: task.executionStatus || 'not_started',
    executionOutput: String(task.executionOutput || ''),
    executionError: String(task.executionError || ''),
    lastCompletedAt: task.lastCompletedAt || null,
    createdAt: task.createdAt || nowIso(),
    updatedAt: task.updatedAt || nowIso()
  };
}

function readTasks() {
  const data = readJson(P.tasks, []);
  return Array.isArray(data) ? data.map(normalizeTask) : [];
}

function saveTasks(items) {
  writeJson(P.tasks, items);
}

function computeNextAt(kind, cron, after = new Date()) {
  if (kind !== 'cron' || !cron) return null;
  try {
    const next = nextCronAfter(cron, after);
    return next ? next.toISOString() : null;
  } catch {
    return null;
  }
}

function createTask(input = {}) {
  const items = readTasks();
  const t = normalizeTask({
    id: input.id || undefined,
    title: input.title,
    detail: input.detail || '',
    type: input.type || 'todo',
    category: input.type || 'todo',
    action: input.action || null,
    executionMode: input.executionMode || (input.action ? 'dsh' : (input.type === 'reminder' ? 'system' : 'manual')),
    kind: input.kind || 'once',
    dueAt: input.dueAt || null,
    scheduledStartAt: input.scheduledStartAt || null,
    scheduledEndAt: input.scheduledEndAt || null,
    cron: input.cron || '',
    status: input.status || 'open',
    sourceIntentId: input.sourceIntentId || '',
    source: input.source || null
  });
  if (!t.title) return null;
  if (t.kind === 'cron') {
    t.nextAt = computeNextAt('cron', t.cron);
    t.dueAt = null;
    if (!t.nextAt) return null;
  }
  items.push(t);
  saveTasks(items);
  return { ...t };
}

function getTask(id) {
  return readTasks().find((x) => x.id === id) || null;
}

function listTasks(opts = {}) {
  const items = readTasks();
  if (opts.status) return items.filter((x) => x.status === opts.status);
  return items;
}

function updateTask(id, patch = {}) {
  const items = readTasks();
  const task = items.find((x) => x.id === id);
  if (!task) return null;
  if (patch.title !== undefined) task.title = String(patch.title).trim();
  if (patch.detail !== undefined) task.detail = String(patch.detail);
  const typeChanged = patch.type !== undefined;
  if (typeChanged) task.type = patch.type === 'reminder' ? 'reminder' : 'todo';
  if (patch.action !== undefined) {
    task.action = patch.action && typeof patch.action === 'object' ? patch.action : null;
    task.lastQueuedAt = null;
    task.executionStatus = 'not_started';
    task.executionOutput = '';
    task.executionError = '';
  }
  if (patch.executionMode !== undefined) task.executionMode = ['manual', 'system', 'dsh'].includes(patch.executionMode) ? patch.executionMode : 'manual';
  if (patch.kind !== undefined) task.kind = patch.kind === 'cron' ? 'cron' : 'once';
  if (patch.dueAt !== undefined) {
    task.dueAt = patch.dueAt || null;
    task.lastQueuedAt = null;
    if (task.action) task.executionStatus = 'not_started';
  }
  if (patch.scheduledStartAt !== undefined) task.scheduledStartAt = patch.scheduledStartAt || null;
  if (patch.scheduledEndAt !== undefined) task.scheduledEndAt = patch.scheduledEndAt || null;
  if (patch.cron !== undefined) task.cron = String(patch.cron).trim();
  if (patch.status !== undefined) task.status = patch.status;
  if (patch.sourceIntentId !== undefined) task.sourceIntentId = patch.sourceIntentId;
  if (patch.lastQueuedAt !== undefined) task.lastQueuedAt = patch.lastQueuedAt || null;
  if (patch.executionStatus !== undefined) task.executionStatus = String(patch.executionStatus);
  if (patch.executionOutput !== undefined) task.executionOutput = String(patch.executionOutput || '');
  if (patch.executionError !== undefined) task.executionError = String(patch.executionError || '');
  if (task.kind === 'cron') {
    task.type = 'reminder';
    task.action = null;
    task.executionMode = 'system';
    task.dueAt = null;
    task.nextAt = computeNextAt('cron', task.cron, new Date());
    if (!task.nextAt) return null;
  } else {
    if (task.type === 'reminder') {
      task.action = null;
      task.executionMode = 'system';
    } else if (typeChanged && patch.executionMode === undefined && patch.action === undefined) {
      task.executionMode = task.action ? 'dsh' : 'manual';
    }
    task.cron = '';
    task.nextAt = null;
  }
  task.category = task.type;
  task.updatedAt = nowIso();
  saveTasks(items);
  return { ...task };
}

// 完成：
// - once：任务直接完成
// - cron：视为完成“本期”，自动推进到下一个 cron 触发点
function completeTask(id) {
  const items = readTasks();
  const task = items.find((x) => x.id === id);
  if (!task) return null;
  const completedAt = nowIso();
  if (task.kind === 'cron') {
    task.lastCompletedAt = completedAt;
    task.lastNotifiedAt = null;
    task.status = 'open';
    task.nextAt = computeNextAt('cron', task.cron, new Date());
  } else {
    task.status = 'done';
    task.lastCompletedAt = completedAt;
    task.executionStatus = 'completed';
  }
  task.updatedAt = completedAt;
  saveTasks(items);
  return { ...task };
}

function startTask(id) {
  const task = getTask(id);
  if (!task) return { ok: false, status: 404, error: '事项不存在' };
  if (task.type !== 'todo' || task.executionMode !== 'dsh' || !task.action) {
    return { ok: false, status: 400, error: '该待办没有可启动的 AI 执行动作' };
  }
  if (task.status === 'done') return { ok: false, status: 409, error: '该待办已经完成' };
  if (task.executionStatus === 'queued' || task.executionStatus === 'running') {
    return { ok: true, task, queued: null };
  }
  const { enqueueTask } = require('../../agent/queue');
  const queued = enqueueTask({
    type: task.action.capability || 'todo',
    summary: task.title,
    detail: task.detail,
    payload: { action: task.action, taskId: task.id },
    taskId: task.id,
    source: { taskId: task.id, intentId: task.sourceIntentId, ...(task.source || {}) }
  });
  if (!queued) return { ok: false, status: 400, error: 'AI 执行入队失败' };
  const updated = updateTask(id, { lastQueuedAt: 'manual', executionStatus: 'queued' });
  return { ok: true, task: updated || task, queued };
}

function deleteTask(id) {
  const items = readTasks();
  const idx = items.findIndex((x) => x.id === id);
  if (idx < 0) return false;
  items.splice(idx, 1);
  saveTasks(items);
  return true;
}

module.exports = {
  createTask,
  getTask,
  listTasks,
  updateTask,
  startTask,
  completeTask,
  deleteTask,
  computeNextAt,
  normalizeTask
};
