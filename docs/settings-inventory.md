# 小鹈鹕设置项清单与整理方案

> 生成时间：2026-10-16 · 依据：`dashboard/src/**`、`core/lib/config.js`、`core/api/routes/settings.js`、`app/main.js`

## 一、现在有几个「设置面」

| # | 设置面 | 位置 | 状态 |
|---|--------|------|------|
| 1 | 设置弹窗（8 个板块 + 1 个 DSH 宿主分组） | `dashboard/src/views/settings.mjs` | 可用 |
| 2 | 导航分组：模型与服务 / Agent 与记忆 / 消息渠道 / 通知 / 对话与 Agent | 同上（`groups` 硬编码 id 数组） | 与板块对不上 |
| 3 | 关系策略页（主动级别、提醒策略、关系维护、免打扰、心跳） | `dashboard/src/views/strategy.mjs` | **死页：全仓库无任何入口引用** |
| 4 | DSH 自带设置（对话偏好 / Agent 插件） | 宿主挂进弹窗「对话与 Agent」分组 | 可用；DSH 的「Agent 模型」被重定向到我们的「模型服务」 |
| 5 | 功能页里的配置/操作入口 | 渠道列表、记忆输入、邮件页 | 与设置弹窗重复 |

## 二、配置项总表

「UI 位置」= 目前能改到它的地方；⚠ = 界面上没有入口，只能改 `config.json` 或直接调 API。

### A. 模型服务（`engine`）

| 配置项 | 默认值 | UI 位置 | 状态 |
|---|---|---|---|
| `engine.provider` | `deepseek` | 设置 → 模型服务 | ✅ |
| `engine.providers.<名>.baseUrl / apiKey / model` | 见 DEFAULTS | 设置 → 模型服务 | ✅ |
| `engine.providers.<名>.thinkingBody / noThinkingBody` | 无 | 设置 → 模型服务 → 高级折叠 | ✅ |
| `engine.timeoutMs` | 120000 | — | ⚠ |
| `engine.retries` | 2 | — | ⚠ |
| `engine.smallModel` | `''` | — | ⚠ |
| 生成物：`settings.yaml` 的 catalog 能力声明 | — | 无（本次新加的逻辑） | ⚠ 只能改代码 |

### B. 记忆录入（`capture` / `selfNicknames` / 剪贴板）

| 配置项 | 默认值 | UI 位置 | 状态 |
|---|---|---|---|
| `capture.enabled` | false | 设置 → 记忆输入与回复建议 | ✅ |
| `capture.replySuggestions.enabled` | true | 同上 | ✅ |
| `capture.replySuggestions.optionCount` | 3 | — | ⚠ |
| `capture.replySuggestions.maxMessagesPerPlan` | 4 | — | ⚠ |
| `capture.replySuggestions.maxMessageChars` | 40 | — | ⚠ |
| `capture.replySuggestions.deepMaxMessagesPerPlan` | 4（实际 8） | — | ⚠ |
| `capture.replySuggestions.deepMaxMessageChars` | 40（实际 120） | — | ⚠ |
| `capture.replySuggestions.deepTimeoutMs` | 120000 | — | ⚠ |
| `capture.replySuggestions.maxHistoryMessages` | 24 | — | ⚠ |
| `capture.replySuggestions.expireSeconds` | 300（实际 120） | — | ⚠ |
| `capture.replySuggestions.maxOptionChars` | 120 | — | ⚠ |
| `capture.replySuggestions.timeoutMs` | 30000 | — | ⚠ |
| `selfNicknames` | `[]` | 设置 → 记忆输入 → 微信聊天记录（子页面） | ✅ |
| `pollMs`（剪贴板轮询） | 400（实际 700） | — | ⚠ |
| `minMatchLines` | 2 | — | ⚠ |

### C. 画像与总结（`profileAutoUpdate`）

| 配置项 | 默认值 | UI 位置 | 状态 |
|---|---|---|---|
| `profileAutoUpdate.enabled` | false | 设置 → 联系人 → 聊天总结与画像更新 | ✅ |
| `profileAutoUpdate.days` | 7（仅 7/30） | 同上 | ✅ |
| `profileAutoUpdate.scope` | `important` | 同上 | ✅ |

