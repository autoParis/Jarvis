// The one sanctioned way to write to the Marketplace migration sheet. bin/sheet-edit is the entry point;
// docs/sheet-edit.md has the edit file format. The sheet id and gws path are constants, with no flag or
// environment override, so an allow rule on the command covers this sheet and nothing else.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';

// The one sheet sheet-edit may write to. bin/setup writes JARVIS_MIGRATION_SHEET_ID to .env.
export const SHEET_ID = process.env.JARVIS_MIGRATION_SHEET_ID?.trim() || 'EXAMPLE_SHEET_ID';
const GWS_BIN = '/opt/homebrew/bin/gws';
const ROOT = join(dirname(import.meta.filename), '..');
const USAGE = 'usage: sheet-edit <edit.json> [--dry-run] [--sheet-id <id>]';
const EXIT = { ok: 0, failed: 1, refused: 2, preflight: 3 };
// A deleted tab takes its formatting and history links with it, and no values backup restores those.
const REFUSED_REQUESTS = new Set(['deleteSheet']);

type Cell = string | number | boolean | null;
type Grid = Cell[][];
type Check = { range: string; values: Grid };
type Write = Check & { inputOption?: 'RAW' | 'USER_ENTERED'; expect?: Grid };
type Edit = { spreadsheetId?: string; description?: string; expected: Check[]; writes?: Write[]; requests?: object[]; verify?: Check[] };
type Range = { tab: string; col1: number; row1: number; col2: number; row2: number };
type Diff = { range: string; cell: string; expected: string; actual: string };
type Deps = { gwsBin?: string; root?: string; now?: () => Date; log?: (line: string) => void };

class Refused extends Error {}

function colNumber(col: string): number {
  return [...col].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);
}

function colName(n: number): string {
  let s = '';
  for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + (n - 1) % 26) + s;
  return s;
}

// Closed A1 ranges with a tab only: an open range could reach rows nobody declared.
function parseRange(range: unknown): Range {
  const m = typeof range === 'string' ? /^(?:'((?:[^']|'')+)'|([^'!]+))!([A-Z]+)([1-9]\d*)(?::([A-Z]+)([1-9]\d*))?$/.exec(range) : null;
  if (!m) throw new Refused(`bad range ${JSON.stringify(range)}: use a tab and closed cells, like Dealerships!A5:C5`);
  const r = {
    tab: m[1] ? m[1].replace(/''/g, "'") : m[2],
    col1: colNumber(m[3]), row1: Number(m[4]),
    col2: colNumber(m[5] ?? m[3]), row2: Number(m[6] ?? m[4]),
  };
  if (r.col2 < r.col1 || r.row2 < r.row1) throw new Refused(`bad range ${range}: the end comes before the start`);
  return r;
}

function checkGrid(values: unknown, range: string, allowNull: boolean): asserts values is Grid {
  const scalar = (c: unknown) => ['string', 'number', 'boolean'].includes(typeof c) || (allowNull && c === null);
  if (!Array.isArray(values) || !values.every(row => Array.isArray(row) && row.every(scalar))) {
    throw new Refused(`values for ${range} must be rows of text, number or boolean cells${allowNull ? ' (null leaves a cell alone)' : ' (no null)'}`);
  }
}

function checkFits(values: Grid, range: string): void {
  const r = parseRange(range);
  if (values.length > r.row2 - r.row1 + 1 || values.some(row => row.length > r.col2 - r.col1 + 1)) {
    throw new Refused(`values do not fit in ${range}`);
  }
}

function within(inner: Range, outer: Range): boolean {
  return inner.tab === outer.tab && inner.col1 >= outer.col1 && inner.col2 <= outer.col2 && inner.row1 >= outer.row1 && inner.row2 <= outer.row2;
}

