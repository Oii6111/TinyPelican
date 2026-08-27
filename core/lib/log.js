// 小鹈鹕核心 — 活动日志写入器
// 所有后台模块统一把活动写入 activity.log，供 Dashboard「日志」页查看。
'use strict';

const fs = require('fs');
const path = require('path');
const { getPaths } = require('./paths');

function logPath() {
  return getPaths().activityLog;
}

function ensureFile() {
  try {
    const dir = path.dirname(logPath());
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch {}
}

function log(level, source, message) {
  try {
    ensureFile();
    const entry = {
      ts: new Date().toISOString(),
      level: String(level || 'info').toLowerCase(),
      source: String(source || 'app'),
      message: String(message || '')
    };
    fs.appendFileSync(logPath(), JSON.stringify(entry) + '\n', 'utf8');
  } catch {}
}

module.exports = { log, logPath };
