// The sync against a fake gws that holds a small Dealerships and Overview sheet. bin/sheet-edit's own run() does the
// writes, so the expected-values check is the real one. Nothing here reaches the real sheet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runSync, syncDue, easternTime } from './sheetsync.ts';
import { run as sheetEditRun } from './sheet-edit.ts';
import { createTables } from './migration.ts';

// A fake gws: reads ranges, inserts rows (a group grows only when the insert falls strictly inside it, like the case
// sheetsync must not rely on), handles the three group requests, and writes values.
const STUB = `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const dir = path.dirname(fs.realpathSync(process.argv[1]));
const args = process.argv.slice(2);
const at = f => { const i = args.indexOf(f); return i < 0 ? undefined : JSON.parse(args[i + 1]); };
const verb = args.slice(0, args.indexOf('--params')).join(' ');
const params = at('--params'), body = at('--json');
fs.appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify({ verb, params, body }) + '\\n');
const s = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
const col = c => [...c].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
function parse(r) {
  const m = /^(?:'([^']+)'|([^'!]+))(?:!([A-Z]+)(\\d+)(?::([A-Z]+)(\\d+))?)?$/.exec(r);
  const tab = m[1] || m[2];
  if (!m[3]) return { tab, c1: 0, r1: 0, c2: 99, r2: 9999 };
  return { tab, c1: col(m[3]), r1: +m[4] - 1, c2: col(m[5] || m[3]), r2: +(m[6] || m[4]) - 1 };
}
const sheetOf = id => s.sheets.find(x => x.properties.sheetId === id);
let out = {};
if (verb === 'sheets spreadsheets get') out = { sheets: s.sheets };
if (verb === 'sheets spreadsheets values get') {
  const r = parse(params.range), g = s.tabs[r.tab] || [];
  const rows = [];
  for (let y = r.r1; y <= Math.min(r.r2, g.length - 1); y++) {
    const row = (g[y] || []).slice(r.c1, r.c2 + 1);
    while (row.length && (row[row.length - 1] === '' || row[row.length - 1] == null)) row.pop();
    rows.push(row);
  }
  while (rows.length && !rows[rows.length - 1].length) rows.pop();
  out = rows.length ? { values: rows } : {};
}
if (verb === 'sheets spreadsheets batchUpdate') {
  for (const q of body.requests) {
    if (q.insertDimension) {
      const { sheetId, startIndex, endIndex } = q.insertDimension.range, sh = sheetOf(sheetId), n = endIndex - startIndex;
      s.tabs[sh.properties.title].splice(startIndex, 0, ...Array.from({ length: n }, () => []));
      for (const g of sh.rowGroups || []) {
        if (g.range.startIndex >= startIndex) { g.range.startIndex += n; g.range.endIndex += n; }
        else if (g.range.endIndex > startIndex) g.range.endIndex += n;
      }
    }
    const r = (q.addDimensionGroup || q.deleteDimensionGroup || {}).range;
    if (q.deleteDimensionGroup) { const sh = sheetOf(r.sheetId); sh.rowGroups = sh.rowGroups.filter(g => !(g.range.startIndex === r.startIndex && g.range.endIndex === r.endIndex)); }
    if (q.addDimensionGroup) { const sh = sheetOf(r.sheetId); (sh.rowGroups = sh.rowGroups || []).push({ range: { ...r }, depth: 1 }); }
    if (q.updateDimensionGroup) { const d = q.updateDimensionGroup.dimensionGroup, sh = sheetOf(d.range.sheetId); const g = sh.rowGroups.find(g => g.range.startIndex === d.range.startIndex && g.range.endIndex === d.range.endIndex); g.collapsed = d.collapsed; }
  }
  out = { replies: [] };
}
if (verb === 'sheets spreadsheets values batchUpdate') {
  for (const d of body.data) {
    const r = parse(d.range), g = s.tabs[r.tab];
    d.values.forEach((row, y) => row.forEach((v, x) => { if (v === null) return; g[r.r1 + y] = g[r.r1 + y] || []; g[r.r1 + y][r.c1 + x] = v; }));
  }
}
fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(s));
console.log(JSON.stringify(out));
`;

