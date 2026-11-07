import { QUIET_HOURS, sqlTime } from './push.ts';
import { inCheckHours } from './check.ts';
import type { Store, Reminder } from './store.ts';
import type { Log } from './log.ts';

// Reminders: bin/jarvis-remind relays here, and the check in check.ts tells the brain when one is due.

const ISO = /^(\d{4})-(\d\d)-(\d\d)T\d\d:\d\d(:\d\d(\.\d+)?)?(Z|[+-]\d\d:\d\d)$/;
const UNITS = { d: 86_400_000, h: 3_600_000, m: 60_000 };

/**
 * The instant for `--due`: an ISO time with its offset, or `+` and a duration such as +90m, +2h or +1d4h.
 * A time with no offset is refused, because reading it in the wrong zone would fire the reminder hours off with no error.
 */
export function parseDue(due: unknown, now: number): number {
  if (typeof due !== 'string') throw new Error('--due is required');
  if (due.startsWith('+')) {
    const m = due.match(/^\+(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?$/);
    const ms = m ? Number(m[1] ?? 0) * UNITS.d + Number(m[2] ?? 0) * UNITS.h + Number(m[3] ?? 0) * UNITS.m : 0;
    if (!ms) throw new Error(`bad duration ${due}: use +90m, +2h or +1d4h`);
    return now + ms;
  }
  const m = due.match(ISO);
  if (!m) throw new Error(`bad time ${due}: use ISO with an offset, like 2026-11-03T15:00:00-05:00, or a duration like +2h`);
  const t = Date.parse(due);
  // V8 accepts February 31 and rolls it into March.
  const day = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (Number.isNaN(t) || day.getUTCDate() !== Number(m[3])) throw new Error(`bad time ${due}: no such date`);
  if (t <= now) throw new Error(`${due} has already passed`);
  return t;
}

/** A UTC time from the database as the owner's clock reads it, like "Nov 3, 10:00 AM". */
export function eastern(sql: string): string {
  return new Date(`${sql.replace(' ', 'T')}Z`).toLocaleString('en-US', { timeZone: QUIET_HOURS.zone, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).replace(/\u202f/g, ' ');
}

const shown = (r: Reminder) => ({ ...r, due_eastern: eastern(r.due_at) });

/** The internal routes jarvis-remind calls. Undefined when the URL is not one of them. */
export function reminderRoute(store: Store, log: Log, method: string, url: string, b: { due?: unknown; text?: unknown }, now = Date.now()): { status: number; body: unknown } | undefined {
  if (method === 'GET' && url === '/api/internal/reminders') return { status: 200, body: store.openReminders().map(shown) };
  if (method === 'POST' && url === '/api/internal/reminders') {
    const text = typeof b.text === 'string' ? b.text.replace(/\s+/g, ' ').trim() : '';
    if (!text) return { status: 400, body: { error: '--text is required' } };
    let due: number;
    try { due = parseDue(b.due, now); } catch (e) { return { status: 400, body: { error: (e as Error).message } }; }
    const r = store.addReminder(text, sqlTime(due));
    log('reminder added', { reminder: r.id, due_at: r.due_at });
    return { status: 200, body: { ...shown(r), ...(inCheckHours(due) ? {} : { note: 'Due outside the check hours, so the owner first hears it at the next 8 AM Eastern.' }) } };
  }
  const done = method === 'POST' && url.match(/^\/api\/internal\/reminders\/(\d+)\/done$/);
  if (done) {
    const r = store.doneReminder(Number(done[1]), sqlTime(now));
    if (!r) return { status: 404, body: { error: `no reminder ${done[1]}` } };
    log('reminder done', { reminder: r.id });
    return { status: 200, body: shown(r) };
  }
  return undefined;
}
