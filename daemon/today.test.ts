import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { openStore, type TodayRow } from './store.ts';
import { makeToday, todayRoute, decidePass, buttons, todayOrder, todayView, parseReport, morningLine, todayBrief, draftSpec, runSpec, storyStartSpec, CAP, MAX_TRIES, BACKSTOP_MS, STUCK_MS } from './today.ts';
import { PRESSED, buildCommand, makeGate } from './gate.ts';
import { sqlTime } from './push.ts';
import { todayButton, todayListHtml, detailHtml, answersChanged, shownAnswer } from '../web/today.js';

const REPO = '/repo/acmeapp';
const T0 = Date.parse('2026-11-04T15:00:00Z');
const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

type Press = { action: string; args: any; say: string };
function setup(o: { load?: number; cores?: number; result?: (p: Press) => { status: string; result: string } } = {}) {
  const store = openStore(':memory:');
  const pressed: Press[] = [], wakes: string[] = [], logs: string[] = [], discussed: string[] = [], released: number[] = [];
  let n = 0, clock = T0, changes = 0;
  const gate = {
    pressed: async (action: string, args: any, say: string) => {
      const p = { action, args, say };
      pressed.push(p);
      const r = o.result?.(p) ?? (action === 'today-issue' ? { status: 'done', result: 'https://github.com/o/r/issues/4890' } : { status: 'done', result: JSON.stringify({ dispatchId: `ctx_${++n}` }) });
      return { id: 100 + pressed.length, ...r } as any;
    },
  };
  const state = { load: o.load ?? 1, cores: o.cores ?? 10, paused: false };
  const today = makeToday({
    store, gate, log: m => { logs.push(m); }, wake: t => { wakes.push(t); }, repos: () => [{ path: REPO }], paused: () => state.paused,
    onChange: () => { changes++; }, discuss: w => { discussed.push(w); }, released: i => { released.push(i.id); },
    load: () => state.load, cores: () => state.cores, now: () => clock, skillFor: () => 'pick-and-ship-v3',
  });
  return { store, today, pressed, wakes, logs, discussed, released, state, advance: (ms: number) => { clock += ms; }, changes: () => changes };
}
const settle = () => new Promise(r => setImmediate(r));
const STORY = { kind: 'story', title: 'Photo order', reading: 'A re-shoot breaks the order.', repo: REPO, story: { github: 'o/r', title: 'Photo order', body: 'Story text' } };
const TASK = { kind: 'task', title: 'Read the logs', reading: 'Read them.', repo: REPO, spec: 'Read the logs and report.' };
const TALK = { kind: 'talk', title: 'A talk', reading: 'To discuss.' };
const row = (f: Partial<TodayRow>): TodayRow => ({ id: 1, words: 'w', title: null, kind: null, go: 0, status: 'new', status_at: '2026-11-04 15:00:00', reading: null, questions: null, assumptions: null, reason: null, result: null, not_proven: null, link: null, link_label: null, note: null, repo: null, spec: null, story: null, phase: null, brief: null, draft_report: null, dispatch: null, worktree: null, line: null, issue_url: null, issue_state: null, owed: null, told_at: null, tries: 0, created_at: '2026-11-04 15:00:00', released_at: null, ...f });
const addItem = (t: ReturnType<typeof setup>, words: string, go = false) => t.today.add({ words, go }).body.item.id as number;
const status = (t: ReturnType<typeof setup>, id: number) => t.store.todayItem(id)!.status;
/** A request and a worker_done, as the poller and the watcher would have left them. */
function finish(t: ReturnType<typeof setup>, dispatch: string, f: { status?: string; subject?: string; body?: string; outcome?: string; pr_url?: string } = {}) {
  t.store.addRequest({ dispatch_id: dispatch, action: 'worker-start', title: 'x' });
  const r = t.store.requestOf(dispatch)!;
  t.store.updateRequest(r.id, { status: f.status ?? 'done', ...(f.pr_url ? { pr: 'PR #7', pr_url: f.pr_url } : {}) });
  if (f.body !== undefined) t.store.insertItem({ source: 'orca', external_id: `done_${dispatch}_${Math.random()}`, kind: 'worker_done', dispatch_id: dispatch, subject: f.subject ?? 'Finished', body: f.body, meta: JSON.stringify({ outcome: f.outcome ?? 'succeeded' }), status: 'done' });
}

// ---- the store ----
test('the store keeps the owner\'s exact words and refuses any change to them', () => {
  const s = openStore(':memory:');
  const words = '  la photo, "exact"\nline two ';
  const r = s.addToday(words, true);
  assert.equal(s.todayItem(r.id)!.words, words);
  assert.equal(r.go, 1);
  assert.equal(r.status, 'new');
  s.setToday(r.id, { title: 'T', words: 'changed' } as any);
  assert.equal(s.todayItem(r.id)!.words, words, 'setToday has no words column');
  assert.throws(() => s.db.prepare('UPDATE today_items SET words = ? WHERE id = ?').run('x', r.id), /do not change/);
});

test('a status change moves status_at, and a claim only works from the expected status', () => {
  const s = openStore(':memory:');
  const r = s.addToday('a', false);
  s.db.prepare(`UPDATE today_items SET status_at = '2000-01-01 00:00:00' WHERE id = ?`).run(r.id);
  s.setToday(r.id, { title: 't' });
  assert.equal(s.todayItem(r.id)!.status_at, '2000-01-01 00:00:00');
  s.setToday(r.id, { status: 'queued' });
  assert.notEqual(s.todayItem(r.id)!.status_at, '2000-01-01 00:00:00');
  assert.equal(s.claimToday(r.id, 'queued', 'working'), true);
  assert.equal(s.claimToday(r.id, 'queued', 'working'), false, 'a second claim loses');
});

test('dropped and moved rows stay stored but are not listed; a bad status is refused', () => {
  const s = openStore(':memory:');
  const a = s.addToday('a', false), b = s.addToday('b', false), c = s.addToday('c', false);
  s.setToday(a.id, { status: 'dropped' });
  s.setToday(b.id, { status: 'moved' });
  assert.deepEqual(s.todayItems().map(i => i.id), [c.id]);
  assert.equal(s.todayItem(a.id)!.status, 'dropped');
  assert.throws(() => s.setToday(c.id, { status: 'nonsense' }));
});

