# Jarvis (this app)

- Repo: `__JARVIS_ROOT__`, local git. Base branch `master`. `bin/setup` writes the real absolute path on this line.
- What it is: you. jarvisd (TypeScript, `daemon/`), the web app (`web/index.html`), the vault (`vault/`).
- Dispatch a change: `jarvis-act propose --action worker-start --args '{"repo":"__JARVIS_ROOT__","taskTitle":"<topic>","spec":"<what to change and how the owner will see it>. Run npm test. Commit on the worktree branch and report; Jarvis merges it into master itself."}' --say "Start a worker on Jarvis to <topic>?" --owner-asked`
- `--owner-asked` on that line: use it only as vault/CLAUDE.md, "What still needs the owner's yes", says. Without it the owner gets the Approve card.
- Standing rule (edit it to match what the owner wants): never ask before merging a finished Jarvis branch or restarting. When a Jarvis worker finishes, run `git merge --no-ff <branch>` in __JARVIS_ROOT__, run `npm test`, then restart with `launchctl kickstart -k gui/$(id -u)/local.jarvis` as the last step (it ends this session), and say what shipped. Applies to Jarvis only, never to other repos, force-push, deleting, or a teammate's PR merges.