// Every refusal here happens before the first gws call.
function validate(edit: unknown): Edit {
  if (typeof edit !== 'object' || edit === null || Array.isArray(edit)) throw new Refused('the edit file must hold a JSON object');
  const unknown = Object.keys(edit).filter(k => !['spreadsheetId', 'description', 'expected', 'writes', 'requests', 'verify'].includes(k));
  if (unknown.length) throw new Refused(`unknown key in the edit file: ${unknown.join(', ')}`);
  const e = edit as Edit;
  if (e.spreadsheetId !== undefined) checkSheetId(e.spreadsheetId);
  if (!Array.isArray(e.expected) || !e.expected.length) throw new Refused('expected must list the current values of the target rows');
  const writes = e.writes ?? [], requests = e.requests ?? [], verify = e.verify ?? [];
  if (!Array.isArray(writes) || !Array.isArray(requests) || !Array.isArray(verify)) throw new Refused('writes, requests and verify must be lists');
  if (!writes.length && !requests.length) throw new Refused('the edit needs writes or requests');
  if (requests.length && !verify.length) throw new Refused('requests need a verify list: the rows and values to read back afterwards');

  for (const c of [...e.expected, ...verify]) {
    parseRange(c.range);
    checkGrid(c.values, c.range, false);
    checkFits(c.values, c.range);
  }
  for (const w of writes) {
    const r = parseRange(w.range);
    checkGrid(w.values, w.range, true);
    if (w.values.length !== r.row2 - r.row1 + 1 || w.values.some(row => row.length !== r.col2 - r.col1 + 1)) {
      throw new Refused(`new values must fill ${w.range} exactly`);
    }
    if (w.inputOption !== undefined && w.inputOption !== 'RAW' && w.inputOption !== 'USER_ENTERED') {
      throw new Refused(`bad inputOption ${w.inputOption} on ${w.range}: use RAW or USER_ENTERED`);
    }
    if (w.expect !== undefined) {
      checkGrid(w.expect, w.range, false);
      checkFits(w.expect, w.range);
    }
    // Requests can shift rows, so coordinates are only comparable when there are none.
    if (!requests.length && !e.expected.some(c => within(r, parseRange(c.range)))) {
      throw new Refused(`write ${w.range} is outside every expected range: state its current values first`);
    }
  }
  for (const q of requests) {
    if (typeof q !== 'object' || q === null) throw new Refused('each request must be a batchUpdate request object');
    const bad = Object.keys(q).filter(k => REFUSED_REQUESTS.has(k));
    if (bad.length) throw new Refused(`request type not allowed: ${bad.join(', ')}`);
  }
  return e;
}

function checkSheetId(id: unknown): void {
  if (id !== SHEET_ID) throw new Refused(`refused: ${id} is not the migration sheet. sheet-edit only writes to ${SHEET_ID}`);
}

const text = (c: Cell | undefined) => (c === undefined || c === null ? '' : String(c));

// Compares cell by cell. Google drops trailing blanks, so a missing cell equals "". A null wanted cell is skipped.
function diffGrid(range: string, wanted: Grid, actual: Grid): Diff[] {
  const r = parseRange(range);
  const diffs: Diff[] = [];
  for (let y = 0; y < Math.max(wanted.length, actual.length); y++) {
    for (let x = 0; x < Math.max(wanted[y]?.length ?? 0, actual[y]?.length ?? 0); x++) {
      if (wanted[y]?.[x] === null) continue;
      const [w, a] = [text(wanted[y]?.[x]), text(actual[y]?.[x])];
      if (w !== a) diffs.push({ range, cell: `${colName(r.col1 + x)}${r.row1 + y}`, expected: w, actual: a });
    }
  }
  return diffs;
}

