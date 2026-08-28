'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaotihu-api-'));
process.env.XIAOTIHU_DATA_DIR = tmp;

const { createServer } = require('../core/server');

function listen(srv) {
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(srv.address().port)));
}

test('REST 服务：健康/设置读写/静态资源/404', async () => {
  const srv = createServer();
  const port = await listen(srv);
  const base = `http://127.0.0.1:${port}`;
  try {
    const h = await (await fetch(base + '/api/health')).json();
    assert.strictEqual(h.ok, true);
    assert.strictEqual(h.name, 'xiaotihu-core');

    // 未配置时返回带默认值的设置
    const s = await (await fetch(base + '/api/settings')).json();
    assert.strictEqual(s.engine.provider, 'siliconflow');
    assert.ok(s.engine.providers.openai);

    // 保存设置
    const patch = {
      engine: {
        provider: 'ollama',
        providers: { ollama: { baseUrl: 'http://127.0.0.1:11434/v1', apiKey: '', model: 'qwen3:8b' } }
      }
    };
    const r = await fetch(base + '/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch)
    });
    assert.strictEqual((await r.json()).engine.provider, 'ollama');

    // Agent 任务 API
    const agentList = await (await fetch(base + '/api/agent/tasks')).json();
    assert.ok(Array.isArray(agentList));
    const badAgent = await fetch(base + '/api/agent/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task: '   ' })
    });
    assert.strictEqual(badAgent.status, 400);

    // Agent 队列 API
    const queueList = await (await fetch(base + '/api/agent/queue')).json();
    assert.ok(Array.isArray(queueList));
    const badQueue = await fetch(base + '/api/agent/queue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ summary: '   ' })
    });
    assert.strictEqual(badQueue.status, 400);

    // 回复建议 API
    const cur = await (await fetch(base + '/api/reply-suggestions/current')).json();
    assert.strictEqual(cur.suggestion, null);
    const badApply = await fetch(base + '/api/reply-suggestions/nope/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ index: 0 })
    });
    assert.strictEqual(badApply.status, 400);
    const dismiss = await (await fetch(base + '/api/reply-suggestions/nope/dismiss', { method: 'POST' })).json();
    assert.strictEqual(dismiss.ok, false);

    // 静态资源
    const html = await (await fetch(base + '/')).text();
    assert.ok(html.includes('小鹈鹕'));
    const css = await (await fetch(base + '/styles.css')).text();
    assert.ok(css.includes('--accent'));
    const src = await fetch(base + '/src/app.mjs');
    assert.strictEqual(src.status, 200);
    assert.strictEqual((await fetch(base + '/suggestion-icon.html')).status, 200);
    assert.strictEqual((await fetch(base + '/suggestion-card.html')).status, 200);

    // 未匹配路由
    assert.strictEqual((await fetch(base + '/api/nope')).status, 404);
    // 目录穿越防护
    const evil = await fetch(base + '/src/../../core/server.js');
    assert.notStrictEqual(evil.status, 200);
  } finally {
    srv.close();
  }
});
