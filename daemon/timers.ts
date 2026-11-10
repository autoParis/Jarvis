import type { Log } from './log.ts';

// jarvisd's own timers, one start function each. main.ts calls each one where the thing it ticks is made, so the start
// order is the order of the file. Each sets its interval first, then runs its first pass where it has one.

export const NATIVE_POLL_MS = 30_000;
export const TASKS_SAMPLE_MS = 60_000;
export const PUSH_SWEEP_MS = 30_000;
export const TERM_POLL_MS = 15_000;

type Record = (id: string, outcome: 'ok' | 'fail', note?: string) => void;

/**
 * Native workers: `claude agents` every 30 s (native.ts poll). After each poll, the asks a later answer closed leave the
 * open list, then the requests and the Today rows follow the native rows.
 */
export function startNativePoll(o: { poll: () => Promise<unknown>; closeEarlier: () => void; sync: () => Promise<void>; log: Log }) {
  const run = () => o.poll().then(() => {
    o.closeEarlier();
    return o.sync();
  }).catch(e => o.log(`native poll failed: ${e}`));
  setInterval(run, NATIVE_POLL_MS);
  run();
}

/** The Scheduled tasks screen: a sample of the launchd jobs every minute (tasks.ts). The kill switch skips it. */
export function startTaskSampler(o: { sample: () => Promise<unknown>; killed: () => boolean; log: Log }) {
  const run = () => { if (!o.killed()) o.sample().catch(e => o.log(`tasks: sample failed: ${e}`)); };
  setInterval(run, TASKS_SAMPLE_MS);
  run();
}

/** Push: pushes held for quiet hours, then open asks and escalations the owner has not answered (rules in push.ts). One sweep at a time. */
export function startPushSweep(o: { flush: () => Promise<unknown>; openAsks: () => Promise<unknown>; killed: () => boolean; log: Log }) {
  let sweeping = false;
  setInterval(async () => {
    if (sweeping || o.killed()) return;
    sweeping = true;
    try { await o.flush(); await o.openAsks(); } catch (e) { o.log(`push sweep: ${e}`); } finally { sweeping = false; }
  }, PUSH_SWEEP_MS);
}

/** The ten-minute check (check.ts). A tick that ran records ok on the Scheduled tasks screen, a failure records why. */
export function startCheck(o: { check: { tick: () => Promise<unknown>; start: () => void }; everyMs: number; record: Record; log: Log }) {
  setInterval(() => {
    o.check.tick().then(r => { if (r) o.record('jarvisd:check', 'ok'); },
      e => { o.log(`check: ${e}`); o.record('jarvisd:check', 'fail', String(e).slice(0, 300)); });
  }, o.everyMs);
  o.check.start();
}

/** The Today list backstop (today.ts): catches items an event missed. The first pass runs at start. The kill switch skips a tick. */
export function startTodayBackstop(o: { today: { tick: () => Promise<unknown>; pass: (why: string) => Promise<unknown> }; everyMs: number; killed: () => boolean; record: Record; log: Log }) {
  setInterval(() => {
    if (o.killed()) return;
    o.today.tick().then(() => o.record('jarvisd:today', 'ok'), e => { o.log(`today timer: ${e}`); o.record('jarvisd:today', 'fail', String(e).slice(0, 300)); });
  }, o.everyMs);
  o.today.pass('daemon started').catch(e => o.log(`today pass: ${e}`));
}

/**
 * Project terminals (terminal.ts): the tmux list every 15 s. A change publishes the work list. Returns the poll, which
 * the terminal routes also call after a change.
 */
export function startTermPoll<T>(o: { list: () => Promise<T>; current: () => T; publish: () => void }): () => Promise<void> {
  let termKey = '';
  async function pollTerms() {
    const key = JSON.stringify(await o.list().catch(() => o.current()));
    if (key !== termKey) { termKey = key; o.publish(); }
  }
  setInterval(() => { pollTerms().catch(() => {}); }, TERM_POLL_MS);
  pollTerms().catch(() => {});
  return pollTerms;
}
