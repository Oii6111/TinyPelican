// 回复建议服务：复制聊天归档后，用模型引擎快速生成多组「连贯消息方案」（不走 DSH Agent）。
// 一组方案 = 按发送顺序排列的 1~N 条短消息；支持「换一批」和「按用户描述重写」。
'use strict';

const { runTask } = require('../engine/client');
const { loadConfig } = require('../lib/config');
const { log } = require('../lib/log');
const chatDb = require('../memory/chat-db');
const store = require('./suggestion-store');

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.floor(n), min), max);
}

// chatDb 的历史行发件人字段是 sender，legacy/搜索结果是 name —— 统一成 { name, ts, type, content }，
// 免得下游（提示词）读错字段把「谁说的」丢掉。
function normalizeMessage(m) {
  return {
    name: String((m && (m.name || m.sender || m.senderName)) || ''),
    ts: String((m && (m.ts || m.timestamp)) || ''),
    type: String((m && m.type) || 'text'),
    content: String((m && m.content) || '')
  };
}

function latestTextMessage(contactDoc) {
  const messages = Array.isArray(contactDoc?.recentMessages)
    ? contactDoc.recentMessages
    : (Array.isArray(contactDoc?.messages) ? contactDoc.messages : []);
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.type === 'text' && String(m.content || '').trim()) {
      return normalizeMessage(m);
    }
  }
  return null;
}

// 模型输出 -> 方案列表：[{ tone, messages: ['第一条', '第二条'] }]
// 兼容旧的单条格式 { tone, text }（视为只有一条消息的方案）。
function normalizePlans(rawArray, { planCount = 3, maxMessagesPerPlan = 3, maxChars = 120 } = {}) {
  const itemLimit = clampInt(planCount, 1, 6, 3);
  const messageLimit = clampInt(maxMessagesPerPlan, 1, 6, 3);
  const seen = new Set();
  const out = [];

  for (const item of Array.isArray(rawArray) ? rawArray : []) {
    if (!item || typeof item !== 'object') continue;
    const tone = String(item.tone || item.label || '').trim() || '自然';
    const rawMessages = Array.isArray(item.messages) ? item.messages
      : (Array.isArray(item.texts) ? item.texts : [item.text]);

    const messages = [];
    for (const raw of rawMessages) {
      if (typeof raw !== 'string' && typeof raw !== 'number') continue;
      const text = String(raw).replace(/\s+/g, ' ').trim();
      if (!text || text.length > maxChars) continue;
      messages.push(text);
      if (messages.length >= messageLimit) break;
    }
    if (!messages.length) continue;

    const key = messages.join('\u0001');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ tone, messages });
    if (out.length >= itemLimit) break;
  }
  return out;
}

function canSuggest({ contact, cfg }) {
  const capture = (cfg && cfg.capture) || {};
  const rs = capture.replySuggestions || {};
  if (!capture.enabled || rs.enabled === false) return false;
  if (!contact) return false;
  return true;
}

function historicalContext(contact, latestText, limit = 8) {
  const terms = String(latestText || '').match(/[\u4e00-\u9fff]{2,}|[A-Za-z0-9]{3,}/g) || [];
  const unique = [...new Set(terms)].slice(0, 4);
  const rows = [];
  for (const term of unique) rows.push(...chatDb.searchMessages(term, { contact, limit: 3 }));
  const seen = new Set();
  return rows.filter((row) => { const key = `${row.ts}|${row.name}|${row.content}`; if (seen.has(key)) return false; seen.add(key); return true; }).slice(-limit);
}

function normalizeTargetWindow(targetWindow) {
  if (!targetWindow || !targetWindow.handle) return null;
  return {
    handle: String(targetWindow.handle),
    pid: targetWindow.pid ? String(targetWindow.pid) : null,
    processName: targetWindow.processName || null,
    bounds: targetWindow.bounds ? {
      left: Number(targetWindow.bounds.left),
      top: Number(targetWindow.bounds.top),
      right: Number(targetWindow.bounds.right),
      bottom: Number(targetWindow.bounds.bottom)
    } : null,
    dpi: Number(targetWindow.dpi) || 0
  };
}

