# 小鹈鹕 AI（TinyPelican）

> **“长记忆 + 主动关系 + 会自己动手的 Agent”个人 AI 助手。**
>
> 复制微信聊天记录，小鹈鹕自动归档联系人、提取任务与 DDL、主动提醒你维护关系；WebUI 对话默认由 DSH Agent 驱动，像 DSH 一样流式展示思考、工具调用与执行过程。

---

## 项目状态

当前版本：`0.4.0`

- ✅ 核心服务 + Web 看板 + Electron 桌面壳可运行
- ✅ 对话/微信消息统一走 DSH Web 常驻会话
- ✅ DSH Web 会话按项目目录隔离，项目迁移不会误用旧目录历史会话
- ✅ 新 DSH Web 会话自动注入「小鹈鹕人设 + 本地数据上下文」
- ✅ 所有运行时路径使用相对定位/环境变量解析，不在代码中写死个人路径

---

## 功能特性

| 特色 | 一句话 |
|------|--------|
| 🧠 长记忆 | 每个联系人一个档案：近况、偏好、承诺、情绪趋势，自动沉淀 |
| 🔔 主动关系 | 标记「特别关心」，长时间没联系会自动提醒你维护 |
| 📌 任务不流失 | 聊天里的“下周发方案”自动变成 DDL，到期前提醒 |
| 🤖 DSH Agent 对话 | WebUI/微信对话默认走 DSH 常驻 Agent，不只是小模型问答 |
| 🖥️ 逐步可见 | 流式展示 Agent 的思考、工具调用、执行过程，最终回答独立清晰 |
| 💡 回复建议 | 复制聊天后自动生成 3 条建议，右下角小图标点击查看，可一键填入微信输入框（不自动发送） |
| 🔒 本地优先 | 数据默认存本地，真实聊天记录/凭据不进 Git |

---

## 当前能力

- ✅ 微信 iLink 双向通道：扫码登录、收发消息、提醒推送
- ✅ 剪贴板捕获聊天记录：自动识别、去重、归档联系人
- ✅ 联系人一人一档案：画像 + 聊天记录，支持直接编辑备注/画像
- ✅ 聊天记录管理：清空某联系人记录、删除联系人，同步清理 `inbox.jsonl`
- ✅ 意图识别 / 待确认行动 / 主动提醒调度
- ✅ DSH Web 常驻会话：WebUI 与微信主会话统一使用，事件流实时可见
- ✅ Agent 事件流：思考/工具调用/执行过程实时展示，工具结果自动截断
- ✅ 回复建议浮窗：私聊复制后生成 3 条建议，小图标 + 卡片展示，点击回填微信输入框
- ✅ 本地 Web 看板：对话、联系人、聊天记录、主动策略、Agent 执行过程、设置
- ✅ Electron 桌面壳：自动拉起核心服务，提供右下角建议浮窗
- ✅ 多 Provider 引擎：SiliconFlow / OpenAI / DeepSeek / Ollama / 自定义 OpenAI 兼容端点

---

## 快速开始

### 环境要求

- Windows
- Node.js 18+
- 已安装 `@deepseek-ai/dsh`（执行 `npm install` 会自动安装；也可用 `DSH_BIN` 指向本机 DSH）

### 安装与启动

在仓库根目录（含 `package.json` 的目录）打开终端：

```powershell
npm install          # 自动安装 @deepseek-ai/dsh
copy config.example.json config.json

npm run daemon       # 完整守护：服务 + 剪贴板 + 微信通道 + 定时调度
```

然后打开看板：

```text
http://127.0.0.1:18791
```

桌面壳（可选）：

```powershell
# 在仓库根目录下的 app/ 目录打开终端
npm install
npm start
```

如果 DSH 没有通过 npm 安装成功，可设置环境变量 `DSH_BIN` 指向本机 `@deepseek-ai/dsh/lib/bin.js`。

### 常用命令

```powershell
npm run server    # 只看板
npm test          # 测试
npm run check     # 全量语法检查
npm run remind:dry # 提醒规则演练（不发送）
```

---

## 快速使用

1. **配置模型服务**：打开看板 → 设置 → 模型服务，选择服务商并填写 API Key/模型；也可直接编辑 `config.json`。
2. **微信通道（可选）**：设置页扫码登录 iLink；入站消息自动归档，主会话由 DSH Agent 回复。
3. **剪贴板捕获**：在「记忆 → 记忆输入」开启；复制微信聊天记录后自动识别并归档联系人。
4. **对话**：顶部「💬 对话」新建会话；每条消息会进入 DSH Web 常驻会话，实时显示 Agent 事件。
5. **回复建议**：私聊复制内容后，右下角小图标出现建议卡片；点击建议会安全填入微信输入框，不自动发送。
6. **主动策略**：在「主动 → 策略配置」调整主动级别、关系维护频率、提醒提前量、免打扰时段。

---

## 架构

