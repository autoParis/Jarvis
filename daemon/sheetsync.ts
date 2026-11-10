// The daily sync from the Migration list (migration.ts, data/jarvis.db) to the Marketplace migration sheet.
// Part of the temporary migration pieces listed in docs/migration/README.md. Rules:
// - It writes only through bin/sheet-edit, with an `expected` value for every cell it changes, so a cell edited
//   after the read aborts the write (sheet-edit exit 3) and nothing is written.
// - Each lead is a person sub-line with a readable key `<dealership key>/<folded name>` (Dealerships AB, Overview M, which
//   the formulas use) and the lead's stable uid in a hidden "Lead id" column (Dealerships AE, Overview O). The sync matches a
//   row by the uid, so a rename in the Leads list updates the same row. A row without a uid matches once by its key.
//   The sync owns five cells of that person: the name (Dealerships B, Overview A), the stage (Overview C, the dropdown
//   Dealerships C reads), the meeting time in Eastern (Dealerships G), the contact (Dealerships I) and the note (Dealerships V).
// - The Leads list is the owner's source of truth for people (his rule, 2026-11-10). The stage always follows it, Migrated
//   included. Another cell follows a lead change. A hand edit the sync replaces is listed in the run log as overwritten.
// - A baseline file keeps, for each owned cell, the lead value and the sheet value of the last sync, to tell a lead change
//   from a hand edit. Without a lead change, the sheet's own text in the other cells stays.
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
export type SheetMeta = { properties: { sheetId: number; title: string; gridProperties?: { columnCount?: number } }; rowGroups?: Group[] };
type Tab = 'Dealerships' | 'Overview';
export type Field = 'name' | 'stage' | 'meeting' | 'contact' | 'note';
export type Baseline = { keys: Record<string, string>; cells: Record<string, { lead: string; sheet: string }> };
type Write = { range: string; values: (Cell | null)[][]; inputOption?: 'RAW' | 'USER_ENTERED' };
type Check = { range: string; values: Grid };
export type EditFile = { description: string; expected: Check[]; writes: Write[]; requests?: object[]; verify?: Check[] };
/** One line of the report. `cell` is the A1 cell after the rows are inserted, the one sheet-edit writes. */
export type Item = { person: string; dealership: string; field?: Field | 'row' | 'uid'; cell?: string; from?: string; to?: string; why: string };
export type Plan = {
  edit?: EditFile;
  /** The rows each new person gets, after the inserts, for the row-group step. */
  inserted: { tab: 'Dealerships' | 'Overview'; dealerKey: string; at: number; n: number; keys: string[] }[];
  /** overwritten: hand edits on the sheet that the Leads list replaced. Each one is also in `writes`. */
  writes: Item[]; added: Item[]; overwritten: Item[]; kept: Item[]; skipped: Item[];
  /** "X of Y migrated" before and after, for each dealership the edit touches. The sheet's formulas compute the real ones. */
  counts: { dealership: string; before: string; after: string }[];
  /** The baseline to save once the edit is verified. */
  baseline: Baseline;
};

const D = { tab: 'Dealerships', A: 0, B: 1, C: 2, D: 3, G: 6, I: 8, V: 21, AB: 27, AC: 28, UID: 30 } as const;
const O = { tab: 'Overview', A: 0, B: 1, C: 2, M: 12, UID: 14 } as const;
const UID_HEADER = 'Lead id (Jarvis)';
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

// The Overview name (column A) is a second copy of the name. It follows the Dealerships name and is not compared on its own.
const SPOT: Record<Field, { tab: Tab; col: number }> = {
  name: { tab: 'Dealerships', col: D.B }, stage: { tab: 'Overview', col: O.C }, meeting: { tab: 'Dealerships', col: D.G },
  contact: { tab: 'Dealerships', col: D.I }, note: { tab: 'Dealerships', col: D.V },
};

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
 * One write per row and input mode instead of one per cell: sheet-edit reads back each write, and Google allows 60 reads a
 * minute. A cell between two written cells is null, which sheet-edit leaves alone and does not read back.
 */
