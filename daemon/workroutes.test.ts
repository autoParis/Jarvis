// The work list's routes, tested through workRoute() with a fake request, as nativeroutes.test.ts does.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from './store.ts';
import { workRoute, hiddenIds, type WorkCtx } from './workroutes.ts';
import { READ_PICTURES } from '../web/compose.js';

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

test('work list: the list with hidden ids, repos, product and owner, in that key order', async () => {
  const { o, store } = setup();
  store.setState('workHidden', JSON.stringify(['t:x']));
  const r = await workRoute(o, 'GET', '/api/work', none, q());
  assert.equal(r?.status, 200);
  assert.deepEqual(Object.keys(r!.body as object), ['at', 'rows', 'hidden', 'repos', 'product', 'owner']);
  assert.deepEqual((r!.body as any).hidden, ['t:x']);
});

test('work list: hide and show a row, and only the hidden list changes', async () => {
  const { o, store, seen } = setup();
  assert.equal((await workRoute(o, 'POST', '/api/work/hide', body({}), q()))?.status, 400);
  assert.deepEqual(await workRoute(o, 'POST', '/api/work/hide', body({ id: 'n:w1' }), q()), { status: 200, body: { hidden: ['n:w1'] } });
  assert.deepEqual(hiddenIds(store), ['n:w1']);
  assert.deepEqual(await workRoute(o, 'POST', '/api/work/hide', body({ id: 'n:w1', hidden: false }), q()), { status: 200, body: { hidden: [] } });
  assert.deepEqual(seen.broadcast, [{ type: 'hidden', hidden: ['n:w1'] }, { type: 'hidden', hidden: [] }]);
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
