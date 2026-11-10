// The Migration contacts list: The owner's working list of dealer contacts for the Marketplace migration. Temporary, so it is
// self-contained: its own tables (created here, prefixed migration_), its own routes, CLI (bin/jarvis-migration) and page
// module (web/migration.js). docs/migration/README.md lists every piece, so it comes out in one go.
// Rules, enforced here and not only in the prompt:
// - The brain can add a person, list, set a status, write a note and edit a person's name, dealership, source and contact. Only the owner's page can remove a row or add a dealership.
// - A dealership is picked from the list, never typed by the brain, so names match the migration sheet exactly.
// - Every status change is kept with its time (migration_status_log), so a later sheet sync never has to guess.
// - Meeting set carries the meeting time (meeting_at, UTC). The owner's page cannot set Meeting set without one; the brain may,
//   and the row then shows "Pick a time". Leaving Meeting set clears it from the row; the log keeps it.
// - Nothing here writes to the sheet. The sheet stays the record. Only the daily sync (sheetsync.ts) writes to it, through bin/sheet-edit.
import { OWNER } from './config.ts';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import type { Log } from './log.ts';

export const STATUSES = ['todo', 'contacted', 'meeting', 'migrated'] as const;
export type Status = typeof STATUSES[number];
export const STATUS_WORDS: Record<Status, string> = { todo: 'To contact', contacted: 'Contacted', meeting: 'Meeting set', migrated: 'Migrated' };
export const SOURCES = ['email', 'text'] as const;
export const SOURCE_WORDS: Record<string, string> = { email: 'Email', text: 'Text message' };

export type Dealer = { id: number; name: string; sheet_key: string | null; on_sheet: number; added_by: string; created_at: string; updated_at: string };
export type PersonRow = {
  id: number; uid: string; name: string; dealer_id: number; source: string; status: Status; note: string;
  added_by: 'owner' | 'jarvis'; added_from: string | null; created_at: string; updated_at: string; status_at: string; note_at: string | null; removed_at: string | null;
  meeting_at: string | null; by_hidden_at: string | null; contact: string | null;
};
export type StatusChange = { status: Status; at: string; by: string; meetingAt?: string };
export type PersonView = {
  id: number; uid: string; name: string; dealership: string; dealerId: number; dealerKey: string | null; onSheet: boolean;
  source: string; sourceWords: string; status: Status; statusWords: string; note: string;
  /** A phone number or an email to reach the person. Null when nobody gave one. */
  contact: string | null;
  addedBy: 'owner' | 'jarvis'; addedFrom: string | null; createdAt: string; updatedAt: string; statusAt: string; noteAt: string | null;
  /** The meeting time in UTC, only while the status is Meeting set. Null when the brain set Meeting set without one. */
  meetingAt: string | null;
  /** the owner tapped the x on the "Added by Jarvis" line. addedBy and addedFrom stay as they were. */
  byHidden: boolean;
  history: StatusChange[];
};
export type DealerView = { id: number; name: string; key: string | null; onSheet: boolean };
/** `toastClosed` holds the meeting toasts the owner closed, as "<person id>|<meetingAt>" (`toastKey` in web/migration.js). */
export type MigrationState = { people: PersonView[]; dealers: DealerView[]; toastClosed: string[] };
export type RouteResult = { status: number; body: any };
type SheetDealer = { name: string; key?: string | null };

const iso = (sql: string | null) => sql ? `${sql.replace(' ', 'T')}Z` : null;
const text = (v: unknown) => typeof v === 'string' ? v.trim() : '';
/**
 * A meeting time as the database stores it (UTC, "YYYY-MM-DD HH:MM:SS"), from an ISO time that names its zone
 * ("2026-11-07T10:00-05:00" or "...Z"). A time without a zone is refused: the brain and the page must say which clock they mean.
 */
