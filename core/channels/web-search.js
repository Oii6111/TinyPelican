'use strict';

const cache = new Map();
const MAX_CACHE = 100;

function searchConfig(config = {}) {
  const input = config.webSearch || {};
  return {
    enabled: input.enabled === true,
    provider: ['searxng', 'moonshot'].includes(input.provider) ? input.provider : 'searxng',
    fallback: ['searxng', 'moonshot'].includes(input.fallback) ? input.fallback : '',
    timeoutMs: Math.min(180000, Math.max(1000, Number(input.timeoutMs) || 45000)),
    maxResults: Math.min(10, Math.max(1, Number(input.maxResults) || 6)),
    searxng: { baseUrl: String(input.searxng?.baseUrl || '').replace(/\/+$/, '') },
    moonshot: { baseUrl: String(input.moonshot?.baseUrl || 'https://api.moonshot.cn/v1').replace(/\/+$/, ''), apiKey: String(input.moonshot?.apiKey || ''), model: String(input.moonshot?.model || 'kimi-k2.6') }
  };
}

function ready(provider, config) {
  return provider === 'searxng' ? !!config.searxng.baseUrl : provider === 'moonshot' && !!config.moonshot.apiKey;
}

function status(config) {
  const current = searchConfig(config);
  return { enabled: current.enabled, provider: current.provider, fallback: current.fallback, ready: current.enabled && ready(current.provider, current), engines: { searxng: ready('searxng', current), moonshot: ready('moonshot', current) } };
}

async function fetchJson(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    if (!response.ok) throw new Error(`搜索服务返回 ${response.status}，请检查地址、密钥或服务额度`);
    try { return JSON.parse(text); } catch { throw new Error('搜索服务未返回 JSON；SearXNG 需在 settings.yml 中开启 json 格式'); }
  } finally { clearTimeout(timer); }
}

function validUrl(value) {
  try { const url = new URL(value); return /^https?:$/.test(url.protocol) && !url.username && !url.password ? url.href : ''; } catch { return ''; }
}

function normalize(item, provider) {
  const published = item.publishedDate || item.published_at || item.publishedAt || null;
  return {
    title: String(item.title || item.name || '来源').slice(0, 200),
    url: validUrl(item.url || item.link),
    snippet: String(item.content || item.snippet || item.description || '').slice(0, 800),
    provider,
    fetchedAt: new Date().toISOString(),
    publishedAt: published && Number.isFinite(Date.parse(published)) ? new Date(published).toISOString() : null
  };
}

async function searxng(query, config) {
  const url = new URL(`${config.searxng.baseUrl}/search`);
  url.search = new URLSearchParams({ q: query, format: 'json', safesearch: '1', time_range: 'week', language: 'zh-CN' }).toString();
  const data = await fetchJson(url, { headers: { Accept: 'application/json' } }, config.timeoutMs);
  return { results: (data.results || []).slice(0, config.maxResults).map((item) => normalize(item, 'searxng')) };
}

async function moonshot(query, config) {
  const settings = config.moonshot;
  const url = /\/chat\/completions$/.test(settings.baseUrl) ? settings.baseUrl : `${settings.baseUrl}/chat/completions`;
  const body = {
    model: settings.model,
    messages: [
      { role: 'system', content: '你是联网搜索助手。使用实时搜索查找最近七天有趣、适合日常聊天的热门事情。只返回 JSON：{"results":[{"title":"标题","url":"原始来源链接","snippet":"事实摘要","publishedAt":null}]}。日期只填写来源明确提供的日期，否则为 null。不可编造链接或声称没有日期的事件发生在今天。' },
      { role: 'user', content: query }
    ],
    tools: [{ type: 'builtin_function', function: { name: '$web_search' } }]
  };
  let usedSearch = false;
  for (let round = 0; round < 4; round++) {
    const data = await fetchJson(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.apiKey}` }, body: JSON.stringify(body) }, config.timeoutMs);
    const message = data.choices?.[0]?.message;
    if (!message) throw new Error('Kimi 搜索返回结构异常');
    const calls = message.tool_calls || [];
    if (!calls.length) {
      if (!usedSearch) throw new Error('Kimi 未执行联网搜索，请检查模型是否支持 $web_search');
      let parsed;
      try { parsed = JSON.parse(String(message.content || '').replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { throw new Error('Kimi 搜索未返回可核对的结构化来源，请重试'); }
      return { results: (parsed.results || []).slice(0, config.maxResults).map((item) => normalize(item, 'moonshot')) };
    }
    body.messages.push(message);
    for (const call of calls) {
      if (call.function?.name !== '$web_search') throw new Error('Kimi 返回了不支持的搜索工具');
      usedSearch = true;
      body.messages.push({ role: 'tool', tool_call_id: call.id, name: call.function.name, content: call.function.arguments || '{}' });
    }
  }
  throw new Error('Kimi 搜索轮次过多，请重试');
}

async function search(query, config, { bypassCache = false } = {}) {
  const settings = searchConfig(config);
  if (!settings.enabled) throw new Error('联网搜索未启用，请到设置 → 联网搜索配置');
  const chain = [...new Set([settings.provider, settings.fallback].filter((provider) => ready(provider, settings)))];
  if (!chain.length) throw new Error('联网搜索服务未配置，请到设置 → 联网搜索填写地址或密钥');
  const key = JSON.stringify([String(query), settings]);
  const stored = cache.get(key);
  if (!bypassCache && stored && stored.expiresAt > Date.now()) return { ...stored.data, cached: true };
  const rows = [];
  const errors = [];
  for (const provider of chain) {
    try {
      const result = await (provider === 'searxng' ? searxng : moonshot)(String(query).slice(0, 300), settings);
      rows.push(...result.results.filter((item) => item.url && item.snippet));
      if (rows.length >= Math.min(3, settings.maxResults)) break;
    } catch (error) { errors.push(error.message); }
  }
  const seen = new Set();
  const results = rows.filter((item) => {
    const normalized = item.url.replace(/#.*$/, '');
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  }).slice(0, settings.maxResults).map((item, index) => ({ ...item, id: `source-${index + 1}` }));
  if (!results.length) throw new Error(errors.join('；') || '没有找到带来源的新鲜内容，请重试或切换方向');
  const data = { query, results, fetchedAt: new Date().toISOString(), warnings: errors };
  if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
  cache.set(key, { data, expiresAt: Date.now() + 15 * 60000 });
  return data;
}

function topicQuery(profile = {}) {
  const text = JSON.stringify(profile['行为意向'] || {});
  const topics = ['音乐', '电影', '游戏', '运动', '美食', '旅行', '科技', '阅读', '摄影', '宠物', '书籍', '影视'].filter((word) => text.includes(word)).slice(0, 2);
  return `${new Date().toISOString().slice(0, 10)} 最近七天 ${topics.join(' ') || '生活 科技 文化'} 有趣 热门 新鲜事`;
}

module.exports = { search, status, topicQuery, searchConfig, validUrl };
