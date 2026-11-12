import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openStore } from './store.ts';
import { makeRequests, DONE_KEEP_MS } from './requests.ts';
import { workRoute, completedRows, COMPLETED_KEY, REMOVED_AT } from './workroutes.ts';
import { mergeWork } from '../web/worklist.js';
import type { Work, WorkRow } from './work.ts';

const START = Date.parse('2026-11-12T15:00:00Z');

function setup() {
  const store = openStore(':memory:');
  let clock = START;
  const reqs = makeRequests({ store, log: () => {}, now: () => clock, onChange: () => {}, repoOf: async () => undefined, prOpen: async () => undefined });
  const sent: Record<string, string>[] = [];
  const o = { store, log: () => {}, requests: reqs, changed: (c: Record<string, string>) => sent.push(c), now: () => clock };
  const post = (url: string, body: object) => workRoute(o, 'POST', url, body);
  /** The gate started a worker for the owner. */
  const start = (dispatch: string) => {
    const a = store.addApproval({ action: 'worker-start', args: JSON.stringify({ repo: '/r', taskTitle: `Task ${dispatch}`, spec: 's' }), say: 'Start it?' });
    store.decide(a.id, 'approved', 'button');
    store.finishApproval(a.id, 'done', JSON.stringify({ dispatchId: dispatch }));
    reqs.started(store.approval(a.id)!);
    return store.requestOf(dispatch)!.id;
  };
  const row = (id: string, extra: Partial<WorkRow> = {}): WorkRow => ({ id, kind: 'worker', dispatch: id, title: `Row ${id}`, group: 'other', state: 'working', sideChat: false, steer: 'auto', ...extra });
  const work = (rows: WorkRow[], error?: string): Work => ({ at: '', rows, done: [], ...(error ? { error } : {}) });
  return { store, reqs, post, start, row, work, sent, tick: (ms: number) => { clock += ms; }, now: () => clock };
}

test('the × on a row with a request moves both to Completed in one call, and the page is told', async () => {
  const t = setup();
  const id = t.start('ctx_1');
  await t.reqs.sync(t.work([t.row('ctx_1')]), [{ dispatch: 'ctx_1', outcome: 'in_progress', path: '/w/a' }]);
  assert.equal(t.reqs.list()[0].status, 'working');

  const r = await t.post('/api/work/complete', { row: 'ctx_1', request: id });
  assert.equal(r?.status, 200);
  assert.deepEqual((r?.body as any).completed, { ctx_1: new Date(START).toISOString() });
  assert.deepEqual(t.sent, [{ ctx_1: new Date(START).toISOString() }], 'the page gets the new list');
  const [view] = t.reqs.list();
  assert.equal(view.status, 'done', 'the request is in Completed');
  assert.ok(t.store.request(id)!.closed_at, 'marked as closed by the owner');

  // The page draws it in Completed, and not in its group, while the worker still runs.
  const m = mergeWork([t.row('ctx_1')], t.reqs.list(), (r?.body as any).completed, t.now());
  assert.equal(m.groups.flatMap((g: any) => g.items).length, 0);
  assert.deepEqual(m.done.map((x: any) => x.id), [id]);
});

test('a closed request stays done while its worker runs on, and leaves with the normal purge a day later', async () => {
  const t = setup();
  const id = t.start('ctx_1');
  const live = [{ dispatch: 'ctx_1', outcome: 'in_progress', path: '/w/a' }];
  await t.post('/api/work/complete', { row: 'ctx_1', request: id });
  // status_at is the database clock. Put it at the test clock, as the purge reads it.
  t.store.db.prepare("UPDATE requests SET status_at = '2026-11-12 15:00:00'").run();

  await t.reqs.sync(t.work([t.row('ctx_1', { state: 'waiting' })]), live);
  assert.equal(t.reqs.list()[0].status, 'done', 'a waiting worker does not pull it back out');
  t.tick(DONE_KEEP_MS - 60_000);
  await t.reqs.sync(t.work([t.row('ctx_1')]), live);
  assert.equal(t.reqs.list().length, 1, 'still in Completed just under a day later');
  t.tick(60_000);
  await t.reqs.sync(t.work([t.row('ctx_1')]), live);
  assert.equal(t.reqs.list().length, 0, 'gone a day after the press');
  assert.ok(t.store.request(id)!.removed_at, 'marked, never deleted');
});

