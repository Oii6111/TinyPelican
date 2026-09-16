// 小鹈鹕核心 — WebUI 登录鉴权
// 会话 token + HttpOnly Cookie。会话落盘到数据目录（sessions.json）：
// 保存配置会让核心热重启，会话若只在内存里，重启后看板/桌面端会静默变“未登录”
// （表现就是下一次「保存策略」报 unauthorized）。过期会话在载入时清理。
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { getPaths } = require('./lib/paths');

const COOKIE_NAME = 'xtp_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function sessionsFile() {
  return getPaths().sessions;
}

function loadSessions() {
  const map = new Map();
  try {
    const raw = JSON.parse(fs.readFileSync(sessionsFile(), 'utf8'));
    const now = Date.now();
    for (const [token, value] of Object.entries(raw || {})) {
      if (!value || !(Number(value.expiresAt) > now)) continue;
      map.set(token, { username: String(value.username || ''), expiresAt: Number(value.expiresAt) });
    }
  } catch {}
  return map;
}

let sessions = loadSessions();

function persistSessions() {
  try {
    const obj = {};
    for (const [token, s] of sessions) obj[token] = { username: s.username, expiresAt: s.expiresAt };
    const file = sessionsFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(obj), { mode: 0o600 });
  } catch {}
}

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
  persistSessions();
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
  if (!token) return;
  sessions.delete(token);
  persistSessions();
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
  // 测试用：丢掉内存会话，模拟重新载入（核心重启）
  reloadSessions: () => { sessions = loadSessions(); return sessions.size; },
  sessionCount: () => sessions.size,
  COOKIE_NAME
};
