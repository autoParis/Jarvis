// The work list's routes, tested through workRoute() with a fake request, as nativeroutes.test.ts does.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from './store.ts';
import { workRoute, completedRows, steerWorker, COMPLETED_KEY, REMOVED_AT, type WorkCtx } from './workroutes.ts';
import { makeRequests, DONE_KEEP_MS } from './requests.ts';
import { mergeWork } from '../web/worklist.js';
import { readFileSync } from 'node:fs';
import type { Work, WorkRow } from './work.ts';
import { READ_PICTURES } from '../web/compose.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const body = (v: unknown) => async () => v;
const none = () => { throw new Error('the route read a body it does not need'); };
const q = (s = '') => new URLSearchParams(s);

const nativeRow = { id: 'n:w1', kind: 'worker' as const, dispatch: 'n:w1', title: 'Fix the badge', group: 'story' as const, state: 'working' as const, steer: 'auto' as const,
  native: { id: 'w1', sessionId: 's-1', name: 'fix-badge', state: 'idle' as any, waitingFor: null, outcome: null } };
const termRow = { id: 't:x', kind: 'session' as const, title: 'Terminal', group: 'terminal' as const, state: 'idle' as const, steer: 'none' as const,
  tmux: { name: 'x', project: 'p', kind: 'terminal' as const, cwd: '/tmp', branch: 'main' } };

function setup(over: Partial<WorkCtx> = {}) {
  const store = openStore(':memory:');
  const seen: any = { broadcast: [], published: 0, synced: 0, changed: [], woke: [], pressed: [], recorded: [], replied: [], watched: [], phone: [] };
  const worker: any = { id: 'w1', session_id: 's-1', cwd: '/repo', state: 'idle', remote: undefined };
  const o: WorkCtx = {
    native: {
      get: (id: string) => (id === 'w1' || id === 'n:w1' ? worker : undefined),
      transcriptFile: () => undefined,
      reply: async (id: string, text: string, by: 'owner' | 'jarvis') => { seen.replied.push([id, text, by]); return { ok: true } as const; },
      attach: async () => {},
      desktop: async () => {},
      phone: async (a: any) => { seen.phone.push(a); return { ok: true, worker: { ...worker, remote: 'Fix the badge' } } as any; },
    } as any,
    store,
    gate: {
      pressed: async (action: string, args: any, say: string) => { seen.pressed.push({ action, args, say }); return { id: 7, status: 'done' } as any; },
      recorded: (id: number, status: string, result: string) => { seen.recorded.push([id, status, result]); },
      propose: async (action: string, args: any, say: string) => ({ id: 8, action, args, say }) as any,
    },
    requests: { read: async (id: number) => (id === 1 ? { lines: ['x'] } as any : undefined) },
    log: () => {},
    work: () => ({ at: '2026-11-10T00:00:00Z', rows: [nativeRow, termRow] as any }),
    repos: () => [{ name: 'jarvis', path: '/repo' }],
    broadcast: ev => seen.broadcast.push(ev),
    publish: () => { seen.published++; },
    sync: () => { seen.synced++; },
    askChanged: id => seen.changed.push(id),
    killed: () => false,
    wake: text => seen.woke.push(text),
    watchPane: (id, file) => seen.watched.push([id, file]),
    chatFiles: new Map(),
    readLog: () => '',
    ...over,
  };
  return { store, o, seen, worker };
}

test('work list: the list with the completed rows, repos, product and owner, in that key order', async () => {
  const { o, store } = setup();
  store.setState(COMPLETED_KEY, JSON.stringify([['t:x', '2026-11-12T15:00:00.000Z']]));
  const r = await workRoute(o, 'GET', '/api/work', none, q());
  assert.equal(r?.status, 200);
  assert.deepEqual(Object.keys(r!.body as object), ['at', 'rows', 'completed', 'repos', 'product', 'owner']);
  assert.deepEqual((r!.body as any).completed, { 't:x': '2026-11-12T15:00:00.000Z' });
});

