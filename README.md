# 小鹈鹕 V3 — 社交关系归档（MVP 第一刀）

> 复制微信聊天记录 → 自动识别格式 → 解析入库 → Agent 为每个联系人维护「画像 + 聊天记录」文档。

## 已实现（本目录）

| 文件/目录 | 作用 |
|-----------|------|
| `watch-clipboard.ps1` | 剪贴板监听器：嗅探「昵称 YYYY年MM月DD日 HH:mm 内容」格式 → 解析去重 → 写入 `inbox.jsonl` + `pending.jsonl` → 去抖后触发 Agent |
| `start.ps1` | 一键启动：确保 gateway 在线 → 启动监听器 |
| `RULES.md` | Agent 侧行为契约（一人一文档规则） |
| `config.json` | 配置：`selfNicknames`（你的微信昵称）、`weixinPush`（微信推送账号/目标）、`pollMs`、`debounceMs`、`minMatchLines` |
| `contacts/` | 产物：每个联系人一个 `.json`（画像 + 聊天记录） |
| `batches/` | 待处理批次（监听器写入，处理完成后删除） |
| `inbox.jsonl` | 全量聊天流水（只读） |
| `dashboard/` | 最小 Web 看板（`server.mjs` + `index.html`，含后台日志页） |
| `check_relations.js` | 关系维护提醒：扫描「特别关心」联系人，超过 N 天未联系则生成问候建议并微信推送 |
| `relation-pushed.json` | 关系维护去重状态（避免同一个人反复提醒） |
| `voice-pending.json` | 语音待回填队列：记录还没回填内容的语音占位 |
| `extract_intents.js` | 意图识别：新聊天归档后触发（带冷却），调用 intent Agent 提取任务/DDL/日程/事项/等待回复 |
| `intents.json` | 意图库：识别出的结构化意图条目 |
| `intent-state.json` | 意图增量处理游标：记录每个联系人已扫描到的时间 |
| `remind.js` | 主动提醒引擎：消费 `intents.json`，按 DDL/日程/事项时间点推送微信提醒 |

## 启动

```powershell
# 方式 A：一键（自动拉起 gateway + 监听器）
powershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\Lenovo\v3\start.ps1

# 方式 B：gateway 已在跑，直接启动监听器
powershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\Lenovo\v3\watch-clipboard.ps1
```

## 看板

```powershell
node C:\Users\Lenovo\v3\dashboard\server.mjs
# 浏览器打开 http://127.0.0.1:18791
```

## 关键配置：selfNicknames

项目不把个人 `config.json` 提交到 git；首次使用先复制 `config.example.json` 为 `config.json`。
把你的**微信昵称**填进 `config.json` 的 `selfNicknames`（数组），例如：

```json
{ "selfNicknames": ["六壹"] }
```

- **填了**：Agent 会跳过你自己，只为「对方」建档，且每个文档写**完整对话**（双方消息）。
- **不填**：退化为「每个出现的昵称各建一个文档，只写该昵称自己的消息」。

## 主动推送 + 新联系人备注

- 归档成功后，会往你微信推「小鹈鹕已成功消化 N 条聊天记录，吃饱啦」。
- 发现**新联系人**时，会推「发现新联系人「昵称」，请回复备注名」；你在微信里直接回复备注名，就会写进该联系人档案标题下的 `**备注**` 行。
- 推送账号/目标在 `config.json` 的 `weixinPush` 里配置（`enabled: false` 可关闭）。
- 待备注队列：`remark-pending.json`（由监听器写入、Agent 处理后清除）。

## 关系维护提醒

- 在 Dashboard「档案」页给联系人点 ⭐，标记为「特别关心」。
- `check_relations.js` 会找出超过 `relationCheck.days` 天没联系的人，用 LLM 生成一条自然问候建议，推送到你的微信。
- 已接入 OpenClaw cron：每天 09:00 自动执行一次（任务名 `xiaotihu-relation-check`）。
- 配置项在 `config.json` 的 `relationCheck`：
  ```json
  { "enabled": true, "days": 7 }
  ```

## 语音转写回填

- 复制聊天记录时，`【语音】` 会先保留为占位，并进入 `voice-pending.json` 待回填队列。
- 之后你按顺序复制微信「转文字」后的纯文本，监听器会把第 1 条文本填给第 1 条语音、第 2 条填给第 2 条，依此类推。
- Dashboard「语音」页可以看到待回填列表，也可以手动跳过。
- 如果语音已经归档到联系人档案，回填时会直接更新对应联系人 JSON；如果还没归档，会先更新待处理批次。

## 意图识别

- `extract_intents.js` 在**新聊天归档后自动触发**（不再每小时全量扫描），调用 `intent` Agent（Qwen3.5-9B）识别：
  - `task` 任务
  - `deadline` DDL
  - `schedule` 日程
  - `reminder` 事项提醒
  - `waiting_reply` 等待回复
- 结果写入 `intents.json`，处理进度记录在 `intent-state.json`。
- 触发带冷却：默认两次识别至少间隔 10 分钟（`intent.minIntervalMinutes`），避免频繁复制时反复烧 token。
- 高置信度（≥ 0.85）自动添加并微信推送；中置信度推送待确认；低置信度只进 Dashboard。
- Dashboard「意图」页可以查看、确认、忽略、修改。

## 主动提醒引擎

- `remind.js` 消费 `intents.json` 中 `status=auto_added/confirmed` 且带 `dueAt` 的意图。
- 提醒节点：
  - `deadline`：提前 1 天、提前 2 小时、到期
  - `schedule`：提前 30 分钟、开始时
  - `reminder`：到期时
  - `task`：到期时（如有 dueAt）
- 每条意图通过 `reminders` 数组记录已提醒过的节点，避免重复推送。
- **免打扰时段**：`doNotDisturb` 配置时间段内不推送，等结束后下一轮自动补推；支持跨天（如 23:00 - 08:00）。
- **按需生成文案**：只有真正到提醒节点时才调用小模型生成提醒消息，平时纯代码检查，0 token。
- 已接入 OpenClaw cron：每 15 分钟执行一次（任务名 `xiaotihu-remind`）。
- 支持 `node remind.js --dry-run` 本地测试不真实推送。

## 后台日志

- Dashboard「日志」页显示小鹈鹕后台活动：剪贴板捕获、意图识别、主动提醒、关系维护、微信推送等。
- 日志写入 `activity.log`（JSON Lines），可通过日志页按级别筛选。
- 日志页每 5 秒自动刷新，方便测试时观察智能体在后台做了什么。

## 隐私

- 剪贴板只认「聊天记录格式」，非聊天内容（密码/验证码/普通文本）直接丢弃，不落盘。
- 数据只写本地 `C:\Users\Lenovo\v3\`，绝不上传、绝不外发。

## 下一步（待接入）

- 微信回复确认：用户在微信里回复“确认/忽略”直接更新意图状态
- 群聊消息模型：群聊识别、群聊档案、任务指向判断
- 提醒策略增强：重复提醒、位置提醒、稍后提醒我
