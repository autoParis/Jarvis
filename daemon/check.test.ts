import test from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from './store.ts';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeCheck, readDelivery, inCheckHours, CHECK_MS, ASK_WAIT_MS, LOST_MS, type Delivery } from './check.ts';
import type { Work, WorkRow } from './work.ts';

const at = (s: string) => Date.parse(s);

test('the check runs 8 AM to 4 PM Eastern, on Eastern time through both DST changes', () => {
  // Winter, EST is UTC-5.
  assert.equal(inCheckHours(at('2026-11-02T12:59:59Z')), false); // 7:59 AM
  assert.equal(inCheckHours(at('2026-11-02T13:00:00Z')), true);  // 8:00 AM
  assert.equal(inCheckHours(at('2026-11-02T20:59:59Z')), true);  // 3:59 PM
  assert.equal(inCheckHours(at('2026-11-02T21:00:00Z')), false); // 4:00 PM
  // Summer, EDT is UTC-4: the same instants read one hour later.
  assert.equal(inCheckHours(at('2026-07-15T11:59:59Z')), false);
  assert.equal(inCheckHours(at('2026-07-15T12:00:00Z')), true);
  assert.equal(inCheckHours(at('2026-07-15T19:59:59Z')), true);
  assert.equal(inCheckHours(at('2026-07-15T20:00:00Z')), false);
  // The days the clocks change: EST to EDT on March 8, EDT to EST on November 1.
  assert.equal(inCheckHours(at('2026-03-08T11:59:59Z')), false);
  assert.equal(inCheckHours(at('2026-03-08T12:00:00Z')), true);
  assert.equal(inCheckHours(at('2026-11-01T12:30:00Z')), false);
  assert.equal(inCheckHours(at('2026-11-01T13:00:00Z')), true);
  // Every day counts, weekends too. November 7, 2026 is a Saturday.
  assert.equal(inCheckHours(at('2026-11-07T15:00:00Z')), true);
  assert.equal(inCheckHours(at('2026-11-02T03:00:00Z')), false); // 10 PM the night before
});

const DAY = at('2026-11-02T15:00:00Z'); // 10 AM Eastern

function setup(rows: WorkRow[] = [], start = DAY) {
  const store = openStore(':memory:');
  let clock = start, polls = 0;
  const wakes: string[] = [];
  const closing = new Set<number>();
  const git = { delivery: { master: 'a'.repeat(40), unmerged: [] } as Delivery, error: undefined as string | undefined, running: 'a'.repeat(40), busy: false, paused: false };
  const check = makeCheck({
    store, log: () => {}, now: () => clock, paused: () => git.paused,
    poll: async () => { polls++; return { at: '', rows } as Work; },
    requests: { synced: async () => {}, closing: id => closing.has(id) },
    delivery: async () => { if (git.error) throw new Error(git.error); return git.delivery; },
    get running() { return git.running; },
    brainBusy: () => git.busy,
    wake: t => wakes.push(t),
  });
  return { store, check, wakes, closing, git, polls: () => polls, tick: (ms: number) => { clock += ms; } };
}
const worker = (id: string, extra: Partial<WorkRow> = {}): WorkRow => ({ id, kind: 'worker', dispatch: id, title: id, group: 'other', state: 'working', steer: 'auto', ...extra });
/** An ask that arrived `minutes` before the test clock. */
function ask(store: ReturnType<typeof openStore>, id: string, dispatch: string | null, minutes: number) {
  store.insertItem({ source: 'native', external_id: id, kind: 'question', dispatch_id: dispatch, subject: 'Which one?', status: 'spoken' });
  store.db.prepare('UPDATE items SET created_at = ? WHERE external_id = ?').run(new Date(DAY - minutes * 60_000).toISOString().slice(0, 19).replace('T', ' '), id);
}

test('no finding makes no model call and says nothing', async () => {
  const { store, check, wakes, polls } = setup([worker('ctx_1')]);
  store.addRequest({ dispatch_id: 'ctx_1', action: 'worker-start', title: 'Live work' });
  for (let i = 0; i < 3; i++) await check.tick();
  assert.equal(polls(), 3);
  assert.deepEqual(wakes, []);
});

