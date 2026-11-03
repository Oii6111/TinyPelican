'use strict';

const API_KEY_ENV = 'TINYPELICAN_MODEL_API_KEY';

function officialDeepSeek(baseUrl) {
  try { return new URL(baseUrl).origin === 'https://api.deepseek.com'; } catch { return false; }
}

function settingsRoute(prov, facts, label) {
  const quote = value => JSON.stringify(String(value));
  const official = officialDeepSeek(prov.baseUrl);
  const provider = official ? 'deepseek-official' : 'tinypelican';
  const modelLines = [
    `      - id: ${quote(prov.model)}`,
    `        name: ${quote(`${prov.model} · ${label}`)}`,
    `        contextWindow: ${Number(prov.entry?.contextWindow) || 131072}`
  ];
  if (official) {
    return { provider, lines: [
      'llm-deepseek:',
      '  baseURL: "https://api.deepseek.com/anthropic"',
      `  apiKeyEnv: ${API_KEY_ENV}`,
      '  models:',
      ...modelLines.map(line => line.slice(2)),
      ...(facts.image ? ['      inputModalities: [text, image]'] : []),
      ...(facts.inHistorySystemPrompt ? ['      systemPromptUpdate: in-history'] : [])
    ] };
  }
  return { provider, lines: [
    'llm-pi-ai:',
    '  providers:',
    '    tinypelican:',
    `      displayName: ${quote(label)}`,
    '      api: openai-completions',
    `      baseURL: ${quote(prov.baseUrl.replace(/\/+$/, ''))}`,
    `      apiKeyEnv: ${API_KEY_ENV}`,
    '      models:',
    ...modelLines.map(line => `  ${line}`),
    `          input: [text${facts.image ? ', image' : ''}]`
  ] };
}

function mergePiSettings(lines, blocks) {
  const foreign = blocks.find(block => block.key === 'llm-pi-ai');
  if (!foreign) return blocks;
  const source = foreign.text.split('\n');
  const providers = [];
  const siblings = [];
  let inProviders = false;
  let skip = false;
  for (const line of source.slice(1)) {
    if (/^  \S/.test(line)) {
      inProviders = /^  providers:\s*(?:#.*)?$/.test(line);
      skip = false;
      if (inProviders) continue;
    }
    if (inProviders && /^    \S/.test(line)) {
      skip = /^    (?:tinypelican|["']tinypelican["']):/.test(line);
    }
    if (!skip) (inProviders ? providers : siblings).push(line);
  }
  while (providers.length && !providers.at(-1).trim()) providers.pop();
  while (siblings.length && !siblings.at(-1).trim()) siblings.pop();
  if (lines.includes('llm-pi-ai:')) {
    lines.push(...providers, ...siblings);
  } else if (providers.length || siblings.length) {
    lines.push('', 'llm-pi-ai:', ...(providers.length ? ['  providers:', ...providers] : []), ...siblings);
  }
  return blocks.filter(block => block !== foreign);
}

module.exports = { API_KEY_ENV, officialDeepSeek, settingsRoute, mergePiSettings };
