'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const YAML = require('yaml');
const { writeGeneratedDshSettings } = require('../core/agent/dsh-client');
const { writeDshSettings, modelFromConfig } = require('../scripts/start-dsh');
const { settingsRoute, mergePiSettings, officialDeepSeek } = require('../core/agent/dsh-provider');

test('provider merging preserves foreign providers, nested text and sibling options across route switches', context => {
  for (const write of [writeGeneratedDshSettings, (home, config) => writeDshSettings(home, modelFromConfig(config))]) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-route-'));
    context.after(() => fs.rmSync(home, { recursive: true, force: true }));
    const file = path.join(home, 'settings.yaml');
    fs.writeFileSync(file, 'llm-pi-ai:\n  providers:\n    foreign:\n      api: openai-completions\n      baseURL: https://foreign.example/v1\n      displayName: |\n        First\n\n        Second\n    tinypelican:\n      baseURL: https://stale.example/v1\n');
    for (const baseUrl of ['https://gateway.example/v1', 'https://api.deepseek.com/v1', 'https://gateway.example/v1']) {
      const config = { engine: { provider: 'deepseek', providers: { deepseek: { baseUrl, model: 'deepseek-flash', apiKey: 'test-key' } } } };
      write(home, config);
      const first = fs.readFileSync(file, 'utf8');
      const parsed = YAML.parse(first);
      assert.equal(parsed['llm-pi-ai'].providers.foreign.displayName, 'First\n\nSecond\n');
      assert.equal(parsed['llm-pi-ai'].providers.tinypelican?.baseURL, baseUrl.includes('gateway') ? baseUrl : undefined);
      assert.doesNotMatch(first, /stale\.example/);
      write(home, config);
      assert.equal(fs.readFileSync(file, 'utf8'), first);
    }
  }
  const route = settingsRoute({ baseUrl: 'https://gateway.example/v1', model: 'test' }, {}, 'Test');
  mergePiSettings(route.lines, [{ key: 'llm-pi-ai', text: 'llm-pi-ai:\n  futureOption: true\n  providers:\n    other:\n      api: openai-completions\n  anotherOption: 2' }]);
  const parsed = YAML.parse(route.lines.join('\n'))['llm-pi-ai'];
  assert.equal(parsed.futureOption, true);
  assert.equal(parsed.anotherOption, 2);
  assert.equal(parsed.providers.other.api, 'openai-completions');
  assert.equal(officialDeepSeek('https://api.deepseek.com.attacker.example/v1'), false);
});
