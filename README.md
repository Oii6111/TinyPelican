# TinyPelican · 小鹈鹕

> **A relationship operating system for personal AI.**
>
> TinyPelican turns the scattered context inside conversations into durable memory, thoughtful next steps, and timely action—while keeping the human in control.

<p align="center">
  <a href="https://github.com/Oii6111/TinyPelican">GitHub repository</a>
  ·
  <a href="https://github.com/Oii6111/TinyPelican/issues">Issues</a>
  ·
  <a href="https://github.com/Oii6111/TinyPelican/discussions">Discussions</a>
</p>

🌐 **English** · [中文](README.zh-CN.md)

## The missing layer in personal AI

The most important context in life rarely lives in a spreadsheet. It is hidden in a message saying “let’s find time next week,” a promise to ask someone for help, an unanswered question, or the different boundaries you keep with every person.

Messaging apps store the words. Task managers store isolated actions. Calendars store time. General-purpose AI can answer a question, but it does not reliably remember who matters, why something matters, or what the next respectful step should be.

TinyPelican is building that missing layer: a personal context system that understands people, conversations, commitments, and the direction a relationship is meant to take.

## Our vision

We believe the next generation of personal AI should be more than a chat window waiting for prompts. It should be a trusted context layer that stays close to everyday life:

```text
Life happens in conversations
          ↓
AI remembers who and why it matters
          ↓
AI proposes the right confirmation, reminder, or action
          ↓
You respond with better timing and better judgment
```

We start with copied WeChat conversations because they are rich, immediate, and under the user’s control. The long-term ambition is a cross-platform foundation for personal relationships and commitments—connecting messages, contacts, calendars, tasks, notifications, and Agents without turning the user into a data-entry clerk.

## One copy, a complete loop

```text
Copy a conversation
        ↓
Parse, deduplicate, and resolve the contact
        ↓
Build a living profile, social goal, and searchable memory
        ↓
Surface possible commitments, reminders, and schedules for review
        ↓
Draft a reply that respects the relationship
        ↓
Keep the next step visible in the proactive dashboard
```

The input is simple. The product value is the trusted next step.

## What the experience feels like

### A living memory for every relationship

Each contact can carry more than a nickname or remark:

- relationship context and importance;
- recent events and durable preferences;
- a current social goal for the relationship;
- communication style, boundaries, and topics to avoid;
- a searchable timeline of the conversations that shaped it.

Remark names take priority, and opening a contact goes directly to the conversation. Contacts and chat history are one continuous experience rather than two disconnected tools.

### Reply suggestions with social intelligence

When TinyPelican drafts a reply, it starts with the most recent copied context, then considers the contact’s social goal and profile, and finally performs a targeted search of older messages when needed.

The same sentence can require warmth, restraint, precision, or a clear next step depending on whether the other person is family, a friend, a customer, or a potential collaborator. Suggestions are drafts placed in the input box; they are never sent without confirmation.

### Commitments become controlled actions

Possible commitments found in conversations enter a review flow before they become formal tasks, reminders, or calendar events.

- The Agent interprets intent and proposes what could happen.
- System APIs validate fields, dates, permissions, and duplicates.
- The user decides what is confirmed and when it runs.

This is proactive software with a clear boundary between understanding and execution.

### A dashboard for the things that matter

The proactive dashboard brings together tasks, reminders, schedules, pending intentions, and Agent activity. Users can start with what needs attention today, move into a specific date, and trace why an action was suggested.

## The foundation we are building

### Local-first trust

Contacts, profiles, social goals, and chat messages are stored in a local SQLite database by default. Users can bring their own model provider, keep sensitive context on their machine, and decide what leaves it.

### Relationship semantics, not message volume

Messages are raw material. The durable value is relationship context: who this person is, what is happening between you, where you want the relationship to go, and how to take the next step well.

### Human-controlled autonomy

