import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from './store.ts';
import { makeRequests, backfillRequests, statusOf, shownTitle, requestReport, DONE_KEEP_MS, type RequestView } from './requests.ts';
import { STOP_ANSWER } from './asks.ts';
import { requestGroups, requestListHtml } from '../web/requestlist.js';
import type { Work, WorkRow } from './work.ts';

function setup() {
  const store = openStore(':memory:');
  let clock = Date.parse('2026-10-30T12:00:00Z');
  const views: RequestView[][] = [];
  const prState = new Map<string, boolean>();
  const reqs = makeRequests({
    store, log: () => {}, now: () => clock, onChange: v => views.push(v),
    repoOf: async () => 'https://github.com/o/jarvis', prOpen: async url => prState.get(url),
  });
  /** the owner asks, Jarvis proposes, the gate starts the worker. */
  const start = (dispatch: string, words: string, args: object = { repo: '/r', taskTitle: `Task ${dispatch}`, spec: 's' }) => {
    store.addTurn({ role: 'owner', text: words });
    const a = store.addApproval({ action: 'worker-start', args: JSON.stringify(args), say: 'Start it?' });
    store.decide(a.id, 'approved', 'button');
    store.finishApproval(a.id, 'done', JSON.stringify({ dispatchId: dispatch, taskId: 't', state: 'ready' }));
    reqs.started(store.approval(a.id)!);
  };
  const row = (id: string, extra: Partial<WorkRow> = {}): WorkRow => ({ id, kind: 'worker', dispatch: id, title: id, group: 'other', state: 'working', sideChat: false, steer: 'auto', ...extra });
  const work = (rows: WorkRow[], error?: string): Work => ({ at: '', rows, done: [], ...(error ? { error } : {}) });
  return { store, reqs, start, row, work, views, prState, tick: (ms: number) => { clock += ms; } };
}

test('a started worker becomes a request with the owner\'s words; failed starts do not', () => {
  const { store, reqs, start } = setup();
  start('ctx_1', 'Add a requests sidebar please');
  const f = store.addApproval({ action: 'worker-start', args: '{}', say: 'Start?' });
  store.finishApproval(f.id, 'failed', 'error spawn_failed');
  reqs.started(store.approval(f.id)!);
  const list = reqs.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].title, 'Task ctx_1');
  assert.equal(list[0].words, 'Add a requests sidebar please');
  assert.equal(list[0].status, 'working');
});

/** the owner asks, Jarvis proposes a question, the gate starts its worker without a card. */
function askQuestion(store: ReturnType<typeof setup>['store'], dispatch: string, args: object = { repo: '/r', question: 'why?' }, words = 'Why does it do that?') {
  store.addTurn({ role: 'owner', text: words });
  const q = store.addApproval({ action: 'question', args: JSON.stringify(args), say: 'Asking a worker why it does that.' });
  store.decide(q.id, 'approved', 'automatic');
  store.finishApproval(q.id, 'done', JSON.stringify({ dispatchId: dispatch }));
  return store.approval(q.id)!;
}

test('a question worker is a request, titled by its taskTitle or else by what Jarvis said', () => {
  const { store, reqs } = setup();
  reqs.started(askQuestion(store, 'ctx_q'));
  reqs.started(askQuestion(store, 'ctx_t', { repo: '/r', question: 'how?', taskTitle: 'Dealer B thread' }));
  const failed = store.addApproval({ action: 'question', args: JSON.stringify({ repo: '/r', question: 'no' }), say: 'Asking' });
  store.finishApproval(failed.id, 'failed', 'error spawn_failed');
  reqs.started(store.approval(failed.id)!);
  assert.deepEqual(reqs.list().map(r => [r.title, r.words, r.status]), [
    ['Asking a worker why it does that.', 'Why does it do that?', 'working'],
    ['Dealer B thread', 'Why does it do that?', 'working'],
  ]);
});

test('a question moves from working to done on worker_done, then leaves after 24 hours', async () => {
  const { store, reqs, row, work, tick } = setup();
  reqs.started(askQuestion(store, 'ctx_q'));
  await reqs.sync(work([row('ctx_q', { worktree: 'jarvis' })]), [{ dispatch: 'ctx_q', outcome: 'in_progress', path: '/repos/jarvis' }]);
  assert.equal(reqs.list()[0].status, 'working');
  assert.equal(reqs.list()[0].row, 'ctx_q');

  store.insertItem({ source: 'orca', external_id: 'm1', kind: 'worker_done', dispatch_id: 'ctx_q', subject: 'Answered', body: 'Because.', meta: '{"outcome":"succeeded"}' });
  const finished = [{ dispatch: 'ctx_q', outcome: 'succeeded', path: '/repos/jarvis' }];
  await reqs.sync(work([]), finished);
  assert.equal(reqs.list()[0].status, 'done');
  assert.deepEqual(order(requestListHtml(reqs.list(), { done: true }, AT)), ['done', 'Asking a worker why it does that.']);

  store.db.prepare("UPDATE requests SET status_at = '2026-10-30 12:00:00'").run();
  tick(DONE_KEEP_MS);
  await reqs.sync(work([]), finished);
  assert.equal(reqs.list().length, 0);
});