test('work list: a "Worked for" row gives its steps, an unknown one 404', async () => {
  const { o, store } = setup();
  const id = store.addTurn({ role: 'jarvis-work', text: JSON.stringify({ steps: ['read'], ms: 5 }) });
  assert.deepEqual(await workRoute(o, 'GET', `/api/fold/${id}`, none, q()), { status: 200, body: { steps: ['read'] } });
  assert.deepEqual(await workRoute(o, 'GET', '/api/fold/999', none, q()), { status: 404, body: { error: 'Not found' } });
});

test('work list: the transcript pane for a closed request, a native worker, and a row that left', async () => {
  const { o, seen } = setup();
  assert.deepEqual(await workRoute(o, 'GET', '/api/work/req%3A1/read', none, q()), { status: 200, body: { lines: ['x'] } });
  assert.equal((await workRoute(o, 'GET', '/api/work/req%3A2/read', none, q()))?.status, 404);
  assert.deepEqual(await workRoute(o, 'GET', '/api/work/n%3Aw1/read', none, q()),
    { status: 200, body: { lines: [], busy: false, error: 'No transcript yet: the worker has not written its first turn.' } });
  assert.equal((await workRoute(o, 'GET', '/api/work/n%3Agone/read', none, q()))?.status, 404);
  assert.deepEqual(await workRoute(o, 'GET', '/api/work/t%3Ax/read', none, q()), { status: 404, body: { error: 'It is not in the work list any more.' } });
  assert.deepEqual(seen.watched, [], 'no file, no watcher');
});

test('work list: a worker message in the pane says how many sentences read aloud has, the owner\'s words do not', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'jarvis-wr-')), 's.jsonl');
  writeFileSync(file, [
    { type: 'user', message: { content: 'go on' } },
    { type: 'assistant', message: { content: 'Tests pass. Pushed it.' } },
    { type: 'assistant', message: { content: '[image: /tmp/a.png]' } },
  ].map(e => JSON.stringify(e)).join('\n') + '\n');
  const { o } = setup();
  o.native.transcriptFile = () => file;
  const r: any = await workRoute(o, 'GET', '/api/work/n%3Aw1/read', none, q());
  assert.deepEqual(r.body.lines.map((l: any) => [l.role, l.clips]), [['user', undefined], ['agent', 2], ['agent', undefined]]);
});

test('work list: Side chat needs a listed repo, and a press that did not start answers 502', async () => {
  const { o, seen } = setup();
  assert.deepEqual(await workRoute(o, 'POST', '/api/work/side-chat', body({ repo: '/other' }), q()), { status: 400, body: { error: 'pick a project' } });
  assert.equal((await workRoute(o, 'POST', '/api/work/side-chat', body({ repo: '/repo', worktree: true }), q()))?.status, 200);
  assert.deepEqual(seen.pressed[0], { action: 'side-chat', args: { repo: '/repo', text: '', worktree: true }, say: 'Side chat: new in jarvis' });
  const failed = setup({ gate: { pressed: async () => ({ status: 'failed' }) as any, recorded: () => {}, propose: async () => ({}) as any } });
  assert.equal((await workRoute(failed.o, 'POST', '/api/work/side-chat', body({ repo: '/repo', text: 'hi' }), q()))?.status, 502);
});

test('work list: the steer box types into a native worker, answers its open ask, and tells the brain', async () => {
  const { o, store, seen } = setup();
  store.insertItem({ source: 'native', external_id: 'msg_1', kind: 'question', dispatch_id: 'n:w1', status: 'spoken' });
  assert.equal((await workRoute(o, 'POST', '/api/work/steer', body({ id: 't:x', text: 'hi' }), q()))?.status, 409);
  assert.equal((await workRoute(o, 'POST', '/api/work/steer', body({ id: 'n:w1', text: '  ' }), q()))?.status, 400);
  assert.equal((await workRoute(o, 'POST', '/api/work/steer', body({ id: 'gone', text: 'hi' }), q()))?.status, 404);
  assert.deepEqual(await workRoute(o, 'POST', '/api/work/steer', body({ id: 'n:w1', text: ' go on ' }), q()), { status: 200, body: { done: 'sent' } });
  assert.deepEqual(seen.replied, [['w1', 'go on', 'owner']]);
  assert.equal(store.item('msg_1')?.status, 'answered');
  assert.deepEqual(seen.changed, ['msg_1']);
  assert.match(seen.woke[0], /That answers its open question\. Reply SILENT\.$/);
  assert.equal(seen.published, 1);
  assert.equal(seen.synced, 1);
  const killed = setup({ killed: () => true });
  await workRoute(killed.o, 'POST', '/api/work/steer', body({ id: 'n:w1', text: 'x' }), q());
  assert.deepEqual(killed.seen.woke, [], 'the kill switch keeps the brain asleep');
  const down = setup({ native: { ...setup().o.native, reply: async () => ({ ok: false, error: 'gone' }) } as any });
  assert.deepEqual(await workRoute(down.o, 'POST', '/api/work/steer', body({ id: 'n:w1', text: 'x' }), q()), { status: 502, body: { error: 'gone' } });
});