### D. 人设（`userPersona`）

| 配置项 | 默认值 | UI 位置 | 状态 |
|---|---|---|---|
| `userPersona` | `''` | 设置 → 回复建议 → 我的人设与表达风格 | ✅（这段只给「回复建议」用，不是 Agent 人设） |

### E. 联网搜索（`webSearch`）

| 配置项 | 默认值 | UI 位置 | 状态 |
|---|---|---|---|
| `webSearch.enabled / provider / fallback` | false / searxng / `''` | 设置 → 联网搜索（「连接与账号」组） | ✅ |
| `webSearch.searxng.baseUrl` | `''` | 同上 | ✅ |
| `webSearch.moonshot.baseUrl / apiKey / model` | — | 同上 | ✅ |
| `webSearch.timeoutMs / maxResults` | 45000 / 6 | 同上（秒 / 条） | ✅ |
| 状态卡片（已启用/待配置 + 测试按钮） | — | 渠道列表页 | 🔁 与设置重复 |

### F. 微信与推送账号（`weixinPush` / `notify.channels`）

| 配置项 | 默认值 | UI 位置 | 状态 |
|---|---|---|---|
| 微信登录凭据 | — | 设置 → 微信渠道（扫码） | ✅ 写在 `config.toml` |
| `notify.channels.weixin.*` | enabled/direction/label | — | ⚠ 无 UI、无人读 |
| `weixinPush.enabled` | false | — | ⚠ 遗留键，仍会被写回 config.json |
| `weixinPush.notifyComplete / accountId / to` | — | — | ⚠ 同上（`to`/`accountId` 是推送目标） |

### G. 邮件（`email`）

| 配置项 | 默认值 | UI 位置 | 状态 |
|---|---|---|---|
| `email.enabled` | false | 设置 → 邮件 | ✅ |
| `email.importantPush` | false | 设置 → 邮件 **和** 通知板块 | 🔁 两处 |
| `email.address / initialDays` | — / 30 | 设置 → 邮件 | ✅ |
| `email.imap.* / smtp.*`（host/port/secure/rejectUnauthorized/username/password） | — | 设置 → 邮件 | ✅ |
| `email.folder` | `INBOX` | — | ⚠ |
| `email.accountId` | `default` | — | ⚠ |
| `email.reconnectMinMs / reconnectMaxMs` | 1000 / 300000 | — | ⚠ |
| 连接测试 / 立即同步 | — | 设置 → 邮件 **和** 渠道列表页 | 🔁 两处 |

### H. 通知（`notify`）

| 配置项 | 默认值 | UI 位置 | 状态 |
|---|---|---|---|
| `notify.mode` | `weixin` | 设置 → 通知设置 | ✅ |
| `notify.events.captureComplete` | false | 同上 | ✅ |
| `notify.events.intent / reminder / relation` | true | 同上 | ✅ |
| `notify.events.emailImportant` | false | 同上 **和** 邮件板块 | 🔁 两处 |
| `notify.bark.*`（server/key/group/subtitle/level/sound/icon/badge/url/copy/autoCopy/call/isArchive，12 项） | 见 DEFAULTS | 设置 → 通知设置 → Bark 详细设置 | ✅ |
| 发送测试通知 | — | 设置 → 通知设置 | ✅ |

### I. 提醒与主动（**全部在死页里**）

| 配置项 | 默认值 | UI 位置 | 状态 |
|---|---|---|---|
| `proactivity.level`（L0–L4） | `L2` | `strategy.mjs`（未挂载） | ⚠ 死页 |
| `heartbeat.intervalSec` | 30（实际 3000） | 同上 | ⚠ 死页 |
| `relationCheck.enabled / days` | true / 7 | 同上 | ⚠ 死页 |
| `doNotDisturb.enabled / start / end` | true / 23:00 / 08:00（实际 enabled=false） | 同上 | ⚠ 死页 |
| `reminder.deadlineLeadDays` | `[1]` | 同上 | ⚠ 死页 |
| `reminder.deadlineLeadHours` | `[2]` | 同上 | ⚠ 死页 |
| `reminder.scheduleLeadMinutes` | 30 | 同上 | ⚠ 死页 |
| 日历/日程/待办/待确认/记录 页本身 | — | 侧栏「日历与日程」 | ✅（只读+操作，不含这些配置） |

