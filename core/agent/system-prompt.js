'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SYSTEM_PROMPT_PATH = path.resolve(__dirname, '../../agent/Agent.md');
// 产品随包的技能目录（records-query / todo / reminder / schedule / intent-review / chat-search）。
// 它属于**产品本体**，不是用户的工作目录——打包后是 <安装目录>/resources/content/agent/skills。
const SKILLS_PATH = path.resolve(__dirname, '../../agent/skills');
// 生成物一律写到**数据目录**（$DSH_HOME/<这个目录名>/），不写安装目录：
// 打包成 per-user 安装时安装目录可写，但装到 Program Files 或只读/签名目录就写不进去——
// 而 patch 写不进去会让 DSH 直接起不来。见 ensureSystemPromptPatch。
const GENERATED_DIRNAME = 'tinypelican';
// 每种面各一份**固定**文件名的 overlay（别共用一个路径：谁最后写谁赢，盘上会留下降级版）
const PATCH_FILENAMES = {
  task: 'system-prompt.patch.yml',
  web: 'system-prompt.web.patch.yml',
  webFallback: 'system-prompt.web-fallback.patch.yml'
};

// 产品自己的 agent preset id。DSH 要求 id 匹配 [a-z0-9][a-z0-9-]*（它同时是目录名），
// 且不能和随附的 standard/minimal/ptc/cordis 撞名——随附根目录同 id 优先，撞了就永远轮不到我们。
const AGENT_PRESET_ID = 'tinypelican';
// DSH 存放「本地创作的 preset」的目录名（dsh-agent-presets 的 USER_PRESET_DIR）。
// 它挂在 $DSH_HOME 下，是 roster 默认就包含的 user 根目录。
const AGENT_PRESET_DIRNAME = '.agent-presets';
// DSH 随附的模板 preset：我们整份复制它，只换掉 persona（人设）那一段，
// 这样工具 / skills / 工作流等能力跟着 DSH 版本走，不用自己维护一份组装文件。
// 注意路径规则：dis 的 bin 在 `<...>/node_modules/@deepseek-ai/dsh/lib/bin.js`，
// 所以「往上两级」= `@deepseek-ai/` 那一层，下面这段**不能再带** `@deepseek-ai/` 前缀。
const AGENT_PRESET_TEMPLATE = path.join('dsh-agent-presets', 'presets', 'standard', 'agent.cordis.yml');
// 与 DSH 随附的 standard preset、dsh-headless 保持同一句
const PERSONA_SUFFIX = 'Your working directory is {{cwd}}.';

// 关掉运行上下文（includeRuntimeContext: false）换来的这份说明。
//
// 为什么要关：DSH 会把「运行上下文」作为一条 **user 角色消息**写进会话日志，
// WebUI 对话里渲染成一个可展开的注入行，**折叠状态显示的正是来源插件名**
// （dsh-client-ui-chat 的 ContextInjectionRow → provenance.label），也就是
// `@deepseek-ai/dsh-system-prompt`；展开才是 "Current DSH file policy: …"。用户一眼就能看到。
// 而 dsh-agent-loop 的 project() 里有一句：`if (this.retained === void 0 && current.length === 0) return;`
// —— 只要**从第一步起**就没有运行上下文，那条注入消息根本不会产生，标签与正文一起消失。
//
// 代价是模型不再被告知文件策略与审批策略（原来两句话），所以在这里给一段**等价但不含任何
// 品牌字样**的说明。它进的是人设（= 系统提示），不会在对话界面里显示。
// 措辞故意不写死具体模式：模式是**按会话**定的（权限预设），会随设置变；写死会撒谎。
// 真正的兜底是工具被拒时返回的 `[sandbox: file access denied under <mode> mode]` 标记。
const POLICY_NOTES = [
  'Host policy for tool use: file writes are checked by the host application and contained to the session',
  'workspace (reads are not restricted). A blocked operation reports a `[sandbox: file access denied under',
  '<mode> mode]` marker — that is a policy denial, not a bug, so do not retry it another way. Operations that',
  'require approval may be asked of the user; when no answerer is available the request fails closed.'
].join(' ');

// 人设正文 = 产品自己写的 Agent.md + 上面那份说明 + 一段「产品文件 vs 用户工作目录」的定位说明。
// 为什么要第三段：打包后**产品本体在安装目录，用户在别的地方工作**，两者不是一个目录。
// 提示词里若出现 `agent/skills/` 这类相对路径，模型会去用户的工作目录里找（找不到）。
// 所以这里给出运行时才算得出来的**绝对路径**，并明确两者不同。
// 注意 Agent.md 里若写了 {{...}}，DSH 会当提示词变量渲染（只认 {{cwd}} / {{model}} 这类已注册的）。
function personaText(prompt, { skillsDir = SKILLS_PATH } = {}) {
  const layout = [
    "Product layout: this product's own files (its agent instructions and the skills exposed in the skill",
    `catalog) live under \`${skillsDir}\`. That is the product installation, NOT the user's`,
    'working directory: the working directory is the user\'s own project and may be anywhere. Never assume',
    'the product folder is inside the working directory, and never write product-owned files into it.'
  ].join(' ');
  return `${prompt}\n\n${POLICY_NOTES}\n\n${layout}`;
}