test('outside the hours a tick reads nothing, writes nothing and wakes nobody, even with a finding waiting', async () => {
  const { store, check, wakes, polls } = setup([], at('2026-11-02T22:00:00Z')); // 5 PM Eastern
  store.addRequest({ dispatch_id: 'ctx_1', action: 'worker-start', title: 'Orphan' });
  await check.tick();
  assert.equal(polls(), 0);
  assert.deepEqual(wakes, []);
  assert.equal(store.getState('checkAt'), undefined);
});

test('a finding from the night wakes the brain on the first tick after 8 AM', async () => {
  const { store, check, wakes, tick } = setup([], at('2026-11-02T12:50:00Z')); // 7:50 AM Eastern
  store.addRequest({ dispatch_id: 'ctx_1', action: 'worker-start', title: 'Orphan' });
  await check.tick();
  assert.deepEqual(wakes, []);
  tick(CHECK_MS);
  await check.tick();
  assert.equal(wakes.length, 1);
});

test('an ask counts as unanswered after 15 minutes, and only while its worker is live', async () => {
  const { store, check, wakes } = setup([worker('ctx_1', { state: 'waiting', note: 'Which one?' })]);
  ask(store, 'recent', 'ctx_1', ASK_WAIT_MS / 60_000 - 1);
  ask(store, 'dead', 'ctx_gone', 120);
  await check.tick();
  assert.deepEqual(wakes, []);
  ask(store, 'old', 'ctx_1', 20);
  await check.tick();
  assert.equal(wakes.length, 1);
  assert.match(wakes[0], /^\[check\]/);
  assert.match(wakes[0], /message_id=old/);
  assert.doesNotMatch(wakes[0], /recent|dead/);
});

test('each finding wakes the brain once, across restarts; one that clears and returns wakes it again', async () => {
  const rows: WorkRow[] = [];
  const { store, check, wakes } = setup(rows);
  store.addRequest({ dispatch_id: 'n:1', action: 'worker-start', title: 'Orphan' });
  await check.tick();
  await check.tick();
  assert.equal(wakes.length, 1);
  assert.match(wakes[0], /Request open \(working\) with no live worker/);
  const later = makeCheck({ store, log: () => {}, now: () => DAY, paused: () => false, poll: async () => ({ at: '', rows }), requests: { synced: async () => {}, closing: () => false }, delivery: async () => ({ master: 'a', unmerged: [] }), running: 'a', brainBusy: () => false, wake: t => wakes.push(t) });
  await later.tick();
  assert.equal(wakes.length, 1);
  rows.push(worker('n:1'));
  await check.tick();
  assert.equal(wakes.length, 1);
  rows.length = 0;
  await check.tick();
  assert.equal(wakes.length, 2);
});

test('closed requests never count as open; a failed one and an orphan do', async () => {
  const { store, check, wakes, closing } = setup();
  const add = (id: string, status: string) => {
    store.addRequest({ dispatch_id: id, action: 'worker-start', title: id });
    const r = store.requests().find(x => x.dispatch_id === id)!;
    store.updateRequest(r.id, { status });
    return r.id;
  };
  add('ctx_done', 'done');
  add('ctx_review', 'review');
  store.hideRequest(add('ctx_hidden', 'working'));
  closing.add(add('ctx_closing', 'working')); // missing from one poll, closes on the next
  await check.tick();
  assert.deepEqual(wakes, []);
  add('ctx_failed', 'failed');
  add('ctx_orphan', 'working');
  await check.tick();
  assert.equal(wakes.length, 1);
  assert.match(wakes[0], /Request failed: "ctx_failed"/);
  assert.match(wakes[0], /no live worker: "ctx_orphan"/);
  assert.doesNotMatch(wakes[0], /ctx_done|ctx_review|ctx_hidden|ctx_closing/);
});

test('a native worker in the polled rows is live: its open request is no orphan, and it is not judged stuck', async () => {
  // main.ts hands the check the native rows (nativeWork). Without them every running native worker read as
  // "Request open (working) with no live worker" (2026-11-09: 43dfae28, f918c991, 4b393f6c).
  const { store, check, wakes } = setup([worker('n:43dfae28', { state: 'idle', note: 'Idle, resumes on a message' })]);
  store.addRequest({ dispatch_id: 'n:43dfae28', action: 'worker-start', title: '#4886 Check the price' });
  await check.tick();
  assert.deepEqual(wakes, []);
});

const branch = (name: string, sha: string, worktree?: string) => ({ branch: name, sha, worktree });