### J. Agent 运行与安全（全部无 UI）

| 配置项 | 默认值 | 状态 |
|---|---|---|
| `agent.reply.enabled / profile / maxHistory / timeoutMs` | true / tinypelican / 12 / 180000 | ⚠ |
| `agent.queue.enabled / intervalMs / maxConcurrent / profile / timeoutMs` | true / 10000 / 1 / tinypelican / 300000 | ⚠ |
| `agent.dsh.webToken` | `''` | ⚠（排障用，注释里写了怎么填） |
| `intent.agent / provider / model / chatTimeoutMs` | intent / deepseek / `''` / 120000 | ⚠ |
| `intent.highConfidence / mediumConfidence` | 0.85 / 0.5 | ⚠ |
| `intent.maxMessagesPerBatch / staleDeadlineDays` | 50 / 2 | ⚠ |
| `intent.agentTimeoutMs / minIntervalMinutes / scanIntervalMs` | 120000 / 0 / 0 | ⚠ |
| `auth.enabled / username / password` | false / admin / `''` | ⚠（看板登录；明文存 config.json） |

## 三、为什么觉得乱（根因清单）

1. **死页面**：提醒/主动相关的 5 组配置全在 `strategy.mjs` 里，而它没有任何入口。界面上根本改不到，但值是生效的（心跳 3000 秒、免打扰关闭、主动级别 L2 都是文件里的值说了算）。
2. **同一件事多个入口/多处显示**：模型（我们的 + DSH 的，靠重定向缝合）、联网搜索（设置板块 + 渠道页卡片）、邮件（设置 + 渠道页 + 邮件页）、记忆输入（设置板块 + 记忆输入页）、邮件重要通知开关（邮件板块 + 通知板块）。
3. **导航分组与板块对不上**：导航 4 组 + 「对话与 Agent」，板块 8 个，映射靠硬编码 id 数组；新增板块若忘加 id，会静默落到最后一个分组。
4. **保存粒度不一致 + 静默重启**：8 个板块 8 个保存按钮，其中模型 / 通知 / 记忆输入 / 邮件保存后会**自动重启核心**，但事前没有任何提示。
5. **30+ 个隐藏旋钮**：上表所有 ⚠ 项只能改文件；其中几个会明显改变行为（意图识别阈值与批量、回复建议条数/字数/过期时间、心跳间隔、回复等待超时）。
6. **默认值与实际值漂移**：`deepMaxMessagesPerPlan` 默认 4 实际 8、`deepMaxMessageChars` 默认 40 实际 120、`expireSeconds` 默认 300 实际 120、`pollMs` 默认 400 实际 700、`doNotDisturb` 默认开实际关。没有 UI 能确认「我现在到底跑的是什么值」。
7. **遗留键还在写盘**：`weixinPush`（已迁到 `notify`，但路由仍会写回）、`notify.channels`（无人读）。它们让 config.json 看起来更乱。
8. **校验很薄**：`POST /api/settings` 只校验 webSearch / profileAutoUpdate / email / engine 思考参数等少数键，其余任意深合并直接写盘（`auth`、`intent`、`heartbeat` 写错值也没人拦）。

## 四、建议整成什么样（3 个方案）

### 方案 A（推荐）：按「用户目标」分 5 组

| 分组 | 放什么 |
|---|---|
| 1. 连接与账号 | 模型服务、微信渠道、邮件、通知渠道（模式 + Bark） |
| 2. 记什么 | 记忆输入（剪贴板/昵称）、画像与总结、联网搜索、语音/导入 |
| 3. 怎么说话 | 人设与表达风格、回复建议（含现在隐藏的条数/字数/过期/超时） |
| 4. 什么时候提醒我 | 主动级别、提醒策略、免打扰、关系维护、通知开关（从死页复活挪进来） |
| 5. 高级与排障 | 模型高级参数、心跳与扫描间隔、意图识别阈值、令牌与登录、队列/超时 |

