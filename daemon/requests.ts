import { execFile } from 'node:child_process';
import { basename } from 'node:path';
import type { Store, Approval, Request } from './store.ts';
import type { Work, WorkRow, WorkerInfo } from './work.ts';
import { findPr } from './work.ts';
import type { Log } from './log.ts';
import type { OrcaResult } from './orca.ts';
import { fields, STOP_ANSWER } from './asks.ts';
import { readStopNotice } from './prompt.ts';
import { findWorkerSession, readChatFile, type Read } from './transcript.ts';
import { ROW_PREFIX } from './native.ts';

// The Requests sidebar: one row per thing the owner asked Jarvis for, from the worker start to its PR. A request is
// recorded when the gate starts a worker for him, and its status follows the work poller. Nothing here touches
// a worktree, a session or a branch: removing or hiding a row only marks it in the requests table.

export type RequestStatus = 'waiting' | 'working' | 'review' | 'done' | 'failed';
/** What the app shows for one request. `row` is the work-list row that opens its conversation, if one is listed. */
export type RequestView = { id: number; title: string; words: string | null; status: RequestStatus; at: string; startedAt: string; pr?: string; url?: string; row?: string; report?: boolean };
/** A worker's last report, for the app's report page. `failed` is its own outcome, which can differ from the request's status. */
export type RequestReport = { id: number; title: string; status: string; at: string; subject: string; body: string; failed: boolean };

/** Worker starts that answer something the owner asked for, research questions included. Side chats live in their own
 * Orca tab, so they are not tracked. */
export const REQUEST_ACTIONS = new Set(['worker-start', 'question', 'today-start', 'today-draft']);
/** A Today draft runs read-only in the main checkout like a question, and a Today run in its own worktree like a worker-start. */
const REQUEST_KIND: Record<string, string> = { 'today-start': 'worker-start', 'today-draft': 'question' };
/** A done request is removed once it has been done this long, whether or not its conversation is still listed. */
export const DONE_KEEP_MS = 24 * 60 * 60_000;
/** A working request whose worker is missing from this many polls in a row is over. */
export const ABSENT_POLLS = 2;
const PR_CHECK_MS = 5 * 60_000;
const BACKFILL_KEY = 'requestsSessionBackfill';

/** The title as shown: Jarvis sometimes starts a task title with "Request:" or "Requests:", which the list does not need. */
export function shownTitle(title: string): string {
  return title.replace(/^\s*requests?\s*:\s*/i, '') || title;
}

const json = (s: string | null): any => { try { return JSON.parse(s ?? ''); } catch { return undefined; } };

/** The request a finished worker-start or question approval created, or undefined when no worker started. A question has no taskTitle unless Jarvis gave one, so it shows what Jarvis said. */
export function requestFromApproval(a: Approval, words: string | undefined): Parameters<Store['addRequest']>[0] | undefined {
  if (!REQUEST_ACTIONS.has(a.action) || a.status !== 'done') return undefined;
  const res = json(a.result);
  // An Orca start names its dispatch; a native start names its worker, `n:<id>`, which is also its work-list row.
  const dispatch = res?.dispatchId ?? (typeof res?.worker === 'string' && res.worker.startsWith(ROW_PREFIX) ? res.worker : undefined);
  if (typeof dispatch !== 'string') return undefined;
  const args = json(a.args) ?? {};
  return { dispatch_id: dispatch, approval_id: a.id, action: REQUEST_KIND[a.action] ?? a.action, title: String(args.taskTitle || a.say), words: words ?? null };
}

/** Records the request for a worker the gate just started. The owner's words are his last message before the proposal. */
export function recordRequest(store: Store, a: Approval): boolean {
  const r = requestFromApproval(a, a.after_turn ? store.turnText(a.after_turn) : undefined);
  return !!r && store.addRequest(r);
}

/** Work started before the requests table existed: every worker the gate started in the last `days` days. */
export function backfillRequests(store: Store, days = 3): number {
  const actions = [...REQUEST_ACTIONS];
  const old = store.db.prepare(`SELECT * FROM approvals WHERE action IN (${actions.map(() => '?').join()}) AND status = 'done'
    AND created_at > datetime('now', ?) ORDER BY id`).all(...actions, `-${days} days`) as Approval[];
  let n = 0;
  for (const a of old) {
    const r = requestFromApproval(a, a.after_turn ? store.turnText(a.after_turn) : undefined);
    if (r && store.addRequest({ ...r, created_at: a.created_at })) n++;
  }
  return n;
}

