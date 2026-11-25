'use strict';

// 今日行动的客观信号修正、决策护栏与证据包。
//
// 来源只有两类（都是可核查的事实，不含模型自己对联系人的描述）：
//   1. 用户自己写的社交目的
//   2. 客观事实：距上次对话多久、谁说的最后一句、近 7/30 天消息量、
//      用户对历史建议的采纳与忽略、临近日程
//
// 画像、模型推断出的关系状态一律不进这里。那些是模型推断出来的描述，
// 拿它们反过来决定提醒频率，就会变成「模型说关系升温 → 提醒变密 → 模型又据此说升温」的自证闭环。
//
// 模型有判断权，但结论必须落在下面这几条护栏里：
//   - 间隔 1–30 天
//   - 单次变动不超过上一版的 2 倍（不会今天每天、明天两周）
//   - 超出范围就夹住，并在决策日志里说明「被夹过」

const MIN_DAYS = 1;
const MAX_DAYS = 30;
const MAX_INTERVAL_DAYS = 30;
const MAX_RATIO = 2;
const DEFAULT_DAYS = 2;

const ACTIVE_CHAT_MIN = 20;      // 近 7 天消息数达到这个量算「很活跃」
const LONG_SILENCE_DAYS = 14;    // 距上次对话超过这个天数算「很久没聊」
const FEEDBACK_WINDOW_DAYS = 7;  // 看多久以内的行动反馈

// 修正项：全部来自客观事实，没有一项来自 AI 的推断。
const ADJUSTMENTS = Object.freeze({
  awaitingReply: { factor: 0.5, label: '对方最后一句还没回' },
  adopted: { factor: 0.8, label: '最近采纳过建议' },
  activeChat: { factor: 1.5, label: '最近聊得很勤' },
  ignored: { factor: 1.5, label: '最近连续忽略建议' },
  longSilence: { factor: 2, label: '已经很久没聊' }
});

const WEIGHTS = Object.freeze({
  goal: 0.45,
  cadence: 0.25,
  feedback: 0.15,
  schedule: 0.15
});

const SOURCE_LABELS = Object.freeze({
  goal: '你写的社交目的',
  cadence: '聊天节奏（间隔 / 谁最后说的 / 消息量）',
  feedback: '你对历史建议的反馈',
  schedule: '临近日程'
});

/** 把客观事实折成开关；阈值集中在这里，方便调。 */
function signalsFrom({ gap, recentCount, feedback } = {}) {
  const done = Number(feedback?.done || 0);
  const dismissed = Number(feedback?.dismissed || 0);
  const days = gap?.known === true ? Number(gap.daysSinceLastMessage) : null;
  return {
    awaitingReply: gap?.known === true && gap.ownerSpokeLast === false,
    adopted: done >= 1,
    activeChat: Number(recentCount || 0) >= ACTIVE_CHAT_MIN,
    ignored: dismissed >= 2 && done === 0,
    longSilence: days != null && days >= LONG_SILENCE_DAYS
  };
}

/** 基准 × 修正，夹在 1–30 天之间；暂停档不参与换算。 */
function adjustInterval(base, signals = {}) {
  if (base.days == null) return { base, id: base.id, label: base.label, days: null, baseDays: null, factor: null, reasons: [], matched: base.matched ?? null, source: base.source || null };
  let factor = 1;
  const reasons = [];
  for (const [key, rule] of Object.entries(ADJUSTMENTS)) {
    if (!signals[key]) continue;
    factor *= rule.factor;
    reasons.push(rule.label);
  }
  const days = Math.max(1, Math.min(MAX_INTERVAL_DAYS, Math.round(base.days * factor)));
  return { base, id: base.id, label: base.label, days, baseDays: base.days, factor, reasons, matched: base.matched ?? null, source: base.source || null };
}

function finite(value) {
  // Number(null) === 0、Number('') === 0，直接用会把「没有这个数」当成 0。
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * 组装这次决策的证据包。只放客观来源，缺什么就标 null，别让模型去猜。
 */
function buildCadenceEvidence({ goal = '', gap = {}, messageStats = {}, feedback = {}, schedules = [], previous = null } = {}) {
  const days = gap && gap.known === true ? finite(gap.daysSinceLastMessage) : null;
  return {
    weights: { ...WEIGHTS },
    sources: {
      goal: {
        text: String(goal || '').trim(),
        note: '用户自己写的社交目的，权重最高；为空时不要替他编目的'
      },
      cadence: {
        daysSinceLastMessage: days,
        lastSpeaker: gap?.lastSpeaker || 'unknown',
        ownerSpokeLast: gap?.ownerSpokeLast ?? null,
        messages7d: finite(messageStats.messages7d) ?? 0,
        messages30d: finite(messageStats.messages30d) ?? 0,
        ownerShare: finite(messageStats.ownerShare),
        note: '纯事实。没有新导入记录不等于没联系，缺失就是 null，不要当成冷淡'
      },
      feedback: {
        done7d: finite(feedback?.done) ?? 0,
        dismissed7d: finite(feedback?.dismissed) ?? 0,
        note: '完成只代表用户做过，忽略只代表那天没采用，都不代表对方的态度'
      },
      schedule: {
        upcoming: (Array.isArray(schedules) ? schedules : []).slice(0, 5).map((item) => ({
          title: String(item.title || '').slice(0, 60),
          inDays: finite(item.inDays),
          at: String(item.at || '')
        })),
        note: '承诺和生日这类硬事件可以覆盖节奏：该提醒就必须提醒'
      }
    },
    previous: previous && finite(previous.days)
      ? { intervalDays: finite(previous.days), decidedAt: String(previous.decidedAt || ''), reason: String(previous.reason || '').slice(0, 200) }
      : null
  };
}

/**
 * 把模型给的天数夹进护栏。返回 { days, clamped, note }。
 * previousDays 为上一版决策；没有上一版就不做 ±2 倍约束。
 */
function clampIntervalDays(value, previousDays = null, { minDays = MIN_DAYS, maxDays = MAX_DAYS, ratio = MAX_RATIO } = {}) {
  const notes = [];
  const previous = finite(previousDays);
  let days = finite(value);
  if (days == null) {
    days = previous && previous > 0 ? previous : DEFAULT_DAYS;
    notes.push('模型没给出可用天数，沿用上一版');
  }
  days = Math.round(days);

  const bounded = Math.min(maxDays, Math.max(minDays, days));
  if (bounded !== days) notes.push(`夹到 ${minDays}–${maxDays} 天`);
  days = bounded;

  if (previous != null && previous > 0) {
    const low = Math.max(minDays, Math.ceil(previous / ratio));
    const high = Math.min(maxDays, Math.floor(previous * ratio));
    const limited = Math.min(high, Math.max(low, days));
    if (limited !== days) {
      notes.push(`单次变动不超过 ${ratio} 倍，从 ${days} 天收到 ${limited} 天`);
      days = limited;
    }
  }
  return { days, clamped: notes.length > 0, note: notes.join('；') };
}

module.exports = {
  WEIGHTS, SOURCE_LABELS, MIN_DAYS, MAX_DAYS, MAX_INTERVAL_DAYS, MAX_RATIO, DEFAULT_DAYS,
  ACTIVE_CHAT_MIN, LONG_SILENCE_DAYS, FEEDBACK_WINDOW_DAYS, ADJUSTMENTS,
  signalsFrom, adjustInterval, buildCadenceEvidence, clampIntervalDays
};
