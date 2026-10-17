'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const YAML = require('yaml');
const {
  SYSTEM_PROMPT_PATH,
  SKILLS_PATH,
  GENERATED_DIRNAME,
  patchFile,
  AGENT_PRESET_ID,
  ensureSystemPromptPatch,
  ensureAgentPreset,
  agentPresetTemplate,
  personaText,
  systemPromptEnv
} = require('../core/agent/system-prompt');
const { buildDshEnv } = require('../core/agent/dsh-client');

const DSH_BIN = path.resolve(__dirname, '../node_modules/@deepseek-ai/dsh/lib/bin.js');
const WEB_APP_PATCH = path.resolve(__dirname, '../node_modules/@deepseek-ai/dsh-web-app/cordis.patch.yml');
const YAML_TAGS = [{
  tag: 'tag:yaml.org,2002:js',
  resolve: expression => expression
}];

function parseYaml(text) {
  return YAML.parse(text, { customTags: YAML_TAGS });
}

// 上游 bundle 的 patch 把多数行嵌在 `- insert:` 的列表里，所以按 id 找行要递归
function findRow(rows, id) {
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== 'object') continue;
    if (row.id === id) return row;
    const nested = findRow(row.insert, id);
    if (nested) return nested;
  }
  return undefined;
}

// 白标守卫：凡是会进入模型提示词/会话界的文本，都不许出现框架品牌字样。
// 只认这几种写法，避免误伤（例如工具名里的 "dsh" 前缀本来就不出现在提示词里）。
const BRAND_WORDS = [/DeepSeek Harness/, /\bDSH\b/, /deepseek-ai/, /\bharness\b/i];
function assertNoBrand(text, where = 'prompt') {
  for (const pattern of BRAND_WORDS) {
    assert.doesNotMatch(text, pattern, `${where} 里出现了框架品牌字样：${pattern}`);
  }
}

function scratchHome(context, prefix) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  context.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

// 用文件而不是管道接子进程输出：受限环境里 spawn + 管道会直接 EPERM
// （core/agent/dsh-client.js 的 runDshTaskWithFiles 就是为同一个原因存在的）。
function runToFile(command, args, { env, cwd }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-spawn-'));
  const outFile = path.join(dir, 'stdout.txt');
  const errFile = path.join(dir, 'stderr.txt');
  const outFd = fs.openSync(outFile, 'w');
  const errFd = fs.openSync(errFile, 'w');
  let result;
  try {
    result = spawnSync(command, args, { env, cwd, timeout: 30000, stdio: ['ignore', outFd, errFd] });
  } finally {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
  }
  const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
  return { status: result.status, stdout: read(outFile), stderr: read(errFile) || String(result.error || '') };
}

test('embedded DSH loads the product system prompt through its supported overlays', (context) => {
  const home = scratchHome(context, 'tp-system-prompt-');
  const expected = fs.readFileSync(SYSTEM_PROMPT_PATH, 'utf8').trim();
  assert.ok(expected.length > 0);
  assert.equal(systemPromptEnv().TINY_PELICAN_SYSTEM_PROMPT, expected);
  const env = buildDshEnv(home, {});
  assert.equal(env.TINY_PELICAN_SYSTEM_PROMPT, expected);
  const result = runToFile(process.execPath, [
    DSH_BIN,
    'web', '--patch', ensureSystemPromptPatch({ dshHome: home, surface: 'web', defaultPreset: AGENT_PRESET_ID }), '--dump-config'
  ], { env, cwd: path.resolve(__dirname, '..') });
  assert.equal(result.status, 0, result.stderr);
  const rows = parseYaml(result.stdout);
  const prompt = rows.find(row => row.id === 'system-prompt').config;
  assert.equal(prompt.personaPrefix, personaText(expected));
  assert.equal(prompt.includeHarnessIdentity, false);
  // 运行上下文整块关掉：那条注入消息（WebUI 里折叠行显示上游包名）才不会产生
  assert.equal(prompt.includeRuntimeContext, false);
  assert.match(prompt.personaSuffix, /{{cwd}}/);
  assert.ok(rows.some(row => row.id === 'tools'));
  // 生成出来的提示词里不许出现框架品牌字样（含人设里补的那段策略说明）
  assertNoBrand(prompt.personaPrefix);

  // 白标：组合结果里 Web 运行时必须是关掉表面上下文的，而且被重述的那三个键一个都不能掉
  const runtime = rows.find(row => row.id === 'web-runtime').config;
  assert.equal(runtime.surfaceContext, false);
  assert.equal(runtime.printUrl, true);
  assert.equal(runtime.openBrowser, 'ctx.webStartup.openBrowser');
  assert.equal(runtime.trustedHosts, 'ctx.webStartup.trustedHosts');
  assert.equal(rows.find(row => row.id === 'agent-presets').config.includeShippedRoot, false);
});

