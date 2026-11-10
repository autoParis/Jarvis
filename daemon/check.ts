import { DONE_REFS } from './config.ts';
import { OWNER } from './config.ts';
import { execFile } from 'node:child_process';
import { basename } from 'node:path';
import type { Store, Item, Request, OwnerTurn } from './store.ts';
import type { Requests } from './requests.ts';
import { AT_PROMPT, type Work, type WorkRow } from './work.ts';
import { isQuietHours, QUIET_HOURS, sqlTime } from './push.ts';
import { eastern } from './reminders.ts';
import type { Log } from './log.ts';
import { isBrainAsk, checkLine } from './brainasks.ts';

// The ten-minute check: during the day jarvisd reads open asks, workers, requests and reminders in code, and wakes the
// brain only when a new finding or a due reminder needs it. Otherwise there is no model call and nothing said. Gmail has its own watcher.

export const CHECK_MS = 10 * 60_000;
/** A fired reminder is told again this often, inside the check hours, until `jarvis-remind done`. */
export const REMIND_MS = 60 * 60_000;
/** An ask gets this long, past its two pushes (push.ts), before it counts as unanswered. */
export const ASK_WAIT_MS = 15 * 60_000;
/** A message from the owner gets this long, with the brain idle, before it counts as lost. */
export const LOST_MS = 3 * 60_000;
/** `turn` is the lost message a finding reports. */
export type Finding = { key: string; line: string; turn?: number };
/** Master's head and the branches with commits not in master. `worktree` is the checkout a branch is in, if any. */
export type Delivery = { master: string; unmerged: { branch: string; sha: string; worktree?: string }[] };

const git = (repo: string, ...args: string[]) => new Promise<string>((resolve, reject) =>
  execFile('git', ['-C', repo, ...args], { timeout: 10_000 }, (err, out) => err ? reject(err) : resolve(out.trim())));
export const masterHead = (repo: string) => git(repo, 'rev-parse', 'master');
export async function readDelivery(repo: string, done: string[] = DONE_REFS): Promise<Delivery> {
  // A branch merged into one of DONE_REFS (an archived history kept on this Mac) is delivered too. A missing ref falls back to master only.
  const list = (done: string[]) => git(repo, 'for-each-ref', '--no-merged', 'master', ...done.flatMap(r => ['--no-merged', r]), '--format=%(refname:short)%09%(objectname)%09%(worktreepath)', 'refs/heads');
  const [master, refs] = await Promise.all([masterHead(repo), list(done).catch(() => list([]))]);
  return { master, unmerged: refs.split('\n').filter(Boolean).map(l => { const [branch, sha, worktree] = l.split('\t'); return { branch, sha, worktree: worktree || undefined }; }) };
}

/** 8:00 to 15:59 Eastern, every day. The zone follows DST. */
export function inCheckHours(t: number): boolean {
  return !isQuietHours(t, { zone: QUIET_HOURS.zone, start: 16, end: 8 });
}

/** Messages from the owner that waited at least `wait` ms. Reporting one settles it, so it wakes the brain once. */
function lostFindings(turns: OwnerTurn[], now: number, wait: number): Finding[] {
  return turns.flatMap(t => {
    const waited = now - Date.parse(`${t.created_at.replace(' ', 'T')}Z`);
    return waited >= wait ? [{ key: `lost:${t.id}`, turn: t.id, line: `Message from ${OWNER} the brain never answered, sent ${Math.floor(waited / 60_000)} min ago: ${JSON.stringify(t.text.slice(0, 500))}` }] : [];
  });
}

/**
 * What needs judgment right now. Only Jarvis's own workers count: another Run's workers belong to its coordinator.
 * An ask from a worker that is no longer live waits for nobody. A closed request is never open here: `done` and
 * `review` are skipped, and a hidden or removed one is not in `requests`.
 * A branch counts as finished work only when nothing is active in its worktree: no worker of any state, and no
 * session except one Orca shows as Done. `running` is the commit the daemon started from.
 */
export function findings(s: { asks: Item[]; requests: Request[]; rows: WorkRow[]; jarvisRun: string; closing: (id: number) => boolean; now: number; delivery: Delivery; running?: string; lost: OwnerTurn[] }): Finding[] {
  const live = new Set(s.rows.filter(r => r.kind === 'worker').map(r => r.id));
  const asking = new Set(s.asks.map(a => a.dispatch_id));
  const out: Finding[] = [];
  for (const a of s.asks) {
    if (a.dispatch_id && !live.has(a.dispatch_id)) continue;
    const waited = s.now - Date.parse(`${a.created_at.replace(' ', 'T')}Z`);
    if (waited >= ASK_WAIT_MS) out.push({ key: `ask:${a.external_id}`, line: isBrainAsk(a) ? checkLine(a, Math.floor(waited / 60_000)) : `${a.kind} unanswered for ${Math.floor(waited / 60_000)} min: message_id=${a.external_id} dispatch=${a.dispatch_id ?? '?'} subject=${JSON.stringify(a.subject)}` });
  }
  for (const r of s.rows) {
    if (r.kind !== 'worker' || r.sideChat || r.run !== s.jarvisRun) continue;
    const what = r.state === 'exited' ? 'exited without reporting' : r.state === 'idle' ? `stuck: ${r.note}` : r.state === 'waiting' && r.note === AT_PROMPT && !asking.has(r.id) ? 'stuck at a prompt in Orca' : undefined;
    if (what) out.push({ key: `worker:${r.id}:${r.state}`, line: `Worker ${what}: dispatch=${r.id} title=${JSON.stringify(r.title)}` });
  }
  for (const q of s.requests) {
    if (q.status === 'failed') out.push({ key: `failed:${q.id}`, line: `Request failed: ${JSON.stringify(q.title)} dispatch=${q.dispatch_id}` });
    else if ((q.status === 'working' || q.status === 'waiting') && !live.has(q.dispatch_id) && !s.closing(q.id)) out.push({ key: `request:${q.id}`, line: `Request open (${q.status}) with no live worker: ${JSON.stringify(q.title)} dispatch=${q.dispatch_id}` });
  }
  const active = new Set(s.rows.filter(r => r.kind === 'worker' || !r.note?.startsWith('Done')).map(r => r.worktree));
  for (const b of s.delivery.unmerged) {
    if (b.worktree && active.has(basename(b.worktree))) continue;
    out.push({ key: `branch:${b.branch}:${b.sha}`, line: `Branch not merged into master, no live worker: ${b.branch} at ${b.sha.slice(0, 7)} worktree=${b.worktree ?? 'none'}` });
  }
  if (s.running && s.running !== s.delivery.master) out.push({ key: `restart:${s.delivery.master}`, line: `Restart pending: master is at ${s.delivery.master.slice(0, 7)}, the running daemon started from ${s.running.slice(0, 7)}` });
  out.push(...lostFindings(s.lost, s.now, LOST_MS));
  return out;
}