function planTexts(plans) {
  return (plans || []).map((p) => (p.messages || []).join(' / ')).filter(Boolean);
}

// 快速模式（默认，关思考）与深度思考模式的消息条数/长度/超时上限：
// 快速模式限 4 条以内、每条短；深度思考放开到 8 条、每条也能更长，但更慢。
function limitsFor(rs, deep) {
  const planCount = clampInt(rs.optionCount, 1, 4, 3);
  if (deep) {
    const maxMessageChars = clampInt(rs.deepMaxMessageChars, 8, 400, 120);
    return {
      planCount,
      maxMessagesPerPlan: clampInt(rs.deepMaxMessagesPerPlan, 1, 12, 8),
      maxMessageChars,
      maxChars: clampInt(rs.deepMaxOptionChars, 20, 2000, 600),
      timeoutMs: clampInt(rs.deepTimeoutMs, 5000, 600000, 120000)
    };
  }
  const maxChars = clampInt(rs.maxOptionChars, 20, 400, 120);
  return {
    planCount,
    maxMessagesPerPlan: clampInt(rs.maxMessagesPerPlan, 1, 12, 4),
    maxMessageChars: clampInt(rs.maxMessageChars, 8, maxChars, Math.min(40, maxChars)),
    maxChars,
    timeoutMs: clampInt(rs.timeoutMs, 5000, 600000, 30000)
  };
}

