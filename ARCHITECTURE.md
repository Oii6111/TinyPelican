# 小鹈鹕 V3 架构

> 版本：v0.4.0（框架重构：五模块分层，引擎直连大模型 API，微信 iLink 双向通道，看板板块化）

## 总览

小鹈鹕按五个模块组织：

1. **Agent 引擎（engine）**：所有"调用模型"的事（意图识别、提醒文案、关系建议、回复建议、看板对话）统一走这里。
2. **通道接入（channels）**：与外部聊天平台的进出接口。当前实现微信 iLink；新增平台只需按通道契约实现 `connect / stop / send`。
3. **记忆框架（memory）**：联系人档案、意图库、关系状态、对话记录。统一通过 store 读写，后续可平滑切换 SQLite。
4. **记忆输入（ingest + capture）**：剪贴板监听和通道实时消息都归一成同一种消息格式，去重后归档进记忆层。
5. **主动提醒（remind）**：进程内调度（心跳 + 定时任务），到期消费意图库生成提醒并推送，替代外部 cron。

```
输入通道(channels)          输出通道(channels)
微信 iLink / 剪贴板            微信 iLink 推送
      │ 消息                          ▲ 提醒/问候
      ▼                               │
 记忆输入(ingest)           主动提醒(remind)
 解析→去重→归档              心跳 + 定时任务
      │                               │
      ▼                               │
  ┌─ 记忆框架(memory) ────────────────┘
  │  contacts / intents / relations
  │         ▲
  │         │ 读写
  └─ Agent 引擎(engine) ── 直连大模型 API，多 Provider
```

## 目录结构

```
app/                    Electron 桌面壳（拉起核心服务、窗口、热重启）
core/                   核心服务（Node，无第三方依赖，Node >= 18）
  lib/                  横切基础：路径、配置、日志、存储、聊天解析、时间解析、提醒规则、TOML
  engine/               ① Agent 引擎
    client.js           统一调用入口（OpenAI 兼容 /chat/completions，超时 + 重试）
    providers.js        Provider 预设与解析（SiliconFlow/OpenAI/DeepSeek/Ollama/自定义）
    extract.js          模型结构化输出解析
    tasks.js + prompts/ 任务注册表与提示词（intent/relation/reminder/reply）
    intent-runner.js    意图识别执行器（扫描新增消息 -> 识别 -> 入库 -> 通知）
  channels/             ② 通道接入
    interface.js        通道契约（name/connect/stop/send）
    weixin/             iLink 实现
      client.js         HTTP 客户端（扫码登录、getupdates 长轮询、sendmessage）
      login.js          扫码登录状态机（start/check/confirm，凭据写 config.toml）
      context.js        context_token 持久化（重启后仍能主动推送）
      channel.js        WeChatChannel（长轮询、入站处理、出站发送）
      push.js           主动推送统一入口
  memory/               ③ 记忆框架
    stores/             contacts（一人一档）、intents、conversations、unread（未读数）
    relations.js        关系维护检查（冷落检测 + 问候建议）
  ingest/               ④ 记忆输入
    pipeline.js         批次/实时消息统一归档管道
    dedupe.js           消息去重
  capture/              ④ 记忆输入（剪贴板）
    clipboard.js        Node 剪贴板监听（常驻 PowerShell 传感器 + 解析）
  remind/               ⑤ 主动提醒
    scheduler.js        进程内定时调度（防重叠、异常隔离）
    runner.js           提醒执行器（到期点、免打扰、文案生成、推送）
  status.js             全局状态（心跳 / 主动级别 / 未读数）
  api/                  路由层：rest.js 装配 + router.js 路由表 + routes/ 按领域拆分 + models.js 响应规范化
    routes/search.js    全局消息检索（跨联系人关键词）
    routes/status.js    状态与未读接口
  server.js             HTTP 服务入口（装配见 api/rest.js）
  index.js              常驻入口（服务 + 通道 + 监听 + 调度）
  launcher.js           守护启动器（核心退出码 42 自动重启）
dashboard/              看板前端：index.html 骨架 + styles.css（设计令牌）+ src/
  components/           wechat-login.mjs（微信登录组件，设置页与记忆输入页复用）
  views/                chat / channels / contacts / timeline / knowledge / memory-input /
                        proactive / pending（待确认行动）/ records（思考和行动记录）/
                        strategy / mcp / skills / workflows / settings
tests/                  单元测试与 fixture 测试（node --test）
```

## 全局状态与心跳

核心常驻进程每 N 秒（`config.json` 的 `heartbeat.intervalSec`，默认 30，可在「主动 → 策略配置」修改）执行一次心跳，`core/status.js` 维护：

- `heartbeat`：在线状态、最后/下次心跳时间
- `proactivity.level`：全局主动级别（L0 静默准备 ~ L4 自动执行）
- `unread`：微信通道入站消息的未读数（打开对话页即清零）

顶部状态栏每 5 秒轮询 `/api/status` 展示，心跳灯为呼吸动画。

## 看板界面结构

