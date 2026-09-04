// 小鹈鹕核心 — 微信 iLink 协议客户端
// 依据腾讯官方 openclaw-weixin（iLink）HTTP 协议实现：扫码登录、长轮询收消息、发送文本。
// 协议基线 2.4.6；错误处理遵循官方语义（-14 = token 失效）。
'use strict';

const crypto = require('crypto');
const { getPaths } = require('../../lib/paths');
const { readJson, writeJson } = require('../../lib/store');

const DEFAULT_ENTRY = 'https://ilinkai.weixin.qq.com';
const APP_CLIENT_VERSION = '132102'; // 2.4.6 对应版本号
const CHANNEL_VERSION = '2.4.6';
const BOT_AGENT = 'xiaotihu-v3/0.3.0 (node)';
const P = getPaths();

// X-WECHAT-UIN：随机 uint32 转十进制字符串后 base64，每次 POST 重新生成
function randUinHeader() {
  return Buffer.from(String(crypto.randomBytes(4).readUInt32BE(0)), 'utf8').toString('base64');
}

function commonHeaders({ token = '' } = {}) {
  const h = {
    'Content-Type': 'application/json',
    'iLink-App-Id': 'bot',
    'iLink-App-ClientVersion': APP_CLIENT_VERSION
  };
  if (token) {
    h.AuthorizationType = 'ilink_bot_token';
    h['X-WECHAT-UIN'] = randUinHeader();
    h.Authorization = `Bearer ${token}`;
  }
  return h;
}

function baseInfo() {
  return { channel_version: CHANNEL_VERSION, bot_agent: BOT_AGENT };
}

class WeChatClient {
  constructor(creds = {}) {
    this.token = creds.bot_token || creds.botToken || '';
    this.accountId = creds.account_id || creds.ilink_bot_id || '';
    this.userId = creds.user_id || creds.ilink_user_id || '';
    this.baseUrl = String(creds.base_url || creds.baseUrl || '').replace(/\/+$/, '');
    this.cursor = '';
    this.typingTickets = new Map();
    this._loadCursor();
  }

  async _post(pathname, body, { token = this.token, timeoutMs = 15000, base = null } = {}) {
    const url = (base || this.baseUrl || DEFAULT_ENTRY) + pathname;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: commonHeaders({ token }),
        body: JSON.stringify(body),
        signal: ctrl.signal
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, data };
      return { ok: true, data };
    } catch (e) {
      return { ok: false, error: String(e.message || e), data: null };
    } finally {
      clearTimeout(timer);
    }
  }

  async _get(pathname, { timeoutMs = 35000, base = null } = {}) {
    const url = (base || this.baseUrl || DEFAULT_ENTRY) + pathname;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { method: 'GET', headers: commonHeaders(), signal: ctrl.signal });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, data };
      return { ok: true, data };
    } catch (e) {
      return { ok: false, error: String(e.message || e), data: null };
    } finally {
      clearTimeout(timer);
    }
  }

  // ---------- 登录 ----------
  async getQrcode(localTokenList = []) {
    const r = await this._post('/ilink/bot/get_bot_qrcode?bot_type=3', {
      local_token_list: Array.isArray(localTokenList) ? localTokenList.slice(0, 10) : []
    }, { token: '', base: DEFAULT_ENTRY });
    if (!r.ok) return r;
    if (!r.data.qrcode) return { ok: false, error: 'iLink 未返回二维码标识' };
    return { ok: true, qrcode: r.data.qrcode, qrcodeUrl: r.data.qrcode_img_content || '' };
  }

  async getQrcodeStatus(qrcode, verifyCode = '') {
    let pathname = `/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
    if (verifyCode) pathname += `&verify_code=${encodeURIComponent(verifyCode)}`;
    const r = await this._get(pathname, { timeoutMs: 35000 });
    if (!r.ok) return r;
    return { ok: true, ...r.data };
  }

  // ---------- 消息 ----------
  async getUpdates(timeoutMs = 35000) {
    const r = await this._post('/ilink/bot/getupdates', {
      get_updates_buf: this.cursor,
      base_info: baseInfo()
    }, { timeoutMs });
    if (!r.ok) return r;
    const d = r.data;
    if ((d.ret !== undefined && d.ret !== 0) || (d.errcode !== undefined && d.errcode !== 0)) {
      return {
        ok: false,
        error: `iLink ret=${d.ret} errcode=${d.errcode} errmsg=${d.errmsg || ''}`,
        staleToken: d.ret === -14 || d.errcode === -14,
        data: d
      };
    }
    // 只在成功且新游标非空时替换并持久化
    if (d.get_updates_buf) {
      this.cursor = d.get_updates_buf;
      this._saveCursor();
    }
    return { ok: true, msgs: d.msgs || [], timeoutMs: d.longpolling_timeout_ms || 35000, data: d };
  }

  async sendText(toUserId, text, contextToken, { clientId = null } = {}) {
    const msg = {
      from_user_id: '',
      to_user_id: toUserId,
      client_id: clientId || `xiaotihu-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      message_type: 2,
      message_state: 2,
      context_token: contextToken,
      item_list: [{ type: 1, text_item: { text: String(text) } }]
    };
    const r = await this._post('/ilink/bot/sendmessage', { msg, base_info: baseInfo() }, { timeoutMs: 15000 });
    if (!r.ok) return r;
    const d = r.data;
    if (d.ret !== undefined && d.ret !== 0) {
      // -14 是登录态失效；ret=-2 + prepare failed 在 iLink 中通常代表 context_token
      // 过期/不可用（不是限流），需要用户重新给 bot 发消息刷新。
      const stale = d.ret === -14 || (d.ret === -2 && /prepare failed/i.test(String(d.errmsg || '')));
      return { ok: false, error: `sendmessage ret=${d.ret} errmsg=${d.errmsg || ''}`, staleToken: stale, data: d };
    }
    return { ok: true, data: d };
  }

  async getConfig(ilinkUserId, contextToken = '') {
    const r = await this._post('/ilink/bot/getconfig', {
      ilink_user_id: ilinkUserId,
      context_token: contextToken,
      base_info: baseInfo()
    }, { timeoutMs: 10000 });
    if (!r.ok) return r;
    return { ok: true, typingTicket: r.data.typing_ticket || '' };
  }

  async sendTyping(ilinkUserId, typingTicket, status) {
    return this._post('/ilink/bot/sendtyping', {
      ilink_user_id: ilinkUserId,
      typing_ticket: typingTicket,
      status,
      base_info: baseInfo()
    }, { timeoutMs: 10000 });
  }

  async notifyStart() {
    return this._post('/ilink/bot/msg/notifystart', { base_info: baseInfo() }, { timeoutMs: 10000 });
  }

  async notifyStop() {
    return this._post('/ilink/bot/msg/notifystop', { base_info: baseInfo() }, { timeoutMs: 10000 });
  }

  // ---------- 游标持久化（重启续传） ----------
  _loadCursor() {
    const st = readJson(P.weixinCursor, {});
    if (st && st.accountId === this.accountId && st.cursor) this.cursor = st.cursor;
  }

  _saveCursor() {
    writeJson(P.weixinCursor, {
      accountId: this.accountId,
      cursor: this.cursor,
      updatedAt: new Date().toISOString()
    });
  }
}

module.exports = { WeChatClient, DEFAULT_ENTRY, commonHeaders, baseInfo };