// ---- the status rules ----
test('each status and kind offers exactly the buttons in the design', () => {
  const b = (f: Partial<TodayRow>) => buttons(row(f));
  assert.deepEqual(b({ status: 'waiting', kind: 'story', story: '{}' }), ['accept', 'not-right', 'drop']);
  assert.deepEqual(b({ status: 'waiting', kind: 'task' }), ['do', 'not-right', 'drop']);
  assert.deepEqual(b({ status: 'waiting', kind: 'talk' }), ['discuss', 'drop']);
  assert.deepEqual(b({ status: 'ready' }), ['release', 'not-right']);
  assert.deepEqual(b({ status: 'working' }), [], 'working has nothing to press');
  assert.deepEqual(b({ status: 'released' }), []);
  assert.deepEqual(b({ status: 'new' }), ['drop']);
  assert.deepEqual(b({ status: 'waiting', kind: null }), ['retry', 'drop'], 'a failed item with no work-up');
  assert.deepEqual(b({ status: 'waiting', kind: 'story', story: null }), ['retry', 'drop'], 'no draft, nothing to accept');
  assert.deepEqual(b({ status: 'waiting', kind: 'story', story: '{}', issue_state: 'unknown' }), ['not-right', 'drop'], 'an issue that may exist is never filed again');
});

test('rows sort Waiting, Ready, Working, Queued, New, Released; oldest first inside a status, newest release first', () => {
  const rows = [row({ id: 1, status: 'new' }), row({ id: 2, status: 'released' }), row({ id: 3, status: 'queued' }), row({ id: 4, status: 'working' }), row({ id: 5, status: 'ready' }), row({ id: 6, status: 'waiting' }), row({ id: 7, status: 'waiting' }), row({ id: 8, status: 'released' })];
  assert.deepEqual(todayOrder(rows).map(i => i.id), [6, 7, 5, 4, 3, 1, 8, 2]);
});

test('a tap the row does not offer is refused and changes nothing', async () => {
  const t = setup();
  const id = addItem(t, 'x');
  for (const action of ['accept', 'do', 'release', 'discuss', 'not-right', 'nonsense']) {
    const r = await t.today.act({ id, action, note: 'n' });
    assert.equal(r.status, 409, action);
    assert.equal(status(t, id), 'new', action);
  }
  assert.equal((await t.today.act({ id: 999, action: 'drop' })).status, 404);
  assert.equal(t.pressed.length, 0);
});

test('Drop takes it off the list, Release folds it into history, and neither runs anything', async () => {
  const t = setup();
  const a = addItem(t, 'a'), b = addItem(t, 'b');
  t.today.result(b, { result: 'done', notProven: 'nothing' });
  assert.equal((await t.today.act({ id: a, action: 'drop' })).status, 200);
  assert.ok(!t.today.list().some(i => i.id === a));
  assert.equal((await t.today.act({ id: b, action: 'release' })).status, 200);
  const v = t.today.list().find(i => i.id === b)!;
  assert.equal(v.status, 'released');
  assert.equal(v.result, 'done', 'history keeps its result');
  assert.ok(t.store.todayItem(b)!.released_at);
  assert.deepEqual(t.released, [b], 'the brain hears, to close the loop');
  assert.equal(t.pressed.length, 0);
});

test('Do it queues a task with a spec and starts it; one with no spec goes back to the brain as a go item', async () => {
  const t = setup();
  const a = addItem(t, 'a');
  t.today.workup(a, TASK);
  assert.equal(status(t, a), 'waiting', 'no go, so it waits');
  assert.equal(t.pressed.length, 0);
  await t.today.act({ id: a, action: 'do' });
  await settle();
  assert.equal(status(t, a), 'working');
  assert.equal(t.pressed[0].action, 'today-start');
  assert.equal(t.store.todayItem(a)!.dispatch, 'ctx_1');
  const b = addItem(t, 'b');
  t.today.workup(b, { kind: 'task', reading: 'r', questions: [{ q: 'Which?', options: ['A', 'B'] }] });
  await t.today.act({ id: b, action: 'do' });
  await settle();
  const r = t.store.todayItem(b)!;
  assert.equal(r.status, 'new');
  assert.equal(r.go, 1);
  assert.equal(r.owed, 'do');
  assert.match(t.wakes.at(-1)!, /the owner tapped Do it/);
});

test('Not right on a finished run reruns it with the note in its own folder; Not right needs words', async () => {
  const t = setup();
  const id = addItem(t, 'a', true);
  t.today.workup(id, TASK);
  await settle();
  finish(t, 'ctx_1', { body: 'All done.\n\nNot proven: the phone.' });
  t.today.sync([{ dispatch: 'ctx_1', path: '/wt/a', outcome: 'succeeded' }], true);
  await settle();
  assert.equal(status(t, id), 'ready');
  assert.equal((await t.today.act({ id, action: 'not-right', note: ' ' })).status, 400);
  await t.today.act({ id, action: 'not-right', note: 'Wrong dealer' });
  await settle();
  assert.equal(status(t, id), 'working', 'back to Working');
  const again = t.pressed.at(-1)!;
  assert.equal(again.args.worktree, 'path:/wt/a');
  assert.match(again.args.spec, /Wrong dealer/);
  assert.match(again.args.spec, /All done\./, 'it sees what it reported');
  assert.equal(t.store.todayItem(id)!.dispatch, 'ctx_2');
});

test('Not right on a work-up, and a changed answer, go back to the brain and show as New', async () => {
  const t = setup();
  const id = addItem(t, 'a');
  t.today.workup(id, { ...STORY, questions: [{ q: 'Q?', options: ['A', 'B'] }] });
  await t.today.act({ id, action: 'not-right', note: 'It is about video' });
  await settle();
  let r = t.store.todayItem(id)!;
  assert.equal(r.status, 'new');
  assert.equal(r.owed, 'not-right');
  assert.match(t.wakes.at(-1)!, /It is about video/);
  t.today.workup(id, { ...STORY, questions: [{ q: 'Q?', options: ['A', 'B'] }] });
  assert.equal(t.store.todayItem(id)!.note, null);
  const stale = await t.today.act({ id, action: 'accept', answers: ['B'] });
  assert.equal(stale.status, 409, 'Accept is refused while an answer differs from the draft');
  assert.equal(t.pressed.length, 0);
  await t.today.act({ id, action: 'answers', answers: ['B'] });
  await settle();
  r = t.store.todayItem(id)!;
  assert.equal(r.status, 'new');
  assert.equal(JSON.parse(r.questions!)[0].answer, 'B');
  assert.match(t.wakes.at(-1)!, /answers changed/);
});

test('The owner can change the kind; a kind with no work-up behind it goes back to the brain', async () => {
  const t = setup();
  const id = addItem(t, 'a');
  t.today.workup(id, TASK);
  await t.today.act({ id, action: 'kind', kind: 'talk' });
  assert.equal(t.store.todayItem(id)!.kind, 'talk');
  assert.equal(status(t, id), 'waiting');
  await t.today.act({ id, action: 'kind', kind: 'story' });
  assert.equal(status(t, id), 'new', 'no story draft yet');
  assert.equal(t.store.todayItem(id)!.owed, 'kind');
  assert.equal((await t.today.act({ id, action: 'kind', kind: 'bad' })).status, 400);
});

