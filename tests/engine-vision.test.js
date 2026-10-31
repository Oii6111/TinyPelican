// 视觉模型设置：后端判定接口 + 设置保存校验
// 关注点：/api/engine/vision 能如实回答「谁在看图」，设置页保存时挡住非法服务商。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaotihu-vision-settings-'));
process.env.XIAOTIHU_DATA_DIR = tmp;

const { createRouter } = require('../core/api/router');
const engineRoute = require('../core/api/routes/engine');
const settingsRoute = require('../core/api/routes/settings');

function writeConfig(engine) {
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ engine }, null, 2));
}

function makeCtx() {
  return {
    config: null,
    json: (res, code, body) => { res.statusCode = code; res.body = body; },
    readBody: async () => '{}'
  };
}

function build(ctx) {
  const router = createRouter();
  engineRoute(router, ctx);
  settingsRoute(router, ctx);
  return router;
}

async function call(router, ctx, method, url, body) {
  const req = { method, url, headers: {} };
  const res = { statusCode: 0, body: null, writeHead() {}, end() {} };
  ctx.readBody = async () => JSON.stringify(body || {});
  const matched = await router.match(req, res, ctx);
  return { matched, status: res.statusCode, body: res.body };
}

const PROVIDERS = {
  deepseek: { baseUrl: 'https://api.deepseek.com', apiKey: 'k', model: 'deepseek-chat' },
  openai: { baseUrl: 'https://api.openai.com/v1', apiKey: 'k', model: 'gpt-4o-mini' },
  siliconflow: { baseUrl: 'https://api.siliconflow.cn/v1', apiKey: 'k', model: 'Qwen/Qwen3.5-9B' },
  ollama: { baseUrl: 'http://127.0.0.1:11434/v1', apiKey: '', model: 'qwen3:8b' },
  custom: { baseUrl: '', apiKey: '', model: '' }
};

test('当前模型是纯文本时，判定接口说清楚「谁都不能看图」', async () => {
  writeConfig({ provider: 'deepseek', providers: PROVIDERS });
  const ctx = makeCtx();
  ctx.config = JSON.parse(fs.readFileSync(path.join(tmp, 'config.json'), 'utf8'));
  const result = await call(build(ctx), ctx, 'GET', '/api/engine/vision');
  assert.strictEqual(result.status, 200);
  assert.strictEqual(result.body.ok, false);
  assert.strictEqual(result.body.reason, 'unsupported');
  assert.match(result.body.error, /不支持视觉/);
  assert.strictEqual(result.body.model, 'deepseek-chat');
});

test('当前模型本身支持视觉时，判定为可直接用', async () => {
  writeConfig({ provider: 'deepseek', providers: { ...PROVIDERS, deepseek: { ...PROVIDERS.deepseek, model: 'deepseek-flash' } } });
  const ctx = makeCtx();
  ctx.config = JSON.parse(fs.readFileSync(path.join(tmp, 'config.json'), 'utf8'));
  const result = await call(build(ctx), ctx, 'GET', '/api/engine/vision');
  assert.strictEqual(result.body.ok, true);
  assert.deepStrictEqual({ provider: result.body.vision.provider, model: result.body.vision.model }, { provider: 'deepseek', model: 'deepseek-flash' });
  assert.strictEqual(result.body.vision.explicit, false);
});

test('单独指定视觉模型后，判定接口报告 explicit', async () => {
  writeConfig({
    provider: 'deepseek',
    providers: PROVIDERS,
    vision: { provider: 'openai', model: 'gpt-4o-mini' }
  });
  const ctx = makeCtx();
  ctx.config = JSON.parse(fs.readFileSync(path.join(tmp, 'config.json'), 'utf8'));
  const result = await call(build(ctx), ctx, 'GET', '/api/engine/vision');
  assert.strictEqual(result.body.ok, true);
  assert.deepStrictEqual({ provider: result.body.vision.provider, model: result.body.vision.model }, { provider: 'openai', model: 'gpt-4o-mini' });
  assert.strictEqual(result.body.vision.explicit, true);
});

test('保存视觉模型配置：合法值写进 config.json，非法服务商被拒', async () => {
  writeConfig({ provider: 'deepseek', providers: PROVIDERS });
  const ctx = makeCtx();
  const router = build(ctx);

  const bad = await call(router, ctx, 'POST', '/api/settings', { engine: { vision: { provider: 'not-a-provider', model: 'x' } } });
  assert.strictEqual(bad.status, 400);
  assert.match(bad.body.error, /服务商无效/);

  const saved = await call(router, ctx, 'POST', '/api/settings', { engine: { vision: { provider: 'openai', model: 'gpt-4o-mini' } } });
  assert.strictEqual(saved.status, 200);
  const onDisk = JSON.parse(fs.readFileSync(path.join(tmp, 'config.json'), 'utf8'));
  assert.deepStrictEqual(onDisk.engine.vision, { provider: 'openai', model: 'gpt-4o-mini' });
});

test('清空视觉模型 = 回到跟随当前模型', async () => {
  writeConfig({ provider: 'deepseek', providers: PROVIDERS, vision: { provider: 'openai', model: 'gpt-4o-mini' } });
  const ctx = makeCtx();
  const router = build(ctx);
  const saved = await call(router, ctx, 'POST', '/api/settings', { engine: { vision: { provider: '', model: '' } } });
  assert.strictEqual(saved.status, 200);
  const onDisk = JSON.parse(fs.readFileSync(path.join(tmp, 'config.json'), 'utf8'));
  assert.deepStrictEqual(onDisk.engine.vision, { provider: '', model: '' });
});

test('视觉描述超时有范围校验', async () => {
  writeConfig({ provider: 'deepseek', providers: PROVIDERS });
  const ctx = makeCtx();
  const router = build(ctx);
  const tooShort = await call(router, ctx, 'POST', '/api/settings', { engine: { visionTimeoutMs: 100 } });
  assert.strictEqual(tooShort.status, 400);
  const ok = await call(router, ctx, 'POST', '/api/settings', { engine: { visionTimeoutMs: 30000 } });
  assert.strictEqual(ok.status, 200);
});
