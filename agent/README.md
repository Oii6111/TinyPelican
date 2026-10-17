# DSH Agent 后端集成（小鹈鹕）

> **现状（2026-09）**：主路径已改为 **DSH Web 常驻会话**（`core/agent/dsh-web-client.js` → `dsh web` 的 `/api`，需 dsh 0.1.5+ 的 BrowserAuth，见 [ARCHITECTURE.md「DSH WebUI 对接」](../ARCHITECTURE.md)）；
> 本文下面写的 headless 子进程 + `agent-tasks.jsonl` 队列是**兜底/后台执行**路径，只在 Web 路径不可用时使用，且依赖 `agent/dsh-home` 下存在与 `agent.reply.profile` 同名的 profile。

小鹈鹕通过 DSH Headless 获得通用 Agent 能力：

- 查看本地文件
- 创建/修改文件
- 执行命令
- 子 Agent / 工具调用
- 像 DSH WebUI 一样逐步展示思考与工具调用

## 架构

```
通道消息（微信/WebUI/未来其他）
        │
        ▼
┌───────────────────┐      ┌──────────────────────────────┐
│ ingest 记忆归档    │      │ dsh-reply：自动用 DSH LLM 回复 │
└───────────────────┘      └──────────────┬───────────────┘
        │                                 ▼
        ▼                       DSH Agent 任务（events 记录）
  意图识别模型（DeepSeek 云端）               │
        │                                 ▼
        ▼                    Agent 任务页 / WebUI 逐步展示
  agent-tasks.jsonl 队列
        │
        ▼
  DSH 大模型 Worker 拉取执行
```

- **大模型回复**：任何通道进来的对话都由 DSH harness 配置的 LLM 回复。
- **意图识别**：聊天入口和心跳扫描默认使用 `intent.provider` 指定的 DeepSeek 云端模型，只负责产出待确认意图。
- **DSH 执行**：用户确认后的 AI 任务写入 `agent-tasks.jsonl`，DSH Worker 拉取执行；用户日程只进入日历。
- **关系维护**：发现“特别关心 + 冷落”的联系人后，会入队一条 `relation` 任务；DSH 生成问候语后由队列 Worker 推送给用户确认。

## 内置 DSH 系统提示词与白标

网页对话和后台任务都在启动时从 `agent/Agent.md` 读系统提示词，落到两条路径（都由 `core/agent/system-prompt.js` 生成）：

- **网页对话**：DSH 的 Web 表面把 agent 相关的东西交给了 **agent preset**——每个会话创建时按 preset 组装，`standard` preset 里的 `persona` 行会**遮蔽**部署层 `system-prompt` 的 `personaPrefix`（两边注册的是同一个 prompt section 名）。所以启动时会把 DSH 随附的 `standard` preset 整份复制成 `<DSH_HOME>/.agent-presets/tinypelican/`，只换掉 `persona` 那一段，再用生成的 web patch 把默认 preset 指到它。preset 只在**会话创建时**读取，所以会话 id 代次（`SESSION_GENERATION`）换代后新会话才会用上。
- **后台任务**：headless（`xiaotihu` profile）没有 preset roster，用生成的 task patch 覆盖部署层即可，同时也用它关掉 DSH 固定的开场白（`includeHarnessIdentity: false`）。

### 生成物放哪（打包相关的硬性规则）

**一律写到数据目录 `<DSH_HOME>/tinypelican/`，绝不写安装目录**：

| 生成物 | 路径 |
|---|---|
| Web patch | `<DSH_HOME>/tinypelican/system-prompt.web.patch.yml` |
| Web patch（preset 生成失败时的降级版） | `<DSH_HOME>/tinypelican/system-prompt.web-fallback.patch.yml` |
| 任务 patch | `<DSH_HOME>/tinypelican/system-prompt.patch.yml` |
| agent preset | `<DSH_HOME>/.agent-presets/tinypelican/`（`agent.cordis.yml` + `preset.yml`） |