test('Discuss now puts the words in the chat and leaves the row on the list', async () => {
  const t = setup();
  const id = addItem(t, 'who owns it');
  t.today.workup(id, TALK);
  await t.today.act({ id, action: 'discuss' });
  assert.deepEqual(t.discussed, ['who owns it']);
  assert.equal(status(t, id), 'waiting');
});

// ---- the pass decision ----
const decide = (items: TodayRow[], f: Partial<{ load: number; cores: number; paused: boolean; now: number }> = {}) => decidePass({ items, load: 1, cores: 10, paused: false, now: T0, ...f });

test('a pass with nothing to do wakes no brain and starts nothing', async () => {
  assert.equal(decide([]).skip, 'nothing');
  const settled = [row({ id: 1, status: 'waiting' }), row({ id: 2, status: 'ready' }), row({ id: 3, status: 'working', dispatch: 'd' }), row({ id: 4, status: 'released' })];
  assert.equal(decide(settled).skip, 'nothing');
  const t = setup();
  await t.today.pass('timer');
  assert.deepEqual(t.wakes, []);
  assert.deepEqual(t.pressed, []);
  assert.match(t.store.getState('todayPass')!, /"skip":"nothing"/, 'it still leaves a record');
  const id = addItem(t, 'x');
  t.today.workup(id, TASK);
  t.wakes.length = 0;
  await t.today.pass('timer');
  assert.deepEqual(t.wakes, [], 'a row waiting on the owner needs no brain');
  await t.today.tick();
  assert.deepEqual(t.wakes.filter(w => w.startsWith('[today pass]')), []);
});

test('the pass skips when the load average is above the core count, and only then', () => {
  const items = [row({ id: 1, owed: 'new' }), row({ id: 2, status: 'queued' })];
  assert.equal(decide(items, { load: 10.01, cores: 10 }).skip, 'overloaded');
  const at = decide(items, { load: 10, cores: 10 });
  assert.equal(at.skip, undefined, 'equal is not above');
  assert.deepEqual(at.wake, [1]);
  assert.deepEqual(at.start, [2]);
});

test('an overloaded pass does nothing at all, and the next pass picks it up', async () => {
  const t = setup({ load: 20, cores: 10 });
  const id = addItem(t, 'x', true);
  await settle();
  assert.deepEqual(t.wakes, []);
  assert.deepEqual(t.pressed, []);
  assert.match(t.store.getState('todayPass')!, /overloaded/);
  assert.ok(t.logs.includes('today pass'));
  t.state.load = 2;
  await t.today.pass('timer');
  assert.equal(t.wakes.length, 1);
  assert.match(t.wakes[0], new RegExp(`item=${id} go=true`));
});

test('the kill switch pauses a pass', () => {
  assert.equal(decide([row({ owed: 'new' })], { paused: true }).skip, 'paused');
});

test('at most three run at once, drafts counted, and the oldest queued goes first', () => {
  assert.equal(CAP, 3);
  const q = (id: number) => row({ id, status: 'queued' }), w = (id: number) => row({ id, status: 'working', dispatch: `d${id}` });
  assert.deepEqual(decide([q(5), q(4), q(6), q(7)]).start, [4, 5, 6]);
  assert.deepEqual(decide([w(1), w(2), q(3), q(4)]).start, [3]);
  assert.equal(decide([w(1), w(2), w(3), q(4)]).skip, 'nothing', 'full, so a queued item waits and no brain wakes');
  assert.deepEqual(decide([row({ id: 1, status: 'working', phase: 'draft', dispatch: 'd' }), w(2), q(3), q(4)]).start, [3]);
});

test('one story draft runs at a time, and a task can pass a draft that must wait', () => {
  const d = (id: number) => row({ id, status: 'queued', phase: 'draft' });
  assert.deepEqual(decide([d(1), d(2)]).start, [1]);
  assert.deepEqual(decide([row({ id: 9, status: 'working', phase: 'draft', dispatch: 'x' }), d(1), row({ id: 2, status: 'queued' })]).start, [2]);
});

test('four go items through the real flow: three run, the fourth queues and starts when a slot frees', async () => {
  const t = setup();
  const ids = ['a', 'b', 'c', 'd'].map(w => addItem(t, w, true));
  await settle();
  for (const id of ids) t.today.workup(id, { ...TASK, title: `T${id}` });
  await settle(); await settle();
  assert.deepEqual(ids.map(i => status(t, i)), ['working', 'working', 'working', 'queued']);
  assert.equal(t.pressed.length, 3);
  const first = t.store.todayItem(ids[0])!.dispatch!;
  finish(t, first, { body: 'Done.\n\nNot proven: nothing' });
  t.today.sync([], true);
  await settle(); await settle();
  assert.equal(status(t, ids[0]), 'ready');
  assert.equal(status(t, ids[3]), 'working');
  assert.equal(t.pressed.length, 4);
});

test('a brain that writes no work-up is told again at the backstop, then the row fails with the reason', async () => {
  const t = setup();
  const id = addItem(t, 'x');
  await settle();
  assert.equal(t.wakes.length, 1);
  await t.today.pass('timer');
  assert.equal(t.wakes.length, 1, 'not told again before the backstop');
  for (let n = 2; n <= MAX_TRIES; n++) {
    t.advance(BACKSTOP_MS);
    await t.today.pass('timer');
    assert.equal(t.wakes.length, n);
    assert.match(t.wakes.at(-1)!, /told before/);
  }
  t.advance(BACKSTOP_MS);
  await t.today.pass('timer');
  assert.equal(t.wakes.length, MAX_TRIES, 'no more model calls');
  const r = t.store.todayItem(id)!;
  assert.equal(r.status, 'waiting');
  assert.match(r.reason!, /no work-up/);
  await t.today.act({ id, action: 'retry' });
  await settle();
  assert.equal(t.wakes.length, MAX_TRIES + 1);
});

// ---- go, and the hard limit ----
test('go never covers an outward action: a go story stops for the tap and no pass files it', async () => {
  const t = setup();
  const id = addItem(t, 'x', true);
  t.today.workup(id, STORY);
  assert.equal(status(t, id), 'waiting');
  for (let n = 0; n < 5; n++) { t.advance(BACKSTOP_MS); await t.today.tick(); }
  assert.deepEqual(t.pressed, []);
  assert.equal(status(t, id), 'waiting');
});

test('a pass only ever presses the two worker actions, and a worker spec forbids anything outward', async () => {
  const t = setup();
  const a = addItem(t, 'a', true), b = addItem(t, 'b');
  t.today.workup(a, TASK);
  t.today.draft(b, { repo: REPO, brief: 'b' });
  await settle(); await settle();
  assert.deepEqual(t.pressed.map(p => p.action).sort(), ['today-draft', 'today-start']);
  const run = runSpec(t.store.todayItem(a)!);
  for (const limit of [/send nothing/, /file no issues/, /open or merge no PRs/, /push nothing/, /change no client data/, /Not proven:/]) assert.match(run, limit);
  const draft = draftSpec(t.store.todayItem(b)!);
  assert.match(draft, /Read-only/);
  assert.match(draft, /prove-it skill in light mode/);
  assert.match(draft, /You file nothing/);
});