/** One line of a request's history. Times are ISO, UTC. */
export type HistoryEntry = { at: string; kind: 'question' | 'escalation' | 'worker_done' | 'approval' | 'status'; title: string; text?: string; answer?: string; answeredAt?: string; answeredBy?: 'jarvis'; failed?: boolean };
/** What Jarvis still knows about a request, from `requests`, `items`, `approvals` and the daemon's log. */
export type RequestDetail = { id: number; title: string; words: string | null; status: string; at: string; startedAt: string; worktree?: string; pr?: string; url?: string; history: HistoryEntry[]; transcript?: boolean };

const iso = (t: string) => t.includes('T') ? t : `${t.replace(' ', 'T')}Z`;
const APPROVAL_TITLE: Record<string, string> = { 'worker-start': 'Worker start', question: 'Question worker start', 'worker-stop': 'Worker stop', 'worker-send': 'Message to the worker', 'today-start': 'Worker start from Today', 'today-draft': 'Story draft from Today' };

function itemEntry(i: { external_id: string; kind: string; subject: string | null; body: string | null; answer: string | null; created_at: string; updated_at: string | null; meta: string | null }): HistoryEntry {
  const answer = i.answer ? { answer: i.answer, ...(i.updated_at ? { answeredAt: iso(i.updated_at) } : {}), ...(i.answered_by === 'jarvis' ? { answeredBy: 'jarvis' as const } : {}) } : {};
  const at = iso(i.created_at);
  if (i.kind === 'worker_done') {
    const outcome = json(i.meta)?.outcome;
    return { at, kind: 'worker_done', title: `Worker done${outcome ? `, ${outcome}` : ''}: ${i.subject ?? ''}`, text: i.body ?? '', failed: !!outcome && outcome !== 'succeeded', ...answer };
  }
  if (i.kind === 'question') {
    const f = fields(i.body ?? '');
    return { at, kind: 'question', title: 'Question', text: [f.QUESTION, f.CONTEXT].filter(Boolean).join('\n\n') || i.body || '', ...answer };
  }
  if (i.external_id.startsWith('msg_stop_')) {
    const n = readStopNotice(i.body);
    return { at, kind: 'escalation', title: n.kind === 'prompt' ? 'Stopped at a prompt' : 'Stopped without reporting', text: n.output, ...answer };
  }
  return { at, kind: 'escalation', title: i.subject || 'Escalation', text: i.body ?? '', ...answer };
}

/** `log` is the text of data/jarvisd.log, for the moment a request closed. A rotated log only loses those lines. */
export function requestDetail(store: Store, id: number, log = ''): RequestDetail | undefined {
  const r = store.request(id);
  if (!r) return undefined;
  const items = store.db.prepare(`SELECT external_id, kind, subject, body, answer, created_at, updated_at, meta FROM items WHERE dispatch_id = ? ORDER BY id`).all(r.dispatch_id) as Parameters<typeof itemEntry>[0][];
  // A spec can quote any dispatch id, so an approval counts only when its own arguments or result name this one.
  const approvals = (store.db.prepare(`SELECT * FROM approvals WHERE args LIKE '%' || ? || '%' OR result LIKE '%' || ? || '%' ORDER BY id`).all(r.dispatch_id, r.dispatch_id) as Approval[])
    .filter(a => json(a.args)?.dispatch === r.dispatch_id || json(a.result)?.dispatchId === r.dispatch_id);
  const history: HistoryEntry[] = [
    ...approvals.map((a): HistoryEntry => ({
      at: iso(a.decided_at ?? a.created_at), kind: 'approval', title: `${APPROVAL_TITLE[a.action] ?? a.action}: ${a.status}${a.decided_by ? ` by ${a.decided_by}` : ''}`,
      text: a.say, failed: a.status === 'failed' || a.status === 'unknown',
    })),
    ...items.map(itemEntry),
  ];
  for (const line of log.split('\n')) {
    if (!line.includes(' request status ') || !line.includes(r.dispatch_id)) continue;
    const e = json(line.slice(line.indexOf('{')));
    if (e?.dispatch === r.dispatch_id && !['working', 'waiting'].includes(e.to)) history.push({ at: line.slice(0, line.indexOf(' ')), kind: 'status', title: `Status: ${e.from} to ${e.to}`, failed: e.to === 'failed' });
  }
  history.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  // A worker stopped before worker_done never reports its PR, but a stop notice can still hold the link. Only a full link counts.
  const seen = r.pr ? undefined : [...items].reverse().map(i => findPr(i.body ?? '')).find(f => f.url);
  return {
    id: r.id, title: shownTitle(r.title), words: r.words, status: r.status, at: iso(r.status_at), startedAt: iso(r.created_at),
    ...(r.worktree ? { worktree: r.worktree } : {}), ...(r.pr ?? seen?.pr ? { pr: (r.pr ?? seen?.pr)! } : {}), ...(r.pr_url ?? seen?.url ? { url: (r.pr_url ?? seen?.url)! } : {}), history,
  };
}

