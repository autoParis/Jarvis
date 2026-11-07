# People

Template. `bin/setup` copies this file to `vault/people.md`, which git ignores because it holds real names and
addresses. Edit `vault/people.md`, not this file.

Who the owner works with, and how Jarvis should write to each of them. Jarvis reads this file at the start of every
session, and jarvisd reads the "Email: known senders" section on every Gmail poll (code in `daemon/gmail.ts`).
Replace every example line below with your own. Keep the same shape: one person or group per line.

- Owner Name: you work for them. Say which languages they speak and which one to answer in. Their company and what it does.
  - Their access (for example: admin on the product). Before saying anything waits on someone granting the owner access, check this list. If the access is not listed, ask the owner in one sentence.
- Teammate: what they do (for example: merges PRs, handles onboarding). Where the owner talks to them (Slack, email).
- Clients (Example Dealer and others): which language to write to them in. Never contact a client without the owner's yes.

## Email: known senders

jarvisd's Gmail watcher reads mail only from the addresses and `@domains` written below. Everyone else, and every
newsletter, calendar invite or automated alert, is dropped without an LLM call. Add a line to follow someone new. No
restart is needed. The owner's own addresses (`JARVIS_OWNER_EMAILS` in `.env`) are never known senders.

- Teammate: teammate@example.test
- Example Dealer: @dealer.example.test