test('a go task starts only with a spec and no question; otherwise it waits with one question', async () => {
  const t = setup();
  const a = addItem(t, 'a', true);
  const two = t.today.workup(a, { kind: 'task', reading: 'r', questions: [{ q: 'One?' }, { q: 'Two?' }] });
  assert.equal(two.status, 400, 'a go item stops on one question');
  assert.equal(status(t, a), 'new');
  assert.equal(t.today.workup(a, { kind: 'task', reading: 'r' }).status, 400, 'no spec and no question');
  t.today.workup(a, { kind: 'task', reading: 'r', questions: [{ q: 'Which dealer?', options: ['A', 'B'] }] });
  await settle();
  assert.equal(status(t, a), 'waiting');
  assert.deepEqual(t.pressed, []);
  t.today.workup(a, TASK);
  await settle();
  assert.equal(status(t, a), 'working');
});

test('a go talk waits, and a work-up is refused once work has started', async () => {
  const t = setup();
  const a = addItem(t, 'a', true);
  t.today.workup(a, TALK);
  assert.equal(status(t, a), 'waiting');
  const b = addItem(t, 'b', true);
  t.today.workup(b, TASK);
  await settle();
  assert.equal(t.today.workup(b, TASK).status, 409);
  assert.equal(t.today.draft(b, { repo: REPO }).status, 409);
  assert.equal(t.today.result(b, { result: 'r', notProven: 'n' }).status, 409);
});

test('a work-up checks its repo, and a story needs a GitHub repo', () => {
  const t = setup();
  const id = addItem(t, 'a');
  assert.equal(t.today.workup(id, { ...TASK, repo: '/somewhere/else' }).status, 400);
  assert.equal(t.today.workup(id, { ...STORY, story: { ...STORY.story, github: '' } }).status, 400);
  assert.equal(t.today.workup(id, { ...TASK, reading: '' }).status, 400);
  assert.equal(t.today.workup(id, { ...TASK, kind: 'x' }).status, 400);
  assert.equal(t.today.workup(id, { kind: 'task', reading: 'r', questions: [{ q: 'Q', options: ['A'], recommended: 4 }] }).status, 400);
  assert.equal(status(t, id), 'new');
  assert.equal(t.today.draft(id, { repo: '/somewhere/else' }).status, 400);
});

