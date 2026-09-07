# 小鹈鹕 TinyPelican

> **AI 社交副驾驶。** 一个本地优先的关系推演引擎：解析聊天记录，构建持续生长的联系人档案，识别关系信号，生成跟进待办、日程与回复草稿。

<p align="center">
  <a href="https://github.com/Oii6111/TinyPelican"><img src="https://img.shields.io/github/stars/Oii6111/TinyPelican?style=flat-square" alt="GitHub stars"></a>
  <a href="https://github.com/Oii6111/TinyPelican/blob/main/LICENSE"><img src="https://img.shields.io/github/license/Oii6111/TinyPelican?style=flat-square" alt="License"></a>
  <a href="https://github.com/Oii6111/TinyPelican/commits/main"><img src="https://img.shields.io/github/last-commit/Oii6111/TinyPelican?style=flat-square" alt="Last commit"></a>
</p>

<p align="center"><a href="README.md">English</a> · <b>中文</b></p>

---

## ⚠️ 先看这里

这个项目**不是**开箱即用的个人微信助手：

- ❌ 它**不会**在后台偷偷读取微信。聊天记录通过**剪贴板自动识别导入：你复制聊天，小鹈鹕自动检测并归档**——或通过**实验性 iLink bot 通道**导入；
- ❌ 它**不承诺**官方微信集成或全场景实时消息同步；
- ✅ 它**开放**的是关系推演内核：聊天解析、联系人画像抽取、意图/待办/日程生成、主动提醒、回复草稿。

如果你关注的是推理引擎和产品思路，那你就来对地方了。

## 它做什么

传统个人 CRM（如 [Monica](https://github.com/monicahq/monica)）需要手动录入。小鹈鹕把复制的聊天记录变成自动生长的关系记忆：

| 能力 | 说明 | 状态 |
|---|---|---|
| 聊天接入 | 剪贴板自动识别微信聊天 + 实验性 iLink 通道 | ✅ 已落地 |
| 联系人档案 | 一人一档，从对话中持续抽取 | ✅ 已落地 |
| 关系推演 | 重要程度、近况、偏好、边界、社交目标 | ✅ 基础版 |
| 意图抽取 | 任务、DDL、日程、等待回复 | ✅ 基础版 |
| 主动提醒 | 到期提醒、免打扰、冷落关系提醒 | ✅ 基础版 |
| 回复草稿 | 懂分寸的关系化建议，一键回填，永不自动发送 | ✅ 已落地 |
| Agent 执行 | DSH Agent + 结构化 Skills，过程可审计 | ✅ 已落地 |
| 语音日记（bot） | 对微信 bot 说话，Agent 沉淀到记忆 | 🚧 进行中 |
| 更多社交通道 | QQ、飞书 / 钉钉、Telegram、邮件、日历 | ⏳ 开发中 |
| 穿戴设备活动导入 | AI 眼镜 / 相机 / 手表作为记忆输入 | ⏳ 规划 |

## 差异化

| | 小鹈鹕 | Monica | 通用 AI 助手 |
|---|---|---|---|
| 数据录入 | 从复制的聊天记录自动 | 手动 | 无 |
| 关系档案 | AI 抽取、持续更新 | 手动表单 | 无持久记忆 |
| 主动提醒 | 从聊天承诺与关系信号生成 | 用户手动设置 | 无 |
| 回复草稿 | 懂关系分寸 | 无 | 通用 |
| 本地优先 | 是，自带模型 Key | 可自托管 | 云端 |

## 更多社交通道正在开发中——欢迎加入 Contributor

当前输入以微信为主（剪贴板自动识别 + 实验性 iLink）。更多社交通道正在规划/开发中：

- QQ、飞书 / 钉钉、Telegram、邮件、日历
- 穿戴设备活动导入（AI 眼镜 / 相机 / 手表）

这个项目由一名本科学生维护，多通道支持需要时间。每个通道都遵循简单的 `connect / stop / send` 契约——如果你对通道适配器、Agent Skills 或关系推演内核感兴趣，**非常欢迎加入成为 Contributor**。详见 [CONTRIBUTING.md](CONTRIBUTING.md)。

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

## 架构

```text
聊天记录（剪贴板 / 实验性 iLink 通道）
        ↓
解析、去重、识别联系人
        ↓
SQLite 联系人与聊天记忆 + 结构化任务/日程
        ↓
结构化 API
        ↓
DSH Agent + Skills
        ↓
回复草稿 / 待确认意图 / 待办 / 提醒 / 日程
        ↓
Web 仪表盘 / Electron 浮窗 / 微信与 Bark 通知
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

## 路线图

1. 让联系人记忆、主动提醒、回复草稿成为日常习惯；
2. 通过人在回路反馈提升意图识别准确率；
3. 群聊模型与穿戴设备活动导入适配器；
4. 增加更多通道适配器（QQ、飞书 / 钉钉、Telegram、邮件、日历）。

## 参与贡献

欢迎贡献，详见 [CONTRIBUTING.md](CONTRIBUTING.md)。我们会为新手维护 `good first issue` 标签。

## License

MIT License —— 个人学习与开源使用免费。详见 [LICENSE](LICENSE)。

---

> ⭐ 如果这个项目对你有启发，欢迎点 star 支持项目发展。

[GitHub 仓库](https://github.com/Oii6111/TinyPelican)
