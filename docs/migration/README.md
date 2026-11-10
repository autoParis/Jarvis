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
- An open row has a small pencil Edit. Edit mode changes the name, the dealership (from the same list, no Other), the source and an optional contact (a phone number or an email, `contact`), then Save or Cancel. The open row shows the contact as a link when it is set. The brain does the same with `jarvis-migration edit <id>`, and `add` takes `--contact`. An edit never changes the status, the note, the history or the uid, and it refuses to make a second row with the same name at the same dealership.
- The x on an "Added by Jarvis" line hides that line on that row for good (`by_hidden_at`). Who added the row stays stored.
- The page and the brain never write to the sheet. The panel footer says the sheet stays the record. Only the daily sync below writes to it.

## Daily sync to the sheet

`bin/migration-sheet-sync` copies the list to the migration sheet (`JARVIS_MIGRATION_SHEET_ID`). It writes only through `bin/sheet-edit`, so every changed cell carries its expected value and a cell edited after the read aborts the write. Rules are in `daemon/sheetsync.ts`.

- Each person is a sub-line with a readable key `<dealership key>/<folded name>` (Dealerships AB, Overview M, used by the formulas) and the lead's uid in a hidden "Lead id (Jarvis)" column (Dealerships AE, Overview O). Rows match by the uid, so a rename in the list updates the same row and keeps its key. A row without a uid matches once by its key and then gets the uid. A new person gets a Dealerships sub-line and an Overview child row at the end of the dealership's block, and joins its row group.
- The sync owns five cells of a person: name (Dealerships B, Overview A), stage (Overview C: To contact is `Not contacted`, Contacted is `Contacted`, Meeting set is `Appointment booked`, Migrated is `Migrated`), meeting time in Eastern (Dealerships G), contact (Dealerships I: the name, then the lead's phone or email, else the channel) and note (Dealerships V).
- The Leads list is the source of truth for people (the owner's rule of 2026-11-10). The stage always follows the list, Migrated included, and a stage changed by hand on the sheet is replaced. The other cells follow a lead change. `data/migration-sheet-sync/baseline.json` keeps the lead value and the sheet value of each owned cell, to tell a lead change from a hand edit. A hand edit that the list replaces is listed in the run's report. Without a lead change, the sheet's own text stays.
- The X of Y counts (Dealerships AD, Overview B) are formulas that count the keys, so they follow the new rows. The report shows them before and after.
- It never moves a row: a lead moved to another dealership in the Leads list is skipped and listed in the report.
- It never deletes a row, never copies a note that names a password or token, and skips a dealership that is not on the sheet.
- It writes one range per row, and each write run checks every lead row: a row outside a row group joins its dealership's group, so a group step that failed one day is done the next.
- jarvisd runs it once a day at 7:30 AM Eastern. `JARVIS_MIGRATION_SHEET_SYNC` is `dry-run` (the default: plans and reports, writes nothing), `write` or `off`. Each run is a mark on the Scheduled tasks screen (row "Migration sheet sync", id `jarvisd:sheet-sync`), with a note and the report path. An abort is a warning, a failure is failing and also wakes the brain. The state key `migrationSheetSyncDay` holds the day of the last run, so a restart never runs it twice. Each run keeps `edit.json`, `result.json` and `report.md` in `data/migration-sheet-sync/runs/<time>-<mode>/`, and the jarvisd log has one line per written cell.
- By hand: `bin/migration-sheet-sync --dry-run [--report <file.md>]` or `--write`. From a worktree, set `JARVIS_DATA_DIR=$HOME/Repos/jarvis/data` and `JARVIS_SHEET_EDIT=$HOME/Repos/jarvis/bin/sheet-edit`.

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
| `daemon/sheetsync.ts`, `daemon/sheetsync.test.ts`, `bin/migration-sheet-sync` | The daily sync to the sheet and its tests |
| `daemon/timers.ts`, `daemon/timers.test.ts` | `startSheetSync`, `SHEET_SYNC_TICK_MS` and its test |
| `daemon/main.ts` (sync) | `SHEET_SYNC_ON`, the `jarvisd:sheet-sync` row of the Scheduled tasks list, the "Migration sheet sync" block, the three imports for it |
| `daemon/config.ts` | `MIGRATION_SHEET_SYNC` |
| `data/migration-sheet-sync/` | The baseline and the run records. State key `migrationSheetSyncDay` |
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
