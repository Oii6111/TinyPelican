# 小鹈鹕 V3 架构

> 版本：v0.5.0（产品叙事升级：五模块分层现状 + 规划中的穿戴设备接入、bot 语音日记、官方托管服务）
> 标记说明：本文件按「✅ 现状」和「⏳ 规划」区分，规划模块不冒充已实现。

## 总览

小鹈鹕按五个核心模块组织（现状）：

1. **Agent 引擎（engine）**：所有「调用模型」的事（意图识别、提醒文案、关系建议、回复建议、看板对话）统一走这里。
2. **通道接入（channels）**：与外部聊天平台的进出接口。当前实现微信 iLink；新增平台只需按通道契约实现 `connect / stop / send`。
3. **记忆框架（memory）**：联系人档案、意图库、关系状态、对话记录。统一通过 store 读写，已支持 SQLite 聊天记忆。
4. **记忆输入（ingest + capture）**：剪贴板监听和通道实时消息都归一成同一种消息格式，去重后归档进记忆层。
5. **主动提醒（remind）**：进程内调度（心跳 + 定时任务），到期消费意图库生成提醒并推送，替代外部 cron。

规划中的扩展模块（见文末「规划架构」）：

- **活动接入（activity，⏳）**：AI 眼镜 / AI 相机 / AI 手表等穿戴设备的统一接入层；
- **语音日记（diary，🚧）**：微信 bot 对话 → 记忆条目 → 联系人档案回写；
- **官方托管（managed，⏳）**：账号、云同步、自动更新、自动备份、订阅计费。

```
输入通道(channels)          输出通道(channels)
微信 iLink / 剪贴板            微信 iLink 推送 / Bark
      │ 消息                          ▲ 提醒/问候
      ▼                               │
  记忆输入(ingest)           主动提醒(remind)
  解析→去重→归档              心跳 + 定时任务
      │                               │
      ▼                               │
   ┌─ 记忆框架(memory) ────────────────┘
   │  contacts / intents / relations
   │  SQLite chat memory
   │         ▲
   │         │ 读写
   └─ Agent 引擎(engine) ── 直连大模型 API，多 Provider
```

## 目录结构

```
app/                    Electron 桌面壳（拉起核心服务、窗口、热重启、回复建议浮窗）
core/                   核心服务（Node，无第三方运行时依赖，Node >= 18）
  lib/                  横切基础：路径、配置、日志、存储、聊天解析、时间解析、提醒规则、TOML
  engine/               ① Agent 引擎
    client.js           统一调用入口（OpenAI 兼容 /chat/completions，超时 + 重试）
    providers.js        Provider 预设与解析（SiliconFlow/OpenAI/DeepSeek/Ollama/自定义）
    extract.js          模型结构化输出解析
    tasks.js + prompts/ 任务注册表与提示词（intent/relation/reminder/reply-suggestions/reply_followup）
    intent-runner.js    意图识别执行器（扫描新增消息 -> 识别 -> 入库 -> 通知）
  channels/             ② 通道接入
    interface.js        通道契约（name/connect/stop/send）
    weixin/             iLink 实现（扫码登录、长轮询、收发、主动推送）
  memory/               ③ 记忆框架
    stores/             contacts、intents、conversations、unread、voice、tasks、schedules
    chat-db.js          SQLite 聊天记忆
    relations.js        关系维护检查（冷落检测 + 问候建议）
  ingest/               ④ 记忆输入
    pipeline.js         批次/实时消息统一归档管道
    dedupe.js           消息去重
  capture/              ④ 记忆输入（剪贴板）
    clipboard.js        Node 剪贴板监听（拉起 clipboard-sensor.ps1 传感器 + 解析）
  remind/               ⑤ 主动提醒
    scheduler.js        进程内定时调度（防重叠、异常隔离）
    runner.js           提醒执行器（到期点、免打扰、文案生成、推送）
  reply/                回复建议（多组连贯消息方案、换一批/按描述重写、状态、安全回填）
  import/               聊天记录批量导入（ZIP/TXT/CSV/JSON → 统一归档进 SQLite）
  agent/                DSH Agent 后端（headless、web 会话、任务队列、微信回复）
  status.js             全局状态（心跳 / 主动级别 / 未读数）
  api/                  路由层：rest.js 装配 + router.js 路由表 + routes/ 按领域拆分
  server.js             HTTP 服务入口
  index.js              常驻入口（服务 + 通道 + 监听 + 调度）
  launcher.js           守护启动器（核心退出码 42 自动重启）
dashboard/              看板前端：index.html 骨架 + styles.css + src/
  components/           wechat-login.mjs、agent-events.mjs
  views/                chat / channels / contacts / timeline / knowledge / memory-input /
                        proactive / pending / records / strategy / mcp / skills /
                        workflows / settings / tasks / calendar
tests/                  单元测试与集成测试（node --test）
```

