# Setup guide for the agent that installs Jarvis

Read this file before you install Jarvis for a new owner. It lists everything this copy ships empty or as a template,
where each piece lives, and a short example of each. Git ignores every file that holds the owner's real data, so you
can fill them in without risk of a commit.

Do the steps in this order. Ask the owner for each value you cannot find on the machine.

## 1. Tools on the machine

Jarvis needs these before `bin/setup` runs:

- macOS, Node 22.18 or later (`node --version`), and the Claude Code CLI (`claude --version`).
- ffmpeg (`brew install ffmpeg`).
- Voice: the FluidAudio CLI. Build it at `~/src/FluidAudio` with `swift build -c release --product fluidaudiocli`. If you build it in another place, set `JARVIS_FLUIDAUDIO` in `.env` to the full path of `fluidaudiocli`.
- Email triage (optional): the `gws` CLI, signed in to the owner's Gmail account.
- Phone access (optional): Tailscale. The code calls it at `/opt/homebrew/bin/tailscale`.
- GitHub actions (optional): `gh`, signed in.

## 2. Settings in .env

Run `bin/setup`. It asks for each setting and writes `.env` (mode 600, ignored by git). Enter keeps the value in
brackets. `.env.example` explains each setting. Run `bin/setup` again to change an answer.

| Setting | What to put | Example |
|---|---|---|
| `JARVIS_OWNER_NAME` | The owner's name, as they sign an email | `Ada Lovelace` |
| `JARVIS_COMPANY`, `JARVIS_COMPANY_ABOUT` | The company and one line on what it does | `Acme Ltd`, `a software company for car dealers` |
| `JARVIS_GMAIL_ACCOUNT` | The Gmail account `gws` reads | `ada@acme.test` |
| `JARVIS_OWNER_EMAILS` | All of the owner's addresses, comma separated | `ada@acme.test,ada@gmail.test` |
| `JARVIS_GMAIL` | `off` to run without the Gmail watcher | `on` |
| `JARVIS_ALLOWED_LOGINS` | The owner's Tailscale login | `ada@acme.test` |
| `JARVIS_TERM_ORIGIN` | The app's tailnet URL | `https://ada-mac.tail1234.ts.net:7717` |
| `JARVIS_SHELL_DEVICES` | The phone's tailnet addresses, from `tailscale status` | `100.64.0.10` |
| `JARVIS_TS_SOCKET`, `JARVIS_TS_SERVICE` | The socket and launchd label of a userspace tailscaled. See the note below | `~/.tailscale-personal/ts.sock`, `local.tailscale-personal` |
| `JARVIS_VAPID_SUBJECT` | A contact for web push | `mailto:ada@acme.test` |
| `JARVIS_TRUSTED_REPOS` | The owner's own GitHub repositories | `acme/app,acme/site` |
| `JARVIS_FBM_REPO`, `JARVIS_PR_AUDIT_REPO` | Local clones that two named actions read. Leave empty to skip | `~/Repos/app` |
| `JARVIS_PROD_MCP_URL`, `JARVIS_STAGING_MCP_URL` | The MCP URLs of the owner's product, if it has them | `https://app.acme.test/api/mcp` |
| `JARVIS_TICKET_PREFIX` | The support desk's ticket prefix | `HELP` for `HELP-1045` |
| `JARVIS_MIGRATION_SHEET_ID` | The one Google Sheet `bin/sheet-edit` may write to | `1AbC...xyz` |

Optional settings, not asked by `bin/setup`:

- `JARVIS_PORT`: the port, `7717` by default.
- `JARVIS_TTS_FR`, `JARVIS_TTS_EN`: the voices, for example `say:Amelie` or `supertonic3:M1`.
- `JARVIS_WAKE_WORD`: the hands-free wake word.

Note on the phone checks: a terminal opens on the phone, and Pair the Mac shows its code, only through a userspace
tailscaled that answers on `JARVIS_TS_SOCKET`. With the Tailscale app alone, both refuse every request from the phone. The rest of the app works.

## 3. People: vault/people.md

`bin/setup` copies `vault/people.example.md` to `vault/people.md`. Replace every example line. Keep one person or
group per line. The brain reads this file at the start of each session. The Gmail watcher reads the "Email: known
senders" section on each poll and drops mail from everyone else.

```markdown
- Ada Lovelace: you work for her. English and French, answer in the language she uses. Acme Ltd sells software to car dealers.
  - Her access: admin on the Acme app.
- Sam Lee: merges the PRs. Talk to Sam on Slack.
- Clients: write to them in French. Never contact a client without Ada's yes.

## Email: known senders

- Sam Lee: sam@acme.test
- Client One: @clientone.test
```

## 4. Project cards: vault/projects/

Make one card per repository the owner works on. Copy `vault/projects/example-project.md` to
`vault/projects/<name>.md` and fill each line. The app's side chat picker lists each card whose first line is
`- Repo:` with an absolute path in backticks.

```markdown
# Acme app

- Repo: `/Users/ada/Repos/acme-app`, GitHub `acme/app`. Base branch `main`. Rules in `.claude/CLAUDE.md`.
- What it is: the web app the dealers use to list their cars.
- How stories run: run the pick-and-ship skill on issue #<n>.
- Rules: never merge on a Friday (Ada, 2026-11-07).
```

`vault/projects/jarvis.md` is the card for Jarvis itself. `bin/setup` writes this folder's path in it, so an install
shows that file as changed. Do not commit that change. Edit its "Standing rule" line to match what the owner wants.

## 5. Notes: vault/notes/

The folder starts empty. Jarvis writes its own notes here, one file per topic. You can start one if the owner has a
running piece of work. Add a line to the Index in `vault/CLAUDE.md` if the brain must read the note on a given
trigger.

```markdown
# Decisions

- 2026-11-07: Ada wants a daily email summary at 8:00 Eastern. Reason: she reads email only once in the morning.
```

## 6. Today list

The Today list lives in the database `data/jarvis.db`. jarvisd creates the database empty on the first start. There
is nothing to import. To check it after the first start, add one item and list it:

```
bin/jarvis-today add --words "Call Sam about the release"
bin/jarvis-today list
```

The item shows behind the app's Today button.

## 7. Migration contacts list

This list is temporary, for one owner's Marketplace migration. `docs/migration/README.md` names every piece of it,
so you can remove it in one change. If the new owner does not need it, leave it empty: the app works without it.

The dealer list `docs/migration/dealerships.json` ships empty, so the first start adds no dealership. To fill it,
write a JSON file in this shape and import it. The import adds only dealerships. It does not add or change people.

```json
{ "dealerships": [ { "name": "Client One", "key": "clientone" }, { "name": "Client Two", "key": "clienttwo" } ] }
```

```
bin/jarvis-migration import-dealers --file ~/clients.json
bin/jarvis-migration add --name "Jo Smith" --dealership "Client One" --source email --from chat
```

## 8. Start and check

1. `npm test`. All tests must pass.
2. `npm run preview` shows the app with sample data, without the brain.
3. `npm start`, or `bin/install-service` for a login service plus `tailscale serve`.
4. Open http://127.0.0.1:7717.
5. Send "hello" in the chat. The brain must answer in the owner's language.
6. Optional: `set -a; . ./.env; set +a; python3 bin/trust-own-repos.py` tells Claude Code's auto mode that the repos in `JARVIS_TRUSTED_REPOS` are the owner's.

To stop the watcher and the brain, run `touch data/KILL`. The chat keeps working.