test('work list: a picture with no words goes to the worker with the read line, and the brain sees it without', async () => {
  const { o, seen } = setup();
  const pic = '[image: /data/uploads/20261111T120000-ab12cd34.png]';
  assert.deepEqual(await workRoute(o, 'POST', '/api/work/steer', body({ id: 'n:w1', text: pic }), q()), { status: 200, body: { done: 'sent' } });
  assert.deepEqual(seen.replied, [['w1', `${pic}\n${READ_PICTURES}`, 'owner']]);
  assert.ok(!seen.woke[0].includes(READ_PICTURES));
  await workRoute(o, 'POST', '/api/work/steer', body({ id: 'n:w1', text: 'no picture here' }), q());
  assert.deepEqual(seen.replied[1], ['w1', 'no picture here', 'owner'], 'a message with no picture has no read line');
});

test('work list: Stop, Open and Desktop find the row first', async () => {
  const { o, seen } = setup();
  assert.equal((await workRoute(o, 'POST', '/api/work/stop', body({ id: 'gone' }), q()))?.status, 404);
  assert.equal((await workRoute(o, 'POST', '/api/work/stop', body({ id: 't:x' }), q()))?.status, 409);
  assert.equal((await workRoute(o, 'POST', '/api/work/stop', body({ id: 'n:w1' }), q()))?.status, 200);
  assert.deepEqual(await workRoute(o, 'POST', '/api/work/open', body({ dispatch: 'n:w1' }), q()), { status: 204 });
  assert.deepEqual(await workRoute(o, 'POST', '/api/work/open', body({ id: 't:x' }), q()), { status: 404, body: { error: 'no such worker' } });
  assert.deepEqual(await workRoute(o, 'POST', '/api/work/desktop', body({ id: 'n:w1' }), q()), { status: 204 });
  assert.equal(seen.published, 1);
  const broken = setup({ native: { ...setup().o.native, attach: async () => { throw new Error('no Terminal'); } } as any });
  assert.deepEqual(await workRoute(broken.o, 'POST', '/api/work/open', body({ id: 'n:w1' }), q()), { status: 502, body: { error: 'Could not open Terminal: no Terminal' } });
});

test('work list: Continue on phone resumes a native row, keeps only real pids, and refuses a terminal', async () => {
  const { o, seen } = setup();
  assert.deepEqual(await workRoute(o, 'POST', '/api/work/phone', body({ id: 't:x' }), q()), { status: 400, body: { error: 'A project terminal has no Claude session to continue.' } });
  const r = await workRoute(o, 'POST', '/api/work/phone', body({ id: 'n:w1', stop: [1, 42, 'x', 3.5] }), q());
  assert.deepEqual(r, { status: 200, body: { id: 'n:w1', remote: 'Fix the badge', already: false } });
  assert.deepEqual(seen.pressed[0].args, { session: 's-1', title: 'Fix the badge', stop: [42] });
  assert.deepEqual(seen.phone[0].stop, [42]);
  assert.deepEqual(seen.recorded, [[7, 'done', 'Remote Control as "Fix the badge" (n:w1)']]);
  assert.equal(seen.published, 1);
});

test('work list: another concept\'s URL is not answered, and a GET reads no body', async () => {
  const { o } = setup();
  assert.equal(await workRoute(o, 'GET', '/api/requests', none, q()), undefined);
  assert.equal(await workRoute(o, 'POST', '/api/work/nothing', none, q()), undefined);
  assert.equal(await workRoute(o, 'GET', '/api/work/steer', none, q()), undefined);
});

