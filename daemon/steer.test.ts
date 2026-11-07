import test from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from './store.ts';
import { makeGate } from './gate.ts';
import { steer, stop } from './steer.ts';
import type { WorkRow } from './work.ts';

const ids = { run: 'run_j', handle: 'term_j' };
const row = (extra: Partial<WorkRow>): WorkRow => ({ id: 'd_1', kind: 'worker', dispatch: 'd_1', run: 'run_j', title: 'pick-and-ship #4460', group: 'story', state: 'working', sideChat: false, steer: 'auto', ...extra });

function setup(answer: (args: string[]) => any) {
  const store = openStore(':memory:');
  const gate = makeGate(store, ids, () => {});
  const calls: string[][] = [], notes: string[] = [];
  const orca = async (args: string[]) => { calls.push(args); const a = answer(args); if (a instanceof Error) throw a; return a; };
  const go = (r: WorkRow, text: string) => steer({ row: r, text, ...ids, store, gate, orca, log: () => {}, note: n => notes.push(n) });
  return { store, gate, calls, notes, go };
}

test('an open question from Jarvis\'s own worker is answered at once, claimed first, and the brain is told', async () => {
  const t = setup(() => ({ ok: true, result: {} }));
  t.store.insertItem({ source: 'orca', external_id: 'msg_q', kind: 'question', dispatch_id: 'd_1', subject: 'Skip Muse?' });
  const r = await t.go(row({ state: 'waiting' }), 'Yes, skip it');
  assert.equal(r.body.done, 'replied');
  assert.deepEqual(t.calls[0], ['orchestration', 'reply', '--run', 'run_j', '--from', 'term_j', '--id', 'msg_q', '--body', 'Yes, skip it']);
  assert.equal(t.store.item('msg_q')!.status, 'answered');
  assert.match(t.notes[0], /msg_q.*Reply SILENT/);
  assert.equal(t.store.pendingApprovals().length, 0, 'no card');
});

test('a reply the brain already claimed is not sent twice', async () => {
  const t = setup(() => ({ ok: true, result: {} }));
  t.store.insertItem({ source: 'orca', external_id: 'msg_q', kind: 'question', dispatch_id: 'd_1' });
  assert.equal(t.store.claimReply('msg_q'), 'claimed'); // jarvis-orca reply got there first
  const r = await t.go(row({}), 'Yes');
  assert.equal(r.status, 409);
  assert.equal(t.calls.length, 0);
});

test('Orca refusing the answer reopens the ask; no answer at all leaves it marked replying', async () => {
  const refused = setup(() => ({ ok: false, error: { code: 'busy', message: 'busy' } }));
  refused.store.insertItem({ source: 'orca', external_id: 'msg_q', kind: 'question', dispatch_id: 'd_1' });
  assert.equal((await refused.go(row({}), 'Yes')).status, 502);
  assert.equal(refused.store.item('msg_q')!.status, 'spoken');
  const silent = setup(() => new Error('no JSON'));
  silent.store.insertItem({ source: 'orca', external_id: 'msg_q', kind: 'question', dispatch_id: 'd_1' });
  assert.equal((await silent.go(row({}), 'Yes')).status, 502);
  assert.equal(silent.store.item('msg_q')!.status, 'replying');
  assert.equal(silent.notes.length, 0);
});

test('with no open question the text steers the worker, and answers an open escalation', async () => {
  const t = setup(() => ({ ok: true, result: {} }));
  t.store.insertItem({ source: 'orca', external_id: 'msg_e', kind: 'escalation', dispatch_id: 'd_1' });
  const r = await t.go(row({}), 'Use the staging DB');
  assert.equal(r.body.done, 'sent');
  assert.deepEqual(t.calls[0], ['orchestration', 'send', '--run', 'run_j', '--from', 'term_j', '--to', 'dispatch:d_1', '--subject', 'From the owner', '--body', 'Use the staging DB']);
  assert.equal(t.store.item('msg_e')!.status, 'answered');
  assert.match(t.notes[0], /msg_e.*Reply SILENT/);
});

