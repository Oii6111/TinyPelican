# TinyPelican · 小鹈鹕

> **AI social copilot.** A local-first relationship reasoning engine: parse chat logs, build living contact profiles, detect relationship signals, and generate follow-up todos, schedules, and reply drafts.

<p align="center">
  <a href="https://github.com/Oii6111/TinyPelican"><img src="https://img.shields.io/github/stars/Oii6111/TinyPelican?style=flat-square" alt="GitHub stars"></a>
  <a href="https://github.com/Oii6111/TinyPelican/blob/main/LICENSE"><img src="https://img.shields.io/github/license/Oii6111/TinyPelican?style=flat-square" alt="License"></a>
  <a href="https://github.com/Oii6111/TinyPelican/commits/main"><img src="https://img.shields.io/github/last-commit/Oii6111/TinyPelican?style=flat-square" alt="Last commit"></a>
</p>

<p align="center">🌐 <b>English</b> · <a href="README.zh-CN.md">中文</a></p>

---

## ⚠️ Read this first

This project is **not** a turnkey personal-WeChat assistant:

- ❌ It does **not** silently read WeChat in the background. Chat logs are ingested by **automatic clipboard detection: you copy a chat, TinyPelican detects and archives it automatically** — or via an **experimental iLink bot channel**.
- ❌ It does **not** claim official WeChat integration or real-time message sync for all scenarios.
- ✅ It **does** provide the open relationship-reasoning core: chat parsing, contact profile extraction, intent/todo/schedule generation, proactive reminders, and reply drafting.

If you are interested in the reasoning engine and the product idea, you are in the right place.

## What TinyPelican does

Traditional personal CRMs like [Monica](https://github.com/monicahq/monica) require manual data entry. TinyPelican turns copied chat logs into a self-growing relationship memory:

| Capability | Description | Status |
|---|---|---|
| Chat ingestion | Automatic clipboard detection of WeChat chat logs + experimental iLink channel | ✅ Live |
| Contact profiles | One profile per contact, continuously extracted from conversations | ✅ Live |
| Relationship reasoning | Importance, recent context, preferences, boundaries, social goals | ✅ Basic |
| Intent extraction | Tasks, deadlines, schedules, waiting-for-reply | ✅ Basic |
| Proactive reminders | Deadline reminders, do-not-disturb, neglected-relationship nudges | ✅ Basic |
| Reply drafts | Relationship-aware suggestions, one-click fill, never auto-sent | ✅ Live |
| Agent execution | DSH Agent with structured Skills and auditable event stream | ✅ Live |
| Spoken diary via bot | Tell the WeChat bot; memory is settled by the Agent | 🚧 In progress |
| Email | IMAP sync, classification and summaries, SMTP sending, contact email links | ✅ Basic |
| More social channels | QQ, Feishu / DingTalk, Telegram | ⏳ In development |
| Wearable activity import | AI glasses / cameras / watches as future memory inputs | ⏳ Planned |

## Contact history and profiles

The contact workspace uses an avatar-free, three-column layout: contact list, read-only chat history, and a collapsible profile sidebar. Messages are grouped by date with fewer repeated timestamps. Profile cards show saved fields, topic summaries, and analysis status, with an explicit editing and saving workflow.

Date filtering and text export apply to **currently loaded messages only**; load older history first to include it. Clearing history and deleting a contact are separate data-management actions with confirmation. See the [contact workspace guide](docs/contacts-ui.md) for usage and implementation details (Chinese).

## Recent updates

- Native DSH conversations and settings share session state through a same-origin proxy. See the [conversation guide](docs/dsh-webui.md).
- WeChat supports image and file transfers, previews, and partial-send feedback. See the [media guide](docs/weixin-media.md).
- Email adds IMAP synchronization, message classification and summaries, SMTP sending, and contact email links.
- Channels, contacts, tasks, review queues, records, and settings receive UI updates alongside model configuration, Agent context, and startup improvements.

See the [recent changes](docs/recent-changes.md) for implementation and validation notes (Chinese).

## Why it's different

| | TinyPelican | Monica | General AI assistant |
|---|---|---|---|
| Data entry | Automatic from copied chat logs | Manual | None |
| Relationship profiles | AI-extracted, continuously updated | Manual forms | No persistent memory |
| Proactive reminders | From chat commitments and relationship signals | User-set reminders only | No |
| Reply drafts | Relationship-aware | No | Generic |
| Local-first | Yes, BYO model key | Self-host option | Cloud |

## More channels are coming — contributors wanted

Current input is WeChat-first (clipboard auto-detection + experimental iLink). More social channels are under active planning/development:

- QQ, Feishu / DingTalk, Telegram
- Wearable activity import (AI glasses / cameras / watches)

This project is maintained by an undergraduate student, so multi-channel support will take time. Every channel follows a simple `connect / stop / send` contract — if you are interested in channel adapters, Agent Skills, or the relationship-reasoning core, **you are very welcome to join as a contributor**. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Quick start

**Requirements:** Windows, Node.js **22.13+** (Node 24 LTS recommended; `node:sqlite` needs this unflagged runtime), DSH WebUI (`http://127.0.0.1:3080`), one OpenAI-compatible model provider.

```powershell
git clone https://github.com/Oii6111/TinyPelican.git
cd TinyPelican
npm install
npm run daemon
```

Open `http://127.0.0.1:18791` for the WebUI.

Desktop shell:

```powershell
cd app
npm install
npm start
```

Commands:

```powershell
npm run daemon      # core service, clipboard, WeChat, scheduler, Agent queue
npm run server      # WebUI/API only
npm test            # tests
npm run check       # syntax checks
npm run remind:dry  # preview reminder rules
```

## Architecture

```text
Chat logs (clipboard / experimental iLink channel)
        ↓
Parse, deduplicate, resolve contact
        ↓
SQLite contact & chat memory + structured tasks/schedules
        ↓
Structured APIs
        ↓
DSH Agent + Skills
        ↓
Drafts / pending intents / tasks / reminders / schedules
        ↓
Web dashboard / Electron overlay / WeChat & Bark notifications
```

## Repository map

```text
app/                 Electron desktop shell
agent/               Agent.md, Skills, DSH event stream
core/                APIs, Agent, SQLite, ingestion, reminders, channels
dashboard/           Native ES Module WebUI
tests/               Unit and integration tests
```

Runtime data (SQLite, tasks, schedules, intents, credentials, logs, chat records) is gitignored.

## Roadmap

1. Make contact memory, proactive reminders, and reply drafts a daily habit.
2. Improve intent accuracy with human-in-the-loop feedback.
3. Group-chat model and wearable activity import adapters.
4. Add more channel adapters (QQ, Feishu / DingTalk, Telegram, email, calendar).

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). We keep a `good first issue` label for newcomers.

## License

MIT License — free for personal learning and open-source use. See [LICENSE](LICENSE).

---

> ⭐ If this project inspires you, a star helps the project grow. Thank you!

**Repository:** [github.com/Oii6111/TinyPelican](https://github.com/Oii6111/TinyPelican)

新电脑部署请参阅 [部署说明](docs/deployment.md)。安装版数据默认位于 `%APPDATA%/TinyPelican/data`，不会自动读取旧版 `%APPDATA%/xiaotihu`。
