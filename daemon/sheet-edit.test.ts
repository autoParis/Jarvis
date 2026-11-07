// Every test drives a stub gws executable in a temp dir. Nothing here reaches the real sheet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { run, SHEET_ID } from './sheet-edit.ts';

const STUB = `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const dir = path.dirname(fs.realpathSync(process.argv[1]));
const args = process.argv.slice(2);
const at = f => { const i = args.indexOf(f); return i < 0 ? undefined : JSON.parse(args[i + 1]); };
const verb = args.slice(0, args.indexOf('--params')).join(' ');
const params = at('--params'), body = at('--json');
fs.appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify({ verb, params, body }) + '\\n');
const state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
console.error('Using keyring backend: keyring');
if (state.failOn === verb) { console.error('boom'); process.exit(1); }
let out = {};
if (verb === 'sheets spreadsheets get') out = { sheets: state.sheets };
if (verb === 'sheets spreadsheets values get') {
  out = { values: state.cells[params.range] };
  if (state.changeOnRead?.range === params.range) Object.assign(state.cells, state.changeOnRead.cells);
}
if (verb === 'sheets spreadsheets batchUpdate') { Object.assign(state.cells, state.afterRequests); out = { replies: [{}] }; }
if (verb === 'sheets spreadsheets values batchUpdate') {
  for (const d of body.data) state.cells[d.range] = state.corruptWrites ? [['WRONG']] : d.values;
}
fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state));
console.log(JSON.stringify(out));
`;

const SHEETS = [{ properties: { sheetId: 10, title: 'Dealerships' } }, { properties: { sheetId: 20, title: 'AcmeApp evidence' } }];
const ROW = 'Dealerships!A5:C5';
const baseCells = () => ({ [ROW]: [['Acme', 'Lead']], Dealerships: [['Name'], ['Acme', 'Lead']], "'Dealerships'": [['Name'], ['Acme', 'Lead']], "'AcmeApp evidence'": [['Id']] });

function setup(state: object = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sheet-edit-'));
  const gwsBin = join(dir, 'gws');
  writeFileSync(gwsBin, STUB, { mode: 0o755 });
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ sheets: SHEETS, cells: baseCells(), ...state }));
  const root = join(dir, 'root');
  const lines: string[] = [];
  return {
    root,
    output: () => lines.join('\n'),
    calls: () => existsSync(join(dir, 'calls.jsonl')) ? readFileSync(join(dir, 'calls.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)) : [],
    writes: function () { return this.calls().filter((c: { verb: string }) => /batchUpdate$/.test(c.verb)); },
    backups: () => existsSync(join(root, 'data', 'sheet-backups')) ? readdirSync(join(root, 'data', 'sheet-backups')) : [],
    run: (edit: unknown, ...flags: string[]) => {
      const file = join(dir, 'edit.json');
      writeFileSync(file, typeof edit === 'string' ? edit : JSON.stringify(edit));
      return run([file, ...flags], { gwsBin, root, now: () => new Date('2026-11-03T12:00:00.000Z'), log: l => lines.push(l) });
    },
  };
}

const edit = (over: object = {}) => ({
  expected: [{ range: ROW, values: [['Acme', 'Lead']] }],
  writes: [{ range: ROW, values: [['Acme', 'Migrated', 'The owner']] }],
  ...over,
});

test('refuses another sheet id from the flag and from the edit file, before calling gws', () => {
  const a = setup();
  assert.equal(a.run(edit(), '--sheet-id', 'some-other-sheet'), 2);
  assert.match(a.output(), /refused.*some-other-sheet/i);
  assert.equal(a.calls().length, 0);

  const b = setup();
  assert.equal(b.run(edit({ spreadsheetId: 'some-other-sheet' })), 2);
  assert.match(b.output(), /refused.*some-other-sheet/i);
  assert.equal(b.calls().length, 0);
});

test('the real command refuses another sheet id and exits 2', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sheet-edit-'));
  const file = join(dir, 'edit.json');
  writeFileSync(file, JSON.stringify(edit()));
  const bin = join(dirname(import.meta.filename), '..', 'bin', 'sheet-edit');
  const r = spawnSync(bin, [file, '--dry-run', '--sheet-id', 'some-other-sheet'], { encoding: 'utf8' });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stdout + r.stderr, /refused.*some-other-sheet/i);
});