export function meetingOf(v: unknown): string | undefined {
  const s = text(v);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d+)?)?(Z|[+-]\d\d:?\d\d)$/.test(s)) return undefined;
  const t = Date.parse(s);
  if (!Number.isFinite(t) || t < Date.UTC(2020, 0, 1) || t > Date.UTC(2100, 0, 1)) return undefined;
  return new Date(t).toISOString().slice(0, 19).replace('T', ' ');
}
const MEETING_FORMAT = 'meetingAt must be an ISO time with its zone, such as 2026-11-07T10:00-05:00';
/** The status key from a key or its words, any case: "Meeting set" and "meeting" are both `meeting`. */
export function statusOf(v: unknown): Status | undefined {
  const s = text(v).toLowerCase();
  return STATUSES.find(k => k === s || STATUS_WORDS[k].toLowerCase() === s || (k === 'todo' && s === 'to-contact'));
}
export function sourceOf(v: unknown): string | undefined {
  const s = text(v).toLowerCase();
  return s === 'email' || s === 'e-mail' ? 'email' : s === 'text' || s === 'sms' || s === 'text message' ? 'text' : undefined;
}
const CONTACT_FORMAT = 'contact must be a phone number (7 digits or more) or an email address';
/**
 * A contact as stored: an email, or a phone number with at least 7 digits and only phone signs. Spaces are folded, the rest
 * stays as typed ("581-232-9500"). '' means clear it. Undefined when it is neither.
 */
export function contactOf(v: unknown): string | undefined {
  const s = text(v).replace(/\s+/g, ' ');
  if (!s) return '';
  if (s.length > 120) return undefined;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return s;
  if (/^\+?[\d\s().-]+(\s*(x|ext\.?)\s*\d+)?$/i.test(s) && (s.match(/\d/g) ?? []).length >= 7) return s;
  return undefined;
}
/** Lowercase, no accents, letters and digits only, for matching a name typed in the chat against the list. */
export const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]/g, '');

