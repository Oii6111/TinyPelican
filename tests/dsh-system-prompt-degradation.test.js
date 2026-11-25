'use strict';

// 产品人设的降级必须是可见的。
// 回归点：agentPresetTemplate 原本只靠 require.resolve 的默认解析，生产能走通
// 是因为 core/lib/startup.js 把 vendor 目录塞进了 NODE_PATH；任何没先加载 startup
// 的入口（测试、脚本、新启动路径）都会解析失败，然后静默退回不带人设的 fallback
// overlay —— 界面看不出异常，产品人设其实没生效。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { agentPresetTemplate, ensureSystemPromptPatch, patchFile } = require('../core/agent/system-prompt');

const root = path.resolve(__dirname, '..');

test('agent preset 模板显式解析，不依赖 NODE_PATH 副作用', () => {
  const template = agentPresetTemplate();
  assert.ok(template, '应能找到 DSH 随附的 standard preset 模板');
  assert.ok(fs.existsSync(template), `模板文件不存在：${template}`);
  assert.ok(template.endsWith(path.join('dsh-web-app', 'presets', 'standard.patch.yml')), template);
  assert.ok(template.startsWith(root), `模板应落在项目/安装根内：${template}`);
});

test('generation honours the install layout instead of the process NODE_PATH', () => {
  const saved = process.env.NODE_PATH;
  delete process.env.NODE_PATH;
  require('node:module')._initPaths();
  try {
    assert.ok(agentPresetTemplate(), '清掉 NODE_PATH 后仍应解析到模板');
  } finally {
    process.env.NODE_PATH = saved;
    require('node:module')._initPaths();
  }
});

test('人设生成失败时不再静默降级', (context) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-degrade-'));
  context.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args.map(String).join(' '));
  try {
    const patch = ensureSystemPromptPatch({ dshHome: home, surface: 'web', defaultPreset: 'BAD ID' });
    assert.equal(patch, patchFile(home, 'webFallback'), '生成失败时应退回 web-fallback');
    assert.ok(warnings.some(line => line.includes('[system-prompt]')), `没有留下告警：${warnings.join(' | ')}`);
    assert.ok(warnings.some(line => /standard preset/.test(line)), `告警没说明后果：${warnings.join(' | ')}`);
  } finally {
    console.warn = original;
  }
});