test('a finished question ignores other sessions in the main checkout it ran in', async () => {
  const { store, reqs, row, work } = setup();
  reqs.started(askQuestion(store, 'ctx_q'));
  await reqs.sync(work([row('ctx_q', { worktree: 'jarvis' })]), [{ dispatch: 'ctx_q', outcome: 'in_progress', path: '/repos/jarvis' }]);
  store.insertItem({ source: 'orca', external_id: 'm1', kind: 'worker_done', dispatch_id: 'ctx_q', subject: 'Answered', meta: '{"outcome":"succeeded"}' });
  // the owner's own chat in that checkout sits at a prompt, on a branch with a PR. Neither belongs to the question.
  const other = row('s:owner', { kind: 'session', worktree: 'jarvis', state: 'waiting', pr: 'PR #9' });
  const finished = [{ dispatch: 'ctx_q', outcome: 'succeeded', path: '/repos/jarvis' }];
  await reqs.sync(work([other]), finished);
  await reqs.sync(work([other]), finished);
  const r = reqs.list()[0];
  assert.equal(r.status, 'done');
  assert.equal(r.row, undefined);
  assert.equal(r.pr, undefined);
});

test('a question stays done when its answer mentions a PR, and a real failure or wait still shows', async () => {
  const { store, reqs, row, work } = setup();
  reqs.started(askQuestion(store, 'ctx_q'));
  store.insertItem({ source: 'orca', external_id: 'm1', kind: 'worker_done', dispatch_id: 'ctx_q', subject: 'Answered', body: 'PR #12 changed it: https://github.com/o/jarvis/pull/12', meta: '{"outcome":"succeeded"}' });
  await reqs.sync(work([]), [{ dispatch: 'ctx_q', outcome: 'succeeded', path: '/repos/jarvis' }]);
  assert.equal(reqs.list()[0].status, 'done');
  assert.equal(reqs.list()[0].pr, undefined);

  reqs.started(askQuestion(store, 'ctx_w'));
  await reqs.sync(work([row('ctx_w', { state: 'waiting', note: 'Which repo?' })]), [{ dispatch: 'ctx_w', outcome: 'in_progress', path: '/repos/jarvis' }]);
  assert.equal(reqs.list().find(r => r.status === 'waiting')?.row, 'ctx_w');

  reqs.started(askQuestion(store, 'ctx_x'));
  await reqs.sync(work([row('ctx_x', { state: 'exited' })]), [{ dispatch: 'ctx_x', outcome: 'in_progress', path: '/repos/jarvis' }]);
  assert.equal(reqs.list().find(r => r.row === 'ctx_x')?.status, 'failed');
});

test('questions from the last days are backfilled too', () => {
  const store = openStore(':memory:');
  askQuestion(store, 'ctx_old_q');
  assert.equal(backfillRequests(store), 1);
  assert.equal(backfillRequests(store), 0);
  assert.deepEqual(store.requests().map(r => [r.action, r.dispatch_id, r.title]), [['question', 'ctx_old_q', 'Asking a worker why it does that.']]);
});

test('status follows the work list: waiting, working, in review with the PR link, then done once merged', async () => {
  const { store, reqs, start, row, work, prState } = setup();
  start('ctx_1', 'Do the thing');
  await reqs.sync(work([row('ctx_1', { state: 'waiting', note: 'Which colour?' })]), [{ dispatch: 'ctx_1', outcome: 'in_progress', path: '/w/cod' }]);
  assert.equal(reqs.list()[0].status, 'waiting');
  assert.equal(reqs.list()[0].row, 'ctx_1');
  await reqs.sync(work([row('ctx_1')]), [{ dispatch: 'ctx_1', outcome: 'in_progress', path: '/w/cod' }]);
  assert.equal(reqs.list()[0].status, 'working');

  // It finishes: worker_done names a PR number, and its chat stays as a session row in the same worktree.
  store.insertItem({ source: 'orca', external_id: 'm1', kind: 'worker_done', dispatch_id: 'ctx_1', subject: 'Done, PR #12', body: 'all good' });
  prState.set('https://github.com/o/jarvis/pull/12', true);
  const session = row('s:abc', { kind: 'session', worktree: 'cod', state: 'idle' });
  await reqs.sync(work([session]), [{ dispatch: 'ctx_1', outcome: 'succeeded', path: '/w/cod' }]);
  let r = reqs.list()[0];
  assert.equal(r.status, 'review');
  assert.equal(r.url, 'https://github.com/o/jarvis/pull/12');
  assert.equal(r.row, 's:abc'); // tapping it opens the finished worker's chat

  prState.set('https://github.com/o/jarvis/pull/12', false);
  await reqs.sync(work([session]), [{ dispatch: 'ctx_1', outcome: 'succeeded', path: '/w/cod' }]);
  assert.equal(reqs.list()[0].status, 'review'); // PR state is checked at most every 5 minutes
});

test('a merged PR is done, and a done request leaves 24 hours after it became done', async () => {
  const { store, reqs, start, row, work, prState, tick } = setup();
  start('ctx_1', 'Ship it');
  store.insertItem({ source: 'orca', external_id: 'm1', kind: 'worker_done', dispatch_id: 'ctx_1', subject: 'See https://github.com/o/jarvis/pull/7', body: '' });
  prState.set('https://github.com/o/jarvis/pull/7', false);
  const done = [{ dispatch: 'ctx_1', outcome: 'succeeded', path: '/w/cod' }];
  await reqs.sync(work([row('s:k', { kind: 'session', worktree: 'cod', state: 'idle' })]), done);
  assert.equal(reqs.list()[0].status, 'done');
  store.db.prepare("UPDATE requests SET status_at = '2026-10-30 12:00:00'").run(); // done at the test clock's start

  await reqs.sync(work([]), done); // the hourly cleanup removed the worktree soon after the merge
  tick(DONE_KEEP_MS - 60_000);
  await reqs.sync(work([]), done);
  assert.equal(reqs.list().length, 1); // still shown a few hours later, conversation gone or not

  tick(60_000);
  await reqs.sync(work([], 'Orca: no answer'), done); // Orca not answering never removes anything
  assert.equal(reqs.list().length, 1);
  await reqs.sync(work([row('s:k', { kind: 'session', worktree: 'cod', state: 'idle' })]), done);
  assert.equal(reqs.list().length, 0); // a day after done it leaves, even with its conversation still listed
  assert.ok(store.db.prepare('SELECT removed_at FROM requests').get()); // marked, never deleted
});

