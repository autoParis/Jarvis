import test from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from './store.ts';
import { makeGate, OWNER_ASKED, UNDO, UNDO_MS } from './gate.ts';
import { startedNoticeHtml, undoDeadline, UNDO_MS as WEB_UNDO_MS } from '../web/worklist.js';

const id = { run: 'run_x', handle: 'term_x' };
const JARVIS = '/repos/jarvis';
const spec = (repo: string, title = '#1 change the card') => ({ repo, taskTitle: title, spec: 'Change the card. Run npm test.' });

function setup(opts: { fromOwner?: boolean; hold?: Promise<void> } = {}) {
  const s = openStore(':memory:');
  s.addTurn({ role: 'owner', text: 'start a worker on Jarvis to change the card' });
  const stops: string[] = [], seen: { id: number; status: string; decided_by: string | null }[] = [];
  const native = {
    start: async (a: any) => { await opts.hold; return { id: 'abcd1234', session_id: 'abcd1234-0000-0000-0000-000000000000', name: a.name, state: 'working' } as any; },
    stop: async (w: string) => { stops.push(w); },
    abandon: async () => {},
  };
  const own = { repo: JARVIS, fromOwner: () => opts.fromOwner ?? true };
  const gate = makeGate(s, id, a => seen.push({ id: a.id, status: a.status, decided_by: a.decided_by }), () => {}, undefined, undefined, undefined, native, own);
  return { s, gate, stops, seen };
}

test('a Jarvis worker the owner asked for starts at once, recorded with his words, and shows Starting before Started', async () => {
  const { s, gate, seen } = setup();
  const a = await gate.propose('worker-start', spec(JARVIS), 'Start a worker on Jarvis?', undefined, { ownerAsked: true });
  assert.equal(a.status, 'done');
  assert.equal(a.decided_by, OWNER_ASKED);
  assert.equal(a.owner_text, 'start a worker on Jarvis to change the card');
  assert.match(a.result!, /"worker":"n:abcd1234"/);
  assert.ok(a.finished_at, 'the end of the start is recorded, so Stop can count from it');
  assert.deepEqual(seen.map(x => x.status), ['approved', 'done']);
  assert.equal(s.pendingApprovals().length, 0, 'no card waits');
});

test('a worktree path inside the Jarvis repo counts as the Jarvis repo', async () => {
  const { gate } = setup();
  const a = await gate.propose('worker-start', spec(`${JARVIS}/.claude/worktrees/x`), 'Start?', undefined, { ownerAsked: true });
  assert.equal(a.decided_by, OWNER_ASKED);
});

test('every other case keeps the Approve card: another repo, no owner message in the turn, or no ownerAsked', async () => {
  const other = setup();
  const a = await other.gate.propose('worker-start', spec('/repos/product'), 'Start?', undefined, { ownerAsked: true });
  assert.equal(a.status, 'pending');
  const lookalike = await other.gate.propose('worker-start', spec('/repos/jarvis-old', '#2 other'), 'Start?', undefined, { ownerAsked: true });
  assert.equal(lookalike.status, 'pending', 'a repo whose name only starts the same is not Jarvis');

  const event = setup({ fromOwner: false });
  assert.equal((await event.gate.propose('worker-start', spec(JARVIS), 'Start?', undefined, { ownerAsked: true })).status, 'pending');

  const unasked = setup();
  assert.equal((await unasked.gate.propose('worker-start', spec(JARVIS), 'Start?')).status, 'pending');

  const stop = setup();
  assert.equal((await stop.gate.propose('worker-stop', { dispatch: 'n:abcd1234' }, 'Stop?', undefined, { ownerAsked: true })).status, 'pending', 'only a worker-start starts at once');
});

test('Stop within 60 seconds stops the worker once, as a recorded worker-stop', async () => {
  const { s, gate, stops } = setup();
  const a = await gate.propose('worker-start', spec(JARVIS), 'Start?', undefined, { ownerAsked: true });
  const stop = await gate.undo(a.id);
  assert.equal(stop.action, 'worker-stop');
  assert.equal(stop.decided_by, UNDO);
  assert.equal(stop.status, 'done');
  assert.deepEqual(stops, ['n:abcd1234']);
  assert.equal((await gate.undo(a.id)).id, stop.id, 'a second press returns the same stop');
  assert.deepEqual(stops, ['n:abcd1234']);
  assert.equal(s.approval(a.id)!.status, 'done', 'the start keeps its own record');
});

test('Stop after 60 seconds is refused and stops nothing', async () => {
  const { s, gate, stops } = setup();
  const a = await gate.propose('worker-start', spec(JARVIS), 'Start?', undefined, { ownerAsked: true });
  s.db.prepare(`UPDATE approvals SET finished_at = datetime('now', '-61 seconds') WHERE id = ?`).run(a.id);
  await assert.rejects(gate.undo(a.id), /60 seconds/);
  assert.deepEqual(stops, []);
});

test('Stop is refused on a card the owner approved himself', async () => {
  const { s, gate } = setup();
  const a = await gate.propose('worker-start', spec('/repos/product'), 'Start?');
  s.addTurn({ role: 'owner', text: 'yes' });
  await gate.confirm(a.id);
  await assert.rejects(gate.undo(a.id), /not a worker Jarvis started at once/);
});

