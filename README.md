# TinyPelican · 小鹈鹕

> A local-first personal Agent for contact memory, commitments, reminders, schedules, and context-aware reply suggestions.

🌐 **English** · [中文](README.zh-CN.md)

## What it does

TinyPelican runs on Windows and turns copied WeChat conversations into searchable contact memory. It combines a SQLite chat database, a proactive dashboard, task and schedule management, and a DSH Agent that uses system Skills instead of keyword routing.

The DSH Agent is the natural-language decision maker. Backend APIs validate fields, enforce permissions, prevent duplicates, and persist changes. The Agent does not scan the project or edit data files directly.

```text
WeChat / clipboard
        │
        ▼
Parse → deduplicate → resolve contact
        │
        ▼
SQLite: contacts, profiles, social goals, messages
        │
        ├── search / contact context / reply suggestions
        └── intent review → task, reminder, or schedule
                                      │
                                      ▼
                              DSH Agent + system Skills
```

## Current capabilities

- WeChat-style contact list with remark-first names and direct chat view.
- SQLite storage for contacts, profiles, social goals, messages, and indexed search.
- Clipboard chat import with parsing, deduplication, contact discovery, and incremental ingestion.
- Reply suggestions generated in this order: recent copied context, social goal, profile, then targeted historical search. Suggestions fill the input box and never auto-send.
- Pending-intent review before creating tasks, reminders, or schedules.
- Proactive dashboard with calendar, scrollable and paginated todos, schedules, reminders, pending intents, and Agent records.
- Persistent DSH Web sessions for WebUI and WeChat, with streaming tool events and a task queue.
- Electron desktop shell with core-process supervision and a floating reply-suggestion card.
- Optional authentication, WeChat/Bark notifications, relationship reminders, and voice-transcript backfill.

## Quick start

### Requirements

- Windows
- Node.js 18+
- A DSH WebUI at `http://127.0.0.1:3080` by default
- At least one configured OpenAI-compatible model provider

```powershell
git clone <your-repository-url>
cd TinyPelican
npm install
Copy-Item config.example.json config.json
```

Edit `config.json` before starting. Set `selfNicknames`, configure a model provider, and choose whether clipboard capture is enabled. If the WebUI is exposed through a LAN, reverse proxy, or Cloudflare Tunnel, enable `auth.enabled` and set a strong username/password.

Start the full local service:

```powershell
npm run daemon
```

Open `http://127.0.0.1:18791`. To run only the WebUI/API, use `npm run server`.

### Electron shell

```powershell
cd app
npm install
npm start
```

The desktop shell starts the core service, establishes the local auth cookie when needed, and displays reply suggestions. Packaged builds use `XIAOTIHU_DATA_DIR` for writable data; development runs use the repository directory.

## Commands

```powershell
npm run daemon      # core, clipboard, WeChat, scheduler, and Agent queue
npm run server      # local WebUI/API only
npm test            # Node.js tests
npm run check       # syntax checks
npm run remind:dry  # preview reminder rules
```

Useful environment variables:

| Variable | Purpose |
|---|---|
| `DSH_BIN` | Override the local DSH executable |
| `DSH_WEB_URL` | DSH WebUI URL; defaults to `http://127.0.0.1:3080` |
| `XIAOTIHU_NODE` | Node executable override for Electron |
| `XIAOTIHU_DATA_DIR` | Writable data directory for packaged mode |

## Repository layout and data

```text
app/                 Electron desktop shell
agent/               Agent.md, Skills, and DSH event-stream plugin
core/                API, Agent, SQLite, ingestion, reminders, and channels
dashboard/           Native ES Module WebUI; no build step
tests/               Unit and integration tests
tinypelican.sqlite   Local contact/profile/message database; never commit it
tasks.json           Local tasks and reminders
schedules.json       Local schedules
intents.json         Local pending intents
config.json          Local configuration and secrets
```

The SQLite database uses WAL mode, so `tinypelican.sqlite-shm` and `tinypelican.sqlite-wal` are also runtime files. Chat content, credentials, logs, Agent sessions, and local configuration are ignored by Git. Legacy contact JSON is only a one-time migration source and is not the runtime chat store.

## System Skills

The capability index is `agent/Agent.md`; individual Skills live under `agent/skills/`. Contact and chat data must be queried through structured system tools:

```powershell
node core/agent/system-cli.js query contacts
node core/agent/system-cli.js search-chat "keyword" [contact]
node core/agent/system-cli.js contact-context "contact-or-remark"
```

This keeps the Agent focused on decisions while the backend owns validation and persistence.

## Security

- Keep authentication enabled whenever the WebUI is reachable beyond the local machine.
- Never commit `config.json`, API keys, WeChat context, SQLite files, or chat records.
- Reply suggestions are drafts only; they are not sent automatically.

## Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md)
- [RULES.md](RULES.md)
- [agent/README.md](agent/README.md)
- [产品设计.md](产品设计.md)
