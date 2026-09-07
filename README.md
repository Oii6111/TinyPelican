# TinyPelican · 小鹈鹕

> **AI social copilot.** A local-first relationship reasoning engine: parse chat logs, build living contact profiles, detect relationship signals, and generate follow-up todos, schedules, and reply drafts.

<p align="center">
  <a href="https://github.com/Oii6111/TinyPelican"><img src="https://img.shields.io/github/stars/Oii6111/TinyPelican?style=flat-square" alt="GitHub stars"></a>
  <a href="https://github.com/Oii6111/TinyPelican/blob/main/LICENSE"><img src="https://img.shields.io/github/license/Oii6111/TinyPelican?style=flat-square" alt="License"></a>
  <a href="https://github.com/Oii6111/TinyPelican/commits/main"><img src="https://img.shields.io/github/last-commit/Oii6111/TinyPelican?style=flat-square" alt="Last commit"></a>
</p>

> **Open-source demo for the C-side. The complete seamless enterprise WeCom (企业微信) experience is a closed-source commercial product.**

---

## ⚠️ Read this first: what this repo is NOT

This open-source repository is a **technical verification / C-side demo**:

- ❌ It is **not** a turnkey personal-WeChat assistant. Personal WeChat history is ingested by **manually copying chats (clipboard)** or an **experimental iLink bot channel**.
- ❌ It does **not** provide seamless auto-sync of WeChat, WeCom sidebar integration, multi-tenant SaaS, or enterprise relationship handover.
- ✅ It **does** contain the open relationship-reasoning core: chat parsing, contact profile extraction, intent/todo/schedule generation, proactive reminders, and reply drafting.

**The full seamless WeCom (企业微信) experience — auto-sync, enterprise sidebar, team handover — is a closed-source commercial version.**

If you are looking for a ready-to-use WeChat/WeCom social CRM, this repo is only the kernel, not the product.

---

## What TinyPelican does

Traditional personal CRMs like [Monica](https://github.com/monicahq/monica) require manual data entry. TinyPelican turns imported chat logs into a self-growing relationship memory:

| Capability | Description | Status |
|---|---|---|
| Chat ingestion | Clipboard capture of WeChat chat logs + experimental iLink channel | ✅ Live |
| Contact profiles | One profile per contact, continuously extracted from conversations | ✅ Live |
| Relationship reasoning | Importance, recent context, preferences, boundaries, social goals | ✅ Basic |
| Intent extraction | Tasks, deadlines, schedules, waiting-for-reply | ✅ Basic |
| Proactive reminders | Deadline reminders, do-not-disturb, neglected-relationship nudges | ✅ Basic |
| Reply drafts | Relationship-aware suggestions, one-click fill, never auto-sent | ✅ Live |
| Agent execution | DSH Agent with structured Skills and auditable event stream | ✅ Live |
| Spoken diary via bot | Tell the WeChat bot; memory is settled by the Agent | 🚧 In progress |
| Wearable activity import | AI glasses / cameras / watches as future memory inputs | ⏳ Planned |
| WeCom enterprise version | Auto-sync, sidebar, multi-tenant SaaS, handover | 🔒 Closed-source commercial |

## Why it's different

| | TinyPelican OSS | Monica | General AI assistant |
|---|---|---|---|
| Data entry | Automatic from chat logs | Manual | None |
| Relationship profiles | AI-extracted, continuously updated | Manual forms | No persistent memory |
| Proactive reminders | From chat commitments and relationship signals | User-set reminders only | No |
| Reply drafts | Relationship-aware | No | Generic |
| Local-first | Yes, BYO model key | Self-host option | Cloud |
| WeCom enterprise | Closed-source commercial | No | No |

## Quick start

**Requirements:** Windows, Node.js 18+, DSH WebUI (`http://127.0.0.1:3080`), one OpenAI-compatible model provider.

```powershell
git clone https://github.com/Oii6111/TinyPelican.git
cd TinyPelican
npm install
Copy-Item config.example.json config.json
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

**Open-source C-side (this repo):**

1. Make contact memory, proactive reminders, and reply drafts a daily habit.
2. Improve intent accuracy with human-in-the-loop feedback.
3. Group-chat model and wearable activity import adapters.

**Closed-source commercial (WeCom enterprise version):**

1. Seamless WeCom auto-sync and sidebar assistant.
2. Multi-tenant SaaS with encrypted cloud sync, auto-update, backup.
3. Enterprise relationship handover and team collaboration.

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). We keep a `good first issue` label for newcomers.

## License

MIT License — free for personal learning and open-source use. The enterprise WeCom version and related commercial capabilities are **closed-source and require official commercial authorization**.

See [LICENSE](LICENSE).

---

> ⭐ If this project inspires you, a star helps the project grow. Thank you!

**Repository:** [github.com/Oii6111/TinyPelican](https://github.com/Oii6111/TinyPelican)