function readSystemPrompt() {
  const prompt = fs.readFileSync(SYSTEM_PROMPT_PATH, 'utf8').trim();
  if (!prompt) throw new Error('小鹈鹕系统提示词不能为空：agent/Agent.md');
  return prompt;
}

function systemPromptEnv() {
  return { TINY_PELICAN_SYSTEM_PROMPT: readSystemPrompt() };
}

// 内容没变就不动文件：DSH 按 mtime+size 记录 preset 的 stamp，
// 反复改写会让它一直重开代际。
function writeIfChanged(file, content) {
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === content) return false;
  fs.writeFileSync(file, content, 'utf8');
  return true;
}

// 定位 DSH 随附的 standard preset 模板：
// 1. 与 dsh 的 lib/bin.js 同一次安装（开发时 node_modules/@deepseek-ai/，
//    打包后 vendor/node_modules/@deepseek-ai/ —— 两种布局都是 bin 往上两级）
// 2. 从本进程解析（开发机 / 测试兜底）
function agentPresetTemplate(dshBin = '') {
  const candidates = [];
  if (dshBin) candidates.push(path.resolve(path.dirname(dshBin), '..', '..', AGENT_PRESET_TEMPLATE));
  try {
    candidates.push(path.join(
      path.dirname(require.resolve('@deepseek-ai/dsh-agent-presets/package.json')),
      'presets', 'standard', 'agent.cordis.yml'
    ));
  } catch {}
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return '';
}

// 小鹈鹕人设那一行（结构照抄 standard preset 的 persona 行）
// includeRuntimeContext: false —— 见 POLICY_NOTES 的注释：关掉运行上下文注入，
// 连带消掉 WebUI 对话里那条带 `@deepseek-ai/dsh-system-prompt` 标签的注入行。
function personaLines(prompt, options = {}) {
  return [
    '- id: persona',
    "  name: '@deepseek-ai/dsh-persona'",
    '  config:',
    `    prefix: ${JSON.stringify(personaText(prompt, options))}`,
    `    suffix: ${JSON.stringify(PERSONA_SUFFIX)}`,
    '    includeRuntimeContext: false'
  ];
}

// Web 面的「白标」行：用户不该从模型的嘴里听出底下是 DSH。
//
// 1) web-runtime.surfaceContext: false —— 这一个开关同时注销两段 first-party 提示词
//    （dsh-web-app/README 明确写了「为 false 时两段和该变量都不注册」）：
//      · harness:source  —— "The DeepSeek Harness implementation checkout is at …"
//      · app:web-surface —— "You are interacting with the user through the DeepSeek Harness Web GUI at …"
//    顺带 DSH_WEB_URL 不再作为受管变量出现在 agent 的 shell 环境里（我们的代码/skills 不依赖它）。
//    ⚠ 整行 config 是**替换**语义（实测：只写 surfaceContext 时，dump 出来的这行就只剩它一个键），
//    所以 openBrowser / printUrl / trustedHosts 必须原样重述，否则掉回 schema 默认值：
//    openBrowser=true 会自己弹浏览器、trustedHosts=[] 会改变浏览器信任围栏。
//    这三行与 dsh-web-app/cordis.patch.yml 里那一行逐字一致；测试会对照上游文件校验键集，
//    上游加键时测试会失败，提醒我们同步（否则那个新键会静默掉回默认值）。
// 2) agent-presets.includeShippedRoot: false（在 ensureSystemPromptPatch 里）——
//    预设选择器里不再出现随附的 standard / ptc / cordis / minimal：其中 cordis 的人设
//    直接写着 "running on the DeepSeek Harness"，用户选中就会露底。
//    我们自己的 preset 是 standard 的自包含副本，能力不受影响。
//    ⚠ 代价：以后若要用 `DSH_TOOLS_MODE=ptc`，需要随附的 ptc preset，得把这一项去掉。
// 3) 关掉「插件清单」页（`ui-settings-plugin-inventory`）——它会列出 `@deepseek-ai/dsh-*`
//    的模块名、entry id、Loader/Fiber 状态和随附 preset 的名字，是最直白的"框架说明书"。
//    该页只是往 `settings.plugins.tab` 槽位注册的一个 tab（槽位由 ui-settings-plugins 声明），
//    关掉它不影响那个槽位与另一个"可配置"tab。
// 4) 关掉 `ui-cordis` —— 它在侧栏页脚常驻一个「Cordis Plugin」按钮（点开是动态插件面板）。
//    该行只往 `sidebar.footer.action` / `tool.call.toolview` 注册 occupant，不提供任何服务，
//    关掉安全。⚠ 别把关 `cordis-client-runner`：`dynamicCordisRunner` 由它提供。
const WEB_SURFACE_ROWS = [
  '- id: web-runtime',
  '  config:',
  '    openBrowser: !!js ctx.webStartup.openBrowser',
  '    printUrl: true',
  '    surfaceContext: false',
  '    trustedHosts: !!js ctx.webStartup.trustedHosts',
  '- id: ui-settings-plugin-inventory',
  '  disabled: true',
  '- id: ui-cordis',
  '  disabled: true'
];

