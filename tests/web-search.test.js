'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const search = require('../core/channels/web-search');
const { maskConfig, restoreMaskedKeys } = require('../core/api/models');

async function server(handler) {
  const instance = http.createServer(async (request, response) => {
    let body = '';
    for await (const piece of request) body += piece;
    const result = await handler(request, body ? JSON.parse(body) : null);
    if (result === null) return;
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(result));
  });
  await new Promise((resolve) => instance.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${instance.address().port}`, close: () => { instance.closeAllConnections(); instance.close(); } };
}
test('SearXNG JSON、最近七天、来源去重、未知日期与十五分钟缓存', async () => {
  let calls = 0;
  const mock = await server((request) => {
    calls++;
    const url = new URL(request.url, 'http://localhost');
    assert.equal(url.searchParams.get('format'), 'json');
    assert.equal(url.searchParams.get('time_range'), 'week');
    return { results: [
      { title: '有趣的事', url: 'https://example.com/story', content: '故事摘要' },
      { title: '重复', url: 'https://example.com/story#part', content: '摘要' },
      { title: '另一个事件', url: 'https://example.com/new', content: '事件摘要', publishedDate: '2026-09-24' },
      { title: '无效', url: 'javascript:alert(1)', content: '无效' }
    ] };
  });
  try {
    const config = { webSearch: { enabled: true, searxng: { baseUrl: mock.url } } };
    const result = await search.search('缓存用测试查询', config);
    assert.equal(result.results.length, 2);
    assert.equal(result.results[0].publishedAt, null);
    assert.equal(result.results[0].provider, 'searxng');
    assert.equal(result.results[1].publishedAt, '2026-09-24T00:00:00.000Z');
    assert.equal((await search.search('缓存用测试查询', config)).cached, true);
    assert.equal(calls, 1);
    const originalNow = Date.now;
    Date.now = () => originalNow() + 16 * 60000;
    try { await search.search('缓存用测试查询', config); } finally { Date.now = originalNow; }
    assert.equal(calls, 2);
  } finally { mock.close(); }
});

test('Kimi 保留完整工具调用消息及原始 arguments，最多四轮，失败走已配置备用服务', async () => {
  let calls = 0;
  const assistant = { role: 'assistant', content: null, reasoning_content: 'provider-required', tool_calls: [{ id: 'search-call', type: 'function', function: { name: '$web_search', arguments: '{ "query": "科技", "search_results": [] }' } }] };
  const mock = await server((request, body) => {
    if (request.url.startsWith('/search')) return { results: [] };
    calls++;
    assert.equal(body.tools[0].type, 'builtin_function');
    if (calls === 1) return { choices: [{ message: assistant }] };
    assert.deepEqual(body.messages[2], assistant);
    assert.equal(body.messages[3].content, assistant.tool_calls[0].function.arguments);
    return { choices: [{ message: { role: 'assistant', content: JSON.stringify({ results: [{ title: '来源', url: 'https://example.com/kimi', snippet: '检索结果', publishedAt: null }] }) } }] };
  });
  try {
    const config = { webSearch: { enabled: true, provider: 'searxng', fallback: 'moonshot', searxng: { baseUrl: mock.url }, moonshot: { baseUrl: mock.url, apiKey: 'test-secret', model: 'test-model' } } };
    const result = await search.search('备用查询', config);
    assert.equal(result.results[0].provider, 'moonshot');
    assert.equal(calls, 2);
    const masked = maskConfig(config);
    assert.ok(!JSON.stringify(masked).includes('test-secret'));
    restoreMaskedKeys(config, masked);
    assert.equal(masked.webSearch.moonshot.apiKey, 'test-secret');
  } finally { mock.close(); }
  let rounds = 0;
  const endless = await server(() => { rounds++; return { choices: [{ message: assistant }] }; });
  try {
    await assert.rejects(search.search('循环', { webSearch: { enabled: true, provider: 'moonshot', moonshot: { baseUrl: endless.url, apiKey: 'test' } } }), /轮次过多/);
    assert.equal(rounds, 4);
  } finally { endless.close(); }
});

test('未启用不请求网络、超时可重试、查询不含身份及私密原文', async () => {
  await assert.rejects(search.search('不应发送', { webSearch: { enabled: false } }), /未启用/);
  const query = search.topicQuery({ 基础身份: { 姓名: '绝不发送姓名', 城市: '私人城市' }, 行为意向: { 爱好: '音乐', 经历: '私人故事' } });
  assert.ok(query.includes('音乐'));
  assert.ok(!/绝不发送|私人/.test(query));
  const mock = await server(() => null);
  try { await assert.rejects(search.search('超时', { webSearch: { enabled: true, timeoutMs: 1000, searxng: { baseUrl: mock.url } } })); }
  finally { mock.close(); }
});