test('a live worker matches its request by dispatch id, whatever its title, before any worktree or session is known', async () => {
  const { reqs, start, row, work } = setup();
  start('ctx_1', 'Do it', { repo: '/r', taskTitle: '#4140 and #3165 Paused-account drive realignment', spec: 's' });
  // The same workspace's chat is listed too, under another title. The worker's own row wins.
  await reqs.sync(work([row('s:k', { kind: 'session', title: 'Pick ship issues 4140', worktree: 'kelpfish' }), row('ctx_1', { title: 'Task title in Orca' })]), [{ dispatch: 'ctx_1', outcome: 'in_progress', path: '/w/kelpfish' }]);
  const r = reqs.list()[0];
  assert.equal(r.row, 'ctx_1');
  assert.equal(r.status, 'working');
});

test('a request closes itself once its worker is missing from two polls in a row, and goes to done', async () => {
  const { reqs, start, row, work } = setup();
  start('ctx_1', 'Do it');
  await reqs.sync(work([row('ctx_1')]), [{ dispatch: 'ctx_1', outcome: 'in_progress' }]);
  await reqs.sync(work([]), []);
  assert.equal(reqs.list()[0].status, 'working'); // one poll proves nothing
  assert.equal(reqs.closing(reqs.list()[0].id), true);
  await reqs.sync(work([row('ctx_1')]), [{ dispatch: 'ctx_1', outcome: 'in_progress' }]);
  assert.equal(reqs.closing(reqs.list()[0].id), false); // it came back, so the count starts over
  await reqs.sync(work([]), []);
  assert.equal(reqs.list()[0].status, 'working');
  await reqs.sync(work([]), []);
  assert.equal(reqs.list()[0].status, 'done');
});

test('a row dropped from the list while Orca still says in progress counts as missing', async () => {
  const { reqs, start, work } = setup();
  start('ctx_1', 'Do it');
  const stuck = [{ dispatch: 'ctx_1', outcome: 'in_progress' }];
  await reqs.sync(work([]), stuck);
  await reqs.sync(work([]), stuck);
  assert.equal(reqs.list()[0].status, 'done');
});

test('a missing worker with a PR on its workspace closes to in review, not done', async () => {
  const { store, reqs, start, work, prState } = setup();
  start('ctx_1', 'Ship');
  store.db.prepare(`UPDATE requests SET pr = 'PR #3', pr_url = 'https://github.com/o/jarvis/pull/3'`).run();
  prState.set('https://github.com/o/jarvis/pull/3', true);
  await reqs.sync(work([]), []);
  await reqs.sync(work([]), []);
  assert.equal(reqs.list()[0].status, 'review');
});

test('a poll where a Run did not answer does not count a worker as missing', async () => {
  const { reqs, start, work } = setup();
  start('ctx_1', 'Do it');
  for (let i = 0; i < 5; i++) await reqs.sync(work([]), [], false);
  assert.equal(reqs.list()[0].status, 'working');
  assert.equal(reqs.closing(reqs.list()[0].id), false);
});

test('worker_done closes the request at once, by the outcome it reported, with the worker no longer listed', async () => {
  const { store, reqs, start, work } = setup();
  start('ctx_1', 'One');
  start('ctx_2', 'Two');
  store.insertItem({ source: 'orca', external_id: 'm1', kind: 'worker_done', dispatch_id: 'ctx_1', subject: 'Done', meta: '{"outcome":"succeeded"}' });
  store.insertItem({ source: 'orca', external_id: 'm2', kind: 'worker_done', dispatch_id: 'ctx_2', subject: 'Could not', meta: '{"outcome":"failed"}' });
  await reqs.sync(work([]), []);
  assert.deepEqual(reqs.list().map(r => r.status), ['done', 'failed']);
});

test('a finished request does not reopen, and a worker Orca reports finished wins over its worker_done', async () => {
  const { store, reqs, start, work } = setup();
  start('ctx_1', 'One');
  store.insertItem({ source: 'orca', external_id: 'm1', kind: 'worker_done', dispatch_id: 'ctx_1', subject: 'Done', meta: '{"outcome":"succeeded"}' });
  await reqs.sync(work([]), [{ dispatch: 'ctx_1', outcome: 'failed' }]);
  assert.equal(reqs.list()[0].status, 'failed');
  store.updateRequest(reqs.list()[0].id, { status: 'done' });
  await reqs.sync(work([]), []);
  await reqs.sync(work([]), []);
  assert.equal(reqs.list()[0].status, 'done');
});

test('a shown title drops a leading Request: or Requests:', async () => {
  assert.equal(shownTitle('Requests: keep done rows for a day'), 'keep done rows for a day');
  assert.equal(shownTitle('request:Strip prefixes'), 'Strip prefixes');
  assert.equal(shownTitle('REQUESTS : x'), 'x');
  assert.equal(shownTitle('Requests sidebar'), 'Requests sidebar');
  assert.equal(shownTitle('Request:'), 'Request:');
  const { reqs, start } = setup();
  start('ctx_1', 'Fix titles', { repo: '/r', taskTitle: 'Requests: titles without the topic', spec: 's' });
  assert.equal(reqs.list()[0].title, 'titles without the topic');
});

test('a failed request stays until the owner hides it', async () => {
  const { reqs, start, work, tick } = setup();
  start('ctx_1', 'Try it');
  await reqs.sync(work([]), [{ dispatch: 'ctx_1', outcome: 'failed' }]);
  tick(DONE_KEEP_MS * 3);
  await reqs.sync(work([]), [{ dispatch: 'ctx_1', outcome: 'failed' }]);
  assert.equal(reqs.list()[0].status, 'failed');
  assert.equal(reqs.hide(reqs.list()[0].id), true);
  assert.equal(reqs.list().length, 0);
  assert.equal(reqs.hide(1), false);
});

