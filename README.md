# TinyPelican · 小鹈鹕 AI

> **Your second brain for relationships, promises, and personal tasks.**
>
> TinyPelican quietly turns everyday chat messages into durable memory, active reminders, and a personal Agent that helps you maintain the people and commitments that matter.

🌐 **English** · [中文](README.zh-CN.md)

---

## Why TinyPelican?

Most AI assistants are reactive: you have to ask, and they answer. But the real information that matters to you lives in casual conversations — a friend's new job, a client's deadline, a promise to send a document, a relationship you haven't touched in weeks.

Existing tools fail in the same way:

| Problem | Existing tools | TinyPelican |
|---|---|---|
| **Memory is lost** | Generic AI chats disappear when the session ends | Each person gets a living profile built over time |
| **Promises slip away** | Todo apps need manual entry; calendars don't understand chat | "Send the plan next Monday" becomes a tracked DDL automatically |
| **Relationships get cold** | Reminders are dumb timers | Important people who haven't been contacted get proactively surfaced |
| **Replying is stressful** | Input methods only autocomplete words | Reply suggestions are generated from real relationship context |
| **Setup is heavy** | Agents need prompts, files, and configuration | **Copy a WeChat chat → TinyPelican does the rest** |

**TinyPelican is built on a simple bet:** the next generation of personal AI is not a chatbot you open when you need help — it is a continuously present assistant that remembers, notices, and acts.

---

## Vision

> From **"you tell the AI what to do"** to **"the AI tells you what deserves your attention."**

TinyPelican is the personal-scene implementation of a **Relationship OS**:
- Long-term memory that survives across sessions
- Proactive timing — it knows when to nudge you
- Relationship state machines — it understands the people behind the messages
- Local-first trust — your private data stays on your machine

Today it starts with WeChat chat records on your PC. The architecture is designed to grow toward a general personal AI companion across platforms.

---

## How It Works

```
WeChat / clipboard input
        │  copy & paste, or incoming message
        ▼
Memory Ingestion → contacts, intents, relationships, conversation history
        │
        ▼
DSH Agent (persistent Web session + headless fallback)
        │
        ▼
Dashboard: streaming thoughts, tool calls, execution, final answer
```

1. **You copy a chat** (or a WeChat message arrives).
2. TinyPelican recognizes the conversation, deduplicates it, and files it under the right person.
3. It extracts tasks, deadlines, and relationship context.
4. Later, it reminds you at the right moment and helps you reply with context-aware suggestions.
5. When you open the dashboard, the DSH Agent can read local files, run commands, and explain its reasoning step by step.

---

## What Already Works

| Capability | Status | Notes |
|---|---|---|
| 💬 **DSH Agent conversations** | ✅ Live | WebUI and WeChat use a persistent DSH Web session with streaming thoughts/tool calls |
| 🧠 **Per-person long memory** | ✅ Live | One profile per contact: recent updates, preferences, promises, emotional trends |
| 📋 **Clipboard capture** | ✅ Live | Automatically recognizes, dedupes, and archives copied WeChat chats |
| 🔔 **Relationship maintenance** | ✅ Live | Starred contacts are surfaced when they have been silent for too long |
| ⏰ **Task & DDL extraction** | ✅ MVP | Chat deadlines are detected and proactively reminded |
| 🗂️ **Contact & message management** | ✅ Live | Edit profiles, clear history, delete contacts, full-text search |
| 💡 **Reply suggestions** | ✅ Live | Copy a private chat → 3 suggestions → one-click fill into WeChat input (never auto-sends) |
| 📊 **Local dashboard** | ✅ Live | Conversations, contacts, timeline, knowledge, proactive strategy, agent records |
| 🖥️ **Electron desktop shell** | ✅ Live | Launches core, floating suggestion bubble/card, auto-restart |
| 🔊 **Voice message backfill** | ✅ Live | Paste voice transcripts and TinyPelican backfills them into the right archive |

---

## Quick Start

### Requirements

- Windows
- Node.js 18+
- `@deepseek-ai/dsh` (installed automatically by `npm install`, or point `DSH_BIN` at your local DSH)

### Run it

```powershell
# From the repository root (the folder containing package.json)
npm install
copy config.example.json config.json

npm run daemon   # full daemon: HTTP + clipboard + WeChat + scheduler
```

Open the dashboard:

```text
http://127.0.0.1:18791
```

Optional Electron desktop shell:

```powershell
# From the app/ folder under the repository root
npm install
npm start
```

### Commands

```powershell
npm run server      # dashboard only
npm run daemon      # full daemon
npm test            # tests
npm run check       # full syntax check
npm run remind:dry  # dry-run reminder rules
```

### DSH environment variables

| Variable | Purpose |
|---|---|
| `DSH_BIN` | Path to `@deepseek-ai/dsh/lib/bin.js` |
| `DSH_WEB_URL` | DSH Web URL, default `http://127.0.0.1:3080` |
| `XIAOTIHU_NODE` | Node executable override used by the Electron shell |
| `XIAOTIHU_DATA_DIR` | Data directory in packaged mode; dev mode defaults to project root |

---

## Tech Highlights

- **Core**: Node.js, no framework lock-in, local JSON/JSONL/TOML storage
- **Models**: Multi-provider OpenAI-compatible engine — SiliconFlow, OpenAI, DeepSeek, Ollama, custom endpoints
- **Agent**: DeepSeek Harness (DSH) — persistent Web sessions + headless fallback + custom event-stream plugin
- **Frontend**: Native ES Module dashboard, no build step
- **Desktop**: Electron shell for background service management and floating reply UI
- **Data**: `contacts/*.json`, `inbox.jsonl`, `intents.json`, `conversations.json`, local `config.toml`/`config.json`

### Repository layout

```
app/          Electron desktop shell
agent/        DSH profile + event-stream plugin
core/         engine, agent, channels, memory, ingest, capture, remind, API
dashboard/    local Web dashboard
tests/        unit/integration tests
```

---

## Roadmap

The current MVP proves the core loop on one platform. The bigger product is already in the design:

- 🌐 **More platforms** — WeChat, QQ, Feishu, email adapters through one channel contract
- 📱 **Mobile presence** — proactive push summaries and mobile-friendly review
- ⌨️ **Input-method integration** — context-aware reply suggestions while typing
- 👥 **Group chat memory** — group profiles and multi-party task ownership
- 🖼️ **Vision understanding** — image memory when appropriate (local-first)
- 🧩 **Pluggable memory backends** — from local JSON to SQLite/vector storage for scale
- 🤖 **Stronger autonomy** — from “suggest and confirm” to user-controlled auto-execution levels

---

## Documentation

- [产品设计 / Product Design](产品设计.md)
- [ARCHITECTURE.md](ARCHITECTURE.md)
- [RULES.md](RULES.md)
- [agent/README.md](agent/README.md)

---

## Project Description (GitHub About)

> **TinyPelican (小鹈鹕 AI)** — a local-first personal AI assistant that remembers relationships, extracts tasks from chat, proactively maintains the people who matter, and lets a DSH Agent act on your behalf with streaming, transparent reasoning.
