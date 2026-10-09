'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pelican-topics-'));
process.env.XIAOTIHU_DATA_DIR = directory;
const chat = require('../core/memory/chat-db');
const store = require('../core/reply/suggestion-store');
const { generateReplySuggestions, regenerateRemaining, normalizePlans } = require('../core/reply/suggestions');
const { chatCompletion } = require('../core/engine/client');
const config = { capture: { enabled: true, replySuggestions: { enabled: true } }, userPersona: '人设标记-自然从容', selfNicknames: ['我'], engine: { provider: 'deepseek', smallModel: 'never-use-for-replies', retries: 0, providers: { deepseek: { baseUrl: 'http://mock.local/v1', model: 'chosen-model', apiKey: 'test' } } } };
chat.ingestMessages('测试联系人', [{ name: '测试联系人', ts: new Date().toISOString(), type: 'text', content: '最新聊天' }]);
chat.updateMember('测试联系人', { profile: { 基础身份: { 所在城市: '城市标记' }, 行为意向: { 周末安排: '未知' } } });
chat.db.prepare('UPDATE member SET chat_summary_json=?').run(JSON.stringify({ summary: '累计总结标记' }));
after(() => { chat.db.close(); fs.rmSync(directory, { recursive: true, force: true }); });

test('四个方向及换一批/思考保持方向；新复制恢复普通回复；快深上下文隔离', async () => {
  const originalFetch = global.fetch;
  const payloads = [];
  global.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    payloads.push(body);
    const prompt = body.messages[0].content;
    const plans = prompt.includes('可选了解目标') ? [{ tone: '轻松', messages: ['周末喜欢出去走走还是在家休息？'], profileTargetId: 'interests:周末安排' }] : [{ tone: '自然', messages: ['最近有什么好玩的？'] }];
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(plans) } }] }), { status: 200 });
  };
  try {
    store.invalidate();
    assert.equal((await generateReplySuggestions({ contact: '测试联系人', config })).ok, true);
    for (const direction of ['casual', 'discover', 'history']) {
      const result = await generateReplySuggestions({ newTopic: true, direction, config });
      assert.equal(result.ok, true, result.error);
      assert.equal(result.suggestion.direction, direction);
      const rotated = await generateReplySuggestions({ rotate: true, deep: true, config });
      assert.equal(rotated.suggestion.direction, direction);
      const deep = payloads.at(-1);
      assert.equal(deep.model, 'chosen-model');
      assert.equal(deep.thinking.type, 'enabled');
      assert.match(deep.messages[0].content, /人设标记/);
      assert.match(deep.messages[0].content, /累计总结标记/);
      assert.match(deep.messages[0].content, /城市标记/);
    }
    const copied = await generateReplySuggestions({ contact: '测试联系人', config });
    assert.equal(copied.suggestion.mode, 'reply');
    const fast = payloads.at(-1);
    assert.equal(fast.model, 'chosen-model');
    assert.equal(fast.thinking.type, 'disabled');
    assert.doesNotMatch(fast.messages[0].content, /人设标记|累计总结标记/);
    store.setActivePlan(copied.suggestion.id, { sent: ['先聊一句'], remaining: ['后面一句'] });
    assert.equal((await regenerateRemaining({ config, deep: true })).ok, true);
    assert.match(payloads.at(-1).messages[0].content, /人设标记/);
    assert.equal((await regenerateRemaining({ config })).ok, true);
    assert.doesNotMatch(payloads.at(-1).messages[0].content, /人设标记|累计总结标记/);
  } finally { global.fetch = originalFetch; }
});

test('新鲜话题失败保留旧建议、来源编号和了解目标须来自当前上下文', async () => {
  const old = store.getCurrent();
  const failed = await generateReplySuggestions({ newTopic: true, direction: 'fresh', config });
  assert.equal(failed.ok, false);
  assert.equal(store.getCurrent().id, old.id);
  assert.equal(store.getPending(), null);
  const sources = [{ id: 'source-1', url: 'https://example.com', title: '可信编号' }];
  assert.equal(normalizePlans([{ messages: ['伪造来源'], sourceIds: ['fake'] }], { direction: 'fresh', sources }).length, 0);
  assert.deepEqual(normalizePlans([{ messages: ['分享正文'], sourceIds: ['source-1'] }], { direction: 'fresh', sources })[0].messages, ['分享正文']);
  assert.equal(normalizePlans([{ messages: ['询问隐私'], profileTargetId: 'fake' }], { direction: 'discover', gaps: [] }).length, 0);
});

