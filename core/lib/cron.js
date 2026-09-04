// 小鹈鹕核心 — 轻量 5 段 cron 解析（分 时 日 月 星期）
// 支持：*  */n  a-b  a,b  数字；星期 0/7 都表示周日。
'use strict';

function parseField(expr, min, max) {
  const values = new Set();
  if (expr === '*') {
    for (let i = min; i <= max; i++) values.add(i);
    return values;
  }
  for (const part of String(expr).split(',')) {
    const p = part.trim();
    if (!p) continue;
    const stepMatch = p.match(/^(.+)\/(\d+)$/);
    let range = p;
    let step = 1;
    if (stepMatch) {
      range = stepMatch[1];
      step = parseInt(stepMatch[2], 10) || 1;
    }
    let start = min;
    let end = max;
    if (range !== '*') {
      const parts = range.split('-');
      if (parts.length === 1) {
        start = end = parseInt(parts[0], 10);
      } else if (parts.length === 2) {
        start = parseInt(parts[0], 10);
        end = parseInt(parts[1], 10);
      } else {
        throw new Error('无法解析 cron 字段：' + p);
      }
    }
    if (Number.isNaN(start) || Number.isNaN(end) || start < min || end > max || start > end) {
      throw new Error('cron 字段越界：' + p);
    }
    for (let i = start; i <= end; i += step) values.add(i);
  }
  return values;
}

function parseCron(expr) {
  const parts = String(expr || '').trim().split(/\s+/);
  if (parts.length !== 5) throw new Error('cron 必须为 5 段：分 时 日 月 星期');
  const weekdayExpr = parts[4].split(',').map((x) => x.trim() === '7' ? '0' : x.trim()).join(',');
  return {
    minute: parseField(parts[0], 0, 59),
    hour: parseField(parts[1], 0, 23),
    day: parseField(parts[2], 1, 31),
    month: parseField(parts[3], 1, 12),
    weekday: parseField(weekdayExpr, 0, 6)
  };
}

function matches(date, cron) {
  return cron.minute.has(date.getMinutes())
    && cron.hour.has(date.getHours())
    && cron.month.has(date.getMonth() + 1)
    && cron.day.has(date.getDate())
    && cron.weekday.has(date.getDay());
}

// 返回 after 之后（严格大于）的第一个匹配时间；找不到返回 null。
// 使用本地时区逐分钟推进，最多向前搜索 5 年，避免死循环。
function nextCronAfter(expr, after = new Date()) {
  const cron = parseCron(expr);
  const candidate = new Date((after instanceof Date ? after : new Date(after)).getTime() + 60000);
  candidate.setSeconds(0, 0);
  const deadline = candidate.getTime() + 5 * 366 * 24 * 60 * 60000;
  while (candidate.getTime() <= deadline) {
    if (matches(candidate, cron)) return candidate;
    candidate.setTime(candidate.getTime() + 60000);
  }
  return null;
}

module.exports = { parseCron, matches, nextCronAfter };
