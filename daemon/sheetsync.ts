// The daily sync from the Migration list (migration.ts, data/jarvis.db) to the Marketplace migration sheet.
// Part of the temporary migration pieces listed in docs/migration/README.md. Rules:
// - It writes only through bin/sheet-edit, with an `expected` value for every cell it changes, so a cell edited
//   after the read aborts the write (sheet-edit exit 3) and nothing is written.
// - Each lead is a person sub-line keyed `<dealership key>/<folded name>`: Dealerships column AB, Overview column M.
//   The sync owns five cells of that person: the name (Dealerships B, Overview A), the stage (Overview C, the dropdown
//   Dealerships C reads), the meeting time in Eastern (Dealerships G), the contact channel (Dealerships I) and the note (Dealerships V).
// - A baseline file keeps, for each owned cell, the lead value and the sheet value of the last sync. A cell whose sheet
//   value moved since then is the owner's edit: it is kept, and reported as a conflict when the lead changed too.
// - A new lead adds a Dealerships sub-line and an Overview child row at the end of its dealership's block, and joins the
//   block's row group. The counts (Dealerships AD, Overview B) are formulas that count the keys, so they follow.
// - It never deletes a row, never writes a password or token, and never writes for a dealership missing from the sheet.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { fold, SOURCE_WORDS, type Status } from './migration.ts';

export type Cell = string | number | boolean;
export type Grid = Cell[][];
export type Lead = {
  uid: string; name: string; dealership: string; dealerKey: string | null; onSheet: boolean;
  status: Status; meetingAt: string | null; note: string; source: string; removed: boolean;
};
type Group = { range: { sheetId: number; dimension: string; startIndex: number; endIndex: number }; depth: number; collapsed?: boolean };
export type SheetMeta = { properties: { sheetId: number; title: string }; rowGroups?: Group[] };
export type Field = 'name' | 'stage' | 'meeting' | 'contact' | 'note';
export type Baseline = { keys: Record<string, string>; cells: Record<string, { lead: string; sheet: string }> };
type Write = { range: string; values: (Cell | null)[][]; inputOption?: 'RAW' | 'USER_ENTERED' };
type Check = { range: string; values: Grid };
export type EditFile = { description: string; expected: Check[]; writes: Write[]; requests?: object[]; verify?: Check[] };
/** One line of the report. `cell` is the A1 cell after the rows are inserted, the one sheet-edit writes. */
export type Item = { person: string; dealership: string; field?: Field | 'row'; cell?: string; from?: string; to?: string; why: string };
export type Plan = {
  edit?: EditFile;
  /** The rows each new person gets, after the inserts, for the row-group step. */
  inserted: { tab: 'Dealerships' | 'Overview'; dealerKey: string; at: number; n: number; keys: string[] }[];
  writes: Item[]; added: Item[]; conflicts: Item[]; kept: Item[]; skipped: Item[];
  /** "X of Y migrated" before and after, for each dealership the edit touches. The sheet's formulas compute the real ones. */
  counts: { dealership: string; before: string; after: string }[];
  /** The baseline to save once the edit is verified. */
  baseline: Baseline;
};

const D = { tab: 'Dealerships', A: 0, B: 1, C: 2, D: 3, G: 6, I: 8, V: 21, AB: 27, AC: 28 } as const;
const O = { tab: 'Overview', A: 0, B: 1, C: 2, M: 12 } as const;
/** The lead status as a name of the Overview stage dropdown (strict list of 13). */
export const STAGE: Record<Status, string> = { todo: 'Not contacted', contacted: 'Contacted', meeting: 'Appointment booked', migrated: 'Migrated' };
const INDENT = '    ';
// A note that names a password, a token or a key never goes to the sheet. The handoff forbids it, so the cell is skipped.
const SECRET = /pass(word|wd|e)?\b|mot de passe|\bmdp\b|token|api[ _-]?key|secret|bearer\s|\bsk-[a-z0-9]{8,}|\bgh[pousr]_[a-z0-9]{10,}/i;
const ZONE = 'America/Toronto';