function byRow(cells: Write[]): Write[] {
  const rows = new Map<string, { tab: string; row: string; mode: Write['inputOption']; cols: Map<number, Cell | null> }>();
  for (const w of cells) {
    const m = /^(\w+)!([A-Z]+)(\d+)$/.exec(w.range)!;
    const k = `${m[1]}!${m[3]}!${w.inputOption ?? 'RAW'}`;
    if (!rows.has(k)) rows.set(k, { tab: m[1], row: m[3], mode: w.inputOption, cols: new Map() });
    rows.get(k)!.cols.set(colNumber(m[2]), w.values[0][0]);
  }
  return [...rows.values()].map(r => {
    const cols = [...r.cols.keys()], lo = Math.min(...cols), hi = Math.max(...cols);
    const values = Array.from({ length: hi - lo + 1 }, (_, i) => r.cols.has(lo + i) ? r.cols.get(lo + i)! : null);
    return { range: `${r.tab}!${colName(lo)}${r.row}:${colName(hi)}${r.row}`, values: [values], ...(r.mode ? { inputOption: r.mode } : {}) };
  });
}
const colNumber = (c: string) => [...c].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;

/**
 * The edit for one run, computed from the leads, both tabs read with the FORMULA render option, and the last baseline.
 * Pure: it reads and writes nothing. `sheetIds` are the tab ids the requests name, `columns` each tab's column count.
 */
