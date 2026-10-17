// 小鹈鹕核心 — WeChatChannel（iLink 长轮询双向通道）
// 入站消息回调给上层（ingest），出站走 sendmessage。
'use strict';

const { log } = require('../../lib/log');
const { WeChatClient } = require('./client');
const { readCredentials } = require('./login');
const { getContext, setContext, clearContext } = require('./context');
const { downloadItem } = require('./media');

function extractText(raw) {
  const items = (raw && Array.isArray(raw.item_list)) ? raw.item_list : [];
  const parts = [];
  for (const item of items) {
    if (!item) continue;
    if (item.type === 1 && item.text_item && typeof item.text_item.text === 'string') parts.push(item.text_item.text);
    else if (item.voice_item && typeof item.voice_item.text === 'string') parts.push(item.voice_item.text);
  }
  return parts.filter((text) => text.trim()).join('\n');
}

class WeChatChannel {
  constructor({ onMessage = () => {}, config = {}, downloadMedia = downloadItem } = {}) {
    this.onMessage = onMessage;
    this.config = config;
    this.downloadMedia = downloadMedia;
    this.client = null;
    this.running = false;
    this.consecutiveFailures = 0;
    this._pollTimer = null;
    this._stopReason = '';
  }

  get connected() {
    return !!this.client && this.running;
  }

  async connect() {
    const creds = readCredentials();
    if (!creds) {
      log('warn', 'weixin', '未找到微信登录凭据（config.toml），跳过连接；可在设置页扫码登录');
      return false;
    }
    this.client = new WeChatClient(creds);
    this.running = true;
    await this.client.notifyStart();
    this._poll();
    log('info', 'weixin', '微信通道已连接（长轮询启动）');
    return true;
  }

  _poll() {
    if (!this.running) return;
    (async () => {
      try {
        const r = await this.client.getUpdates(this._timeoutMs());
        if (!r.ok) {
          if (r.staleToken) {
            this._stop('token-invalid');
            log('error', 'weixin', 'bot_token 已失效，请在设置页重新扫码登录');
            return;
          }
          this.consecutiveFailures += 1;
          const delay = this.consecutiveFailures >= 3 ? 30000 : 2000;
          log('warn', 'weixin', `长轮询失败（${r.error}），${Math.round(delay / 1000)}s 后重试`);
          this._pollTimer = setTimeout(() => this._poll(), delay);
          return;
        }
        this.consecutiveFailures = 0;
        this._serverTimeout = r.timeoutMs || this._serverTimeout;
        for (const msg of r.msgs || []) {
          try {
            await this._handleIncoming(msg);
          } catch (error) {
            log('warn', 'weixin', '微信消息处理失败：' + String((error && error.message) || error));
          }
        }
        this._pollTimer = setTimeout(() => this._poll(), 500);
      } catch (e) {
        log('error', 'weixin', '长轮询异常：' + (e && e.message ? e.message : e));
        this._pollTimer = setTimeout(() => this._poll(), 5000);
      }
    })();
  }

  _timeoutMs() {
    return this._serverTimeout || 35000;
  }

  async _handleIncoming(raw) {
    // 群聊不支持：记录并跳过，避免误回
    if (raw && raw.group_id) {
      log('info', 'weixin', '收到群聊消息，iLink 通道暂不支持，已跳过');
      return;
    }
    const from = raw && (raw.from_user_id || raw.from_user);
    const ctx = raw && raw.context_token;
    const text = extractText(raw);
    if (!from) return;
    if (ctx) setContext(this.client.accountId, from, ctx);
    const attachments = [];
    for (const item of (raw && Array.isArray(raw.item_list)) ? raw.item_list : []) {
      if (!item || ![2, 4].includes(item.type)) continue;
      try {
        attachments.push(await this.downloadMedia(item, {
          cdnBaseUrl: (this.config.weixin || {}).cdnBaseUrl
        }));
      } catch (error) {
        const kind = item.type === 2 ? 'image' : 'file';
        attachments.push({
          kind,
          name: kind === 'image' ? '图片' : String((item.file_item && item.file_item.file_name) || '文件'),
          status: 'failed',
          error: '附件下载失败，请重新发送。'
        });
        log('warn', 'weixin', '微信附件下载失败：' + String((error && error.message) || error));
      }
    }
    if (!text && !attachments.length) return;
    const content = text || attachments.map((attachment) =>
      `[${attachment.kind === 'image' ? '图片' : '文件'}] ${attachment.name || ''}${attachment.status === 'failed' ? '（下载失败，请重新发送）' : ''}`.trim()
    ).join('\n');
    // 主人（扫码绑定的微信）给 bot 发消息也要触发自动回复；
    // 否则主人无法在微信里直接与 bot 对话。
    Promise.resolve().then(() => this.onMessage({
      channel: 'weixin',
      from,
      name: (raw && (raw.from_user_name || raw.from_user_nickname)) || from,
      ts: new Date().toISOString().slice(0, 16).replace('T', ' '),
      type: attachments.length ? (text || attachments.length > 1 ? 'mixed' : attachments[0].kind) : 'text',
      content,
      attachments,
      contextToken: ctx || ''
    })).catch((error) => {
      log('warn', 'weixin', '微信消息处理失败：' + String((error && error.message) || error));
    });
  }

  async send({ to, text, attachment = null, contextToken = '' }) {
    if (!this.client) return { ok: false, error: '微信通道未连接' };
    const ctx = contextToken || getContext(this.client.accountId, to);
    if (!ctx) return { ok: false, error: '缺少 context_token（对方尚未与 bot 建立会话，无法主动发送）' };
    const r = attachment
      ? await this.client.sendMedia(to, attachment, ctx, { text })
      : await this.client.sendText(to, text, ctx);
    if (!r.ok && r.staleToken && getContext(this.client.accountId, to) === ctx) clearContext(this.client.accountId, to);
    return r;
  }

  _stop(reason) {
    this.running = false;
    this._stopReason = reason || 'stopped';
    if (this._pollTimer) clearTimeout(this._pollTimer);
    this.client && this.client.notifyStop().catch(() => {});
  }

  stop() {
    if (!this.running) return;
    this._stop('user-stop');
    log('info', 'weixin', '微信通道已停止');
  }
}

module.exports = { WeChatChannel, extractText };