```
微信 iLink / 剪贴板捕获
        │
        ▼
记忆输入（ingest）→ 联系人档案 / 意图 / 关系状态 / 对话记录
        │
        ▼
Agent 层（DSH Web 常驻会话 / DSH Headless）
        │
        ▼
WebUI 流式展示思考 / 工具调用 / 最终回答
```

### 目录结构

```
app/                       Electron 桌面壳（拉起核心、浮窗、热重启）
agent/
  dsh-event-stream/        小鹈鹕 DSH 插件：把 session/event 输出为 JSONL
  dsh-home/profiles/       小鹈鹕专用 DSH profile（headless 使用）
core/                      核心服务（Node，无框架依赖）
  engine/                  多 Provider 大模型接入、提示词任务、意图/提醒/建议
  agent/                   DSH 客户端、DSH Web 常驻会话、主会话、任务队列
  channels/                通道接入（当前微信 iLink）
  memory/                  联系人档案、意图库、对话、未读、语音待回填
  ingest/ + capture/       批次/实时消息解析、去重、归档；剪贴板监听
  remind/                  主动提醒调度与执行
  api/                     HTTP 路由/API
  lib/                     路径、配置、日志、存储等横切能力
  index.js                 常驻入口
dashboard/                 本地 Web 看板（原生 ES Module，无构建步骤）
tests/                     单元测试与 fixture 测试
config.example.json        配置模板
```

---

## DSH Agent 集成

小鹈鹕的 Agent 能力由 DSH 提供，包含两套执行路径：

- **DSH Web 常驻会话（主路径）**
  - WebUI 对话与微信主对话默认走 DSH Web（默认 `127.0.0.1:3080`）。
  - 同一个会话内串行发送消息，避免并发乱序。
  - 会话 ID 绑定项目目录：项目移动/改名后不会误用旧目录的历史 DSH 会话，也不会触发 `same sessionId + different cwd` 冲突。
  - 新会话首条消息注入小鹈鹕人设、本地数据目录、搜索规则与最近对话历史；后续消息由 DSH 会话自身记忆承接。
- **DSH Headless（降级/任务路径）**
  - Agent 任务页、队列 Worker 和 DSH Web 不可用时的降级回复使用一次性 `dsh --profile xiaotihu` headless 进程。
  - 自定义插件 `agent/dsh-event-stream` 负责把 Agent 事件流输出为 JSONL。

### DSH 相关环境变量

| 变量 | 用途 |
|------|------|
| `DSH_BIN` | 指定 `@deepseek-ai/dsh/lib/bin.js` 的路径 |
| `DSH_WEB_URL` | 指定 DSH Web 服务地址，默认 `http://127.0.0.1:3080` |
| `XIAOTIHU_NODE` | Electron 壳查找 Node 时优先使用该路径（可选） |
| `XIAOTIHU_DATA_DIR` | 打包模式下数据目录；开发模式默认使用项目根目录 |

---

## 配置说明

配置从 `config.example.json` 复制为 `config.json`，隐私数据默认不会入库。

| 配置 | 说明 |
|------|------|
| `engine.provider` / `engine.providers.*` | 模型服务商、Base URL、API Key、模型 |
| `agent.reply.enabled` | 是否启用通道自动回复 |
| `agent.queue` | 小模型任务队列的 DSH Worker 配置 |
| `selfNicknames` | 自己的微信昵称（归档分组用） |
| `capture.enabled` | 剪贴板捕获开关（默认关闭） |
| `capture.replySuggestions` | 回复建议开关、条数、有效期 |
| `relationCheck` / `reminder` / `doNotDisturb` | 关系维护、DDL/日程提醒、免打扰 |
| `proactivity.level` | 全局主动级别 |
| `heartbeat.intervalSec` | 心跳/状态刷新间隔 |
| `weixinPush` | 微信主动推送账号配置 |

---

## 数据与隐私

- 数据默认本地存储：`contacts/`、`inbox.jsonl`、`intents.json`、`config.toml` 等。
- 开发模式数据目录 = 项目根目录；打包模式由 `XIAOTIHU_DATA_DIR` 指定，首次运行会复制配置模板到用户数据目录。
- 真实联系人档案、聊天流水、配置凭据默认被 `.gitignore` 排除。
- Agent 工具结果默认截断，历史会话只保存最终回答与执行摘要。
- 联系人页可随时编辑/删除画像、清空聊天记录。
- 剪贴板只识别聊天记录格式，非聊天内容丢弃。

---

## 相关文档

- [ARCHITECTURE.md](ARCHITECTURE.md) — 技术架构
- [RULES.md](RULES.md) — 社交关系归档规则
- [产品设计.md](产品设计.md) — 产品设计文档
- [agent/README.md](agent/README.md) — DSH Agent 后端集成说明

---

## GitHub 项目描述（About 用）

> **小鹈鹕 AI（TinyPelican）**：一个“长记忆 + 主动关系 + DSH Agent”的个人 AI 助手。复制微信聊天记录即可自动归档联系人、提取任务与 DDL、主动提醒维护关系；对话由 DSH Agent 驱动，WebUI 逐步展示思考与工具调用。
