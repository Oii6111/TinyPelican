// 小鹈鹕核心 — 微信扫码登录状态机
// 看板流程：start（拿二维码）→ check（轮询状态）→ confirm（写凭据 + 触发重启）。
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const { getPaths } = require('../../lib/paths');
const { stringifyToml, parseToml } = require('../../lib/toml');
const { WeChatClient } = require('./client');

const P = getPaths();
const SESSION_TTL_MS = 10 * 60 * 1000;
const sessions = new Map();

function readCredentials() {
  try {
    if (!fs.existsSync(P.configToml)) return null;
    const t = parseToml(fs.readFileSync(P.configToml, 'utf8'));
    const w = t.weixin || {};
    if (!w.bot_token) return null;
    return {
      bot_token: w.bot_token,
      account_id: w.account_id || '',
      base_url: w.base_url || '',
      user_id: w.user_id || ''
    };
  } catch {
    return null;
  }
}

function saveCredentials(creds) {
  fs.mkdirSync(P.dataDir, { recursive: true });
  const body = stringifyToml({
    weixin: {
      bot_token: creds.bot_token,
      account_id: creds.account_id || '',
      base_url: creds.base_url || '',
      user_id: creds.user_id || ''
    }
  });
  const tmp = P.configToml + '.tmp';
  fs.writeFileSync(tmp, body, 'utf8');
  fs.renameSync(tmp, P.configToml);
}

function clearCredentials() {
  try {
    if (fs.existsSync(P.configToml)) fs.unlinkSync(P.configToml);
  } catch {}
}

function startLogin() {
  const key = 'wxlogin_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex');
  const creds = readCredentials();
  const session = {
    key,
    client: new WeChatClient(),
    localTokens: creds ? [creds.bot_token] : [],
    qrcode: '',
    status: 'waiting',
    verifyCode: '',
    confirmedCreds: null,
    reuse: false,
    expiresAt: Date.now() + SESSION_TTL_MS
  };
  sessions.set(key, session);
  return key;
}

function getSession(key) {
  const s = sessions.get(key);
  if (!s) return null;
  if (Date.now() > s.expiresAt) {
    sessions.delete(key);
    return null;
  }
  return s;
}

// 第一步：调 iLink 拿二维码
async function stepStart(key) {
  const s = getSession(key);
  if (!s) return { ok: false, error: '登录会话不存在或已过期' };
  const r = await s.client.getQrcode(s.localTokens);
  if (!r.ok) return r;
  s.qrcode = r.qrcode;
  s.status = 'waiting';
  return { ok: true, sessionKey: key, qrcodeUrl: r.qrcodeUrl };
}

// 第二步：轮询扫码状态
async function stepCheck(key) {
  const s = getSession(key);
  if (!s) return { ok: false, error: '登录会话不存在或已过期' };
  if (!s.qrcode) return { ok: false, error: '尚未获取二维码' };
  const r = await s.client.getQrcodeStatus(s.qrcode, s.verifyCode || '');
  if (!r.ok) return r;
  const status = r.status || 'wait';
  s.status = status;
  switch (status) {
    case 'wait':
      return { ok: true, status: 'waiting' };
    case 'scaned':
      return { ok: true, status: 'scanned' };
    case 'need_verifycode':
      return { ok: true, status: 'need_verifycode' };
    case 'verify_code_blocked':
      return { ok: true, status: 'verify_code_blocked' };
    case 'scaned_but_redirect':
      if (r.redirect_host) s.client.baseUrl = 'https://' + r.redirect_host;
      return { ok: true, status: 'redirecting' };
    case 'binded_redirect':
      // 已绑定本客户端：有本地凭据就算完成，没有则继续等
      if (readCredentials()) {
        s.reuse = true;
        return { ok: true, status: 'confirmed', reuse: true };
      }
      return { ok: true, status: 'waiting' };
    case 'expired':
      return { ok: true, status: 'expired' };
    case 'confirmed':
      s.confirmedCreds = {
        bot_token: r.bot_token,
        account_id: r.ilink_bot_id,
        user_id: r.ilink_user_id,
        base_url: r.baseurl
      };
      return { ok: true, status: 'confirmed' };
    default:
      return { ok: true, status };
  }
}

// 第三步：确认登录 -> 凭据写入 config.toml
async function stepConfirm(key) {
  const s = getSession(key);
  if (!s) return { ok: false, error: '登录会话不存在或已过期' };
  if (s.reuse) {
    const creds = readCredentials();
    if (!creds) return { ok: false, error: '没有可复用的登录凭据' };
    sessions.delete(key);
    return { ok: true, status: 'confirmed', reuse: true };
  }
  if (!s.confirmedCreds) return { ok: false, error: '尚未扫码确认，不能登录' };
  saveCredentials(s.confirmedCreds);
  sessions.delete(key);
  return { ok: true, status: 'confirmed' };
}

module.exports = { startLogin, stepStart, stepCheck, stepConfirm, readCredentials, saveCredentials, clearCredentials };
