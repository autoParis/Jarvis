// jarvisd's timers: each runs at its interval, runs its first pass at start where it has one, and keeps its guards.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { startNativePoll, startTaskSampler, startPushSweep, startCheck, startTodayBackstop, startTermPoll, NATIVE_POLL_MS, TASKS_SAMPLE_MS, PUSH_SWEEP_MS, TERM_POLL_MS } from './timers.ts';

const settle = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

test('timers: the intervals are the ones the Scheduled tasks screen and the app expect', () => {
  assert.deepEqual([NATIVE_POLL_MS, TASKS_SAMPLE_MS, PUSH_SWEEP_MS, TERM_POLL_MS], [30_000, 60_000, 30_000, 15_000]);
});

test('native poll: a first poll at start, one every 30 s, each followed by the close and the sync; a failure is logged', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const seen: string[] = [];
  let fail = false;
  startNativePoll({ poll: async () => { seen.push('poll'); if (fail) throw new Error('down'); }, closeEarlier: () => seen.push('close'), sync: async () => { seen.push('sync'); }, log: m => seen.push(m) });
  await settle();
  assert.deepEqual(seen, ['poll', 'close', 'sync']);
  fail = true;
  t.mock.timers.tick(NATIVE_POLL_MS);
  await settle();
  assert.deepEqual(seen.slice(3), ['poll', 'native poll failed: Error: down']);
});

test('task sampler: a sample at start and every minute, none while the kill switch is on', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let samples = 0, killed = false;
  startTaskSampler({ sample: async () => { samples++; }, killed: () => killed, log: () => {} });
  assert.equal(samples, 1);
  killed = true;
  t.mock.timers.tick(TASKS_SAMPLE_MS);
  assert.equal(samples, 1);
  killed = false;
  t.mock.timers.tick(TASKS_SAMPLE_MS);
  assert.equal(samples, 2);
});

test('push sweep: nothing at start, then held pushes before open asks, one sweep at a time', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const seen: string[] = [];
  let release!: () => void;
  startPushSweep({ flush: () => { seen.push('flush'); return new Promise<void>(r => { release = r; }); }, openAsks: async () => { seen.push('asks'); }, killed: () => false, log: () => {} });
  assert.deepEqual(seen, []);
  t.mock.timers.tick(PUSH_SWEEP_MS);
  t.mock.timers.tick(PUSH_SWEEP_MS);
  assert.deepEqual(seen, ['flush'], 'a sweep still running skips the next tick');
  release();
  await settle();
  assert.deepEqual(seen, ['flush', 'asks']);
});

test('check and Today backstop: the record on the Scheduled tasks screen, and the first pass at start', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const recorded: unknown[][] = [];
  const record = (...a: unknown[]) => { recorded.push(a); };
  let started = 0, ran: unknown = true;
  startCheck({ check: { tick: async () => ran, start: () => { started++; } }, everyMs: 600_000, record, log: () => {} });
  assert.equal(started, 1);
  t.mock.timers.tick(600_000);
  await settle();
  ran = undefined;
  t.mock.timers.tick(600_000);
  await settle();
  assert.deepEqual(recorded, [['jarvisd:check', 'ok']], 'a tick outside check hours records nothing');
  const passes: string[] = [];
  startTodayBackstop({ today: { tick: async () => { throw new Error('stuck'); }, pass: async why => { passes.push(why); } }, everyMs: 300_000, killed: () => false, record, log: () => {} });
  assert.deepEqual(passes, ['daemon started']);
  t.mock.timers.tick(300_000);
  await settle();
  assert.deepEqual(recorded[1], ['jarvisd:today', 'fail', 'Error: stuck']);
});

test('term poll: a change publishes the work list once, and a failed list falls back to the current one', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let list: unknown = ['a'], published = 0;
  const poll = startTermPoll({ list: async () => { if (list === 'fail') throw new Error('tmux'); return list; }, current: () => ['a'], publish: () => { published++; } });
  await settle();
  assert.equal(published, 1);
  t.mock.timers.tick(TERM_POLL_MS);
  await settle();
  assert.equal(published, 1, 'no change, no publish');
  list = 'fail';
  await poll();
  assert.equal(published, 1, 'the fallback is the same list');
  list = ['a', 'b'];
  await poll();
  assert.equal(published, 2);
});
