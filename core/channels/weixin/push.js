// 小鹈鹕核心 — 微信主动推送（提醒/问候/意图通知统一走这里）
'use strict';

const { log } = require('../../lib/log');
const { WeChatClient } = require('./client');
const { readCredentials } = require('./login');
const { getContext } = require('./context');

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
    log('error', 'weixin', '推送失败：' + r.error);
    return false;
  }
  log('info', 'weixin', '已推送微信：' + String(message).slice(0, 40));
  return true;
}

module.exports = { pushToUser };
