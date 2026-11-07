# PR audit

An independent re-check of the READY verdict on `example-org/acmeapp_nextjs`, for the owner only. Its purpose is to fix the source of those verdicts: the prompts, skills and scripts workers follow before READY. It audits pull requests to find what that source lets through, and its report is a ranked list of source changes. It reads GitHub and posts nothing: `gh()` in `bin/pr-audit` refuses anything but read commands. It edits no skill in `acmeapp_nextjs`. Applying a change is the owner's call.

```sh
bin/pr-audit weekly [--count 10] [--include 4771] [--exclude 4777] [--prs a,b,c] [--dry-run]
bin/pr-audit daily  [--max 8] [--dry-run]
bin/pr-audit sources ~/.cache/pr-audit/runs/<date>-<mode> [--mode weekly|daily]   # source step only, no new audits
bin/pr-audit report ~/.cache/pr-audit/runs/<date>-<mode>   # re-render, no sessions
bin/pr-audit selftest
```

`PR_AUDIT_MODEL`, `PR_AUDIT_SESSION_BUDGET` and `PR_AUDIT_DRAFT_PR` override the model, the per-session cap and the draft pull request the source step reads (`0` reads staging only). The first run used a cap of 30 dollars and no session came near it.

Each run writes two files to `docs/audits/`. `<date>.md` holds the ranked source changes, with a short appendix of defects that belong to one pull request. `<date>-detail.md` holds the full audit tables and each pull request's blind view, and includes `notes.md` from the run folder. Daily runs use `<date>-daily.md` and `<date>-daily-detail.md`. `source-notes.md` in the run folder, if present, goes into the main report.

## How independence is enforced

Each pull request gets two fresh `claude -p` sessions.

**Blind.** It sees the description with graded sections removed, the issue, the diff, the source at the READY commit, CI and the attached evidence. It answers with its own gaps and verdict. The answer is written and hashed (`blind.sha256`) before the script fetches the READY comment. So the sealed material is not on disk while this session runs.

**Compare.** A new session gets the frozen answer plus the READY comment, the hidden sections, the worker's comments and the after-merge history. It rechecks both sides, and recomputes the posted figures.

Both sessions run with no settings, no memory and no MCP, and with an empty GitHub config. Read, Grep and Glob are limited to the run folder. The only shell commands granted are `bin/pr-audit db`, a read-only database door that refuses secret columns, and `bc`. A smoke test confirmed that `gh`, `curl`, `~/.claude`, `.env.local` and compound commands are all denied. Claude Code's permission mode still let one source-step session run `cd`, `ls` and `wc` inside its own run folder, by its own account, so listing commands are not fully shut off.

The auditor verdict is the blind one. The compare session's verdict is reported beside it, because it can differ for a good reason. For example, the comment may hold evidence the description lacked.

A merged pull request is judged on what its squash commit landed, so a stacked parent's code does not count against it. An open stacked pull request can still show its parent's code.

## The source step

It runs after the audits on every weekly and daily run, and `bin/pr-audit sources` runs it alone on finished audits. A rerun only does what is not on disk. A failure is written to the report and does not lose the audits. Files land in `source-step/` in the run folder.

1. **Snapshot.** It copies pick-and-ship, pick-and-ship-v3, babysit-acmeapp with `ready.py`, verify-acmeapp, prove-it and the ship-story workflows at `origin/staging` and at the head of draft #4777. It reads with local git and never touches a working tree.
2. **Group.** A fresh session gets every finding with a stable id such as `4771-M2`, and the snapshot. It writes one change per root cause, however many pull requests share it. Each change names its file, section, a verbatim quote of the current text, the new wording or check, the gap class and the findings behind it.
3. **Validate.** The code refuses a path outside those skills, a section or a quote not in the file at that commit, a proposed text naming an audited pull request, and any finding left unplaced. A refused answer goes back to a new session, up to 3 attempts in all, and then the step fails.
4. **Replay.** One fresh session per pull request gets the recorded diff, description, READY comment and that pull request's findings, plus every proposed text. It does not see which pull requests a change was proposed for, or its confidence. For each change it answers with an outcome and cites the line of the record behind it. Two checks need no session, and the code computes them from the record: the head moved after READY, and no log or data file attached.
5. **Rank.** The code sorts by replayed verdict changes, then significant gaps caught, then pull requests changed, then stated confidence. Replay rows at low confidence are shown and do not count. The grouping session cannot set its own rank.

