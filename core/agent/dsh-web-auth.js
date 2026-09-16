// DSH WebUI 鉴权（dsh 0.1.5+ 内置 BrowserAuth）
//
// 机制（见 @deepseek-ai/dsh-client-connection 的 browser-auth）：
//   1. 每次 `dsh web` 启动会打印 http://127.0.0.1:3080/?token=<临时令牌>；
//   2. 用这个令牌 GET /?token=... 一次，会 303 并下发签名 cookie `dsh-auth-*`
//      （HttpOnly；签名密钥持久化在 DSH 自己的凭据库里，重启后 cookie 仍然有效）；
//   3. 之后所有 /api 请求都靠这个 cookie 放行；没有 cookie 一律 401 unauthorized。
//
// 所以：令牌是每进程临时的，cookie 是长期的 —— cookie 缓存到本地数据目录复用，
// 只有拿不到 cookie（首次运行 / cookie 过期或 DSH 换了 home）时才需要令牌。
'use strict';

const fs = require('fs');
const path = require('path');
const { getPaths } = require('../lib/paths');
const { log } = require('../lib/log');
const { loadConfig } = require('../lib/config');

const COOKIE_FILE = () => path.join(getPaths().dataDir, 'dsh-web-auth.json');

const cache = new Map();      // base -> cookie
const launchTokens = new Map(); // base -> 由本进程拉起 DSH 时从启动日志里抓到的令牌
let loaded = false;

function normalizeBase(base) {
  return String(base || '').replace(/\/+$/, '');
}

function load() {
  if (loaded) return;
  loaded = true;
  try {
    const raw = JSON.parse(fs.readFileSync(COOKIE_FILE(), 'utf8'));
    for (const [base, entry] of Object.entries(raw || {})) {
      if (entry && typeof entry.cookie === 'string' && entry.cookie) cache.set(normalizeBase(base), entry.cookie);
    }
  } catch {}
}

function persist() {
  try {
    const obj = {};
    for (const [base, cookie] of cache) obj[base] = { cookie, savedAt: new Date().toISOString() };
    const file = COOKIE_FILE();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(obj), { mode: 0o600 });
  } catch {}
}

function cookieFor(base) {
  load();
  return cache.get(normalizeBase(base)) || '';
}

function rememberCookie(base, cookie) {
  if (!cookie) return;
  load();
  cache.set(normalizeBase(base), cookie);
  persist();
}

// 由本进程拉起 dsh web 时，从它的启动日志里抓令牌（形如 .../?token=xxxx）
function rememberLaunchToken(base, token) {
  const t = String(token || '').trim();
  if (!t) return false;
  launchTokens.set(normalizeBase(base), t);
  return true;
}

function scanLaunchOutput(base, chunk) {
  const text = String(chunk || '');
  const m = text.match(/\?token=([A-Za-z0-9_-]{8,})/);
  if (!m) return false;
  if (rememberLaunchToken(base, m[1])) log('info', 'agent', '已从 DSH 启动日志捕获 WebUI 令牌');
  return true;
}

function tokenFromConfig(config) {
  let cfg = config;
  if (!cfg) {
    try { cfg = loadConfig(); } catch {}
  }
  const dsh = (cfg && cfg.agent && cfg.agent.dsh) || {};
  return String(dsh.webToken || process.env.DSH_WEB_TOKEN || '').trim();
}

function setCookieHeader(res, cookie) {
  const raw = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : [res.headers.get('set-cookie')].filter(Boolean);
  for (const value of raw) {
    const pair = String(value || '').split(';')[0];
    if (pair.startsWith('dsh-auth-')) return pair;
  }
  return '';
}

// 用令牌换 cookie
async function exchangeToken(base, token) {
  const url = `${normalizeBase(base)}/?token=${encodeURIComponent(token)}`;
  try {
    const res = await fetch(url, { redirect: 'manual' });
    const cookie = setCookieHeader(res, cookieFor(base));
    if (cookie) {
      rememberCookie(base, cookie);
      log('info', 'agent', 'DSH WebUI 鉴权成功（已保存会话 cookie）');
      return cookie;
    }
    if (res.status === 401) log('warn', 'agent', 'DSH WebUI 令牌被拒绝：请把 dsh web 启动日志里的 ?token=... 更新到配置');
    return '';
  } catch (e) {
    log('warn', 'agent', 'DSH WebUI 令牌兑换失败：' + String((e && e.message) || e));
    return '';
  }
}

// 取一个可用于请求的 cookie：本地缓存优先，没有就用令牌换一次
async function ensureCookie({ base, config = null, force = false } = {}) {
  if (!force) {
    const cached = cookieFor(base);
    if (cached) return cached;
  }
  const token = launchTokens.get(normalizeBase(base)) || tokenFromConfig(config);
  if (!token) return '';
  return exchangeToken(base, token);
}

// 鉴权失败时给用户看得懂的指引
function unauthorizedHint(base) {
  return `DSH WebUI 需要登录令牌：把 dsh web 启动日志里的 .../?token=xxx 填到 config.json 的 agent.dsh.webToken（或设环境变量 DSH_WEB_TOKEN）后重试（${normalizeBase(base)}）`;
}

module.exports = {
  cookieFor,
  scanLaunchOutput,
  ensureCookie,
  unauthorizedHint,
  _resetCache: () => { cache.clear(); launchTokens.clear(); loaded = false; }
};