根目录另有 `start.ps1`（开发模式一键启动）。PowerShell 组件仅薄壳，核心逻辑全部在 Node 侧。

## 全局状态与心跳

核心常驻进程每 N 秒（`config.json` 的 `heartbeat.intervalSec`，默认 30）执行一次心跳，`core/status.js` 维护：

- `heartbeat`：在线状态、最后/下次心跳时间
- `proactivity.level`：全局主动级别（L0 静默准备 ~ L4 自动执行）
- `unread`：微信通道入站消息的未读数

顶部状态栏每 5 秒轮询 `/api/status` 展示。

## 看板界面结构

```
┌ 顶部状态栏：Agent 心跳 · 最后心跳 · 主动级别 · 未读数 ┐
├ 侧边栏 ────────────────────────────────────────────┤
│ 💬 对话（独立板块，默认空新对话）                     │
│ 📨 消息渠道 ▸  渠道列表                              │
│ 🧠 记忆 ▸      联系人 / 聊天记录查看器 / 个人知识库    │
│                记忆输入                              │
│ 🔥 主动 ▸      主动仪表盘 / 待确认行动 / 任务          │
│                思考和行动记录 / 策略配置 / 日历        │
│ 🛠️ Agent 功能 ▸ MCP 工具 / Skill 管理 / Workflow    │
│ ────────────────────────────────────────────────   │
│ ⚙️ 设置（左下角独立入口）                            │
└────────────────────────────────────────────────────┘
```

## 引擎（直连大模型 API + Provider）

用户在看板「设置 → 模型服务」里选择服务商、填 API 地址 / Key / 模型，支持：

- SiliconFlow / OpenAI / DeepSeek / Ollama（本地）/ 自定义 OpenAI 兼容端点
- 未配置 Key 时给出明确提示；「测试连接」用当前表单配置做一次最小请求验证
- 配置保存在 `config.json` 的 `engine` 段（gitignore 排除），API Key 不回显完整值

## 回复建议（悬浮卡片）

复制一段微信私聊（`capture.enabled` + `capture.replySuggestions.enabled` 同时打开）后：

1. 归档聊天 → 模型按「下一轮怎么回」给出 `optionCount` 组方案，每组是 **1~N 条按发送顺序排列的短消息**（多数情况 1~2 条；只有必须完整说明一件事时才用一条长消息）；
2. 卡片自动出现在微信输入框上方（不再有独立的悬浮小图标，卡片高度随内容自适应）；
3. 点某一组 = 先填入第 1 条并停在该组「下一条」上，用户发出上一条后再点下一条，逐条按顺序回填；**任何一条都不会自动发送**；
4. 卡片底部一行输入框：写下自己想表达什么，回车（或点 ↵）让模型按你的描述重写；🎲 换一批 = 同一段聊天换几种说法（会把已给过的方案作为「不要重复」约束传给模型）。

生成速度与两种模式：

- 检测到聊天复制就**先把浮窗弹出来放「思考中」**（`/api/reply-suggestions/current` 里带 `pending`，含定位锚点），模型返回后再把内容填进去；
- **快速模式（默认）**：关掉模型思考过程（DeepSeek 等混合模型实测 5.5s → 1.0s，参数见 `core/engine/client.js` 的 `noThinkingBody()`），每组最多 `maxMessagesPerPlan`（默认 4）条、每条 `maxMessageChars`（默认 40）字；
- **深度思考模式**：卡片上的 🧠 按钮，打开思考过程重来，放开到 `deepMaxMessagesPerPlan`（默认 8）条、`deepMaxMessageChars`（默认 120）字，超时 `deepTimeoutMs`（默认 120s）；
- 顺序发送中，这一组的「🎲 换一批 / 🧠 深度思考」只重写**还没发出去的那几条**（`reply_followup` 任务），并把用户**已经发出去的内容**带进提示词，避免续写和已发消息语境割裂；已经给过的那几条同时进「不要重复」清单。