export function colName(n: number): string {
  let s = '';
  for (n += 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + (n - 1) % 26) + s;
  return s;
}
const a1 = (tab: string, col: number, row1: number) => `${tab}!${colName(col)}${row1}`;
const text = (c: Cell | null | undefined) => (c === undefined || c === null ? '' : String(c));
const at = (g: Grid, r: number, c: number) => text(g[r]?.[c]);

/** The meeting time in Eastern, as the sheet's people rows write it: "2026-11-11 10:00 AM Eastern". */
export function easternTime(iso: string): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: 'numeric', minute: '2-digit', hour12: true })
    .formatToParts(new Date(iso)).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} ${p.dayPeriod} Eastern`;
}
export const personKey = (dealerKey: string, name: string) => `${dealerKey}/${fold(name)}`;

function wanted(l: Lead): Record<Field, string> {
  return {
    name: INDENT + l.name,
    stage: STAGE[l.status],
    meeting: l.status === 'meeting' && l.meetingAt ? easternTime(l.meetingAt) : '',
    // Column I holds "Contact names (verify)": the person's name, then how the list reached them.
    contact: `${l.name} (${(SOURCE_WORDS[l.source] ?? l.source).toLowerCase()})`,
    note: l.note,
  };
}
/**
 * The sheet already says it: the same text, any "Migrated..." stage for Migrated, the name with other indentation, or a
 * contact cell that starts with the person's name (the sheet's people rows hold the name there, sometimes with an email).
 */
function same(field: Field, sheet: string, want: string, name: string): boolean {
  if (field === 'stage' && want === STAGE.migrated) return sheet.startsWith('Migrated');
  if (field === 'contact' && sheet !== '') return fold(sheet).startsWith(fold(name));
  return sheet.trim() === want.trim();
}

type Spot = { tab: 'Dealerships' | 'Overview'; col: number };
const SPOT: Record<Field, Spot> = {
  name: { tab: 'Dealerships', col: D.B }, stage: { tab: 'Overview', col: O.C }, meeting: { tab: 'Dealerships', col: D.G },
  contact: { tab: 'Dealerships', col: D.I }, note: { tab: 'Dealerships', col: D.V },
};
// The Overview name is a second copy of the name. It follows the Dealerships name and is not compared on its own.
const OVERVIEW_NAME: Spot = { tab: 'Overview', col: O.A };

/** The rows of one dealership: its own row, and the row index where a new person goes (0-based, the end of its block). */
function dealershipRows(dRows: Grid, oRows: Grid, key: string) {
  const dRow = dRows.findIndex(r => text(r[D.AB]) === key);
  const oRow = oRows.findIndex(r => text(r[O.M]) === key);
  if (dRow < 0 || oRow < 0) return undefined;
  let dEnd = dRow + 1;
  while (text(dRows[dEnd]?.[D.AB]).startsWith(`${key}/`)) dEnd++;
  // An Overview block runs to the next dealership row: a row whose key has no slash.
  let oEnd = oRow + 1;
  const isDealer = (r: Cell[] | undefined) => { const m = text(r?.[O.M]); return m !== '' && !m.includes('/'); };
  while (oEnd < oRows.length && !isDealer(oRows[oEnd])) oEnd++;
  // Trailing blank rows at the very end are not part of the last block.
  while (oEnd > oRow + 1 && oRows[oEnd - 1].every(c => text(c) === '')) oEnd--;
  return { dRow, dEnd, oRow, oEnd };
}

/**
 * The edit for one run, computed from the leads, both tabs read with the FORMULA render option, and the last baseline.
 * Pure: it reads and writes nothing. `sheetIds` are the tab ids the insert requests name.
 */
export function plan(leads: Lead[], dRows: Grid, oRows: Grid, base: Baseline, sheetIds: { Dealerships: number; Overview: number }, sheetUrl: string): Plan {
  const p: Plan = { inserted: [], writes: [], added: [], conflicts: [], kept: [], skipped: [], counts: [], baseline: { keys: { ...base.keys }, cells: { ...base.cells } } };
  // The stage each touched person has after the edit, by person key, and the dealership name of each touched dealership key.
  const stageAfter = new Map<string, string>(), touched = new Map<string, string>();
  const expected: Check[] = [], writes: (Write & { tab: 'Dealerships' | 'Overview'; row0: number; col: number })[] = [];
  const verify: Check[] = [];
  // New rows per dealership block and tab, in original coordinates: at = the 0-based index the rows go in at.
  const inserts: { tab: 'Dealerships' | 'Overview'; at: number; dealerKey: string; rows: { lead: Lead; key: string }[] }[] = [];
  const insertAt = (tab: 'Dealerships' | 'Overview', idx: number, dealerKey: string, lead: Lead, key: string) => {
    let ins = inserts.find(i => i.tab === tab && i.at === idx);
    if (!ins) inserts.push(ins = { tab, at: idx, dealerKey, rows: [] });
    ins.rows.push({ lead, key });
  };

  const live = leads.filter(l => !l.removed);
  for (const l of leads.filter(l => l.removed)) {
    if (!live.some(o => o.uid !== l.uid && o.dealerKey === l.dealerKey && fold(o.name) === fold(l.name))) {
      p.skipped.push({ person: l.name, dealership: l.dealership, why: 'removed from the list; the sheet row, if any, stays' });
    }
  }
  const keyOf = (l: Lead) => base.keys[l.uid] ?? (l.dealerKey ? personKey(l.dealerKey, l.name) : '');
  const byKey = new Map<string, Lead[]>();
  for (const l of live) byKey.set(keyOf(l), [...(byKey.get(keyOf(l)) ?? []), l]);

  for (const l of live) {
    const who = { person: l.name, dealership: l.dealership };
    if (!l.dealerKey || !l.onSheet) { p.skipped.push({ ...who, why: 'the dealership is not on the sheet' }); continue; }
    const key = keyOf(l);
    if ((byKey.get(key) ?? []).length > 1) { p.skipped.push({ ...who, why: `two leads share the key ${key}` }); continue; }
    const rows = dealershipRows(dRows, oRows, l.dealerKey);
    if (!rows) { p.skipped.push({ ...who, why: `no dealership row with key ${l.dealerKey} on both tabs` }); continue; }
    const want = wanted(l);
    const secret = SECRET.test(l.note);
    if (secret) p.skipped.push({ ...who, field: 'note', why: 'the note looks like it names a password or token, so it is not copied' });
    p.baseline.keys[l.uid] = key;

    const dIdx = dRows.findIndex(r => text(r[D.AB]) === key);
    const oIdx = oRows.findIndex(r => text(r[O.M]) === key);
    const rowOf = (tab: 'Dealerships' | 'Overview') => tab === 'Dealerships' ? dIdx : oIdx;
    if (dIdx < 0) insertAt('Dealerships', rows.dEnd, l.dealerKey, l, key);
    if (oIdx < 0) { insertAt('Overview', rows.oEnd, l.dealerKey, l, key); stageAfter.set(key, want.stage); touched.set(l.dealerKey, l.dealership); }
    if (dIdx < 0 || oIdx < 0) p.added.push({ ...who, field: 'row', why: `new sub-line ${key} on ${[dIdx < 0 && 'Dealerships', oIdx < 0 && 'Overview'].filter(Boolean).join(' and ')}` });

    for (const field of Object.keys(want) as Field[]) {
      const spot = SPOT[field];
      const idx = rowOf(spot.tab);
      if (idx < 0) continue; // a new row gets every cell below, with the insert
      const cellId = `${l.uid}:${field}`;
      const st = base.cells[cellId];
      const sheet = at(spot.tab === 'Dealerships' ? dRows : oRows, idx, spot.col).trim();
      const lead = want[field].trim();
      const item = { ...who, field, cell: '', from: sheet, to: lead };
      if (field === 'note' && secret) continue;
      if (same(field, sheet, lead, l.name)) { p.baseline.cells[cellId] = { lead, sheet }; continue; }
      const doWrite = () => {
        writes.push({ tab: spot.tab, row0: idx, col: spot.col, range: '', values: [[want[field]]] });
        expected.push({ range: a1(spot.tab, spot.col, idx + 1), values: [[at(spot.tab === 'Dealerships' ? dRows : oRows, idx, spot.col)]] });
        p.writes.push({ ...item, cell: `${spot.tab}:${spot.col}:${idx}`, why: st ? 'the lead changed' : 'the cell was empty' });
        p.baseline.cells[cellId] = { lead, sheet: lead };
        if (field === 'stage') { stageAfter.set(key, lead); touched.set(l.dealerKey!, l.dealership); }
        if (field === 'name' && oIdx >= 0) {
          writes.push({ tab: 'Overview', row0: oIdx, col: OVERVIEW_NAME.col, range: '', values: [[want.name]] });
          expected.push({ range: a1('Overview', O.A, oIdx + 1), values: [[at(oRows, oIdx, O.A)]] });
        }
      };
      if (!st) {
        if (sheet === '') doWrite();
        else if (lead === '') p.baseline.cells[cellId] = { lead, sheet };
        else {
          // First sync with two different values: the sheet wins. A stage is worth the owner's look, the rest is his own text.
          (field === 'stage' ? p.conflicts : p.kept).push({ ...item, why: field === 'stage' ? 'first sync: the sheet and the list differ, the sheet is kept' : 'first sync: the sheet has its own text, kept' });
          p.baseline.cells[cellId] = { lead, sheet };
        }
        continue;
      }
      const leadChanged = lead !== st.lead, sheetChanged = sheet !== st.sheet;
      if (!leadChanged) {
        if (sheetChanged) p.kept.push({ ...item, why: 'changed on the sheet by hand since the last sync, kept' });
        p.baseline.cells[cellId] = { lead, sheet };
      } else if (!sheetChanged) doWrite();
      // Both moved: the owner's edit stays, and the baseline stays too, so the conflict shows again until one side gives.
      else p.conflicts.push({ ...item, why: 'the lead changed and the sheet cell was changed by hand since the last sync, the sheet is kept' });
    }
  }

  // The same count the Overview B and Dealerships AD formulas make: person keys under the dealership, stages starting "Migrated".
  for (const [dk, name] of touched) {
    const stages = new Map(oRows.filter(r => text(r[O.M]).startsWith(`${dk}/`)).map(r => [text(r[O.M]), text(r[O.C])]));
    const count = (m: Map<string, string>) => m.size ? `${[...m.values()].filter(s => s.startsWith('Migrated')).length} of ${m.size} migrated` : 'no people';
    const before = count(stages);
    for (const [k, s] of stageAfter) if (k.startsWith(`${dk}/`)) stages.set(k, s);
    p.counts.push({ dealership: name, before, after: count(stages) });
  }

  // Final coordinates: an original 0-based row moves down by every row inserted at or above it.
  const shift = (tab: string, row0: number) => inserts.filter(i => i.tab === tab && i.at <= row0).reduce((n, i) => n + i.rows.length, 0);
  const finalRow1 = (tab: string, row0: number) => row0 + shift(tab, row0) + 1;
  for (const w of writes) w.range = a1(w.tab, w.col, finalRow1(w.tab, w.row0));
  // Until here p.writes holds "<tab>:<col>:<row0>"; give each its final A1 cell.
  for (const item of p.writes) {
    const [tab, col, row0] = item.cell!.split(':');
    item.cell = a1(tab, Number(col), finalRow1(tab, Number(row0)));
  }

  const requests: object[] = [];
  const newWrites: Write[] = [];
  for (const ins of inserts) {
    const tab = ins.tab, rows = tab === 'Dealerships' ? dRows : oRows;
    const before = inserts.filter(i => i.tab === tab && i.at < ins.at).reduce((n, i) => n + i.rows.length, 0);
    const start0 = ins.at + before; // first new row, 0-based, after every insert
    p.inserted.push({ tab, dealerKey: ins.dealerKey, at: start0, n: ins.rows.length, keys: ins.rows.map(r => r.key) });
    // The rows around the insert point must still be where the read saw them.
    const keyCol = tab === 'Dealerships' ? D.AB : O.M;
    expected.push({ range: a1(tab, keyCol, ins.at), values: [[at(rows, ins.at - 1, keyCol)]] });
    if (ins.at < rows.length) expected.push({ range: a1(tab, keyCol, ins.at + 1), values: [[at(rows, ins.at, keyCol)]] });
    const dealerRow0 = rows.findIndex(r => text(r[keyCol]) === ins.dealerKey);
    verify.push({ range: a1(tab, keyCol, finalRow1(tab, dealerRow0)), values: [[ins.dealerKey]] });
    ins.rows.forEach(({ lead, key }, k) => {
      const r = start0 + k + 1, want = wanted(lead), secret = SECRET.test(lead.note);
      const raw = (col: number, v: string) => newWrites.push({ range: a1(tab, col, r), values: [[v]] });
      const formula = (col: number, v: string) => newWrites.push({ range: a1(tab, col, r), values: [[v]], inputOption: 'USER_ENTERED' });
      const item = { person: lead.name, dealership: lead.dealership };
      if (tab === 'Dealerships') {
        const dealerRow = dRows[dealerRow0];
        raw(D.A, text(dealerRow[D.A]));
        raw(D.B, want.name);
        formula(D.C, `=IFERROR(INDEX(Overview!$C:$C,MATCH($AB${r},Overview!$M:$M,0)),"Not on Overview")`);
        raw(D.D, text(dealerRow[D.D]));
        if (want.meeting) raw(D.G, want.meeting);
        raw(D.I, want.contact);
        if (want.note && !secret) raw(D.V, want.note);
        raw(D.AB, key);
        formula(D.AC, `=IF(F${r}="","Set next action date",IF(F${r}<TODAY(),"Overdue","Scheduled"))`);
        for (const f of ['name', 'meeting', 'contact', 'note'] as Field[]) {
          if (f === 'note' && secret) continue;
          p.baseline.cells[`${lead.uid}:${f}`] = { lead: want[f].trim(), sheet: want[f].trim() };
          if (want[f]) p.writes.push({ ...item, field: f, cell: a1(tab, SPOT[f].col, r), from: '', to: want[f].trim(), why: 'new sub-line' });
        }
      } else {
        // The person columns of an Overview child row, as on the other EvalAuto person rows (handoff, "To add a person later").
        const look = (col: string) => `=IF(INDEX(Dealerships!$${col}:$${col},MATCH($M${r},Dealerships!$AB:$AB,0))="","",INDEX(Dealerships!$${col}:$${col},MATCH($M${r},Dealerships!$AB:$AB,0)))`;
        raw(O.A, want.name);
        raw(O.B, 'Lead · Jarvis list');
        raw(O.C, want.stage);
        formula(5, look('I'));
        formula(6, look('E'));
        formula(7, look('F'));
        formula(8, look('G'));
        formula(10, look('P'));
        formula(11, `=HYPERLINK("${sheetUrl}#gid=${sheetIds.Dealerships}&range=A"&MATCH($M${r},Dealerships!$AB:$AB,0),"Open source")`);
        raw(O.M, key);
        formula(13, `=IF($D${r}<>"",$D${r},N${r - 1})`);
        p.baseline.cells[`${lead.uid}:stage`] = { lead: want.stage, sheet: want.stage };
        p.writes.push({ ...item, field: 'stage', cell: a1(tab, O.C, r), from: '', to: want.stage, why: 'new sub-line' });
      }
    });
  }
  // Highest insert first, so each request's index is still an original one when it runs.
  for (const ins of [...inserts].sort((x, y) => y.at - x.at || x.tab.localeCompare(y.tab))) {
    requests.push({ insertDimension: { range: { sheetId: sheetIds[ins.tab], dimension: 'ROWS', startIndex: ins.at, endIndex: ins.at + ins.rows.length }, inheritFromBefore: true } });
  }

  const allWrites: Write[] = [...writes.map(({ range, values }) => ({ range, values })), ...newWrites];
  if (!allWrites.length) return p;
  // sheet-edit refuses an edit with no expected range. Writes with no insert are each covered by their own expected cell.
  p.edit = {
    description: `Migration list sync: ${p.added.length} new person row(s), ${p.writes.length} cell(s)`,
    expected,
    writes: allWrites,
    ...(requests.length ? { requests, verify } : {}),
  };
  return p;
}

/**
 * The second edit: the new rows join their dealership's row group. It is computed from the groups as they are after the
 * insert, because whether an insert widens a group is Google's choice. A group that ends right above the new rows is
 * replaced by one that also covers them, with its collapsed state kept. Undefined when every new row is already grouped.
 */
export function groupEdit(inserted: Plan['inserted'], meta: SheetMeta[], keysAt: (tab: string, row1: number) => string): EditFile | undefined {
  const requests: object[] = [], expected: Check[] = [];
  for (const ins of [...inserted].sort((x, y) => y.at - x.at)) {
    const sheet = meta.find(s => s.properties.title === ins.tab);
    if (!sheet) continue;
    const id = sheet.properties.sheetId, start = ins.at, end = ins.at + ins.n;
    const groups = (sheet.rowGroups ?? []).filter(g => g.depth === 1);
    const keyCol = ins.tab === 'Dealerships' ? D.AB : O.M;
    for (let k = 0; k < ins.n; k++) expected.push({ range: a1(ins.tab, keyCol, start + k + 1), values: [[keysAt(ins.tab, start + k + 1)]] });
    if (groups.some(g => g.range.startIndex <= start && g.range.endIndex >= end)) continue;
    const above = groups.find(g => g.range.endIndex === start);
    const range = (s: number, e: number) => ({ sheetId: id, dimension: 'ROWS', startIndex: s, endIndex: e });
    if (above) {
      requests.push({ deleteDimensionGroup: { range: range(above.range.startIndex, above.range.endIndex) } });
      requests.push({ addDimensionGroup: { range: range(above.range.startIndex, end) } });
      if (above.collapsed) requests.push({ updateDimensionGroup: { dimensionGroup: { range: range(above.range.startIndex, end), depth: 1, collapsed: true }, fields: 'collapsed' } });
    } else {
      requests.push({ addDimensionGroup: { range: range(start, end) } });
    }
  }
  if (!requests.length) return undefined;
  return { description: 'Migration list sync: new rows join their dealership group', expected, writes: [], requests, verify: expected };
}

/** Every lead, removed ones too, from the migration tables. */
export function readLeads(db: DatabaseSync): Lead[] {
  const rows = db.prepare(`SELECT p.uid, p.name, p.status, p.meeting_at, p.note, p.source, p.removed_at, d.name AS dealership, d.sheet_key, d.on_sheet
    FROM migration_people p JOIN migration_dealers d ON d.id = p.dealer_id ORDER BY p.id`).all() as Record<string, string | number | null>[];
  return rows.map(r => ({
    uid: String(r.uid), name: String(r.name), dealership: String(r.dealership), dealerKey: r.sheet_key ? String(r.sheet_key) : null, onSheet: !!r.on_sheet,
    status: r.status as Status, meetingAt: r.meeting_at ? `${String(r.meeting_at).replace(' ', 'T')}Z` : null, note: String(r.note ?? ''), source: String(r.source),
    removed: !!r.removed_at,
  }));
}

export type RunResult = {
  at: string; mode: 'dry-run' | 'write';
  /** ok: written and verified, or the dry run passed. nothing: no change to make. aborted: a target cell moved, nothing written. failed: see error. */
  outcome: 'ok' | 'nothing' | 'aborted' | 'failed';
  error?: string; dir: string;
  writes: Item[]; added: Item[]; conflicts: Item[]; kept: Item[]; skipped: Item[];
  counts: Plan['counts'];
  sheetEdit: string[];
};
export type SyncDeps = {
  sheetId: string; db: DatabaseSync; dataDir: string;
  /** Runs bin/sheet-edit on an edit file. Returns its exit code and output. */
  sheetEdit: (file: string, dryRun: boolean) => { code: number; output: string };
  gwsBin?: string; now?: () => Date; log?: (msg: string, fields?: Record<string, unknown>) => void;
};

function gwsClient(bin: string, sheetId: string) {
  const call = (args: string[], params: object) => {
    const out = execFileSync(bin, ['sheets', 'spreadsheets', ...args, '--params', JSON.stringify({ ...params, spreadsheetId: sheetId })], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 });
    const parsed = JSON.parse(out || '{}');
    if (parsed.error) throw new Error(`gws ${args.join(' ')}: ${JSON.stringify(parsed.error)}`);
    return parsed;
  };
  return {
    tab: (tab: string): Grid => call(['values', 'get'], { range: `'${tab}'`, valueRenderOption: 'FORMULA' }).values ?? [],
    meta: (): SheetMeta[] => call(['get'], { fields: 'sheets(properties(sheetId,title),rowGroups)' }).sheets ?? [],
  };
}

const BASELINE = 'baseline.json';
export function readBaseline(dataDir: string): Baseline {
  const f = join(dataDir, BASELINE);
  if (!existsSync(f)) return { keys: {}, cells: {} };
  const b = JSON.parse(readFileSync(f, 'utf8'));
  return { keys: b.keys ?? {}, cells: b.cells ?? {} };
}

/** One sync run. A dry run passes the edit to sheet-edit with --dry-run and never saves the baseline. */
export function runSync(mode: 'dry-run' | 'write', deps: SyncDeps): RunResult {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => {});
  const startedAt = now().toISOString();
  const dir = join(deps.dataDir, 'runs', `${startedAt.replace(/[:.]/g, '-')}-${mode}`);
  mkdirSync(dir, { recursive: true });
  const res: RunResult = { at: startedAt, mode, outcome: 'nothing', dir, writes: [], added: [], conflicts: [], kept: [], skipped: [], counts: [], sheetEdit: [] };
  const finish = (r: RunResult) => { writeFileSync(join(dir, 'result.json'), JSON.stringify(r, null, 2)); writeFileSync(join(deps.dataDir, 'last.json'), JSON.stringify(r, null, 2)); return r; };
  try {
    if (!deps.sheetId || deps.sheetId === 'EXAMPLE_SHEET_ID') throw new Error('JARVIS_MIGRATION_SHEET_ID is not set');
    const gws = gwsClient(deps.gwsBin ?? '/opt/homebrew/bin/gws', deps.sheetId);
    const meta = gws.meta();
    const id = (t: string) => { const s = meta.find(m => m.properties.title === t); if (!s) throw new Error(`the sheet has no ${t} tab`); return s.properties.sheetId; };
    const ids = { Dealerships: id('Dealerships'), Overview: id('Overview') };
    const base = readBaseline(deps.dataDir);
    const p = plan(readLeads(deps.db), gws.tab('Dealerships'), gws.tab('Overview'), base, ids, `https://docs.google.com/spreadsheets/d/${deps.sheetId}/edit`);
    Object.assign(res, { writes: p.writes, added: p.added, conflicts: p.conflicts, kept: p.kept, skipped: p.skipped, counts: p.counts });
    for (const c of p.conflicts) log('migration sheet sync conflict', { ...c, mode });
    if (!p.edit) {
      // Nothing to write. The baseline still learns the cells that agree, so a later hand edit is told apart.
      if (mode === 'write') writeFileSync(join(deps.dataDir, BASELINE), JSON.stringify(p.baseline, null, 2));
      return finish(res);
    }
    const file = join(dir, 'edit.json');
    writeFileSync(file, JSON.stringify(p.edit, null, 2));
    const first = deps.sheetEdit(file, mode === 'dry-run');
    res.sheetEdit.push(...first.output.split('\n').filter(Boolean));
    if (first.code === 3) return finish({ ...res, outcome: 'aborted', error: 'a target cell changed after the read; nothing written, the next run tries again' });
    if (first.code !== 0) return finish({ ...res, outcome: 'failed', error: `sheet-edit exited ${first.code}` });
    for (const w of p.writes) log(mode === 'write' ? 'migration sheet sync wrote' : 'migration sheet sync would write', { cell: w.cell, person: w.person, field: w.field, from: w.from, to: w.to });
    if (mode === 'write') {
      // Saved before the group step: the cells are verified, and a failed group step must not make them look like hand edits.
      writeFileSync(join(deps.dataDir, BASELINE), JSON.stringify(p.baseline, null, 2));
      if (p.inserted.length) {
        const after = new Map(['Dealerships', 'Overview'].map(t => [t, gws.tab(t)]));
        const g = groupEdit(p.inserted, gws.meta(), (tab, row1) => text(after.get(tab)?.[row1 - 1]?.[tab === 'Dealerships' ? D.AB : O.M]));
        if (g) {
          const gf = join(dir, 'groups.json');
          writeFileSync(gf, JSON.stringify(g, null, 2));
          const second = deps.sheetEdit(gf, false);
          res.sheetEdit.push(...second.output.split('\n').filter(Boolean));
          if (second.code !== 0) return finish({ ...res, outcome: 'failed', error: `the cells are written and verified, but the row-group step exited ${second.code}` });
        }
      }
    }
    return finish({ ...res, outcome: 'ok' });
  } catch (e) {
    return finish({ ...res, outcome: 'failed', error: (e as Error).message });
  }
}

