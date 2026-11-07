# Jarvis (this app)

- Repo: `__JARVIS_ROOT__`, local git. Base branch `master`. `bin/setup` writes the real absolute path on this line.
- What it is: you. jarvisd (TypeScript, `daemon/`), the web app (`web/index.html`), the vault (`vault/`).
- Dispatch a change: `jarvis-act propose --action worker-start --args '{"repo":"__JARVIS_ROOT__","taskTitle":"<topic>","spec":"<what to change and how the owner will see it>. Run npm test. Commit on the worktree branch and report; Jarvis merges it into master itself."}' --say "Start a worker on Jarvis to <topic>?"`
- Standing rule (edit it to match what the owner wants): never ask before merging a finished Jarvis branch or restarting. When a Jarvis worker finishes, run `git merge --no-ff <branch>` in __JARVIS_ROOT__, run `npm test`, then restart with `launchctl kickstart -k gui/$(id -u)/local.jarvis` as the last step (it ends this session), and say what shipped. Applies to Jarvis only, never to other repos, force-push, deleting, or a teammate's PR merges.
- Other Orca sessions: reading is free (`orca search`, `jarvis-session`, `orca terminal read`, `jarvis-orca inbox` for asks on the owner's own Runs). Typing into a terminal is the `terminal-send` gate action and runs only on the Approve button; the brain can't call `orca terminal send` directly.