回收与找回：

- ✕ / Esc 是**收起**（只隐藏浮窗，服务端那批建议仍然保留）；
- 再复制一次同一段聊天 → 直接把既有的那批建议重新弹出来（`showToken` 自增触发重新显示），顺带刷新定位与有效期，**不会重复调模型、也不会重复归档**；
- 上下文变了（你回了新消息，最新消息指纹不同）→ 自动重新生成；复制别的聊天、过期或核心重启也会丢掉旧那批。

安全边界：回填前校验窗口句柄 + 进程 + 前台窗口，只发 Ctrl+V 不发 Enter；无微信窗口句柄时降级为只复制到剪贴板。

## 打包分发（双击安装即用）

一条命令产出安装包：

```powershell
npm run dist          # = scripts/build-installer.ps1
```

产物 `app/dist/TinyPelican-Setup-<版本>.exe`（本机实测 147MB；NSIS oneClick，装到当前用户目录、无需管理员，装完自动启动）。

自包含三件套（都已落地）：

1. **Node 运行时**：不再要求用户安装 Node —— Electron 壳用 `process.execPath` + `ELECTRON_RUN_AS_NODE=1` 直接把核心当 Node 进程跑（`app/main.js` 的 `coreEnv()/startCore()`）；
2. **DSH 内置**：`packaging/vendor/node_modules` 里装好 `@deepseek-ai/dsh`（约 223MB，`scripts/build-installer.ps1` 会自动安装），由 electron-builder 复制到 `resources/content/vendor/node_modules`；`findDshBin()` 与 `app/main.js` 都优先用它（`XIAOTIHU_DSH_BIN`）。注意 dsh 0.1.5-rc.2 自己的依赖里有个不存在的版本（`…sidebar-documentpreview@^0.1.5-rc.3`），所以 `packaging/vendor/package.json` 用 npm `overrides` 钉到 rc.2；
3. **DSH home 与配置**：首次启动把 `DSH_HOME` 指向 `<用户数据目录>/dsh-home`（DSH 自己生成 `web` profile，实测 4 秒完成、不需要联网），并把「设置 → 模型服务」里的模型与 API Key 通过 `buildDshEnv()` 传给 DSH；配置只带 `config.example.json`，首次运行生成 `config.json`（**安装包里不含开发者的 Key**）。

用户拿到 exe 之后要做的只有两件（无法代劳）：在「设置 → 模型服务」填自己的模型 API Key（首次启动会弹提示），以及微信通道扫码登录一次。

## 意图识别（结合上下文与当前时间）

`core/engine/intent-runner.js` 只扫描**新增消息**（按联系人游标增量），所以提示词必须自带上下文，否则会误判：

- 提示词（`core/engine/prompts/intent.js`）现在带 **当前时间**（含星期）、**每行消息自身的发送时间**，以及 **前文背景**（该批次之前最多 12 条，标注「仅供参考，不要从前文产出新待办」）；
- 规则要求：先结合前文与当前时间判断是否**已完成 / 已取消 / 已过期**，相对时间（明天/周五）必须按**消息自己的时间**换算成绝对日期再比较；过期且无未完成证据的不要输出；模型也可用 `expired: true` 明确标注；
- 代码侧兜底：模型标了 `expired`，或截止时间已经过去 `intent.staleDeadlineDays`（默认 2 天）的，**不入待确认列表**（日志记为「跳过过期/已完成」）；
- 每轮扫描还会把**旧的过期待确认事项自动标为已忽略**（`staleReason` 记录原因），避免历史遗留的假待办一直刷屏。

## 聊天记录批量导入（微信导出 / 分享目标）

微信 4.x 支持把聊天记录导出成 ZIP/TXT；导入管线见 `core/import/chat-archive.js`（`npm run import -- <文件>`、`POST /api/import/archive`）。
压缩包在内存内解压（`core/import/zip.js`，无第三方依赖），按联系人归档进 SQLite 并自动去重；不认识的文件如实报告状态 + 内容预览。

系统入口分两类，细节与取舍见 [docs/chat-import.md](docs/chat-import.md)：