test('a branch not in master wakes the brain once per commit, whether or not it has a worktree', async () => {
  const { check, wakes, git } = setup();
  git.delivery.unmerged = [branch('old-work', 'b'.repeat(40)), branch('finished', 'c'.repeat(40), '/w/stonefish')];
  await check.tick();
  await check.tick();
  assert.equal(wakes.length, 1);
  assert.match(wakes[0], /Branch not merged into master, no live worker: old-work at bbbbbbb worktree=none/);
  assert.match(wakes[0], /finished at ccccccc worktree=\/w\/stonefish/);
  git.delivery.unmerged = [branch('old-work', 'd'.repeat(40)), branch('finished', 'c'.repeat(40), '/w/stonefish')];
  await check.tick();
  assert.equal(wakes.length, 2);
  assert.match(wakes[1], /old-work at ddddddd/);
  assert.doesNotMatch(wakes[1], /finished/);
});

test('a branch still being worked on is not finished work; a session listed as Done does not hold it back', async () => {
  const session = (worktree: string, state: WorkRow['state'], note?: string): WorkRow => ({ id: `s:${worktree}`, kind: 'session', title: worktree, group: 'other', state, note, worktree, steer: 'none' });
  const { check, wakes, git } = setup([
    worker('ctx_live', { worktree: 'live' }), worker('ctx_exit', { state: 'exited', worktree: 'exited' }),
    session('chat', 'working'), session('prompt', 'waiting', 'Waiting at a prompt'), session('monitor', 'idle', 'Monitoring'),
    session('over', 'idle', 'Done 3 h ago'),
  ]);
  git.delivery.unmerged = ['live', 'exited', 'chat', 'prompt', 'monitor', 'over'].map(n => branch(`b-${n}`, 'e'.repeat(40), `/w/${n}`));
  await check.tick();
  assert.equal(wakes.length, 1);
  assert.match(wakes[0], /b-over/);
  assert.doesNotMatch(wakes[0], /b-live|b-exited|b-chat|b-prompt|b-monitor/);
});

test('master moving past the commit the daemon started from means a restart is pending, once per head', async () => {
  const { check, wakes, git } = setup();
  await check.tick();
  assert.deepEqual(wakes, []);
  git.delivery.master = 'f'.repeat(40);
  await check.tick();
  await check.tick();
  assert.equal(wakes.length, 1);
  assert.match(wakes[0], /Restart pending: master is at fffffff, the running daemon started from aaaaaaa/);
  git.delivery.master = '1'.repeat(40);
  await check.tick();
  assert.equal(wakes.length, 2);
  git.running = '1'.repeat(40); // restarted
  await check.tick();
  assert.equal(wakes.length, 2);
});

test('when git fails the tick throws, wakes nobody and forgets nothing', async () => {
  const { check, wakes, git } = setup();
  git.delivery.unmerged = [branch('finished', 'c'.repeat(40))];
  await check.tick();
  assert.equal(wakes.length, 1);
  git.error = 'git: no answer';
  await assert.rejects(check.tick(), /no answer/);
  git.error = undefined;
  await check.tick();
  assert.equal(wakes.length, 1);
});

/** A message from the owner sent `minutes` before the test clock. */
function ownerSaid(store: ReturnType<typeof openStore>, text: string, minutes: number) {
  const id = store.addTurn({ role: 'owner', text });
  store.db.prepare('UPDATE turns SET created_at = ? WHERE id = ?').run(new Date(DAY - minutes * 60_000).toISOString().slice(0, 19).replace('T', ' '), id);
  return id;
}