test('the web overlay whitepapers the harness out of the prompt surface', (context) => {
  const home = scratchHome(context, 'tp-web-patch-');
  const expected = fs.readFileSync(SYSTEM_PROMPT_PATH, 'utf8').trim();
  const webPatch = ensureSystemPromptPatch({ dshHome: home, surface: 'web', defaultPreset: AGENT_PRESET_ID });
  // 生成物落在**数据目录**，不是安装目录（打包到只读位置时就靠这个）
  assert.equal(webPatch, patchFile(home, 'web'));
  assert.ok(webPatch.startsWith(path.join(home, GENERATED_DIRNAME)));
  assert.ok(!webPatch.startsWith(path.resolve(__dirname, '..')), '不能写进代码/安装目录');
  const rows = parseYaml(fs.readFileSync(webPatch, 'utf8'));

  const roster = rows.find(row => row.id === 'agent-presets');
  assert.equal(roster.config.default, AGENT_PRESET_ID);
  // 整行 config 是替换语义：只声明我们真正要的两个键
  // （roots 走默认空数组，user 根靠 includeUserRoot 的默认 true）
  assert.deepEqual(Object.keys(roster.config), ['default', 'includeShippedRoot']);
  const webSystemPrompt = rows.find(row => row.id === 'system-prompt').config;
  assert.equal(webSystemPrompt.personaPrefix, personaText(expected));
  assert.equal(webSystemPrompt.includeRuntimeContext, false);
  assertNoBrand(webSystemPrompt.personaPrefix, 'web patch 的人设');

  // web-runtime 是**整行替换**：我们的 overlay 必须和上游那一行同键集，
  // 只把 surfaceContext 翻成 false。上游加键时这条会失败——提醒同步，
  // 否则新键会静默掉回 schema 默认值。
  const upstream = findRow(parseYaml(fs.readFileSync(WEB_APP_PATCH, 'utf8')), 'web-runtime').config;
  const ours = rows.find(row => row.id === 'web-runtime').config;
  assert.deepEqual(Object.keys(ours).sort(), Object.keys(upstream).sort());
  for (const key of Object.keys(upstream)) {
    if (key === 'surfaceContext') continue;
    assert.deepEqual(ours[key], upstream[key], `web-runtime.${key} 必须与上游逐字一致`);
  }
  assert.equal(upstream.surfaceContext, true);
  assert.equal(ours.surfaceContext, false);
  // 这两段就是会露底的 first-party 提示词，必须真的没有被别的键重新打开
  assert.ok(!rows.some(row => row.id === 'harness-source' || row.id === 'web-surface'));

  // 插件清单页（列 @deepseek-ai/dsh-* 模块名的那页）必须被关掉，
  // 而且关的必须是上游真实存在的行——打不存在的行只会得到一条警告，等于没关。
  const inventory = rows.find(row => row.id === 'ui-settings-plugin-inventory');
  assert.equal(inventory.disabled, true);
  const upstreamInventory = findRow(parseYaml(fs.readFileSync(WEB_APP_PATCH, 'utf8')), 'ui-settings-plugin-inventory');
  assert.equal(upstreamInventory.name, '@deepseek-ai/dsh-client-ui-settings-plugin-inventory');

  // 侧栏页脚常驻的「Cordis Plugin」按钮：关行即可（它只注册槽位 occupant，不提供任何服务）
  const cordis = rows.find(row => row.id === 'ui-cordis');
  assert.equal(cordis.disabled, true);
  assert.equal(findRow(parseYaml(fs.readFileSync(WEB_APP_PATCH, 'utf8')), 'ui-cordis').name,
    '@deepseek-ai/dsh-client-ui-cordis');

  // 任务（headless / xiaotihu profile）没有 web-runtime / preset roster 这些行：
  // 打不存在的行 DSH 每次启动都会打一条 "patch: entry not found" 警告。
  const taskPatch = ensureSystemPromptPatch({ dshHome: home });
  assert.equal(taskPatch, patchFile(home, 'task'));
  const taskRows = parseYaml(fs.readFileSync(taskPatch, 'utf8'));
  assert.deepEqual(taskRows.map(row => row.id), ['system-prompt']);
  assert.equal(taskRows[0].config.personaPrefix, personaText(expected));
  // 后台任务同样关掉运行上下文：那条注入消息的折叠标签就是上游包名
  assert.equal(taskRows[0].config.includeRuntimeContext, false);
  assertNoBrand(taskRows[0].config.personaPrefix, 'task patch 的人设');

  // preset 生成失败时绝不能把默认 preset 指过去（会指向不存在的 preset，新会话起不来），
  // 但白标行与部署层人设照旧——而且降级版有**自己固定的一份文件**，
  // 不能和带 roster 的那份互相覆盖（否则盘上会留着一份降级 patch）。
  const fallback = ensureSystemPromptPatch({ dshHome: home, surface: 'web' });
  assert.equal(fallback, patchFile(home, 'webFallback'));
  assert.notEqual(fallback, webPatch);
  const fallbackRows = parseYaml(fs.readFileSync(fallback, 'utf8'));
  assert.deepEqual(fallbackRows.map(row => row.id),
    ['system-prompt', 'web-runtime', 'ui-settings-plugin-inventory', 'ui-cordis']);
  assert.equal(fallbackRows.find(row => row.id === 'web-runtime').config.surfaceContext, false);
  // 降级版写过之后，带 roster 的那份文件必须还是完整的（内容互不干扰）
  const stillComplete = parseYaml(fs.readFileSync(webPatch, 'utf8'));
  assert.deepEqual(stillComplete.map(row => row.id),
    ['system-prompt', 'web-runtime', 'ui-settings-plugin-inventory', 'ui-cordis', 'agent-presets']);

  // 写不进去时（没有 DSH_HOME）返回空串：调用方省略 --patch 继续启动，绝不让 DSH 起不来
  assert.equal(ensureSystemPromptPatch({ dshHome: '' }), '');
  assert.equal(ensureSystemPromptPatch({ dshHome: home, surface: 'web' }).length > 0, true);
});