- **经典 Win32**：`scripts/register-import-handler.ps1` 注册「发送到」与右键菜单（HKCU，可 `-Unregister` 撤销），配合 `scripts/tinypelican-import.cmd` 使用；
- **微信「转发到其他应用」**（已实现）：走的是 Windows 分享面板（UWP `windows.shareTarget` 合约），只有**打包应用**会出现在列表里。`packaging/share-target/` 提供了全信任打包 shim（C#，`Windows.FullTrustApplication` + `rescap:runFullTrust`）：接收 `ShareTarget` 激活 → 取 `StorageItems` → 调用 `core/import/chat-archive.js` 入库（微信导出无昵称，shim 会先问「这段记录属于谁」）。安装/卸载：`install-share-target.ps1` / `-Unregister`（开发模式免签名注册，本机已验证）。

## DSH WebUI 对接（dsh 0.1.5+）

`core/agent/dsh-web-client.js` 通过 `dsh web`（默认 3080）的 `/api` 与常驻 Agent 会话交互。DSH 0.1.5 起换了两样东西，客户端已按新协议对接（不再兼容 0.1.0 的点号接口）：

- **内置鉴权（BrowserAuth）**：`/api` 需要签名 cookie。`dsh web` 启动时会打印 `http://127.0.0.1:3080/?token=<临时令牌>`；用该令牌 GET 一次即下发 `dsh-auth-*` cookie（签名密钥持久化，重启 DSH 后 cookie 仍有效）。客户端把 cookie 缓存在数据目录 `dsh-web-auth.json` 复用，只有拿不到 cookie 时才需要令牌：
  - 由小鹈鹕拉起 `dsh web` 时，自动从启动输出里抓令牌（`--no-open`，不弹浏览器）；
  - 用户自己启动 DSH 时，把日志里的 `?token=` 填到 `config.json` 的 `agent.dsh.webToken`（或环境变量 `DSH_WEB_TOKEN`），认证一次即可。
  没令牌时错误信息会直接给出这段指引，而不是只丢一句 401。
- **接口风格**：Typert Remote，路径 `<namespace>/<method>`（如 `session/prompt`、`session/page`、`workspace/create`），载荷为 `payload.args = { <参数名>: request }`；参数名各控制器不统一（`request` / `_request`），客户端会按服务端的校验提示自动纠正并记住。发消息必须带 `requestId`；历史用 `session/page`（游标取自 `session/list` 的 `asOfSeq`），事件结构与旧版一致（`assistant/message`）。

`findDshBin()` 会在**项目依赖 / 全局安装 / npx 缓存**里挑版本号最高的那份 dsh（0.1.5 以下没有这套 WebUI 协议，捡到老的会 404）。

**启动慢与自愈**：本机实测 `dsh web` **冷启动要 40~50 秒**才监听 3080（插件/鉴权门初始化慢，热启动 4 秒左右）。
所以 DSH 的拉起是**后台进行、不阻塞核心启动**（微信通道、剪贴板监听先跑），等待窗口 120 秒；
任何 RPC 遇到网络层失败（`fetch failed`）会先 `ensureWebReady()` 等它就绪再重试，多个调用共享同一次启动。
入口：`npm start`（= `node core/launcher.js`，启动核心并确保 DSH）。

**`--expose-internals`（打包版必须带）**：DSH 的 `web` profile 模板里 `patchReload: live`，
而 live reload 的 `@deepseek-ai/cordis-plugin-hmr` 依赖 Node 的 `--expose-internals`。
打包版用 Electron 当 Node（`ELECTRON_RUN_AS_NODE`），不带这个 flag 时 DSH 会**在启动阶段直接崩**
（`--expose-internals is required for HMR service`）：全新机器上第一次装完就是这个表现——
3080 打不开、对话报 `fetch failed`。所以 `spawnDshWeb()` 拉起 DSH 时固定加上该 flag。
老安装目录里的核心没有这个 flag，`scripts/start-dsh.{cmd,js}`（排障脚本）会把该 profile 的
`patchReload` 降为 `startup`（DSH 自己的 `initProfile` 不覆盖已有文件，所以改一次就永久生效），
这样连老版本核心也能正常拉起 DSH。