export function plan(leads: Lead[], dRows: Grid, oRows: Grid, base: Baseline, sheetIds: { Dealerships: number; Overview: number }, sheetUrl: string,
  columns: { Dealerships: number; Overview: number } = { Dealerships: Infinity, Overview: Infinity }): Plan {
  const p: Plan = { inserted: [], writes: [], added: [], overwritten: [], kept: [], skipped: [], counts: [], baseline: { keys: { ...base.keys }, cells: { ...base.cells } } };
  // The stage each touched person has after the edit, by person key, and the dealership name of each touched dealership key.
  const stageAfter = new Map<string, string>(), touched = new Map<string, string>();
  const expected: Check[] = [], writes: (Write & { tab: Tab; row0: number; col: number })[] = [];
  const verify: Check[] = [], requests: object[] = [], newWrites: Write[] = [];
  // New rows per dealership block and tab, in original coordinates: at = the 0-based index the rows go in at.
  const inserts: { tab: Tab; at: number; dealerKey: string; rows: { lead: Lead; key: string }[] }[] = [];
  const insertAt = (tab: Tab, idx: number, dealerKey: string, lead: Lead, key: string) => {
    let ins = inserts.find(i => i.tab === tab && i.at === idx);
    if (!ins) inserts.push(ins = { tab, at: idx, dealerKey, rows: [] });
    ins.rows.push({ lead, key });
  };
  const grid = (tab: Tab) => tab === 'Dealerships' ? dRows : oRows;
  const keyCol = (tab: Tab) => tab === 'Dealerships' ? D.AB : O.M;
  const uidCol = (tab: Tab) => tab === 'Dealerships' ? D.UID : O.UID;

  // The hidden "Lead id" column, once: Dealerships AE and Overview O, with a header. The tabs end at AD and N, so the first
  // run appends the column. A cell outside the grid cannot be read, so these writes carry no expected value.
  const headerRow0 = { Dealerships: 0, Overview: oRows.findIndex(r => text(r[O.M]) === 'Record key') };
  for (const tab of ['Dealerships', 'Overview'] as Tab[]) {
    const h = headerRow0[tab];
    if (h < 0 || at(grid(tab), h, uidCol(tab)) !== '') continue;
    if (columns[tab] <= uidCol(tab)) requests.push({ appendDimension: { sheetId: sheetIds[tab], dimension: 'COLUMNS', length: uidCol(tab) + 1 - columns[tab] } });
    requests.push({ updateDimensionProperties: { range: { sheetId: sheetIds[tab], dimension: 'COLUMNS', startIndex: uidCol(tab), endIndex: uidCol(tab) + 1 }, properties: { hiddenByUser: true }, fields: 'hiddenByUser' } });
    newWrites.push({ range: a1(tab, uidCol(tab), h + 1), values: [[UID_HEADER]] });
    verify.push({ range: a1(tab, uidCol(tab), h + 1), values: [[UID_HEADER]] });
  }

  const live = leads.filter(l => !l.removed);
  for (const l of leads.filter(l => l.removed)) {
    if (!live.some(o => o.uid !== l.uid && o.dealerKey === l.dealerKey && fold(o.name) === fold(l.name))) {
      p.skipped.push({ person: l.name, dealership: l.dealership, why: 'removed from the list; the sheet row, if any, stays' });
    }
  }

  // Each lead's rows. The lead id column decides; a row without an id matches once by its readable key, and then gets the id.
  // A rename keeps the row and its readable key, so the formulas that link the two tabs by key keep working.
  const found = new Map<string, { dIdx: number; oIdx: number; key: string }>();
  for (const l of live) {
    if (!l.dealerKey || !l.onSheet) continue;
    const guess = base.keys[l.uid] ?? personKey(l.dealerKey, l.name);
    const find = (tab: Tab) => {
      const g = grid(tab), byUid = g.findIndex(r => text(r[uidCol(tab)]) === l.uid);
      return byUid >= 0 ? byUid : g.findIndex(r => text(r[keyCol(tab)]) === guess && text(r[uidCol(tab)]) === '');
    };
    const dIdx = find('Dealerships'), oIdx = find('Overview');
    found.set(l.uid, { dIdx, oIdx, key: dIdx >= 0 ? at(dRows, dIdx, D.AB) : oIdx >= 0 ? at(oRows, oIdx, O.M) : guess });
  }
  const keyCount = new Map<string, number>();
  for (const f of found.values()) keyCount.set(f.key, (keyCount.get(f.key) ?? 0) + 1);

  for (const l of live) {
    const who = { person: l.name, dealership: l.dealership };
    const f = found.get(l.uid);
    if (!f) { p.skipped.push({ ...who, why: 'the dealership is not on the sheet' }); continue; }
    const { dIdx, oIdx, key } = f;
    if ((keyCount.get(key) ?? 0) > 1) { p.skipped.push({ ...who, why: `two leads share the key ${key}` }); continue; }
    // A new row needs a key no other row has: the formulas match the two tabs by it.
    const taken = (tab: Tab) => grid(tab).some(r => text(r[keyCol(tab)]) === key);
    if ((dIdx < 0 && taken('Dealerships')) || (oIdx < 0 && taken('Overview'))) { p.skipped.push({ ...who, why: `the key ${key} belongs to another person's row` }); continue; }
    const rows = dealershipRows(dRows, oRows, l.dealerKey!);
    if (!rows) { p.skipped.push({ ...who, why: `no dealership row with key ${l.dealerKey} on both tabs` }); continue; }
    const want = wanted(l);
    const secret = SECRET.test(l.note);
    if (secret) p.skipped.push({ ...who, field: 'note', why: 'the note looks like it names a password or token, so it is not copied' });
    p.baseline.keys[l.uid] = key;

    const rowOf = (tab: Tab) => tab === 'Dealerships' ? dIdx : oIdx;
    if (dIdx < 0) insertAt('Dealerships', rows.dEnd, l.dealerKey!, l, key);
    if (oIdx < 0) { insertAt('Overview', rows.oEnd, l.dealerKey!, l, key); stageAfter.set(key, want.stage); touched.set(l.dealerKey!, l.dealership); }
    if (dIdx < 0 || oIdx < 0) p.added.push({ ...who, field: 'row', why: `new sub-line ${key} on ${[dIdx < 0 && 'Dealerships', oIdx < 0 && 'Overview'].filter(Boolean).join(' and ')}` });

    // An existing row without the lead id gets it, so the next run finds the row even after a rename.
    for (const tab of ['Dealerships', 'Overview'] as Tab[]) {
      const idx = rowOf(tab);
      if (idx < 0 || at(grid(tab), idx, uidCol(tab)) === l.uid) continue;
      writes.push({ tab, row0: idx, col: uidCol(tab), range: '', values: [[l.uid]] });
      p.writes.push({ ...who, field: 'uid', cell: `${tab}:${uidCol(tab)}:${idx}`, from: '', to: l.uid, why: 'the row gets its lead id' });
    }

    for (const field of Object.keys(want) as Field[]) {
      const spot = SPOT[field];
      const idx = rowOf(spot.tab);
      if (idx < 0) continue; // a new row gets every cell below, with the insert
      if (field === 'note' && secret) continue;
      const cellId = `${l.uid}:${field}`;
      const st = base.cells[cellId];
      const sheet = at(grid(spot.tab), idx, spot.col).trim();
      const lead = want[field].trim();
      const item = { ...who, field, cell: `${spot.tab}:${spot.col}:${idx}`, from: sheet, to: lead };
      const handEdit = !!st && sheet !== st.sheet;
      if (same(field, sheet, lead, l.name)) { p.baseline.cells[cellId] = { lead, sheet }; continue; }
      const doWrite = (why: string) => {
        writes.push({ tab: spot.tab, row0: idx, col: spot.col, range: '', values: [[want[field]]] });
        expected.push({ range: a1(spot.tab, spot.col, idx + 1), values: [[at(grid(spot.tab), idx, spot.col)]] });
        p.writes.push({ ...item, why });
        // A hand edit the Leads list replaces is written down in the run log, never kept silently.
        if (handEdit) p.overwritten.push({ ...item, why: 'changed on the sheet by hand since the last sync; the Leads list wins' });
        p.baseline.cells[cellId] = { lead, sheet: lead };
        if (field === 'stage') { stageAfter.set(key, lead); touched.set(l.dealerKey!, l.dealership); }
        if (field === 'name' && oIdx >= 0) {
          writes.push({ tab: 'Overview', row0: oIdx, col: O.A, range: '', values: [[want.name]] });
          expected.push({ range: a1('Overview', O.A, oIdx + 1), values: [[at(oRows, oIdx, O.A)]] });
        }
      };
      // The stage always follows the Leads list, the owner's source of truth for people (rule of 2026-11-10).
      if (field === 'stage') { doWrite(st ? (handEdit ? 'the sheet stage was changed by hand; the Leads list wins' : 'the lead changed') : 'first sync: the Leads list wins'); continue; }
      // The other cells: a lead change is written over the sheet. Without one, the sheet's own text stays.
      if (!st) {
        if (sheet === '') doWrite('the cell was empty');
        else if (lead === '') p.baseline.cells[cellId] = { lead, sheet };
        else { p.kept.push({ ...item, why: 'first sync: the sheet has its own text, kept' }); p.baseline.cells[cellId] = { lead, sheet }; }
        continue;
      }
      if (lead !== st.lead) doWrite('the lead changed');
      else {
        if (handEdit) p.kept.push({ ...item, why: 'changed on the sheet by hand, and the lead did not change, kept' });
        p.baseline.cells[cellId] = { lead, sheet };
      }
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
  // Until here the items of existing rows hold "<tab>:<col>:<row0>"; give each its final A1 cell.
  for (const item of [...p.writes, ...p.overwritten, ...p.kept]) {
    if (!item.cell?.includes(':')) continue;
    const [tab, col, row0] = item.cell.split(':');
    item.cell = a1(tab, Number(col), finalRow1(tab, Number(row0)));
  }

  for (const ins of inserts) {
    const tab = ins.tab, rows = grid(tab), kc = keyCol(tab);
    const before = inserts.filter(i => i.tab === tab && i.at < ins.at).reduce((n, i) => n + i.rows.length, 0);
    const start0 = ins.at + before; // first new row, 0-based, after every insert
    p.inserted.push({ tab, dealerKey: ins.dealerKey, at: start0, n: ins.rows.length, keys: ins.rows.map(r => r.key) });
    // The rows around the insert point must still be where the read saw them.
    expected.push({ range: a1(tab, kc, ins.at), values: [[at(rows, ins.at - 1, kc)]] });
    if (ins.at < rows.length) expected.push({ range: a1(tab, kc, ins.at + 1), values: [[at(rows, ins.at, kc)]] });
    const dealerRow0 = rows.findIndex(r => text(r[kc]) === ins.dealerKey);
    verify.push({ range: a1(tab, kc, finalRow1(tab, dealerRow0)), values: [[ins.dealerKey]] });
    ins.rows.forEach(({ lead, key }, k) => {
      const r = start0 + k + 1, want = wanted(lead), secret = SECRET.test(lead.note);
      const raw = (col: number, v: string) => newWrites.push({ range: a1(tab, col, r), values: [[v]] });
      const formula = (col: number, v: string) => newWrites.push({ range: a1(tab, col, r), values: [[v]], inputOption: 'USER_ENTERED' });
      const item = { person: lead.name, dealership: lead.dealership };
      raw(uidCol(tab), lead.uid);
      p.writes.push({ ...item, field: 'uid', cell: a1(tab, uidCol(tab), r), from: '', to: lead.uid, why: 'new sub-line' });
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
  // Highest insert first, so each request's index is still an original one when it runs. Column requests come first.
  for (const ins of [...inserts].sort((x, y) => y.at - x.at || x.tab.localeCompare(y.tab))) {
    requests.push({ insertDimension: { range: { sheetId: sheetIds[ins.tab], dimension: 'ROWS', startIndex: ins.at, endIndex: ins.at + ins.rows.length }, inheritFromBefore: true } });
  }

  const allWrites = byRow([...writes.map(({ range, values }) => ({ range, values })), ...newWrites]);
  if (!allWrites.length) return p;
  // A lead id written on an existing row fills an empty cell: state it, in the coordinates of the read, when the column exists.
  for (const w of writes) if (w.col === uidCol(w.tab) && columns[w.tab] > w.col) expected.push({ range: a1(w.tab, w.col, w.row0 + 1), values: [[at(grid(w.tab), w.row0, w.col)]] });
  // With no insert, the rows have not moved, so each merged write states every current cell of its own range. sheet-edit
  // then checks the whole segment, and every write sits inside an expected range as it requires.
  const segment = (range: string): Grid => {
    const m = /^(\w+)!([A-Z]+)(\d+):([A-Z]+)\d+$/.exec(range)!;
    const g = grid(m[1] as Tab), r0 = Number(m[3]) - 1;
    return [Array.from({ length: colNumber(m[4]) - colNumber(m[2]) + 1 }, (_, i) => at(g, r0, colNumber(m[2]) + i))];
  };
  p.edit = {
    description: `Migration list sync: ${p.added.length} new person row(s), ${p.writes.length} cell(s)`,
    expected: requests.length ? expected : allWrites.map(w => ({ range: w.range, values: segment(w.range) })),
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

/** The group edit for every lead row (found by its lead id) that sits in no row group, as runs of adjacent rows. */
export function groupFixEdit(uids: Set<string>, dRows: Grid, oRows: Grid, meta: SheetMeta[]): EditFile | undefined {
  const runs: Plan['inserted'] = [];
  for (const tab of ['Dealerships', 'Overview'] as Tab[]) {
    const g = tab === 'Dealerships' ? dRows : oRows, uc = tab === 'Dealerships' ? D.UID : O.UID;
    const groups = (meta.find(s => s.properties.title === tab)?.rowGroups ?? []).filter(x => x.depth >= 1);
    const loose = g.map((r, i) => i).filter(i => uids.has(text(g[i][uc])) && !groups.some(x => x.range.startIndex <= i && i < x.range.endIndex));
    for (const i of loose) {
      const last = runs[runs.length - 1];
      if (last && last.tab === tab && last.at + last.n === i) last.n++;
      else runs.push({ tab, dealerKey: '', at: i, n: 1, keys: [] });
    }
  }
  if (!runs.length) return undefined;
  return groupEdit(runs, meta, (tab, row1) => text((tab === 'Dealerships' ? dRows : oRows)[row1 - 1]?.[tab === 'Dealerships' ? D.AB : O.M]));
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
  writes: Item[]; added: Item[]; overwritten: Item[]; kept: Item[]; skipped: Item[];
  counts: Plan['counts'];
  /** The key cells of the lead rows the row-group step grouped. */
  grouped?: string[];
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
    meta: (): SheetMeta[] => call(['get'], { fields: 'sheets(properties(sheetId,title,gridProperties(columnCount)),rowGroups)' }).sheets ?? [],
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
  const res: RunResult = { at: startedAt, mode, outcome: 'nothing', dir, writes: [], added: [], overwritten: [], kept: [], skipped: [], counts: [], sheetEdit: [] };
  const finish = (r: RunResult) => { writeFileSync(join(dir, 'result.json'), JSON.stringify(r, null, 2)); writeFileSync(join(deps.dataDir, 'last.json'), JSON.stringify(r, null, 2)); return r; };
  try {
    if (!deps.sheetId || deps.sheetId === 'EXAMPLE_SHEET_ID') throw new Error('JARVIS_MIGRATION_SHEET_ID is not set');
    const gws = gwsClient(deps.gwsBin ?? '/opt/homebrew/bin/gws', deps.sheetId);
    const meta = gws.meta();
    const id = (t: string) => { const s = meta.find(m => m.properties.title === t); if (!s) throw new Error(`the sheet has no ${t} tab`); return s.properties.sheetId; };
    const ids = { Dealerships: id('Dealerships'), Overview: id('Overview') };
    const cols = (t: string) => meta.find(m => m.properties.title === t)?.properties.gridProperties?.columnCount ?? Infinity;
    const base = readBaseline(deps.dataDir);
    const dRows = gws.tab('Dealerships'), oRows = gws.tab('Overview');
    const p = plan(readLeads(deps.db), dRows, oRows, base, ids, `https://docs.google.com/spreadsheets/d/${deps.sheetId}/edit`, { Dealerships: cols('Dealerships'), Overview: cols('Overview') });
    Object.assign(res, { writes: p.writes, added: p.added, overwritten: p.overwritten, kept: p.kept, skipped: p.skipped, counts: p.counts });
    for (const c of p.overwritten) log('migration sheet sync replaces a hand edit', { ...c, mode });
    let wrote = false;
    if (p.edit) {
      const file = join(dir, 'edit.json');
      writeFileSync(file, JSON.stringify(p.edit, null, 2));
      const first = deps.sheetEdit(file, mode === 'dry-run');
      res.sheetEdit.push(...first.output.split('\n').filter(Boolean));
      if (first.code === 3) return finish({ ...res, outcome: 'aborted', error: 'a target cell changed after the read; nothing written, the next run tries again' });
      if (first.code !== 0) return finish({ ...res, outcome: 'failed', error: `sheet-edit exited ${first.code}` });
      for (const w of p.writes) log(mode === 'write' ? 'migration sheet sync wrote' : 'migration sheet sync would write', { cell: w.cell, person: w.person, field: w.field, from: w.from, to: w.to });
      wrote = true;
    }
    // Saved before the group step: the cells are verified, and a failed group step must not make them look like hand edits.
    // With nothing to write, the baseline still learns the cells that agree, so a later hand edit is told apart.
    if (mode === 'write') writeFileSync(join(deps.dataDir, BASELINE), JSON.stringify(p.baseline, null, 2));
    // Every lead row outside a row group joins its dealership's group: the rows this run added, and any a failed run left.
    // A dry run checks the sheet as it is now, so rows it would add are not in it yet.
    const uids = new Set(Object.keys(p.baseline.keys));
    const g = groupFixEdit(uids, mode === 'write' && wrote ? gws.tab('Dealerships') : dRows, mode === 'write' && wrote ? gws.tab('Overview') : oRows, mode === 'write' && wrote ? gws.meta() : meta);
    if (g) {
      const gf = join(dir, 'groups.json');
      writeFileSync(gf, JSON.stringify(g, null, 2));
      const second = deps.sheetEdit(gf, mode === 'dry-run');
      res.sheetEdit.push(...second.output.split('\n').filter(Boolean));
      res.grouped = g.expected.map(c => c.range);
      if (second.code !== 0) return finish({ ...res, outcome: 'failed', error: `${wrote ? 'the cells are written and verified, but ' : ''}the row-group step exited ${second.code}` });
      wrote = true;
    }
    if (!wrote) return finish(res);
    return finish({ ...res, outcome: 'ok' });
  } catch (e) {
    return finish({ ...res, outcome: 'failed', error: (e as Error).message });
  }
}

/** The run as a short Markdown report: what it wrote or would write, the hand edits it replaced, what it kept and skipped. */
export function reportOf(r: RunResult): string {
  const line = (i: Item) => `- ${i.person} (${i.dealership})${i.field ? `, ${i.field}` : ''}${i.cell ? ` at ${i.cell}` : ''}: ${i.from !== undefined && i.to !== undefined ? `${JSON.stringify(i.from)} to ${JSON.stringify(i.to)}. ` : ''}${i.why}.`;
  const section = (title: string, items: Item[]) => items.length ? [`## ${title}`, '', ...items.map(line), ''] : [];
  return [
    `# Migration sheet sync, ${r.mode === 'dry-run' ? 'dry run' : 'write'} of ${r.at}`, '',
    `Outcome: ${r.outcome}${r.error ? ` (${r.error})` : ''}. ${r.added.length} new person row(s), ${r.writes.length} cell(s), ${r.overwritten.length} hand edit(s) replaced.`, '',
    ...section('New person rows', r.added),
    ...(r.counts.length ? ['## Dealership counts (Dealerships AD, Overview B)', '', ...r.counts.map(c => `- ${c.dealership}: ${c.before} to ${c.after}.`), ''] : []),
    ...section(r.mode === 'dry-run' ? 'Cells it would write' : 'Cells written', r.writes),
    ...section('Hand edits on the sheet that the Leads list replaces', r.overwritten),
    ...section('Kept as the sheet has it', r.kept),
    ...section('Skipped', r.skipped),
    ...(r.grouped?.length ? [`## Rows ${r.mode === 'dry-run' ? 'it would put' : 'put'} into their dealership's row group`, '', ...r.grouped.map(c => `- ${c}`), ''] : []),
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
