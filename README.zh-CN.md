# 小鹈鹕 TinyPelican

> 本地优先的个人 Agent：把聊天记录整理成联系人记忆，把承诺变成可执行事项，并在需要时给出有上下文的回复建议。

[English](README.md) · **中文**

## 项目定位

小鹈鹕运行在 Windows 本机，围绕微信聊天记录提供联系人记忆、主动提醒、待办/日程管理和 DSH Agent 对话。它不把自然语言意图拆成一串关键词路由，而是让 DSH 通过 Agent 规则和系统 Skill 决定下一步，再由后端 API 负责校验、权限和落库。

## 核心链路

```text
微信消息 / 剪贴板聊天
          │
          ▼
解析、去重、联系人匹配
          │
          ▼
SQLite：联系人、画像、社交目标、聊天消息
          │
          ├── 查询 / 搜索 / 回复建议
          └── 意图识别 → 待确认意图 → 待办、提醒或日程
                                      │
                                      ▼
                              DSH Agent + 系统 Skills
```

DSH 是唯一的自然语言决策者。系统工具提供结构化查询和写入接口，禁止 Agent 直接扫描项目目录或编辑数据文件。聊天记录运行时以 `tinypelican.sqlite` 为准，旧版联系人 JSON 只用于一次性迁移。

## 已实现能力

- **联系人与聊天**：微信式联系人列表，备注名优先；点击联系人直接查看聊天，支持搜索消息、编辑画像、社交目标和关系信息。
- **SQLite 聊天存储**：联系人、联系人画像、社交目标、消息和全文搜索索引集中在 SQLite 中，复制导入会去重并增量写入。
- **上下文回复建议**：复制私聊后，按“最近复制内容 → 社交目标 → 联系人画像 → 定向历史检索”的顺序生成建议，不自动发送。
- **意图与事项**：聊天中的可能事项先进入待确认意图；确认后才创建待办、提醒或日程。系统 API 负责字段校验、时间校验和重复保护。
- **主动仪表盘**：日历、待办分页/滚动、日程提醒、待确认意图、思考与行动记录集中查看。
- **DSH 对话**：WebUI 和微信使用长期会话，支持流式回复、系统工具调用和复杂任务队列。
- **桌面浮窗**：Electron 负责拉起核心服务，并显示回复建议图标和悬浮卡片。
- **主动提醒**：周期提醒、截止时间提醒、关系维护提醒，以及微信/Bark 推送。
- **语音回填**：按顺序粘贴转写文本，回填到对应联系人的语音消息记录。

## 快速开始

### 环境要求

- Windows
- Node.js 18 或更高版本
- 可用的 DSH WebUI（默认地址 `http://127.0.0.1:3080`）
- 至少配置一个 OpenAI 兼容模型 Provider

### 初始化与启动

```powershell
git clone <你的仓库地址>
cd TinyPelican
npm install
Copy-Item config.example.json config.json
```

编辑 `config.json`，至少确认：

- `selfNicknames`：你的微信昵称，用于区分自己和联系人发言；
- `engine.providers`：模型 Provider、地址、模型和 API Key；
- `capture.enabled`：是否启用剪贴板聊天导入；
- `auth.enabled`、`auth.username`、`auth.password`：如果通过公网或 Cloudflare Tunnel 暴露 WebUI，必须开启鉴权。

启动完整核心：

```powershell
npm run daemon
```

打开看板：`http://127.0.0.1:18791`

只启动 WebUI/API：

```powershell
npm run server
```

### Electron 桌面端

```powershell
cd app
npm install
npm start
```

桌面端会启动核心服务、处理鉴权 Cookie，并显示回复建议浮窗。开发模式的数据默认写入仓库目录；打包模式可通过 `XIAOTIHU_DATA_DIR` 指定数据目录。

## 常用命令

```powershell
npm run daemon      # 核心服务、剪贴板、微信通道、调度器和 Agent 队列
npm run server      # 仅启动本地 WebUI/API
npm test            # Node.js 测试
npm run check       # 全量语法检查
npm run remind:dry  # 预览提醒规则
```

## 数据与目录

```text
app/                 Electron 桌面端
agent/               Agent.md、Skills 和事件流插件
core/                API、Agent、SQLite、导入、提醒和微信通道
dashboard/           原生 ES Module WebUI，无构建步骤
tests/               单元测试和集成测试
tinypelican.sqlite   联系人、画像和聊天消息数据库（本地生成，不入库）
tasks.json           待办与提醒数据（本地生成）
schedules.json       日程数据（本地生成）
intents.json         待确认意图（本地生成）
config.json          本地配置和密钥（本地生成）
```

SQLite 使用 WAL 模式，因此 `tinypelican.sqlite-shm` 和 `tinypelican.sqlite-wal` 也属于本地运行时文件。聊天内容、配置、日志和 Agent 会话不会提交到 Git。

## DSH 与系统 Skill

Agent 的能力总目录在 `agent/Agent.md`，具体能力在 `agent/skills/`。联系人和聊天记录必须通过系统工具查询，例如：

```powershell
node core/agent/system-cli.js query contacts
node core/agent/system-cli.js search-chat "关键词" [联系人]
node core/agent/system-cli.js contact-context "联系人或备注名"
```

系统工具只返回结构化结果；创建或修改事项仍由后端 API 执行。这样可以避免重复创建、类型混淆和直接改写 SQLite/JSON 文件。

## 安全提示

- 本地开发可以关闭 WebUI 鉴权；只要把端口暴露到局域网、公网或 Cloudflare Tunnel，就应启用 `auth`。
- 不要把 `config.json`、API Key、微信上下文、SQLite 数据库或聊天记录提交到仓库。
- 回复建议只负责填入输入框，不会自动向联系人发送消息。

## 文档

- [ARCHITECTURE.md](ARCHITECTURE.md)
- [RULES.md](RULES.md)
- [agent/README.md](agent/README.md)
- [产品设计.md](产品设计.md)

## 后续方向

- 更完整的群聊归属和群组画像
- 更多消息渠道与移动端查看
- SQLite 上的更强搜索和摘要索引
- 用户可控的主动执行等级与审计记录