/** the owner approves a stop on the card and Orca stops the worker. */
function stop(store: ReturnType<typeof setup>['store'], dispatch: string, result: 'done' | 'failed' = 'done') {
  const a = store.addApproval({ action: 'worker-stop', args: JSON.stringify({ dispatch }), say: 'Stop it?' });
  store.decide(a.id, 'approved', 'button');
  store.finishApproval(a.id, result, JSON.stringify({ dispatchId: dispatch, state: 'stopped' }));
  return a.id;
}
const stoppedWorker = (dispatch: string) => [{ dispatch, outcome: 'failed', path: '/w/cod' }];

test('a worker the owner stopped lands in Completed, though Orca settles it as failed', async () => {
  const { store, reqs, start, row, work } = setup();
  start('ctx_1', 'Try it');
  await reqs.sync(work([row('ctx_1')]), [{ dispatch: 'ctx_1', outcome: 'in_progress', path: '/w/cod' }]);
  stop(store, 'ctx_1');
  await reqs.sync(work([]), stoppedWorker('ctx_1'));
  assert.equal(reqs.list()[0].status, 'done');
  assert.deepEqual(requestGroups(reqs.list()).done.map((r: RequestView) => r.title), ['Task ctx_1']);
  await reqs.sync(work([]), stoppedWorker('ctx_1'));
  assert.equal(reqs.list()[0].status, 'done');
});

test('a stopped worker still listed as exited is done', async () => {
  const { store, reqs, start, row, work } = setup();
  start('ctx_1', 'Try it');
  stop(store, 'ctx_1');
  await reqs.sync(work([row('ctx_1', { state: 'exited' })]), [{ dispatch: 'ctx_1', outcome: 'in_progress', path: '/w/cod' }]);
  assert.equal(reqs.list()[0].status, 'done');
});

test('a stopped worker with an open PR waits for merge', async () => {
  const { store, reqs, start, work, prState } = setup();
  start('ctx_1', 'Ship');
  store.db.prepare(`UPDATE requests SET pr = 'PR #3', pr_url = 'https://github.com/o/jarvis/pull/3'`).run();
  prState.set('https://github.com/o/jarvis/pull/3', true);
  stop(store, 'ctx_1');
  await reqs.sync(work([]), stoppedWorker('ctx_1'));
  assert.equal(reqs.list()[0].status, 'review');
});

test('a request a stop already left as failed moves to done, with its worker gone from Orca too', async () => {
  const { store, reqs, start, work } = setup();
  start('ctx_1', 'Try it');
  const a = stop(store, 'ctx_1');
  store.db.prepare(`UPDATE approvals SET decided_at = '2026-11-03 13:15:07' WHERE id = ?`).run(a);
  store.db.prepare(`UPDATE requests SET status = 'failed', status_at = '2026-11-03 13:15:16'`).run();
  await reqs.sync(work([]), []);
  assert.equal(reqs.list()[0].status, 'done');
});

test('a real failure stays failed: no stop, a stop that did not go through, or a failure before the stop', async () => {
  const { store, reqs, start, work } = setup();
  start('ctx_none', 'No stop');
  await reqs.sync(work([]), stoppedWorker('ctx_none'));
  assert.equal(reqs.list()[0].status, 'failed');

  start('ctx_refused', 'Stop refused');
  stop(store, 'ctx_refused', 'failed');
  await reqs.sync(work([]), stoppedWorker('ctx_refused'));
  assert.equal(reqs.list()[1].status, 'failed');

  // It failed, and the owner stopped what was left of it afterwards.
  start('ctx_before', 'Failed first');
  const a = stop(store, 'ctx_before');
  store.db.prepare(`UPDATE approvals SET decided_at = '2026-11-03 13:15:07' WHERE id = ?`).run(a);
  store.db.prepare(`UPDATE requests SET status = 'failed', status_at = '2026-11-03 13:00:00' WHERE dispatch_id = 'ctx_before'`).run();
  await reqs.sync(work([]), stoppedWorker('ctx_before'));
  assert.equal(reqs.list()[2].status, 'failed');

  // It reported failure itself before the stop.
  start('ctx_report', 'Reported first');
  store.insertItem({ source: 'orca', external_id: 'r1', kind: 'worker_done', dispatch_id: 'ctx_report', subject: 'Could not', meta: '{"outcome":"failed"}' });
  store.db.prepare(`UPDATE items SET created_at = '2026-11-03 13:00:00' WHERE external_id = 'r1'`).run();
  const b = stop(store, 'ctx_report');
  store.db.prepare(`UPDATE approvals SET decided_at = '2026-11-03 13:15:07' WHERE id = ?`).run(b);
  await reqs.sync(work([]), stoppedWorker('ctx_report'));
  assert.equal(reqs.list()[3].status, 'failed');
});

test('the ask card Stop: the worker keeps its status until it ends, then it is done even if it reports failed', async () => {
  const { store, reqs, start, row, work } = setup();
  start('ctx_1', 'Try it');
  store.insertItem({ source: 'orca', external_id: 'e1', kind: 'escalation', dispatch_id: 'ctx_1', subject: 'Blocked', body: 'Stuck' });
  store.markItem('e1', 'answered', STOP_ANSWER);
  const running = [{ dispatch: 'ctx_1', outcome: 'in_progress', path: '/w/cod' }];
  await reqs.sync(work([row('ctx_1')]), running);
  assert.equal(reqs.list()[0].status, 'working');
  await reqs.sync(work([]), [], false); // a poll where Orca did not answer proves nothing
  assert.equal(reqs.list()[0].status, 'working');

  store.insertItem({ source: 'orca', external_id: 'd1', kind: 'worker_done', dispatch_id: 'ctx_1', subject: 'Stopped as asked', meta: '{"outcome":"failed"}' });
  await reqs.sync(work([]), stoppedWorker('ctx_1'));
  assert.equal(reqs.list()[0].status, 'done');
});