export function createTables(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS migration_dealers (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, sheet_key TEXT UNIQUE, on_sheet INTEGER NOT NULL DEFAULT 1,
      added_by TEXT NOT NULL DEFAULT 'sheet', created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS migration_people (
      id INTEGER PRIMARY KEY, uid TEXT NOT NULL UNIQUE, name TEXT NOT NULL, dealer_id INTEGER NOT NULL REFERENCES migration_dealers(id),
      source TEXT NOT NULL CHECK (source IN ('email', 'text')),
      status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'contacted', 'meeting', 'migrated')),
      note TEXT NOT NULL DEFAULT '', added_by TEXT NOT NULL CHECK (added_by IN ('owner', 'jarvis')), added_from TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      status_at TEXT NOT NULL DEFAULT (datetime('now')), note_at TEXT, removed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS migration_status_log (
      id INTEGER PRIMARY KEY, person_id INTEGER NOT NULL REFERENCES migration_people(id), status TEXT NOT NULL,
      by TEXT NOT NULL, at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    -- The stable id a later sheet sync keys on never changes.
    CREATE TRIGGER IF NOT EXISTS migration_uid_fixed BEFORE UPDATE OF uid ON migration_people BEGIN SELECT RAISE(ABORT, 'a person''s id does not change'); END;
  `);
  // Columns added after the first build: a database made before them gains them here, empty.
  const has = (table: string, col: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some(c => c.name === col);
  if (!has('migration_people', 'meeting_at')) db.exec('ALTER TABLE migration_people ADD COLUMN meeting_at TEXT');
  if (!has('migration_people', 'by_hidden_at')) db.exec('ALTER TABLE migration_people ADD COLUMN by_hidden_at TEXT');
  if (!has('migration_people', 'contact')) db.exec('ALTER TABLE migration_people ADD COLUMN contact TEXT');
  if (!has('migration_status_log', 'meeting_at')) db.exec('ALTER TABLE migration_status_log ADD COLUMN meeting_at TEXT');
}

/** Reads the seed or a re-import file: `{ "dealerships": [{ "name", "key" }] }` or the bare list. */
export function readDealerFile(path: string): SheetDealer[] {
  const j = JSON.parse(readFileSync(path, 'utf8'));
  return Array.isArray(j) ? j : j.dealerships;
}

export function makeMigration(o: { db: DatabaseSync; log: Log; onChange: () => void; seed?: () => SheetDealer[]; getState: (k: string) => string | undefined; setState: (k: string, v: string) => void }) {
  const { db, log } = o;
  createTables(db);

  const dealers = () => db.prepare('SELECT * FROM migration_dealers ORDER BY name COLLATE NOCASE').all() as Dealer[];
  const dealer = (id: number) => db.prepare('SELECT * FROM migration_dealers WHERE id = ?').get(id) as Dealer | undefined;
  const person = (id: number) => db.prepare('SELECT * FROM migration_people WHERE id = ? AND removed_at IS NULL').get(id) as PersonRow | undefined;
  const people = () => db.prepare('SELECT * FROM migration_people WHERE removed_at IS NULL ORDER BY id').all() as PersonRow[];
  const historyOf = (id: number) => (db.prepare('SELECT status, at, by, meeting_at FROM migration_status_log WHERE person_id = ? ORDER BY id').all(id) as (StatusChange & { meeting_at: string | null })[])
    .map(({ meeting_at, ...h }) => ({ ...h, at: iso(h.at)!, ...(meeting_at ? { meetingAt: iso(meeting_at)! } : {}) }));

  function view(p: PersonRow): PersonView {
    const d = dealer(p.dealer_id)!;
    return {
      id: p.id, uid: p.uid, name: p.name, dealership: d.name, dealerId: d.id, dealerKey: d.sheet_key, onSheet: !!d.on_sheet,
      source: p.source, sourceWords: SOURCE_WORDS[p.source] ?? p.source, status: p.status, statusWords: STATUS_WORDS[p.status], note: p.note,
      contact: p.contact || null, addedBy: p.added_by, addedFrom: p.added_from, createdAt: iso(p.created_at)!, updatedAt: iso(p.updated_at)!, statusAt: iso(p.status_at)!, noteAt: iso(p.note_at),
      meetingAt: iso(p.meeting_at), byHidden: !!p.by_hidden_at,
      history: historyOf(p.id),
    };
  }
  // The closed meeting toasts live in the state table, so a close on the phone also hides the toast on the Mac and a restart keeps it.
  const TOAST = 'migrationToastClosed', TOAST_KEEP = 50;
  function toastClosed(): string[] {
    try { const v = JSON.parse(o.getState(TOAST) ?? '[]'); return Array.isArray(v) ? v.filter(k => typeof k === 'string') : []; } catch { return []; }
  }
  const state = (): MigrationState => ({ people: people().map(view), dealers: dealers().map(d => ({ id: d.id, name: d.name, key: d.sheet_key, onSheet: !!d.on_sheet })), toastClosed: toastClosed() });
  const reply = (status: number, extra: object = {}): RouteResult => ({ status, body: { ...extra, migration: state() } });
  const refuse = (status: number, error: string) => reply(status, { error });

  /**
   * Replaces the sheet's dealership list. A row matches by its sheet key, else by its exact name. People rows are never
   * touched: a dealership gone from the file stays, flagged as not on the sheet, so nobody loses their dealership.
   */
  function importDealers(list: unknown, notify = true): { added: number; renamed: number; offSheet: number; total: number } | string {
    if (!Array.isArray(list) || !list.length) return 'the file needs a non-empty list of dealerships';
    const rows: { name: string; key: string | null }[] = [];
    for (const r of list) {
      const name = typeof r?.name === 'string' ? r.name : '';
      if (!name.trim()) return 'every dealership needs a name';
      rows.push({ name, key: text(r.key) || null });
    }
    if (new Set(rows.map(r => r.name)).size !== rows.length) return 'the file has the same dealership name twice';
    const keys = rows.map(r => r.key).filter(Boolean);
    if (new Set(keys).size !== keys.length) return 'the file has the same dealership key twice';
    let added = 0, renamed = 0, offSheet = 0;
    db.exec('BEGIN');
    try {
      const seen = new Set<number>();
      for (const r of rows) {
        const byKey = r.key ? db.prepare('SELECT * FROM migration_dealers WHERE sheet_key = ?').get(r.key) as Dealer | undefined : undefined;
        const byName = db.prepare('SELECT * FROM migration_dealers WHERE name = ?').get(r.name) as Dealer | undefined;
        const hit = byKey ?? byName;
        if (!hit) {
          const res = db.prepare(`INSERT INTO migration_dealers (name, sheet_key, on_sheet, added_by) VALUES (?, ?, 1, 'sheet')`).run(r.name, r.key);
          seen.add(Number(res.lastInsertRowid)); added++;
          continue;
        }
        // A name taken by another row (The owner added it by hand before the sheet had it): that row takes the sheet's key.
        if (byKey && byName && byKey.id !== byName.id) return rollback(`"${r.name}" is two rows here, one by key and one by name. Fix the file or the list by hand.`);
        if (hit.name !== r.name) renamed++;
        db.prepare(`UPDATE migration_dealers SET name = ?, sheet_key = COALESCE(?, sheet_key), on_sheet = 1, updated_at = datetime('now') WHERE id = ?`).run(r.name, r.key, hit.id);
        seen.add(hit.id);
      }
      const off = dealers().filter(d => d.on_sheet && !seen.has(d.id));
      for (const d of off) db.prepare(`UPDATE migration_dealers SET on_sheet = 0, updated_at = datetime('now') WHERE id = ?`).run(d.id);
      db.exec('COMMIT');
      offSheet = off.length;
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    log('migration dealers imported', { added, renamed, offSheet, total: rows.length });
    if (notify) o.onChange();
    return { added, renamed, offSheet, total: rows.length };
    function rollback(m: string) { db.exec('ROLLBACK'); return m; }
  }

  // The first start seeds the list from the sheet export in the repo. After that only an import changes it. Nobody is listening yet.
  // An empty seed file seeds nothing and waits for an import (the public copy ships it empty).
  const seedList = !o.getState('migrationSeeded') && o.seed ? o.seed() : [];
  if (seedList.length) {
    const r = importDealers(seedList, false);
    if (typeof r === 'string') log(`migration seed refused: ${r}`);
    else o.setState('migrationSeeded', new Date().toISOString());
  }

  /** The dealership a name means: exact first, then the same letters ignoring case and accents. Ambiguous means none. */
  function findDealer(name: string): Dealer | undefined {
    const all = dealers();
    const exact = all.find(d => d.name === name);
    if (exact) return exact;
    const f = fold(name), loose = all.filter(d => fold(d.name) === f);
    return loose.length === 1 ? loose[0] : undefined;
  }
  /** Up to five names that look like it, for the brain to pick from or read to the owner. */
  function closeTo(name: string): string[] {
    const f = fold(name), words = name.toLowerCase().split(/\s+/).filter(w => w.length > 2).map(fold);
    return dealers().filter(d => { const n = fold(d.name); return n.includes(f) || f.includes(n) || words.some(w => n.includes(w)); }).slice(0, 5).map(d => d.name);
  }

  /** A new status, with its meeting time for Meeting set. Meeting set again with a new time only moves the meeting. */
  function setStatus(p: PersonRow, status: Status, by: string, meeting: string | null = null) {
    if (p.status === status) {
      if (status === 'meeting' && meeting && meeting !== p.meeting_at) moveMeeting(p, meeting, by);
      return;
    }
    const at = status === 'meeting' ? meeting : null;
    db.prepare(`UPDATE migration_people SET status = ?, meeting_at = ?, status_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(status, at, p.id);
    db.prepare('INSERT INTO migration_status_log (person_id, status, by, meeting_at) VALUES (?, ?, ?, ?)').run(p.id, status, by, at);
    log('migration status', { person: p.id, from: p.status, to: status, by, meetingAt: at });
  }
  /** A new time for a meeting already set. The status and its time stay, so the row's "time since" does not restart. */
  function moveMeeting(p: PersonRow, meeting: string, by: string) {
    db.prepare(`UPDATE migration_people SET meeting_at = ?, updated_at = datetime('now') WHERE id = ?`).run(meeting, p.id);
    log('migration meeting time', { person: p.id, from: p.meeting_at, to: meeting, by });
  }
  /**
   * The meeting time a request carries, checked against its status. The owner's page always sends one with Meeting set, so a
   * missing one there is a page bug and is refused; the brain may not know the time yet.
   */
  function meetingFor(status: Status, b: any, by: 'owner' | 'jarvis', was?: PersonRow): { at: string | null } | string {
    const given = b?.meetingAt !== undefined && b?.meetingAt !== null && b?.meetingAt !== '';
    if (status !== 'meeting') return given ? 'a meeting time goes with Meeting set only' : { at: null };
    if (!given) return by === 'owner' && was?.status !== 'meeting' ? 'Pick the meeting day and time first.' : { at: null };
    const at = meetingOf(b.meetingAt);
    return at ? { at } : MEETING_FORMAT;
  }

  /** The dealership a request names: the owner's page sends its id from the dropdown, the brain a name that must be on the list. */
  function dealerFor(b: any, by: 'owner' | 'jarvis'): Dealer | string {
    const d = by === 'owner' && b?.dealerId !== undefined ? dealer(Number(b.dealerId)) : findDealer(text(b?.dealership));
    if (d) return d;
    if (by === 'owner' && b?.dealerId !== undefined) return 'That dealership is not on the list any more. Pick another.';
    const near = closeTo(text(b?.dealership));
    return `"${text(b?.dealership)}" is not on the dealership list.${near.length ? ` Close: ${near.join('; ')}.` : ''} Only ${OWNER} adds a dealership, from the app.`;
  }

  const api = {
    state,
    view: (id: number) => { const p = person(id); return p && view(p); },
    importDealers,
    /** One person. The same name at the same dealership returns that row, so a retried command adds nothing. */
    add(b: any, by: 'owner' | 'jarvis'): RouteResult {
      const name = text(b?.name).replace(/\s+/g, ' ');
      if (!name) return refuse(400, 'name is required');
      if (name.length > 120) return refuse(400, 'name is too long');
      const source = sourceOf(b?.source);
      if (!source) return refuse(400, 'source must be email or text');
      const status = b?.status === undefined || b?.status === '' ? 'todo' : statusOf(b.status);
      if (!status) return refuse(400, `status must be one of ${STATUSES.join(', ')}`);
      const meeting = meetingFor(status, b, by);
      if (typeof meeting === 'string') return refuse(400, meeting);
      const note = text(b?.note);
      if (note.length > 4000) return refuse(400, 'the note is too long');
      const contact = b?.contact === undefined || b?.contact === null ? '' : contactOf(b.contact);
      if (contact === undefined) return refuse(400, CONTACT_FORMAT);
      const d = dealerFor(b, by);
      if (typeof d === 'string') return refuse(400, d);
      const from = by === 'jarvis' ? text(b?.from) : '';
      if (by === 'jarvis' && !from) return refuse(400, '--from is required: where the person came from, such as "an email from Max" or "chat"');
      const same = people().find(p => fold(p.name) === fold(name) && p.dealer_id === d!.id);
      if (same) return reply(200, { person: view(same), existing: true });
      const r = db.prepare(`INSERT INTO migration_people (uid, name, dealer_id, source, status, meeting_at, note, note_at, added_by, added_from, contact) VALUES (?, ?, ?, ?, ?, ?, ?, ${note ? "datetime('now')" : 'NULL'}, ?, ?, ?)`)
        .run(randomUUID(), name, d.id, source, status, meeting.at, note, by, from || null, contact || null);
      const id = Number(r.lastInsertRowid);
      db.prepare('INSERT INTO migration_status_log (person_id, status, by, meeting_at) VALUES (?, ?, ?, ?)').run(id, status, by, meeting.at);
      log('migration person added', { person: id, by, dealer: d.id });
      o.onChange();
      return reply(200, { person: view(person(id)!) });
    },
    status(id: number, b: any, by: 'owner' | 'jarvis'): RouteResult {
      const p = person(id);
      if (!p) return refuse(404, `no person ${id} on the migration list`);
      const s = statusOf(b?.status);
      if (!s) return refuse(400, `status must be one of ${STATUSES.join(', ')}`);
      const meeting = meetingFor(s, b, by, p);
      if (typeof meeting === 'string') return refuse(400, meeting);
      setStatus(p, s, by, meeting.at);
      o.onChange();
      return reply(200, { person: view(person(id)!) });
    },
    /** A new time for a row already at Meeting set. */
    meeting(id: number, b: any, by: 'owner' | 'jarvis'): RouteResult {
      const p = person(id);
      if (!p) return refuse(404, `no person ${id} on the migration list`);
      if (p.status !== 'meeting') return refuse(400, `${p.name} is ${STATUS_WORDS[p.status]}, not Meeting set. Set the status with the time instead.`);
      const at = meetingOf(b?.meetingAt);
      if (!at) return refuse(400, MEETING_FORMAT);
      if (at !== p.meeting_at) { moveMeeting(p, at, by); o.onChange(); }
      return reply(200, { person: view(person(id)!) });
    },
    /** the owner's x on the "Added by Jarvis" line: hides the line on that row for good. Who added it stays on the row. */
    hideBy(id: number): RouteResult {
      const p = person(id);
      if (!p) return refuse(404, 'That person is not on the list any more.');
      if (!p.by_hidden_at) {
        db.prepare(`UPDATE migration_people SET by_hidden_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(id);
        log('migration added-by line hidden', { person: id });
        o.onChange();
      }
      return reply(200, { person: view(person(id)!) });
    },
    /**
     * Changes who the person is: name, dealership, source and contact. A field left out stays as it was; an empty contact
     * clears it. The status, its history, the note and the uid never change here. The same name at the same dealership as
     * another row is refused, so an edit never makes the duplicate that add avoids.
     */
    edit(id: number, b: any, by: 'owner' | 'jarvis'): RouteResult {
      const p = person(id);
      if (!p) return refuse(404, `no person ${id} on the migration list`);
      const has = (k: string) => b?.[k] !== undefined && b?.[k] !== null;
      const next = { name: p.name, dealer_id: p.dealer_id, source: p.source, contact: p.contact ?? '' };
      if (has('name')) {
        next.name = text(b.name).replace(/\s+/g, ' ');
        if (!next.name) return refuse(400, 'name cannot be empty');
        if (next.name.length > 120) return refuse(400, 'name is too long');
      }
      if (has('dealership') || (by === 'owner' && has('dealerId'))) {
        const d = dealerFor(b, by);
        if (typeof d === 'string') return refuse(400, d);
        next.dealer_id = d.id;
      }
      if (has('source')) {
        const src = sourceOf(b.source);
        if (!src) return refuse(400, 'source must be email or text');
        next.source = src;
      }
      if (has('contact')) {
        const c = contactOf(b.contact);
        if (c === undefined) return refuse(400, CONTACT_FORMAT);
        next.contact = c;
      }
      if (!['name', 'dealership', ...(by === 'owner' ? ['dealerId'] : []), 'source', 'contact'].some(has)) return refuse(400, 'nothing to change: give a name, dealership, source or contact');
      const changed = (Object.keys(next) as (keyof typeof next)[]).filter(k => next[k] !== (k === 'contact' ? p.contact ?? '' : p[k]));
      if (!changed.length) return reply(200, { person: view(p) });
      const same = people().find(x => x.id !== id && fold(x.name) === fold(next.name) && x.dealer_id === next.dealer_id);
      if (same) return refuse(409, `${same.name} is already on the list at ${dealer(same.dealer_id)!.name} (id ${same.id}).`);
      db.prepare(`UPDATE migration_people SET name = ?, dealer_id = ?, source = ?, contact = ?, updated_at = datetime('now') WHERE id = ?`)
        .run(next.name, next.dealer_id, next.source, next.contact || null, id);
      log('migration person edited', { person: id, by, changed, from: Object.fromEntries(changed.map(k => [k, k === 'contact' ? p.contact : p[k]])), to: Object.fromEntries(changed.map(k => [k, next[k] || null])) });
      o.onChange();
      return reply(200, { person: view(person(id)!) });
    },
    /** Replaces the note. An empty note clears it. */
    note(id: number, b: any, by: 'owner' | 'jarvis'): RouteResult {
      const p = person(id);
      if (!p) return refuse(404, `no person ${id} on the migration list`);
      if (typeof b?.note !== 'string') return refuse(400, 'note is required');
      const note = b.note.trim();
      if (note.length > 4000) return refuse(400, 'the note is too long');
      if (note !== p.note) {
        db.prepare(`UPDATE migration_people SET note = ?, note_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(note, id);
        log('migration note', { person: id, by });
        o.onChange();
      }
      return reply(200, { person: view(person(id)!) });
    },
    /** the owner's tap only. The row is kept with removed_at, so a later sheet sync can see it went. */
    remove(id: number): RouteResult {
      const p = person(id);
      if (!p) return refuse(404, 'That person is not on the list any more.');
      db.prepare(`UPDATE migration_people SET removed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(id);
      log('migration person removed', { person: id });
      o.onChange();
      return reply(200);
    },
    /**
     * the owner's × on the meeting toast. It closes the toast for that person and that meeting time only, so a moved or new
     * meeting shows again. A time that is not the person's current one is refused, so a close from a stale page hides nothing new.
     */
    closeToast(b: any): RouteResult {
      const p = person(Number(b?.id));
      if (!p || p.status !== 'meeting' || !p.meeting_at) return refuse(404, 'That meeting is not on the list any more.');
      const at = iso(p.meeting_at)!;
      if (meetingOf(b?.meetingAt) !== p.meeting_at) return refuse(409, 'That meeting moved. The toast shows the new time.');
      const key = `${p.id}|${at}`;
      o.setState(TOAST, JSON.stringify([...toastClosed().filter(k => k !== key), key].slice(-TOAST_KEEP)));
      log('migration meeting toast closed', { person: p.id, meetingAt: at });
      o.onChange();
      return reply(200);
    },
    /** the owner's "Other..." entry: a dealership missing from the sheet, flagged as not on it. An existing name returns that row. */
    addDealer(b: any): RouteResult {
      const name = text(b?.name).replace(/\s+/g, ' ');
      if (!name) return refuse(400, 'Type the dealership name first.');
      if (name.length > 120) return refuse(400, 'That name is too long.');
      const same = findDealer(name);
      if (same) return reply(200, { dealer: { id: same.id, name: same.name, key: same.sheet_key, onSheet: !!same.on_sheet }, existing: true });
      const r = db.prepare(`INSERT INTO migration_dealers (name, on_sheet, added_by) VALUES (?, 0, 'owner')`).run(name);
      const d = dealer(Number(r.lastInsertRowid))!;
      log('migration dealer added by the owner', { dealer: d.id });
      o.onChange();
      return reply(200, { dealer: { id: d.id, name: d.name, key: null, onSheet: false } });
    },
  };
  return api;
}
export type Migration = ReturnType<typeof makeMigration>;

/** The brain's session brief: one line for each open To contact row, then each Meeting set row with its time. Empty when there is none. */
export function migrationBrief(people: PersonView[]): string {
  const open = people.filter(p => p.status === 'todo');
  const meetings = people.filter(p => p.status === 'meeting').sort((a, b) => (a.meetingAt ?? '').localeCompare(b.meetingAt ?? ''));
  if (!open.length && !meetings.length) return '';
  return [`Migration list, ${open.length} to contact, ${meetings.length} with a meeting set (jarvis-migration list shows everyone):`,
    ...open.slice(0, 30).map(p => `- [migration] id=${p.id} ${JSON.stringify(p.name)} dealership=${JSON.stringify(p.dealership)} source=${p.source} since=${p.statusAt}${p.note ? ` note=${JSON.stringify(p.note.slice(0, 160))}` : ''}`),
    ...meetings.slice(0, 15).map(p => `- [migration meeting] id=${p.id} ${JSON.stringify(p.name)} dealership=${JSON.stringify(p.dealership)} at=${p.meetingAt ?? 'not set'}`)].join('\n');
}

/**
 * The routes. `/api/migration/*` act as the owner and sit behind the open-page secret in main.ts. `/api/internal/migration*` is what
 * bin/jarvis-migration calls: add, list, status, meeting time, note, edit and the dealership import. It has no route to remove a person or add a dealership.
 * Undefined when the URL is not one of these.
 */
export function migrationRoute(m: Migration, method: string, url: string, b: any): RouteResult | undefined {
  if (method === 'GET' && (url === '/api/migration' || url === '/api/internal/migration')) return { status: 200, body: { migration: m.state() } };
  if (method !== 'POST') return undefined;
  if (url === '/api/migration/add') return m.add(b, 'owner');
  if (url === '/api/migration/dealer') return m.addDealer(b);
  if (url === '/api/migration/toast-close') return m.closeToast(b);
  if (url === '/api/migration/act') {
    const id = Number(b?.id);
    if (b?.action === 'status') return m.status(id, b, 'owner');
    if (b?.action === 'note') return m.note(id, b, 'owner');
    if (b?.action === 'meeting') return m.meeting(id, b, 'owner');
    if (b?.action === 'edit') return m.edit(id, b, 'owner');
    if (b?.action === 'hide-by') return m.hideBy(id);
    if (b?.action === 'remove') return m.remove(id);
    return { status: 400, body: { error: `unknown action ${b?.action}` } };
  }
  if (url === '/api/internal/migration') return m.add(b, 'jarvis');
  if (url === '/api/internal/migration/dealers') {
    const r = m.importDealers(Array.isArray(b) ? b : b?.dealerships);
    return typeof r === 'string' ? { status: 400, body: { error: r } } : { status: 200, body: { imported: r } };
  }
  const x = /^\/api\/internal\/migration\/(\d+)\/(status|note|meeting|edit)$/.exec(url);
  if (!x) return undefined;
  const id = Number(x[1]);
  return x[2] === 'status' ? m.status(id, b, 'jarvis') : x[2] === 'meeting' ? m.meeting(id, b, 'jarvis') : x[2] === 'edit' ? m.edit(id, b, 'jarvis') : m.note(id, b, 'jarvis');
}
