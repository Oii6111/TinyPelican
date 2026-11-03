// 系统代理探测：只测纯逻辑（解析 / 决策 / 注入），不碰真实注册表
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const systemProxy = require(path.join(__dirname, '..', 'core', 'net', 'system-proxy.js'));

test('parseProxyServer：裸 host:port 同时作用于 http 和 https', () => {
  const parsed = systemProxy.parseProxyServer('127.0.0.1:7897');
  assert.strictEqual(parsed.http, 'http://127.0.0.1:7897');
  assert.strictEqual(parsed.https, 'http://127.0.0.1:7897');
  assert.deepStrictEqual(parsed.unsupported, []);
});

test('parseProxyServer：按协议分开的写法各归各的', () => {
  const parsed = systemProxy.parseProxyServer('http=127.0.0.1:7890;https=10.0.0.2:8443');
  assert.strictEqual(parsed.http, 'http://127.0.0.1:7890');
  assert.strictEqual(parsed.https, 'http://10.0.0.2:8443');
});

test('parseProxyServer：SOCKS 单独报出来，不当成可用代理', () => {
  const parsed = systemProxy.parseProxyServer('socks=127.0.0.1:7891');
  assert.strictEqual(parsed.http, '');
  assert.strictEqual(parsed.https, '');
  assert.deepStrictEqual(parsed.unsupported, ['socks=127.0.0.1:7891']);
});

test('normalizeBypass：丢掉 <local> 占位，保留通配', () => {
  const list = systemProxy.normalizeBypass('localhost;*.local;127.*;<local>');
  assert.deepStrictEqual(list, ['localhost', '*.local', '127.*']);
});

test('resolve：系统未启用代理 → 直连', () => {
  const info = systemProxy.resolve({ env: {}, system: { enabled: false, server: '', pac: '', bypass: '' } });
  assert.strictEqual(info.source, 'none');
  assert.strictEqual(info.httpProxy, '');
  assert.match(info.summary, /直连/);
});

test('resolve：系统代理已启用 → 走代理，且 no_proxy 必带回环地址', () => {
  const info = systemProxy.resolve({
    env: {},
    system: { enabled: true, server: '127.0.0.1:7897', pac: '', bypass: '*.corp.example;<local>' }
  });
  assert.strictEqual(info.source, 'system');
  assert.strictEqual(info.httpsProxy, 'http://127.0.0.1:7897');
  assert.match(info.noProxy, /127\.0\.0\.1/);
  assert.match(info.noProxy, /localhost/);
  assert.match(info.noProxy, /\*\.corp\.example/);
});

test('resolve：用户已设 http_proxy → 原样尊重，不读系统代理', () => {
  const info = systemProxy.resolve({
    env: { https_proxy: 'http://10.1.1.1:8080' },
    system: { enabled: true, server: '127.0.0.1:7897', pac: '', bypass: '' }
  });
  assert.strictEqual(info.source, 'env');
  assert.strictEqual(info.httpsProxy, 'http://10.1.1.1:8080');
});

test('resolve：只配了 PAC → 直连并给出可操作的说明', () => {
  const info = systemProxy.resolve({
    env: {},
    system: { enabled: true, server: '', pac: 'http://127.0.0.1:7897/pac', bypass: '' }
  });
  assert.strictEqual(info.source, 'none');
  assert.ok(info.notes.some((n) => /PAC/.test(n)));
});

test('applyToEnv：走系统代理时把大小写两份都写上', () => {
  const env = {};
  const info = systemProxy.applyToEnv(env, { system: { enabled: true, server: '127.0.0.1:7897', pac: '', bypass: '' } });
  assert.strictEqual(info.applied, true);
  assert.strictEqual(env.http_proxy, 'http://127.0.0.1:7897');
  assert.strictEqual(env.HTTP_PROXY, 'http://127.0.0.1:7897');
  assert.strictEqual(env.https_proxy, 'http://127.0.0.1:7897');
  assert.strictEqual(env.HTTPS_PROXY, 'http://127.0.0.1:7897');
  assert.ok(env.no_proxy && env.NO_PROXY);
});

test('parseRegValue：按 reg query 的真实输出取值（任意端口都不写死）', () => {
  // 下面三段是从真实 `reg query ... /v X` 复制的输出
  const enableOut = '\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\r\n    ProxyEnable    REG_DWORD    0x1\r\n\r\n';
  const serverOut = '\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\r\n    ProxyServer    REG_SZ    127.0.0.1:10809\r\n\r\n';
  const overrideOut = '\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\r\n    ProxyOverride    REG_SZ    localhost;*.local;<local>\r\n\r\n';
  assert.strictEqual(systemProxy.parseRegValue('ProxyEnable', enableOut), '0x1');
  assert.strictEqual(systemProxy.parseRegValue('ProxyServer', serverOut), '127.0.0.1:10809');
  assert.strictEqual(systemProxy.parseRegValue('ProxyOverride', overrideOut), 'localhost;*.local;<local>');
});

test('parseRegValue：值不存在时返回空串（不能被当成解析成功）', () => {
  const emptyOut = '\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\r\n';
  assert.strictEqual(systemProxy.parseRegValue('ProxyServer', emptyOut), '');
});

test('resolve：读不到系统代理时如实报错，不伪装成「没配代理」', () => {
  const info = systemProxy.resolve({ env: {}, system: { ok: false, error: 'EPERM', enabled: false } });
  assert.strictEqual(info.source, 'none');
  assert.match(info.summary, /读取系统代理失败/);
  assert.ok(info.notes.some((n) => /EPERM/.test(n)));
});

test('applyToEnv：直连时一个代理键都不加', () => {
  const env = {};
  const info = systemProxy.applyToEnv(env, { system: { enabled: false, server: '', pac: '', bypass: '' } });
  assert.strictEqual(info.applied, false);
  assert.deepStrictEqual(Object.keys(env), []);
});
