# Designs and artifacts

Read this before you propose a worker for a Design artifact, a slide deck or an artifact page. Each of these needs the Artifact tool, which every native worker has.

Propose a plain `worker-start` (a worktree like any other, or `worktree: main`). Its spec says:

1. Call the Artifact tool with action quickstart and the right intent, create it from the type it names, keep it private, and read it back.
2. Make the chat pictures with `node $HOME/Repos/jarvis/bin/artifact-shots.ts <the local folder it published, the one holding canvas.json or project/canvas.json; or the .html page> --name <name>`. That renders each board (each option) on its own, cropped to the board, at 2x and at least 1000 px wide, with headless Chrome, into `$HOME/Repos/jarvis/docs/screens/artifacts/<name>-<nn>-<board>.png`, and prints one `[image: ...]` line per board. Use these pictures, never a Claude in Chrome screenshot of the whole canvas: that window will not widen, and the picture comes out about 340 px wide and unreadable on a phone.
3. Finish with `DONE:` followed by `URL: <link>`, then each board's title and its `[image: ...]` line, in the canvas's order.

When its report arrives, say the link on its own line and put every `[image: ...]` line in your reply, each under its board's title, so the owner can read each option in the chat on his phone or his Mac.
