# Continue on phone (2026-11-08)

The owner reaches one of his Claude sessions from the Claude app on his phone, as the same session, not a copy.

## Why approval 434 made a copy

Reproduced on Claude Code 2.1.316.

1. Card 434 typed `cd <repo> && claude --resume 9b765826-… --remote-control="<name>" "And now?"` into an Orca terminal at 13:58:07 UTC. The terminal did not run it: its output at 13:58:20 shows only the old prompt, and no process or transcript line came from it. The card still said done (the silent terminal-send that idea 2 fixes).
2. The brain saw nothing happen. At 13:58:42 it ran the command itself in Bash, outside the gate, as `claude --bg --resume 9b765826-… --remote-control="<name>" "And now?"`.
3. 9b765826 was a background session (`claude --bg`), which keeps its own saved options (`respawnFlags` in `~/.claude/jobs/<id>/state.json`). The CLI answered: "background session 9b765826 keeps its own saved options, so the flags you passed started a copy as 5c9cf6d6. Without flags, the same command continues 9b765826 itself."

The probes (a throwaway haiku session, `probe-copy-439`):

- `claude --bg --resume <id> --remote-control=<name> --model … "<text>"` on a stopped background session printed the same note and started a copy, `f15d7deb`, with an automatic name and `--remote-control` without its name in the saved flags. That is the shape of 5c9cf6d6.
- `claude --resume <id> --remote-control=<name> "<text>"` in a pseudo-terminal (no `--bg`) on the same stopped session answered in the same transcript file, listed as one interactive process on the same session id, with no new job.

So the copy needs `--bg` together with flags. A plain interactive resume keeps the session.

## What jarvisd does

- A phone button on every Claude session row in the work list (a native worker, an Orca chat or terminal agent; not a project terminal). `POST /api/work/phone` with the row id. It is a work-list press, recorded as a `session-phone` approval.
- `native.phone` (`daemon/native.ts`) checks the session first. Any other process on it refuses the press: the `claude agents` listing (a background host, an interactive terminal, the desktop app) and every Claude process whose command line names the session id (`holdersIn` in `daemon/resume.ts`). A transcript written in the last 10 s also refuses it. The refusal names each process by pid.
- The pane shows that refusal with "Stop it and continue". That tap sends the pids as `stop`: a background session is stopped with `claude stop <id>`, any other process gets SIGTERM, and jarvisd waits up to 10 s until none holds it. Only pids the owner saw are ended. Anything new refuses again.
- Then it runs `claude --resume <id> --name <name> --remote-control=<title> --permission-mode <mode> --model <model> --settings data/worker-settings.json` in a detached pseudo-terminal, in the session's folder. No message goes in, so no turn starts. The mode is the last one the transcript records (`auto`, `default`, `acceptEdits` or `plan`, else `default`). The model is the model of the last answer. The title is the session's own name.
- The session becomes an `n:<first 8 of id>` row (kind interactive, column `remote`). A session jarvisd already runs keeps its row: its own terminal is ended and resumed with the flag. A busy one is refused, so its turn is not cut off.
- A phone row is left running: the one-hour idle reaper skips it, it does not fold or leave the list while it lives, its turn end shows it idle, and a later resume keeps `--remote-control`.
- The brain: `jarvis-native phone --session <id> [--title <name>]` for a session the list does not show. It never stops another process. vault/CLAUDE.md tells it never to resume a session with `claude` itself.
- Side fix: `lastModel` reads the model of the last answer (`"model":"…","id":"msg_…"`). A deferred tool's definition in the tail said `claude-opus-5-5` in a haiku session.

Screens: `docs/screens/continue-on-phone/` (the preview at 390 px wide: the refusal, then after "Stop it and continue").

## Proven live (2026-11-08 UTC, the real CLI, a scratch store, no jarvisd)

- Background probe `1b422b4f` with its process alive: `native.phone` refused with "pid 43968, a background session named "probe-copy-439", idle". A first run also named a shell whose script mentioned the id. `holdersIn` now counts only Claude programs.
- The same call with `stop: [43968]`: `claude stop`, then a pseudo-terminal running `claude --resume 1b422b4f-… --remote-control=probe-phone-439 …`. The listing showed one interactive pid on the same session id, and `~/.claude/jobs` gained no new job.

## Not proven

- The session in the Claude app on the phone, and typing into it from there. The probe registered Remote Control, but nobody opened it on a phone.
- Permission prompts of a phone session. They go to Jarvis cards through the worker settings hook. Whether the Claude app also shows them is not checked.
- The button against the live daemon. It ran in the preview and in tests only. A second jarvisd must not start.
- An Orca chat tab as the holder (its process is named by `ps`; not run live).
