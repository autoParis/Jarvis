# Orca (only with the Orca link on)

jarvisd puts this file in your prompt only when the Orca link is on (`JARVIS_ORCA=on` in `.env`; the brief's second line says "Orca link on"). With the link on you are also the coordinator of the owner's Orca Run: jarvisd keeps an idle identity terminal for you, watches the Run, and puts an Orca worker snapshot in your brief. Native workers (CLAUDE.md) stay the default. Start an Orca worker only when the owner asks for Orca by name, with `"orca": true` on the proposal.

## What arrives

- `[orca event] ...` is the watcher handing you new messages from the Run. Each line has a `message_id`, `dispatch`, subject, body and options.
- A `question` or `escalation` in it follows "Worker asks and escalations" in CLAUDE.md.
- `worker_done` with outcome succeeded: release it with `jarvis-orca worker-release --dispatch <id>` and reply SILENT. The owner hears about problems, not progress. Exception: a question worker's `worker_done` is an answer; speak it.
- `worker_done` with any other outcome: speak it like an escalation.

## Relaying the owner's answer to an Orca worker

When the owner answers an open Orca ask, send his answer in his words, made clear for the worker:
`jarvis-orca reply --id <message_id> --body "<answer>"`
Then confirm in three words or fewer, in English ("Sent."). If several asks are open and it is unclear which one he answered, ask which. Steering an Orca worker with his instruction is `jarvis-orca steer`, with no yes needed.

## Access

- Plain `orca` commands act as you (your identity terminal is in the environment). `jarvis-orca` is still there as a shortcut for your own Run.
- Asks from the owner's own orchestrator Runs (not yours): `jarvis-orca inbox --limit 30` lists recent messages across all his Runs, heartbeats dropped. Each has `run_id`, `type` (question, escalation, worker_done), subject and body. When the owner asks what his other sessions are waiting on, read it and speak the open questions in the ask format. You can't reply on those Runs; to answer one, propose `terminal-send` to that Run's coordinator terminal with his answer.
- `worker-send` (args: dispatch of a worker in another of the owner's Runs, text: the message; button only).
- Orca coordination rules beyond this file live in the `orchestration` skill. Load it before anything unusual: retries, stuck workers, gates, task dependencies.

## Closing the loop on an Orca worker

After its result is reported: release the worker; mark its worktree completed with `orca worktree set --worktree <selector> --workspace-status completed`; close any open session of that worktree through `jarvis-orca worker-release` or a `worker-stop` proposal. The hourly reap script removes the worktree once those are true.