A replay is a judgement from the record, not a re-run of the pipeline. No worker ran with the new text. It tells you which rules have a condition the record meets, and it cannot tell you that a live worker would obey the wording.

## Selection

**Weekly.** `--include` first, then up to 2 open pull requests with READY, newest first, then merged ones from the last 14 days: about 45 percent posted High, the rest Medium, one Low, evenly spread by size within each. It also analyzes what would close the gaps behind REVIEW.

**Daily.** Pull requests with a READY comment from the last 26 hours whose audited commit is new, riskiest first, up to `--max`. It says how many it left out. It writes `docs/audits/<date>-daily.md`. On 2026-11-04 it had 10 candidates.

A failed pull request is listed as failed in the report and does not stop the others. A rerun on the same day and mode skips what is on disk. Raw sessions stay in `~/.cache/pr-audit/runs/`.

## Cost, measured on 2026-11-04

The numbers are API-equivalent dollars as reported by each session, on `claude-opus-5-5`, at 3 pull requests at a time. The Max subscription bills nothing per run, and each run draws on its rate limit instead. An audit costs about 2.3 million input tokens, mostly cache reads, and 67,000 output tokens per pull request.

| Item | Dollars | Time |
|---|---:|---|
| One pull request, average of 11 | 3.76 | 10 session minutes |
| One pull request, lowest and highest | 1.54 to 6.25 | 3 to 17 minutes |
| Weekly run, 10 pull requests | about 38 | about 35 minutes |
| Daily run, capped at 8 | about 30 | about 30 minutes |
| Daily run with no cap, at 20 a day | about 75 | about 70 minutes |
| Daily run with no cap, on a 58 merge day | about 218 | about 3.5 hours |

Cost does not track diff size. The 27-line #4716 cost 4.60 dollars because it dug through production data. Merge volume over the last 10 days with merges was 200, or 20 a day, with a peak of 58.

The first run cost 44.91 dollars in all: 41.41 for the 11 audits in the report, and 3.50 for the #4669 audit discarded after the diff fix.

## Schedule proposal

Not installed. Weekdays and weekly together, at the cap, come to about 810 dollars a month API-equivalent. Times are Eastern.

```cron
# Daily, Monday to Friday, 06:30: before the day's merges, on yesterday's READY comments
30 6 * * 1-5  cd $HOME/Repos/jarvis && PATH=/opt/homebrew/bin:/usr/bin:/bin bin/pr-audit daily --max 8 >> ~/.cache/pr-audit/daily.log 2>&1
# Weekly, Saturday 07:00: no sessions competing for the rate limit
0 7 * * 6     cd $HOME/Repos/jarvis && PATH=/opt/homebrew/bin:/usr/bin:/bin bin/pr-audit weekly --count 10 >> ~/.cache/pr-audit/weekly.log 2>&1
```

Use launchd rather than cron if the Mac sleeps at those hours, because launchd runs a missed job on wake. `bin/install-service` shows how Jarvis does it. Two jobs are enough: `StartCalendarInterval` with the same hours, `WorkingDirectory` set to the repo, and the same `PATH`.

The cap matters: above 8 a day, low-risk pull requests go unaudited, and the daily report says how many. To cover every MERGE before an auto-merge, remove the cap and accept the costs in the table. A cheaper model may cover the blind step for less, but no cheaper model has been measured against these 11 results yet.

## What the report holds

The main report opens on the ranked changes. Each has its file and section, the proposed wording or check, the gap class it prevents, the pull requests that are its evidence, how many pull requests it would have changed, a confidence, and whether it caught the gap in the replay. Appendix A lists defects that stay open on one pull request. Appendix B lists changes to the audit tool itself.

The detail report measures:

- How often the blind verdict differs from the posted one, split between real `READY: MERGE` or `READY: REVIEW` titles and old comments read as MERGE. An old READY added the `Ready to merge` label, which now means MERGE, so that split asks whether today's rubric would have held it.
- The repeating causes of those differences, from a fixed list, counted per pull request.
- How often the audit's two sessions disagree with each other, which is the auditor's own noise.
- Posted figures that did not hold, posted gaps that were not real, gaps nobody listed, and fixes, reverts or incidents after merge.
- For weekly runs, what would close each significant gap, ranked by pull requests blocked.

Every proposed change carries a confidence (high, medium, low) and its evidence.