test('accepts the migration sheet id when named explicitly', () => {
  const t = setup();
  assert.equal(t.run(edit({ spreadsheetId: SHEET_ID }), '--dry-run', '--sheet-id', SHEET_ID), 0);
});

test('every gws call carries the hardcoded sheet id', () => {
  const t = setup();
  assert.equal(t.run(edit()), 0);
  assert.ok(t.calls().length > 0);
  for (const c of t.calls()) assert.equal(c.params.spreadsheetId, SHEET_ID);
});

test('preflight abort: changed rows write nothing and leave no backup', () => {
  const t = setup({ cells: { ...baseCells(), [ROW]: [['Acme', 'Someone changed this']] } });
  assert.equal(t.run(edit()), 3);
  assert.equal(t.writes().length, 0);
  assert.deepEqual(t.backups(), []);
  assert.match(t.output(), /B5.*Lead.*Someone changed this/);
});

test('rows that change during the backup abort the write and keep the backup', () => {
  const t = setup({ changeOnRead: { range: "'Dealerships'", cells: { [ROW]: [['Acme', 'Edited mid-backup']] } } });
  assert.equal(t.run(edit()), 3);
  assert.equal(t.writes().length, 0);
  assert.match(t.output(), /B5.*Lead.*Edited mid-backup/);
  const dir = join(t.root, 'data', 'sheet-backups', t.backups()[0]);
  assert.equal(JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8')).outcome, 'aborted');
});

test('preflight abort also applies to a dry run', () => {
  const t = setup({ cells: { ...baseCells(), [ROW]: [['Other']] } });
  assert.equal(t.run(edit(), '--dry-run'), 3);
  assert.equal(t.writes().length, 0);
});

test('preflight treats the blanks Google trims as equal, and numbers as their text', () => {
  const t = setup({ cells: { ...baseCells(), [ROW]: [['Acme', 12]] } });
  assert.equal(t.run(edit({ expected: [{ range: ROW, values: [['Acme', '12', '']] }] }), '--dry-run'), 0);
});

test('preflight sees a trailing cell the edit did not expect', () => {
  const t = setup({ cells: { ...baseCells(), [ROW]: [['Acme', 'Lead', 'extra']] } });
  assert.equal(t.run(edit()), 3);
});

test('dry run writes nothing, leaves no backup, and prints the planned change', () => {
  const t = setup();
  assert.equal(t.run(edit(), '--dry-run'), 0);
  assert.equal(t.writes().length, 0);
  assert.deepEqual(t.backups(), []);
  assert.match(t.output(), /B5.*Lead.*Migrated/);
  assert.match(t.output(), /C5.*The owner/);
  assert.match(t.output(), /dry run/i);
});

test('a real edit backs up first, writes, reads back, and records the result', () => {
  const t = setup();
  assert.equal(t.run(edit()), 0);
  const calls = t.calls();
  const backupRead = calls.findIndex((c: { params: { range?: string } }) => c.params.range === "'Dealerships'");
  const firstWrite = calls.findIndex((c: { verb: string }) => c.verb === 'sheets spreadsheets values batchUpdate');
  assert.ok(backupRead >= 0 && backupRead < firstWrite, 'the backup read comes before the write');
  const readAfterWrite = calls.slice(firstWrite + 1).filter((c: { params: { range?: string } }) => c.params.range === ROW);
  assert.equal(readAfterWrite.length, 1, 'the written range is read back');
  assert.deepEqual(t.backups(), ['2026-11-03T12-00-00-000Z']);
  const dir = join(t.root, 'data', 'sheet-backups', '2026-11-03T12-00-00-000Z');
  const tab = JSON.parse(readFileSync(join(dir, 'Dealerships.json'), 'utf8'));
  assert.deepEqual(tab.values, [['Name'], ['Acme', 'Lead']]);
  assert.equal(tab.spreadsheetId, SHEET_ID);
  assert.equal(existsSync(join(dir, 'AcmeApp evidence.json')), false);
  assert.equal(JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8')).outcome, 'verified');
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'edit.json'), 'utf8')), edit());
  assert.match(t.output(), /no differences/i);
});