const AB = 27, M = 12;
/** A Dealerships row: priority, name, stage formula, owner, then AB = key. */
function dRow(name: string, key: string, extra: Record<number, string> = {}) {
  const r: string[] = Array(30).fill('');
  Object.assign(r, { 0: '2 - Current client', 1: name, 2: '=stage', 3: 'Simon', [AB]: key, ...extra });
  return r;
}
function oRow(name: string, stage: string, key: string) {
  const r: string[] = Array(14).fill('');
  Object.assign(r, { 0: name, 1: key.includes('/') ? 'EvalAuto · active' : '=count', 2: stage, [M]: key });
  return r;
}
function sheet() {
  return {
    sheets: [
      { properties: { sheetId: 31, title: 'Overview' }, rowGroups: [{ range: { sheetId: 31, dimension: 'ROWS', startIndex: 2, endIndex: 4 }, depth: 1, collapsed: true }] },
      { properties: { sheetId: 30, title: 'Dealerships' }, rowGroups: [{ range: { sheetId: 30, dimension: 'ROWS', startIndex: 2, endIndex: 3 }, depth: 1 }] },
    ],
    tabs: {
      Dealerships: [
        ['Priority', 'Dealership'],
        dRow('Acme Kia', 'acmekia'),
        dRow('    Ann Lee', 'acmekia/annlee'),
        dRow('Bolt Nissan', 'boltnissan'),
      ],
      Overview: [
        ['Dealership / sub-account'],
        oRow('=acme', 'Contacted', 'acmekia'),
        oRow('    Acme legacy', '=legacy', ''),
        oRow('    Ann Lee', 'Migrated', 'acmekia/annlee'),
        oRow('=bolt', 'Needs confirmation', 'boltnissan'),
        oRow('    Bolt legacy', '=legacy', ''),
      ],
    },
  };
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'sheetsync-'));
  const gwsBin = join(dir, 'gws');
  writeFileSync(gwsBin, STUB, { mode: 0o755 });
  writeFileSync(join(dir, 'state.json'), JSON.stringify(sheet()));
  const db = new DatabaseSync(':memory:');
  createTables(db);
  db.exec(`INSERT INTO migration_dealers (id, name, sheet_key, on_sheet) VALUES (1, 'Acme Kia', 'acmekia', 1), (2, 'Bolt Nissan', 'boltnissan', 1), (3, 'Off Sheet Motors', NULL, 0)`);
  let n = 0;
  const add = (name: string, dealer: number, status = 'todo', o: { note?: string; meeting?: string; source?: string } = {}) => {
    db.prepare(`INSERT INTO migration_people (uid, name, dealer_id, source, status, note, meeting_at, added_by) VALUES (?, ?, ?, ?, ?, ?, ?, 'owner')`)
      .run(`uid-${++n}`, name, dealer, o.source ?? 'email', status, o.note ?? '', o.meeting ?? null);
    return n;
  };
  const dataDir = join(dir, 'data');
  const lines: string[] = [];
  const sync = (mode: 'dry-run' | 'write') => runSync(mode, {
    sheetId: 'TEST_SHEET', db, dataDir, gwsBin, now: () => new Date('2026-11-10T12:30:00Z'),
    log: (m, f) => lines.push(`${m} ${JSON.stringify(f)}`),
    sheetEdit: (file, dryRun) => {
      const out: string[] = [];
      const code = sheetEditRun([file, ...(dryRun ? ['--dry-run'] : [])], { gwsBin, root: dir, log: l => out.push(l) });
      return { code, output: out.join('\n') };
    },
  });
  const state = () => JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
  const setCell = (tab: string, row1: number, col: number, v: string) => { const s = state(); s.tabs[tab][row1 - 1][col] = v; writeFileSync(join(dir, 'state.json'), JSON.stringify(s)); };
  const calls = () => existsSync(join(dir, 'calls.jsonl')) ? readFileSync(join(dir, 'calls.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)) : [];
  const valueWrites = () => calls().filter(c => c.verb === 'sheets spreadsheets values batchUpdate');
  return { db, add, sync, state, setCell, calls, valueWrites, lines, dataDir };
}

test('a new lead adds a sub-line at the end of its block on both tabs, inside the row group', () => {
  const t = setup();
  t.add('Zoé Côté', 2, 'meeting', { meeting: '2026-11-11 15:00:00', note: 'Texted Nov 10', source: 'text' });
  const r = t.sync('write');
  assert.equal(r.outcome, 'ok', r.error);
  const s = t.state();
  const d = s.tabs.Dealerships, o = s.tabs.Overview;
  // Dealerships: the new row sits after Bolt Nissan (row 4), so it is row 5.
  assert.equal(d[4][1], '    Zoé Côté');
  assert.equal(d[4][AB], 'boltnissan/zoecote');
  assert.equal(d[4][2], '=IFERROR(INDEX(Overview!$C:$C,MATCH($AB5,Overview!$M:$M,0)),"Not on Overview")');
  assert.equal(d[4][6], '2026-11-11 10:00 AM Eastern');
  assert.equal(d[4][8], 'Zoé Côté (text message)');
  assert.equal(d[4][21], 'Texted Nov 10');
  assert.equal(d[4][0], '2 - Current client');
  // Overview: after the Bolt legacy row (row 6), so row 7, with the stage the dropdown knows.
  assert.equal(o[6][0], '    Zoé Côté');
  assert.equal(o[6][2], 'Appointment booked');
  assert.equal(o[6][M], 'boltnissan/zoecote');
  assert.equal(o[6][13], '=IF($D7<>"",$D7,N6)');
  // Bolt had no Dealerships sub-line, so the new row gets its own group. On Overview the row is ungrouped too.
  const groups = (title: string) => s.sheets.find((x: { properties: { title: string } }) => x.properties.title === title).rowGroups.map((g: { range: { startIndex: number; endIndex: number } }) => [g.range.startIndex, g.range.endIndex]);
  assert.deepEqual(groups('Dealerships'), [[2, 3], [4, 5]]);
  assert.deepEqual(groups('Overview'), [[2, 4], [6, 7]]);
  assert.match(t.lines.join('\n'), /migration sheet sync wrote .*Dealerships!V5/);
});

test('a person added after an existing sub-line joins the group above, which stays collapsed', () => {
  const t = setup();
  t.add('Ann Lee', 1, 'migrated');
  t.add('Bob Roy', 1, 'contacted');
  const r = t.sync('write');
  assert.equal(r.outcome, 'ok', r.error);
  const s = t.state();
  assert.equal(s.tabs.Dealerships[3][AB], 'acmekia/bobroy');
  assert.equal(s.tabs.Overview[4][M], 'acmekia/bobroy');
  const og = s.sheets.find((x: { properties: { title: string } }) => x.properties.title === 'Overview').rowGroups;
  assert.deepEqual(og.map((g: { range: { startIndex: number; endIndex: number }; collapsed?: boolean }) => [g.range.startIndex, g.range.endIndex, !!g.collapsed]), [[2, 5, true]]);
  // Ann Lee is Migrated on both sides, so her stage is not written. Only her empty contact cell is filled.
  assert.deepEqual(r.writes.filter(w => w.person === 'Ann Lee').map(w => [w.field, w.cell, w.to]), [['contact', 'Dealerships!I3', 'Ann Lee (email)']]);
  assert.deepEqual(r.counts, [{ dealership: 'Acme Kia', before: '1 of 1 migrated', after: '1 of 2 migrated' }]);
});

test('a changed lead updates only its own stage cell', () => {
  const t = setup();
  const id = t.add('Bob Roy', 1, 'contacted');
  assert.equal(t.sync('write').outcome, 'ok');
  const before = t.valueWrites().length;
  t.db.prepare(`UPDATE migration_people SET status = 'migrated' WHERE id = ?`).run(id);
  const r = t.sync('write');
  assert.equal(r.outcome, 'ok', r.error);
  assert.deepEqual(r.writes.map(w => w.cell), ['Overview!C5']);
  assert.equal(r.added.length, 0);
  const last = t.valueWrites().slice(before);
  assert.deepEqual(last.flatMap(c => c.body.data.map((d: { range: string }) => d.range)), ['Overview!C5']);
  assert.equal(t.state().tabs.Overview[4][2], 'Migrated');
});

test('a cell changed by hand since the last sync is never overwritten: a conflict when the lead changed too', () => {
  const t = setup();
  const id = t.add('Bob Roy', 1, 'contacted');
  t.sync('write');
  t.setCell('Overview', 5, 2, 'Replied'); // the owner picks another stage on the sheet
  t.db.prepare(`UPDATE migration_people SET status = 'meeting', meeting_at = '2026-11-12 14:00:00' WHERE id = ?`).run(id);
  const r = t.sync('write');
  assert.equal(r.outcome, 'ok', r.error);
  assert.equal(t.state().tabs.Overview[4][2], 'Replied');
  assert.deepEqual(r.conflicts.map(c => [c.field, c.from, c.to]), [['stage', 'Replied', 'Appointment booked']]);
  // The meeting cell was not touched by hand, so it still follows the lead.
  assert.deepEqual(r.writes.map(w => w.cell), ['Dealerships!G4']);
  // The conflict shows again on the next run, until one side gives.
  assert.equal(t.sync('write').conflicts.length, 1);
});

test('a hand edit with no lead change is kept and not reported as a conflict', () => {
  const t = setup();
  t.add('Bob Roy', 1, 'contacted', { note: 'first note' });
  t.sync('write');
  t.setCell('Dealerships', 4, 21, 'the owner rewrote this');
  const r = t.sync('write');
  assert.equal(r.outcome, 'nothing');
  assert.equal(r.conflicts.length, 0);
  assert.equal(r.kept[0].field, 'note');
  assert.equal(t.state().tabs.Dealerships[3][21], 'the owner rewrote this');
});

test('first sync: a person already on the sheet with another stage is a conflict, and the sheet is kept', () => {
  const t = setup();
  t.add('Ann Lee', 1, 'contacted');
  const r = t.sync('write');
  assert.deepEqual(r.conflicts.map(c => [c.person, c.from, c.to]), [['Ann Lee', 'Migrated', 'Contacted']]);
  assert.equal(t.state().tabs.Overview[3][2], 'Migrated');
});

test('a dry run writes nothing and saves no baseline', () => {
  const t = setup();
  t.add('Bob Roy', 1);
  const r = t.sync('dry-run');
  assert.equal(r.outcome, 'ok', r.error);
  assert.equal(t.calls().filter(c => /batchUpdate$/.test(c.verb)).length, 0);
  assert.ok(!existsSync(join(t.dataDir, 'baseline.json')));
  assert.match(r.sheetEdit.join('\n'), /Dry run: nothing written/);
  assert.ok(r.writes.some(w => w.cell === 'Overview!C5' && w.to === 'Not contacted'));
});

test('a note naming a password is never copied, and off-sheet or removed leads are skipped', () => {
  const t = setup();
  t.add('Bob Roy', 1, 'todo', { note: 'mot de passe: hunter2' });
  t.add('Cy Off', 3);
  const gone = t.add('Dee Gone', 2);
  t.db.prepare(`UPDATE migration_people SET removed_at = datetime('now') WHERE id = ?`).run(gone);
  const r = t.sync('write');
  assert.equal(r.outcome, 'ok', r.error);
  assert.equal(t.state().tabs.Dealerships[3][21] ?? '', '');
  assert.ok(!JSON.stringify(t.calls()).includes('hunter2'));
  assert.deepEqual(r.skipped.map(s => s.person).sort(), ['Bob Roy', 'Cy Off', 'Dee Gone']);
});

test('a cell edited between the read and the write aborts the run: sheet-edit writes nothing', () => {
  const t = setup();
  const id = t.add('Bob Roy', 1, 'contacted');
  t.sync('write');
  t.db.prepare(`UPDATE migration_people SET status = 'migrated' WHERE id = ?`).run(id);
  // The owner changes the target cell after the sync read the sheet and before sheet-edit runs.
  const r = runSync('write', {
    sheetId: 'TEST_SHEET', db: t.db, dataDir: t.dataDir, gwsBin: join(t.dataDir, '..', 'gws'),
    sheetEdit: (file) => { t.setCell('Overview', 5, 2, 'Declined'); return { code: sheetEditRun([file], { gwsBin: join(t.dataDir, '..', 'gws'), root: join(t.dataDir, '..'), log: () => {} }), output: '' }; },
  });
  assert.equal(r.outcome, 'aborted');
  assert.equal(t.state().tabs.Overview[4][2], 'Declined');
});

test('the timer is due once a day from 7:30 AM Eastern', () => {
  assert.deepEqual(syncDue(new Date('2026-11-10T12:29:00Z'), undefined), { due: false, day: '2026-11-10' }); // 7:29 EST
  assert.deepEqual(syncDue(new Date('2026-11-10T12:30:00Z'), undefined), { due: true, day: '2026-11-10' });
  assert.equal(syncDue(new Date('2026-11-10T20:00:00Z'), '2026-11-10').due, false);
  assert.equal(syncDue(new Date('2026-07-10T11:30:00Z'), '2026-07-09').due, true); // 7:30 EDT
  assert.equal(easternTime('2026-07-10T14:00:00Z'), '2026-07-10 10:00 AM Eastern');
});
