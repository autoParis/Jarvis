# Example project (template)

Copy this file to `vault/projects/<name>.md` for each repository the owner works on, then fill it in. Jarvis reads the
card before it answers a question about the project or dispatches a worker on it. The side chat picker in the app lists
every card whose first line below is `- Repo:` followed by an absolute path in backticks. This template uses a
placeholder, so it is not listed.

- Repo: `<absolute path of the local clone>`, GitHub `<owner>/<name>`. Base branch `<main or staging>`. Where its own rules live (for example `.claude/CLAUDE.md`).
- What it is: one or two sentences on the product and who uses it.
- How stories run: the skill or playbook a worker follows (for example "Run the pick-and-ship skill on issue #<n>").
- Dispatch a specific story: `jarvis-act propose --action worker-start --args '{"repo":"<absolute path>","taskTitle":"#<n> <topic>","spec":"Run the pick-and-ship skill on issue #<n>."}' --say "Start a worker on #<n>?"`
- Rules the owner gave for this project, each with the date they said it.
