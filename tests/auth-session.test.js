// 登录会话：保存配置会触发核心热重启，会话必须活过重启，
// 否则下一次「保存策略」会因为 GET /api/settings 401 而报 unauthorized。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaotihu-auth-'));
process.env.XIAOTIHU_DATA_DIR = tmp;

const auth = require('../core/auth');
const { createServer } = require('../core/server');

const CFG = {
  auth: { enabled: true, username: 'liuyee', password: 'pw-123456' },
  engine: { provider: 'ollama', providers: { ollama: { baseUrl: 'http://127.0.0.1:9/v1', model: 'mock' } } }
};

function writeConfig() {
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify(CFG), 'utf8');
}

function listen(srv) {
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(srv.address().port)));
}

test('会话落盘：核心重启后同一个 token 仍然有效', () => {
  auth.reloadSessions();
  const token = auth.createSession('liuyee');
  assert.ok(auth.getSession(token), '新建会话应有效');
  assert.ok(fs.existsSync(path.join(tmp, 'sessions.json')), '会话应写入数据目录');

  // 模拟核心重启：丢内存、从磁盘重新载入
  auth.reloadSessions();
  const restored = auth.getSession(token);
  assert.ok(restored, '重启后会话必须还在（否则保存配置后就被踢下线）');
  assert.strictEqual(restored.username, 'liuyee');

  auth.destroySession(token);
  assert.strictEqual(auth.getSession(token), null);
  auth.reloadSessions();
  assert.strictEqual(auth.getSession(token), null, '登出后重启也不该复活');
});

test('过期会话在载入时被清掉', () => {
  fs.writeFileSync(path.join(tmp, 'sessions.json'), JSON.stringify({
    expired: { username: 'liuyee', expiresAt: Date.now() - 1000 },
    alive: { username: 'liuyee', expiresAt: Date.now() + 60000 }
  }), 'utf8');
  auth.reloadSessions();
  assert.strictEqual(auth.getSession('expired'), null);
  assert.ok(auth.getSession('alive'));
  auth.destroySession('alive');
});

test('REST：未登录保存配置返回 401 unauthorized，登录后可以保存', async () => {
  writeConfig();
  const srv = createServer({ config: CFG });
  const port = await listen(srv);
  const base = `http://127.0.0.1:${port}`;
  try {
    const anon = await fetch(base + '/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ proactivity: { level: 'L2' } })
    });
    assert.strictEqual(anon.status, 401);
    assert.strictEqual((await anon.json()).error, 'unauthorized');

    const bad = await fetch(base + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'liuyee', password: 'wrong' })
    });
    assert.strictEqual(bad.status, 401);

    const login = await fetch(base + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'liuyee', password: 'pw-123456' })
    });
    assert.strictEqual(login.status, 200);
    const cookie = String(login.headers.getSetCookie ? login.headers.getSetCookie()[0] : login.headers.get('set-cookie')).split(';')[0];

    // 登录后：读+写设置都要正常（保存会触发 onRestart，但这里没传 onRestart）
    const read = await fetch(base + '/api/settings', { headers: { Cookie: cookie } });
    assert.strictEqual(read.status, 200);
    const saved = await fetch(base + '/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ proactivity: { level: 'L3' } })
    });
    assert.strictEqual(saved.status, 200);
    assert.strictEqual((await saved.json()).proactivity.level, 'L3');

    // 模拟核心重启后拿同一个 cookie 继续用
    auth.reloadSessions();
    const afterRestart = await fetch(base + '/api/settings', { headers: { Cookie: cookie } });
    assert.strictEqual(afterRestart.status, 200, '重启后同一 cookie 不应再被踢下线');
  } finally {
    srv.close();
  }
});
