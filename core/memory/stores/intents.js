// 小鹈鹕核心 — 意图库存储
'use strict';

const { getPaths } = require('../../lib/paths');
const { readJson, writeJson } = require('../../lib/store');

const P = getPaths();

function readIntents() {
  const data = readJson(P.intents, []);
  return Array.isArray(data) ? data : [];
}

function saveIntents(items) {
  writeJson(P.intents, items);
}

function loadState() {
  const data = readJson(P.intentState, {});
  return (data && typeof data === 'object' && !Array.isArray(data)) ? data : {};
}

function saveState(state) {
  writeJson(P.intentState, state);
}

module.exports = { readIntents, saveIntents, loadState, saveState };