原因：打包后安装目录可能在 `Program Files`、只读介质或签名目录里，写不进去；而 patch 只在 `--patch` 参数里被读一次，放哪都行。`ensureSystemPromptPatch()` 写失败时返回**空串**，调用方省略 `--patch` 继续启动——白标失效，但**绝不能让一个 overlay 文件把 DSH 拦在门外**（会话照常能用，人设退回 DSH 随附的那份）。

### 打包后：产品本体 vs 用户工作目录

打包后 `TinyPelican` 安装目录是**产品本体**，而用户在**自己的项目文件夹**里工作，两者不是一个目录。三条规则：

1. **提示词从产品本体读**：`core/agent/system-prompt.js` 按 `__dirname/../../agent/Agent.md` 解析，打包后就是 `<安装目录>/resources/content/agent/Agent.md`，和用户 cwd 无关。用户的工作目录通过 `personaSuffix` 的 `{{cwd}}` 自动进提示词。
2. **提示词里不要写产品相对路径**：`Agent.md` 里曾经写「优先使用 `agent/skills/` 中对应的 Skill」——模型会在**用户的工作目录**里找 `agent/skills/`（找不到）。技能一律**按名字**引用（`records-query` / `todo` / `reminder` / `schedule` / `intent-review` / `chat-search`），位置由下面第 3 条解决；运行时还会在人设里补一段 `Product layout:` 说明，把产品文件的**绝对路径**告诉模型，并明确"那不是用户的工作目录"。
3. **技能要塞进 DSH 认识的技能根**：DSH 的 `skill-filesystem` 只扫 `<cwd>/.dsh/skills`、`<cwd>/.agents/skills`、`<DSH_HOME>/skills` 和 config 里的 `customSkillDirs`——产品随包的 `agent/skills/`（安装目录下）**哪个默认根都不覆盖**，所以生成 preset 时会往 `- id: skill-filesystem` 行写：

   ```yaml
   - id: skill-filesystem
     name: '@deepseek-ai/dsh-skill-filesystem'
     config:
       customSkillDirs:
         - "<安装目录>/resources/content/agent/skills"   # 绝对路径，启动时算出来
   ```

   这样无论用户在哪个文件夹工作，这 6 个技能都在。配套：`app/package.json` 的 `extraResources` 必须**带上技能目录**（否则安装包里根本没有它们）——测试会校验这一条。
   ⚠ 那一行是**整行 config 替换**语义：只声明 `customSkillDirs`，`includeDefaultRoots`（默认 true，仍会扫 `<DSH_HOME>/skills`）等键走 schema 默认值。若上游给该行自带 `config:`，生成器会**保持原样并让 preset 生成失败**（宁可退回 DSH 人设，也不静默丢掉技能）。

白标（用户交互时不该看出底下是 DSH）分三层，前两层已经做完：

**第一层 · 模型口吻 + 对话注入块**（`system-prompt.web.patch.yml`，整行 config 是**替换**语义，改的时候别漏键）：

| 行 | 作用 | 注意 |
|---|---|---|
| `system-prompt` | `includeHarnessIdentity: false` 关掉固定开场白；`includeRuntimeContext: false` 关掉运行上下文；`personaPrefix` 换成人设（`agent/Agent.md` + 一段不含品牌字样的策略说明） | 部署层，headless 也吃这份 |
| `web-runtime` | `surfaceContext: false` 同时注销 `harness:source`（"The DeepSeek Harness implementation checkout is at …"）与 `app:web-surface`（"interacting with the user through the DeepSeek Harness Web GUI at …"）两段提示词 | **必须原样重述** `openBrowser` / `printUrl` / `trustedHosts`（含 `!!js ctx.webStartup.*`），否则掉回默认值：`openBrowser=true` 会自己弹浏览器、`trustedHosts=[]` 会改变信任围栏。测试会对照上游 `dsh-web-app/cordis.patch.yml` 校验键集 |
| `ui-settings-plugin-inventory` | `disabled: true`：关掉「插件清单」页（列 `@deepseek-ai/dsh-*` 模块名 / entry id / Loader 状态 / 随附 preset 名） | 该页只是往 `settings.plugins.tab` 槽位注册的一个 tab，槽位由 `ui-settings-plugins` 声明，关它不影响另一个"可配置"tab |
| `agent-presets` | `default: tinypelican` + `includeShippedRoot: false` | 预设列表里不再出现随附的 `standard/ptc/cordis/minimal`（`cordis` 的人设直接写着 "running on the DeepSeek Harness"）。代价：将来要用 `DSH_TOOLS_MODE=ptc` 就得去掉这一项 |

