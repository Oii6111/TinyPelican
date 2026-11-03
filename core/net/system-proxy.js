// 小鹈鹕 · 系统代理探测
//
// 背景：DSH（模型出站请求那一层）只认 http_proxy / https_proxy / no_proxy / all_proxy
// 这几个环境变量（见 @deepseek-ai/dsh-http-proxy 的 policy 解析），它不读 Windows 的
// 「系统代理」设置。用户在系统/代理客户端里配好的代理，对模型请求这一层是隐形的：
//   · 用户挂着代理、但没设环境变量  → 模型请求走直连，被墙/被公司网络重置 → TLS 握手失败
//   · 用户没代理、环境变量有残留    → 模型请求反而去连一个死端口 → 同样失败
// 所以这里把 Windows 系统代理翻译成 DSH 认得的形态：检测到就走代理，检测不到就保持直连。
//
// 原则：
//   1. 用户显式设过环境变量 → 完全尊重，一个字都不改（环境变量优先级高于系统代理）
//   2. 任何异常都不抛，最差退回「直连」，绝不让探测把进程带崩
//   3. 只翻译，不判断「该不该走代理」——那是用户的事
'use strict';

const { execFileSync } = require('child_process');
const net = require('net');
const path = require('path');

// 回环地址永远直连：代理自己也会连本机，不绕过就是死循环
const LOOPBACK_NO_PROXY = ['localhost', '127.0.0.1', '::1', '[::1]'];

// 携带代理配置的环境变量名。任何一个非空，就认为用户已经显式表达过意图
const PROXY_ENV_NAMES = [
  'http_proxy', 'HTTP_PROXY',
  'https_proxy', 'HTTPS_PROXY',
  'no_proxy', 'NO_PROXY',
  'all_proxy', 'ALL_PROXY'
];

const WIN_INTERNET_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
// 打包后的 Electron 进程 PATH 未必含 System32，用绝对路径更稳
const REG_EXE = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe');

let lastInfo = { source: 'none', summary: '直连（未检测到代理）' };

// ---------------------------------------------------------------- 读系统代理

// 从 `reg query` 的输出里取一个值：
//   HKEY_CURRENT_USER\...\Internet Settings
//       ProxyEnable    REG_DWORD    0x1
function parseRegValue(name, rawText) {
  const m = String(rawText || '').match(new RegExp('^\\s*' + name + '\\s+REG_\\w+\\s+(.*)$', 'm'));
  return m ? m[1].trim() : '';
}

