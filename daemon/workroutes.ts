import { watch as fsWatch } from 'node:fs';
import { OWNER, OWNER_CAP, PRODUCT_KEY, PRODUCT_LABEL } from './config.ts';
import type { Store } from './store.ts';
import type { Log } from './log.ts';
import type { Gate } from './gate.ts';
import type { Native } from './native.ts';
import { ROW_PREFIX } from './native.ts';
import type { Requests } from './requests.ts';
import type { Work, WorkRow } from './work.ts';
import { stop } from './steer.ts';
import { readChatFile, withEvents, fileCursor, type Read, type Line } from './transcript.ts';
import { spokenSentences } from './voice.ts';
import type { RouteResult, Body } from './route.ts';
import { withReadLine } from '../web/compose.js';

// The work list's routes: the list, hiding a row, a "Worked for" row's steps, the transcript pane, and the row buttons
// (Side chat, the steer box, Stop, Open, Desktop, Continue on phone). main.ts tries workRoute from its route table.

/** Rows the owner hid from the app. Hiding only changes the view: no worker is stopped or deleted. */
export const hiddenIds = (store: Pick<Store, 'getState'>): string[] => JSON.parse(store.getState('workHidden') ?? '[]');

/**
 * A native pane that was read is watched: a write to its transcript broadcasts a `pane` event, and the open page reads at
 * once instead of waiting for its 3 s poll. One watcher per file, debounced; dropped when the row leaves the list.
 */
export function makePaneWatcher(o: { native: Pick<Native, 'get'>; broadcast: (ev: object) => void; log: Log }) {
  const paneWatchers = new Map<string, { close: () => void; timer?: NodeJS.Timeout }>();
  return function watchPane(id: string, file: string) {
    if (paneWatchers.has(id)) return;
    try {
      const w = fsWatch(file, () => {
        const p = paneWatchers.get(id); if (!p) return;
        clearTimeout(p.timer);
        p.timer = setTimeout(() => { if (o.native.get(id)) o.broadcast({ type: 'pane', id }); else { p.close(); paneWatchers.delete(id); } }, 300);
      });
      w.on('error', () => { paneWatchers.get(id)?.close(); paneWatchers.delete(id); });
      paneWatchers.set(id, { close: () => w.close() });
    } catch (e) { o.log('pane watch failed', { id, error: (e as Error).message }); }
  };
}

type WorkNative = Pick<Native, 'get' | 'transcriptFile' | 'reply' | 'attach' | 'desktop' | 'phone'>;

/** The Claude session behind a work-list row, for Continue on phone: a native row's own. */
async function phoneTarget(native: Pick<Native, 'get' | 'transcriptFile'>, row: WorkRow): Promise<{ sessionId: string; cwd: string; title: string; transcript?: string } | { error: string }> {
  if (row.tmux) return { error: 'A project terminal has no Claude session to continue.' };
  if (!row.native) return { error: 'Only a native worker can continue on the phone.' };
  const w = native.get(row.native.id);
  if (!w?.session_id) return { error: 'This worker has no session id yet.' };
  return { sessionId: w.session_id, cwd: w.cwd, title: w.remote ?? row.title, transcript: native.transcriptFile(w.id) };
}

export type WorkCtx = {
  native: WorkNative;
  store: Store;
  gate: Pick<Gate, 'pressed' | 'recorded' | 'propose'>;
  requests: Pick<Requests, 'read'>;
  log: Log;
  /** The merged work list: native rows and project terminals. */
  work: () => Work;
  repos: () => { name: string; path: string }[];
  broadcast: (ev: object) => void;
  /** Sends the work list to every open page. */
  publish: () => void;
  /** Moves the requests and the Today rows on from the native rows now, not at the next poll. */
  sync: () => void;
  askChanged: (id: string) => void;
  killed: () => boolean;
  /** Wakes the brain with the text. */
  wake: (text: string) => void;
  watchPane: (id: string, file: string) => void;
  /** Transcript files of finished requests, found once. */
  chatFiles: Map<string, string>;
  readLog: () => string;
};

/**
 * A worker message gets `clips`, the number of sentences read aloud (spokenSentences in voice.ts), so the pane can show
 * its speaker button and play it from /api/speech/worker/<row>/<line>/<i>. A message with nothing to read gets none.
 */
export function withClips<R extends Read>(r: R): R {
  for (const l of r.lines as (Line & { clips?: number })[]) {
    if (l.role !== 'agent' || l.kind) continue;
    const n = spokenSentences(l.text).length;
    if (n) l.clips = n;
  }
  return r;
}

