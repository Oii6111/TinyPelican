// 小鹈鹕核心 — WebUI 登录鉴权
// 会话使用内存 token + HttpOnly Cookie；进程重启后需重新登录。
'use strict';

const crypto = require('crypto');

const COOKIE_NAME = 'xtp_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const sessions = new Map();

function isEnabled(cfg) {
  return !!(cfg && cfg.auth && cfg.auth.enabled && cfg.auth.password);
}

function hash(s) {
  return crypto.createHash('sha256').update(String(s || '')).digest('hex');
}

function safeEqual(a, b) {
  const ha = hash(a);
  const hb = hash(b);
  const ba = Buffer.from(ha);
  const bb = Buffer.from(hb);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function verify({ username = '', password = '' } = {}, cfg) {
  const a = cfg && cfg.auth;
  if (!a || !a.password) return false;
  if (!safeEqual(username, a.username || '')) return false;
  return safeEqual(password, a.password);
}

function createSession(username) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, {
    username,
    expiresAt: Date.now() + SESSION_TTL_MS
  });
  return token;
}

function getSession(token) {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() > s.expiresAt) {
    sessions.delete(token);
    return null;
  }
  return s;
}

function destroySession(token) {
  if (token) sessions.delete(token);
}

function tokenFromRequest(req) {
  const cookie = req.headers.cookie || '';
  for (const part of cookie.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (name === COOKIE_NAME && value) return decodeURIComponent(value);
  }
  return '';
}

function checkRequest(req) {
  return !!getSession(tokenFromRequest(req));
}

function sessionCookie(token) {
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`;
}

function clearCookie() {
  return `${COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`;
}

module.exports = {
  isEnabled,
  verify,
  createSession,
  getSession,
  destroySession,
  checkRequest,
  sessionCookie,
  clearCookie,
  COOKIE_NAME
};
