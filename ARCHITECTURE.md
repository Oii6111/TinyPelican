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
    tasks.js + prompts/ 任务注册表与提示词（intent/relation/reminder/reply/reply-suggestions）
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
  reply/                回复建议（生成、状态、安全回填）
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
- 剪贴板只识别聊天记录格式，非聊天内容丢弃

## 配置项一览（config.json）

| 字段 | 说明 | 看板位置 |
|------|------|----------|
| `engine.provider` / `engine.providers.*` | 模型服务商与密钥 | 设置 → 模型服务 |
| `proactivity.level` | 全局主动级别 L0~L4 | 主动 → 策略配置 |
| `heartbeat.intervalSec` | 心跳间隔（秒） | 主动 → 策略配置 |
| `capture.enabled` | 剪贴板捕获开关（默认关闭） | 记忆 → 记忆输入 |
| `capture.replySuggestions.*` | 回复建议开关与参数 | 记忆 → 记忆输入 |
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
- 打包分发尚未完全自包含：Electron 壳依赖本机 Node，DSH 依赖根目录 `node_modules`，商业化前需内置于安装包；
- `app/package.json` 打包时会把根目录 `config.json` 作为 `extraResources`，发布前必须改为 `config.example.json` 或首次运行生成，避免泄露密钥；
- 心跳间隔修改后需重启核心生效。

## 运行与打包改进清单（商业化 Beta 前）

1. 自包含安装包：内置 Node 运行时 + DSH 依赖；
2. 首次启动向导：授权、模型配置、昵称配置、通道开启；
3. 安装包移除真实 `config.json`；
4. Windows 代码签名与自动更新；
5. 托管服务端最小闭环：账号、同步、备份、订阅计量；
6. CI 与测试稳定性：修复 Windows 临时目录/文件锁导致的 flaky 测试。