test('read-back mismatch exits 1, prints expected against actual, and records it', () => {
  const t = setup({ corruptWrites: true });
  assert.equal(t.run(edit()), 1);
  assert.match(t.output(), /A5.*Acme.*WRONG/);
  const dir = join(t.root, 'data', 'sheet-backups', t.backups()[0]);
  assert.equal(JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8')).outcome, 'mismatch');
});

test('a write that fails exits 1 and names the backup', () => {
  const t = setup({ failOn: 'sheets spreadsheets values batchUpdate' });
  assert.equal(t.run(edit()), 1);
  assert.match(t.output(), /boom/);
  assert.match(t.output(), /2026-11-03T12-00-00-000Z/);
  const dir = join(t.root, 'data', 'sheet-backups', t.backups()[0]);
  assert.equal(JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8')).outcome, 'write_failed');
});

test('a read that fails before any write exits 1 and writes nothing', () => {
  const t = setup({ failOn: 'sheets spreadsheets values get' });
  assert.equal(t.run(edit()), 1);
  assert.equal(t.writes().length, 0);
});

test('null in new values leaves the cell alone and is not checked on read-back', () => {
  const t = setup({ cells: { ...baseCells() } });
  const e = edit({ writes: [{ range: ROW, values: [[null, 'Migrated', null]], expect: undefined }] });
  assert.equal(t.run(e), 0);
});

test('expect overrides the read-back check for a value Google converts', () => {
  const t = setup({ corruptWrites: true });
  const e = edit({ writes: [{ range: ROW, values: [['2026-11-03', 'x', 'y']], inputOption: 'USER_ENTERED', expect: [['WRONG']] }] });
  assert.equal(t.run(e), 0);
  const write = t.writes()[0];
  assert.equal(write.body.valueInputOption, 'USER_ENTERED');
});

test('requests run before writes, back up the tab they name, and need a verify list', () => {
  const after = { 'Dealerships!A6:B6': [['New', 'Row']] };
  const t = setup({ afterRequests: after });
  const e = {
    expected: [{ range: ROW, values: [['Acme', 'Lead']] }],
    requests: [{ insertDimension: { range: { sheetId: 20, dimension: 'ROWS', startIndex: 5, endIndex: 6 } } }],
    writes: [{ range: 'Dealerships!A7:A7', values: [['Below the new row']] }],
    verify: [{ range: 'Dealerships!A6:B6', values: [['New', 'Row']] }],
  };
  assert.equal(t.run(e), 0);
  assert.deepEqual(t.writes().map((c: { verb: string }) => c.verb), ['sheets spreadsheets batchUpdate', 'sheets spreadsheets values batchUpdate']);
  const dir = join(t.root, 'data', 'sheet-backups', t.backups()[0]);
  assert.equal(existsSync(join(dir, 'Dealerships.json')), true);
  assert.equal(existsSync(join(dir, 'AcmeApp evidence.json')), true);
});

test('a verify mismatch after requests exits 1', () => {
  const t = setup({ afterRequests: { 'Dealerships!A6:A6': [['Other']] } });
  const e = {
    expected: [{ range: ROW, values: [['Acme', 'Lead']] }],
    requests: [{ insertDimension: { range: { sheetId: 10, dimension: 'ROWS', startIndex: 5, endIndex: 6 } } }],
    verify: [{ range: 'Dealerships!A6:A6', values: [['New']] }],
  };
  assert.equal(t.run(e), 1);
  assert.match(t.output(), /A6.*New.*Other/);
});

test('handles a quoted tab name and names cells past column Z', () => {
  const range = "'AcmeApp evidence'!AA3:AC3";
  const t = setup({ cells: { ...baseCells(), [range]: [['a', 'changed', 'c']] } });
  assert.equal(t.run({ expected: [{ range, values: [['a', 'b', 'c']] }], writes: [{ range, values: [['x', 'y', 'z']] }] }), 3);
  assert.match(t.output(), /AB3.*changed/);

  const ok = setup({ cells: { ...baseCells(), [range]: [['a', 'b', 'c']] } });
  assert.equal(ok.run({ expected: [{ range, values: [['a', 'b', 'c']] }], writes: [{ range, values: [['x', 'y', 'z']] }] }), 0);
  const dir = join(ok.root, 'data', 'sheet-backups', ok.backups()[0]);
  assert.equal(existsSync(join(dir, 'AcmeApp evidence.json')), true);
  assert.equal(existsSync(join(dir, 'Dealerships.json')), false);
});

test('a request that names no tab backs up every tab', () => {
  const t = setup();
  const e = {
    expected: [{ range: ROW, values: [['Acme', 'Lead']] }],
    requests: [{ findReplace: { find: 'a', replacement: 'b', allSheets: true } }],
    verify: [{ range: ROW, values: [['Acme', 'Lead']] }],
  };
  assert.equal(t.run(e), 0);
  const dir = join(t.root, 'data', 'sheet-backups', t.backups()[0]);
  assert.equal(existsSync(join(dir, 'AcmeApp evidence.json')), true);
});

for (const [name, bad, why] of [
  ['no expected rows', edit({ expected: [] }), /expected/],
  ['nothing to do', { expected: edit().expected }, /writes or requests/],
  ['a typo in a key', edit({ request: [] }), /request/],
  ['requests with no verify list', edit({ requests: [{ addDimensionGroup: {} }] }), /verify/],
  ['deleting a tab', edit({ requests: [{ deleteSheet: { sheetId: 10 } }], verify: edit().expected }), /deleteSheet/],
  ['an open range', edit({ expected: [{ range: 'Dealerships!A:C', values: [] }] }), /A:C/],
  ['a range with no tab', edit({ expected: [{ range: 'A5:C5', values: [] }] }), /A5:C5/],
  ['a write outside the expected rows', edit({ writes: [{ range: 'Dealerships!A6:A6', values: [['x']] }] }), /A6:A6.*expected/],
  ['a write smaller than its range', edit({ writes: [{ range: ROW, values: [['x']] }] }), /exactly/],
  ['an unknown input option', edit({ writes: [{ range: ROW, values: [['a', 'b', 'c']], inputOption: 'FANCY' }] }), /FANCY/],
  ['expected values wider than the range', edit({ expected: [{ range: ROW, values: [['a', 'b', 'c', 'd']] }] }), /fit/],
  ['null in expected values', edit({ expected: [{ range: ROW, values: [[null]] }] }), /null|cell/],
] as const) {
  test(`refuses ${name} before calling gws`, () => {
    const t = setup();
    assert.equal(t.run(bad), 2);
    assert.match(t.output(), why);
    assert.equal(t.calls().length, 0);
  });
}

test('refuses unreadable JSON, a missing file, and a tab the sheet does not have', () => {
  const a = setup();
  assert.equal(a.run('{not json'), 2);
  assert.equal(run([], { log: () => {} }), 2);
  assert.equal(run(['/nonexistent/edit.json'], { log: () => {} }), 2);
  assert.equal(run(['x.json', '--bogus'], { log: () => {} }), 2);

  const b = setup({ cells: { ...baseCells(), 'Nope!A1:A1': [['x']] } });
  const e = { expected: [{ range: 'Nope!A1:A1', values: [['x']] }], writes: [{ range: 'Nope!A1:A1', values: [['y']] }] };
  assert.equal(b.run(e), 2);
  assert.match(b.output(), /Nope/);
  assert.equal(b.writes().length, 0);
});