```
┌ 顶部状态栏：Agent 心跳 · 最后心跳 · 主动级别 · 未读数 ┐
├ 侧边栏 ────────────────────────────────────────────┤
│ 💬 对话（独立板块，默认空新对话）                     │
│ 📨 消息渠道 ▸  渠道列表                              │
│ 🧠 记忆 ▸      联系人 / 聊天记录查看器 / 个人知识库    │
│                记忆输入                              │
│ 🔥 主动 ▸      主动仪表盘 / 待确认行动                 │
│                思考和行动记录 / 策略配置              │
│ 🛠️ Agent 功能 ▸ MCP 工具 / Skill 管理 / Workflow    │
│ ────────────────────────────────────────────────   │
│ ⚙️ 设置（左下角独立入口）                            │
└────────────────────────────────────────────────────┘
```

要点：

- **对话**：独立板块，默认启动即空的新对话；打开即清零未读
- **记忆输入**：剪贴板捕获（含语音回填）、微信通道、意图提取的配置全部**在当前页内联展开**，不跳转系统设置；剪贴板捕获默认关闭
- **待确认行动**：AI 主动生成但未自动执行的行动，支持 👍 确认 / 👎 忽略 / 修改，反馈记入学习
- **思考和行动记录**：行动轨迹与思考日志合并的时间线，支持按行动/思考筛选与关键词搜索
- **渠道列表**：微信 iLink 通道卡片 + 网页/邮件/API/Slack/飞书占位
- 侧边栏为折叠式：初始只显示板块，点击展开子页面；窗口自适应缩放（字号、侧栏、网格随宽度浮动）

## 引擎（直连大模型 API + Provider）

用户在看板「设置 -> 模型服务」里选择服务商、填 API 地址 / Key / 模型，支持：

- SiliconFlow / OpenAI / DeepSeek / Ollama（本地）/ 自定义 OpenAI 兼容端点
- 未配置 Key 时给出明确提示；「测试连接」用当前表单配置做一次最小请求验证
- 兼容旧配置：未配置 Provider 时回退读取 `intent.api` 或旧 OpenClaw 的 SiliconFlow 配置

配置保存在 `config.json` 的 `engine` 段（gitignore 排除），API Key 不回显完整值。

## 微信通道（iLink）

微信个人号经腾讯官方 iLink Bot 协议接入，双向收发：

1. 看板点「扫码登录」→ `POST /api/wechat/login/start`
2. 后端调 iLink `get_bot_qrcode` 拿二维码 URL → 前端展示并轮询 `check`
3. 手机扫码确认后 → `confirm` 把 `bot_token / account_id / base_url / user_id` 写入数据目录 `config.toml`
4. 核心自动重启 → `WeChatChannel` 启动 `getupdates` 长轮询（游标落盘续传）
5. 入站消息自动归档并触发意图识别；提醒/建议通过 `sendmessage` 推送

协议要点（依据官方 2.4.6 基线）：

- 鉴权头 `AuthorizationType: ilink_bot_token` + `Bearer`，业务 POST 带 `base_info`
- 长轮询超时正常重试；`ret=-14` 表示 token 失效，停止并提示重新扫码
- 主动推送需要对方 `context_token`（按账号+用户持久化）；从未给 bot 发过消息的人无法主动推送
- 群聊不支持（iLink 限制），入站群消息仅记录并跳过；群聊文本仍可走剪贴板补录
- 出站语音不可靠，语音以文件附件形式发送；入站语音有微信 ASR 转写

## 数据与隐私

- 数据默认本地存储：`contacts/`、`inbox.jsonl`、`intents.json`、`config.toml` 等均在数据目录（开发模式为项目根目录，打包模式为用户数据目录）
- `config.json`（含 Provider Key）、`config.toml`（微信凭据）、`unread.json`、`conversations.json` 均已 gitignore，不入库
- 剪贴板只识别聊天记录格式，非聊天内容丢弃

## 配置项一览（config.json）

| 字段 | 说明 | 看板位置 |
|------|------|----------|
| `engine.provider` / `engine.providers.*` | 模型服务商与密钥 | 设置 → 模型服务 |
| `proactivity.level` | 全局主动级别 L0~L4 | 主动 → 策略配置 |
| `heartbeat.intervalSec` | 心跳间隔（秒），修改后重启核心生效 | 主动 → 策略配置 |
| `capture.enabled` | 剪贴板捕获开关（默认关闭） | 记忆 → 记忆输入 |
| `selfNicknames` | 自己的微信昵称（归档排除用） | 记忆 → 记忆输入 |
| `relationCheck` / `reminder` / `doNotDisturb` | 关系维护与提醒策略 | 主动 → 策略配置 |

## 运行与验证

```powershell
npm test          # 单元测试 + fixture 测试
npm run check     # 全量语法检查
npm run server    # 只启动 HTTP 服务（看板）
npm run daemon    # 守护核心（服务 + 监听 + 通道 + 调度）
```

Electron：`cd app && npm install && npm start`。

## 已知边界（待真机验证）

- 微信扫码登录、长轮询收发的 HTTP 细节按公开协议实现，需真实设备扫码验证一次
- 剪贴板捕获默认关闭，需在记忆输入页开启；Node 监听与旧 `watch-clipboard.ps1` 二选一，勿同时运行
- 语音回填队列（voice-pending.json）目前仍由旧监听器写入，Node 捕获接管后建议将回填逻辑迁入 ingest
- 心跳间隔修改后需重启核心生效（重启由守护/Electron 自动处理）
