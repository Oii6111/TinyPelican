// 内置 DSH 的模型配置：小鹈鹕设置里的「模型 + 地址 + Key」必须成套地写进 DSH_HOME/settings.yaml。
// 曾经的坑：打包版默认 provider 是 siliconflow（模型 Qwen/Qwen3.5-9B、Key 为空），
// 用户只在 deepseek 里填了 Key，结果写出「Qwen 模型 + 没钥匙」的配置，DSH 里发消息报「API 密钥无效」。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { writeGeneratedDshSettings, effectiveEngineProvider, buildDshEnv } = require('../core/agent/dsh-client');

function tmpHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tnp-dsh-settings-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function configWithKeyOnDeepSeek() {
  return {
    engine: {
      provider: 'siliconflow',
      providers: {
        siliconflow: { baseUrl: 'https://api.siliconflow.cn/v1', apiKey: '', model: 'Qwen/Qwen3.5-9B' },
        deepseek: { baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-deepseek-test', model: 'deepseek-flash' }
      }
    }
  };
}

test('DSH 模型配置：选中的 provider 没 Key 时，退到真有 Key 的那个', (t) => {
  const home = tmpHome(t);
  assert.strictEqual(writeGeneratedDshSettings(home, configWithKeyOnDeepSeek()), true);
  const text = fs.readFileSync(path.join(home, 'settings.yaml'), 'utf8');
  assert.match(text, /model: "deepseek-flash"/);
  assert.match(text, /baseURL: "https:\/\/api\.deepseek\.com\/v1"/);
  assert.doesNotMatch(text, /Qwen/);
  assert.doesNotMatch(text, /siliconflow/);
});

test('DSH 模型配置：内容没变就不重写（免得 DSH 反复热重载）', (t) => {
  const home = tmpHome(t);
  writeGeneratedDshSettings(home, configWithKeyOnDeepSeek());
  const before = fs.statSync(path.join(home, 'settings.yaml')).mtimeMs;
  assert.strictEqual(writeGeneratedDshSettings(home, configWithKeyOnDeepSeek()), false);
  assert.strictEqual(fs.statSync(path.join(home, 'settings.yaml')).mtimeMs, before);
});

test('DSH 模型配置：一个可用 provider 都没有时，回到 DSH 默认模型（不留半套配置）', (t) => {
  const home = tmpHome(t);
  const cfg = {
    engine: {
      provider: 'siliconflow',
      providers: { siliconflow: { baseUrl: 'https://api.siliconflow.cn/v1', apiKey: '', model: 'Qwen/Qwen3.5-9B' } }
    }
  };
  assert.strictEqual(writeGeneratedDshSettings(home, cfg), true);
  const text = fs.readFileSync(path.join(home, 'settings.yaml'), 'utf8');
  assert.match(text, /model: "deepseek-flash"/);
  assert.doesNotMatch(text, /Qwen/);         // 不能带模型
  assert.doesNotMatch(text, /baseURL/);      // 也不能带地址
});

test('DSH 模型配置：配置变回不可用时，把之前写进去的模型/地址覆盖掉', (t) => {
  const home = tmpHome(t);
  const cfg = configWithKeyOnDeepSeek();
  assert.strictEqual(writeGeneratedDshSettings(home, cfg), true);
  const file = path.join(home, 'settings.yaml');
  assert.match(fs.readFileSync(file, 'utf8'), /baseURL: "https:\/\/api\.deepseek\.com\/v1"/);

  cfg.engine.providers.deepseek.apiKey = '';
  assert.strictEqual(writeGeneratedDshSettings(home, cfg), true);
  const text = fs.readFileSync(file, 'utf8');
  assert.doesNotMatch(text, /baseURL/);
  assert.match(text, /model: "deepseek-flash"/);
});

test('DSH 模型配置：选中且可用时用选中的那个；没 Key 时不算可用', () => {
  const cfg = configWithKeyOnDeepSeek();
  assert.strictEqual(effectiveEngineProvider(cfg).name, 'deepseek');
  cfg.engine.provider = 'deepseek';
  assert.strictEqual(effectiveEngineProvider(cfg).name, 'deepseek');
  cfg.engine.providers.deepseek.apiKey = '';
  assert.strictEqual(effectiveEngineProvider(cfg), null);
});

test('DSH 模型配置：没填任何 Key 时，不能悄悄退到本地 Ollama', () => {
  // 打包版默认配置长这样：选中 siliconflow（空 Key）+ 预设里的 ollama（qwen3:8b、无 Key）
  const cfg = configWithKeyOnDeepSeek();
  cfg.engine.providers.deepseek.apiKey = '';
  cfg.engine.providers.ollama = { baseUrl: 'http://127.0.0.1:11434/v1', apiKey: '', model: 'qwen3:8b' };
  assert.strictEqual(effectiveEngineProvider(cfg), null);

  // 但用户显式选了 Ollama 就得用 Ollama（本地服务不需要 Key）
  cfg.engine.provider = 'ollama';
  assert.strictEqual(effectiveEngineProvider(cfg).name, 'ollama');
});

test('DSH 模型配置：设置里的 Key 覆盖环境里残留的 DEEPSEEK_API_KEY', (t) => {
  const home = tmpHome(t);
  const prev = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = 'sk-stale-from-env';
  try {
    const env = buildDshEnv(home, configWithKeyOnDeepSeek());
    assert.strictEqual(env.DEEPSEEK_API_KEY, 'sk-deepseek-test');
    assert.strictEqual(env.DSH_HOME, home);
  } finally {
    if (prev === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = prev;
  }
});