// 把模板里的 `- id: persona` 整块换成小鹈鹕人设；模板里没有这一行就补在最前面。
// 只做这一处文本手术：模板其余内容（含 !!js 表达式与注释）原样保留。
function withProductPersona(template, prompt, options = {}) {
  const lines = template.split(/\r?\n/);
  const start = lines.findIndex((line) => /^- id: persona\s*$/.test(line));
  if (start < 0) return [...personaLines(prompt, options), '', ...lines].join('\n');
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^- /.test(lines[i])) { end = i; break; }
  }
  return [...lines.slice(0, start), ...personaLines(prompt, options), ...lines.slice(end)].join('\n');
}

// 给模板里的 `- id: skill-filesystem` 行加上技能发现目录。
//
// 为什么必须加：DSH 的 skill-filesystem 只扫 `<cwd>/.dsh/skills`、`<cwd>/.agents/skills`、
// `<DSH_HOME>/skills` 和 config 里的 `customSkillDirs`。产品随包的技能在**安装目录**下，
// 哪个默认根都不是——所以现在这 6 个技能其实一个都没挂上，模型手里没有它们。
// 打包后用户在别的文件夹工作，更不能靠 cwd 相对路径，所以这里写**绝对路径**。
// ⚠ 整行 config 是替换语义：只声明 customSkillDirs，其余键（includeDefaultRoots=true 等）走 schema 默认值。
function withSkillsRoot(template, skillsDir) {
  if (!skillsDir || !fs.existsSync(skillsDir)) return template;
  const lines = template.split(/\r?\n/);
  const start = lines.findIndex((line) => /^- id: skill-filesystem\s*$/.test(line));
  if (start < 0) return template;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^- /.test(lines[i])) { end = i; break; }
  }
  const block = lines.slice(start, end);
  if (block.some((line) => /^\s+config:/.test(line))) return template; // 模板自带 config：不猜，保持原样
  const insertAt = block.findIndex((line) => /^\s+name:/.test(line));
  const withConfig = [
    ...block.slice(0, insertAt + 1),
    '  config:',
    '    customSkillDirs:',
    `      - ${JSON.stringify(skillsDir)}`,
    ...block.slice(insertAt + 1)
  ];
  return [...lines.slice(0, start), ...withConfig, ...lines.slice(end)].join('\n');
}

// 生成「小鹈鹕 agent preset」到 $DSH_HOME/.agent-presets/<id>/。
// 为什么需要它：Web 表面把 agent 相关的东西交给了 agent preset，
// 每个会话创建时按 preset 组装；standard preset 里的 persona 行注册的 prompt
// section 名和部署层 system-prompt 的完全相同（deployment:persona-prefix），
// 而 scoped section 永远遮蔽 global section —— 所以部署层的 personaPrefix 在
// Web 会话里根本到不了模型。要换人设，只能在 preset 里换。
// 失败时返回 { ok: false, reason }，调用方应退回只打部署层（会话照常能跑）。
function ensureAgentPreset({ dshHome = '', id = AGENT_PRESET_ID, dshBin = '', skillsDir = SKILLS_PATH } = {}) {
  try {
    if (!dshHome) throw new Error('缺少 DSH_HOME，无法写入 agent preset');
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error(`agent preset id 不合法：${id}`);
    const prompt = readSystemPrompt();
    const templatePath = agentPresetTemplate(dshBin);
    if (!templatePath) throw new Error('找不到 DSH 随附的 standard preset 模板（@deepseek-ai/dsh-agent-presets）');
    const template = withSkillsRoot(fs.readFileSync(templatePath, 'utf8'), skillsDir);
    const composition = withProductPersona(template, prompt, { skillsDir });
    // 自检：手术必须真的把提示词写进去（写坏宁可不启用，也不能让会话起不来）
    if (!composition.includes(JSON.stringify(personaText(prompt, { skillsDir })))) throw new Error('生成 agent preset 后人设没有写进去');
    if (/^- id: persona\s*$/m.test(composition) === false) throw new Error('生成 agent preset 后找不到 persona 行');
    // 技能目录存在的却没能写进 config，说明上游改了那一行的形状：宁可整个不启用，也不要静默丢掉技能
    if (fs.existsSync(skillsDir) && !composition.includes(JSON.stringify(skillsDir))) {
      throw new Error('生成 agent preset 时没能把技能目录写进 skill-filesystem 行');
    }

    const dir = path.join(dshHome, AGENT_PRESET_DIRNAME, id);
    fs.mkdirSync(dir, { recursive: true });
    writeIfChanged(path.join(dir, 'agent.cordis.yml'), composition);
    writeIfChanged(path.join(dir, 'preset.yml'), [
      'name: 小鹈鹕',
      'description: 小鹈鹕产品 Agent（人设取自 agent/Agent.md）',
      'order: 0',
      ''
    ].join('\n'));
    return { ok: true, id, dir };
  } catch (error) {
    return { ok: false, id, reason: String((error && error.message) || error) };
  }
}

