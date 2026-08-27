// 小鹈鹕核心 — 文件存储统一读写
// 目前基于本地 JSON / JSONL；后续若切换 SQLite，只需替换本层。
'use strict';

const fs = require('fs');
const path = require('path');

function readJson(file, fallback = null) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {}
  return fallback;
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function appendJsonl(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(obj) + '\n', 'utf8');
}

function readJsonl(file) {
  try {
    if (!fs.existsSync(file)) return [];
    const out = [];
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch {}
    }
    return out;
  } catch {
    return [];
  }
}

function listJsonFiles(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  } catch {
    return [];
  }
}

module.exports = { readJson, writeJson, appendJsonl, readJsonl, listJsonFiles };