**模型配置怎么进 DSH**：小鹈鹕「设置 → 模型服务」是唯一来源，`buildDshEnv()` /
`writeGeneratedDshSettings()` 把它翻译成 `<DSH_HOME>/settings.yaml`：`agent-default-model` 指到
`deepseek-official` 路由（DSH 的 llm-deepseek 适配任意 OpenAI 兼容端点），`llm-deepseek.baseURL` 用设置里的地址，
Key 通过 `DEEPSEEK_API_KEY` 环境变量给 DSH（**以设置里的 Key 为准**，覆盖环境里可能残留的旧值）。
两条硬规则：

1. **模型 / 地址 / Key 必须成套**：`effectiveEngineProvider()` 只在三者齐全时才算「可用」；
   设置里选中的那个 provider 没配 Key 时，自动退到任一配好的 provider（键名 `deepseek` 优先），
   并在 DSH 的模型名前缀出来源（如 `Qwen/Qwen3.5-9B · SiliconFlow`）。
   一个都没有时写回 DSH 自带默认模型 —— 绝不能留下一份「模型是 A、地址是 B、却没有对应 Key」的配置，
   那正是 DSH 里报「API 密钥无效」的来源（打包版默认 provider 曾是空 Key 的 siliconflow）。
2. **改了设置要生效**：DSH 常驻，核心重启不会重启它。`ensureWebReady()` 每次都会刷新 settings.yaml，
   发现内容变化且 DSH 是自己拉起来的就重启它（DSH 自己也会热加载 settings.yaml）。
   注意：老版本核心按 `config.engine.provider` 直接写 settings.yaml（不看 Key），
   所以 `scripts/start-dsh.js` 在「选中 provider ≠ 可用 provider」时不把启动交给核心，改由脚本自己拉起。

另外：数据目录分「开发模式=项目根目录」与「打包模式=`%APPDATA%\xiaotihu`」两套 config.json，
两个实例同时跑会共用同一个 DSH（3080），谁的配置生效取决于谁先拉起 DSH —— 排查模型问题时先确认只跑了一个实例。

**会话 id 代次**：同一条会话 key（`agent:main:webui:*` / `agent:main:weixin:*`）永远映射同一个 DSH sessionId，历史靠它续上。
常量 `SESSION_GENERATION`（`core/agent/dsh-web-client.js`）决定代次；当前是 `v3`——`v2` 那批会话文件被从 DSH 外部删过，
DSH 仍记着那些 id，`session/prompt` 会被接受但落盘时 `ENOENT`（表现为「本轮运行失败」），已经不可用。
以后再出现「绕过 DSH 删掉会话文件」，把该常量 +1 即可；从界面清理会话请用 DSH 的归档，或让小鹈鹕换一代 id。

## 微信通道（iLink）

1. 看板点「扫码登录」→ `POST /api/wechat/login/start`
2. 后端调 iLink `get_bot_qrcode` 拿二维码 URL → 前端展示并轮询 `check`
3. 手机扫码确认后 → `confirm` 把 `bot_token / account_id / base_url / user_id` 写入数据目录 `config.toml`
4. 核心自动重启 → `WeChatChannel` 启动 `getupdates` 长轮询（游标落盘续传）
5. 入站消息自动归档并触发意图识别；提醒/建议通过 `sendmessage` 推送

协议要点：

- 鉴权头 `AuthorizationType: ilink_bot_token` + `Bearer`
- 长轮询超时正常重试；`ret=-14` 表示 token 失效，停止并提示重新扫码
- 主动推送需要对方 `context_token`；从未给 bot 发过消息的人无法主动推送
- 群聊暂不支持（iLink 限制），群聊文本可走剪贴板补录
- 出站语音不可靠，语音以文件附件形式发送；入站语音有微信 ASR 转写

## 数据与隐私（现状）

- 数据默认本地存储：SQLite、`contacts/`、`inbox.jsonl`、`intents.json`、`config.toml` 等均在数据目录（开发模式为项目根目录，打包模式为用户数据目录）
- `config.json`（含 Provider Key）、`config.toml`（微信凭据）、`unread.json`、`conversations.json` 均已 gitignore，不入库
- 登录会话持久化在数据目录 `sessions.json`（HttpOnly Cookie `xtp_session`，7 天有效，载入时清理过期项）。
  保存设置会热重启核心，会话若只在内存里，重启后看板/桌面端会静默变“未登录”（表现为下一次保存报 `unauthorized`），所以会话必须落盘