test('the generated agent preset carries the product persona and the standard abilities', async (context) => {
  const home = scratchHome(context, 'tp-agent-preset-');
  const expected = fs.readFileSync(SYSTEM_PROMPT_PATH, 'utf8').trim();

  // 模板定位规则：bin 在 `<...>/node_modules/@deepseek-ai/dsh/lib/bin.js`，
  // 「往上两级」就是 @deepseek-ai 那层。打包版没有 require.resolve 兜底，所以这里必须对得上。
  const expectedTemplate = path.resolve(path.dirname(DSH_BIN), '..', '..',
    'dsh-agent-presets', 'presets', 'standard', 'agent.cordis.yml');
  assert.equal(fs.existsSync(expectedTemplate), true, '测试前置：随包模板应存在');
  assert.equal(agentPresetTemplate(DSH_BIN), expectedTemplate);

  const preset = ensureAgentPreset({ dshHome: home, dshBin: DSH_BIN });
  assert.equal(preset.ok, true, preset.reason);
  assert.equal(preset.id, AGENT_PRESET_ID);

  const dir = path.join(home, '.agent-presets', AGENT_PRESET_ID);
  const rows = parseYaml(fs.readFileSync(path.join(dir, 'agent.cordis.yml'), 'utf8'));
  const persona = rows.find(row => row.id === 'persona');
  assert.equal(persona.name, '@deepseek-ai/dsh-persona');
  assert.equal(persona.config.prefix, personaText(expected));
  assert.equal(persona.config.includeRuntimeContext, false);
  assert.match(persona.config.suffix, /{{cwd}}/);
  assertNoBrand(persona.config.prefix, 'preset 人设');
  // 复制的是 standard preset：能力行必须都还在，不能只剩人设
  for (const id of ['agent-instructions', 'tool-fs', 'tool-pwsh', 'tool-web', 'delegation']) {
    assert.ok(rows.some(row => row.id === id), `preset 缺少 ${id} 行`);
  }

  // 技能：产品随包的技能在**安装目录**下，DSH 的默认根一个都不覆盖它（<cwd>/.dsh/skills、
  // <DSH_HOME>/skills 都不含它）。所以必须把绝对路径塞进 skill-filesystem 的 customSkillDirs，
  // 否则用户在别的文件夹工作时这 6 个技能等于不存在。
  const skills = rows.find(row => row.id === 'skill-filesystem');
  assert.equal(skills.name, '@deepseek-ai/dsh-skill-filesystem');
  assert.deepEqual(skills.config.customSkillDirs, [SKILLS_PATH]);
  assert.equal(path.isAbsolute(SKILLS_PATH), true, '必须是绝对路径：打包后用户工作目录在别处');
  assert.ok(fs.existsSync(SKILLS_PATH), '测试前置：随包技能目录应存在');
  assert.match(persona.config.prefix, new RegExp(SKILLS_PATH.replace(/[\\^$*+?.()|[\]{}]/g, '\\$&')), '人设里要说明产品文件在哪');

  const meta = parseYaml(fs.readFileSync(path.join(dir, 'preset.yml'), 'utf8'));
  assert.equal(meta.name, '小鹈鹕');
  assert.equal(typeof meta.description, 'string');
  assert.equal(meta.order, 0);

  // 让 DSH 自己的发现逻辑判一次健康：它会把组装缺行 / 引用了装不上的插件的 preset 判成 broken
  const { scanRoot } = await import('@deepseek-ai/dsh-agent-presets');
  const harnessBase = `file:///${path.resolve(__dirname, '../node_modules').replace(/\\/g, '/')}/`;
  const discovered = await scanRoot({ path: path.join(home, '.agent-presets'), trust: 'user' }, harnessBase);
  assert.deepEqual(discovered.map(row => row.id), [AGENT_PRESET_ID]);
  assert.equal(discovered[0].broken, undefined, discovered[0].broken);
  assert.equal(discovered[0].name, '小鹈鹕');

  // 二次调用必须幂等（DSH 按 mtime+size 记录 preset 代际，反复改写会让它一直重开）
  const before = fs.statSync(path.join(dir, 'agent.cordis.yml')).mtimeMs;
  assert.equal(ensureAgentPreset({ dshHome: home, dshBin: DSH_BIN }).ok, true);
  assert.equal(fs.statSync(path.join(dir, 'agent.cordis.yml')).mtimeMs, before);

  // 生成不了（没有 DSH_HOME / id 不合法）时要返回失败而不是抛异常：
  // 调用方据此退回只打部署层，会话照常能起来。
  assert.equal(ensureAgentPreset({ dshHome: '' }).ok, false);
  assert.equal(ensureAgentPreset({ dshHome: home, id: 'Bad_Id' }).ok, false);
});

test('desktop distribution includes the canonical product prompt and skills', () => {
  const packageConfig = require('../app/package.json');
  const resources = packageConfig.build.extraResources;
  assert.ok(resources.some(resource =>
    resource.from === '../agent/Agent.md' && resource.to === 'content/agent/Agent.md'));
  // 技能目录也得进安装包：它不在 DSH 的任何默认技能根里，靠 preset 的绝对路径指过来
  assert.ok(resources.some(resource =>
    resource.from === '../agent/skills' && resource.to === 'content/agent/skills'));
});