为什么运行上下文要整块关：DSH 把它作为一条 **user 角色消息**写进会话日志，WebUI 里渲染成可展开的注入行，**折叠状态显示的正是来源插件名**（`@deepseek-ai/dsh-system-prompt`），展开才是 `Current DSH file policy: …`。而 `dsh-agent-loop` 的 `project()` 有一句 `if (this.retained === void 0 && current.length === 0) return;`——只要**从第一步起**就没有运行上下文，那条消息根本不会产生，标签与正文一起消失。代价是模型不再被告知文件策略与审批策略，所以 `core/agent/system-prompt.js` 的 `POLICY_NOTES` 里补了一段等价但不含品牌字样的说明（进人设 = 系统提示，不会显示在对话里）。

preset 生成失败时会退到 `<DSH_HOME>/tinypelican/system-prompt.web-fallback.patch.yml`（同样的白标行、不带 roster 行）——**两种内容各有固定的一份文件**，不能共用一个路径，否则谁最后写谁赢，盘上会留着一份降级 patch。

**第二层 · WebUI 里 DSH 自己写进 settings.yaml 的东西**（`core/agent/dsh-client.js`）：

- `writeGeneratedDshSettings` 现在**保留非我们拥有的顶层键**（`permission`、插件设置、`ui-onboarding` 等）。早先是整份重写，等于把用户在 DSH 界面里改过的设置静默抹掉——最明显的后果是「内测声明」反复弹回来。
- 同时会主动写入 `ui-onboarding.welcomeNoticeVersion`（版本号从随包前端资源里读），那段"内测声明"是写给 DSH 插件开发者看的，不再出现在终端用户界面上。不想要就把 `welcomeNoticeVersion()` 改成返回空字符串。

**第三层 · 还没做 / 你自己代码里的**（见下节「已知的品牌残留」）。

改完 `agent/Agent.md` 后要重启应用：常驻 DSH 进程只在启动时生成 preset 与 patch 文件。安装包只带 `Agent.md`（preset 与 patch 文件在用户机上生成，不入库）。

### 已知的品牌残留

| 位置 | 现状 | 处理建议 |
|---|---|---|
| 侧栏品牌槽位的 fallback | 官方品牌行缺失时退回 **鱼形图标 + "DSH 本地构建"**（`dsh-client-locale` 的 `brand.localBuild`）。你们已自行改过品牌，需要确认这条 fallback 不会露出来 | 彻底干净的做法是给 `sidebar.brand.mark` / `sidebar.brand.name` 两个槽位提供自己的品牌包；或者至少用 `/dsh/` 代理改写把那个字串换掉 |
| 设置里的「插件」区 | `ui-settings-plugins` 会渲染各 settings 命名空间（例如我们自己插件的 `dsh-email`） | 把命名空间改成不带 `dsh` 前缀的名字，或关掉这一行（会一并失去插件配置卡片） |
| `document.title` | `dsh-client-ui-layout` 里硬编码 `DeepSeek Harness` | 嵌在 iframe 里时浏览器标签显示的是外层页面标题，实际看不到 |
| 连接自检页的示例数据 | `dsh-client-connection` 的 `WEB_SEARCH_META` fixture 提到 DSH | 只在连接自检视图里出现，正常对话看不到 |
| 安装目录 / 进程名 / 日志 | `vendor/node_modules/@deepseek-ai/*`、`dsh.log`、`$DSH_HOME` 路径 | 要彻底消失只能 fork 改名；**LICENSE 与版权声明必须保留** |



## 目录