function client(bin: string) {
  const call = (args: string[], params: object = {}, body?: object) => {
    const argv = ['sheets', 'spreadsheets', ...args, '--params', JSON.stringify({ ...params, spreadsheetId: SHEET_ID })];
    if (body) argv.push('--json', JSON.stringify(body));
    try {
      const out = execFileSync(bin, argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 512 * 1024 * 1024 });
      const parsed = JSON.parse(out || '{}');
      if (parsed.error) throw new Error(JSON.stringify(parsed.error));
      return parsed;
    } catch (err) {
      const e = err as Error & { stderr?: string; stdout?: string };
      throw new Error(`gws ${args.join(' ')} failed: ${[e.stdout, e.stderr].filter(Boolean).join(' ').trim() || e.message}`, { cause: err });
    }
  };
  return {
    read: (range: string): Grid => call(['values', 'get'], { range, valueRenderOption: 'FORMULA' }).values ?? [],
    // Whole-sheet metadata, so a backup can restore row groups, merges and colour rules along with the values.
    sheets: () => call(['get'], { fields: 'sheets(properties,rowGroups,columnGroups,merges,conditionalFormats)' }).sheets ?? [],
    requests: (requests: object[]) => call(['batchUpdate'], {}, { requests }),
    write: (data: Check[], valueInputOption: string) => call(['values', 'batchUpdate'], {}, { valueInputOption, data }),
  };
}
type Client = ReturnType<typeof client>;

function preflight(gws: Client, expected: Check[]): Diff[] {
  return expected.flatMap(c => diffGrid(c.range, c.values, gws.read(c.range)));
}

function sheetIdsIn(value: unknown): number[] {
  if (Array.isArray(value)) return value.flatMap(sheetIdsIn);
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([k, v]) => (k === 'sheetId' && typeof v === 'number' ? [v] : sheetIdsIn(v)));
}

type SheetMeta = { properties: { sheetId: number; title: string } };

// The tabs named by a range, plus the ones requests touch. A request naming no tab (findReplace with
// allSheets, say) could reach any of them, so it backs up all.
function affectedTabs(edit: Edit, all: SheetMeta[]): SheetMeta[] {
  const ranges = [...edit.expected, ...(edit.writes ?? []), ...(edit.verify ?? [])].map(c => parseRange(c.range).tab);
  const missing = ranges.filter(t => !all.some(s => s.properties.title === t));
  if (missing.length) throw new Refused(`the sheet has no tab named ${[...new Set(missing)].join(', ')}`);
  const requests = edit.requests ?? [];
  if (requests.some(q => !sheetIdsIn(q).some(id => all.some(s => s.properties.sheetId === id)))) return all;
  const ids = requests.flatMap(sheetIdsIn);
  return all.filter(s => ranges.includes(s.properties.title) || ids.includes(s.properties.sheetId));
}

function backup(gws: Client, edit: Edit, dir: string, takenAt: string): string[] {
  const tabs = affectedTabs(edit, gws.sheets());
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'edit.json'), JSON.stringify(edit, null, 2));
  for (const sheet of tabs) {
    const tab = sheet.properties.title;
    const range = `'${tab.replace(/'/g, "''")}'`;
    const data = { spreadsheetId: SHEET_ID, tab, takenAt, valueRenderOption: 'FORMULA', sheet, values: gws.read(range) };
    writeFileSync(join(dir, `${tab.replace(/[/\\:]/g, '_')}.json`), JSON.stringify(data, null, 2), { flag: 'wx' });
  }
  return tabs.map(s => s.properties.title);
}

function apply(gws: Client, edit: Edit): void {
  if (edit.requests?.length) gws.requests(edit.requests);
  for (const mode of ['RAW', 'USER_ENTERED']) {
    const data = (edit.writes ?? []).filter(w => (w.inputOption ?? 'RAW') === mode).map(w => ({ range: w.range, values: w.values }));
    if (data.length) gws.write(data, mode);
  }
}

function readBack(gws: Client, edit: Edit): Diff[] {
  const checks = [
    ...(edit.writes ?? []).map(w => ({ range: w.range, values: w.expect ?? w.values })),
    ...(edit.verify ?? []),
  ];
  return checks.flatMap(c => diffGrid(c.range, c.values, gws.read(c.range)));
}

