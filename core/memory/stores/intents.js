// 小鹈鹕核心 — 意图库存储
'use strict';

const { getPaths } = require('../../lib/paths');
const { readJson, writeJson } = require('../../lib/store');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const P = getPaths();

function readIntents() {
  const data = readJson(P.intents, []);
  return Array.isArray(data) ? data : [];
}

function saveIntents(items) {
  fs.mkdirSync(path.dirname(P.intents), { recursive: true });
  const temporary = `${P.intents}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(items, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(temporary, P.intents);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}

function loadState() {
  const data = readJson(P.intentState, {});
  return (data && typeof data === 'object' && !Array.isArray(data)) ? data : {};
}

function saveState(state) {
  writeJson(P.intentState, state);
}

module.exports = { readIntents, saveIntents, loadState, saveState };
