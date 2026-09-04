// 小鹈鹕核心 — 微信主动推送（提醒/问候/意图通知统一走这里）
'use strict';

const { log } = require('../../lib/log');
const { WeChatClient } = require('./client');
const { readCredentials } = require('./login');
const { getContext, getContextInfo, clearContext } = require('./context');

async function pushToUser(message, opts = {}) {
  const creds = readCredentials();
  if (!creds) {
    log('warn', 'weixin', '微信通道未登录，跳过推送：' + String(message).slice(0, 40));
    return false;
  }
  const target = creds.user_id;
  if (!target) {
    log('warn', 'weixin', '缺少扫码用户 ID，无法推送');
    return false;
  }
  const client = new WeChatClient(creds);
  const ctx = getContext(client.accountId, target);
  if (!ctx) {
    log('warn', 'weixin', '尚未获得自己的 context_token（先给 bot 发一条消息即可获得），跳过推送');
    return false;
  }
  const r = await client.sendText(target, message, ctx);
  if (!r.ok) {
    if (r.staleToken) {
      clearContext(client.accountId, target);
      log('warn', 'weixin', 'context_token 已失效，已清除本地 token；需要用户给 bot 发一条消息后重新激活主动推送');
    } else {
      log('error', 'weixin', '推送失败：' + r.error);
    }
    return false;
  }
  log('info', 'weixin', '已推送微信：' + String(message).slice(0, 40));
  return true;
}

// 看板状态：是否具备“主动推送”能力。iLink 的 context_token 只能由用户入站消息刷新。
function pushStatus() {
  const creds = readCredentials();
  if (!creds) {
    return { configured: false, ready: false, reason: '微信通道未登录', updatedAt: null };
  }
  const target = creds.user_id;
  if (!target) {
    return { configured: false, ready: false, reason: '缺少扫码用户 ID', updatedAt: null };
  }
  const client = new WeChatClient(creds);
  const info = getContextInfo(client.accountId, target);
  if (!info.token) {
    return {
      configured: true,
      ready: false,
      reason: '主动推送已失效：请在微信里给 bot 发一条消息重新激活',
      updatedAt: info.updatedAt
    };
  }
  return {
    configured: true,
    ready: true,
    reason: '',
    updatedAt: info.updatedAt
  };
}

module.exports = { pushToUser, pushStatus };
