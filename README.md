# TinyPelican · 小鹈鹕

> **The automatic relationship OS.**
> TinyPelican turns conversations and real-world interactions into a self-growing personal memory — profiles, commitments, reminders, and replies, maintained automatically by AI.

<p align="center">
  <a href="https://github.com/Oii6111/TinyPelican">GitHub</a>
  ·
  <a href="https://github.com/Oii6111/TinyPelican/issues">Issues</a>
  ·
  <a href="https://github.com/Oii6111/TinyPelican/discussions">Discussions</a>
</p>

🌐 **English** · [中文](README.zh-CN.md)

## What it does

Traditional personal CRMs (like [Monica](https://github.com/monicahq/monica)) require manual data entry. TinyPelican removes that burden:

- **Chat → profiles.** WeChat messages are parsed, deduplicated, and resolved into one living profile per contact.
- **Conversations → actions.** Commitments, deadlines, and schedules are extracted and queued for your confirmation.
- **Proactive reminders.** For deadlines, silent replies, and neglected important relationships.
- **Relationship-aware reply drafts.** Same sentence, different tone for family, friends, and customers.
- **Agent-native.** A DSH Agent with structured Skills handles tasks with a transparent, auditable event stream.

```text
WeChat / clipboard / bot diary
        ↓
parse, deduplicate, resolve contact
        ↓
SQLite contact & chat memory + structured tasks/schedules
        ↓
structured APIs
        ↓
DSH Agent + Skills
        ↓
drafts / pending intents / tasks / reminders / schedules
        ↓
Web dashboard / Electron overlay / WeChat & Bark notifications
```

## Current status

| Capability | Status |
|---|---|
| Clipboard capture of WeChat chats | ✅ Live |
| WeChat iLink channel (two-way) | ✅ Live |
| Per-contact profile + chat timeline | ✅ Live |
| Intent extraction (tasks / deadlines / schedules) | ✅ Basic |
| Proactive reminders + do-not-disturb | ✅ Basic |
| Reply suggestion overlay (Electron) | ✅ Live |
| WeChat bot conversation + DSH Agent execution | ✅ Live |
| Voice transcription backfill | ✅ Live |
| Spoken diary via bot | 🚧 In progress |
| Wearable activity import (AI glasses / cameras / watches) | ⏳ Planned |
| Managed hosting (auto-update / backup / sync) | ⏳ Planned |

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

## Repository map

```text
app/                 Electron desktop shell
agent/               Agent.md, Skills, DSH event stream
core/                APIs, Agent, SQLite, ingestion, reminders, channels
dashboard/           Native ES Module WebUI
tests/               Unit and integration tests
```

Runtime data (SQLite, tasks, schedules, intents, credentials, logs, chat records) is gitignored.

## Data & privacy

- Local-first: contacts, profiles, and chat messages live in a local SQLite database by default.
- Bring your own model provider (OpenAI, SiliconFlow, DeepSeek, Ollama, custom OpenAI-compatible endpoints).
- Clipboard capture only recognizes chat-log formatting; non-chat content is discarded.
- Enable `auth.enabled` before exposing the WebUI beyond localhost.

## Roadmap

1. **Now** — make contact memory, proactive reminders, and reply drafts a daily habit.
2. **Next** — wearable import (AI glasses / cameras / watches), more channels, group chats.
3. **Later** — configurable autonomy levels, auditable automated workflows.

## Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md) — architecture and module map
- [RULES.md](RULES.md) — chat archive rules
- [agent/README.md](agent/README.md) — DSH Agent integration
- [产品设计.md](产品设计.md) — product & business narrative (Chinese)

**Repository:** [github.com/Oii6111/TinyPelican](https://github.com/Oii6111/TinyPelican)
