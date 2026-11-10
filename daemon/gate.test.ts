import test from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from './store.ts';
import { makeGate, buildCommand } from './gate.ts';
import { workerBrief } from './workercontract.ts';
import { sentences, detectLang } from './voice.ts';


test('confirm is refused until the owner speaks after the proposal, and a decision happens once', async () => {
  const s = openStore(':memory:');
  s.addTurn({ role: 'owner', text: 'start 4412' });
  const gate = makeGate(s, () => {});
  const a = await gate.propose('worker-stop', { dispatch: 'ctx_1' }, 'Stop 4412?');
  await assert.rejects(gate.confirm(a.id), /has not said anything/);
  s.addTurn({ role: 'owner', text: 'no' });
  assert.equal(gate.reject(a.id).status, 'rejected');
  assert.equal(s.approval(a.id)!.owner_text, 'no');
  await assert.rejects(gate.confirm(a.id), /already rejected/);
  assert.throws(() => gate.reject(a.id));
});

test('bad proposals are refused before anything is stored', async () => {
  const s = openStore(':memory:');
  const gate = makeGate(s, () => {});
  await assert.rejects(gate.propose('merge', {}, 'Merge it?'), /unknown action/);
  await assert.rejects(gate.propose('worker-start', { spec: 'x' }, 'Start?'), /repo/);
  await assert.rejects(gate.propose('worker-start', { repo: 'jarvis', spec: 'x' }, 'Start?'), /absolute path/);
  await assert.rejects(gate.propose('question', { repo: '~/Repos/jarvis', question: 'Why?' }, 'Ask?'), /absolute path/);
  await assert.rejects(gate.propose('worker-stop', null, 'Stop?'), /JSON object/);
  await assert.rejects(gate.propose('worker-stop', ['ctx_1'], 'Stop?'), /JSON object/);
  assert.equal(s.pendingApprovals().length, 0);
});