test('DeepSeek、SiliconFlow、Ollama显式开关与自定义参数适配', async () => {
  const originalFetch = global.fetch;
  const requests = [];
  global.fetch = async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    return new Response(JSON.stringify({ message: { content: 'ok' }, choices: [{ message: { content: 'ok' } }] }));
  };
  try {
    for (const provider of ['deepseek', 'siliconflow', 'ollama']) {
      const cfg = { engine: { provider, providers: { [provider]: { baseUrl: 'http://localhost:1234/v1', apiKey: 'test', model: 'selected' } } } };
      for (const thinking of [false, true]) assert.equal((await chatCompletion([{ role: 'user', content: 'hi' }], { config: cfg, thinking })).ok, true);
    }
    assert.deepEqual(requests.slice(0, 2).map((request) => request.body.thinking.type), ['disabled', 'enabled']);
    assert.deepEqual(requests.slice(2, 4).map((request) => request.body.enable_thinking), [false, true]);
    assert.deepEqual(requests.slice(4, 6).map((request) => request.body.think), [false, true]);
    assert.equal(requests[4].url, 'http://localhost:1234/api/chat');
    const custom = { engine: { provider: 'custom', providers: { custom: { baseUrl: 'http://local/v1', apiKey: 'test', model: 'chosen' } } } };
    assert.match((await chatCompletion([], { config: custom, thinking: true })).error, /思考开关/);
    custom.engine.providers.custom.thinkingBody = { reasoning_effort: 'high' };
    assert.equal((await chatCompletion([], { config: custom, thinking: true })).ok, true);
    assert.equal(requests.at(-1).body.reasoning_effort, 'high');
  } finally { global.fetch = originalFetch; }
});

test('新鲜话题搜索阶段、来源绑定与换批避开已使用事件', async () => {
  const originalFetch = global.fetch;
  const seen = [];
  let searches = 0;
  const cfg = { ...config, webSearch: { enabled: true, searxng: { baseUrl: 'http://mock-search.local' } } };
  global.fetch = async (url, options) => {
    if (String(url).includes('/search?')) {
      searches++;
      assert.equal(store.sanitizePending(store.getPending()).stage, 'searching');
      return new Response(JSON.stringify({ results: [1, 2, 3].map((index) => ({ title: '事件' + index, content: '可核对的事件摘要', url: `https://example.com/event${index}` })) }));
    }
    const body = JSON.parse(options.body);
    const prompt = body.messages[0].content;
    assert.equal(store.getPending().stage, 'generating');
    const sources = JSON.parse(prompt.split('本次搜索来源：\n')[1].split('\n')[0]);
    seen.push(sources);
    assert.match(prompt, /发布时间未知/);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify([{ tone: '分享', messages: ['看到一件挺有意思的事'], sourceIds: [sources[0].id] }]) } }] }));
  };
  try {
    const result = await generateReplySuggestions({ newTopic: true, direction: 'fresh', config: cfg });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.suggestion.plans[0].sources[0].url, 'https://example.com/event1');
    assert.deepEqual(result.suggestion.plans[0].messages, ['看到一件挺有意思的事']);
    assert.equal(result.suggestion.plans[0].sources[0].publishedAt, null);
    const rotated = await generateReplySuggestions({ rotate: true, config: cfg });
    assert.equal(rotated.ok, true, rotated.error);
    assert.equal(rotated.suggestion.plans[0].sources[0].url, 'https://example.com/event2');
    assert.equal(seen[1].some((source) => source.url.endsWith('event1')), false);
    assert.equal(searches, 1);
  } finally { global.fetch = originalFetch; }
});
