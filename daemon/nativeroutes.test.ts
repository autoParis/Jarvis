import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Item } from './store.ts';
import { helpRun } from './fakeclaude.ts';
import { askCard } from './asks.ts';
import { makeNative, NATIVE_FOOTER, REPORT_NUDGE, type Claude } from './native.ts';
import { nativeRoute, routeWorkerTurn, answerOpenAsks, askId, workerMessageKind, NO_OPTIONS_REFUSAL, matchSender, unknownId, UNKNOWN_SUBJECT } from './nativeroutes.ts';
import { answerAsk } from './asks.ts';
import { buildCommand, nativeName, WORKER_PERMISSION, BUTTON_ONLY } from './gate.ts';
import { chatLines } from './transcript.ts';

/** A fake `claude`: one background worker that starts, is listed alive, and a relay that always says SENT. */
function fakeClaude() {
  const calls: string[][] = [];
  const agent: any = { id: 'abc12345', sessionId: 'abc12345-0000-0000-0000-000000000000', name: 'probe-1', kind: 'background', pid: 42, status: 'idle', state: 'done' };
  const claude: Claude = async (args) => {
    calls.push(args);
    const help = helpRun(args); if (help) return help;
    if (args[0] === '--version') return { code: 0, out: '2.1.316 (Claude Code)', err: '' };
    if (args[0] === '--bg') return { code: 0, out: `backgrounded · ${agent.id} · ${args[2]}\n`, err: '' };
    if (args[0] === 'agents') return { code: 0, out: JSON.stringify([agent]), err: '' };
    if (args[0] === '-p') return { code: 0, out: JSON.stringify({ type: 'result', is_error: false, result: 'SENT' }), err: '' };
    return { code: 0, out: '', err: '' };
  };
  return { claude, calls, agent };
}

function setup() {
  const store = openStore(':memory:');
  const logs: string[] = [];
  const log = (m: string, f?: object) => logs.push(`${m} ${JSON.stringify(f ?? {})}`);
  const cards: any[] = [], reports: any[] = [], notices: string[] = [], changed: string[] = [];
  const { claude, calls, agent } = fakeClaude();
  const native = makeNative({ store, log, jarvisUrl: 'http://127.0.0.1:1', dataDir: mkdtempSync(join(tmpdir(), 'jarvis-nr-')), claude,
    onChange: () => {}, onReport: (w, t, final) => reports.push({ w: w.id, t, final }), onCard: a => cards.push(a), onNotice: (_w, t) => notices.push(t) });
  const o = { native, store, log, askChanged: (i: string) => changed.push(i) };
  return { store, log, logs, native, o, cards, reports, notices, changed, calls, agent };
}