优点：一个用户问题对应一个分组；「什么时候提醒我」把现在最看不见的一堆复活；「高级」收容所有旋钮。

> 注：上面三条口语化分组名在实现时统一改成了书面语（记忆与画像 / 回复与表达 / 主动与提醒），见第七节。

### 方案 B：按「我 / Agent / 系统」三层

- 我：人设、昵称、提醒偏好、免打扰
- Agent：模型、记忆与总结、回复建议、联网搜索、意图识别
- 系统：渠道与账号、通知、邮件、安全与令牌、高级

### 方案 C：最小改动

只做三件事：复活死页入口（并回主动/提醒配置）、去掉重复入口、补校验。分组结构不动。

## 五、建议动手顺序

1. 定 IA（A/B/C）→ 我按它改导航与板块归属（含硬编码 id 数组改成显式声明）。
2. 复活 5 组提醒/主动配置（挪进新分组，顺手把 heartbeat 的单位与显示理清）。
3. 去重：渠道页只留状态与测试、链接回设置；`email.importantPush` 只留一处；搜索结果卡片去掉重复。
4. 每个板块标注「保存后是否重启核心」；能热更新的尽量热更新（现在只有邮件走 `reconfigure`）。
5. 给隐藏旋钮补 UI：优先 intent 阈值、回复建议参数、心跳、回复超时；其余收进「高级」。
6. `settings` 路由补校验（枚举、范围、类型），清理 `weixinPush` / `notify.channels` 遗留键。

## 六、已拍板（2026-10-16）

| 问题 | 决定 |
|---|---|
| IA | **方案 A**（按用户目标分 5 组） |
| 隐藏旋钮 | 只补必要项：意图识别阈值、回复建议参数、心跳、回复/队列超时；其余留在「高级与排障」 |
| 保存模型 | 板块各自保存（现状），页面顶部统一说明「保存后核心会重启一次」 |
| 自动重启 | **保留**（剪贴板监听、提醒调度、心跳都在启动时读配置，热更新是后续课题） |
| 死页 strategy | **删掉**，配置搬进「主动与提醒」 |

## 七、本次改动（v1）

**导航按方案 A 重组**（`dashboard/src/views/settings.mjs`，板块 id 改由各板块自己声明，分组用 id 列表引用，未归组的板块会兜底到「其他」并告警）：

| 分组 | 板块（id） |
|---|---|
| 连接与账号 | 模型服务 `model` · **双向渠道 `channels`**（微信 / 邮件 / 通知 三个子页面） · 联网搜索 `web-search` |
| 记忆与画像 | 记忆输入 `capture`（子页：微信聊天记录） · **联系人 `contacts`**（子页：聊天总结与画像更新） |
| 回复与表达 | **回复建议 `reply-suggestions`**（子页：生成设置 / 我的人设与表达风格） |
| 主动与提醒 | **提醒与主动 `proactive`（新，原死页内容）** |
| 高级与排障 | **高级与排障 `advanced`（新）** |
| 对话与 Agent | DSH 宿主分组（不变） |

**新板块内容**

- `reply-suggestions`（回复建议）：启用开关 + 方案组数、每组条数、每条字数、每组字数、浮窗有效期、参考聊天条数、快速/思考模式生成超时（原 `capture.replySuggestions.*`，此前只有 `enabled` 有 UI）。
- `proactive`（提醒与主动）：主动级别 L0–L4、心跳间隔、DDL 提前天/小时、日程提前分钟、免打扰开关与时段、关系维护开关与冷落天数。
- `advanced`（高级与排障）：意图识别高/中置信度阈值、每批消息上限、定时扫描间隔；剪贴板轮询间隔、最少匹配行数；回复等待超时、队列间隔/并发/任务超时；DSH Web 登录令牌。

**其他**

