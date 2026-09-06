// 小鹈鹕核心 — 用户日程存储
'use strict';

const crypto = require('crypto');
const { getPaths } = require('../../lib/paths');
const { readJson, writeJson } = require('../../lib/store');

const P = getPaths();

function nowIso() {
  return new Date().toISOString();
}

function normalizeSchedule(value) {
  const item = value && typeof value === 'object' ? value : {};
  return {
    id: item.id || 'schedule_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex'),
    title: String(item.title || '').trim(),
    detail: String(item.detail || ''),
    startAt: item.startAt || null,
    endAt: item.endAt || null,
    status: item.status || 'open',
    sourceIntentId: item.sourceIntentId || '',
    source: item.source || null,
    createdAt: item.createdAt || nowIso(),
    updatedAt: item.updatedAt || nowIso()
  };
}

function readSchedules() {
  const data = readJson(P.schedules, []);
  return Array.isArray(data) ? data.map(normalizeSchedule) : [];
}

function saveSchedules(items) {
  writeJson(P.schedules, items);
}

function createSchedule(input = {}) {
  const items = readSchedules();
  const schedule = normalizeSchedule({
    id: input.id || undefined,
    title: input.title,
    detail: input.detail || '',
    startAt: input.startAt || null,
    endAt: input.endAt || null,
    status: input.status || 'open',
    sourceIntentId: input.sourceIntentId || '',
    source: input.source || null
  });
  if (!schedule.title || !schedule.startAt || (schedule.endAt && new Date(schedule.endAt) < new Date(schedule.startAt))) return null;
  items.push(schedule);
  saveSchedules(items);
  return { ...schedule };
}

function listSchedules(opts = {}) {
  const items = readSchedules();
  return opts.status ? items.filter((x) => x.status === opts.status) : items;
}

function updateSchedule(id, patch = {}) {
  const items = readSchedules();
  const schedule = items.find((x) => x.id === id);
  if (!schedule) return null;
  if (patch.title !== undefined) schedule.title = String(patch.title).trim();
  if (patch.detail !== undefined) schedule.detail = String(patch.detail);
  if (patch.startAt !== undefined) schedule.startAt = patch.startAt || null;
  if (patch.endAt !== undefined) schedule.endAt = patch.endAt || null;
  if (patch.status !== undefined) schedule.status = String(patch.status);
  schedule.updatedAt = nowIso();
  if (!schedule.title || !schedule.startAt || (schedule.endAt && new Date(schedule.endAt) < new Date(schedule.startAt))) return null;
  saveSchedules(items);
  return { ...schedule };
}

function deleteSchedule(id) {
  const items = readSchedules();
  const index = items.findIndex((x) => x.id === id);
  if (index < 0) return false;
  items.splice(index, 1);
  saveSchedules(items);
  return true;
}

module.exports = {
  normalizeSchedule,
  readSchedules,
  saveSchedules,
  createSchedule,
  listSchedules,
  updateSchedule,
  deleteSchedule
};
