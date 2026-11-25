'use strict';

const { createHash } = require('node:crypto');
const { createDailyActionsStore } = require('../memory/stores/daily-actions');
const { buildCadenceEvidence, clampIntervalDays, signalsFrom, adjustInterval, FEEDBACK_WINDOW_DAYS } = require('./cadence');
const { intervalOf, effectiveGoal, intervalForGoal, INTERVAL_META } = require('./goal-interval');

const DAY_MS = 86400000;

function localDate(value = new Date()) {
  const date = new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function parseTimestamp(value) {
  const text = String(value || '').trim();
  if (!text) return Number.NaN;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(text) ? text.replace(' ', 'T') : text;
  const stamp = Date.parse(normalized);
  return Number.isFinite(stamp) ? stamp : Number.NaN;
}

/** 两个本地自然日之间差几天；解析失败返回 null。 */
function dayDifference(fromDate, toDate) {
  const from = Date.parse(`${fromDate}T00:00:00`);
  const to = Date.parse(`${toDate}T00:00:00`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return Math.round((to - from) / DAY_MS);
}

/** 把「距上次对话多久、最后一句是谁说的」算好交给模型，避免它自己从时间戳里减。 */
function gapFor(messages, date, contactName) {
  const dated = (messages || []).filter(message => Number.isFinite(parseTimestamp(message.ts)));
  const last = dated[dated.length - 1];
  if (!last) {
    return { known: false, daysSinceLastMessage: null, lastMessageAt: '', lastSpeaker: 'unknown', ownerSpokeLast: null, datedMessageCount: 0 };
  }
  const days = dayDifference(localDate(new Date(parseTimestamp(last.ts))), date);
  return {
    known: days != null,
    daysSinceLastMessage: days,
    lastMessageAt: last.ts,
    lastSpeaker: last.isOwner === true ? '我' : last.isOwner === false ? contactName : '未确认',
    ownerSpokeLast: last.isOwner ?? null,
    datedMessageCount: dated.length
  };
}

/** 近 N 天内的消息条数，用来判断「聊得很勤」。 */
function recentMessageCount(messages, date, days = 7) {
  const since = Date.parse(`${date}T00:00:00`) - days * DAY_MS;
  if (!Number.isFinite(since)) return 0;
  let count = 0;
  for (const message of messages || []) {
    const at = parseTimestamp(message.ts);
    if (Number.isFinite(at) && at >= since) count += 1;
  }
  return count;
}

function shiftDate(date, days) {
  const at = new Date(`${date}T00:00:00`);
  if (!Number.isFinite(at.getTime())) return date;
  at.setDate(at.getDate() + days);
  return localDate(at);
}

function limitedObject(value, limit) {
  let remaining = limit;
  const copy = (entry, depth = 0) => {
    if (remaining <= 0 || depth > 8 || entry == null) return undefined;
    if (typeof entry === 'string') {
      const text = entry.slice(0, remaining);
      remaining -= text.length;
      return text;
    }
    if (typeof entry === 'number' || typeof entry === 'boolean') { remaining -= 16; return entry; }
    if (Array.isArray(entry)) return entry.slice(0, 80).map(child => copy(child, depth + 1)).filter(child => child !== undefined);
    if (typeof entry !== 'object') return undefined;
    return Object.fromEntries(Object.entries(entry).slice(0, 100).filter(([key]) => !['__proto__', 'constructor', 'prototype'].includes(key)).flatMap(([key, child]) => {
      remaining -= key.length;
      const result = copy(child, depth + 1);
      return result === undefined ? [] : [[key, result]];
    }));
  };
  return copy(value) || {};
}

function recentMessages(messages) {
  let remaining = 12000;
  const result = [];
  for (const message of messages.slice(-80).reverse()) {
    if (remaining <= 0) break;
    const original = String(message.content || '');
    const content = original.slice(0, Math.min(1500, remaining));
    remaining -= content.length;
    result.push({ id: message.id, sender: message.sender || message.name || '', ts: message.ts || '',
      isOwner: message.isOwner ?? null, speakerRole: message.speakerRole, type: message.type || 'text', source: message.source, content, truncated: content.length < original.length });
  }
  return result.reverse();
}

function friendlyError(error) {
  const text = String(error?.message || error || '');
  if (/余额不足|insufficient[_ ]?balance/i.test(text)) return '模型账户余额不足，充值后点「更新推荐」重试。';
  if (/未配置|api.?key|credential|401|403/i.test(text)) return '模型服务尚未配置或密钥无效，请在设置中检查后重试。';
  if (/timeout|timed out|超时|abort/i.test(text)) return '推荐生成超时，请点击更新推荐重试。';
  if (/JSON|格式|依据|证据|输出|结构/.test(text)) return '模型返回的推荐未通过格式或依据校验，请重试。';
  return '暂时无法生成推荐，请点击更新推荐重试；已有结果已保留。';
}

// 「没填社交目的」是一条会过期的休息理由：目的补上之后它描述的状态就不存在了。
// 还留着它，首页就会一直显示「这个人还没填目的」，而其实已经填了。
const MISSING_GOAL_REST = /^还没填社交目的/;
function isStaleRestReason(batch, interval) {
  return !!batch && batch.status === 'resting' && interval?.id !== 'unset'
    && MISSING_GOAL_REST.test(String(batch.emptyReason || ''));
}

function createDailyActionsService({ chatDb, schedules, runTask, getConfig = () => ({}), now = () => new Date(), store = createDailyActionsStore(chatDb.db) }) {
  const queue = [];
  const inFlight = new Set();
  let processing = null;
  store.recover(new Date(now()).toISOString());

  // 只有真正的「人」才进今日行动：群（kind='group'）和群里出现过但还没加联系人的人
  // （kind='member'）都不是可以私聊维护的对象，不能收到行动建议。
  function members() {
    const config = getConfig();
    const self = new Set((config.selfNicknames || []).map(name => String(name).trim()));
    return chatDb.listMembers().filter(member => member.name && member.kind !== 'group' && member.kind !== 'member'
      && member.name !== 'inbox' && !/未归属/.test(member.name) && !self.has(member.name))
      .sort((left, right) => Number(!!right.important) - Number(!!left.important)
        || Number(right.lastMessageId || 0) - Number(left.lastMessageId || 0));
  }

  function feedbackFor(member, date) {
    return store.feedbackWindow(member.id, shiftDate(date, -FEEDBACK_WINDOW_DAYS), shiftDate(date, -1));
  }

  function contextFor(member, date, avoid = []) {
    const config = getConfig();
    const fullMember = chatDb.getMember(member.name) || member;
    const context = chatDb.contactContext(member.name, { limit: 80, hotOnly: false, config }) || {};
    const goal = effectiveGoal(fullMember).slice(0, 1200);
    const start = new Date(now());
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 7);
    const relatedSchedules = schedules.listSchedules({ status: 'open' }).filter(item => item.status === 'open'
      && item.source?.contact === member.name && Date.parse(item.endAt || item.startAt) >= start.getTime() && Date.parse(item.startAt) < end.getTime())
      .sort((left, right) => String(left.startAt).localeCompare(String(right.startAt))).slice(0, 10)
      .map(item => ({ id: item.id, title: String(item.title || '').slice(0, 160), detail: String(item.detail || '').slice(0, 500), startAt: item.startAt, endAt: item.endAt || null }));
    const messages = recentMessages(context.recentMessages || []);
    const gap = gapFor(messages, date, member.name);
    const interval = applyDecided(member, adjustInterval(intervalOf(fullMember),
      signalsFrom({ gap, recentCount: recentMessageCount(messages, date), feedback: feedbackFor(member, date) })));
    const profile = limitedObject(fullMember.profile || context.profile || {}, 10000);
    const summary = limitedObject(context.chatSummary || {}, 4000);
    const evidenceSources = [];
    if (goal) evidenceSources.push({ id: 'goal', type: 'goal', label: '你的社交目的', text: goal });
    for (const [section, fields] of Object.entries(profile)) {
      if (!fields || typeof fields !== 'object' || Array.isArray(fields)) continue;
      for (const [field, value] of Object.entries(fields)) {
        if (typeof value !== 'string' || !value.trim()) continue;
        evidenceSources.push({ id: `profile:${section}:${field}`, type: 'profile', label: `${section} · ${field}`, text: value,
          timestamp: fullMember.profileMeta?.updatedAt || fullMember.profileMeta?.generatedAt || '' });
      }
    }
    const summaryText = typeof summary.summary === 'string' ? summary.summary : typeof summary.text === 'string' ? summary.text : '';
    if (summaryText) evidenceSources.push({ id: 'summary', type: 'summary', label: '已有聊天摘要', text: summaryText.slice(0, 1200), timestamp: summary.updatedAt || '' });
    for (const message of messages) {
      if (message.id == null || !message.content.trim()) continue;
      evidenceSources.push({ id: `message:${message.id}`, type: 'message', label: message.isOwner === true ? '我' : message.isOwner === false ? member.name : '身份未确认',
        text: message.content, messageId: message.id, timestamp: message.ts, truncated: message.truncated });
    }
    for (const item of relatedSchedules) {
      evidenceSources.push({ id: `schedule:${item.id}`, type: 'schedule', label: '已关联日程', text: item.title + (item.detail ? `：${item.detail}` : ''), timestamp: item.startAt, scheduleId: item.id });
    }
    const historyStart = new Date(start);
    historyStart.setDate(historyStart.getDate() - 7);
    const previousActions = store.history(member.id, localDate(historyStart), date).map(action => ({ id: action.id, kind: action.kind,
      title: action.title, summary: action.summary, status: action.status, date: action.date }));
    return {
      date, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      contact: { name: member.name, remark: member.remark || '' }, goal, missingGoal: !goal,
      userPersona: String(config.userPersona || '').slice(0, 2000), profile,
      profileUpdatedAt: fullMember.profileMeta?.updatedAt || fullMember.profileMeta?.generatedAt || '',
      chatSummary: summary, recentMessages: messages, gap,
      interval: {
        id: interval.id, label: interval.label, days: interval.days,
        baseDays: interval.baseDays, reasons: interval.reasons,
        // 这两个必须带上：source 用来区分「模型判的 / 关键词估的」，
        // decided 是决策日志（天数、理由、依据、有没有被护栏夹过）
        source: interval.source || null,
        matched: interval.matched === undefined ? null : interval.matched,
        reason: interval.reason || '',
        decided: interval.decided || null
      },
      messageCoverage: { ...(context.messageCoverage || {}), inputPreviewCount: messages.length,
        inputTruncated: messages.length < (context.recentMessages || []).length || messages.some(message => message.truncated) },
      schedules: relatedSchedules, previousActions, avoidSuggestions: avoid,
      // 节奏决策的全部输入（只有客观来源：社交目的 / 聊天节奏 / 反馈 / 日程）+ 上一版决策
      cadence: buildCadenceEvidence({
        goal,
        gap: gapFor(messages, date, member.name),
        messageStats: {
          messages7d: recentMessageCount(messages, date, 7),
          messages30d: recentMessageCount(messages, date, 30),
          ownerShare: messages.length ? Number((messages.filter(m => m.isOwner === true).length / messages.length).toFixed(2)) : null
        },
        feedback: feedbackFor(member, date),
        schedules: relatedSchedules.map(item => ({
          title: item.title,
          at: item.startAt,
          inDays: item.startAt ? dayDifference(date, localDate(new Date(item.startAt))) : null
        })),
        previous: store.intervalState(member.id)
      }),
      evidenceSources
    };
  }

  function fingerprint(context) {
    // 换一批的「避开列表」只是这一次的请求参数，不进指纹：否则点一次换一批就变成「有新资料」。
    const { previousActions, evidenceSources, avoidSuggestions, cadence, ...input } = context;
    return createHash('sha256').update(JSON.stringify(input)).digest('hex');
  }

  function list() {
    const date = localDate(now());
    const contacts = members().map(member => {
      const batch = store.batch(member.id, date);
      const context = contextFor(member, date);
      const interval = context.interval;
      // 目的填上以后，之前按「没填目的」存下的休息理由就过期了：
      // 不重算，首页会一直挂着一句「还没填社交目的」，而这个人其实已经有目的了。
      // 当成「还没生成」，让页面走它自己的补生成流程。
      const staleRest = isStaleRestReason(batch, interval);
      return {
        contactName: member.name, label: member.remark || member.name,
        goal: context.goal, missingGoal: context.missingGoal,
        interval: interval.id, intervalLabel: interval.label, intervalDays: interval.days,
        intervalBaseDays: interval.baseDays, intervalReasons: interval.reasons, gap: context.gap,
        // matched=null 表示「目的没被规则认出来，走了兜底档」，前端据此提示用户换个说法
        // 决策日志：这次节奏是谁定的、依据是什么、有没有被护栏夹过
        cadence: interval.decided
          ? {
            days: interval.decided.days,
            reason: interval.decided.reason,
            drivers: interval.decided.drivers,
            clamped: interval.decided.clamped,
            decidedAt: interval.decided.decidedAt
          }
          : null,
        status: staleRest ? 'missing' : (batch?.status || 'missing'), error: batch?.error || '',
        generatedAt: batch?.generatedAt || '', emptyReason: staleRest ? '' : (batch?.emptyReason || ''),
        hasNewData: staleRest || (!!batch?.fingerprint && batch.fingerprint !== fingerprint(context)),
        actions: store.actions(member.id, date).map(({ memberId, ...action }) => action)
      };
    });
    // 没填社交目的的联系人不生成今日行动，也不该在首页堆一屏「还没填社交目的」。
    // 它们从 contacts 里摘出去，放进 goalMissing：前端只显示一行计数，
    // 但服务端仍然把状态带出来，便于排查和测试「没目的就不调模型」这条规则。
    const visible = contacts.filter(contact => contact.interval !== 'unset');
    const hidden = contacts.filter(contact => contact.interval === 'unset');
    return {
      date, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, intervalPresets: INTERVAL_META,
      contacts: visible,
      goalMissing: { count: hidden.length, contacts: hidden }
    };
  }

  async function drain() {
    while (queue.length) {
      const job = queue.shift();
      try {
        const member = members().find(item => item.id === job.memberId);
        if (!member || job.date !== localDate(now())) {
          store.setStatus(job.memberId, job.date, 'error', new Date(now()).toISOString(), '联系人或日期已变化，请重新生成。');
          continue;
        }
        store.setStatus(job.memberId, job.date, 'running', new Date(now()).toISOString());
        const context = contextFor(member, job.date, job.avoid || []);
        // 走到这里一定有依据：没填社交目的（unset）或被设为「暂停」的联系人不会入队；
        // 能进来的要么目的本身就是一条依据，要么是「3 天内有日程」把它顶进来，而日程也会进依据。
        const result = await runTask('daily_actions', context, { config: getConfig(), timeoutMs: 60000, retries: 0 });
        if (!result?.ok || !Array.isArray(result.actions)) throw new Error(result?.error || '模型输出结构无效');
        const stillExists = members().some(item => item.id === job.memberId);
        if (!stillExists) throw new Error('联系人资料已删除');
        const stamp = new Date(now()).toISOString();
        // 节奏和内容是一次判出来的：模型真给了天数才落库（没给就沿用上一版，别拿默认值盖掉公式）。
        // 上一版决策是 ±2 倍的基准，也是决策日志里「为什么变了」的对照。
        const previous = store.intervalState(job.memberId);
        const reported = Number(result.intervalDays);
        if (Number.isFinite(reported) && reported > 0) {
          const clamped = clampIntervalDays(reported, previous ? previous.days : null);
          store.setIntervalState(job.memberId, {
            days: clamped.days,
            reason: result.cadenceReason || '',
            drivers: result.drivers || [],
            source: 'llm',
            clamped: clamped.clamped,
            goal: effectiveGoal(member)
          }, stamp);
        }
        // 模型说今天别打扰：落成休息，理由留在卡片上，别静默跳过
        if (result.shouldGenerate === false || result.resting === true) {
          store.rest(job.memberId, job.date, member.name, fingerprint(context),
            result.emptyReason || result.cadenceReason || '按节奏今天先不打扰。', stamp);
          continue;
        }
        store.saveResult(job.memberId, job.date, result, fingerprint(context), stamp, { avoid: job.avoid || [] });
      } catch (error) {
        store.setStatus(job.memberId, job.date, 'error', new Date(now()).toISOString(), friendlyError(error));
      } finally { inFlight.delete(job.key); }
    }
  }

  function kick() {
    if (processing || !queue.length) return;
    processing = Promise.resolve().then(drain).finally(() => {
      processing = null;
      kick();
    });
  }

  /** 未来 3 天内有明确关联的日程时，节奏要让位：承诺和生日不能因为「上周刚聊过」而漏掉。 */
  function upcomingScheduleContacts() {
    const start = new Date(now());
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 3);
    const names = new Set();
    for (const item of schedules.listSchedules({ status: 'open' })) {
      if (item.status !== 'open' || !item.source?.contact) continue;
      const at = Date.parse(item.startAt);
      if (Number.isFinite(at) && at >= start.getTime() && at < end.getTime()) names.add(item.source.contact);
    }
    return names;
  }

  // 模型判过的节奏优先于公式。社交目的文本改过就作废旧结论（旧结论是针对旧目的算的）。
  // list() 和闸门必须走同一条路径，否则会看到「决策存了但界面不认」。
  function applyDecided(member, computed) {
    if (!computed || computed.days == null) return computed;
    const decided = store.intervalState(member.id);
    if (!decided || !Number.isFinite(decided.days) || decided.days <= 0) return computed;
    const goalNow = effectiveGoal(member);
    if (String(decided.goal || '') !== goalNow) return computed;
    return { ...computed, days: decided.days, decided };
  }

  function intervalState(member, date) {
    const fullMember = chatDb.getMember(member.name) || member;
    const context = chatDb.contactContext(member.name, { limit: 80, hotOnly: false, config: getConfig() }) || {};
    const messages = recentMessages(context.recentMessages || []);
    const gap = gapFor(messages, date, member.name);
    const computed = adjustInterval(intervalOf(fullMember),
      signalsFrom({ gap, recentCount: recentMessageCount(messages, date), feedback: feedbackFor(member, date) }));
    return applyDecided(fullMember, computed);
  }

  function shouldRest(member, interval, date, scheduleSoon) {
    if (scheduleSoon.has(member.name)) return false;
    if (interval.days == null) return true;
    if (interval.days <= 1) return false;
    const lastDate = store.lastGeneratedDate(member.id, date);
    if (!lastDate) return false;
    const gap = dayDifference(lastDate, date);
    if (gap == null) return false;
    return gap < interval.days;
  }

  function restReason(interval, memberId, date) {
    if (interval.id === 'unset') return '还没填社交目的，这里暂不生成今日行动；填了之后会按目的安排节奏。';
    if (interval.days == null) return '这位联系人的社交目的是「暂停」，今天不主动生成建议；有日程时会照常提醒。';
    const lastDate = store.lastGeneratedDate(memberId, date);
    const gap = lastDate ? dayDifference(lastDate, date) : null;
    const ago = gap == null ? '上次' : `${gap} 天前`;
    const detail = interval.reasons?.length ? `（${interval.reasons.join('、')}）` : '';
    const base = interval.baseDays && interval.baseDays !== interval.days
      ? `目的基准 ${interval.baseDays} 天，按现在的情况调到 ${interval.days} 天${detail}`
      : `约每 ${interval.days} 天一次${detail}`;
    return `${base}；${ago}刚给过建议，今天先不打扰。有新资料或临近日程时会照常生成。`;
  }

  function generate({ contactName = '', force = false, avoid = [] } = {}) {
    const date = localDate(now());
    // force 也要知道有没有临近日程：没有社交目的的联系人不该因为「手动强制」就去调模型。
    const scheduleSoon = upcomingScheduleContacts();
    const avoidance = (Array.isArray(avoid) ? avoid : [])
      .filter(title => typeof title === 'string' && title.trim()).map(title => title.trim()).slice(0, 4);
    let selected = members();
    if (contactName) {
      selected = selected.filter(member => member.name === contactName);
      if (!selected.length) return { ok: false, status: 404, error: '联系人或社交目的不存在，请刷新首页。' };
    }
    for (const member of selected) {
      const key = `${member.id}|${date}`;
      const batch = store.batch(member.id, date);
      if (inFlight.has(key)) continue;
      const interval = intervalState(member, date);
      // 目的补上之后，之前按「没填目的」存下的休息理由就过期了：当成还没生成，重新走一遍，
      // 否则首页会一直挂着一句「还没填社交目的」，而这个人其实已经有目的了。
      const staleRest = isStaleRestReason(batch, interval);
      if (batch && !force && !staleRest) continue;
      if (!force && store.actions(member.id, date).filter(action => action.status !== 'pending').length >= 2) continue;
      // 「没有社交目的」或「暂停」且没有临近日程 = 没有任何可依据的东西，手动强制也不调模型。
      if (interval.days == null && !scheduleSoon.has(member.name)) {
        const context = contextFor(member, date);
        store.rest(member.id, date, member.name, fingerprint(context),
          restReason(interval, member.id, date), new Date(now()).toISOString());
        continue;
      }
      if (!force && shouldRest(member, interval, date, scheduleSoon)) {
        const context = contextFor(member, date);
        store.rest(member.id, date, member.name, fingerprint(context),
          restReason(interval, member.id, date), new Date(now()).toISOString());
        continue;
      }
      store.queue(member.id, date, member.name, new Date(now()).toISOString());
      inFlight.add(key);
      // 换一批时要避开的标题：只避开「这个联系人自己」正在显示的那几条。
      // 全局换一批时前端会把所有人的标题混在一起发上来，直接用会让 A 去避开 B 的标题。
      const ownAvoid = contactName
        ? avoidance
        : store.actions(member.id, date).filter(action => action.status === 'pending')
          .map(action => action.title).filter(Boolean).slice(0, 4);
      queue.push({ key, memberId: member.id, date, avoid: ownAvoid });
    }
    kick();
    return { ok: true, ...list() };
  }

  function getAction(id) {
    const action = store.get(id);
    if (!action) return null;
    const member = members().find(item => item.id === action.memberId);
    if (!member) return null;
    const { memberId, ...publicAction } = action;
    return { ...publicAction, contactName: member.name };
  }

  function feedback(id, status) {
    if (!['pending', 'done', 'dismissed'].includes(status)) return { ok: false, status: 400, error: '请选择完成、今日忽略或撤销。' };
    const action = getAction(id);
    if (!action) return { ok: false, status: 404, error: '这条推荐已不存在，请刷新首页。' };
    if (action.date !== localDate(now())) return { ok: false, status: 409, error: '这不是今天的推荐，请刷新首页。' };
    if (!store.feedback(id, status, new Date(now()).toISOString())) {
      return { ok: false, status: 409, error: '推荐已更新，请刷新后再操作。' };
    }
    return { ok: true, action: { ...action, status } };
  }

  async function whenIdle() {
    while (processing) await processing;
  }

  return { list, generate, getAction, feedback, whenIdle };
}

let defaultService;
function service() {
  if (!defaultService) defaultService = createDailyActionsService({
    chatDb: require('../memory/chat-db'),
    schedules: require('../memory/stores/schedules'),
    runTask: require('../engine/client').runTask,
    getConfig: require('../lib/config').loadConfig
  });
  return defaultService;
}

module.exports = { createDailyActionsService, localDate, limitedObject, gapFor, intervalOf, effectiveGoal,
  intervalForGoal, signalsFrom, adjustInterval, recentMessageCount, shiftDate, dayDifference, INTERVAL_META,
  list: (...args) => service().list(...args), generate: (...args) => service().generate(...args),
  getAction: (...args) => service().getAction(...args), feedback: (...args) => service().feedback(...args) };