// 生成/重新生成建议。
//  - 普通路径：contact + targetWindow 来自新复制的聊天；
//  - hint：用户自己描述想表达什么，按描述重写；
//  - rotate：换一批（同一上下文重新生成，避开已给过的说法）；
//  - deep：深度思考模式（打开模型思考过程，条数与字数上限也放开）。
async function generateReplySuggestions({
  contact = '',
  targetWindow = null,
  config = null,
  hint = '',
  rotate = false,
  deep = false
} = {}) {
  const cfg = config || loadConfig();
  const capture = (cfg.capture) || {};
  const rs = capture.replySuggestions || {};
  const userHint = String(hint || '').trim();
  const rewrite = !!userHint || !!rotate;
  const expireMs = clampInt(rs.expireSeconds, 30, 3600, 300) * 1000;

  const old = store.getCurrent();
  let ctx;
  let target = normalizeTargetWindow(targetWindow);

  if (rewrite) {
    // 换一批 / 按描述重写：复用上一批建议的上下文，不重新读剪贴板。
    if (!old || !old.context) return { ok: false, error: '没有可以重新生成的建议' };
    if (!canSuggest({ contact: old.contact, cfg })) {
      store.invalidate();
      return { ok: false, error: '回复建议已关闭' };
    }
    const base = old.context;
    target = old.targetWindow || null;
    ctx = {
      contact: base.contact,
      remark: base.remark,
      profile: base.profile,
      socialGoal: base.socialGoal,
      history: base.history,
      olderConversationContext: base.olderConversationContext,
      latestMessage: base.latestMessage,
      selfNicknames: base.selfNicknames,
      sourceFingerprint: base.sourceFingerprint,
      avoid: base.avoid || []
    };
  } else {
    if (!canSuggest({ contact, cfg })) {
      store.invalidate();
      return { ok: false, error: '未启用回复建议或没有识别到联系人' };
    }
    const maxHistory = clampInt(rs.maxHistoryMessages, 6, 40, 16);
    const doc = chatDb.contactContext(contact, { limit: maxHistory });
    if (!doc) {
      store.invalidate();
      return { ok: false, error: '没有找到该联系人的聊天记录' };
    }
    const latest = latestTextMessage(doc);
    if (!latest) {
      store.invalidate();
      return { ok: false, error: '最近没有可回复的文本消息' };
    }

    const selfNicknames = Array.isArray(cfg.selfNicknames) ? cfg.selfNicknames : [];
    const isSelf = selfNicknames.includes(latest.name) || (selfNicknames.length === 0 && latest.name === '我');
    // 消息指纹：联系人 + 发送者 + 时间 + 类型 + 内容
    const fingerprint = [contact, latest.name, latest.ts, latest.type, latest.content].join('|');

    // 同一条消息（指纹相同）不重复生成
    if (old && old.contact === contact &&
        (old.sourceFingerprint === fingerprint || (!old.sourceFingerprint && old.sourceMessage === latest.content))) {
      // 用户又复制了一次同一段聊天：把既有建议原样还给浮窗（收起过也能重新弹出来），
      // 顺便刷新定位（可能换了窗口）与有效期；这样重复复制不会多花一次模型调用。
      store.reshow(old.id, { targetWindow: target, expiresAt: Date.now() + expireMs });
      log('info', 'reply', `同一段聊天再次复制，重新显示既有的 ${old.plans?.length || 0} 组建议：${contact}`);
      return { ok: true, suggestion: store.sanitize(store.getCurrent()), cached: true };
    }

    const profile = doc.profile || {};
    const socialGoal = doc.socialGoal || profile.socialGoal || profile.social_goal || profile.goal || '';
    ctx = {
      contact,
      remark: doc.remark || '',
      profile,
      socialGoal,
      history: (doc.recentMessages || []).slice(-maxHistory).map(normalizeMessage),
      olderConversationContext: historicalContext(contact, latest.content, rs.maxHistoricalMessages || 8),
      latestMessage: {
        text: latest.content,
        speaker: latest.name,
        isSelf,
        timestamp: latest.ts
      },
      selfNicknames,
      sourceFingerprint: fingerprint,
      avoid: []
    };
  }

  // 新复制：旧建议立刻失效，避免用户看到过期建议；
  // 换一批/按描述重写：保留当前卡片到新方案返回，期间卡片显示“正在重写”。
  if (!rewrite) store.invalidate();
  const token = store.beginGeneration();

  const lim = limitsFor(rs, deep);
  const { planCount, maxMessagesPerPlan, maxChars, maxMessageChars } = lim;

  // 先把「生成中」挂出去：浮窗能立刻显示出来并放上「思考中」，不用等模型返回。
  store.setPending({
    contact: ctx.contact,
    sourceMessage: ctx.latestMessage?.text || '',
    sourceSpeaker: ctx.latestMessage?.speaker || '',
    sourceIsSelf: !!ctx.latestMessage?.isSelf,
    mode: deep ? 'deep' : 'fast',
    hint: userHint,
    targetWindow: target
  });

  try {
    const r = await runTask('reply_suggestions', {
      ...ctx,
      userHint,
      planCount,
      maxMessagesPerPlan,
      maxMessageChars
    }, {
      config: cfg,
      timeoutMs: lim.timeoutMs,
      // thinking: false = 关掉模型思考（快速模式默认）；深度思考模式才打开
      thinking: !!deep
    });

    if (!store.isLatestGeneration(token)) return { ok: false, error: '建议已被更新的聊天覆盖' };
    if (!r.ok) {
      store.clearPending();
      log('warn', 'reply', '回复建议生成失败：' + (r.error || ''));
      return { ok: false, error: r.error || '模型调用失败' };
    }

    const plans = normalizePlans(r.array, { planCount, maxMessagesPerPlan, maxChars });
    if (!plans.length) {
      store.clearPending();
      log('warn', 'reply', '回复建议模型输出为空或无法解析');
      return { ok: false, error: '模型没有给出可用的建议' };
    }

    const nextAvoid = [...(ctx.avoid || []), ...planTexts(plans)].slice(-12);
    const suggestion = {
      id: store.createId(),
      contact: ctx.contact,
      sourceMessage: ctx.latestMessage.text,
      sourceSpeaker: ctx.latestMessage.speaker,
      sourceIsSelf: !!ctx.latestMessage.isSelf,
      sourceFingerprint: ctx.sourceFingerprint,
      hint: userHint,
      plans,
      activePlan: null,
      showToken: 1,
      context: { ...ctx, avoid: nextAvoid },
      targetWindow: target,
      createdAt: new Date().toISOString(),
      expiresAt: Date.now() + expireMs
    };
    store.replaceSuggestion(suggestion);
    const total = plans.reduce((n, p) => n + p.messages.length, 0);
    log('info', 'reply', `已生成回复建议：${ctx.contact}（${plans.length} 组 / ${total} 条${userHint ? '，按用户描述' : rotate ? '，换一批' : ''}${deep ? '，深度思考' : ''}）`);
    return { ok: true, suggestion: store.sanitize(suggestion) };
  } catch (e) {
    store.clearPending();
    log('warn', 'reply', '回复建议生成异常：' + String((e && e.message) || e));
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// 顺序发送中「换一批」：只重写这一组还没发出去的那几条。
// 关键是把用户已经发出去的几条带进提示词，否则续写会和已发内容语境割裂。
async function regenerateRemaining({ deep = false, config = null } = {}) {
  const cfg = config || loadConfig();
  const rs = (cfg.capture && cfg.capture.replySuggestions) || {};

  const s = store.getCurrent();
  if (!s || !s.context) return { ok: false, error: '没有可以重写的建议' };
  if (!canSuggest({ contact: s.contact, cfg })) return { ok: false, error: '回复建议已关闭' };

  const active = s.activePlan;
  if (!active || !(active.remaining || []).length) return { ok: false, error: '当前不在顺序发送中' };

  const lim = limitsFor(rs, deep);
  const sent = (active.sent || []).slice();
  // 已经试过的「剩下的几条」也算不要重复
  const avoid = [...(active.avoid || []), active.remaining.join(' / ')].filter(Boolean);

  const token = store.beginGeneration();
  store.setPending({
    contact: s.contact,
    sourceMessage: s.sourceMessage,
    sourceSpeaker: s.sourceSpeaker,
    sourceIsSelf: s.sourceIsSelf,
    mode: deep ? 'deep' : 'fast',
    hint: '',
    targetWindow: s.targetWindow
  });

  try {
    const r = await runTask('reply_followup', {
      ...s.context,
      sent,
      avoid,
      maxMessagesPerPlan: lim.maxMessagesPerPlan,
      maxMessageChars: lim.maxMessageChars
    }, {
      config: cfg,
      timeoutMs: lim.timeoutMs,
      thinking: !!deep
    });

    if (!store.isLatestGeneration(token)) return { ok: false, error: '建议已被更新的聊天覆盖' };
    if (!r.ok) {
      store.clearPending();
      log('warn', 'reply', '续写剩余消息失败：' + (r.error || ''));
      return { ok: false, error: r.error || '模型调用失败' };
    }

    const plans = normalizePlans(r.array, { planCount: 1, maxMessagesPerPlan: lim.maxMessagesPerPlan, maxChars: lim.maxChars });
    if (!plans.length) {
      store.clearPending();
      log('warn', 'reply', '续写剩余消息为空或无法解析');
      return { ok: false, error: '模型没有给出可用的续写' };
    }

    store.clearPending();
    store.replaceRemaining(s.id, plans[0].messages, avoid);
    log('info', 'reply', `已重写「${s.contact}」剩余的 ${plans[0].messages.length} 条消息（已发 ${sent.length} 条作为上下文）${deep ? '，深度思考' : ''}`);
    return { ok: true, suggestion: store.sanitize(store.getCurrent()) };
  } catch (e) {
    store.clearPending();
    log('warn', 'reply', '续写剩余消息异常：' + String((e && e.message) || e));
    return { ok: false, error: String((e && e.message) || e) };
  }
}

module.exports = {
  generateReplySuggestions,
  regenerateRemaining,
  latestTextMessage,
  normalizeMessage,
  normalizePlans,
  canSuggest,
  historicalContext
};
