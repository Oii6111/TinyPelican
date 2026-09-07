# 小鹈鹕 TinyPelican

> **自动化的个人关系操作系统。**
> 小鹈鹕把聊天和真实世界的互动，变成自动生长的个人记忆——联系人档案、承诺、提醒和回复建议，全部由 AI 持续维护。

<p align="center">
  <a href="https://github.com/Oii6111/TinyPelican">GitHub 仓库</a>
  ·
  <a href="https://github.com/Oii6111/TinyPelican/issues">问题反馈</a>
  ·
  <a href="https://github.com/Oii6111/TinyPelican/discussions">讨论区</a>
</p>

[English](README.md) · **中文**

## 它做什么

传统个人 CRM（如 [Monica](https://github.com/monicahq/monica)）需要用户手动录入一切。小鹈鹕把这件事变成自动：

- **聊天 → 档案。** 微信消息解析、去重、识别联系人，沉淀为一人一档。
- **对话 → 行动。** 承诺、DDL、日程自动抽取，进入待确认队列。
- **主动提醒。** 到期提醒、未回复检测、重要关系冷落提醒。
- **懂分寸的回复建议。** 同一句话，对家人、朋友、客户语气完全不同。
- **Agent 原生。** DSH Agent + 结构化 Skills 执行任务，思考与工具调用全程可追溯。

```text
微信 / 剪贴板 / bot 日记
        ↓
解析、去重、识别联系人
        ↓
SQLite 联系人与聊天记忆 + 结构化任务/日程
        ↓
结构化查询、校验、落库 API
        ↓
DSH Agent + Skills
        ↓
回复草稿 / 待确认意图 / 待办 / 提醒 / 日程
        ↓
Web 仪表盘 / Electron 浮窗 / 微信与 Bark 通知
```

## 当前状态

| 能力 | 状态 |
|---|---|
| 剪贴板自动捕获微信聊天 | ✅ 已落地 |
| 微信 iLink 双向通道 | ✅ 已落地 |
| 联系人一人一档 + 聊天时间线 | ✅ 已落地 |
| 意图抽取（任务 / DDL / 日程） | ✅ 基础版 |
| 主动提醒 + 免打扰 | ✅ 基础版 |
| 回复建议悬浮窗（Electron） | ✅ 已落地 |
| 微信 bot 对话 + DSH Agent 执行 | ✅ 已落地 |
| 语音转写回填 | ✅ 已落地 |
| 语音日记沉淀（bot） | 🚧 进行中 |
| 穿戴设备活动导入（AI 眼镜 / 相机 / 手表） | ⏳ 规划 |
| 官方托管（自动更新 / 备份 / 同步） | ⏳ 规划 |

## 快速开始

**环境要求：** Windows、Node.js 18+、DSH WebUI（默认 `http://127.0.0.1:3080`）、至少一个 OpenAI 兼容模型 Provider。

```powershell
git clone https://github.com/Oii6111/TinyPelican.git
cd TinyPelican
npm install
Copy-Item config.example.json config.json
npm run daemon
```

打开 `http://127.0.0.1:18791` 使用 WebUI。

桌面端：

```powershell
cd app
npm install
npm start
```

常用命令：

```powershell
npm run daemon      # 核心服务、剪贴板、微信、调度器、Agent 队列
npm run server      # 仅启动 WebUI/API
npm test            # 测试
npm run check       # 全量语法检查
npm run remind:dry  # 预览提醒规则
```

## 目录结构

```text
app/                 Electron 桌面端
agent/               Agent.md、Skills、DSH 事件流
core/                API、Agent、SQLite、导入、提醒、通道
dashboard/           原生 ES Module WebUI
tests/               单元测试和集成测试
```

运行数据（SQLite、任务、日程、意图、凭据、日志、聊天记录）均已加入 Git 忽略。

## 数据与隐私

- 本地优先：联系人、画像和聊天消息默认保存在本地 SQLite。
- 自带模型 Key：支持 OpenAI、SiliconFlow、DeepSeek、Ollama 及自定义 OpenAI 兼容端点。
- 剪贴板只识别聊天记录格式，非聊天内容立即丢弃。
- 将 WebUI 暴露到局域网 / 公网前，请开启 `auth.enabled`。

## 路线图

1. **现在** —— 让联系人记忆、主动提醒、回复建议成为日常习惯。
2. **下一步** —— 穿戴设备导入（AI 眼镜 / 相机 / 手表）、更多渠道、群聊支持。
3. **更长期** —— 可配置的自主等级、可审计的自动化工作流。

## 文档

- [ARCHITECTURE.md](ARCHITECTURE.md) — 架构与模块说明
- [RULES.md](RULES.md) — 聊天归档规则
- [agent/README.md](agent/README.md) — DSH Agent 集成
- [产品设计.md](产品设计.md) — 产品与商业叙事

[GitHub 仓库](https://github.com/Oii6111/TinyPelican)
