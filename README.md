# 小鹈鹕 AI V3（TinyPelican）

> **“长记忆 + 主动关系 + 会自己动手的 Agent”个人 AI 助手。**
>
> 复制微信聊天记录，小鹈鹕自动归档联系人、提取任务与 DDL、主动提醒你维护关系；所有对话默认由 DSH Agent 大模型回复，并在 WebUI 里像 DSH 一样逐步展示思考与工具调用。

---

## 项目特色

| 特色 | 一句话 |
|------|--------|
| 🧠 长记忆 | 每个人一个档案：近况、偏好、承诺、情绪趋势，自动沉淀 |
| 🔔 主动关系 | 标记「特别关心」，长时间没联系会自动提醒你维护 |
| 📌 任务不流失 | 聊天里的“下周发方案”自动变成 DDL，到期前提醒 |
| 🤖 DSH Agent 对话 | 所有通道对话默认走 DSH harness 大模型回复，不只是小模型问答 |
| 🖥️ 逐步可见 | WebUI 流式展示 Agent 的思考、工具调用、执行过程，最终回答独立清晰 |
| 💡 回复建议 | 复制聊天后自动生成 3 条建议，右下角小图标点击查看，一键填入微信输入框（不自动发送） |
| 🔒 本地优先 | 数据默认存本地，真实聊天记录/凭据不进 Git |

---

## 当前能力

- ✅ 微信 iLink 双向通道：扫码登录 + 收发消息 + 提醒推送
- ✅ 剪贴板捕获聊天记录：自动识别、去重、归档联系人
- ✅ 联系人一人一档案：画像 + 聊天记录，支持直接编辑备注/画像
- ✅ 聊天记录管理：清空某联系人记录、删除联系人，同步清理 `inbox.jsonl`
- ✅ 意图识别 / 待确认行动 / 主动提醒调度
- ✅ DSH Agent 对话：所有通道对话走 DSH harness 大模型回复
- ✅ Agent 事件流：思考/工具调用/执行过程实时展示，工具结果自动截断
- ✅ 回复建议浮窗：私聊复制后生成 3 条建议，小图标 + 卡片展示，点击回填微信输入框
- ✅ 本地 Web 看板：对话、联系人、聊天记录、主动策略、Agent 执行过程

---

## 快速开始

### 环境要求

- Windows
- Node.js 18+

### 安装与启动

```powershell
cd C:\Users\Lenovo\v3
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
cd C:\Users\Lenovo\v3\app
npm install
npm start
```

> 如果 DSH 没有通过 npm 安装成功，可设置 `DSH_BIN` 指向本机 `@deepseek-ai/dsh/lib/bin.js`。

### 常用命令

```powershell
npm run server   # 只看板
npm test         # 测试
npm run check    # 全量语法检查
```

---

## 技术架构

```
微信 iLink / 剪贴板
        │
        ▼
记忆输入 → 联系人档案 / 意图 / 关系状态
        │
        ▼
DSH Agent（core/agent + agent/dsh-event-stream）
        │
        ▼
WebUI 流式展示思考 / 工具调用 / 最终回答
```

- `core/engine/`：多 Provider 大模型接入
- `core/agent/`：DSH harness 对话任务、事件裁剪、增量事件接口
- `core/reply/`：回复建议生成、内存状态、安全回填（窗口句柄仅存后端）
- `agent/dsh-event-stream/`：DSH 自定义插件，把 session/event 输出为 JSONL
- `dashboard/`：原生 ES Module 看板，无构建步骤
- 数据：本地 JSON / JSONL / TOML

---

## 隐私

- 真实联系人档案、聊天流水、意图库、配置凭据默认被 `.gitignore` 排除
- Agent 工具结果默认截断，历史会话只保存最终回答与执行摘要
- 联系人页可随时编辑/删除画像、清空聊天记录

---

## 相关文档

- [产品设计](产品设计.md)
- [ARCHITECTURE.md](ARCHITECTURE.md)
- [RULES.md](RULES.md)

---

## GitHub 项目描述（About 用）

> **小鹈鹕 AI（TinyPelican）**：一个“长记忆 + 主动关系 + DSH Agent”的个人 AI 助手。复制微信聊天记录即可自动归档联系人、提取任务与 DDL、主动提醒维护关系；对话由 DSH Agent 驱动，WebUI 逐步展示思考与工具调用。