// ---- Accept ----
test('Accept files the issue, starts pick-and-ship on it, and the row leaves the list', async () => {
  const t = setup();
  const id = addItem(t, 'x');
  t.today.workup(id, STORY);
  const r = await t.today.act({ id, action: 'accept' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.moved, { number: 4890, url: 'https://github.com/o/r/issues/4890' });
  assert.deepEqual(t.pressed.map(p => p.action), ['today-issue', 'today-start']);
  assert.deepEqual([t.pressed[0].args.repo, t.pressed[0].args.title, t.pressed[0].args.body], ['o/r', 'Photo order', 'Story text']);
  assert.equal(t.pressed[1].args.repo, REPO);
  assert.equal(t.pressed[1].args.taskTitle, '#4890 Photo order');
  assert.equal(t.pressed[1].args.spec, storyStartSpec('4890', 'pick-and-ship-v3'));
  assert.match(t.pressed[1].args.spec, /## Filing issues\n.*P2 or P3 only/s);
  assert.ok(!t.today.list().some(i => i.id === id));
  assert.equal(status(t, id), 'moved');
  assert.equal(t.store.todayItem(id)!.issue_url, 'https://github.com/o/r/issues/4890');
});

test('a refused filing stays on the row with the reason, and Accept can try again', async () => {
  let refuse = true;
  const t = setup({ result: p => p.action === 'today-issue' && refuse ? { status: 'failed', result: 'gh: no access' } : p.action === 'today-issue' ? { status: 'done', result: 'https://github.com/o/r/issues/5' } : { status: 'done', result: '{"dispatchId":"d"}' } });
  const id = addItem(t, 'x');
  t.today.workup(id, STORY);
  assert.equal((await t.today.act({ id, action: 'accept' })).status, 502);
  assert.equal(status(t, id), 'waiting');
  assert.match(t.store.todayItem(id)!.reason!, /no access/);
  refuse = false;
  assert.equal((await t.today.act({ id, action: 'accept' })).status, 200);
});

test('when the worker does not start, the issue is kept and a second Accept never files again', async () => {
  let starts = 0;
  const t = setup({ result: p => p.action === 'today-issue' ? { status: 'done', result: 'https://github.com/o/r/issues/5' } : ++starts === 1 ? { status: 'failed', result: 'orca down' } : { status: 'done', result: '{"dispatchId":"d"}' } });
  const id = addItem(t, 'x');
  t.today.workup(id, STORY);
  assert.equal((await t.today.act({ id, action: 'accept' })).status, 502);
  const r = t.store.todayItem(id)!;
  assert.equal(r.status, 'waiting');
  assert.match(r.reason!, /Issue #5 is filed/);
  assert.equal((await t.today.act({ id, action: 'accept' })).status, 200);
  assert.deepEqual(t.pressed.map(p => p.action), ['today-issue', 'today-start', 'today-start']);
});

test('a filing with no link is unknown: the row says so and Accept is gone', async () => {
  const t = setup({ result: () => ({ status: 'done', result: 'something else' }) });
  const id = addItem(t, 'x');
  t.today.workup(id, STORY);
  assert.equal((await t.today.act({ id, action: 'accept' })).status, 502);
  const v = t.today.list().find(i => i.id === id)!;
  assert.match(v.reason, /will not file it twice/);
  assert.ok(!v.buttons.includes('accept'));
  assert.equal((await t.today.act({ id, action: 'accept' })).status, 409);
  assert.equal(t.pressed.length, 1);
});

test('a filing recorded before a crash is found, not repeated', async () => {
  const t = setup();
  const id = addItem(t, 'x');
  t.today.workup(id, STORY);
  const a = t.store.addApproval({ action: 'today-issue', args: JSON.stringify({ item: id, repo: 'o/r', title: 't', body: 'b' }), say: 's' });
  t.store.finishApproval(a.id, 'done', 'https://github.com/o/r/issues/77');
  const r = await t.today.act({ id, action: 'accept' });
  assert.equal(r.body.moved.number, 77);
  assert.deepEqual(t.pressed.map(p => p.action), ['today-start']);
});

test('two taps at once file one issue', async () => {
  const t = setup();
  const id = addItem(t, 'x');
  t.today.workup(id, STORY);
  const [one, two] = await Promise.all([t.today.act({ id, action: 'accept' }), t.today.act({ id, action: 'accept' })]);
  assert.deepEqual([one.status, two.status].sort(), [200, 409]);
  assert.equal(t.pressed.filter(p => p.action === 'today-issue').length, 1);
});

// ---- a worker ending ----
test('a finished run goes to Ready with its result, what was not proven, and its link', async () => {
  const t = setup();
  const id = addItem(t, 'x', true);
  t.today.workup(id, TASK);
  await settle();
  finish(t, 'ctx_1', { body: 'I read the logs. The job runs late.\n\nDetails here.\n\n**Not proven:** the weekend runs.', pr_url: 'https://github.com/o/r/pull/7' });
  t.today.sync([], true);
  const v = t.today.list().find(i => i.id === id)!;
  assert.equal(v.status, 'ready');
  assert.equal(v.result, 'I read the logs. The job runs late.');
  assert.equal(v.notProven, 'the weekend runs.');
  assert.deepEqual(v.link, { label: 'PR #7', url: 'https://github.com/o/r/pull/7' });
});

test('ending with no report, or failing, is Waiting on you with a reason, never Ready', async () => {
  const t = setup();
  const a = addItem(t, 'a', true), b = addItem(t, 'b', true);
  t.today.workup(a, TASK); t.today.workup(b, TASK);
  await settle(); await settle();
  finish(t, t.store.todayItem(a)!.dispatch!, {});
  finish(t, t.store.todayItem(b)!.dispatch!, { status: 'failed', subject: 'Tests broke', body: 'It broke.', outcome: 'failed' });
  t.today.sync([], true);
  assert.equal(status(t, a), 'waiting');
  assert.match(t.store.todayItem(a)!.reason!, /without reporting/);
  assert.equal(status(t, b), 'waiting');
  assert.match(t.store.todayItem(b)!.reason!, /Tests broke/);
  await t.today.act({ id: a, action: 'do' });
  await settle();
  assert.equal(status(t, a), 'working', 'Do it runs a failed task again');
  assert.equal(t.store.todayItem(a)!.reason, null);
});

test('a finished draft goes back to the brain with its report and frees the draft turn', async () => {
  const t = setup();
  const a = addItem(t, 'a'), b = addItem(t, 'b');
  await settle();
  t.today.draft(a, { repo: REPO, brief: 'code needed' });
  t.today.draft(b, { repo: REPO, brief: 'code needed' });
  await settle(); await settle();
  assert.deepEqual([status(t, a), status(t, b)], ['working', 'queued']);
  t.wakes.length = 0;
  finish(t, t.store.todayItem(a)!.dispatch!, { subject: 'Drafted', body: 'Story: the draft' });
  t.today.sync([], true);
  await settle(); await settle();
  const r = t.store.todayItem(a)!;
  assert.equal(r.status, 'new');
  assert.equal(r.owed, 'draft');
  assert.match(t.wakes.join('\n'), /Story: the draft/);
  assert.equal(status(t, b), 'working', 'the next draft starts when the last finishes');
});

test('a request the owner hid does not hold a slot, while a still-running worker keeps it', async () => {
  const t = setup();
  const id = addItem(t, 'x', true);
  t.today.workup(id, TASK);
  await settle();
  t.store.addRequest({ dispatch_id: 'ctx_1', action: 'worker-start', title: 'x' });
  t.store.hideRequest(t.store.requestOf('ctx_1')!.id);
  t.today.sync([{ dispatch: 'ctx_1', outcome: 'in_progress' }], true);
  assert.equal(status(t, id), 'working');
  t.today.sync([], false);
  assert.equal(status(t, id), 'working', 'an incomplete poll proves nothing');
  t.today.sync([], true);
  assert.equal(status(t, id), 'waiting');
});

test('a hidden request on a native worker: Orca\'s complete list proves nothing, its own row decides', async () => {
  const t = setup();
  const id = addItem(t, 'x', true);
  t.today.workup(id, TASK);
  await settle();
  // The worker is native: Orca's list never holds it.
  const at = new Date(T0).toISOString();
  t.store.addNativeWorker({ id: 'nat1', session_id: 's-nat1', name: 'x-1', cwd: '/wt/x-1', approval_id: null, state: 'working', waiting_for: null, report: null, report_at: null, outcome: null, transcript: null, created_at: at, updated_at: at });
  t.store.setToday(id, { dispatch: 'n:nat1' });
  t.store.addRequest({ dispatch_id: 'n:nat1', action: 'today-start', title: 'x' });
  t.store.hideRequest(t.store.requestOf('n:nat1')!.id);
  t.today.sync([{ dispatch: 'ctx_other', outcome: 'in_progress' }], true);
  assert.equal(status(t, id), 'working', 'a complete Orca list without it does not end a native worker');
  // The idle reaper's stop is not an end: a message resumes it.
  t.store.updateNativeWorker('nat1', { state: 'stopped', waiting_for: 'Idle, resumes on a message' });
  t.today.sync([], true);
  assert.equal(status(t, id), 'working');
  t.store.updateNativeWorker('nat1', { state: 'done', outcome: 'done', report: 'DONE: the list sorts by date.\n\nNot proven: the phone.', report_at: at });
  t.today.sync([], false);
  const r = t.store.todayItem(id)!;
  assert.equal(r.status, 'ready');
  assert.equal(r.result, 'the list sorts by date.');
  // The owner stopping it ends it too, with no report.
  const t2 = setup();
  const id2 = addItem(t2, 'y', true);
  t2.today.workup(id2, TASK);
  await settle();
  t2.store.addNativeWorker({ id: 'nat2', session_id: 's-nat2', name: 'y-1', cwd: '/wt/y-1', approval_id: null, state: 'stopped', waiting_for: null, report: null, report_at: null, outcome: null, transcript: null, created_at: at, updated_at: at });
  t2.store.setToday(id2, { dispatch: 'n:nat2' });
  t2.today.sync([], false);
  assert.equal(status(t2, id2), 'waiting');
  assert.match(t2.store.todayItem(id2)!.reason!, /ended without reporting/);
});

test('a start that lost its answer, or a crash mid-start, never retries on its own', async () => {
  const t = setup({ result: () => ({ status: 'unknown', result: 'no JSON' }) });
  const id = addItem(t, 'x', true);
  t.today.workup(id, TASK);
  await settle(); await settle();
  assert.equal(status(t, id), 'waiting');
  assert.match(t.store.todayItem(id)!.reason!, /may be running/);
  assert.equal(t.pressed.length, 1);
  const c = setup();
  const stuck = addItem(c, 'y');
  c.store.setToday(stuck, { status: 'working', owed: null, repo: REPO, spec: 's' });
  c.today.sync([], true);
  assert.equal(status(c, stuck), 'working', 'not yet');
  c.advance(STUCK_MS + 1000);
  c.store.db.prepare('UPDATE today_items SET status_at = ? WHERE id = ?').run(sqlTime(T0), stuck);
  c.today.sync([], true);
  assert.equal(status(c, stuck), 'waiting');
  assert.equal(c.pressed.length, 0);
});

test('a working row shows its worker link and one line, including a question from its worker', async () => {
  const t = setup();
  const id = addItem(t, 'x', true);
  t.today.workup(id, TASK);
  await settle();
  t.store.addRequest({ dispatch_id: 'ctx_1', action: 'worker-start', title: 'x' });
  const req = t.store.requestOf('ctx_1')!;
  t.store.updateRequest(req.id, { status: 'waiting' });
  t.today.sync([{ dispatch: 'ctx_1' }], true);
  const v = t.today.list().find(i => i.id === id)!;
  assert.deepEqual(v.link, { label: 'Worker', open: req.id });
  assert.match(v.line, /see Requests/);
  assert.deepEqual(v.buttons, []);
});

test('parseReport finds the not-proven line in the shapes workers write, and says so when there is none', () => {
  assert.deepEqual(parseReport('s', 'Did it.\n\nNot proven: the phone'), { result: 'Did it.', notProven: 'the phone' });
  assert.equal(parseReport('s', 'Did it.\n- **Not proven**: a\nstill a').notProven, 'a\nstill a');
  assert.match(parseReport('s', 'Did it.').notProven, /did not say/);
  assert.equal(parseReport('Subject', 'Not proven: x').result, 'Subject');
});

// ---- adding, and the chat path ----
test('adding keeps the words, starts New, and a retry of the same words adds nothing', async () => {
  const t = setup();
  const r = t.today.add({ words: ' Call Sam, about "x" ' });
  assert.equal(r.body.item.words, 'Call Sam, about "x"');
  assert.equal(r.body.item.statusWords, 'New');
  assert.equal(r.body.item.go, false);
  const again = t.today.add({ words: 'Call Sam, about "x"' });
  assert.equal(again.body.existing, true);
  assert.equal(t.today.list().length, 1);
  assert.equal(t.today.add({ words: '  ' }).status, 400);
  assert.equal(t.today.add({ words: 'x'.repeat(8001) }).status, 400);
});

test('a chat answer updates the row; one that differs goes back to New without waking the brain mid-turn', () => {
  const t = setup();
  const id = addItem(t, 'x');
  t.today.workup(id, { ...TASK, questions: [{ q: 'Q?', options: ['A', 'B'] }] });
  const woke = t.wakes.length;
  t.today.answer(id, { question: 0, text: 'A' });
  assert.equal(status(t, id), 'waiting');
  t.today.answer(id, { question: '0', text: 'Neither, use C' });
  assert.equal(status(t, id), 'new');
  assert.equal(JSON.parse(t.store.todayItem(id)!.questions!)[0].answer, 'Neither, use C');
  assert.equal(t.wakes.length, woke);
  assert.equal(t.today.answer(id, { question: 5, text: 'x' }).status, 400);
});

test('a result from the brain still waits for Release and must say what was not proven', () => {
  const t = setup();
  const id = addItem(t, 'x');
  assert.equal(t.today.result(id, { result: 'r' }).status, 400);
  t.today.result(id, { result: 'r', notProven: 'n', link: 'https://x.test/a' });
  const v = t.today.list().find(i => i.id === id)!;
  assert.equal(v.status, 'ready');
  assert.deepEqual(v.buttons, ['release', 'not-right']);
  assert.deepEqual(v.link, { label: 'Link', url: 'https://x.test/a' });
});

// ---- the brief ----
test('the morning line reads as the design says, once a day, after 8 AM Eastern, and only if there is something', async () => {
  assert.equal(morningLine([{ status: 'ready' }, { status: 'ready' }, { status: 'ready' }, { status: 'ready' }, { status: 'waiting' }, { status: 'waiting' }]), 'four items ready to check, two waiting on you');
  assert.equal(morningLine([{ status: 'ready' }]), 'one item ready to check');
  assert.equal(morningLine([{ status: 'working' }]), '');
  const t = setup();
  t.advance(Date.parse('2026-11-04T12:00:00Z') - T0); // 7 AM Eastern
  t.today.morning();
  assert.deepEqual(t.wakes, []);
  t.advance(90 * 60_000); // 8:30
  t.today.morning();
  assert.deepEqual(t.wakes, [], 'nothing on the list, so no model call');
  const u = setup();
  const id = addItem(u, 'who owns it');
  u.today.workup(id, { ...TALK, title: 'Who owns it' });
  await settle();
  u.wakes.length = 0;
  u.today.morning();
  assert.match(u.wakes[0], /one waiting on you.*"Who owns it"/s);
  u.today.morning();
  assert.equal(u.wakes.length, 1, 'once a day');
});

test('the session brief lists open rows and nothing when the list is empty', () => {
  assert.equal(todayBrief([]), '');
  const b = todayBrief([row({ id: 1, status: 'ready', title: 'A' }), row({ id: 2, status: 'released', title: 'B' })]);
  assert.match(b, /one item ready to check/);
  assert.match(b, /\[today\] item=1 ready "A"/);
  assert.doesNotMatch(b, /"B"/);
});

// ---- the routes ----
const route = (t: ReturnType<typeof setup>, method: string, url: string, b: any = {}, fromOwner = false) => todayRoute(t.today, method, url, b, { fromOwner: () => fromOwner });

test('the routes list, add and act', async () => {
  const t = setup();
  assert.deepEqual((await route(t, 'GET', '/api/today'))!.body.today, []);
  const add = await route(t, 'POST', '/api/today/add', { words: 'x', go: true });
  assert.equal(add!.status, 200);
  const id = add!.body.item.id;
  assert.equal(add!.body.item.go, true);
  assert.equal((await route(t, 'POST', '/api/today/act', { id, action: 'drop' }))!.status, 200);
  assert.equal(await route(t, 'POST', '/api/today/nope'), undefined);
  assert.equal(await route(t, 'DELETE', '/api/today'), undefined);
});

test('the brain\'s routes can set go only in a turn with the owner\'s message, and cannot press any button', async () => {
  const t = setup();
  const refused = await route(t, 'POST', '/api/internal/today', { words: 'x', go: true }, false);
  assert.equal(refused!.status, 409);
  assert.equal(t.today.list().length, 0);
  const ok = await route(t, 'POST', '/api/internal/today', { words: 'x', go: true }, true);
  assert.equal(ok!.body.item.go, true);
  const id = ok!.body.item.id;
  for (const op of ['act', 'accept', 'release', 'drop', 'do', 'not-right', 'retry']) assert.equal(await route(t, 'POST', `/api/internal/today/${id}/${op}`, { action: 'accept' }), undefined, op);
  assert.equal(await route(t, 'POST', '/api/internal/today/act', { id, action: 'accept' }), undefined);
  const wrote = await route(t, 'POST', `/api/internal/today/${id}/workup`, STORY);
  assert.equal(wrote!.status, 200);
  assert.equal(status(t, id), 'waiting');
  assert.deepEqual(t.pressed, []);
});

test('in main.ts the routes that act as the owner need an open page, and the brain cannot propose what they press', () => {
  const main = read('./main.ts');
  const set = /const AS_OWNER = new Set\(\[(.*?)\]\)/s.exec(main)![1];
  for (const r of ['/api/today/add', '/api/today/act', '/api/today/voice']) assert.ok(set.includes(`'${r}'`), r);
  for (const a of ['today-issue', 'today-start', 'today-draft']) assert.ok(PRESSED.has(a), a);
  assert.match(read('./webfiles.ts'), /'\/today\.js': 'today\.js'/);
});

test('the gate builds the three commands, with the footer on workers and no merge anywhere', () => {
  const id = { run: 'run_x', handle: 'term_x' };
  const issue = buildCommand('today-issue', { item: 1, repo: 'o/r', title: 'T', body: 'B' }, id);
  assert.deepEqual(issue, ['gh', 'issue', 'create', '--repo', 'o/r', '--title', 'T', '--body', 'B']);
  // Orca only when the args say so, since 2026-11-08.
  const start = buildCommand('today-start', { repo: REPO, spec: 'S', taskTitle: 'T', orca: true }, id);
  assert.ok(start.includes('new-top-level'));
  assert.match(start[start.indexOf('--spec') + 1], /Asking the coordinator/);
  const again = buildCommand('today-start', { repo: REPO, spec: 'S', taskTitle: 'T', worktree: 'path:/wt/a', keepOpen: true, orca: true }, id);
  assert.deepEqual(again.slice(again.indexOf('--worktree'), again.indexOf('--worktree') + 2), ['--worktree', 'path:/wt/a']);
  assert.ok(again.includes('--keep-open'));
  const draft = buildCommand('today-draft', { repo: REPO, spec: 'S', taskTitle: 'Draft: T', orca: true }, id);
  assert.ok(draft.includes(`path:${REPO}`));
  assert.throws(() => buildCommand('today-draft', { repo: 'relative', spec: 'S', taskTitle: 'T' }, id));
});

test('Today starts and drafts are native workers by default, and a rerun runs in its first folder', () => {
  const id = { run: 'run_x', handle: 'term_x' };
  const start = buildCommand('today-start', { repo: REPO, spec: 'S', taskTitle: 'T' }, id);
  assert.deepEqual(start.slice(0, 3), ['native', 'start', REPO]);
  assert.match(start[3], /## You are a Jarvis worker/);
  assert.doesNotMatch(start[3], /orca orchestration ask/);
  const again = buildCommand('today-start', { repo: REPO, spec: 'S', taskTitle: 'T', worktree: 'path:/wt/a', keepOpen: true }, id);
  assert.deepEqual(again.slice(0, 3), ['native', 'start', '/wt/a']);
  assert.throws(() => buildCommand('today-start', { repo: REPO, spec: 'S', taskTitle: 'T', worktree: 'path:relative' }, id), /absolute/);
  const draft = buildCommand('today-draft', { repo: REPO, spec: 'S', taskTitle: 'Draft: T' }, id);
  assert.deepEqual(draft.slice(0, 3), ['native', 'start', REPO]);
  // A story's issue rule loses the Orca wording: a native worker has no Orca brief.
  const story = buildCommand('today-start', { repo: REPO, spec: storyStartSpec('12', 'pick-and-ship'), taskTitle: '#12 T' }, id);
  assert.match(story[3], /One exception to not posting on GitHub/);
  assert.doesNotMatch(story[3], /Orca brief above/);
});

test('with the Orca link off, an Orca start or message is refused before anything runs; native ones still build', () => {
  const off = { run: '', handle: '' };
  for (const [action, args] of [
    ['today-start', { repo: REPO, spec: 'S', taskTitle: 'T', orca: true }],
    ['today-draft', { repo: REPO, spec: 'S', taskTitle: 'T', orca: true }],
    ['worker-start', { repo: REPO, spec: 'S', taskTitle: 'T', orca: true }],
    ['question', { repo: REPO, question: 'Why?', orca: true }],
    ['side-chat', { repo: REPO, text: 'hi', orca: true }],
    ['worker-send', { dispatch: 'ctx_1', text: 'hi' }],
  ] as const) assert.throws(() => buildCommand(action, args, off), /Orca link is off/, action);
  assert.equal(buildCommand('today-start', { repo: REPO, spec: 'S', taskTitle: 'T' }, off)[0], 'native');
  // A terminal the owner opened in Orca still takes terminal-send.
  assert.equal(buildCommand('terminal-send', { terminal: 'term_9', text: 'go' }, off)[0], 'orca');
});

test('terminal-send to a native session types through native.ts, never through Orca', async () => {
  const id = { run: 'run_x', handle: 'term_x' };
  assert.deepEqual(buildCommand('terminal-send', { terminal: 'n:abc', text: 'go on' }, id), ['native', 'type', 'n:abc', 'go on']);
  assert.throws(() => buildCommand('terminal-send', { terminal: 'n:a b', text: 'x' }, id), /not a native worker row/);
  const store = openStore(':memory:');
  const typed: [string, string, string][] = [];
  const native = { start: async () => { throw new Error('no'); }, stop: async () => {}, abandon: async () => {},
    reply: async (w: string, text: string, by: 'owner' | 'jarvis') => { typed.push([w, text, by]); return { ok: true as const }; } };
  const gate = makeGate(store, id, () => {}, () => {}, undefined, undefined, {}, native as any);
  const a = await gate.propose('terminal-send', { terminal: 'n:abc', text: 'go on' }, 'Tell it to go on?');
  const done = await gate.button(a.id, true);
  assert.equal(done.status, 'done');
  assert.deepEqual(typed, [['abc', 'go on', 'owner']]);
});

test('a native report: its DONE sentence is the result, and Not proven is read the same way', () => {
  const p = parseReport('w-1', 'DONE: Fixed the date parser.\n- branch fix-1\n\nNot proven: the phone view.');
  assert.equal(p.result, 'Fixed the date parser.');
  assert.equal(p.notProven, 'the phone view.');
});

test('the real CLI relays to the real routes, and has no way to press a button', async () => {
  const t = setup();
  const server = http.createServer(async (req, res) => {
    let s = ''; for await (const c of req) s += c;
    const r = await route(t, req.method!, req.url!, s ? JSON.parse(s) : {});
    res.writeHead(r?.status ?? 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify(r?.body ?? { error: 'not found' }));
  }).listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const bin = fileURLToPath(new URL('../bin/jarvis-today', import.meta.url));
  const cli = (...args: string[]) => new Promise<{ code: number; out: string; err: string }>(resolve => execFile(bin, args, { env: { ...process.env, JARVIS_URL: url } }, (e, out, err) => resolve({ code: e ? (e.code as number) : 0, out, err })));
  try {
    const added = await cli('add', '--words', 'Call Sam');
    assert.equal(added.code, 0);
    const id = JSON.parse(added.out).id;
    assert.equal((await cli('add', '--words', 'Not without the owner', '--go')).code, 1, 'go is refused outside his turn');
    assert.equal((await cli('workup', String(id), '--json', JSON.stringify(TASK))).code, 0);
    assert.equal(JSON.parse((await cli('list')).out)[0].statusWords, 'Waiting on you');
    assert.equal((await cli('answer', String(id), '--question', '3', '--text', 'x')).code, 1);
    assert.equal((await cli('workup', String(id), '--json', 'not json')).code, 2);
    for (const c of ['accept', 'release', 'drop', 'do']) assert.equal((await cli(c, String(id))).code, 2, c);
  } finally { server.close(); }
});

// ---- the page ----
test('the button counts Waiting on you plus Ready to check, and is there at zero', () => {
  assert.deepEqual(todayButton([]), { label: 'Today', count: 0, aria: 'Today, nothing needs you' });
  const list = [{ status: 'waiting' }, { status: 'ready' }, { status: 'working' }, { status: 'queued' }, { status: 'new' }, { status: 'released' }];
  assert.equal(todayButton(list).count, 2);
  assert.equal(todayButton([{ status: 'ready' }]).aria, 'Today, 1 item needs you');
  const page = read('../web/index.html');
  assert.match(page, /id="today-btn"(?![^>]*\bhidden\b)[^>]*>/, 'always visible');
  assert.match(page, /<div id="needbar">/, 'the bar is never hidden');
  assert.match(page, />Today</, 'the word, not an icon');
});

const view = (f: Partial<TodayRow>) => todayView(row({ status: 'waiting', title: 'T', ...f }));

test('an open row shows his words first, then the reading, the question with its recommended answer selected, and the buttons', () => {
  const html = detailHtml(view({ words: 'my <words>', reading: 'The reading', kind: 'story', story: '{}', questions: JSON.stringify([{ q: 'Q?', options: ['First', 'Second'], recommended: 1 }]), assumptions: '["Assumed"]' }));
  assert.ok(html.indexOf('my &lt;words&gt;') < html.indexOf('The reading'));
  assert.ok(html.indexOf('The reading') < html.indexOf('Q?'));
  assert.match(html, /value="Second" checked/);
  assert.doesNotMatch(html, /value="First" checked/);
  assert.match(html, /Second <small>Recommended/);
  assert.match(html, /Assumed/);
  for (const b of ['accept', 'not-right', 'drop']) assert.match(html, new RegExp(`data-act="${b}"`));
});

test('a different answer offers Send answers in place of Accept, and going back restores it', () => {
  const i = view({ kind: 'story', story: '{}', questions: JSON.stringify([{ q: 'Q?', options: ['A', 'B'], recommended: 0 }]) });
  assert.equal(answersChanged(i, { 0: 'B' }), true);
  assert.equal(answersChanged(i, { 0: 'A' }), false);
  assert.equal(shownAnswer(i.questions[0], undefined), 'A');
  const html = detailHtml(i, { picks: { 0: 'B' } });
  assert.match(html, /data-act="answers"/);
  assert.doesNotMatch(html, /data-act="accept"/);
});

test('a failed row shows its reason, a ready row its result and what was not proven, and all text is escaped', () => {
  assert.match(detailHtml(view({ kind: 'task', reason: 'It <broke>' })), /It &lt;broke&gt;/);
  const html = detailHtml(view({ status: 'ready', result: 'Did <it>', not_proven: 'The phone' }));
  assert.match(html, /Did &lt;it&gt;/);
  assert.match(html, /Not proven<\/h4><p>The phone/);
  assert.match(html, /data-act="release"/);
});

test('a working row has no buttons, and a link with another scheme is not drawn', () => {
  const html = detailHtml({ ...view({ status: 'working', line: 'Running' }), link: { label: 'x', url: 'javascript:alert(1)' } });
  assert.doesNotMatch(html, /data-act/);
  assert.doesNotMatch(html, /javascript:/);
  assert.match(html, /Running/);
});

test('waiting and ready rows show their mark, title, link and time but not the words, which stay for screen readers', () => {
  const ready = view({ id: 2, status: 'ready', link: '#report/3', link_label: 'Report' });
  const html = todayListHtml([view({ id: 1 }), ready, view({ id: 3, reason: 'The worker failed.' })]);
  assert.match(html, /<span class="t-status sr">Waiting on you<\/span>/);
  assert.match(html, /<span class="g g-waiting" aria-hidden="true"><\/span><span class="t-title">[^<]+<\/span><span class="t-status sr">Ready to check<\/span><\/button><a class="t-link" href="#report\/3">Report<\/a><span class="ago">/);
  assert.match(html, /<span class="g g-failed" aria-hidden="true">/);
  assert.doesNotMatch(html, /t-status need/);
  assert.equal(todayButton([view({ id: 1 }), ready]).count, 2);
});

test('the Today popup is 720 px wide on a desktop and full screen on a phone', () => {
  const css = readFileSync(new URL('../web/app.css', import.meta.url), 'utf8');
  assert.match(css, /\n#pop-today \{ width: 720px;/);
  assert.match(css, /@media \(max-width: 779\.98px\)[\s\S]*#pop-today \{ width: auto; height: auto; \}/);
});

test('the list folds Released under a count, shows the moved line, and has an empty state', () => {
  const list = [view({ id: 1 }), view({ id: 2, status: 'released', title: 'Old' })];
  const closed = todayListHtml(list);
  assert.match(closed, /Released \(1\)/);
  assert.doesNotMatch(closed, /Old/);
  assert.match(todayListHtml(list, { history: true }), /Old/);
  assert.match(todayListHtml([], { moved: { number: 4890, url: 'https://x.test/1' } }), /Moved to Stories, <a[^>]*>#4890/);
  assert.match(todayListHtml([]), /Drop a thought/);
});

test('the brain\'s file names the events, the command and the hard limits', () => {
  const v = read('../vault/CLAUDE.md');
  for (const s of ['[today pass]', '[today brief]', 'jarvis-today workup', 'jarvis-today draft', 'jarvis-today answer', 'Go never covers', 'exactly one question']) assert.ok(v.includes(s), s);
});
