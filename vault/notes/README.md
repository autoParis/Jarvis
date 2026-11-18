# Notes

Jarvis's running notes. Jarvis writes here itself: one markdown file per topic, for anything it must still know after
a reset of its session. Add a line to the Index in `vault/CLAUDE.md` for a note Jarvis must read on a given trigger.

Good notes:

- `decisions.md`: decisions the owner made, each with its date and the reason.
- `<topic>-tracker.md`: a running piece of work with its source of truth (a sheet, a file), the rules the owner gave for it and its current state.
- `draft-story-<topic>.md`: a story draft before it is filed.

How to write a note or an Index line so it still works after a reset:

- Keep each rule in one place. Elsewhere, point to it by its file and heading.
- Write the behavior you want. Add a ban only for a hard limit, and put the wanted behavior next to it.
- Give each step a done condition you can check.
- When the code or the owner's decision changes, remove the old line and its date in the same edit.
- Put what only one kind of event needs in its own file, and give the Index line the trigger: "read X before you do Y".

Keep personal and client data out of any copy of this folder that you publish.
