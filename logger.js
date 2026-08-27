// 小鹈鹕 V3 — 活动日志写入器
// 所有脚本统一把后台活动写入 activity.log，供 Dashboard「日志」页查看。
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.XIAOTIHU_DATA_DIR;
const LOG_PATH = DATA_DIR ? path.join(DATA_DIR, 'activity.log') : path.join(__dirname, 'activity.log');

function ensureFile() {
  try {
    if (!fs.existsSync(path.dirname(LOG_PATH))) {
      fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    }
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
    fs.appendFileSync(LOG_PATH, JSON.stringify(entry) + '\n', 'utf8');
  } catch {}
}

module.exports = { log, LOG_PATH };