test('worker-start starts a native worker in the repo and carries the ask format', () => {
  const argv = buildCommand('worker-start', { repo: '/r', spec: 'Do #1' });
  assert.deepEqual(argv.slice(0, 3), ['native', 'start', '/r']);
  assert.match(argv[3], /^Do #1/);
  assert.match(argv[3], /STORY: <number/);
});

test('a worker Jarvis starts may file issues only through create-issue, at P2 or P3; read-only and Today task workers may not', () => {
  const spec = (action: string, args: any) => buildCommand(action, args)[3];
  const started = spec('worker-start', { repo: '/r', spec: 'Do #1' });
  assert.match(started, /Do #1\n\n## Filing issues\n/);
  assert.match(started, /One exception to not posting on GitHub/);
  assert.match(started, /`create-issue` skill/);
  assert.match(started, /duplicate and already-shipped search/);
  assert.match(started, /Never a hand-rolled `gh issue create`/);
  assert.match(started, /P2 or P3 only, never P0 or P1/);
  assert.match(started, /comment on it instead of filing/);
  assert.match(started, /every issue you filed or commented on, by number, in your worker_done/);
  assert.ok(started.indexOf('## Filing issues') < started.indexOf('## You are a Jarvis worker'));
  assert.doesNotMatch(spec('question', { repo: '/r', question: 'Why?' }), /Filing issues/);
  assert.doesNotMatch(spec('today-draft', { repo: '/r', spec: 'Draft it', taskTitle: 'Draft: x' }), /Filing issues/);
  assert.doesNotMatch(spec('today-start', { repo: '/r', spec: 'A task. file no issues' }), /Filing issues/);
  assert.doesNotMatch(spec('side-chat', { repo: '/r', text: 'hi' }), /Filing issues/);
});

test('speech splitting and language', () => {
  assert.deepEqual(sentences('Story 4412. Skip it?\nhttps://x.y/z'), ['Story 4412.', 'Skip it?']);
  assert.equal(detectLang("Envoyé. C'est fait."), 'fr');
  assert.equal(detectLang('Sent. Should I start it?'), 'en');
});

test('only the owner reaches the app over the tailnet; local requests pass', async () => {
  const { allowed } = await import('./access.ts');
  const ts = { host: 'jarvis.example.ts.net', 'x-forwarded-for': '100.1.2.3' };
  assert.equal(allowed({ host: '127.0.0.1:7717' }), true);
  assert.equal(allowed({ ...ts, 'tailscale-user-login': 'owner@example.test' }), true);
  assert.equal(allowed({ ...ts, 'tailscale-user-login': 'owner@work.example.test' }), false); // work account: not on Jarvis's tailnet
  assert.equal(allowed(ts), false); // tagged device: no login
  assert.equal(allowed({ ...ts, 'tailscale-user-login': 'teammate@example.test' }), false);
});

test('terminal-send types the exact text into a native worker, and refuses anything else', () => {
  assert.deepEqual(buildCommand('terminal-send', { terminal: 'n:abc-1', text: 'send the Adventure draft' }), ['native', 'type', 'n:abc-1', 'send the Adventure draft']);
  assert.throws(() => buildCommand('terminal-send', { terminal: 'n:abc' }), /text is required/);
  assert.throws(() => buildCommand('terminal-send', { terminal: '--all', text: 'x' }), /not a native worker row/);
  assert.throws(() => buildCommand('terminal-send', { terminal: 'term_abc', text: 'x' }), /not a native worker row/);
});

test('terminal-send waits for the Approve button: a relayed yes never runs it', async () => {
  const s = openStore(':memory:');
  const changes: string[] = [];
  const gate = makeGate(s, a => changes.push(a.status));
  const a = await gate.propose('terminal-send', { terminal: 'n:other', text: 'go' }, 'Tell the migration session to go?');
  assert.equal(a.status, 'pending');
  s.addTurn({ role: 'owner', text: 'yes' });
  await assert.rejects(gate.confirm(a.id), /only when the owner taps Approve/);
  assert.equal(s.approval(a.id)!.status, 'pending');
  const rejected = await gate.button(a.id, false);
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.decided_by, 'button');
  await assert.rejects(gate.button(a.id, true), /already decided/);
  assert.deepEqual(changes, ['pending', 'rejected']);
});

test('a worker-start with the title and repo of a pending one is refused until the old one is rejected', async () => {
  const s = openStore(':memory:');
  const lines: string[] = [];
  const gate = makeGate(s, () => {}, (m, f) => lines.push(`${m} ${JSON.stringify(f)}`));
  const old = await gate.propose('worker-start', { repo: '/r', taskTitle: 'Dealer Ten 2 vendeur accounts', spec: 'bad spec' }, 'Start?');
  const fix = { repo: '/r', taskTitle: 'Dealer Ten 2 vendeur accounts', spec: 'good spec' };
  await assert.rejects(gate.propose('worker-start', fix, 'Start?'), new RegExp(`already pending as approval #${old.id}.*jarvis-act revise ${old.id}`));
  await assert.rejects(gate.propose('worker-start', JSON.parse(old.args), 'Start?'), /already pending/);
  // The sidebar would show these the same, so they count as the same.
  await assert.rejects(gate.propose('worker-start', { repo: '/r/', taskTitle: 'Request:  dealer ten 2 Vendeur accounts ', spec: 'x' }, 'Start?'), /already pending/);
  assert.equal(s.pendingApprovals().length, 1);
  assert.match(lines.join('\n'), /gate refused a duplicate worker-start .*"approval":1/);

  gate.reject(old.id);
  const next = await gate.propose('worker-start', fix, 'Start?');
  assert.equal(next.status, 'pending');
  assert.notEqual(next.id, old.id);
});

test('two different tasks, or the same title in another repo, or no title at all, are both proposed', async () => {
  const s = openStore(':memory:');
  const gate = makeGate(s, () => {});
  await gate.propose('worker-start', { repo: '/r', taskTitle: 'Dealer Nine draft and sheet update', spec: 'a' }, 'Start?');
  await gate.propose('worker-start', { repo: '/r', taskTitle: 'Dealer Ten 2 vendeur accounts', spec: 'b' }, 'Start?');
  await gate.propose('worker-start', { repo: '/other', taskTitle: 'Dealer Ten 2 vendeur accounts', spec: 'c' }, 'Start?');
  await gate.propose('worker-start', { repo: '/r', spec: 'd' }, 'Start?');
  await gate.propose('worker-start', { repo: '/r', spec: 'e' }, 'Start?');
  assert.equal(s.pendingApprovals().length, 5);
});

test('a worker-start is refused while its request is live, and allowed once that request ends', async () => {
  const s = openStore(':memory:');
  const gate = makeGate(s, () => {});
  const args = { repo: '/r', taskTitle: 'Same task', spec: 's' };
  const started = () => {
    const a = s.addApproval({ action: 'worker-start', args: JSON.stringify(args), say: 'Start?' });
    s.decide(a.id, 'approved', 'button');
    return a.id;
  };
  const finish = (approval: number, dispatch: string) => {
    s.finishApproval(approval, 'done', JSON.stringify({ dispatchId: dispatch }));
    s.addRequest({ dispatch_id: dispatch, approval_id: approval, action: 'worker-start', title: args.taskTitle });
    return s.requests().find(r => r.dispatch_id === dispatch)!.id;
  };
  const again = { ...args, spec: 'other spec' };

  // Being run: the start has not answered yet.
  const a1 = started();
  await assert.rejects(gate.propose('worker-start', again, 'Start?'), /already running from approval #1.*worker-stop/);
  const r1 = finish(a1, 'ctx_1');
  await assert.rejects(gate.propose('worker-start', again, 'Start?'), /already running from approval #1 \(.*ctx_1.*\)/);
  s.updateRequest(r1, { status: 'waiting' });
  await assert.rejects(gate.propose('worker-start', again, 'Start?'), /already running/);

  // Finished, failed or hidden no longer holds the title.
  for (const status of ['review', 'done', 'failed']) {
    s.updateRequest(r1, { status });
    assert.deepEqual(s.openWorkerStarts(), []);
  }
  s.updateRequest(r1, { status: 'working' });
  s.hideRequest(r1);
  assert.deepEqual(s.openWorkerStarts(), []);
  assert.equal((await gate.propose('worker-start', again, 'Start?')).status, 'pending');
});

test('a lost answer holds the title for 10 minutes, and a failed start not at all', async () => {
  const s = openStore(':memory:');
  const gate = makeGate(s, () => {});
  const args = { repo: '/r', taskTitle: 'Same task', spec: 's' };
  const a = s.addApproval({ action: 'worker-start', args: JSON.stringify(args), say: 'Start?' });
  s.decide(a.id, 'approved', 'button');
  s.finishApproval(a.id, 'unknown', 'no json');
  await assert.rejects(gate.propose('worker-start', { ...args, spec: 'x' }, 'Start?'), /already running/);
  s.db.prepare(`UPDATE approvals SET decided_at = datetime('now', '-11 minutes') WHERE id = ?`).run(a.id);
  assert.deepEqual(s.openWorkerStarts(), []);
  s.db.prepare(`UPDATE approvals SET decided_at = datetime('now'), status = 'failed' WHERE id = ?`).run(a.id);
  assert.deepEqual(s.openWorkerStarts(), []);
});

test('proposing the same action twice returns the first proposal instead of a second one', async () => {
  const s = openStore(':memory:');
  const lines: string[] = [];
  const gate = makeGate(s, () => {}, (m, f) => lines.push(`${m} ${JSON.stringify(f)}`));
  const a = await gate.propose('worker-stop', { dispatch: 'ctx_1' }, 'Stop 4412?');
  const b = await gate.propose('worker-stop', { dispatch: 'ctx_1' }, 'Stop 4412 now?');
  assert.equal(b.id, a.id);
  assert.equal(s.pendingApprovals().length, 1);
  assert.match(lines.join('\n'), /gate proposed .*"approval":1/);
  assert.match(lines.join('\n'), /gate repeat proposal/);
});

test('every worker spec asks for one plain sentence before each batch of tool calls', () => {
  assert.match(workerBrief(), /Before each batch of tool calls, write one plain sentence/);
});

test('a native worker is interactive by default; background: true opts out; the old interactive flag is accepted and ignored', async () => {
  const starts: any[] = [];
  const native = { start: async (a: any) => { starts.push(a); return { id: 'abcd1234', session_id: 'abcd1234-0000-0000-0000-000000000000', name: a.name, state: 'working' } as any; }, stop: async () => {}, abandon: async () => {} };
  const s = openStore(':memory:');
  const gate = makeGate(s, () => {}, () => {}, undefined, undefined, native);
  // A question runs at once (automatic tier), so the start arguments show without a button.
  let a = await gate.propose('question', { repo: '/r', question: 'Why?' }, 'Looking.');
  assert.equal(a.status, 'done');
  assert.equal(starts[0].interactive, true);
  assert.equal(starts[0].worktree, false, 'a question runs in the main checkout');
  a = await gate.propose('question', { repo: '/r', question: 'Why not?', background: true }, 'Looking.');
  assert.equal(starts[1].interactive, false);
  a = await gate.propose('question', { repo: '/r', question: 'Still?', interactive: true }, 'Looking.');
  assert.equal(starts[2].interactive, true);
  a = await gate.propose('question', { repo: '/r', question: 'And?', interactive: false }, 'Looking.');
  assert.equal(starts[3].interactive, true, 'interactive: false means nothing; only background: true opts out');
  // A side chat is pressed from the app: interactive too.
  const side = await gate.pressed('side-chat', { repo: '/r', text: 'hello' }, 'Side chat');
  assert.equal(side.status, 'done');
  assert.equal(starts[4].interactive, true);
  // worker-start through the button: interactive, with its worktree.
  const w = await gate.propose('worker-start', { repo: '/r', spec: 'Do it', taskTitle: 'thing' }, 'Start?');
  assert.equal(w.status, 'pending');
  const done = await gate.button(w.id, true);
  assert.equal(done.status, 'done');
  assert.equal(starts[5].interactive, true);
  assert.equal(starts[5].worktree, true);
  assert.match(starts[5].brief, /You are a Claude Code session started by Jarvis/);
});