test('the hook routes: a known worker\'s permission prompt becomes a card and resolves on the tap; a stop stores the report; unknown sessions get nothing', async () => {
  const s = setup();
  const w = await s.native.start({ name: 'probe-1', cwd: '/tmp', brief: 'x' });
  const body = { session_id: w.session_id, tool_name: 'Bash', tool_input: { command: 'touch /tmp/x' }, transcript_path: '/tmp/t.jsonl' };
  const held = nativeRoute(s.o, 'POST', '/api/hooks/permission', body);
  await new Promise(r => setTimeout(r, 10));
  assert.equal(s.cards.length, 1);
  assert.equal(s.cards[0].action, WORKER_PERMISSION);
  assert.equal(JSON.parse(s.cards[0].args).summary, 'touch /tmp/x');
  assert.equal(s.native.get(w.id)?.state, 'blocked');
  assert.deepEqual(s.native.decide(s.cards[0].id, false), { ok: true });
  const r = await held;
  assert.equal(r?.status, 200);
  assert.equal((r?.body as any).hookSpecificOutput.decision.behavior, 'deny');
  assert.equal(s.store.approval(s.cards[0].id)?.result, 'denied');
  // The stop hook: the report word for word, outcome from the first line.
  const stop = await nativeRoute(s.o, 'POST', '/api/hooks/stop', { session_id: w.session_id, last_assistant_message: 'DONE: all good\n\nDetails here.', stop_hook_active: false });
  assert.equal(stop?.status, 200);
  assert.equal(s.native.get(w.id)?.report, 'DONE: all good\n\nDetails here.');
  assert.equal(s.reports[0].final, true);
  assert.deepEqual(stop?.body, {});
  // A turn with no report line: the reply sends the worker back with Claude Code's `decision: block`.
  const silent = await nativeRoute(s.o, 'POST', '/api/hooks/stop', { session_id: w.session_id, last_assistant_message: 'Here is the answer.', stop_hook_active: false });
  assert.deepEqual(silent?.body, { decision: 'block', reason: REPORT_NUDGE });
  // A session jarvisd did not start: an empty decision (which the worker reads as a denial) and nothing stored.
  const stranger = await nativeRoute(s.o, 'POST', '/api/hooks/permission', { session_id: 'nope', tool_name: 'Bash', tool_input: {} });
  assert.deepEqual(stranger?.body, {});
  assert.equal(s.cards.length, 2); // created, then decided; nothing for the stranger
  assert.ok(s.logs.some(l => l.startsWith('hook from an unknown session')));
  const pre = await nativeRoute(s.o, 'POST', '/api/hooks/pre', { session_id: w.session_id, tool_name: 'AskUserQuestion' });
  assert.equal((pre?.body as any).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(await nativeRoute(s.o, 'GET', '/api/hooks/stop', {}), undefined);
  assert.equal(await nativeRoute(s.o, 'POST', '/api/other', {}), undefined);
});

test('a message with no sender is never dropped: it matches a worker by story, worktree or session, else it is an unknown-sender card', async () => {
  const s = setup();
  const w = await s.native.start({ name: '4390-sup-1025-page-address-problem-483', cwd: '/tmp', brief: 'x' });
  const ro = { native: s.native, store: s.store, log: s.log };
  const ask = 'STORY: #4390 SUP-1025 listing address not read\nQUESTION: Ship a guessed fix now?\nOPTIONS: wait because Pat\'s PR collects data; ship because the customer waits';
  // No sender name: the STORY number names the worker.
  const byStory = routeWorkerTurn({ ...ro, now: () => 1000 }, { text: ask }, 'Story 4390 asks.');
  assert.equal(byStory.item?.dispatch_id, `n:${w.id}`);
  assert.ok(s.logs.some(l => l.startsWith('native message matched to a worker without its name') && l.includes('"by":"story"')));
  // A wrong name, with the worker's session id or worktree in the text.
  assert.equal(matchSender(s.native, { from: 'someone-else', text: `session ${w.session_id}` })?.by, 'session');
  assert.equal(matchSender(s.native, { text: 'QUESTION: x?', from: undefined }), undefined, 'no story, path or session: no guess');
  // Two workers on the same story: no guess.
  const two = [w, { ...w, id: 'other', name: '4390-follow-up-490' }];
  assert.equal(matchSender({ get: () => undefined, list: () => two }, { text: ask }), undefined);
  // A worktree path picks one worker.
  const trees = [{ ...w, cwd: '/Users/x/wt/4390-a' }, { ...w, id: 'b', name: 'b-1', cwd: '/Users/x/wt/other-b' }];
  assert.equal(matchSender({ get: () => undefined, list: () => trees }, { text: 'I am in /Users/x/wt/other-b now' })?.worker.id, 'b');
  // No match: an open card from an unknown sender, with the message word for word, and nothing spoken.
  const stranger = routeWorkerTurn({ ...ro, now: () => 2000 }, { from: 'someone-else', text: 'QUESTION: hi?' }, 'Hello stranger');
  assert.equal(stranger.speak, false);
  assert.equal(stranger.unknown?.external_id, unknownId(2000));
  assert.equal(stranger.unknown?.subject, UNKNOWN_SUBJECT);
  assert.equal(stranger.unknown?.body, 'QUESTION: hi?');
  assert.equal(stranger.unknown?.dispatch_id, null);
  // No peer message at all (2026-11-11 13:51Z): it is the brain's own reply. No card, and it is spoken.
  const none = routeWorkerTurn({ ...ro, now: () => 3000 }, undefined, 'Here is my answer to you.');
  assert.equal(none.unknown, undefined);
  assert.equal(none.speak, true);
  assert.ok(!s.store.openItems().some(i => i.external_id === unknownId(3000)));
  assert.equal(routeWorkerTurn({ ...ro, now: () => 3001 }, undefined, 'SILENT').speak, false);
  // A peer message with an empty body and no match still goes on a card, with the brain's answer.
  const empty = routeWorkerTurn({ ...ro, now: () => 3002 }, { from: 'nobody', text: '' }, 'PR 5321 is ready.');
  assert.match(empty.unknown?.body ?? '', /did not get the message text[\s\S]*PR 5321 is ready\./);
  // Tapping it sends nothing and says why. The brain's relay with --item closes it.
  const tap = await answerAsk({ id: unknownId(2000), value: 'yes', store: s.store, log: s.log, note: () => {}, native: s.native });
  assert.equal(tap.status, 409);
  assert.match(tap.error ?? '', /does not know which worker/);
  const relay = await nativeRoute(s.o, 'POST', '/api/internal/native/reply', { worker: w.name, text: 'Wait for the data.', item: unknownId(2000) });
  assert.equal(relay?.status, 200);
  assert.equal(s.store.item(unknownId(2000))?.status, 'answered');
  assert.equal(s.store.item(unknownId(2000))?.answered_by, 'jarvis');
  assert.ok(s.changed.includes(unknownId(2000)));
});

test('a worker\'s message to the brain becomes a question item; the brain\'s reply answers it', async () => {
  const s = setup();
  const w = await s.native.start({ name: 'probe-1', cwd: '/tmp', brief: 'x' });
  const ask = 'QUESTION: merge?\nOPTIONS: merge because tests pass; wait because review is open';
  const r = routeWorkerTurn({ native: s.native, store: s.store, log: s.log, now: () => 1000 }, { from: 'probe-1', text: ask }, 'Probe one asks whether to merge.');
  assert.equal(r.item?.external_id, askId(w.id, 1000));
  assert.equal(r.item?.dispatch_id, `n:${w.id}`);
  assert.equal(r.item?.body, ask);
  assert.equal(r.speak, true);
  assert.equal(s.store.openItems().length, 1);
  // The brain's reply through jarvis-native: relayed, and the open question is answered in Jarvis's name.
  const reply = await nativeRoute(s.o, 'POST', '/api/internal/native/reply', { worker: 'probe-1', text: 'Yes, merge it.' });
  assert.equal(reply?.status, 200);
  assert.ok(s.calls.some(c => c[0] === '-p' && c.includes('SendMessage')));
  assert.equal(s.store.openItems().length, 0);
  assert.equal(s.store.item(askId(w.id, 1000))?.answered_by, 'jarvis');
  assert.deepEqual(s.changed, [askId(w.id, 1000)]);
  const missing = await nativeRoute(s.o, 'POST', '/api/internal/native/reply', { worker: 'nobody', text: 'x' });
  assert.equal(missing?.status, 404);
  const bad = await nativeRoute(s.o, 'POST', '/api/internal/native/reply', { worker: 'probe-1' });
  assert.equal(bad?.status, 400);
  // The silent case: the brain said SILENT, so nothing is spoken but the card still exists.
  const quiet = routeWorkerTurn({ native: s.native, store: s.store, log: s.log, now: () => 2000 }, { from: 'probe-1', text: 'QUESTION: ship it?\nOPTIONS: ship; hold' }, 'SILENT');
  assert.equal(quiet.speak, false);
  assert.deepEqual(answerOpenAsks(s.store, w.id, 'ok', 'owner'), [askId(w.id, 2000)]);
});

test('a worker notice is a status line with nothing to answer, and an ask with no options goes back to the worker', async () => {
  const s = setup();
  const w = await s.native.start({ name: 'probe-1', cwd: '/tmp', brief: 'x' });
  const route = (text: string, at: number) => routeWorkerTurn({ native: s.native, store: s.store, log: s.log, now: () => at }, { from: 'probe-1', text }, 'The switch starts now.');
  // The message from the incident: a plain status, sent through the question channel.
  const n = route('The switch starts now. jarvisd restarts in 1 minute. You do not need to do anything.', 1000);
  assert.equal(n.item, undefined);
  assert.equal(n.speak, false);
  assert.equal(n.notice, 'The switch starts now. jarvisd restarts in 1 minute. You do not need to do anything.');
  assert.equal(s.store.openItems().length, 0, 'no ask card');
  assert.deepEqual(s.store.eventsFor(`n:${w.id}`).map(i => i.body), [n.notice]);
  assert.equal(route('NOTICE: tests pass, pushing now', 1100).notice, 'tests pass, pushing now');
  assert.ok(route('Status: see https://example.test/pr?x=1 for the diff', 1200).notice, 'a ? inside a link asks nothing');
  // A question with no options: no item, nothing spoken, and the refusal tells the worker what to do.
  const q = route('STORY: 1 merge\nWHERE: tests pass.\nQUESTION: Should I merge?', 1300);
  assert.equal(q.item, undefined);
  assert.equal(q.notice, undefined);
  assert.equal(q.speak, false);
  assert.equal(q.refusal, NO_OPTIONS_REFUSAL);
  assert.match(NO_OPTIONS_REFUSAL, /OPTIONS/);
  assert.match(NO_OPTIONS_REFUSAL, /NOTICE:/);
  assert.equal(route('Should I merge now?', 1400).refusal, NO_OPTIONS_REFUSAL);
  assert.equal(s.store.openItems().length, 0);
  // Options in the body make it an ask, in the headed shape, recommended first.
  assert.equal(workerMessageKind('QUESTION: merge?\nOPTIONS:\n- merge because tests pass\n- wait because review is open'), 'ask');
  assert.equal(workerMessageKind('Which one? Options: (a) merge (b) wait'), 'ask');
  assert.equal(workerMessageKind('DONE: merged'), 'notice');
});

test('a one-line ask with OPTIONS after QUESTION on the same line is an ask card, its options split on semicolons', () => {
  // The live test of 2026-11-08: this exact message went back to the worker with the no-options refusal.
  const text = 'QUESTION: Test step 3. Did the test work? OPTIONS: yes because one status line and one card showed; no because something else showed';
  assert.equal(workerMessageKind(text), 'ask');
  const card = askCard({ id: 0, source: 'native', external_id: 'ask:x:1', kind: 'question', dispatch_id: null, subject: 'Question from x', body: text,
    options: null, status: 'new', answer: null, created_at: '', pushes: 0, pushed_at: null, meta: null } as Item)!;
  assert.equal(card.question, 'Test step 3. Did the test work?');
  assert.doesNotMatch(card.body, /OPTIONS/);
  assert.equal(card.options.length, 2);
  assert.deepEqual(card.options.map(o => o.label), ['yes', 'no']);
  assert.deepEqual(card.options.map(o => o.detail), ['one status line and one card showed', 'something else showed']);
  // A one-line question with no options is still sent back.
  assert.equal(workerMessageKind('QUESTION: Did the test work?'), 'no-options');
});

test('the native worker footer says an ask needs options and a notice is not a question', () => {
  assert.match(NATIVE_FOOTER, /An ask must have OPTIONS/);
  assert.match(NATIVE_FOOTER, /A notice is not a question/);
  assert.match(NATIVE_FOOTER, /NOTICE: <one sentence>/);
});

test('the gate routes worker-start, stop and abandon to native.ts and never proposes a permission card', () => {
  const q = buildCommand('question', { repo: '/r', question: 'Why?' });
  assert.equal(q[0], 'native'); assert.match(q[3], /Read-only research/); assert.match(q[3], /first line is exactly `DONE: answered`/); assert.doesNotMatch(q[3], /worker_done/);
  const sc = buildCommand('side-chat', { repo: '/r', text: 'hi there' });
  assert.equal(sc[0], 'native'); assert.match(sc[3], /Side chat with the owner/); assert.match(sc[3], /hi there/); assert.doesNotMatch(sc[3], /worker_done/);
  const start = buildCommand('worker-start', { repo: '/r', spec: 'Do #1', native: true, taskTitle: '#1 topic' });
  assert.equal(start[0], 'native'); assert.equal(start[1], 'start'); assert.equal(start[2], '/r');
  assert.match(start[3], /Do #1\n\n## Filing issues/);
  assert.match(start[3], /One exception to not posting on GitHub/);
  assert.match(start[3], /## You are a Jarvis worker/);
  assert.match(start[3], /DONE: <one sentence>/);
  assert.throws(() => buildCommand('worker-start', { repo: '/r', spec: 'x', native: true, permissionMode: 'plan' }), /permissionMode/);
  assert.deepEqual(buildCommand('worker-stop', { dispatch: 'n:abc' }), ['native', 'stop', 'n:abc']);
  assert.deepEqual(buildCommand('worker-abandon', { dispatch: 'n:abc' }), ['native', 'abandon', 'n:abc']);
  assert.throws(() => buildCommand(WORKER_PERMISSION, { worker: 'abc' }), /cannot be proposed/);
  assert.ok(BUTTON_ONLY.has(WORKER_PERMISSION));
  assert.equal(nativeName('#4412 Onboarding wizard!', 7), '4412-onboarding-wizard-7');
  assert.equal(nativeName(undefined, 8), 'worker-8');
});

test('a cross-session message in a worker\'s transcript shows as a reply line, not as a hidden meta turn', () => {
  const peer = { type: 'user', isMeta: true, turnOrigin: 'peer', timestamp: '2026-11-06T22:00:00Z', message: { role: 'user', content: 'Another Claude session sent a message:\n<cross-session-message from="uds:/tmp/x.sock" from-name="jarvis-brain-relay" from-mode="prompting">\nhello 42\n</cross-session-message>\n\nThis came from another Claude session.' } };
  const meta = { type: 'user', isMeta: true, message: { role: 'user', content: 'noise' } };
  const lines = chatLines([JSON.stringify(peer), JSON.stringify(meta)].join('\n'), 0);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].kind, 'reply');
  assert.equal(lines[0].text, 'hello 42');
});

test('an interactive worker starts in a pseudo-terminal, is found by name, stops by its process group and resumes in a new one', async () => {
  const store = openStore(':memory:');
  const logs: string[] = [];
  const agent: any = { kind: 'interactive', name: 'design-5', pid: 777, status: 'busy', sessionId: 'c0ffee00-1111-2222-3333-444444444444' };
  const spawned: string[][] = [], killed: number[] = [];
  const claude: Claude = async (args) => {
    const help = helpRun(args); if (help) return help;
    if (args[0] === '--version') return { code: 0, out: '2.1.316', err: '' };
    if (args[0] === 'agents') return { code: 0, out: JSON.stringify([agent]), err: '' };
    if (args[0] === '-p') return { code: 0, out: JSON.stringify({ result: 'SENT' }), err: '' };
    return { code: 0, out: '', err: '' };
  };
  const native = makeNative({ store, log: (m, f) => logs.push(`${m} ${JSON.stringify(f ?? {})}`), jarvisUrl: 'http://127.0.0.1:1', dataDir: mkdtempSync(join(tmpdir(), 'jarvis-nr-')), claude,
    spawnPty: argv => { spawned.push(argv); return 4242; }, killGroup: pgid => killed.push(pgid),
    onChange: () => {}, onReport: () => {}, onCard: () => {}, onNotice: () => {} });
  const w = await native.start({ name: 'design-5', cwd: '/tmp', brief: 'Publish a design', interactive: true, approvalId: 5 });
  assert.equal(w.id, 'c0ffee00');
  assert.equal(w.kind, 'interactive');
  assert.equal(w.pgid, 4242);
  assert.equal(w.state, 'working');
  assert.deepEqual(spawned[0].slice(0, 3), ['claude', '--name', 'design-5']);
  assert.equal(spawned[0].at(-1), 'Publish a design');
  assert.ok(!spawned[0].includes('--bg'));
  // Liveness from status: busy is working, waiting is blocked, idle after a report is done.
  agent.status = 'waiting';
  await native.poll();
  assert.equal(native.get('c0ffee00')?.state, 'blocked');
  agent.status = 'idle';
  native.stopHook({ session_id: agent.sessionId, last_assistant_message: 'DONE: published' });
  await native.poll();
  assert.equal(native.get('c0ffee00')?.state, 'done');
  // Stop ends the process group; a reply afterwards resumes the conversation in a new terminal.
  await native.stop('c0ffee00');
  assert.deepEqual(killed, [4242]);
  assert.equal(native.get('c0ffee00')?.state, 'stopped');
  delete agent.pid;
  const r = native.reply('c0ffee00', 'again', 'owner');
  await new Promise(res => setTimeout(res, 50));
  agent.pid = 778;
  assert.deepEqual(await r, { ok: true });
  assert.ok(spawned[1].includes('--resume') && spawned[1].includes(agent.sessionId));
  await assert.rejects(native.attach('c0ffee00'), /Use Desktop/);
  assert.ok(logs.some(l => l.startsWith('native worker started') && l.includes('"kind":"interactive"')));
});
