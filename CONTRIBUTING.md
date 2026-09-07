# Contributing to TinyPelican

Thanks for your interest in TinyPelican. This repository is the **open-source kernel** of an AI social copilot.

## Scope of this repository

Please keep contributions within the open-source scope:

- Core relationship-reasoning engine (chat parsing, profile extraction, intents, reminders, reply drafts)
- Dashboard, Electron shell, Agent Skills
- Tests, docs, and developer experience

**Out of scope** for this repository:

- Personal WeChat auto-sync (no official API)
- Any feature that reads chat data without explicit user action

For out-of-scope requests we will close the issue and label it as `wontfix`.

## Where help is most wanted

The project is currently WeChat-first. The highest-impact areas for new contributors:

1. **Channel adapters** — QQ, Feishu / DingTalk, Telegram, email, calendar. Every channel implements a simple `connect / stop / send` contract (`core/channels/interface.js`).
2. **Intent & reasoning quality** — prompts, extraction logic, human-in-the-loop feedback.
3. **Tests & CI stability** — the suite runs on Windows and currently has a few flaky cases.
4. **Docs & onboarding** — README, dashboard copy, config guides.

> The project is maintained by an undergraduate student with limited time. Responses may be slow, but every contribution is read and valued.

## Good first issues

New to the project? Look for issues labeled [`good first issue`](https://github.com/Oii6111/TinyPelican/labels/good%20first%20issue). Suggested starting points:

1. Fix a failing/flaky test under `tests/`
2. Improve dashboard copy or styling
3. Add documentation for a config option

## Development

```powershell
git clone https://github.com/Oii6111/TinyPelican.git
cd TinyPelican
npm install
npm test
npm run check
```

## Pull request guidelines

- Keep PRs small and focused.
- Add or update tests when changing core logic.
- Use a clear PR title: `fix:`, `feat:`, `docs:`, `test:`, `refactor:`.
- If your change affects behavior, update the relevant README section.

## Issue guidelines

- Search existing issues before opening a new one.
- Use the provided issue templates.
- For product questions and general discussion, open a [Discussion](https://github.com/Oii6111/TinyPelican/discussions) instead of an issue.

## Code of conduct

Be respectful. This is a small project — maintainers may take time to respond, but every issue is read.

## License reminder

By contributing, you agree that your contributions are licensed under the same MIT License as this repository.