test('the × on a row with no request keeps the first press time, and a second press does not restart its day', async () => {
  const t = setup();
  await t.post('/api/work/complete', { row: 's:babysit' });
  t.tick(60_000);
  const again = await t.post('/api/work/complete', { row: 's:babysit' });
  assert.deepEqual((again?.body as any).completed, { 's:babysit': new Date(START).toISOString() });
});

test('the × in Completed removes now: the request leaves, the row stays out of its group and out of Completed', async () => {
  const t = setup();
  const id = t.start('ctx_1');
  await t.post('/api/work/complete', { row: 'ctx_1', request: id });
  await t.post('/api/work/complete', { row: 'plain' });
  const r = await t.post('/api/work/remove', { row: 'plain' });
  assert.equal((r?.body as any).completed.plain, REMOVED_AT);
  const r2 = await t.post('/api/work/remove', { row: 'ctx_1', request: id });
  assert.equal(r2?.status, 200);
  assert.equal(t.reqs.list().length, 0);
  const m = mergeWork([t.row('ctx_1'), t.row('plain')], t.reqs.list(), (r2?.body as any).completed, t.now());
  assert.equal(m.groups.flatMap((g: any) => g.items).length, 0);
  assert.equal(m.done.length, 0);
});

test('the routes refuse a body with nothing to move, and say when the request is gone', async () => {
  const t = setup();
  assert.equal((await t.post('/api/work/complete', {}))?.status, 400);
  assert.equal((await t.post('/api/work/complete', { row: '', request: 'x' }))?.status, 400);
  assert.equal((await t.post('/api/work/complete', { request: 99 }))?.status, 404);
  const id = t.start('ctx_1');
  assert.equal((await t.post('/api/work/complete', { request: id }))?.status, 200);
  assert.equal((await t.post('/api/work/complete', { request: id }))?.status, 404, 'a request closed twice is not closed again');
  assert.equal((await t.post('/api/work/remove', { request: 99 }))?.status, 404);
  assert.equal(await workRoute({ ...t, log: () => {}, requests: t.reqs, changed: () => {} }, 'GET', '/api/work/complete', {}), undefined);
  assert.equal(await workRoute({ ...t, log: () => {}, requests: t.reqs, changed: () => {} }, 'POST', '/api/work/hide', { id: 'a' }), undefined, 'the old hide route is gone');
  assert.deepEqual(t.sent, [], 'no row, so nothing to broadcast');
});

test('rows hidden before the change move to Completed once, at the time of the first read', () => {
  const store = openStore(':memory:');
  store.setState('workHidden', JSON.stringify(['a', 'b', 7]));
  assert.deepEqual(completedRows(store, START), { a: new Date(START).toISOString(), b: new Date(START).toISOString() });
  assert.deepEqual(completedRows(store, START + 5 * DONE_KEEP_MS), { a: new Date(START).toISOString(), b: new Date(START).toISOString() }, 'only once');
  assert.deepEqual(completedRows(openStore(':memory:'), START), {}, 'a new database has none');
  // A day after the move they are out of Completed, and they stay out of their group.
  const m = mergeWork([{ id: 'a', title: 'A', group: 'other', state: 'idle' }], [], completedRows(store), START + DONE_KEEP_MS + 1);
  assert.equal(m.done.length, 0);
  assert.equal(m.groups.flatMap((g: any) => g.items).length, 0);
});

test('the list keeps the newest 500 presses', async () => {
  const t = setup();
  t.store.setState(COMPLETED_KEY, JSON.stringify(Array.from({ length: 500 }, (_, i) => [`r${i}`, new Date(START).toISOString()])));
  const r = await t.post('/api/work/complete', { row: 'new' });
  const ids = Object.keys((r?.body as any).completed);
  assert.equal(ids.length, 500);
  assert.equal(ids.includes('r0'), false);
  assert.equal(ids.at(-1), 'new');
});

test('main.ts sends both routes to workRoute, behind the open-page check, and keeps no old hide route', () => {
  const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
  const set = /const AS_OWNER = new Set\(\[(.*?)\]\)/s.exec(main)![1];
  for (const r of ['/api/work/complete', '/api/work/remove']) assert.ok(set.includes(`'${r}'`), r);
  assert.match(main, /url === '\/api\/work\/complete' \|\| url === '\/api\/work\/remove'\) \{\s*const r = await workRoute\(/);
  assert.doesNotMatch(main, /\/api\/work\/hide|\/api\/requests\/hide|workHidden/);
  assert.match(main, /completed: completedRows\(store\)/);
});