/** The run as a short Markdown report: what it wrote or would write, the conflicts, what it kept and skipped. */
export function reportOf(r: RunResult): string {
  const line = (i: Item) => `- ${i.person} (${i.dealership})${i.field ? `, ${i.field}` : ''}${i.cell ? ` at ${i.cell}` : ''}: ${i.from !== undefined && i.to !== undefined ? `${JSON.stringify(i.from)} to ${JSON.stringify(i.to)}. ` : ''}${i.why}.`;
  const section = (title: string, items: Item[]) => items.length ? [`## ${title}`, '', ...items.map(line), ''] : [];
  return [
    `# Migration sheet sync, ${r.mode === 'dry-run' ? 'dry run' : 'write'} of ${r.at}`, '',
    `Outcome: ${r.outcome}${r.error ? ` (${r.error})` : ''}. ${r.added.length} new person row(s), ${r.writes.length} cell(s), ${r.conflicts.length} conflict(s).`, '',
    ...section('New person rows', r.added),
    ...(r.counts.length ? ['## Dealership counts (Dealerships AD, Overview B)', '', ...r.counts.map(c => `- ${c.dealership}: ${c.before} to ${c.after}.`), ''] : []),
    ...section(r.mode === 'dry-run' ? 'Cells it would write' : 'Cells written', r.writes),
    ...section('Conflicts (the sheet is kept)', r.conflicts),
    ...section('Kept as the sheet has it', r.kept),
    ...section('Skipped', r.skipped),
    ...(r.sheetEdit.length ? ['## sheet-edit output', '', '```', ...r.sheetEdit, '```', ''] : []),
  ].join('\n');
}

/** True once a day, at or after 7:30 AM Eastern, when today's run has not happened yet. */
export function syncDue(now: Date, lastDay: string | undefined): { due: boolean; day: string } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now).map(x => [x.type, x.value]));
  const day = `${parts.year}-${parts.month}-${parts.day}`;
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  return { due: minutes >= 7 * 60 + 30 && lastDay !== day, day };
}