export type SteerCtx = Pick<WorkCtx, 'native' | 'store' | 'work' | 'askChanged' | 'killed' | 'wake' | 'publish' | 'sync'>;

/**
 * One message from the owner to a native worker: the pane's box (/api/work/steer) and its mic (/api/voice with a
 * target). The words go straight into the session (respawned first if its process was stopped). A message with a
 * picture gets the read line (withReadLine in web/compose.js), so a worker started before that line existed reads the
 * file too. The brain's note and the approval log keep the message without it.
 */
export async function steerWorker(o: SteerCtx, id: unknown, text: unknown): Promise<RouteResult> {
  const row = o.work().rows.find(r => r.id === id);
  if (!row || typeof text !== 'string') return { status: 404, body: { error: 'It is not in the work list any more.' } };
  if (!row.native) return { status: 409, body: { error: 'Only a native worker takes a message here.' } };
  const said = text.trim();
  if (!said) return { status: 400, body: { error: 'Write a message first.' } };
  const r = await o.native.reply(row.native.id, withReadLine(said), 'owner');
  if (!r.ok) return { status: 502, body: { error: r.error } };
  const a = o.store.addApproval({ action: 'session-type', args: JSON.stringify({ worker: row.id, text: said }), say: `Message to "${row.title.slice(0, 60)}"` });
  o.store.decide(a.id, 'approved', 'button', said); o.store.finishApproval(a.id, 'done', 'sent');
  const open = o.store.openItems().filter(i => i.source === 'native' && i.dispatch_id === row.id);
  for (const i of open) { o.store.markItem(i.external_id, 'answered', said); o.askChanged(i.external_id); }
  if (!o.killed()) o.wake(`[work list] ${OWNER} sent native worker ${row.native.name} (${row.id}) a message himself from the work list: ${JSON.stringify(said)}.${open.length ? ' That answers its open question.' : ''} Reply SILENT.`);
  o.publish();
  o.sync(); // a request that was Done goes back to Working now, not at the next poll (requests.ts)
  return { status: 200, body: { done: 'sent' } };
}

