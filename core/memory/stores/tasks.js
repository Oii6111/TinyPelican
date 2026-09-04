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
  return {
    id: task.id || 'task_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex'),
    title: String(task.title || '').trim(),
    detail: String(task.detail || ''),
    kind: task.kind === 'cron' ? 'cron' : 'once',
    dueAt: task.dueAt || null,
    cron: String(task.cron || '').trim(),
    nextAt: task.nextAt || null,
    status: task.status || 'open',
    sourceIntentId: task.sourceIntentId || '',
    source: task.source || null,
    lastNotifiedAt: task.lastNotifiedAt || null,
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
  const next = nextCronAfter(cron, after);
  return next ? next.toISOString() : null;
}

function createTask(input = {}) {
  const items = readTasks();
  const t = normalizeTask({
    id: input.id || undefined,
    title: input.title,
    detail: input.detail || '',
    kind: input.kind || 'once',
    dueAt: input.dueAt || null,
    cron: input.cron || '',
    status: input.status || 'open',
    sourceIntentId: input.sourceIntentId || '',
    source: input.source || null
  });
  if (!t.title) return null;
  if (t.kind === 'cron') {
    t.nextAt = computeNextAt('cron', t.cron);
    t.dueAt = null;
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
  if (patch.kind !== undefined) task.kind = patch.kind === 'cron' ? 'cron' : 'once';
  if (patch.dueAt !== undefined) task.dueAt = patch.dueAt || null;
  if (patch.cron !== undefined) task.cron = String(patch.cron).trim();
  if (patch.status !== undefined) task.status = patch.status;
  if (patch.sourceIntentId !== undefined) task.sourceIntentId = patch.sourceIntentId;
  if (task.kind === 'cron') {
    task.dueAt = null;
    task.nextAt = computeNextAt('cron', task.cron, new Date());
  } else {
    task.cron = '';
    task.nextAt = null;
  }
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
  }
  task.updatedAt = completedAt;
  saveTasks(items);
  return { ...task };
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
  completeTask,
  deleteTask,
  computeNextAt,
  normalizeTask
};
