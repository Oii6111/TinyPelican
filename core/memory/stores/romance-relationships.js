'use strict';

const crypto = require('crypto');
const { getPaths } = require('../../lib/paths');
const { readJson, writeJson } = require('../../lib/store');

function nowIso() { return new Date().toISOString(); }
function pathName() { return getPaths().romanceRelationships; }
function readAll() {
  const value = readJson(pathName(), { relationships: [], primaryId: '' });
  if (Array.isArray(value)) return { relationships: value, primaryId: value[0]?.id || '' };
  return { relationships: Array.isArray(value?.relationships) ? value.relationships : [], primaryId: String(value?.primaryId || '') };
}
function save(state) { writeJson(pathName(), state); }
function normalize(input = {}, existing = {}) {
  const stamp = nowIso();
  return {
    id: existing.id || input.id || `romance_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
    contactName: String(input.contactName ?? existing.contactName ?? '').trim(),
    label: String(input.label ?? existing.label ?? '').trim(),
    type: String(input.type ?? existing.type ?? '暧昧对象').trim(),
    stage: String(input.stage ?? existing.stage ?? '了解中').trim(),
    status: String(input.status ?? existing.status ?? '需要关注').trim(),
    goal: String(input.goal ?? existing.goal ?? '').trim(),
    note: String(input.note ?? existing.note ?? '').trim(),
    createdAt: existing.createdAt || input.createdAt || stamp,
    updatedAt: stamp
  };
}
function list() { return readAll(); }
function get(id) { return readAll().relationships.find(item => item.id === id) || null; }
function create(input) {
  const state = readAll();
  const relationship = normalize(input);
  if (!relationship.contactName) return null;
  state.relationships.push(relationship);
  if (!state.primaryId) state.primaryId = relationship.id;
  save(state);
  return relationship;
}
function update(id, input) {
  const state = readAll();
  const index = state.relationships.findIndex(item => item.id === id);
  if (index < 0) return null;
  const relationship = normalize(input, state.relationships[index]);
  if (!relationship.contactName) return null;
  state.relationships[index] = relationship;
  save(state);
  return relationship;
}
function remove(id) {
  const state = readAll();
  const before = state.relationships.length;
  state.relationships = state.relationships.filter(item => item.id !== id);
  if (before === state.relationships.length) return false;
  if (state.primaryId === id) state.primaryId = state.relationships[0]?.id || '';
  save(state);
  return true;
}
function setPrimary(id) {
  const state = readAll();
  if (!state.relationships.some(item => item.id === id)) return null;
  state.primaryId = id;
  save(state);
  return get(id);
}

module.exports = { list, get, create, update, remove, setPrimary };