- **双向渠道合并**：微信 / 邮件 / 通知三块合成一个板块 `channels`，内部三个子页面（带子页签，一次只显示一张）。外部入口与旧链接沿用原子页面 id：`wechat` / `email` / `notify` 会直接落到对应子页（渠道列表页的「配置 / 去登录」「设置」按钮都走这条路）。
- **记忆输入改为「子页面」结构**：板块下开子页签，目前一个子页面 **微信聊天记录**，里面是「我的微信昵称」+「启用剪贴板自动识别导入」（两项共用一个保存按钮）。以后加语音/文件等录入方式只加子页面，不再占用导航项。昵称没有放进「双向渠道 → 微信」——那是登录态，昵称是录入侧用来区分「我」的依据。
- 子页签组件抽成 `createSubTabs()`（第一张子页面自动选中），双向渠道 / 记忆输入 / 联系人 / 回复建议各用一组，互不影响。
- **「我的人设与表达风格」并入 回复建议**：它本来只用于回复建议（思考模式）与关系问候，不是 Agent 人设，现在作为「回复建议」的子页面。
- **「聊天总结与画像更新」升级为「联系人」板块**：上级名称改为 `contacts`（联系人），内容包括画像候选的开关/周期/适用范围，作为该板块的子页面。
- **联网搜索移到「连接与账号」组**（它是一种外部服务连接）。
- **子页面直达表**（外部入口与旧链接都可用）：`wechat`/`email`/`notify` → 双向渠道对应子页；`persona` → 回复建议 · 我的人设与表达风格；`profile-update` → 联系人；`web-search` → 联网搜索板块。
- `记忆输入` 板块不再含回复建议开关（移到「回复建议」），保存时只写 `capture.enabled`，不再覆盖 `replySuggestions`。
- 页面顶部说明改为：按 5 类分组 + 保存后核心短暂重启。
- **分组名统一为书面语**（原来的「记什么 / 怎么说话 / 什么时候提醒我」太口语）：连接与账号 / 记忆与画像 / 回复与表达 / 主动与提醒 / 高级与排障；同时把几处口语化说明文案改成书面表述（记忆输入、回复建议、提醒与主动、高级与排障的说明与提示）。
- **重要邮件通知只由「双向渠道 → 邮件」写入**：通知子页不再捎带改写 `email.importantPush` / `notify.events.emailImportant`（只留一行指路提示）。核心两个键都读（`core/notify.js` 与 `core/email/service.js`），所以邮件子页保存时两个键一起写、保持一致。
- 删除死页 `dashboard/src/views/strategy.mjs`。
- `tests/settings-ui.test.js` 更新为 8 板块 / 5 分组，并新增：每个板块都能从导航到达、按钮顺序与分组声明一致、三方子页签切换（双向渠道 / 记忆输入 / 联系人 / 回复建议）、`persona`/`profile-update`/`email`/`wechat` 旧链接落到正确子页、「保存通知设置」不得改写邮件开关而「保存邮件设置」必须同时写两个键。

## 八、下一步（还没做）

1. **去重（部分完成）**：✅ 重要邮件通知收敛到邮件子页；待办：渠道列表页卡片里的「连接测试 / 立即同步」与设置里重复，收敛成只留状态 + 跳转。
2. **热更新**：把「保存即重启」改成按需重启（能热更新的就地更新，必须重启的才重启并在按钮上标注）。
3. **路由校验**：`POST /api/settings` 目前只校验少数键，给 `intent.*`、`heartbeat`、`pollMs`、`agent.*`、`capture.replySuggestions.*` 补范围/类型校验。
4. **死键清理**：`capture.replySuggestions.deepMaxMessagesPerPlan` 与 `deepMaxMessageChars` 没有任何代码读取（思考模式实际复用 `maxMessagesPerPlan`/`maxMessageChars`），确认后从 DEFAULTS 与配置里删掉；`weixinPush`、`notify.channels` 一并清理。
5. **默认值对齐**：把实际值和 DEFAULTS 对齐（或用 UI 显示的当前值作为唯一真相）。

