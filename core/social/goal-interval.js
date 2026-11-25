'use strict';

// 今日行动的基准间隔：只由用户自己填的「社交目的」决定。
//
// 这里不读任何 AI 判断出来的描述性状态（画像、阶段、关系分析），
// 只做一件事：把用户写的社交目的文字映射成一个基准天数。
// 最终天数还要叠加客观信号修正（见 cadence.js），日程临期时直接覆盖（见 daily-actions.js）。

const INTERVALS = Object.freeze({
  pause: { id: 'pause', label: '暂停', days: null, hint: '不主动生成，有日程才提醒' },
  unset: { id: 'unset', label: '未填社交目的', days: null, hint: '填了社交目的才会生成今日行动' },
  pursue: { id: 'pursue', label: '推进', days: 1, hint: '每天给一次建议' },
  build: { id: 'build', label: '了解', days: 2, hint: '约每两天一次' },
  maintain: { id: 'maintain', label: '维持', days: 6, hint: '约每周一次' }
});

// 首页的档位展示顺序：从最主动到最克制。
const INTERVAL_META = Object.freeze([
  { id: 'pursue', label: INTERVALS.pursue.label, days: INTERVALS.pursue.days, hint: INTERVALS.pursue.hint },
  { id: 'build', label: INTERVALS.build.label, days: INTERVALS.build.days, hint: INTERVALS.build.hint },
  { id: 'maintain', label: INTERVALS.maintain.label, days: INTERVALS.maintain.days, hint: INTERVALS.maintain.hint },
  { id: 'pause', label: INTERVALS.pause.label, days: null, hint: INTERVALS.pause.hint }
]);

// 顺序有意义：先看「暂停」，再看「维持」，然后「推进」，最后落到「了解」。
// 「维持类」排在「推进类」前面，是为了不让「维持老朋友的关系，偶尔见面」里
// 的「见面」把一条明显的维持型目的误判成推进（两者频率差 6 倍）。
const RULES = Object.freeze([
  { id: 'pause', re: /暂停|先放一放|放一放|缓一缓|冷处理|搁置|不再主动|不想联系|先不联系|先算了/ },
  { id: 'maintain', re: /维持|保持|老朋友|好友|家人|父母|亲戚|偶尔|不定期|日常问候|礼尚往来|保持联系/ },
  { id: 'pursue', re: /约(他|她|出来|一次|见面|个|饭|咖啡|午餐|晚餐)|约见|约饭|约咖啡|约一次|见面|邀请|拜访|当面|打电话|推进|尽快|主动联系|主动约|拉近|加深|单独见面/ },
  { id: 'build', re: /了解|熟悉|慢慢|先聊|多聊|观察|认识|试探/ }
]);

function effectiveGoal(member) {
  return String(member?.socialGoal || member?.goal || '').trim();
}

// matched 记录是哪个规则命中的；null 表示「没认出来，走了兜底」。
// 两者算出来的间隔可能一样（兜底恰好也是 build），但对用户是两种完全不同的信息：
// 「这是按你的社交目的算的」vs「你的目的我没看懂，先按默认来了」。
function intervalForGoal(goal) {
  const text = String(goal || '').trim();
  if (!text) return { ...INTERVALS.unset, matched: 'unset' };
  for (const rule of RULES) {
    if (rule.re.test(text)) return { ...INTERVALS[rule.id], matched: rule.id };
  }
  return { ...INTERVALS.build, matched: null };
}

function intervalOf(member) {
  return intervalForGoal(effectiveGoal(member));
}

module.exports = { INTERVALS, INTERVAL_META, RULES, effectiveGoal, intervalForGoal, intervalOf };
