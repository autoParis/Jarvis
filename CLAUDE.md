# Jarvis, for code workers

This file is for a session that changes Jarvis's code. The brain's own rules are in `vault/CLAUDE.md`. If you are the
brain, skip this file.

## Layers

- `daemon/` is jarvisd, TypeScript run by Node 22.18+ with no build step and no dependencies. `daemon/main.ts` starts it.
- `web/` is the app: `web/index.html` plus one plain ES module per feature. jarvisd serves the files as they are.
- `vault/` is the brain's memory and instructions. `vault/CLAUDE.md` is its system prompt.
- `bin/` holds the CLIs the brain calls (`jarvis-act`, `jarvis-today`, `jarvis-native` and others) and the install scripts.

## Daemon modules, one line each

- `main.ts`: start-up, the timers, the brain's event handlers, and most http routes.
- `store.ts`: the SQLite store (`data/jarvis.db`). Items, approvals, requests, turns, state.
- `brain.ts`, `brainmodel.ts`, `worksteps.ts`: the one long-lived Claude Code brain session, its model, and its turn steps.
- `gate.ts`: the approval gate behind `bin/jarvis-act`. Every action the brain proposes, its tier, and what Approve runs.
- `workercontract.ts`: every rule Jarvis writes into a worker's brief, and the parsers that read the worker's asks and
  reports back. Change a label or a brief here, and `workercontract.test.ts` proves it still reads back.
- `native.ts`, `nativeroutes.ts`: Jarvis's workers (Claude Code sessions), their hooks and their routes.
- `asks.ts`, `brainasks.ts`: worker asks and the brain's own asks as cards.
- `requests.ts`: the Requests sidebar, one row per worker Jarvis started.
- `today.ts`, `reminders.ts`, `tasks.ts`, `check.ts`: the Today list, reminders, the scheduled tasks screen, the ten-minute check.
- `gmail.ts`, `messages.ts`, `replies.ts`, `replyworker.ts`: email triage, the Messages popup, support replies.
- `push.ts`, `access.ts`: web push, and who may reach the app.
- `terminal.ts`, `termroutes.ts`, `termgate.ts`, `termrows.ts`: project terminals and the passkey gate in front of them.
- `transcript.ts`, `resume.ts`, `steer.ts`: the conversation pane, resuming a session, the message box under it.
- `voice.ts`, `listen.ts`: speech to text and text to speech, hands-free listening.
- `reports.ts`, `artifactshots.ts`, `images.ts`, `uploads.ts`: documents, previews and pictures in the chat.
- `namedactions.ts`, `prodmcp.ts`, `sheet-edit.ts`, `migration.ts`: actions jarvisd runs itself on Approve.
- `config.ts`: every personal setting, read from `.env`. `log.ts`: `data/jarvisd.log`.

## Rules

- Put no real names, emails, dealer names or `/Users` paths in code, tests or docs. Personal values come from `.env`
  through `daemon/config.ts`, and each has a neutral default.
- Test: `npm test`. It runs `daemon/*.test.ts` with the `JARVIS_*` settings removed, so the tests see the defaults.
  Add a test at the interface you change. A route test calls the module's `route()` with a fake request, as
  `daemon/nativeroutes.test.ts` does.
- Restart jarvisd with the launchd command in `vault/projects/jarvis.md`. A restart ends the brain's session.
- Commit on your worktree branch. Jarvis merges it into `master` itself.

## The design spec

The design spec is private. It lives only in the main checkout, outside git: `docs/spec/README.md` is the current state
and links one file per topic, and `docs/spec/history.md` is the dated log. Read the README, then only the topic file
for your change. Do not commit any of it.

## Searching

Old worktrees sit in `.claude/worktrees/`. `.ignore` hides them from ripgrep and from the Grep and Glob tools. Plain
`grep -r` and `find` do not read `.ignore`, so use `rg` or name the folder (`grep -rn x daemon web vault bin`).