// 生成物（patch overlay）放哪：**数据目录**，不是安装目录。
// 打包后安装目录可能是 Program Files / 只读 / 签名目录，写不进去；
// 而 patch 只在 --patch 里被读一次，放哪都行，所以统一放 $DSH_HOME/<GENERATED_DIRNAME>/。
function patchFile(dshHome, kind) {
  return path.join(dshHome, GENERATED_DIRNAME, PATCH_FILENAMES[kind] || PATCH_FILENAMES.task);
}

// 生成 --patch 用的 overlay：
// - 永远带 system-prompt 行：includeHarnessIdentity 关掉 DSH 固定开场白
//   （"You are an AI agent powered by DeepSeek Harness."），并且给没有 agent preset
//   的表面（headless / xiaotihu profile）留一份有效人设。
// - surface === 'web' 时再加白标行，见 WEB_SURFACE_ROWS。
// - defaultPreset 非空时把 Web 会话的默认 preset 指到我们生成的那份
//   （生成失败时不能加这行：默认值会指向不存在的 preset，新会话直接起不来；
//   这时用降级版文件，随附的 standard preset 人设本身不含 DSH 字样，不会露底）。
// 返回值：可用的 patch 绝对路径；**写不进去时返回 ''**，调用方应省略 --patch 继续启动
// （白标失效，但产品照常能用——绝不能让一个 overlay 文件把 DSH 拦在门外）。
function ensureSystemPromptPatch({ dshHome = '', surface = 'task', defaultPreset = '', skillsDir = SKILLS_PATH } = {}) {
  if (!dshHome) return '';
  const rows = [
    '- id: system-prompt',
    '  config:',
    '    includeHarnessIdentity: false',
    // 运行上下文整块关掉：它会作为一条 user 消息出现在对话里（折叠行还带着上游包名）。
    // 说明改由人设里的 POLICY_NOTES 承担，所以两种表面都吃同一份人设文本。
    '    includeRuntimeContext: false',
    `    personaPrefix: ${JSON.stringify(personaText(readSystemPrompt(), { skillsDir }))}`,
    `    personaSuffix: ${JSON.stringify(PERSONA_SUFFIX)}`
  ];
  let kind = 'task';
  if (surface === 'web') {
    rows.push(...WEB_SURFACE_ROWS);
    kind = 'webFallback';
    if (defaultPreset) {
      // 整行 config 是替换语义：这里只声明我们要的两个键，
      // roots 走 schema 默认值（空数组），$DSH_HOME/.agent-presets 靠 includeUserRoot 的默认 true。
      rows.push(
        '- id: agent-presets',
        '  config:',
        `    default: ${JSON.stringify(defaultPreset)}`,
        '    includeShippedRoot: false'
      );
      kind = 'web';
    }
  }
  try {
    const file = patchFile(dshHome, kind);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const next = `${rows.join('\n')}\n`;
    if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== next) fs.writeFileSync(file, next, 'utf8');
    return file;
  } catch {
    return '';   // 写不进去就不打 overlay：产品照常启动，只是白标失效
  }
}

module.exports = {
  SYSTEM_PROMPT_PATH,
  SKILLS_PATH,
  GENERATED_DIRNAME,
  PATCH_FILENAMES,
  patchFile,
  AGENT_PRESET_ID,
  AGENT_PRESET_DIRNAME,
  ensureSystemPromptPatch,
  ensureAgentPreset,
  agentPresetTemplate,
  personaText,
  systemPromptEnv
};