test('a message from the owner with no answer wakes the brain once, and only after a few minutes', async () => {
  const { store, check, wakes } = setup();
  ownerSaid(store, 'too recent', LOST_MS / 60_000 - 1);
  store.settleTurns([ownerSaid(store, 'answered', 30)]);
  await check.tick();
  assert.deepEqual(wakes, []);
  ownerSaid(store, 'start 4412', 10);
  await check.tick();
  assert.equal(wakes.length, 1);
  assert.match(wakes[0], /Message from the owner the brain never answered, sent 10 min ago: "start 4412"/);
  assert.doesNotMatch(wakes[0], /too recent|answered"/);
  await check.tick();
  assert.equal(wakes.length, 1);
});

test('a message waiting behind a running turn is not lost, and a reported one does not come back when the brain goes busy', async () => {
  const { store, check, wakes, git } = setup();
  ownerSaid(store, 'queued', 10);
  git.busy = true;
  await check.tick();
  assert.deepEqual(wakes, []);
  git.busy = false;
  await check.tick();
  assert.equal(wakes.length, 1);
  git.busy = true;
  await check.tick();
  git.busy = false;
  await check.tick();
  assert.equal(wakes.length, 1);
});

test('at start a lost message wakes the brain at any hour, however recent, and only once', async () => {
  const night = setup([], at('2026-11-02T22:00:00Z')); // 5 PM Eastern, outside the hours
  ownerSaid(night.store, 'start 4412', 0);
  night.check.start();
  assert.equal(night.wakes.length, 1);
  assert.match(night.wakes[0], /^\[check\]/);
  assert.match(night.wakes[0], /Message from the owner the brain never answered.*"start 4412"/);
  night.check.start();
  assert.equal(night.wakes.length, 1);

  const day = setup(); // sent one minute before the restart, under LOST_MS
  ownerSaid(day.store, 'just said', 1);
  day.check.start();
  assert.equal(day.wakes.length, 1);
  assert.match(day.wakes[0], /"just said"/);
  await day.check.tick();
  assert.equal(day.wakes.length, 1);
});

test('at start only lost messages count: no poll, no other finding, and the keys from ticks stay', async () => {
  const { store, check, wakes, polls } = setup();
  store.addRequest({ dispatch_id: 'ctx_1', action: 'worker-start', title: 'Orphan' });
  store.setState('checkSeen', '["request:9"]');
  store.settleTurns([ownerSaid(store, 'answered', 30)]);
  check.start();
  assert.deepEqual(wakes, []);
  ownerSaid(store, 'lost', 1);
  check.start();
  assert.equal(wakes.length, 1);
  assert.doesNotMatch(wakes[0], /Orphan|answered"/);
  assert.equal(polls(), 0);
  assert.equal(store.getState('checkSeen'), '["request:9"]');
});

test('at start the kill switch holds a lost message for a later tick', async () => {
  const { store, check, wakes, git } = setup();
  ownerSaid(store, 'held', 10);
  git.paused = true;
  check.start();
  assert.deepEqual(wakes, []);
  git.paused = false;
  await check.tick();
  assert.equal(wakes.length, 1);
  assert.match(wakes[0], /"held"/);
});

test('readDelivery lists branches with commits not in master and the worktree each is in', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-delivery-'));
  const run = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
  const commit = (name: string) => { writeFileSync(join(dir, name), name); run('add', name); run('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', name); };
  run('init', '-b', 'master');
  commit('one');
  run('branch', 'merged');
  run('checkout', '-b', 'loose');
  commit('two');
  const sha = run('rev-parse', 'HEAD');
  run('checkout', 'master');
  const tree = join(mkdtempSync(join(tmpdir(), 'jarvis-tree-')), 'stonefish');
  run('worktree', 'add', '-b', 'in-tree', tree);
  execFileSync('git', ['-C', tree, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-m', 'three'], { stdio: 'pipe' });
  const d = await readDelivery(dir);
  assert.equal(d.master, run('rev-parse', 'master'));
  assert.deepEqual(d.unmerged.map(b => b.branch).sort(), ['in-tree', 'loose']);
  assert.equal(d.unmerged.find(b => b.branch === 'loose')!.sha, sha);
  assert.equal(d.unmerged.find(b => b.branch === 'loose')!.worktree, undefined);
  assert.match(d.unmerged.find(b => b.branch === 'in-tree')!.worktree!, /stonefish$/);
  await assert.rejects(readDelivery(join(dir, 'nowhere')));
});

test('readDelivery counts a branch merged into an archived ref as delivered, and ignores a missing ref', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-delivery-'));
  const run = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
  const commit = (name: string) => { writeFileSync(join(dir, name), name); run('add', name); run('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', name); };
  run('init', '-b', 'old');
  commit('one');
  run('branch', 'old-work');
  run('checkout', '--orphan', 'master');
  commit('fresh');
  run('branch', 'archive', 'old');
  assert.deepEqual((await readDelivery(dir, [])).unmerged.map(b => b.branch).sort(), ['archive', 'old', 'old-work']);
  assert.deepEqual((await readDelivery(dir, ['archive'])).unmerged, []);
  assert.deepEqual((await readDelivery(dir, ['missing'])).unmerged.map(b => b.branch).sort(), ['archive', 'old', 'old-work']);
});
