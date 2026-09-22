// 模型服务「测试连接」：旧前端/自动化脚本可能把掩码串（sk-****439d）当 Key 发过来，
// 服务端必须换成已保存的真 Key 再请求，否则会拿掩码去调模型、返回 401，
// 让人误以为「官方复制的 Key 无效」。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaotihu-engine-mask-'));
process.env.XIAOTIHU_DATA_DIR = tmp;

const { createServer } = require('../core/server');
const { maskKey, restoreMaskedKeys } = require('../core/api/models');

const REAL_KEY = 'sk-real-key-000000000000000439d';
const MASKED_KEY = maskKey(REAL_KEY);

function listen(srv) {
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(srv.address().port)));
}

function startMockModel(seen) {
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push(String(req.headers.authorization || ''));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ model: 'mock', choices: [{ message: { role: 'assistant', content: '正常' } }] }));
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(srv)));
}

test('掩码工具：只暴露前 3 位与后 4 位', () => {
  assert.strictEqual(MASKED_KEY.startsWith('sk-****'), true);
  assert.strictEqual(MASKED_KEY.endsWith('439d'), true);
  assert.strictEqual(MASKED_KEY.includes(REAL_KEY), false);
});

test('restoreMaskedKeys：补丁里的掩码串换成当前配置里的真 Key；没有真 Key 时清掉掩码', () => {
  const cur = { engine: { providers: { deepseek: { apiKey: REAL_KEY } } } };
  const patch = { engine: { providers: { deepseek: { apiKey: MASKED_KEY } } } };
  restoreMaskedKeys(cur, patch);
  assert.strictEqual(patch.engine.providers.deepseek.apiKey, REAL_KEY);

  const emptyPatch = { engine: { providers: { siliconflow: { apiKey: 'sk-****abcd' } } } };
  restoreMaskedKeys({ engine: { providers: {} } }, emptyPatch);
  assert.strictEqual(emptyPatch.engine.providers.siliconflow.apiKey, undefined);
});

test('测试连接：收到掩码 Key → 用已保存的真 Key 请求（不再 401）', async () => {
  const seen = [];
  const mock = await startMockModel(seen);
  const mockBase = `http://127.0.0.1:${mock.address().port}/v1`;

  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({
    engine: { provider: 'deepseek', providers: { deepseek: { baseUrl: mockBase, apiKey: REAL_KEY, model: 'mock' } } }
  }), 'utf8');

  const srv = createServer();
  const port = await listen(srv);
  const base = `http://127.0.0.1:${port}`;
  try {
    const r = await (await fetch(base + '/api/engine/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        engine: { provider: 'deepseek', providers: { deepseek: { baseUrl: mockBase, apiKey: MASKED_KEY, model: 'mock' } } }
      })
    })).json();
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(seen[0], 'Bearer ' + REAL_KEY, '应该用真 Key，而不是掩码串');
  } finally {
    srv.close();
    mock.close();
  }
});

test('测试连接：配置里没有真 Key 时给出明确提示，不拿掩码去请求', async () => {
  const seen = [];
  const mock = await startMockModel(seen);
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({
    engine: { provider: 'deepseek', providers: { deepseek: { baseUrl: `http://127.0.0.1:${mock.address().port}/v1`, apiKey: '', model: 'mock' } } }
  }), 'utf8');

  const srv = createServer();
  const port = await listen(srv);
  const base = `http://127.0.0.1:${port}`;
  try {
    const r = await (await fetch(base + '/api/engine/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        engine: { provider: 'deepseek', providers: { deepseek: { apiKey: MASKED_KEY } } }
      })
    })).json();
    assert.strictEqual(r.ok, false);
    assert.ok(String(r.error).includes('掩码'), r.error);
    assert.strictEqual(seen.length, 0, '不该带着掩码去请求模型');
  } finally {
    srv.close();
    mock.close();
  }
});
