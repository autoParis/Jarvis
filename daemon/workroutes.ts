import type { Store } from './store.ts';
import type { Log } from './log.ts';
import type { Requests } from './requests.ts';

// The work list's × (2026-11-12), kept out of main.ts so it can be tested. The × moves a row to Completed, the same as
// a finished worker, and it leaves with Completed's normal purge, a day later. Nothing in Orca or a worktree stops.
// - A request is closed in the requests table (requests.ts): status done, and the poller no longer changes it.
// - A row is kept in `workCompleted` with the time of the press. web/worklist.js keeps it out of its group from then on,
//   and shows it in Completed for a day when no request stands for it there.
// Before this, the × only hid a row, in `workHidden`, for ever. Those rows move to Completed once, at the first read.

export type RouteResult = { status: number; body?: unknown };
type Json = Record<string, any>;

export const COMPLETED_KEY = 'workCompleted';
const HIDDEN_KEY = 'workHidden';
/** A row removed from Completed by hand keeps this time, so it shows nowhere and stays out of its group. */
export const REMOVED_AT = new Date(0).toISOString();
/** The newest this many are kept, so the list cannot grow forever. */
const KEEP = 500;

/** Row id to the time the owner pressed ×, oldest first. Moves the rows hidden before 2026-11-12 in, once. */
export function completedRows(store: Pick<Store, 'getState' | 'setState'>, now = Date.now()): Record<string, string> {
  const saved = store.getState(COMPLETED_KEY);
  if (saved !== undefined) return Object.fromEntries(parse(saved));
  const hidden = parse(store.getState(HIDDEN_KEY) ?? '[]').filter((id): id is string => typeof id === 'string');
  const at = new Date(now).toISOString();
  return save(store, hidden.map(id => [id, at]));
}

function parse(text: string): any[] {
  try { const v = JSON.parse(text); return Array.isArray(v) ? v : []; } catch { return []; }
}

function save(store: Pick<Store, 'setState'>, pairs: [string, string][]): Record<string, string> {
  const kept = pairs.slice(-KEEP);
  store.setState(COMPLETED_KEY, JSON.stringify(kept));
  return Object.fromEntries(kept);
}

export type WorkRouteOptions = {
  store: Pick<Store, 'getState' | 'setState'>; log: Log;
  requests: Pick<Requests, 'close' | 'hide'>;
  /** The completed rows changed; main.ts broadcasts them. */
  changed: (completed: Record<string, string>) => void;
  now?: () => number;
};

/** `POST /api/work/complete` and `POST /api/work/remove`, each with `{ row?, request? }`. Undefined for any other url. */
export async function workRoute(o: WorkRouteOptions, method: string, url: string, body: Json): Promise<RouteResult | undefined> {
  if (method !== 'POST' || (url !== '/api/work/complete' && url !== '/api/work/remove')) return undefined;
  const row = typeof body.row === 'string' && body.row ? body.row : undefined;
  const request = Number.isInteger(body.request) && body.request > 0 ? body.request as number : undefined;
  if (!row && !request) return { status: 400, body: { error: 'row or request is required' } };
  const removing = url === '/api/work/remove';
  // A request already closed or gone is not an error when its row is moved too: the row is what the owner saw.
  const reqOk = request ? removing ? o.requests.hide(request) : o.requests.close(request) : false;
  let completed = completedRows(o.store, o.now?.());
  if (row) {
    const at = removing ? REMOVED_AT : completed[row] ?? new Date(o.now?.() ?? Date.now()).toISOString();
    completed = save(o.store, [...Object.entries(completed).filter(([id]) => id !== row), [row, at]]);
    o.log(removing ? 'work row removed from Completed' : 'work row moved to Completed', { row, ...(request ? { request } : {}) });
    o.changed(completed);
  }
  if (!row && !reqOk) return { status: 404, body: { error: 'It is not in the list any more.' } };
  return { status: 200, body: { completed } };
}