// ---- The × moves a row to Completed (2026-11-12) ----

const START = Date.parse('2026-11-12T15:00:00Z');

/** setup() with a real requests table and a clock, for the × routes. */
function closing() {
  let clock = START;
  const t0 = setup();
  const reqs = makeRequests({ store: t0.store, log: () => {}, now: () => clock, onChange: () => {}, repoOf: async () => undefined, prOpen: async () => undefined });
  Object.assign(t0.o, { requests: { ...t0.o.requests, close: reqs.close, hide: reqs.hide }, now: () => clock });
  const post = (url: string, b: object) => workRoute(t0.o, 'POST', url, body(b), q());
  /** The gate started a worker for the owner. */
  const start = (dispatch: string) => {
    const a = t0.store.addApproval({ action: 'worker-start', args: JSON.stringify({ repo: '/r', taskTitle: `Task ${dispatch}`, spec: 's' }), say: 'Start it?' });
    t0.store.decide(a.id, 'approved', 'button');
    t0.store.finishApproval(a.id, 'done', JSON.stringify({ dispatchId: dispatch }));
    reqs.started(t0.store.approval(a.id)!);
    return t0.store.requestOf(dispatch)!.id;
  };
  const row = (id: string, extra: Partial<WorkRow> = {}): WorkRow => ({ id, kind: 'worker', dispatch: id, title: `Row ${id}`, group: 'other', state: 'working', steer: 'auto', ...extra } as WorkRow);
  const work = (rows: WorkRow[]): Work => ({ at: '', rows });
  return { ...t0, reqs, post, start, row, work, tick: (ms: number) => { clock += ms; }, now: () => clock };
}
const completedEvents = (seen: any) => seen.broadcast.filter((e: any) => e.type === 'completed');

test('the × on a row with a request moves both to Completed in one call, and the page is told', async () => {
  const t = closing();
  const id = t.start('ctx_1');
  await t.reqs.sync(t.work([t.row('ctx_1')]));
  assert.equal(t.reqs.list()[0].status, 'working');

  const r = await t.post('/api/work/complete', { row: 'ctx_1', request: id });
  assert.equal(r?.status, 200);
  assert.deepEqual((r?.body as any).completed, { ctx_1: new Date(START).toISOString() });
  assert.deepEqual(completedEvents(t.seen), [{ type: 'completed', completed: { ctx_1: new Date(START).toISOString() } }], 'the page gets the new list');
  assert.equal(t.reqs.list()[0].status, 'done', 'the request is in Completed');
  assert.ok(t.store.request(id)!.closed_at, 'marked as closed by the owner');

  // The page draws it in Completed, and not in its group, while the worker still runs.
  const m = mergeWork([t.row('ctx_1')], t.reqs.list(), (r?.body as any).completed, t.now());
  assert.equal(m.groups.flatMap((g: any) => g.items).length, 0);
  assert.deepEqual(m.done.map((x: any) => x.id), [id]);
});

test('a closed request stays done while its worker runs on, and leaves with the normal purge a day later', async () => {
  const t = closing();
  const id = t.start('ctx_1');
  await t.post('/api/work/complete', { row: 'ctx_1', request: id });
  // status_at is the database clock. Put it at the test clock, as the purge reads it.
  t.store.db.prepare("UPDATE requests SET status_at = '2026-11-12 15:00:00'").run();

  await t.reqs.sync(t.work([t.row('ctx_1', { state: 'waiting' })]));
  assert.equal(t.reqs.list()[0].status, 'done', 'a waiting worker does not pull it back out');
  t.tick(DONE_KEEP_MS - 60_000);
  await t.reqs.sync(t.work([t.row('ctx_1')]));
  assert.equal(t.reqs.list().length, 1, 'still in Completed just under a day later');
  t.tick(60_000);
  await t.reqs.sync(t.work([t.row('ctx_1')]));
  assert.equal(t.reqs.list().length, 0, 'gone a day after the press');
  assert.ok(t.store.request(id)!.removed_at, 'marked, never deleted');
});

