'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { transformHtml, transformScript } = require('../core/agent/dsh-embed');
const { createDshProxy } = require('../core/api/dsh-proxy');

test('embedded layout adapts the installed DSH batch without replacing other plugin registrations', () => {
  const names = ['dsh-client-ui-layout', 'dsh-client-ui-sidebar', 'dsh-client-ui-brand-official', 'dsh-client-ui-conversation', 'dsh-client-ui-settings-general', 'dsh-client-ui-theme', 'dsh-client-ui-open-in-app', 'dsh-client-ui-chat'];
  const sources = names.map(name => fs.readFileSync(path.join(__dirname, '../node_modules/@deepseek-ai', name, 'lib/client.js'), 'utf8'));
  const source = transformScript(sources.join('\n'));
  new vm.Script(source);
  assert.match(source, /hasSidebar\(\) \? 0/);
  assert.match(source, /wrapLayout\(AppFrame/);
  assert.match(source, /data-tp-preview/);
  assert.match(source, /今天想做点什么/);
  assert.match(source, /小鹈鹕正在思考…/);
  assert.doesNotMatch(source, /深度求索中|Deep diving\.\.\.|探索未至之境|探索未知之境|Into the Unknown/);
  // 首屏「预览版」徽标：文案本身被清空（不再只靠 CSS 隐藏）
  assert.doesNotMatch(source, /"hero\.preview": "(?:预览版|Preview)"/);
  assert.match(source, /wrapSettings\(SettingsRoot/);
  assert.match(source, /跟随小鹈鹕/);
  assert.match(source, /const OPEN_IN_APP_ICON_PREFIX = "\/dsh\/open-in-app\/icon"/);
  const registrations = [];
  vm.runInNewContext(transformScript(sources[2]), { window: { __ModuleLoader__: { load(entry) {
    const plugin = entry.factory(() => ({ jsx() {} }));
    plugin.apply({ slots: {
      inject(name, callback) { const result = callback(); if (result?.[Symbol.iterator]) Array.from(result); },
      register(options) { registrations.push(options.name); return () => {}; }
    } });
  } } } });
  assert.deepEqual(registrations, ['conversation.hero.brand.mark', 'sidebar.brand.mark', 'sidebar.brand.name']);
  assert.throws(() => transformScript(sources[0].replace('}, AppFrame);', '}, ChangedFrame);')), /不兼容/);
});

test('embedded HTML retains module loading while replacing product branding and paths', () => {
  const result = transformHtml('<html><head><base href="/"><script src="/plugins/??one.js"></script><title>DeepSeek Harness</title><link rel="icon" href="./favicon.svg"><link rel="manifest" href="./manifest.webmanifest"></head><body>body</body></html>');
  assert.match(result, /<base href="\/dsh\/">/);
  assert.match(result, /src="\/dsh\/plugins\/\?\?one.js"/);
  assert.match(result, /<title>小鹈鹕<\/title>/);
  assert.match(result, /src="\/src\/dsh-embed.js"/);
  assert.doesNotMatch(result, /favicon.svg|manifest.webmanifest/);
  assert.equal(transformScript('const model = "DeepSeek-V4";'), 'const model = "DeepSeek-V4";');
});

// 下面这条是白标的**上游哨兵**：那几处"尽力而为"的改写（不抛错，因为抛错会让应用/设置页打不开）
// 靠这里对着随包资源钉住。DSH 升级改了文案 → 测试失败，提醒同步 dsh-embed.js，而不是线上静默漏品牌。
test('whitelabel rewrites cover the boot card, locale fallback, export name and welcome body', () => {
  const pkg = (name) => path.join(__dirname, '../node_modules/@deepseek-ai', name);
  const read = (name) => fs.readFileSync(pkg(name), 'utf8');

  // shell bundle 名字带 hash，按内容找（这份是应用本体，加载时屏幕正中的 boot 卡）
  const assets = fs.readdirSync(pkg('dsh-web-frontend/dist/assets')).filter((name) => name.endsWith('.js'));
  const shellName = assets.find((name) => fs.readFileSync(pkg(`dsh-web-frontend/dist/assets/${name}`), 'utf8').includes('dataset.dshBootSpinner'));
  assert.ok(shellName, '随包前端里应能找到 shell bundle');
  const shell = transformScript(read(`dsh-web-frontend/dist/assets/${shellName}`));
  assert.doesNotMatch(shell, /ot\(rt\.wordmark,"HARNESS"\)/);
  assert.match(shell, /ot\(rt\.wordmark,"小鹈鹕"\)/);
  assert.doesNotMatch(shell, /ot\(rt\.hint,"Loading plugins/);

  const locale = transformScript(read('dsh-client-locale/lib/client.js'));
  assert.doesNotMatch(locale, /"brand\.localBuild": "DSH/);
  assert.match(locale, /"brand\.localBuild": "小鹈鹕"/);

  const exporter = transformScript(read('dsh-session-log-export/lib/client.js'));
  assert.doesNotMatch(exporter, /return `dsh-session-\$\{/);
  assert.match(exporter, /return `tinypelican-session-\$\{/);

  const models = transformScript(read('dsh-client-ui-settings-models/lib/client.js'));
  assert.doesNotMatch(models, /welcomeBody: "DeepSeek Harness/);
});

test('DSH proxy streams requests, isolates credentials, rewrites assets, and rejects foreign origins', async (context) => {
  const received = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
    if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'private-upstream-cookie=secret' });
      res.end('<html><head><base href="/"><title>DeepSeek Harness</title></head><body></body></html>');
    } else if (req.url === '/api/document.html') res.writeHead(200, { 'content-type': 'text/html' }).end('<html><head><title>User document</title></head><body>Original document</body></html>');
    else if (req.url === '/redirect') res.writeHead(302, { location: '/somewhere' }).end();
    else if (req.url === '/external') res.writeHead(302, { location: 'https://example.com/' }).end();
    else if (req.url === '/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: first\n\n');
      const timer = setTimeout(() => res.end('data: last\n\n'), 1000);
      res.on('close', () => clearTimeout(timer));
    } else res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(Buffer.concat(chunks));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const proxy = createDshProxy({ base: 'http://127.0.0.1:' + upstream.address().port, getCookie: async () => 'dsh-auth-test=server-secret' });
  const server = http.createServer((req, res) => proxy.handle(req, res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  context.after(async () => {
    proxy.close();
    server.closeAllConnections();
    upstream.closeAllConnections();
    await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => upstream.close(resolve))]);
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  const response = await fetch(base + '/dsh/', { headers: { cookie: 'xtp_session=do-not-forward', authorization: 'Bearer do-not-forward' } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('set-cookie'), null);
  assert.match(await response.text(), /小鹈鹕/);
  assert.equal(received[0].headers.cookie, 'dsh-auth-test=server-secret');
  assert.equal(received[0].headers.authorization, undefined);
  assert.equal(await (await fetch(base + '/dsh/api/document.html')).text(), '<html><head><title>User document</title></head><body>Original document</body></html>');
  const binary = Buffer.from([0, 1, 128, 255]);
  const uploaded = await fetch(base + '/dsh/api/upload?name=test', { method: 'POST', headers: { 'content-type': 'application/octet-stream', origin: base }, body: binary });
  assert.deepEqual(Buffer.from(await uploaded.arrayBuffer()), binary);
  assert.equal(received.at(-1).url, '/api/upload?name=test');
  assert.equal(received.at(-1).headers.origin, 'http://127.0.0.1:' + upstream.address().port);
  assert.equal((await fetch(base + '/dsh/', { headers: { origin: 'https://other.example' } })).status, 403);
  assert.equal((await fetch(base + '/dsh/', { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal((await fetch(base + '/dsh/redirect', { redirect: 'manual' })).headers.get('location'), '/dsh/somewhere');
  assert.equal((await fetch(base + '/dsh/external', { redirect: 'manual' })).status, 502);
  const stream = await fetch(base + '/dsh/stream');
  const reader = stream.body.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'data: first\n\n');
  await reader.cancel();
});

test('DSH proxy forwards upgraded sockets and closes them on shutdown', { timeout: 10000 }, async (context) => {
  const upstream = http.createServer();
  let requestPath;
  upstream.on('upgrade', (req, socket) => {
    requestPath = req.url;
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\n');
    socket.on('data', chunk => socket.write(chunk));
    socket.on('end', () => socket.end());
    socket.on('error', () => {});
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const proxy = createDshProxy({ base: 'http://127.0.0.1:' + upstream.address().port, getCookie: async () => 'dsh-auth-test=secret' });
  const server = http.createServer();
  server.on('upgrade', proxy.upgrade);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  context.after(async () => {
    proxy.close();
    await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => upstream.close(resolve))]);
  });
  const socket = await new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port: server.address().port, path: '/dsh/api/remote.mux', headers: { connection: 'Upgrade', upgrade: 'test' } });
    request.on('upgrade', (response, connected) => resolve(connected));
    request.on('error', reject);
    request.end();
  });
  socket.on('error', () => {});
  socket.on('end', () => socket.end());
  const echoed = new Promise(resolve => socket.once('data', resolve));
  socket.write('hello');
  assert.equal(String(await echoed), 'hello');
  assert.equal(requestPath, '/api/remote.mux');
  const closed = new Promise(resolve => socket.once('close', resolve));
  proxy.close();
  await closed;
});