- 剪贴板只识别聊天记录格式，非聊天内容丢弃

## 配置项一览（config.json）

| 字段 | 说明 | 看板位置 |
|------|------|----------|
| `engine.provider` / `engine.providers.*` | 模型服务商与密钥 | 设置 → 模型服务 |
| `proactivity.level` | 全局主动级别 L0~L4 | 主动 → 策略配置 |
| `heartbeat.intervalSec` | 心跳间隔（秒） | 主动 → 策略配置 |
| `capture.enabled` | 剪贴板捕获开关（默认关闭） | 记忆 → 记忆输入 |
| `capture.replySuggestions.*` | 回复建议开关与参数（`optionCount` 组数、`maxMessagesPerPlan` 每组最多几条、`maxMessageChars` 单条字数、`expireSeconds` 有效期） | 记忆 → 记忆输入 |
| `selfNicknames` | 自己的微信昵称（归档排除用） | 记忆 → 记忆输入 |
| `relationCheck` / `reminder` / `doNotDisturb` | 关系维护与提醒策略 | 主动 → 策略配置 |
| `notify.mode` / `notify.bark.*` | 通知通道（微信 / Bark） | 设置 |

## 运行与验证

```powershell
npm test          # 单元测试 + fixture 测试
npm run check     # 全量语法检查
npm run server    # 只启动 HTTP 服务（看板）
npm run daemon    # 守护核心（服务 + 监听 + 通道 + 调度）
```

Electron：`cd app && npm install && npm start`。

## 规划架构（目标态，⏳ 未实现）

### 1. 活动接入层（wearables/activity）

```
AI 眼镜 / AI 相机 / AI 手表
        ↓ 各厂商 SDK / 开放 API / 标准协议
活动接入适配器（device adapters）
        ↓ 归一化为 ActivityEvent { ts, type, people, place, summary, source }
活动时间线 store（activity timeline）
        ↓
关系档案更新 + 意图触发 + 主动提醒
```

- 优先选择开放度高、可导出数据的设备；
- 每个设备独立授权、独立可删除；
- 硬件厂商只服务自己设备内功能，小鹈鹕负责跨设备统一记忆。

### 2. 语音日记（diary）

```
用户在微信里对 bot 说话
        ↓
DSH 常驻会话（agent:main:weixin:<user>）
        ↓
日记语义路由：与联系人相关 → 档案回写；与任务相关 → 待确认意图；纯情绪/生活 → 日记记忆
        ↓
记忆条目 store（journal）+ 可检索/可删除
```

- 当前进展：bot 对话已长期保存（conversations），日记专用沉淀规则正在完善；
- 未来需要：日记条目模型、按联系人/时间/主题检索、隐私开关。

### 3. 官方托管服务（managed）

```
用户端（PC / 手机 / 穿戴）
        ↓ 加密传输
托管服务：账号系统 + 授权 + 云同步 + 自动更新 + 自动备份 + 计费
        ↓
对象存储（加密备份） + 订阅计量（AI 额度 / 同步量）
```

- 与自托管版共用同一套核心代码，托管版仅增加服务端与发行通道；
- 数据默认端侧加密，用户可导出、可注销、可删除。

## 已知边界（待验证/待补）

- 微信扫码登录、长轮询收发的 HTTP 细节需真实设备持续验证；
- 剪贴板捕获默认关闭，需在记忆输入页开启；
- 安装包已自包含（见下节「打包分发」）：用 Electron 自带 Node 跑核心、内置 DSH、不打包开发者 `config.json`；仍未做的是**代码签名与自动更新**（用户会看到 SmartScreen 未知发布者提示）；
- 心跳间隔修改后需重启核心生效。

## 运行与打包改进清单（商业化 Beta 前）

1. 自包含安装包：内置 Node 运行时 + DSH 依赖；
2. 首次启动向导：授权、模型配置、昵称配置、通道开启；
3. 安装包移除真实 `config.json`；
4. Windows 代码签名与自动更新；
5. 托管服务端最小闭环：账号、同步、备份、订阅计量；
6. CI 与测试稳定性：修复 Windows 临时目录/文件锁导致的 flaky 测试。