test('another Run\'s chat-tab worker still gets an Approve-only card; an exited worker is refused', async () => {
  const t = setup(() => { throw new Error('nothing runs before Approve'); });
  const other = await t.go(row({ run: 'run_other', steer: 'card' }), 'Rebase first');
  assert.equal(other.body.approval!.action, 'worker-send');
  assert.deepEqual(JSON.parse(other.body.approval!.args), { dispatch: 'd_1', text: 'Rebase first' });
  await assert.rejects(t.gate.confirm(other.body.approval!.id), /only when the owner taps Approve/);
  const gone = await t.go(row({ state: 'exited', steer: 'none' }), 'hi');
  assert.equal(gone.status, 409);
  assert.equal(t.calls.length, 0);
});

const live = (handle: string, agentIdentity?: string) => ({ ok: true, result: { terminals: [{ handle, agentIdentity }] } });

test('a message typed into a live agent answers its open question as well as its escalation', async () => {
  const t = setup(() => live('term_a', 'claude'));
  t.store.insertItem({ source: 'orca', external_id: 'msg_q', kind: 'question', dispatch_id: 'd_1' });
  t.store.insertItem({ source: 'orca', external_id: 'msg_e', kind: 'escalation', dispatch_id: 'd_1' });
  t.store.insertItem({ source: 'orca', external_id: 'msg_other', kind: 'question', dispatch_id: 'd_2' });
  const gate = { pressed: async () => ({ status: 'done' }) } as unknown as typeof t.gate;
  const r = await steer({ row: row({ terminal: 'term_a', steer: 'type' }), text: 'Use the app text', ...ids, store: t.store, gate, orca: async () => live('term_a', 'claude'), log: () => {}, note: () => {} });
  assert.equal(r.body.done, 'typed');
  assert.deepEqual(t.store.openItems().map(i => i.external_id), ['msg_other']);
  assert.equal(t.store.item('msg_q')!.answer, 'Use the app text');
});

test('a live terminal agent is not typed into if it has exited since the last poll: the text would run in the shell', async () => {
  const t = setup(() => live('term_db'));
  const r = await t.go(row({ id: 's:x', kind: 'session', dispatch: undefined, terminal: 'term_db', steer: 'type' }), 'rm -rf build');
  assert.equal(r.status, 409);
  assert.match(r.body.error!, /no longer running/);
  assert.deepEqual(t.calls, [['terminal', 'list']]);
  assert.equal(t.store.pendingApprovals().length, 0);
});

test('resuming refuses while the session works in Orca, and when the transcript cannot be found', async () => {
  const t = setup(() => ({ ok: true }));
  const r = row({ id: 's:c', kind: 'session', dispatch: undefined, steer: 'resume' });
  let resumed = 0;
  const go = (x: WorkRow, resume?: any) => steer({ row: x, text: 'hi', ...ids, store: t.store, gate: t.gate, orca: async () => ({ ok: true, result: {} }), log: () => {}, note: () => {}, resume });
  assert.match((await go(r, async () => { resumed++; return { started: true }; })).body.error!, /working in Orca/);
  assert.match((await go({ ...r, state: 'waiting' }, async () => { resumed++; return { started: true }; })).body.error!, /permission prompt/);
  assert.match((await go({ ...r, state: 'idle', note: 'Monitoring' }, async () => { resumed++; return { started: true }; })).body.error!, /working in Orca/);
  assert.equal(resumed, 0);
  const idle = { ...r, state: 'idle' as const };
  assert.match((await go(idle, async () => undefined)).body.error!, /transcript/);
  const refused = await go(idle, async () => ({ started: false, error: 'another process' }));
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, 'another process');
  const ok = await go(idle, async () => ({ started: true, warning: 'Orca tab' }));
  assert.deepEqual(ok, { status: 200, body: { done: 'resumed', warning: 'Orca tab' } });
});

test('Stop asks for Approve, except a side chat the owner started, which closes at once', async () => {
  const t = setup(() => ({ ok: true }));
  const a = await stop(row({}), t.gate);
  assert.equal(a.body.approval!.action, 'worker-stop');
  assert.equal(a.body.approval!.status, 'pending');
  assert.equal((await stop(row({ id: 's:c', kind: 'session', dispatch: undefined }), t.gate)).status, 409);
});