// A worker_done with only spaces in its body has nothing to read, so it counts as no report.
const HAS_BODY = `kind = 'worker_done' AND TRIM(COALESCE(body, ''), ' ' || char(9, 10, 13)) <> ''`;

/** The last worker_done with a body for this request, or undefined when it has none. Works on hidden and removed requests too. */
export function requestReport(store: Store, id: number): RequestReport | undefined {
  const r = store.request(id);
  if (!r) return undefined;
  const i = store.db.prepare(`SELECT subject, body, meta, created_at FROM items WHERE dispatch_id = ? AND ${HAS_BODY} ORDER BY id DESC LIMIT 1`)
    .get(r.dispatch_id) as { subject: string | null; body: string; meta: string | null; created_at: string } | undefined;
  // A native worker's report is on its own row, never in items.
  const n = i ?? nativeReport(store, r.dispatch_id);
  if (!n?.body.trim()) return undefined;
  const outcome = json(n.meta)?.outcome;
  return { id: r.id, title: shownTitle(r.title), status: r.status, at: iso(n.created_at), subject: n.subject ?? '', body: n.body, failed: failing(outcome) };
}

/** The listed row that is this request's conversation: its live worker, then its chat session, then a session in its worktree. */
export function conversation(r: Pick<Request, 'dispatch_id' | 'session' | 'worktree'>, rows: WorkRow[]): WorkRow | undefined {
  return rows.find(x => x.id === r.dispatch_id)
    ?? (r.session ? rows.find(x => x.id === `s:${r.session}`) : undefined)
    ?? (r.worktree ? rows.find(x => x.kind === 'session' && x.worktree === r.worktree) : undefined);
}

/** A native worker's last DONE or FAILED report, shaped like a worker_done item. Native reports live on the worker row
 * (native.ts), never in `items`. Undefined for an Orca dispatch or a native worker with no outcome yet. */
function nativeReport(store: Store, dispatch: string): { subject: string; body: string; meta: string; created_at: string } | undefined {
  if (!dispatch.startsWith(ROW_PREFIX)) return undefined;
  const w = store.nativeWorker(dispatch.slice(ROW_PREFIX.length));
  if (!w?.outcome || !w.report) return undefined;
  // report_at is ISO; the stop check compares it with database times, 'YYYY-MM-DD HH:MM:SS'.
  const at = (w.report_at ?? w.updated_at).replace('T', ' ').replace(/\.\d+Z?$|Z$/, '');
  return { subject: w.name, body: w.report, meta: JSON.stringify({ outcome: w.outcome === 'done' ? 'succeeded' : 'failed' }), created_at: at };
}

/**
 * A native worker's worktree folder name, or undefined when it runs in the repo's main checkout (a question, a draft,
 * `worktree: main`): that folder is not its own, and other sessions there are not its conversation.
 */
function nativeWorktree(store: Store, nw: { cwd: string; repo?: string | null; approval_id: number | null }): string | undefined {
  let repo = nw.repo ?? undefined;
  if (!repo && nw.approval_id) { try { repo = JSON.parse(store.approval(nw.approval_id)?.args ?? '{}').repo; } catch {} }
  const trim = (p: string) => p.replace(/\/+$/, '');
  return typeof repo === 'string' && trim(repo) === trim(nw.cwd) ? undefined : basename(nw.cwd);
}