export function makeCheck(o: {
  store: Store; jarvisRun: string; log: Log;
  /** A fresh work poll, so the check never judges an old list. */
  poll: () => Promise<Work>;
  requests: Pick<Requests, 'synced' | 'closing'>;
  /** Reads git. A failure skips the tick, like Orca not answering. */
  delivery: () => Promise<Delivery>;
  running?: string;
  /** A message waiting behind a running turn is not lost: the brain's hang timer ends a turn that stopped. */
  brainBusy: () => boolean;
  /** Sends text to the brain. This is the only model call the check can make. */
  wake: (text: string) => void;
  paused: () => boolean;
  /** Pending support replies (replies.ts). It needs neither Orca nor git, so it runs before them. */
  replies?: () => Promise<void>;
  now?: () => number;
}) {
  const now = o.now ?? Date.now;
  let running = false;
  const wake = (fresh: Finding[]) => {
    o.log('check woke the brain', { findings: fresh.map(f => f.key) });
    o.wake(`[check] Found by jarvisd's ten-minute check. Speak only what needs ${OWNER}; otherwise reply SILENT.\n${fresh.map(f => `- ${f.line}`).join('\n')}`);
  };
  /** Plain SQL, so a tick with nothing due costs no tokens. It needs neither Orca nor git, so it runs before them. */
  const remind = () => {
    const t = sqlTime(now());
    const due = o.store.dueReminders(t, sqlTime(now() - REMIND_MS));
    if (!due.length) return;
    o.log('check told the brain of reminders', { reminders: due.map(r => r.id) });
    o.wake(due.map(r => `[check] Reminder due: ${r.text} (id=${r.id}, due ${eastern(r.due_at)} Eastern${r.status === 'fired' ? ', told before, still not done' : ''})`).join('\n'));
    for (const r of due) o.store.markReminderTold(r.id, t);
  };
  return {
    /**
     * Once at start, at any hour, before the daemon takes messages. The brain's queue is in memory, so a restart lost
     * every unsettled message, however recent: nothing is waiting behind a running turn and LOST_MS does not apply.
     * Only lost messages are read here. Other findings wait for a tick, and `checkSeen` stays as it is.
     */
    start() {
      if (o.paused()) return;
      const lost = lostFindings(o.store.unsettledTurns(), now(), 0);
      if (!lost.length) return;
      wake(lost);
      o.store.settleTurns(lost.flatMap(f => f.turn ?? []));
    },
    /**
     * One tick. Outside the hours it reads and writes nothing. When Orca does not answer it changes nothing, so the next tick decides.
     * Returns 'ran' or 'skipped' (Orca did not answer) for the Scheduled tasks strip, and undefined when no tick ran.
     */
    async tick(): Promise<'ran' | 'skipped' | undefined> {
      if (running || !inCheckHours(now()) || o.paused()) return undefined;
      running = true;
      try {
        remind();
        await o.replies?.().catch(e => o.log('check: support replies failed', { error: String(e) }));
        const work = await o.poll();
        if (work.error) { o.log('check: skipped, Orca did not answer', { error: work.error }); return 'skipped'; }
        await o.requests.synced();
        const delivery = await o.delivery();
        const found = findings({ asks: o.store.openItems(), requests: o.store.requests(), rows: work.rows, jarvisRun: o.jarvisRun, closing: o.requests.closing, now: now(), delivery, running: o.running, lost: o.brainBusy() ? [] : o.store.unsettledTurns() });
        // Each finding wakes the brain once, across restarts. One that clears can come back and wake it again.
        const seen = new Set(JSON.parse(o.store.getState('checkSeen') ?? '[]') as string[]);
        const fresh = found.filter(f => !seen.has(f.key));
        o.store.setState('checkSeen', JSON.stringify(found.map(f => f.key)));
        o.store.setState('checkAt', new Date(now()).toISOString());
        if (fresh.length) wake(fresh);
        // A lost message is reported once. It stays out of later ticks, even ones where the brain is busy.
        o.store.settleTurns(found.flatMap(f => f.turn ?? []));
        return 'ran';
      } finally { running = false; }
    },
  };
}
