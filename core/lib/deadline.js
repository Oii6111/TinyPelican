// 小鹈鹕核心 — 中文自然语言时间解析
// 把意图里的「明天 / 下周一 / 月底 / 晚上8点」等表达解析成绝对时间。
'use strict';

function pad(n) { return String(n).padStart(2, '0'); }

function toLocalDate(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function parseMsgTs(ts) {
  const m = String(ts || '').match(/^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{1,2})$/);
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], 0, 0);
}

function addDays(d, n) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

function nextWeekday(base, targetDay, nextWeek) {
  // targetDay: 0=周日, 1=周一 ... 6=周六
  const d = new Date(base);
  d.setHours(0, 0, 0, 0);
  let diff = targetDay - d.getDay();
  if (nextWeek) diff += 7;
  else if (diff <= 0) diff += 7;
  return addDays(d, diff);
}

function parseDeadline(text, msgTs) {
  if (!text || !msgTs) return null;
  const t = String(text);
  const base = parseMsgTs(msgTs);
  if (!base) return null;
  let target = null;

  if (/(今天|今晚)/.test(t)) target = base;
  else if (/明天/.test(t)) target = addDays(base, 1);
  else if (/后天/.test(t)) target = addDays(base, 2);
  else if (/大后天/.test(t)) target = addDays(base, 3);
  else if (/月底/.test(t)) {
    target = new Date(base.getFullYear(), base.getMonth() + 1, 0, 23, 59, 0, 0);
  } else if (/(\d{1,2})月(\d{1,2})日/.test(t)) {
    const mm = parseInt(RegExp.$1, 10);
    const dd = parseInt(RegExp.$2, 10);
    let y = base.getFullYear();
    let d = new Date(y, mm - 1, dd, 23, 59, 0, 0);
    if (d < base) d = new Date(y + 1, mm - 1, dd, 23, 59, 0, 0);
    target = d;
  } else if (/(\d{1,2})月/.test(t) && /(?:号|日)/.test(t)) {
    // 已在上面的分支处理
  } else if (/下?周([一二三四五六日天])/.test(t)) {
    const map = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 0, '天': 0 };
    const day = map[RegExp.$1];
    const nextWeek = /下周/.test(t);
    target = nextWeekday(base, day, nextWeek);
    target.setHours(23, 59, 0, 0);
  } else if (/周([一二三四五六日天])/.test(t)) {
    const map = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 0, '天': 0 };
    const day = map[RegExp.$1];
    target = nextWeekday(base, day, false);
    target.setHours(23, 59, 0, 0);
  } else if (/(\d{1,2})天后/.test(t)) {
    target = addDays(base, parseInt(RegExp.$1, 10));
  } else if (/(\d{1,2})[:：](\d{1,2})/.test(t)) {
    const h = parseInt(RegExp.$1, 10);
    const min = parseInt(RegExp.$2, 10);
    target = new Date(base.getFullYear(), base.getMonth(), base.getDate(), h, min, 0, 0);
    if (target <= base) target = addDays(target, 1);
  } else if (/(上午|中午|下午|晚上)?\s*(\d{1,2})点/.test(t)) {
    let h = parseInt(RegExp.$2, 10);
    const period = RegExp.$1;
    if (period === '下午' || period === '晚上') { if (h < 12) h += 12; }
    if (period === '中午' && h < 12) h = 12;
    target = new Date(base.getFullYear(), base.getMonth(), base.getDate(), h, 0, 0, 0);
    if (target <= base) target = addDays(target, 1);
  }

  if (!target) return null;
  return target.toISOString();
}

module.exports = { parseDeadline, toLocalDate, parseMsgTs, addDays, nextWeekday };
