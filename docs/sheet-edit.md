# sheet-edit

`bin/sheet-edit` writes to the Marketplace migration sheet (the id in `JARVIS_MIGRATION_SHEET_ID`). Use it for every write to that sheet, so one allow rule covers them. Ad hoc python or `gws` writes get blocked by the auto mode classifier, even when the owner approved them through the coordinator. Reads can still use `gws` directly.

Always call it by its absolute path in the main checkout. The allow rule only matches that path, and backups land in that checkout's `data/`, which outlives any worktree.

```sh
$HOME/Repos/jarvis/bin/sheet-edit <edit.json> [--dry-run] [--sheet-id <id>]
```

The sheet id and the `gws` path are constants. `--sheet-id` and `spreadsheetId` in the edit file can only confirm the migration sheet: any other value is refused.

| Exit | Meaning |
| --- | --- |
| 0 | Done and verified, or the dry run passed |
| 1 | `gws` failed or the read-back differs. The sheet may be partly edited |
| 2 | Refused: another sheet id, a bad edit file, or an unknown tab. Nothing written |
| 3 | Preflight abort: the target rows differ from the edit file. Nothing written |

## What a run does

1. Validates the edit file.
2. Reads each `expected` range and aborts if any cell differs.
3. With `--dry-run`, prints the planned changes and stops. There is no backup and no write.
4. Saves the affected tabs to `data/sheet-backups/<timestamp>/<tab>.json`: formulas and values, plus row groups, merges and colour rules. `edit.json` goes beside them.
5. Repeats the preflight, because the backup can take seconds.
6. Runs `requests`, then `writes`.
7. Reads back every written range and every `verify` range, prints expected against actual, and saves `result.json` with the outcome.

## Edit file

```json
{
  "description": "Dealer B: Andy Example migrated",
  "expected": [
    { "range": "Dealerships!A85:C85", "values": [["4 - Older", "Dealer B", "Contacted"]] }
  ],
  "writes": [
    { "range": "Dealerships!C85", "values": [["Migrated"]] }
  ]
}
```

To insert rows or change formatting, add `requests`, which are Sheets `batchUpdate` request objects. An edit with requests must also have a `verify` list:

```json
{
  "expected": [
    { "range": "Dealerships!A85:C85", "values": [["4 - Older", "Dealer B", "Contacted"]] }
  ],
  "requests": [
    { "insertDimension": { "range": { "sheetId": 20261030, "dimension": "ROWS", "startIndex": 85, "endIndex": 86 }, "inheritFromBefore": true } }
  ],
  "writes": [
    { "range": "Dealerships!A86:B86", "values": [["4 - Older", "    Andy Example"]] }
  ],
  "verify": [
    { "range": "Dealerships!A85:C85", "values": [["4 - Older", "Dealer B", "Contacted"]] }
  ]
}
```

The rules for each key:

- `expected` is required. It holds the current cells, read with the `FORMULA` render option, so a formula cell is written as its formula. Google drops trailing blanks, so a missing cell equals `""`. Numbers compare by their text.
- `writes[].range` must be a closed range with a tab, and `values` must fill it exactly. `null` leaves a cell alone and skips its read-back.
- `writes[].inputOption` is `RAW` (the default) or `USER_ENTERED`.
- `writes[].expect` replaces the read-back check when Google converts the value. `USER_ENTERED` dates, for example, read back as serial numbers.
- Without `requests`, every write must sit inside an `expected` range.
- With `requests`, write and verify ranges use the row numbers after the requests have run. Split the work into two edits if a later step needs to see the result first.
- `deleteSheet` requests are refused. Unknown keys are refused too, so a typo cannot silently drop part of an edit.

## Limits

- `verify` only checks cell values. A formatting request is not itself verified, so verify that the rows it touched kept their values.
- `requests` can reach rows that `expected` does not list, and the preflight does not protect those rows. The backup does cover their tabs.
- Writes are not atomic. If `requests` succeed and `writes` fail, the run exits 1 and prints the backup path. Nothing restores automatically.
- A hand edit in the moment between the second preflight and the write goes undetected until the read-back.
- The command cannot stop other tools from writing to the sheet. "The only way" holds because auto mode blocks the others.

## Allow rule

The owner adds this by hand, to `permissions.allow` in `~/.claude/settings.json` and in the Jarvis repo's `.claude/settings.json`. It is the same string in both:

```
Bash($HOME/Repos/jarvis/bin/sheet-edit *)
```

The rule needs `bin/sheet-edit` merged into the main checkout, because that is the path it names. A relative `Bash(bin/sheet-edit *)` is deliberately not proposed: it would match a file of that name in any repo, and it would put backups in a worktree that later gets deleted.