test('Stop pressed while the start still runs stops the worker when the start ends', async () => {
  let release!: () => void;
  const { s, gate, stops } = setup({ hold: new Promise<void>(r => { release = r; }) });
  const started = gate.propose('worker-start', spec(JARVIS), 'Start?', undefined, { ownerAsked: true });
  await new Promise(r => setImmediate(r));
  const a = s.db.prepare(`SELECT * FROM approvals WHERE decided_by = ?`).get(OWNER_ASKED) as any;
  assert.equal(a.status, 'approved');
  assert.equal((await gate.undo(a.id)).id, a.id, 'queued: the start itself comes back');
  assert.deepEqual(stops, []);
  release();
  await started;
  assert.deepEqual(stops, ['n:abcd1234']);
});

test('an answer with a change edits the open card in place: same id, new args, Changed, and his yes can confirm it', async () => {
  const { s, gate } = setup();
  const a = await gate.propose('worker-start', spec('/repos/product', '#3 raise the limit to 300'), 'Start 3?', { approves: 'A worker raises it to 300.' });
  s.addTurn({ role: 'owner', text: 'yes but make it 400' });
  const r = await gate.revise(a.id, spec('/repos/product', '#3 raise the limit to 400'), 'Start 3 at 400?');
  assert.equal(r.id, a.id);
  assert.equal(r.status, 'pending');
  assert.equal(JSON.parse(r.args).taskTitle, '#3 raise the limit to 400');
  assert.equal(r.say, 'Start 3 at 400?');
  assert.equal(JSON.parse(r.card!).approves, 'A worker raises it to 300.', 'lines not given are kept');
  assert.ok(r.revised_at);
  assert.equal(s.pendingApprovals().length, 1, 'no second card');
  const done = await gate.confirm(a.id);
  assert.equal(done.status, 'done');
  assert.equal(done.owner_text, 'yes but make it 400');
});

test('revise refuses a decided card, a missing card and bad args, and leaves the card as it was', async () => {
  const { s, gate } = setup();
  const a = await gate.propose('worker-start', spec('/repos/product'), 'Start?');
  await assert.rejects(gate.revise(a.id, { repo: 'relative', spec: 'x' }, 'Start?'), /absolute path/);
  assert.equal(s.approval(a.id)!.args, JSON.stringify(spec('/repos/product')));
  assert.equal(s.approval(a.id)!.revised_at, null);
  s.addTurn({ role: 'owner', text: 'no' });
  gate.reject(a.id);
  await assert.rejects(gate.revise(a.id, spec('/repos/product', '#9 x'), 'Start?'), /already rejected/);
  await assert.rejects(gate.revise(999, spec('/repos/product'), 'Start?'), /no approval 999/);
});

test('revise keeps the duplicate check, but not against the card itself', async () => {
  const { gate } = setup();
  const a = await gate.propose('worker-start', spec('/repos/product', '#4 one'), 'Start 4?');
  await gate.propose('worker-start', spec('/repos/product', '#5 two'), 'Start 5?');
  await gate.revise(a.id, { ...spec('/repos/product', '#4 one'), spec: 'A better spec.' }, 'Start 4?');
  await assert.rejects(gate.revise(a.id, spec('/repos/product', '#5 two'), 'Start 5?'), /already pending as approval/);
});

test('the started line: Starting, Started with Stop for 60 seconds, then no Stop; the app and the gate agree on 60 seconds', () => {
  assert.equal(WEB_UNDO_MS, UNDO_MS);
  const base = { id: 7, say: 'Start?', decided_by: 'owner-asked', decided_at: '2026-11-08 12:00:00', finished_at: '2026-11-08 12:00:20' };
  const at = Date.parse('2026-11-08T12:00:20Z');
  assert.equal(undoDeadline({ ...base, status: 'approved' }), Infinity);
  assert.equal(undoDeadline({ ...base, status: 'done' }), at + UNDO_MS);
  assert.equal(undoDeadline({ ...base, status: 'failed' }), 0);
  assert.equal(undoDeadline({ ...base, status: 'done', decided_by: 'button' }), 0);
  const args = { taskTitle: '#1 change <the> card' };
  assert.match(startedNoticeHtml({ ...base, status: 'approved' }, args, at), /Starting.*#1 change &lt;the&gt; card.*data-undo="7"/);
  assert.match(startedNoticeHtml({ ...base, status: 'done' }, args, at + 59_000), /Started.*data-undo="7">Stop</);
  assert.doesNotMatch(startedNoticeHtml({ ...base, status: 'done' }, args, at + 61_000), /data-undo/);
  assert.match(startedNoticeHtml({ ...base, status: 'done' }, args, at, 'Stopped'), /Stopped/);
  assert.doesNotMatch(startedNoticeHtml({ ...base, status: 'done' }, args, at, 'Stopped'), /data-undo/);
  assert.match(startedNoticeHtml({ ...base, status: 'failed', result: 'no terminal' }, args, at), /Did not start.*no terminal/);
});