test('the owner\'s own message to a worker he closed brings its row back, and its request follows its worker again', async () => {
  const t = closing();
  const id = t.start('n:w1');
  await t.post('/api/work/complete', { row: 'n:w1', request: id });
  assert.ok(t.store.request(id)!.closed_at);
  const r = await steerWorker(t.o, 'n:w1', 'One more thing');
  assert.equal(r.status, 200);
  assert.equal(t.store.request(id)!.closed_at, null, 'the request follows its worker again');
  assert.deepEqual(completedRows(t.store), {}, 'the row is back in its group');
  assert.deepEqual(completedEvents(t.seen).at(-1), { type: 'completed', completed: {} });
});

test('the × on a row with no request keeps the first press time, and a second press does not restart its day', async () => {
  const t = closing();
  await t.post('/api/work/complete', { row: 's:babysit' });
  t.tick(60_000);
  const again = await t.post('/api/work/complete', { row: 's:babysit' });
  assert.deepEqual((again?.body as any).completed, { 's:babysit': new Date(START).toISOString() });
});

test('the × in Completed removes now: the request leaves, the row stays out of its group and out of Completed', async () => {
  const t = closing();
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

test('the × routes refuse a body with nothing to move, and say when the request is gone', async () => {
  const t = closing();
  assert.equal((await t.post('/api/work/complete', {}))?.status, 400);
  assert.equal((await t.post('/api/work/complete', { row: '', request: 'x' }))?.status, 400);
  assert.equal((await t.post('/api/work/complete', { request: 99 }))?.status, 404);
  const id = t.start('ctx_1');
  assert.equal((await t.post('/api/work/complete', { request: id }))?.status, 200);
  assert.equal((await t.post('/api/work/complete', { request: id }))?.status, 404, 'a request closed twice is not closed again');
  assert.equal((await t.post('/api/work/remove', { request: 99 }))?.status, 404);
  assert.equal(await workRoute(t.o, 'GET', '/api/work/complete', none, q()), undefined);
  assert.equal(await workRoute(t.o, 'POST', '/api/work/hide', body({ id: 'a' }), q()), undefined, 'the old hide route is gone');
  assert.deepEqual(completedEvents(t.seen), [], 'no row, so nothing to broadcast');
});

test('rows hidden before the change move to Completed once, at the time of the first read', () => {
  const store = openStore(':memory:');
  store.setState('workHidden', JSON.stringify(['a', 'b', 7]));
  const at = new Date(START).toISOString();
  assert.deepEqual(completedRows(store, START), { a: at, b: at });
  assert.deepEqual(completedRows(store, START + 5 * DONE_KEEP_MS), { a: at, b: at }, 'only once');
  assert.deepEqual(completedRows(openStore(':memory:'), START), {}, 'a new database has none');
  // A day after the move they are out of Completed, and they stay out of their group.
  const m = mergeWork([{ id: 'a', title: 'A', group: 'other', state: 'idle' }], [], completedRows(store), START + DONE_KEEP_MS + 1);
  assert.equal(m.done.length, 0);
  assert.equal(m.groups.flatMap((g: any) => g.items).length, 0);
});

test('the completed list keeps the newest 500 presses', async () => {
  const t = closing();
  t.store.setState(COMPLETED_KEY, JSON.stringify(Array.from({ length: 500 }, (_, i) => [`r${i}`, new Date(START).toISOString()])));
  const r = await t.post('/api/work/complete', { row: 'new' });
  const ids = Object.keys((r?.body as any).completed);
  assert.equal(ids.length, 500);
  assert.equal(ids.includes('r0'), false);
  assert.equal(ids.at(-1), 'new');
});

test('main.ts puts both × routes behind the open-page check, and keeps no old hide route', () => {
  const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
  const set = /const AS_OWNER = new Set\(\[(.*?)\]\)/s.exec(main)![1];
  for (const r of ['/api/work/complete', '/api/work/remove']) assert.ok(set.includes(`'${r}'`), r);
  assert.doesNotMatch(main, /\/api\/work\/hide|\/api\/requests\/hide|workHidden|hiddenIds/);
  assert.match(main, /completed: completedRows\(store\)/);
});