/** True when the owner or the brain sent a native worker more work after its last report: the report no longer settles it. */
function repliedAfter(store: Store, dispatch: string, reportAt: string): boolean {
  if (!dispatch.startsWith(ROW_PREFIX)) return false;
  return !!store.db.prepare(`SELECT 1 FROM items WHERE source = 'native' AND kind = 'reply' AND dispatch_id = ? AND created_at > ? LIMIT 1`).get(dispatch, reportAt);
}

const failing = (outcome: string | undefined) => !!outcome && outcome !== 'succeeded' && outcome !== 'in_progress';

/**
 * The status the work list implies, or undefined when it says nothing new (the worker is no longer listed by Orca).
 * `prOpen` is the last known PR state: true open, false merged or closed, undefined not checked yet.
 */
export function statusOf(row: WorkRow | undefined, outcome: string | undefined, isLive: boolean, pr: string | null, prOpen: boolean | undefined, finished: boolean): RequestStatus | undefined {
  if (row?.state === 'waiting') return 'waiting';
  if (isLive) return row?.state === 'exited' ? 'failed' : 'working';
  if (failing(outcome)) return 'failed';
  if (outcome === 'succeeded' || finished) return pr && prOpen !== false ? 'review' : 'done';
  return undefined;
}

/** When the owner first stopped this worker, as a database time: a `worker-stop` that went through, or Stop on an ask card. */
function stoppedAt(store: Store, dispatch: string): string | null {
  return (store.db.prepare(`SELECT MIN(at) AS at FROM (
    SELECT COALESCE(decided_at, created_at) AS at FROM approvals WHERE action = 'worker-stop' AND status = 'done' AND CASE WHEN json_valid(args) THEN json_extract(args, '$.dispatch') END = ?
    UNION ALL SELECT updated_at FROM items WHERE dispatch_id = ? AND answer = ?)`).get(dispatch, dispatch, STOP_ANSWER) as { at: string | null }).at;
}

/** `gh pr view` for a PR link: true open, false merged or closed, undefined when gh did not answer. */
function ghPrOpen(url: string): Promise<boolean | undefined> {
  return new Promise(resolve => execFile('gh', ['pr', 'view', url, '--json', 'state'], { timeout: 15_000 }, (err, out) => {
    const state = !err && json(out)?.state;
    resolve(state === 'OPEN' ? true : state === 'MERGED' || state === 'CLOSED' ? false : undefined);
  }));
}