export function run(argv: string[], deps: Deps = {}): number {
  const log = deps.log ?? console.log;
  const now = deps.now ?? (() => new Date());
  const printDiffs = (diffs: Diff[]) => {
    for (const d of diffs) log(`  ${d.range} ${d.cell}: expected ${JSON.stringify(d.expected)}, actual ${JSON.stringify(d.actual)}`);
  };
  let dir: string | undefined;
  let wrote = false;
  const record = (outcome: string, extra: object = {}) => {
    if (dir) writeFileSync(join(dir, 'result.json'), JSON.stringify({ outcome, finishedAt: now().toISOString(), ...extra }, null, 2));
  };

  try {
    let parsed;
    try {
      parsed = parseArgs({ args: argv, allowPositionals: true, options: { 'dry-run': { type: 'boolean' }, 'sheet-id': { type: 'string' } } });
    } catch (err) {
      throw new Refused(`${(err as Error).message}\n${USAGE}`);
    }
    if (parsed.positionals.length !== 1) throw new Refused(USAGE);
    if (parsed.values['sheet-id'] !== undefined) checkSheetId(parsed.values['sheet-id']);

    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(parsed.positionals[0], 'utf8'));
    } catch (err) {
      throw new Refused(`cannot read the edit file: ${(err as Error).message}`);
    }
    const edit = validate(raw);
    const gws = client(deps.gwsBin ?? GWS_BIN);

    const changed = preflight(gws, edit.expected);
    if (changed.length) {
      log('Preflight failed: the target rows differ from the edit file. Nothing written.');
      printDiffs(changed);
      return EXIT.preflight;
    }
    log(`Preflight ok: ${edit.expected.length} range(s) match.`);

    if (parsed.values['dry-run']) {
      affectedTabs(edit, gws.sheets());
      for (const q of edit.requests ?? []) log(`Would run request: ${Object.keys(q).join(', ')}`);
      for (const w of edit.writes ?? []) {
        log(`Would write ${w.range} (${w.inputOption ?? 'RAW'}):`);
        // Requests may shift rows, so the current cells at these coordinates mean nothing to compare against.
        if (edit.requests?.length) log(`  ${JSON.stringify(w.values)}`);
        else for (const d of diffGrid(w.range, w.values, gws.read(w.range))) log(`  ${d.cell}: ${JSON.stringify(d.actual)} -> ${JSON.stringify(d.expected)}`);
      }
      log('Dry run: nothing written, no backup taken.');
      return EXIT.ok;
    }

    const takenAt = now().toISOString();
    const pending = join(deps.root ?? ROOT, 'data', 'sheet-backups', takenAt.replace(/[:.]/g, '-'));
    const tabs = backup(gws, edit, pending, takenAt);
    dir = pending;
    log(`Backup of ${tabs.join(', ')}: ${dir}`);

    // The backup takes seconds on large tabs, so check again right before writing.
    const changedSince = preflight(gws, edit.expected);
    if (changedSince.length) {
      log('Preflight failed: the target rows changed during the backup. Nothing written.');
      printDiffs(changedSince);
      record('aborted', { diffs: changedSince });
      return EXIT.preflight;
    }

    wrote = true;
    apply(gws, edit);

    const diffs = readBack(gws, edit);
    record(diffs.length ? 'mismatch' : 'verified', { diffs });
    if (diffs.length) {
      log(`Read-back mismatch, expected against actual. The sheet may be partly edited. Backup: ${dir}`);
      printDiffs(diffs);
      return EXIT.failed;
    }
    log('Read-back: no differences.');
    return EXIT.ok;
  } catch (err) {
    const message = (err as Error).message;
    if (err instanceof Refused) {
      log(message);
      return EXIT.refused;
    }
    log(`Failed: ${message}`);
    if (wrote) log(`The sheet may be partly edited. Backup: ${dir}`);
    record(wrote ? 'write_failed' : 'failed', { error: message });
    return EXIT.failed;
  }
}
