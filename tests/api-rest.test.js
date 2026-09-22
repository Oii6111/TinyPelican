'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaotihu-api-'));
process.env.XIAOTIHU_DATA_DIR = tmp;

const { createServer } = require('../core/server');
const store = require('../core/reply/suggestion-store');

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
    // 默认服务商是 DeepSeek（内置 DSH 的 llm-deepseek 路由、意图识别默认都走它）
    assert.strictEqual(s.engine.provider, 'deepseek');
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
    assert.strictEqual(cur.pending, null);
    const badApply = await fetch(base + '/api/reply-suggestions/nope/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan: 0 })
    });
    assert.strictEqual(badApply.status, 400);
    const badNext = await fetch(base + '/api/reply-suggestions/nope/next', { method: 'POST' });
    assert.strictEqual(badNext.status, 400);
    const badContinue = await fetch(base + '/api/reply-suggestions/nope/continue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deep: false })
    });
    assert.strictEqual(badContinue.status, 400);
    const badReset = await (await fetch(base + '/api/reply-suggestions/nope/reset', { method: 'POST' })).json();
    assert.strictEqual(badReset.ok, false);
    // 没有当前建议时，换一批 / 按描述重写直接失败（不会去调模型）
    const regen = await (await fetch(base + '/api/reply-suggestions/current/regenerate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hint: '婉拒他' })
    })).json();
    assert.strictEqual(regen.ok, false);
    assert.ok(regen.error);

    // 有一批建议时：方案序号越界 / 没有顺序状态都只报错，不触发任何回填
    store.invalidate();
    store.replaceSuggestion({
      id: 'reply_api_1',
      contact: 'Hank',
      sourceMessage: '在吗',
      plans: [{ tone: '自然', messages: ['在的', '怎么了'] }],
      targetWindow: null,
      createdAt: new Date().toISOString(),
      expiresAt: Date.now() + 60000
    });
    const cur2 = await (await fetch(base + '/api/reply-suggestions/current')).json();
    assert.strictEqual(cur2.suggestion.contact, 'Hank');
    assert.deepStrictEqual(cur2.suggestion.plans[0].messages, ['在的', '怎么了']);
    const badPlan = await fetch(base + '/api/reply-suggestions/reply_api_1/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan: 5 })
    });
    assert.strictEqual(badPlan.status, 400);
    const noSeq = await fetch(base + '/api/reply-suggestions/reply_api_1/next', { method: 'POST' });
    assert.strictEqual(noSeq.status, 400);
    // 还没开始顺序发送时，「换一批剩下的」也不该触发模型
    const noSeqContinue = await (await fetch(base + '/api/reply-suggestions/reply_api_1/continue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deep: false })
    })).json();
    assert.strictEqual(noSeqContinue.ok, false);
    const reset = await (await fetch(base + '/api/reply-suggestions/reply_api_1/reset', { method: 'POST' })).json();
    assert.strictEqual(reset.ok, true);

    // 静态资源
    const html = await (await fetch(base + '/')).text();
    assert.ok(html.includes('小鹈鹕'));
    const css = await (await fetch(base + '/styles.css')).text();
    assert.ok(css.includes('--accent'));
    const src = await fetch(base + '/src/app.mjs');
    assert.strictEqual(src.status, 200);
    assert.strictEqual((await fetch(base + '/suggestion-card.html')).status, 200);
    // 悬浮小图标已取消：卡片直接出现，不再有独立图标窗口
    assert.strictEqual((await fetch(base + '/suggestion-icon.html')).status, 404);

    // 未匹配路由
    assert.strictEqual((await fetch(base + '/api/nope')).status, 404);
    // 目录穿越防护
    const evil = await fetch(base + '/src/../../core/server.js');
    assert.notStrictEqual(evil.status, 200);
  } finally {
    srv.close();
  }
});