TinyPelican does not turn a model guess into an irreversible action. Pending intentions, structured Skills, validation APIs, and visible records let autonomy grow without losing consent or auditability.

### An Agent-native system boundary

DSH is the natural-language decision maker. System Skills and APIs provide structured capabilities for contact lookup, chat search, intent review, tasks, reminders, and schedules. The Agent does not need to scan the project or edit data files directly, so the system can expand without weakening its data boundaries.

### A platform beyond one channel

The core objects—people, messages, profiles, social goals, commitments, and actions—are not tied to one messaging application. WeChat is the starting point; the context layer is designed to connect more channels, calendars, and automation services over time.

## Architecture

```text
WeChat / clipboard / WebUI
             ↓
       Parse, deduplicate,
       and resolve contacts
             ↓
 SQLite contacts and chat memory
             ↓
 Structured query, validation,
       and persistence APIs
             ↓
        DSH Agent + Skills
             ↓
 Drafts / pending intentions / tasks / reminders / schedules
             ↓
 Web dashboard / Electron overlay / notifications
```

The current stack includes Node.js services, SQLite, a native ES Module WebUI, an Electron desktop shell, and OpenAI-compatible model providers including OpenAI, SiliconFlow, DeepSeek, Ollama, and custom endpoints.

## For developers

### Requirements

- Windows
- Node.js 18+
- A DSH WebUI at `http://127.0.0.1:3080` by default
- At least one configured OpenAI-compatible model provider

### Quick start

```powershell
git clone https://github.com/Oii6111/TinyPelican.git
cd TinyPelican
npm install
Copy-Item config.example.json config.json
npm run daemon
```

Open `http://127.0.0.1:18791` to use the WebUI. Configure `config.json` with your model provider, `selfNicknames`, and clipboard settings before starting. If the WebUI is reachable beyond the local machine through a LAN, reverse proxy, or Cloudflare Tunnel, enable authentication.

To run the desktop shell:

```powershell
cd app
npm install
npm start
```

Useful commands:

```powershell
npm run daemon      # core service, clipboard, scheduler, channels, and Agent queue
npm run server      # WebUI/API only
npm test            # tests
npm run check       # syntax checks
npm run remind:dry  # preview reminder rules
```

### Repository map

```text
app/                 Electron desktop shell
agent/               Agent.md, Skills, and DSH event stream
core/                APIs, Agent, SQLite, ingestion, reminders, and channels
dashboard/           Native ES Module WebUI
tests/               Unit and integration tests
```

Runtime chat data lives in SQLite. Tasks, schedules, and pending intentions currently use local JSON stores while their structured APIs continue to evolve. Runtime databases, configuration, credentials, logs, and chat records are ignored by Git.

## Roadmap

### Now: close the relationship and commitment loop

Make contact memory, copied-chat ingestion, socially aware drafts, proactive reminders, and Agent Skills reliable enough to become a daily habit.

### Next: a cross-platform personal context layer

Connect more messaging channels, calendars, and notification surfaces. Add richer group-chat roles, relationship context, and ownership for shared commitments.

### Longer term: configurable personal autonomy

Let people choose an autonomy level for each context—from reminders and drafts, to confirmed execution, to auditable workflows that can run on their behalf.

## Join the project

TinyPelican is an open exploration of personal AI, relationship intelligence, long-term memory, and local-first software. If those ideas resonate with you:

- Open an [Issue](https://github.com/Oii6111/TinyPelican/issues) with a bug or a real-world use case.
- Join the [Discussions](https://github.com/Oii6111/TinyPelican/discussions) and help shape the product direction.
- Read [ARCHITECTURE.md](ARCHITECTURE.md), [RULES.md](RULES.md), and [agent/README.md](agent/README.md).
- Build with us toward personal AI that remembers responsibly and acts with judgment.

**Repository:** [github.com/Oii6111/TinyPelican](https://github.com/Oii6111/TinyPelican)
