# Migration contacts list

Status: built on 2026-11-06. Sample data with `npm run preview`, then `?s=migration`.

It is temporary: it lasts as long as the Marketplace migration (about the end of December 2026). Every piece is listed below, so it comes out in one change.

## What it does

- One row per person: name, dealership, source (email or text message), status, note, who added it (The owner, or Jarvis and where from) and timestamps.
- Each person has a stable `uid` that never changes (a database trigger refuses it), and every status change is kept with its time and who made it in `migration_status_log`. A later daily job can sync to the Google Sheet from those without guessing. A removed row keeps its `removed_at` for the same reason.
- The dealership is picked from a dropdown, never typed by the brain. The list was seeded once from the Dealerships tab of the migration sheet, names exactly as the sheet writes them, with the sheet's "Stable dealership key". Seller rows (keys with a slash) are left out. The public copy ships `dealerships.json` empty: import your own list (below).
- The owner can add a missing dealership with "Other..." in the add form. It is flagged as not on the sheet until an import brings the same name.
- Statuses: To contact, Contacted, Meeting set, Migrated. Migrated rows sit in a folded Done section. The button counts only To contact.
- Meeting times. Picking Meeting set opens a day field and a time field under the row; the status waits until Set, and Cancel changes nothing. The add form shows the same two fields for Meeting set, and Add stays off until both are picked. Tapping a meeting's time on its row moves it. Times are entered and shown in Eastern and stored in UTC (`meeting_at`). The brain sets one with `--at`; a Meeting set row without one shows "Pick a time".
- Each row shows the time since its last status change as a short number (5h, 3d). The list reads Meetings soonest first, then To contact and Contacted with the longest silence first.
- The Leads button is one of the four need buttons. A meeting shows as a one-line toast at the right under the bar, only on the Eastern day of the meeting. Its x closes it for that meeting on every screen; the daemon keeps the closed keys in the state key `migrationToastClosed`.
- The x on an "Added by Jarvis" line hides that line on that row for good (`by_hidden_at`). Who added the row stays stored.
- Nothing is written to the sheet. The panel footer says the sheet stays the record.

## Re-importing the dealerships

The sheet's Dealerships tab may gain rows. Export it to a JSON file shaped like `docs/migration/dealerships.json` (`{"dealerships":[{"name":"...","key":"..."}]}`), then:

```
jarvis-migration import-dealers --file <path.json>
```

A row matches by its key, else by its exact name. A new name is added, a changed name under the same key is renamed, and a dealership missing from the file stays but is flagged as not on the sheet. People rows are never touched.

## Every piece, for removal

| Piece | What it is |
|---|---|
| `daemon/migration.ts` | Tables, rules, routes and the session brief lines |
| `daemon/migration.test.ts` | Its tests |
| `bin/jarvis-migration` | The brain's CLI: add, list, dealers, set-status, meeting, note, import-dealers |
| `web/migration.js` | The button count and popup |
| `docs/migration/` | This file and the seed (`dealerships.json`) |
| `daemon/main.ts` | The `makeMigration` block, `migrationBrief` in `brief()`, three paths in `AS_OWNER`, `/migration.js` in `STATIC`, `migration` in the history event, the route block |
| `web/index.html` | `#mig-btn` in the need bar, the `.mtoast-row` before `#doneline`, `paintMigration`, `paintToast`, `toastClosing`, the minute timer and the `#mtoast-x` handler, the `#pop-migration` section, the import, the `migration` entry in `POPS`, `$('mtoast')` in the `inert` list, the `closed()` call, two event lines |
| `web/app.css` | The block starting "Migration contacts list" and its lines in the 780 px media query, the meeting toast block (`.mtoast`, `.mt-*`) and its phone lines |
| `bin/preview.ts` | `sampleMigration`, the `?s=migration` scene and the route line |
| `vault/CLAUDE.md` | The "Migration list" section and its line under "Access" |
| Database | Tables `migration_dealers`, `migration_people` (with `meeting_at` and `by_hidden_at`), `migration_status_log` (with `meeting_at`), trigger `migration_uid_fixed`, state keys `migrationSeeded` and `migrationToastClosed`. Drop them after the sheet sync has read them for the last time. |
