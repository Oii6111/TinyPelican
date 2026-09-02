// 回复建议服务：复制聊天归档后，用模型引擎快速生成 3 条建议（不走 DSH Agent）。
'use strict';

const { runTask } = require('../engine/client');
const { loadConfig } = require('../lib/config');
const { log } = require('../lib/log');
const { readContact } = require('../memory/stores/contacts');
const store = require('./suggestion-store');

function latestTextMessage(contactDoc) {
  const messages = Array.isArray(contactDoc.messages) ? contactDoc.messages : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.type === 'text' && String(m.content || '').trim()) {
      return m;
    }
  }
  return null;
}

function normalizeOptions(rawArray, maxCount = 3, maxChars = 120) {
  const seen = new Set();
  const out = [];
  for (const item of Array.isArray(rawArray) ? rawArray : []) {
    if (!item || typeof item !== 'object') continue;
    const tone = String(item.tone || '').trim() || '自然';
    const text = String(item.text || '').trim();
    if (!text) continue;
    if (text.length > maxChars) continue;
    const key = text.replace(/\s+/g, '');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ tone, text });
    if (out.length >= maxCount) break;
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

async function generateReplySuggestions({ contact, targetWindow = null, config = null } = {}) {
  const cfg = config || loadConfig();
  const capture = (cfg.capture) || {};
  const rs = capture.replySuggestions || {};

  // 新复制一定会使旧建议失效（即使本次不满足生成条件）
  const old = store.getCurrent();
  if (!canSuggest({ contact, cfg })) {
    store.invalidate();
    return null;
  }

  const doc = readContact(contact);
  const latest = latestTextMessage(doc);
  if (!latest) {
    store.invalidate();
    return null;
  }

  const selfNicknames = Array.isArray(cfg.selfNicknames) ? cfg.selfNicknames : [];
  const isSelf = selfNicknames.includes(latest.name) || (selfNicknames.length === 0 && latest.name === '我');
  // 消息指纹：联系人 + 发送者 + 时间 + 类型 + 内容
  const fingerprint = [contact, latest.name, latest.ts, latest.type, latest.content].join('|');

  // 同一条消息（指纹相同）不重复生成
  if (old && old.contact === contact && (old.sourceFingerprint === fingerprint ||
      (!old.sourceFingerprint && old.sourceMessage === latest.content))) {
    return store.sanitize(old);
  }

  store.invalidate();
  const token = store.beginGeneration();
  const maxHistory = rs.maxHistoryMessages || 24;
  const history = (doc.messages || []).slice(-maxHistory);
  const profile = doc.profile || {};
  const optionCount = rs.optionCount || 3;
  const maxOptionChars = rs.maxOptionChars || 120;

  try {
    const r = await runTask('reply_suggestions', {
      contact,
      remark: doc.remark || '',
      profile,
      history,
      latestMessage: {
        text: latest.content,
        speaker: latest.name,
        isSelf,
        timestamp: latest.ts
      },
      selfNicknames,
      maxOptionChars,
      optionCount
    }, {
      config: cfg,
      timeoutMs: rs.timeoutMs || 30000
    });

    if (!store.isLatestGeneration(token)) return null;
    if (!r.ok) {
      log('warn', 'reply', '回复建议生成失败：' + (r.error || ''));
      return null;
    }

    const options = normalizeOptions(r.array, optionCount, maxOptionChars);
    if (!options.length) {
      log('warn', 'reply', '回复建议模型输出为空或无法解析');
      return null;
    }

    const expireMs = (rs.expireSeconds || 120) * 1000;
    const suggestion = {
      id: store.createId(),
      contact,
      sourceMessage: latest.content,
      sourceSpeaker: latest.name,
      sourceIsSelf: isSelf,
      sourceFingerprint: fingerprint,
      options,
      targetWindow: targetWindow && targetWindow.handle ? {
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
      } : null,
      createdAt: new Date().toISOString(),
      expiresAt: Date.now() + expireMs
    };
    store.replaceSuggestion(suggestion);
    log('info', 'reply', `已生成回复建议：${contact}（${options.length} 条）`);
    return store.sanitize(suggestion);
  } catch (e) {
    log('warn', 'reply', '回复建议生成异常：' + String((e && e.message) || e));
    return null;
  }
}

module.exports = { generateReplySuggestions, latestTextMessage, normalizeOptions, canSuggest };
