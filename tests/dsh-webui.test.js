'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.XIAOTIHU_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pelican-webui-'));
const dshWeb = require('../core/agent/dsh-web-client');
const webAuth = require('../core/agent/dsh-web-auth');
const register = require('../core/api/routes/dsh-webui');

test('DSH 页面连接：复用服务、HttpOnly 登录交接及错误处理', async (context) => {
  let handler;
  register({ post(route, callback) { assert.equal(route, '/api/agent/webui'); handler = callback; } }, {
    config: {}, json(res, code, data) { res.status = code; res.data = data; }
  });
  const invoke = async (headers = {}) => {
    const response = { headers: {}, setHeader(name, value) { this.headers[name] = value; } };
    await handler({ headers: { host: '127.0.0.1:18791', ...headers } }, response);
    return response;
  };
  let launches = 0;
  let requests = [];
  let refreshes = [];
  context.mock.method(dshWeb, 'launchWeb', async () => { launches++; return { ok: true, started: false }; });
  context.mock.method(webAuth, 'ensureCookie', async (options) => { refreshes.push(options.force === true); return 'dsh-auth-test=v1.payload.signature'; });
  context.mock.method(global, 'fetch', async (url, options) => {
    requests.push({ url: String(url), options });
    return new Response('DSH');
  });
  const connected = await invoke({ origin: 'http://127.0.0.1:18791' });
  assert.equal(connected.status, 200);
  assert.deepEqual(connected.data, { url: 'http://127.0.0.1:18791/dsh/' });
  assert.match(connected.headers['Set-Cookie'], /; Path=\/; HttpOnly; SameSite=Strict$/);
  assert.equal(connected.headers['Cache-Control'], 'no-store');
  assert.equal(JSON.stringify(connected.data).includes('signature'), false);
  assert.equal(requests[0].options.headers.Cookie, 'dsh-auth-test=v1.payload.signature');
  assert.equal(launches, 1);

  assert.equal((await invoke({ origin: 'https://other.example' })).status, 403);
  assert.equal((await invoke({ 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await invoke({ host: 'localhost:18791' })).status, 400);
  assert.equal(launches, 1);

  requests = [];
  refreshes = [];
  let attempts = 0;
  global.fetch = async () => new Response('', { status: ++attempts === 1 ? 401 : 200 });
  assert.equal((await invoke()).status, 200);
  assert.deepEqual(refreshes, [false, true]);
  global.fetch = async () => new Response('', { status: 401 });
  const expired = await invoke();
  assert.equal(expired.status, 503);
  assert.match(expired.data.error, /登录已失效/);
  assert.equal(expired.headers['Set-Cookie'], undefined);

  dshWeb.launchWeb = async () => ({ ok: false });
  assert.match((await invoke()).data.error, /尚未就绪/);
  dshWeb.launchWeb = async () => { throw new Error('private detail'); };
  assert.match((await invoke()).data.error, /无法连接/);
});

test('DSH 登录交接接口受小鹈鹕登录保护', async () => {
  const { createServer } = require('../core/server');
  const server = createServer({ config: { auth: { enabled: true, username: 'test', password: 'test-password' } } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/agent/webui', { method: 'POST' });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('set-cookie'), null);
    const embedded = await fetch('http://127.0.0.1:' + server.address().port + '/dsh/');
    assert.equal(embedded.status, 401);
    assert.equal(embedded.headers.get('set-cookie'), null);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