```
agent/
  dsh-event-stream/                自定义 DSH 插件：把 session/event 输出为 JSONL
  dsh-home/profiles/xiaotihu/      小鹈鹕专用 DSH profile
  README.md
core/agent/
  dsh-client.js                    定位并 spawn DSH headless，解析事件流
  dsh-reply.js                     通道对话自动回复（DSH LLM）
  tasks.js                         内存 Agent 任务列表/状态/事件记录
  queue.js                         agent-tasks.jsonl 已确认任务队列
  queue-runner.js                  队列 Worker：DSH 大模型拉取执行
core/api/routes/agent.js           /api/agent/tasks + /api/agent/queue
dashboard/src/views/agent.mjs      Agent 任务页（展示逐步思考/工具调用）
```

## 运行前提

项目根目录安装 DSH：

```bash
npm install
```

或设置环境变量 `DSH_BIN` 指向 `@deepseek-ai/dsh/lib/bin.js`。

## 配置

在 `config.json` 中可配置：

```json
{
  "agent": {
    "reply": {
      "enabled": true,
      "profile": "xiaotihu",
      "maxHistory": 12,
      "timeoutMs": 180000
    },
    "queue": {
      "enabled": true,
      "intervalMs": 10000,
      "timeoutMs": 300000
    }
  },
  "engine": {
    "smallModel": "Qwen/Qwen3.5-9B"
  },
  "intent": {
    "provider": "deepseek",
    "model": "deepseek-chat",
    "chatTimeoutMs": 120000,
    "scanIntervalMs": 60000
  }
}
```

- `agent.reply.enabled = false`：关闭通道自动回复。
- `intent.provider` / `intent.model`：对话和心跳意图识别使用的云端模型；默认使用 DeepSeek Provider。
- `engine.smallModel`：其他仍保留小模型配置的轻量模块使用；意图识别不再读取它。
- `intent.scanIntervalMs > 0`：开启心跳式周期意图扫描（默认 0，关闭）。

## 调用方式

```http
POST /api/agent/tasks
Content-Type: application/json

{ "task": "帮我扫描 contacts 目录并生成报告" }
```

```http
POST /api/agent/queue
Content-Type: application/json

{ "summary": "扫描 contacts 并生成报告", "detail": "读取本地文件后输出" }
```

```http
GET /api/agent/tasks/:id
```

任务包含 `events[]`，其中是 DSH `session/event` 事件：

- `assistant/message` / `assistant/chunk`：Agent 思考/回复
- `tool/call` / `tool/result`：工具调用与结果
- `step/start` / `step/end`：步骤边界
- `turn/start` / `turn/end`：回合边界

## 前端

- 侧边栏「Agent 功能 → Agent 任务」：提交任务并查看实时事件流
- 对话页输入框右侧「🤖 Agent 执行」：把当前消息交给 DSH Agent 执行
- 通道自动回复 / 队列 Worker 产生的 DSH 任务也会出现在 Agent 任务页

## 常见问题

### `spawn EPERM`

某些受限环境禁止 Node 子进程管道通信。`dsh-client.js` 已自动降级：改用文件描述符继承输出，不再依赖管道。如果仍遇到，请确认 Agent 工作目录（默认项目根目录）可写。

### `MISSING_CREDENTIAL`

DSH 需要自己的大模型凭据。小鹈鹕现在会自动把本机 `~/.dsh/settings.yaml` 和 `~/.dsh/.credentials.yaml` 同步到项目 `agent/dsh-home/`，所以本地 DSH 已配置过 key 的话一般不用重复设置。

如果本机没有 DSH 配置，也可以手动：

```bash
set DEEPSEEK_API_KEY=你的key
npm run daemon
```

或者在 DSH Web/Models 页面写入凭据。  
如果小鹈鹕 `engine.provider = "deepseek"` 且已配置 apiKey，也会自动作为 `DEEPSEEK_API_KEY` 传给 DSH 子进程。

## 打包说明

正式分发时把 `node_modules/@deepseek-ai/dsh`（或整个 DSH 依赖）与便携 Node 放入 Electron `extraResources`，并把 `DSH_HOME` 指向应用数据目录下的 `agent/dsh-home`。
