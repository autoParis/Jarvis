# Jarvis

A voice-first chief of staff for one person, built on Claude Code and Orca. You talk to it by voice or chat from a Mac
or a phone. It starts coding workers, relays their questions to you, turns your answers into their next step, triages
your email and keeps a Today list. Nothing goes out to another person without your tap.

The brain's instructions are in [vault/CLAUDE.md](vault/CLAUDE.md). An agent that installs Jarvis for a new owner
reads [vault/SETUP.md](vault/SETUP.md) first: it lists every file and setting to fill in, with an example of each.

## Install

Needs macOS, Node 22.18 or later, the Claude Code CLI, Orca, ffmpeg, and for voice the FluidAudio CLI built at
`~/src/FluidAudio` (`swift build -c release --product fluidaudiocli`). Optional: the `gws` CLI signed in to your Gmail
account (email triage), Tailscale (the app on your phone), `gh` (GitHub actions).

```
git clone <this repo> ~/Repos/jarvis
cd ~/Repos/jarvis
bin/setup
```

`bin/setup` asks for your personal settings (your name, company, email addresses, tailnet URL and phone addresses,
your repositories, the product's MCP URLs) and writes them to `.env`, which git ignores. Every question shows a value
in brackets; Enter keeps it. `.env.example` lists every setting with a comment. `bin/setup --defaults` writes the
example values, enough to try the app locally. Run `bin/setup` again at any time to change an answer.

Then fill in the vault, the brain's memory:

- `vault/people.md`: you, your team, your clients, the language to use with each, and the email senders Jarvis follows. `bin/setup` creates it from `vault/people.example.md`.
- `vault/projects/<name>.md`: one card per repository, copied from `vault/projects/example-project.md`.
- `vault/projects/jarvis.md`: Jarvis itself. `bin/setup` writes this folder's path in it.
- `vault/notes/`: Jarvis writes its running notes here.

`.gitignore` keeps your private data out of git: `.env`, `data/`, `vault/people.md`, your notes and project cards, the screenshot and audit folders, and every picture and video file.

## Run

`npm start` in a terminal, or `bin/install-service` once for a login service plus a `tailscale serve` entry. Chat at
http://127.0.0.1:7717, or from the phone at your `JARVIS_TERM_ORIGIN` URL. Tests: `npm test`. Sample data, without
Orca or a brain: `npm run preview`.

- The first start creates an idle Orca terminal titled JARVIS (its identity) and a Run. Leave that terminal open.
- `touch data/KILL` stops the watcher and the brain. Chat keeps working.
- Times are spoken and shown in Eastern time (`America/Toronto`), set in the code and in `vault/CLAUDE.md`.
- Other settings: `JARVIS_PORT`, `JARVIS_HOME_WORKTREE` (any Orca-managed worktree, as an Orca selector), `JARVIS_TTS_FR` / `JARVIS_TTS_EN` (`say:<voice>` or `<fluidaudio backend>:<voice>`, for example `supertonic3:M1`).
- Voice samples to pick from: `/bakeoff`.
- Hands-free listening: the app's "Hands-free" button. Wake word and thresholds come from `JARVIS_WAKE_WORD`, `JARVIS_VAD_*` and `JARVIS_LISTEN_*`.
- Writes to one Google Sheet go through `bin/sheet-edit`: see [docs/sheet-edit.md](docs/sheet-edit.md).
- `python3 bin/trust-own-repos.py` (with `.env` loaded: `set -a; . ./.env; set +a`) tells Claude Code's auto mode that the repositories in `JARVIS_TRUSTED_REPOS` are yours.

Parakeet v3 lives in `voice/models/` (gitignored). The first `fluidaudiocli transcribe --model-dir voice/models` downloads it.