export async function workRoute(o: WorkCtx, method: string, url: string, body: Body, query: URLSearchParams): Promise<RouteResult | undefined> {
  if (method === 'GET' && url === '/api/work') return { status: 200, body: { ...o.work(), hidden: hiddenIds(o.store), repos: o.repos(), product: { key: PRODUCT_KEY, label: PRODUCT_LABEL }, owner: { called: OWNER, cap: OWNER_CAP } } };
  // Hide or show a row in the app. Only the list of hidden ids changes.
  if (method === 'POST' && url === '/api/work/hide') {
    const { id, hidden } = await body();
    if (typeof id !== 'string' || !id) return { status: 400, body: { error: 'id is required' } };
    const ids = new Set(hiddenIds(o.store));
    ids.delete(id);
    if (hidden !== false) ids.add(id);
    // The newest 500 are kept, so the list cannot grow forever.
    const next = [...ids].slice(-500);
    o.store.setState('workHidden', JSON.stringify(next));
    o.broadcast({ type: 'hidden', hidden: next });
    return { status: 200, body: { hidden: next } };
  }
  // One "Worked for" row's steps, read when the owner opens it.
  const fold = method === 'GET' && url.match(/^\/api\/fold\/(\d+)$/);
  if (fold) {
    const text = o.store.workSteps(Number(fold[1]));
    return text ? { status: 200, body: { steps: JSON.parse(text).steps } } : { status: 404, body: { error: 'Not found' } };
  }
  // The transcript pane: messages after `cursor` from a listed worker or session. Read-only.
  const read = method === 'GET' && url.match(/^\/api\/work\/([^/]+)\/read$/);
  // A request with no listed conversation (`req:<id>`): what Jarvis recorded, then the worker's transcript if it is found.
  const closed = read && /^req:(\d+)$/.exec(decodeURIComponent(read[1]));
  if (closed) {
    const cursor = query.get('cursor') || undefined;
    const r = await o.requests.read(Number(closed[1]), cursor, o.chatFiles, o.readLog);
    return r ? { status: 200, body: r } : { status: 404, body: { error: 'Jarvis has no record of it.' } };
  }
  if (read && decodeURIComponent(read[1]).startsWith(ROW_PREFIX)) {
    // A native worker: its own JSONL on disk. Replies in it are the typed lines (interactive) or the
    // cross-session messages (relay); jarvisd's own events (a resume) are gap lines; `busy` is the session's state.
    const id = decodeURIComponent(read[1]);
    const w = o.native.get(id);
    const file = o.native.transcriptFile(id);
    if (!w) return { status: 404, body: { error: 'It is not in the work list any more.' } };
    const busy = w.state === 'working' || w.state === 'starting';
    if (!file) return { status: 200, body: { lines: [], busy, error: 'No transcript yet: the worker has not written its first turn.' } };
    const cursor = query.get('cursor') || undefined;
    o.watchPane(id, file);
    try { return { status: 200, body: { ...withClips(withEvents(readChatFile(file, fileCursor(cursor)), o.store.eventsFor(id), cursor)), busy } }; }
    catch (e) { return { status: 200, body: { lines: [], busy, error: `Transcript unreadable: ${(e as Error).message}` } }; }
  }
  if (read) return { status: 404, body: { error: 'It is not in the work list any more.' } };
  if (method !== 'POST') return undefined;
  // the owner pressed Side chat: a normal working session in the chosen repo's main checkout, no yes needed.
  if (url === '/api/work/side-chat') {
    // From the new-session picker there is no first message (The owner types it in the conversation that opens) and Worktree may be on.
    const { repo, text = '', worktree } = await body();
    const card = o.repos().find(r => r.path === repo);
    if (typeof text !== 'string' || !card) return { status: 400, body: { error: 'pick a project' } };
    const first = text.trim();
    const a = await o.gate.pressed('side-chat', { repo, text: first, ...(worktree === true ? { worktree: true } : {}) }, `Side chat: ${(first || `new in ${card.name}`).slice(0, 80)}`);
    return { status: a.status === 'done' ? 200 : 502, body: a };
  }
  // The steer box under the transcript. A native worker gets the words at once.
  if (url === '/api/work/steer') {
    const { id, text } = await body();
    return steerWorker(o, id, text);
  }
  if (url === '/api/work/stop') {
    const { id } = await body();
    const row = o.work().rows.find(r => r.id === id);
    if (!row) return { status: 404, body: { error: 'It is not in the work list any more.' } };
    return stop(row, o.gate);
  }
  // Opens a Terminal window on the Mac, attached to a native worker's session.
  if (url === '/api/work/open') {
    const { id, dispatch } = await body();
    const row = o.work().rows.find(r => r.id === (id ?? dispatch));
    if (!row?.native) return { status: 404, body: { error: 'no such worker' } };
    try { await o.native.attach(row.native.id); return { status: 204 }; }
    catch (e) { return { status: 502, body: { error: `Could not open Terminal: ${(e as Error).message}` } }; }
  }
  // The Desktop button: stops the background session and opens the same conversation in the Claude desktop app.
  if (url === '/api/work/desktop') {
    const { id } = await body();
    const row = o.work().rows.find(r => r.id === id);
    if (!row?.native) return { status: 404, body: { error: 'Only a native worker can open in the desktop app.' } };
    try { await o.native.desktop(row.native.id); o.publish(); return { status: 204 }; }
    catch (e) { return { status: 502, body: { error: (e as Error).message } }; }
  }
  // Continue on phone: the row's own Claude session, resumed as a native interactive row with Remote Control on (native.phone).
  // `stop` lists the pids of the processes that held it, which the owner chose to end from the refusal in the pane.
  if (url === '/api/work/phone') {
    const { id, stop: holders } = await body();
    const row = o.work().rows.find(r => r.id === id);
    if (!row) return { status: 404, body: { error: 'It is not in the work list any more.' } };
    const t = await phoneTarget(o.native, row);
    if ('error' in t) return { status: 400, body: { error: t.error } };
    const pids = Array.isArray(holders) ? holders.filter((p: unknown): p is number => Number.isInteger(p) && (p as number) > 1) : [];
    const a = await o.gate.pressed('session-phone', { session: t.sessionId, title: t.title, ...(pids.length ? { stop: pids } : {}) }, `Continue "${t.title.slice(0, 60)}" on the phone`);
    const r = await o.native.phone({ ...t, approvalId: a.id, stop: pids });
    o.gate.recorded(a.id, r.ok ? 'done' : 'failed', r.ok ? (r.already ? 'Already in the Claude app' : `Remote Control as "${r.worker.remote}" (${ROW_PREFIX}${r.worker.id})`) : r.error);
    o.publish();
    if (!r.ok) return { status: 409, body: { error: r.error, holders: r.holders ?? [] } };
    return { status: 200, body: { id: `${ROW_PREFIX}${r.worker.id}`, remote: r.worker.remote, already: !!r.already } };
  }
  return undefined;
}