export function makeRequests(opts: {
  store: Store; log: Log;
  /** For finding a worker's session and worktree. Without it, only what `sync` is handed is recorded. */
  orca?: (args: string[]) => Promise<OrcaResult>;
  /** The folders a transcript may be read from. The default is Claude's and Codex's. */
  transcriptDirs?: string[];
  /** GitHub web URL of a checkout, to turn "PR #12" into a link (work.ts githubRepo). */
  repoOf: (dir: string) => Promise<string | undefined>;
  prOpen?: (url: string) => Promise<boolean | undefined>;
  onChange: (list: RequestView[]) => void;
  now?: () => number;
}) {
  const { store, log } = opts;
  const now = opts.now ?? Date.now;
  const prOpen = opts.prOpen ?? ghPrOpen;
  const prChecks = new Map<number, { at: number; open?: boolean }>();
  // Polls in a row an open request's worker was missing. Only a poll where every Run answered counts.
  const absent = new Map<number, number>();
  // Requests already searched for a session since the start, so a closed one is not searched at every poll.
  const searched = new Set<number>();
  const findSession = (dispatch: string, cwd?: string) => opts.orca && !dispatch.startsWith(ROW_PREFIX) ? findWorkerSession(opts.orca, dispatch, { cwd, dirs: opts.transcriptDirs }) : Promise.resolve(undefined);
  let rows: WorkRow[] = [];
  let last = '';
  let syncing: Promise<void> | undefined;

  function list(): RequestView[] {
    const reported = new Set((store.db.prepare(`SELECT DISTINCT dispatch_id FROM items WHERE dispatch_id IS NOT NULL AND ${HAS_BODY}`).all() as { dispatch_id: string }[]).map(i => i.dispatch_id));
    return store.requests().map(r => {
      // A native request's dispatch is its work-list row, listed from the moment the worker starts, before the next poll.
      const fresh = r.dispatch_id.startsWith(ROW_PREFIX) && (r.status === 'working' || r.status === 'waiting') ? { id: r.dispatch_id } : undefined;
      const row = conversation(r, rows) ?? fresh;
      const hasReport = reported.has(r.dispatch_id) || !!nativeReport(store, r.dispatch_id)?.body.trim();
      return {
        id: r.id, title: shownTitle(r.title), words: r.words, status: r.status as RequestStatus, at: `${r.status_at.replace(' ', 'T')}Z`, startedAt: `${r.created_at.replace(' ', 'T')}Z`,
        ...(r.pr ? { pr: r.pr } : {}), ...(r.pr_url ? { url: r.pr_url } : {}), ...(row ? { row: row.id } : {}), ...(hasReport ? { report: true } : {}),
      };
    });
  }

  function publish() {
    const next = list();
    const key = JSON.stringify(next);
    if (key !== last) { last = key; opts.onChange(next); }
  }

  async function sync(work: Work, workers: WorkerInfo[], complete: boolean, only?: (r: Request) => boolean) {
    rows = work.rows;
    const byDispatch = new Map(workers.map(w => [w.dispatch, w]));
    for (const r of store.requests()) {
      if (only && !only(r)) continue;
      const w = byDispatch.get(r.dispatch_id);
      // A native worker is not in Orca's list: its folder and session are on its own row (native.ts), as Orca's are on w.
      const nw = r.dispatch_id.startsWith(ROW_PREFIX) ? store.nativeWorker(r.dispatch_id.slice(ROW_PREFIX.length)) : undefined;
      const f: Parameters<Store['updateRequest']>[1] = {};
      const path = w?.path ?? nw?.cwd;
      // A question runs read-only in the repo's main checkout. Other sessions there are not its conversation, and a
      // PR it names in its answer is not its own, so it takes no worktree and no PR. Nor does a native worker in the main checkout.
      const question = r.action === 'question';
      const worktree = nw ? nativeWorktree(store, nw) : path && basename(path);
      if (worktree && !question && worktree !== r.worktree) f.worktree = worktree;
      const session = w?.session ?? nw?.session_id;
      if (session && session !== r.session) f.session = session;
      const cur = { ...r, ...f };
      const row = conversation(cur, rows);

      // The PR: the link the worker wrote in worker_done, else the PR Orca linked to its workspace.
      const doneMsg = store.db.prepare(`SELECT subject, body, meta, created_at FROM items WHERE kind = 'worker_done' AND dispatch_id = ? ORDER BY id DESC LIMIT 1`)
        .get(r.dispatch_id) as { subject: string; body: string; meta: string | null; created_at: string } | undefined
        ?? nativeReport(store, r.dispatch_id);
      if (!r.pr && !question) {
        const found = doneMsg ? findPr(`${doneMsg.subject}\n${doneMsg.body}`) : {};
        const pr = found.pr ?? row?.pr ?? (row?.label?.startsWith('PR #') ? row.label : undefined);
        if (pr) {
          f.pr = pr;
          f.pr_url = found.url ?? (path ? await opts.repoOf(path).then(repo => repo && `${repo}/pull/${pr.slice(4)}`).catch(() => undefined) : undefined);
        }
      }

      // A native worker sent more work after its DONE or FAILED is working again until its next report: that report
      // no longer settles the request. Its PR link still counts.
      // native.ts keeps one report column: a later turn that only asks something replaces the text but not the outcome.
      const final = !r.dispatch_id.startsWith(ROW_PREFIX) || /^\s*(DONE|FAILED)\b/i.test(doneMsg?.body ?? '');
      const settled = doneMsg && final && !repliedAfter(store, r.dispatch_id, doneMsg.created_at) ? doneMsg : undefined;
      // A native worker's row stays listed for a day after its DONE or FAILED line, so once it has reported it is not live.
      const isLive = rows.some(x => x.id === r.dispatch_id) && !(r.dispatch_id.startsWith(ROW_PREFIX) && settled);
      // Orca settles a worker's outcome when it finishes, so in progress without a live row is a dropped row, the same as not listed.
      const unsettled = !w || !w.outcome || w.outcome === 'in_progress';
      const open = r.status === 'working' || r.status === 'waiting';
      if (!open || isLive || !unsettled) absent.delete(r.id);
      else if (complete) absent.set(r.id, (absent.get(r.id) ?? 0) + 1);
      const over = (absent.get(r.id) ?? 0) >= ABSENT_POLLS;
      const reported = json(settled?.meta ?? null)?.outcome;
      const outcome = unsettled ? reported ?? w?.outcome : w.outcome;

      // Orca settles a stopped worker as failed, but the owner ending it is not a failure. A failure from before the stop still is.
      // The ask card's Stop is only a message, so that worker counts as stopped once it has ended.
      const stopAt = stoppedAt(store, r.dispatch_id);
      const failedFirst = !!stopAt && ((r.status === 'failed' && r.status_at < stopAt) || (failing(reported) && settled!.created_at < stopAt));
      const ended = !unsettled || over || !!settled || row?.state === 'exited' || r.status === 'failed';
      const stopped = !!stopAt && !failedFirst && ended;

      const pr = f.pr ?? r.pr, url = f.pr_url ?? r.pr_url;
      let check = prChecks.get(r.id);
      if (url && r.status !== 'done' && (!check || now() - check.at >= PR_CHECK_MS) && (w?.outcome === 'succeeded' || settled || over || stopped)) {
        check = { at: now(), open: await prOpen(url).catch(() => undefined) ?? check?.open };
        prChecks.set(r.id, check);
      }
      // Done after a merge stays done: the PR check is in memory, and a restart must not reopen it as "in review".
      const status = statusOf(row, stopped ? undefined : outcome, isLive && !stopped, pr, r.status === 'done' ? false : check?.open, !!settled || over || stopped);
      if (status && status !== r.status) { f.status = status; log('request status', { request: r.id, dispatch: r.dispatch_id, from: r.status, to: status }); }

      // A done request leaves 24 hours after it became done, by its status_at. Never while Orca is not answering, for an
      // Orca request: a native one is settled by its own row, which needs no Orca.
      if (r.status === 'done' && !f.status && (!work.error || !!nw) && now() - Date.parse(`${r.status_at.replace(' ', 'T')}Z`) >= DONE_KEEP_MS) {
        f.removed = true;
        log('request removed a day after done', { request: r.id, dispatch: r.dispatch_id });
      }
      // Orca names only a chat-tab worker's session, so any other is looked up, as soon as there is a folder and at each status change.
      if (!cur.session && path && (open || f.status || !searched.has(r.id))) {
        searched.add(r.id);
        const s = await findSession(r.dispatch_id, path);
        if (s) { f.session = s.session; log('request session found', { request: r.id, dispatch: r.dispatch_id, session: s.session }); }
      }
      store.updateRequest(r.id, f);
    }
    publish();
  }

  /** Asks Orca about one request's worker and fills what is empty. It never overwrites, and works on a stopped worker. */
  async function fill(r: Request): Promise<void> {
    if (r.dispatch_id.startsWith(ROW_PREFIX)) {
      // A native worker is not Orca's: what it knows is on its own row.
      const w = store.nativeWorker(r.dispatch_id.slice(ROW_PREFIX.length));
      const f: Parameters<Store['updateRequest']>[1] = {};
      if (!r.session && w?.session_id) f.session = w.session_id;
      if (!r.worktree && w && r.action !== 'question') f.worktree = basename(w.cwd);
      if (f.worktree || f.session) { store.updateRequest(r.id, f); log('request filled', { request: r.id, dispatch: r.dispatch_id, ...f }); }
      return;
    }
    if (!opts.orca ||(r.session && (r.worktree || r.action === 'question'))) return;
    const show = await opts.orca(['orchestration', 'worker-show', '--dispatch', r.dispatch_id, '--full']).catch(() => undefined);
    const res = show?.ok ? show.result : undefined;
    const path: string | undefined = (res?.worker?.worktreeId ?? res?.terminalResource?.worktreeId)?.split('::')[1];
    const inc: string | undefined = res?.terminalResource?.endpointIncarnation;
    const f: Parameters<Store['updateRequest']>[1] = {};
    if (!r.worktree && path && r.action !== 'question') f.worktree = basename(path);
    if (!r.session) {
      const session = inc?.startsWith('structured:') ? inc.slice(11) : (await findSession(r.dispatch_id, path))?.session;
      if (session) f.session = session;
    }
    if (f.worktree || f.session) { store.updateRequest(r.id, f); log('request filled', { request: r.id, dispatch: r.dispatch_id, ...f }); }
  }

  const api = {
    list,
    /** After every work poll. Overlapping polls share one sync. `only` limits it to some requests (the native ones while Orca is silent). */
    sync(work: Work, workers: WorkerInfo[], complete = true, only?: (r: Request) => boolean): Promise<void> {
      syncing ??= sync(work, workers, complete, only).catch(e => log(`requests: sync failed: ${e}`)).finally(() => { syncing = undefined; });
      return syncing;
    },
    /** Resolves when the sync running now, if any, has finished. */
    synced: (): Promise<void> => syncing ?? Promise.resolve(),
    /** True while this request's worker is missing but the request has not closed yet. */
    closing: (id: number): boolean => absent.has(id),
    /** the owner hid a row. Only the requests table changes. */
    hide(id: number): boolean {
      const ok = store.hideRequest(id);
      if (ok) { log('request hidden', { request: id }); publish(); }
      return ok;
    },
    /** A worker the gate just started for the owner. Its worktree is known at once; its session may need a later poll. */
    started(a: Approval) {
      if (recordRequest(store, a)) { log('request recorded', { approval: a.id, action: a.action }); publish(); }
      const dispatch = json(a.result)?.dispatchId;
      if (REQUEST_ACTIONS.has(a.action) && typeof dispatch === 'string') return api.capture(dispatch);
      return Promise.resolve();
    },
    /** Records what Orca knows about this dispatch's worker now. The gate calls it when a stop goes through. */
    async capture(dispatch: string): Promise<void> {
      const r = store.db.prepare('SELECT * FROM requests WHERE dispatch_id = ?').get(dispatch) as Request | undefined;
      if (r) await fill(r).catch(e => log(`requests: capture failed: ${e}`));
    },
    /** One time only: fills session and worktree on every earlier request where Orca still knows them. `state` says it ran. */
    async backfill(): Promise<number> {
      if (!opts.orca || store.getState(BACKFILL_KEY)) return 0;
      // Orca down at this start proves nothing, so the next start tries again.
      const up = await opts.orca(['orchestration', 'run-list', '--limit', '1']).catch(() => undefined);
      if (!up?.ok) { log('requests: backfill waits, Orca did not answer'); return 0; }
      let n = 0;
      for (const r of store.allRequests()) {
        const was = `${r.session ?? ''}|${r.worktree ?? ''}`;
        await fill(r).catch(e => log(`requests: backfill failed: ${e}`));
        const after = store.request(r.id)!;
        if (`${after.session ?? ''}|${after.worktree ?? ''}` !== was) n++;
      }
      store.setState(BACKFILL_KEY, new Date(now()).toISOString());
      log('requests: backfill done', { filled: n });
      return n;
    },
    /** A request with no listed conversation, read-only: the record on the first read, and the transcript if it can be found. */
    async read(id: number, cursor: string | undefined, files: Map<string, string>, readLog: () => string = () => ''): Promise<(Read & { detail?: RequestDetail }) | undefined> {
      let r = store.request(id);
      if (!r) return undefined;
      if (!cursor && !r.session) { await fill(r).catch(e => log(`requests: fill failed: ${e}`)); r = store.request(id)!; }
      let file = r.session ? files.get(r.session) : undefined;
      if (!file && r.session && r.dispatch_id.startsWith(ROW_PREFIX)) {
        file = store.nativeWorker(r.dispatch_id.slice(ROW_PREFIX.length))?.transcript ?? undefined;
        if (file) files.set(r.session, file);
      } else if (!file && r.session && opts.orca) {
        file = (await findWorkerSession(opts.orca, r.dispatch_id, { known: r.session, dirs: opts.transcriptDirs }))?.file;
        if (file) files.set(r.session, file);
      }
      const detail = cursor ? undefined : requestDetail(store, id, readLog());
      if (detail) detail.transcript = !!file;
      if (!file) return { lines: [], ...(detail ? { detail } : {}) };
      try { return { ...readChatFile(file, cursor), ...(detail ? { detail } : {}) }; }
      catch (e) {
        files.delete(r.session!);
        log('requests: transcript unreadable', { request: id, error: String(e) });
        if (detail) detail.transcript = false;
        return { lines: [], ...(detail ? { detail } : {}) };
      }
    },
  };
  return api;
}

export type Requests = ReturnType<typeof makeRequests>;
