# DSH Agent 后端集成（小鹈鹕）

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