test('another ask card answer is not a stop', async () => {
  const { store, reqs, start, work } = setup();
  start('ctx_1', 'Try it');
  store.insertItem({ source: 'orca', external_id: 'e1', kind: 'escalation', dispatch_id: 'ctx_1', subject: 'Blocked', body: 'Stuck' });
  store.markItem('e1', 'answered', 'Retry the step that stopped you, then carry on.');
  await reqs.sync(work([]), stoppedWorker('ctx_1'));
  assert.equal(reqs.list()[0].status, 'failed');
});

test('worker starts from before the table existed are backfilled once, with the owner\'s words', () => {
  const store = openStore(':memory:');
  store.addTurn({ role: 'owner', text: 'Render markdown in the chat' });
  const a = store.addApproval({ action: 'worker-start', args: JSON.stringify({ repo: '/r', taskTitle: 'Render markdown', spec: 's' }), say: 'Start?' });
  store.finishApproval(a.id, 'done', JSON.stringify({ dispatchId: 'ctx_old' }));
  const sc = store.addApproval({ action: 'side-chat', args: JSON.stringify({ repo: '/r', text: 'test the thing\nmore' }), say: 'Side chat' });
  store.finishApproval(sc.id, 'done', JSON.stringify({ dispatchId: 'ctx_sc' }));
  assert.equal(backfillRequests(store), 1);
  assert.equal(backfillRequests(store), 0);
  const rows = store.requests();
  assert.deepEqual(rows.map(r => [r.title, r.words]), [['Render markdown', 'Render markdown in the chat']]);
});

test('a side chat never becomes a request, and side chat rows already stored are hidden on open', () => {
  const { store, reqs } = setup();
  const sc = store.addApproval({ action: 'side-chat', args: JSON.stringify({ repo: '/r', text: 'test' }), say: 'Side chat' });
  store.finishApproval(sc.id, 'done', JSON.stringify({ dispatchId: 'ctx_sc' }));
  reqs.started(store.approval(sc.id)!);
  assert.equal(reqs.list().length, 0);

  const dir = mkdtempSync(join(tmpdir(), 'jarvis-req-'));
  const file = join(dir, 'j.db');
  const old = openStore(file);
  old.addRequest({ dispatch_id: 'ctx_old_sc', action: 'side-chat', title: 'Side chat: test' });
  old.addRequest({ dispatch_id: 'ctx_w', action: 'worker-start', title: 'Real work' });
  old.db.close();
  const reopened = openStore(file);
  assert.deepEqual(reopened.requests().map(r => r.title), ['Real work']);
  assert.ok(reopened.db.prepare(`SELECT hidden_at FROM requests WHERE dispatch_id = 'ctx_old_sc'`).get(), 'the row is hidden, not deleted');
  reopened.db.close();
  rmSync(dir, { recursive: true });
});

test('statusOf: a waiting session wins, an exited worker is failed, an unknown worker changes nothing', () => {
  const w = { id: 's:x', kind: 'session', title: '', group: 'other', state: 'waiting', sideChat: false, steer: 'none' } as WorkRow;
  assert.equal(statusOf(w, 'succeeded', false, null, undefined, true), 'waiting');
  assert.equal(statusOf({ ...w, state: 'exited' }, 'in_progress', true, null, undefined, false), 'failed');
  assert.equal(statusOf(undefined, 'succeeded', false, null, undefined, true), 'done');
  assert.equal(statusOf(undefined, undefined, false, 'PR #1', undefined, false), undefined);
});

// ---- the page's list, web/requestlist.js ----

const AT = Date.parse('2026-10-30T12:00:00Z');
const req = (id: number, status: string, minutesAgo = 5, extra: object = {}) => ({ id, status, title: `R${id}`, row: `r${id}`, at: new Date(AT - minutesAgo * 60_000).toISOString(), ...extra });
const order = (html: string) => [...html.matchAll(/data-folder="(\w+)"|<div class="t">([^<]+)</g)].map(m => m[1] ?? m[2]);

test('the list: open rows, then Waiting for merge, then Completed', () => {
  const html = requestListHtml([req(1, 'done'), req(2, 'review'), req(3, 'failed'), req(4, 'working'), req(5, 'waiting')], {}, AT);
  assert.deepEqual(order(html), ['R5', 'R4', 'R3', 'review', 'R2', 'done', 'R1']);
});

test('a review request leaves the open rows; failed ones stay', () => {
  const { open, review, done } = requestGroups([req(1, 'review'), req(2, 'failed'), req(3, 'done')]);
  assert.deepEqual([open, review, done].map(g => g.map(r => r.id)), [[2], [1], [3]]);
});

test('each folder sorts newest change first', () => {
  const { review } = requestGroups([req(1, 'review', 90), req(2, 'review', 5), req(3, 'review', 30)]);
  assert.deepEqual(review.map(r => r.id), [2, 3, 1]);
});

test('Waiting for merge shows its count while closed, and its rows stay hidden until opened', () => {
  const rows = [req(1, 'review'), req(2, 'review')];
  const closed = requestListHtml(rows, {}, AT);
  assert.match(closed, /aria-expanded="false" aria-controls="req-review">.*Waiting for merge<span class="n">2<\/span><\/button><div id="req-review" hidden>/);
  const open = requestListHtml(rows, { review: true }, AT);
  assert.match(open, /aria-expanded="true" aria-controls="req-review">.*<div id="req-review">/);
});

