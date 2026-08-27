'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { chatCompletion } = require('../core/engine/client');
const { extractJsonArray } = require('../core/engine/extract');

function fakeServer() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const payload = JSON.parse(body || '{}');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          model: payload.model,
          choices: [{ message: { role: 'assistant', content: '{"ok":true}' } }]
        }));
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

test('chatCompletion 调用 OpenAI 兼容接口', async () => {
  const srv = await fakeServer();
  try {
    const port = srv.address().port;
    const cfg = {
      engine: {
        provider: 'custom',
        providers: { custom: { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'sk-test', model: 'test-model' } },
        retries: 0
      }
    };
    const r = await chatCompletion([{ role: 'user', content: 'hi' }], { config: cfg, timeoutMs: 5000 });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.text, '{"ok":true}');
  } finally {
    srv.close();
  }
});

test('未配置 API Key 时返回明确错误', async () => {
  const r = await chatCompletion([{ role: 'user', content: 'hi' }], {
    config: { engine: { provider: 'openai', providers: { openai: { apiKey: '', model: 'gpt-4o-mini' } } } }
  });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /API Key/);
});

test('extractJsonArray 容忍 Markdown 与前后缀', () => {
  const arr = extractJsonArray('```json\n[{"type":"task"}]\n```');
  assert.deepStrictEqual(arr, [{ type: 'task' }]);
  const single = extractJsonArray('结果是：{"type":"deadline","summary":"交方案"}');
  assert.strictEqual(single[0].type, 'deadline');
});