function regQuery(name) {
  try {
    const out = execFileSync(REG_EXE, ['query', WIN_INTERNET_KEY, '/v', name], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    return { ok: true, value: parseRegValue(name, out) };
  } catch (e) {
    // 值不存在时 reg 以退出码 1 结束且没有输出——这是「没配」，不是读失败
    const status = e && typeof e.status === 'number' ? e.status : null;
    const stdout = String((e && e.stdout) || '').trim();
    if (status === 1 && !stdout) return { ok: true, value: '' };
    return { ok: false, value: '', error: String((e && (e.code || e.message)) || e) };
  }
}

// 读 Windows「系统代理」。读不出来要如实说读不出来，不能伪装成「没配代理」——
// 否则日志里永远是「直连」，用户会以为是网络问题。
function readWindowsProxy() {
  if (process.platform !== 'win32') {
    return { ok: true, enabled: false, server: '', pac: '', bypass: '', reason: '非 Windows 平台' };
  }
  const failed = [];
  const read = (name) => {
    const r = regQuery(name);
    if (!r.ok) failed.push(name + '（' + r.error + '）');
    return r.value;
  };
  const flag = read('ProxyEnable').toLowerCase();
  const pac = read('AutoConfigURL');
  const enabled = flag === '0x1' || flag === '1';
  const server = enabled ? read('ProxyServer') : '';
  const bypass = enabled ? read('ProxyOverride') : '';
  if (failed.length) {
    return { ok: false, enabled: false, server: '', pac: '', bypass: '', error: failed.join('；') };
  }
  return { ok: true, enabled, server, pac, bypass };
}

// ---------------------------------------------------------------- 解析

// Windows 的 ProxyServer 有三种写法，都要认：
//   "127.0.0.1:7897"                      → 所有协议共用
//   "http=127.0.0.1:7890;https=1.2.3.4:1" → 按协议分开
//   "socks=127.0.0.1:7891"                → DSH 不支持 SOCKS，要明确报出来
function parseProxyServer(server) {
  const result = { http: '', https: '', unsupported: [] };
  const raw = String(server || '').trim();
  if (!raw) return result;

  const hasSchemeMap = raw.includes('=');
  if (!hasSchemeMap) {
    const url = withScheme(raw);
    if (url) {
      result.http = url;
      result.https = url;
    }
    return result;
  }

  for (const part of raw.split(';')) {
    const text = part.trim();
    if (!text) continue;
    const eq = text.indexOf('=');
    if (eq < 0) continue;
    const scheme = text.slice(0, eq).trim().toLowerCase();
    const url = withScheme(text.slice(eq + 1).trim());
    if (!url) continue;
    if (scheme === 'http') result.http = url;
    else if (scheme === 'https') result.https = url;
    else if (scheme === 'socks' || scheme === 'socks4' || scheme === 'socks5') result.unsupported.push(scheme + '=' + text.slice(eq + 1).trim());
  }
  return result;
}

// 补协议头；SOCKS 协议原样返回但会被上层识别为不支持。
function withScheme(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const url = /^[a-z0-9+.-]+:\/\//i.test(text) ? text : 'http://' + text;
  try {
    const parsed = new URL(url);
    if (!parsed.hostname || !parsed.port) return url;
    return url;
  } catch {
    return url;
  }
}

function isSocksUrl(url) {
  return /^socks/i.test(String(url || ''));
}

// Windows 的 ProxyOverride 语法：`;` 分隔，支持 `*` 通配和 `<local>` 占位。
// 转成 no_proxy 认的逗号分隔形式，`<local>` 直接丢掉（回环地址我们会自己补）。
function normalizeBypass(bypass) {
  const items = String(bypass || '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => !/^<.*>$/.test(s));
  return items;
}

function mergeNoProxy(items) {
  const seen = new Set();
  const out = [];
  for (const item of [...LOOPBACK_NO_PROXY, ...items]) {
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out.join(',');
}

// ---------------------------------------------------------------- 决策

function envHasProxy(env) {
  for (const name of PROXY_ENV_NAMES) {
    const value = env && env[name];
    if (typeof value === 'string' && value.trim()) return name;
  }
  return '';
}

/**
 * 解析出本次进程该用的代理策略。
 *
 * @param {object} [options]
 * @param {object} [options.env]        当前环境变量（默认 process.env）
 * @param {object} [options.system]     直接注入系统代理读取结果（测试用）
 * @param {Function} [options.readSystem] 自定义读取函数（测试用）
 * @returns {{source:'env'|'system'|'none', httpProxy:string, httpsProxy:string, noProxy:string, notes:string[], summary:string}}
 */
function resolve({ env = process.env, system, readSystem = readWindowsProxy } = {}) {
  const notes = [];

  // 0. 逃生阀：个别用户宁可直连也不要被系统代理影响（比如代理只服务浏览器）
  if (String((env && env.XIAOTIHU_IGNORE_SYSTEM_PROXY) || '').trim() === '1') {
    return {
      source: 'none', httpProxy: '', httpsProxy: '', noProxy: mergeNoProxy([]),
      notes: ['已按 XIAOTIHU_IGNORE_SYSTEM_PROXY=1 忽略系统代理'],
      summary: '直连（按配置忽略系统代理）'
    };
  }

  // 1. 用户显式设置的代理优先，绝不覆盖
  const explicit = envHasProxy(env);
  if (explicit) {
    return {
      source: 'env',
      httpProxy: String((env && (env.http_proxy || env.HTTP_PROXY)) || ''),
      httpsProxy: String((env && (env.https_proxy || env.HTTPS_PROXY)) || ''),
      noProxy: String((env && (env.no_proxy || env.NO_PROXY)) || ''),
      notes: [`沿用环境变量 ${explicit}`],
      summary: `代理来自环境变量 ${explicit}`
    };
  }

  // 2. 读系统代理
  let info;
  try {
    info = system || readSystem();
  } catch (e) {
    return { source: 'none', httpProxy: '', httpsProxy: '', noProxy: '', notes: ['读取系统代理失败：' + String((e && e.message) || e)], summary: '直连（读取系统代理失败）' };
  }

  if (!info || info.ok === false) {
    // 读不出来 ≠ 没配代理。区分开，否则日志永远显示「直连」，用户会以为是网络问题
    const reason = info && info.error ? String(info.error) : '未知错误';
    return {
      source: 'none',
      httpProxy: '',
      httpsProxy: '',
      noProxy: mergeNoProxy([]),
      notes: ['读取系统代理失败（' + reason + '），已按直连处理'],
      summary: '直连（读取系统代理失败）'
    };
  }

  if (!info.enabled) {
    // 系统没开代理：保持直连。此时若环境变量有残留，会被上面的 explicit 分支拦下，
    // 也就是说残留环境变量仍会生效——这是用户的显式配置，我们不动。
    const pacNote = info.pac ? ['系统代理关闭，但存在 PAC 脚本 ' + info.pac + '（不生效）'] : [];
    return {
      source: 'none',
      httpProxy: '',
      httpsProxy: '',
      noProxy: mergeNoProxy([]),
      notes: pacNote,
      summary: '直连（系统未启用代理）'
    };
  }

  // 3. 只配了 PAC、没有固定代理地址：PAC 需要执行脚本才能算出代理，DSH 侧无法解析
  const parsed = parseProxyServer(info.server);
  const httpProxy = isSocksUrl(parsed.http) ? '' : parsed.http;
  const httpsProxy = isSocksUrl(parsed.https) ? '' : parsed.https;

  if (parsed.unsupported.length) {
    notes.push('系统代理是 SOCKS（' + parsed.unsupported.join('；') + '），DSH 只支持 http/https 代理，这些协议按直连处理');
  }

  if (!httpProxy && !httpsProxy) {
    if (info.pac) {
      notes.push('系统代理使用 PAC 自动配置（' + info.pac + '），DSH 无法执行 PAC 脚本，已按直连处理；如需走代理请在代理客户端开启「系统代理/固定端口」模式');
      return { source: 'none', httpProxy: '', httpsProxy: '', noProxy: mergeNoProxy([]), notes, summary: '直连（PAC 无法解析）' };
    }
    return { source: 'none', httpProxy: '', httpsProxy: '', noProxy: mergeNoProxy([]), notes, summary: '直连（系统代理地址为空）' };
  }

  const fallback = httpsProxy || httpProxy;
  const noProxy = mergeNoProxy(normalizeBypass(info.bypass));
  return {
    source: 'system',
    httpProxy: httpProxy || fallback,
    httpsProxy: httpsProxy || fallback,
    noProxy,
    notes,
    summary: `系统代理 ${httpsProxy || httpProxy}`
  };
}

/**
 * 把解析结果写进一份环境变量，交给 dsh 子进程。
 * 只写 http_proxy/https_proxy/no_proxy 这三个 DSH 真正认的键，大小写各写一份
 * （undici 读小写优先，少写一份就可能被空值遮蔽）。
 *
 * @param {object} [env] 目标环境变量对象，就地修改
 * @param {object} [options] 透传给 resolve
 * @returns 同 resolve 的返回值，附带 applied 标记
 */
function applyToEnv(env = process.env, options = {}) {
  const info = resolve({ env, ...options });
  if (info.source === 'system') {
    if (info.httpProxy) {
      env.http_proxy = info.httpProxy;
      env.HTTP_PROXY = info.httpProxy;
    }
    if (info.httpsProxy) {
      env.https_proxy = info.httpsProxy;
      env.HTTPS_PROXY = info.httpsProxy;
    }
    if (info.noProxy) {
      env.no_proxy = info.noProxy;
      env.NO_PROXY = info.noProxy;
    }
  }
  lastInfo = info;
  return { ...info, applied: info.source === 'system' };
}

// 最近一次解析结果，给启动日志用
function lastResolution() {
  return lastInfo;
}

// ---------------------------------------------------------------- 存活探测

// 系统代理「开着但进程已经退了」是最常见的一种坏配置（代理客户端异常退出不会改回开关）。
// 探一下端口，探不通就提前告警，别等模型请求失败才让用户猜。
function probeProxy(info, timeoutMs = 1200) {
  return new Promise((resolveProbe) => {
    const url = (info && (info.httpsProxy || info.httpProxy)) || '';
    if (!url) return resolveProbe({ ok: false, skipped: true });
    let host = '';
    let port = 0;
    try {
      const parsed = new URL(url);
      host = parsed.hostname;
      port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
    } catch {
      return resolveProbe({ ok: false, skipped: true });
    }
    if (!host || !port) return resolveProbe({ ok: false, skipped: true });
    const socket = net.connect({ host, port });
    let settled = false;
    const done = (ok, error) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch {}
      resolveProbe({ ok, host, port, error });
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false, '超时'));
    socket.once('error', (e) => done(false, String((e && e.code) || e)));
  });
}

module.exports = {
  LOOPBACK_NO_PROXY,
  PROXY_ENV_NAMES,
  parseProxyServer,
  parseRegValue,
  normalizeBypass,
  mergeNoProxy,
  readWindowsProxy,
  resolve,
  applyToEnv,
  lastResolution,
  probeProxy
};