test('the two folders open separately', () => {
  const html = requestListHtml([req(1, 'review'), req(2, 'done')], { done: true }, AT);
  assert.match(html, /<div id="req-review" hidden>/);
  assert.match(html, /<div id="req-done">/);
});

test('a row in Waiting for merge keeps its In review status and PR link', () => {
  const html = requestListHtml([req(1, 'review', 5, { pr: 'PR #12', url: 'https://github.com/o/jarvis/pull/12' })], {}, AT);
  assert.match(html, /<span class="state">In review<\/span>/);
  assert.match(html, /<a href="https:\/\/github.com\/o\/jarvis\/pull\/12"[^>]*>PR #12<\/a>/);
});

const PR = { pr: 'PR #4407', url: 'https://github.com/o/r/pull/4407' };
const shared = [req(1, 'review', 5, PR), req(2, 'review', 10, PR), req(3, 'review', 20, PR), req(4, 'review', 30, PR)];
const prRows = (html: string) => [...html.matchAll(/data-pr="([^"]+)"/g)].map(m => m[1]);

test('Waiting for merge folds requests that share a PR into one row, linked to the PR, with a count', () => {
  const html = requestListHtml(shared, { review: true }, AT);
  assert.deepEqual(prRows(html), ['PR #4407']);
  assert.match(html, /<a href="https:\/\/github.com\/o\/r\/pull\/4407" class="num"[^>]*>PR #4407<\/a><div class="t">4 sessions<\/div>/);
  assert.match(html, /<span class="ago">5 min<\/span>/, 'the row shows the newest change');
});

test('a PR row starts collapsed, and the folder keeps counting every request', () => {
  const html = requestListHtml(shared, { review: true }, AT);
  assert.match(html, /data-pr="PR #4407"[^>]*aria-expanded="false" aria-controls="req-PR-4407"/);
  assert.match(html, /<div id="req-PR-4407" class="prrows" hidden>/);
  assert.match(html, /Waiting for merge<span class="n">4<\/span>/);
});

test('an expanded PR row lists each conversation, each one still openable and hideable, with no PR number repeated', () => {
  const html = requestListHtml(shared, { review: true, prs: new Set(['PR #4407']) }, AT);
  assert.match(html, /data-pr="PR #4407"[^>]*aria-expanded="true"/);
  assert.match(html, /<div id="req-PR-4407" class="prrows">/);
  assert.deepEqual(order(html), ['review', '4 sessions', 'R1', 'R2', 'R3', 'R4']);
  for (const id of [1, 2, 3, 4]) {
    assert.match(html, new RegExp(`data-row="r${id}"`));
    assert.match(html, new RegExp(`data-hide="${id}" data-hide-row="r${id}"`));
  }
  assert.equal(html.match(/>PR #4407</g)?.length, 1);
});

test('a conversation in a PR row keeps its story number', () => {
  const html = requestListHtml([req(1, 'review', 5, { ...PR, title: '#4380 Preview onboarding' }), req(2, 'review', 10, PR)], { review: true }, AT);
  assert.match(html, />#4380<\/a><div class="t">Preview onboarding</);
});

test('a PR row with no known link shows the PR number as plain text, and takes a link any of its requests knows', () => {
  const plain = requestListHtml([req(1, 'review', 5, { pr: 'PR #9' }), req(2, 'review', 10, { pr: 'PR #9' })], { review: true }, AT);
  assert.match(plain, /<span class="num">PR #9<\/span><div class="t">2 sessions</);
  const one = requestListHtml([req(1, 'review', 5, { pr: 'PR #9' }), req(2, 'review', 10, { pr: 'PR #9', url: 'https://x/pull/9' })], { review: true }, AT);
  assert.match(one, /<a href="https:\/\/x\/pull\/9" class="num"[^>]*>PR #9<\/a><div class="t">2 sessions/);
});

test('a PR row sits where its newest request sorts, among the single rows', () => {
  const html = requestListHtml([req(1, 'review', 50, PR), req(2, 'review', 40), req(3, 'review', 30, PR), req(4, 'review', 60)], { review: true }, AT);
  assert.deepEqual(order(html), ['review', '2 sessions', 'R3', 'R1', 'R2', 'R4']);
});

test('a request alone on its PR, or with a story number and no shared PR, stays a plain row', () => {
  const html = requestListHtml([req(1, 'review', 5, PR), req(2, 'review', 10, { title: '#4612 Story', pr: 'PR #8', url: 'https://x/pull/8' }), req(3, 'review', 15, { title: '#4613 No PR' })], { review: true }, AT);
  assert.deepEqual(prRows(html), []);
  assert.doesNotMatch(html, /sessions/);
  assert.deepEqual(order(html), ['review', 'R1', 'Story', 'No PR']);
  assert.match(html, />PR #4407<\/a><div class="t">R1</);
});

test('Completed stays one row per request, even for a shared PR', () => {
  const html = requestListHtml([req(1, 'done', 5, PR), req(2, 'done', 10, PR)], { done: true }, AT);
  assert.deepEqual(prRows(html), []);
  assert.deepEqual(order(html), ['done', 'R1', 'R2']);
});

test('an empty folder is not drawn, and no requests at all says so', () => {
  assert.deepEqual(order(requestListHtml([req(1, 'working')], {}, AT)), ['R1']);
  assert.match(requestListHtml([], {}, AT), /Nothing asked yet/);
});

test('when the PR merges, the row moves from Waiting for merge to Completed', async () => {
  const { store, reqs, start, row, work, prState, tick } = setup();
  const finished = [{ dispatch: 'ctx_1', outcome: 'succeeded', path: '/w/cod' }];
  start('ctx_1', 'Do the thing');
  store.insertItem({ source: 'orca', external_id: 'm1', kind: 'worker_done', dispatch_id: 'ctx_1', subject: 'Done, PR #12', body: 'all good' });
  prState.set('https://github.com/o/jarvis/pull/12', true);
  const session = row('s:abc', { kind: 'session', worktree: 'cod', state: 'idle' });
  await reqs.sync(work([session]), finished);
  assert.deepEqual(order(requestListHtml(reqs.list(), { review: true }, AT)), ['review', 'Task ctx_1']);

  prState.set('https://github.com/o/jarvis/pull/12', false);
  tick(6 * 60_000);
  await reqs.sync(work([session]), finished);
  assert.deepEqual(order(requestListHtml(reqs.list(), { done: true }, AT)), ['done', 'Task ctx_1']);
});

/** The gate starts a native worker: its result names the worker `n:<id>`, never a dispatch id (gate.ts runNative). */
function startNative(store: ReturnType<typeof setup>['store'], reqs: ReturnType<typeof setup>['reqs'], id: string, title: string) {
  const t = '2026-10-30T12:00:00.000Z';
  store.addNativeWorker({ id, session_id: `sess-${id}`, name: `${id}-name`, cwd: `/repos/wt-${id}`, approval_id: null, state: 'working', waiting_for: null, report: null, report_at: null, outcome: null, transcript: null, created_at: t, updated_at: t });
  store.addTurn({ role: 'owner', text: 'Fix the button' });
  const a = store.addApproval({ action: 'worker-start', args: JSON.stringify({ repo: '/r', taskTitle: title, spec: 's', native: true }), say: 'Start it?' });
  store.decide(a.id, 'approved', 'button');
  store.finishApproval(a.id, 'done', JSON.stringify({ worker: `n:${id}`, sessionId: `sess-${id}`, name: `${id}-name`, state: 'working' }));
  return reqs.started(store.approval(a.id)!);
}
const nativeRow = (id: string, state: WorkRow['state'] = 'working'): WorkRow => ({ id: `n:${id}`, kind: 'worker', dispatch: `n:${id}`, title: id, group: 'other', state, sideChat: false, steer: 'auto' });

test('a native worker start becomes a request whose row opens the worker, with no Orca call', async () => {
  const store = openStore(':memory:');
  const orcaCalls: string[][] = [];
  const reqs = makeRequests({ store, log: () => {}, onChange: () => {}, repoOf: async () => undefined, orca: async args => { orcaCalls.push(args); return { ok: false } as any; } });
  await startNative(store, reqs, 'abc123', 'Native task');
  const [r] = reqs.list();
  assert.equal(r.title, 'Native task');
  assert.equal(r.words, 'Fix the button');
  assert.equal(r.status, 'working');
  // Before the next poll the row is already the worker's own, so the tap opens its chat.
  assert.equal(r.row, 'n:abc123');
  await reqs.sync({ at: '', rows: [nativeRow('abc123')], done: [] }, []);
  assert.equal(reqs.list()[0].row, 'n:abc123');
  assert.equal(reqs.list()[0].status, 'working');
  await reqs.read(r.id, undefined, new Map());
  assert.equal(store.request(r.id)!.session, 'sess-abc123');
  assert.equal(store.request(r.id)!.worktree, 'wt-abc123');
  assert.deepEqual(orcaCalls, []);
});

test('a native DONE report marks the request done, and a FAILED one failed, while the row is still listed', async () => {
  const store = openStore(':memory:');
  const reqs = makeRequests({ store, log: () => {}, onChange: () => {}, repoOf: async () => undefined });
  await startNative(store, reqs, 'ok1', 'Works');
  await startNative(store, reqs, 'bad1', 'Breaks');
  const at = '2026-10-30T12:30:00.000Z';
  store.updateNativeWorker('ok1', { state: 'done', outcome: 'done', report: 'DONE: fixed it.', report_at: at });
  store.updateNativeWorker('bad1', { state: 'failed', outcome: 'failed', report: 'FAILED: tests broke.', report_at: at });
  // native.rows() keeps finished workers listed for a day: done is idle, failed is exited.
  await reqs.sync({ at: '', rows: [nativeRow('ok1', 'idle'), nativeRow('bad1', 'exited')], done: [] }, []);
  const by = new Map(reqs.list().map(r => [r.title, r]));
  assert.equal(by.get('Works')!.status, 'done');
  assert.equal(by.get('Breaks')!.status, 'failed');
  assert.equal(by.get('Works')!.row, 'n:ok1');
});

test('the report page shows a native worker\'s report from its own row', async () => {
  const store = openStore(':memory:');
  const reqs = makeRequests({ store, log: () => {}, onChange: () => {}, repoOf: async () => undefined });
  await startNative(store, reqs, 'rep1', 'Reports');
  const r = reqs.list()[0];
  assert.equal(requestReport(store, r!.id), undefined, 'no report before the worker reports');
  store.updateNativeWorker('rep1', { state: 'done', outcome: 'done', report: 'DONE: fixed it.\nBranch x, commit y.', report_at: '2026-10-30T12:30:00.000Z' });
  const rep = requestReport(store, r!.id)!;
  assert.equal(rep.body, 'DONE: fixed it.\nBranch x, commit y.');
  assert.equal(rep.failed, false);
  assert.equal(rep.at, '2026-10-30T12:30:00Z');
  await reqs.sync({ at: '', rows: [nativeRow('rep1', 'idle')], done: [] }, []);
  assert.equal(reqs.list()[0].report, true, 'the row gets its Report link');
  store.updateNativeWorker('rep1', { state: 'failed', outcome: 'failed', report: 'FAILED: tests broke.' });
  assert.equal(requestReport(store, r!.id)!.failed, true);
});

test('more work after DONE puts a native request back to Working until its next DONE or FAILED', async () => {
  const store = openStore(':memory:');
  const reqs = makeRequests({ store, log: () => {}, onChange: () => {}, repoOf: async () => undefined });
  await startNative(store, reqs, 'again1', 'Again');
  const r = reqs.list()[0];
  const report = (text: string, at: string, outcome: 'done' | 'failed' = 'done') => store.updateNativeWorker('again1', { state: outcome, outcome, report: text, report_at: at });
  const reply = (at: string) => {
    store.insertItem({ source: 'native', external_id: `reply:again1:${at}`, kind: 'reply', dispatch_id: 'n:again1', body: 'one more thing', status: 'done' });
    store.db.prepare('UPDATE items SET created_at = ? WHERE external_id = ?').run(at, `reply:again1:${at}`);
  };
  const status = async (state: WorkRow['state'] = 'idle') => { await reqs.sync({ at: '', rows: [nativeRow('again1', state)], done: [] }, []); return store.request(r!.id)!.status; };
  report('DONE: first pass.', '2026-10-30T12:30:00.000Z');
  assert.equal(await status(), 'done');
  reply('2026-10-30 12:31:00'); // the owner's steer box, or jarvis-native reply
  assert.equal(await status(), 'working');
  assert.equal(await status('working'), 'working');
  // A turn that only asks something replaces the report text but keeps the old outcome: still not done.
  report('Which file did you mean?', '2026-10-30T12:32:00.000Z');
  assert.equal(await status(), 'working');
  report('DONE: second pass.', '2026-10-30T12:33:00.000Z');
  assert.equal(await status(), 'done');
  reply('2026-10-30 12:34:00');
  assert.equal(await status(), 'working');
  report('FAILED: could not.', '2026-10-30T12:35:00.000Z', 'failed');
  assert.equal(await status('exited'), 'failed');
});

test('a native request takes its session and worktree from its own row at the sync, with no Orca call', async () => {
  const store = openStore(':memory:');
  const orcaCalls: string[][] = [];
  const reqs = makeRequests({ store, log: () => {}, onChange: () => {}, repoOf: async () => undefined, orca: async args => { orcaCalls.push(args); return { ok: false } as any; } });
  await startNative(store, reqs, 'wt1', 'In a worktree');
  // A worker started in the main checkout, as `worktree: main`: its folder is the repo itself, so it is not its worktree.
  await startNative(store, reqs, 'main1', 'In the main checkout');
  store.updateNativeWorker('main1', { cwd: '/repos/jarvis' });
  store.db.prepare("UPDATE native_workers SET repo = '/repos/jarvis' WHERE id = 'main1'").run();
  await reqs.sync({ at: '', rows: [nativeRow('wt1'), nativeRow('main1')], done: [] }, [], false);
  const by = new Map(store.requests().map(r => [r.title, r]));
  assert.equal(by.get('In a worktree')!.session, 'sess-wt1');
  assert.equal(by.get('In a worktree')!.worktree, 'wt-wt1');
  assert.equal(by.get('In the main checkout')!.session, 'sess-main1');
  assert.equal(by.get('In the main checkout')!.worktree, null);
  // The listing later names the worker's real worktree: the request follows it.
  store.updateNativeWorker('main1', { cwd: '/repos/jarvis/.claude/worktrees/later-1' });
  await reqs.sync({ at: '', rows: [nativeRow('wt1'), nativeRow('main1')], done: [] }, [], false);
  assert.equal(store.requests().find(r => r.title === 'In the main checkout')!.worktree, 'later-1');
  assert.deepEqual(orcaCalls, []);
});

test('a native DONE that names "PR #12" links to that PR from the worker\'s own folder', async () => {
  const store = openStore(':memory:');
  const asked: string[] = [];
  const reqs = makeRequests({ store, log: () => {}, onChange: () => {}, repoOf: async dir => { asked.push(dir); return 'https://github.com/o/jarvis'; }, prOpen: async () => true });
  await startNative(store, reqs, 'pr1', 'With a PR');
  store.updateNativeWorker('pr1', { state: 'done', outcome: 'done', report: 'DONE: opened PR #12.', report_at: '2026-10-30T12:30:00.000Z' });
  await reqs.sync({ at: '', rows: [nativeRow('pr1', 'idle')], done: [] }, [], false);
  const r = store.requests()[0];
  assert.equal(r.pr, 'PR #12');
  assert.equal(r.pr_url, 'https://github.com/o/jarvis/pull/12');
  assert.deepEqual(asked, ['/repos/wt-pr1']);
  assert.equal(r.status, 'review');
});

test('a done native request leaves a day after done while Orca is not answering; an Orca one waits for Orca', async () => {
  const { store, reqs, start, work, tick } = setup();
  await startNative(store, reqs, 'day1', 'Native done');
  start('ctx_o', 'Orca task');
  store.updateNativeWorker('day1', { state: 'done', outcome: 'done', report: 'DONE: fixed.', report_at: '2026-10-30T12:30:00.000Z' });
  store.insertItem({ source: 'orca', external_id: 'm1', kind: 'worker_done', dispatch_id: 'ctx_o', subject: 'Done', body: 'Fixed.', meta: '{"outcome":"succeeded"}' });
  await reqs.sync(work([nativeRow('day1', 'idle')]), [{ dispatch: 'ctx_o', outcome: 'succeeded' }]);
  assert.deepEqual(store.requests().map(r => r.status), ['done', 'done']);
  store.db.prepare("UPDATE requests SET status_at = '2026-10-30 12:00:00'").run();
  tick(DONE_KEEP_MS);
  // Orca closed: the poll errors, and only the native request may leave.
  await reqs.sync(work([], 'orca did not answer'), [], false);
  assert.deepEqual(reqs.list().map(r => r.title), ['Task ctx_o']);
});
