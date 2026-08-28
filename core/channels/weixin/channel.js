// 小鹈鹕核心 — WeChatChannel（iLink 长轮询双向通道）
// 入站消息回调给上层（ingest），出站走 sendmessage。
'use strict';

const { log } = require('../../lib/log');
const { WeChatClient } = require('./client');
const { readCredentials } = require('./login');
const { getContext, setContext } = require('./context');

function extractText(raw) {
  const items = (raw && Array.isArray(raw.item_list)) ? raw.item_list : [];
  for (const item of items) {
    if (!item) continue;
    if (item.type === 1 && item.text_item && typeof item.text_item.text === 'string') return item.text_item.text;
    if (item.voice_item && typeof item.voice_item.text === 'string') return item.voice_item.text;
  }
  return '';
}

class WeChatChannel {
  constructor({ onMessage = () => {}, config = {} } = {}) {
    this.onMessage = onMessage;
    this.config = config;
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
        for (const msg of r.msgs || []) this._handleIncoming(msg);
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

  _handleIncoming(raw) {
    // 群聊不支持：记录并跳过，避免误回
    if (raw && raw.group_id) {
      log('info', 'weixin', '收到群聊消息，iLink 通道暂不支持，已跳过');
      return;
    }
    const from = raw && (raw.from_user_id || raw.from_user);
    const ctx = raw && raw.context_token;
    const text = extractText(raw);
    if (!from || !text) return;
    if (ctx) setContext(this.client.accountId, from, ctx);
    // 自己（bot 主人）发来的消息不需要归档
    if (this.client.userId && from === this.client.userId) return;
    this.onMessage({
      channel: 'weixin',
      from,
      name: (raw && (raw.from_user_name || raw.from_user_nickname)) || from,
      ts: new Date().toISOString().slice(0, 16).replace('T', ' '),
      type: 'text',
      content: text,
      contextToken: ctx || ''
    });
  }

  async send({ to, text, contextToken = '' }) {
    if (!this.client) return { ok: false, error: '微信通道未连接' };
    const ctx = contextToken || getContext(this.client.accountId, to);
    if (!ctx) return { ok: false, error: '缺少 context_token（对方尚未与 bot 建立会话，无法主动发送）' };
    return this.client.sendText(to, text, ctx);
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
