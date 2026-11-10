import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Approval } from './store.ts';
import { helpRun, CLAUDE_HELP, AGENTS_HELP } from './fakeclaude.ts';
import { makeNative, workerSettings, summarize, projectDir, NATIVE_FOOTER, ROW_PREFIX, SILENT_DONE_MS, IDLE_REAP_MS, IDLE_STOPPED, DESKTOP_WAITING, NUDGE, typedBytes, rowState, finishedAt, missingFeatures, REPORT_NUDGE, type NativeWorker } from './native.ts';
import { statusOf } from './requests.ts';
import { lastTurnMessages } from './transcript.ts';

const SESSION = '00000000-0000-4000-8000-000000000001';

/** A stand-in `claude` CLI: one background agent whose listing the test edits between calls. */
function fakeClaude() {
  const agent: any = { id: 'deabc023', sessionId: SESSION, name: 'probe-7', pid: 4242, status: 'idle', state: 'working', cwd: '/repo' };
  const calls: string[][] = [];
  let relayAnswer = 'SENT';
  const claude = async (args: string[]) => {
    calls.push(args);
    const help = helpRun(args); if (help) return help;
    if (args[0] === '--version') return { code: 0, out: '2.1.316 (Claude Code)\n', err: '' };
    if (args[0] === '--bg') return { code: 0, out: `backgrounded · ${agent.id} · ${agent.name}\n\n  claude attach ${agent.id}\n`, err: '' };
    if (args[0] === 'agents') return { code: 0, out: JSON.stringify(agent.pid === null && !agent.listed ? [] : [agent]), err: '' };
    if (args[0] === 'respawn') { agent.pid = 4343; agent.state = 'working'; return { code: 0, out: 'respawned\n', err: '' }; }
    if (args[0] === 'stop') { agent.pid = null; agent.listed = true; agent.state = 'stopped'; return { code: 0, out: '', err: '' }; }
    if (args[0] === '-p') return { code: 0, out: JSON.stringify({ type: 'result', is_error: false, result: relayAnswer }), err: '' };
    return { code: 0, out: '', err: '' };
  };
  return { agent, calls, claude, setRelay: (s: string) => { relayAnswer = s; } };
}

function setup(nowMs = 1_800_000_000_000) {
  const store = openStore(':memory:');
  const fake = fakeClaude();
  const changes: NativeWorker[] = [], reports: [string, boolean][] = [], cards: Approval[] = [], notices: string[] = [], logs: string[] = [];
  let t = nowMs;
  const native = makeNative({
    store, log: (m, f) => logs.push(`${m} ${JSON.stringify(f ?? {})}`), jarvisUrl: 'http://127.0.0.1:7788', dataDir: mkdtempSync(join(tmpdir(), 'native-')),
    onChange: w => changes.push(w), onReport: (_w, text, final) => reports.push([text, final]), onCard: a => cards.push(a), onNotice: (_w, text) => notices.push(text),
    claude: fake.claude, now: () => t,
  });
  return { store, fake, native, changes, reports, cards, notices, logs, tick: (ms: number) => { t += ms; } };
}

test('workerSettings points the three hooks at jarvisd and blocks AskUserQuestion', () => {
  const s: any = workerSettings('http://127.0.0.1:7788');
  assert.equal(s.hooks.PermissionRequest[0].hooks[0].url, 'http://127.0.0.1:7788/api/hooks/permission');
  assert.equal(s.hooks.PermissionRequest[0].hooks[0].timeout, 86_400);
  assert.equal(s.hooks.Stop[0].hooks[0].url, 'http://127.0.0.1:7788/api/hooks/stop');
  assert.equal(s.hooks.PreToolUse[0].matcher, 'AskUserQuestion');
  assert.deepEqual(s.permissions.deny, ['AskUserQuestion']);
  assert.equal(s.crossSessionInbound, 'accept');
  assert.match(NATIVE_FOOTER, /DONE: <one sentence>/);
  assert.equal(summarize('Bash', { command: 'ls -la' }), 'ls -la');
  assert.equal(summarize('Edit', { file_path: '/a/b.ts' }), '/a/b.ts');
  assert.equal(summarize('WebFetch', { url: 'x' }), '{"url":"x"}');
});

test('start parses the short id, finds the session and stores the worker', async () => {
  const { native, fake, store, logs } = setup();
  const w = await native.start({ name: 'probe-7', cwd: '/repo', brief: 'do it', approvalId: 7 });
  assert.equal(w.id, 'deabc023');
  assert.equal(w.session_id, SESSION);
  assert.equal(w.state, 'working');
  assert.equal(w.approval_id, 7);
  const bg = fake.calls.find(c => c[0] === '--bg')!;
  assert.deepEqual(bg.slice(0, 7), ['--bg', '--name', 'probe-7', '--permission-mode', 'auto', '--model', 'claude-opus-5-5']);
  assert.equal(bg[bg.length - 1], 'do it');
  assert.ok(bg.includes('--settings'));
  assert.equal(store.nativeWorker('deabc023')?.name, 'probe-7');
  assert.ok(logs.some(l => l.startsWith('native worker started {"worker":"deabc023"')));
  assert.equal(native.get(`${ROW_PREFIX}deabc023`)?.id, 'deabc023');
  assert.equal(native.get(SESSION)?.id, 'deabc023');
});

test('start throws with the claude output when no id was printed', async () => {
  const { native, fake } = setup();
  fake.claude = async (args: string[]) => helpRun(args) ?? { code: 1, out: '', err: 'Workspace not trusted\n' };
  const n = makeNative({ store: openStore(':memory:'), log: () => {}, jarvisUrl: 'http://x', dataDir: mkdtempSync(join(tmpdir(), 'native-')), onChange: () => {}, onReport: () => {}, onCard: () => {}, onNotice: () => {}, claude: fake.claude });
  await assert.rejects(n.start({ name: 'p', cwd: '/x', brief: 'b' }), /Workspace not trusted/);
  void native;
});

test('a permission request from an unknown session resolves {} at once', async () => {
  const { native, cards, logs } = setup();
  assert.deepEqual(await native.permissionRequest({ session_id: 'nobody', tool_name: 'Bash' }), {});
  assert.equal(cards.length, 0);
  assert.ok(logs.some(l => l.startsWith('hook from an unknown session')));
});

test('a known session gets a worker-permission card and the hook resolves with the decision', async () => {
  const { native, store, cards, changes } = setup();
  await native.start({ name: 'probe-7', cwd: '/repo', brief: 'b' });
  const p = native.permissionRequest({ session_id: SESSION, transcript_path: '/t/x.jsonl', tool_name: 'Bash', tool_input: { command: 'touch /tmp/a' } });
  assert.equal(cards.length, 1);
  const a = cards[0];
  assert.equal(a.action, 'worker-permission');
  assert.equal(a.say, 'Allow Bash in probe-7?');
  assert.deepEqual(JSON.parse(a.args), { worker: 'deabc023', name: 'probe-7', tool: 'Bash', input: { command: 'touch /tmp/a' }, summary: 'touch /tmp/a' });
  const blocked = native.get('deabc023')!;
  assert.equal(blocked.state, 'blocked');
  assert.equal(blocked.waiting_for, 'touch /tmp/a');
  assert.equal(blocked.transcript, '/t/x.jsonl');
  assert.equal(native.rows()[0].state, 'waiting');
  assert.equal(native.rows()[0].note, 'touch /tmp/a');
  assert.deepEqual(native.decide(a.id, true), { ok: true });
  assert.deepEqual(await p, { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
  assert.equal(store.approval(a.id)?.status, 'done');
  assert.equal(store.approval(a.id)?.result, 'allowed');
  assert.equal(native.get('deabc023')?.state, 'working');
  assert.equal(native.get('deabc023')?.waiting_for, null);
  assert.equal(cards.length, 2);
  assert.ok(changes.length >= 3);

  const q = native.permissionRequest({ session_id: SESSION, tool_name: 'Edit', tool_input: { file_path: '/repo/x.ts' } });
  const b = cards[2];
  assert.deepEqual(native.decide(b.id, false), { ok: true });
  const denied: any = await q;
  assert.equal(denied.hookSpecificOutput.decision.behavior, 'deny');
  assert.equal(denied.hookSpecificOutput.decision.message, 'The owner denied it from the Jarvis app');
  assert.equal(store.approval(b.id)?.result, 'denied');
  assert.equal(native.decide(b.id, true).ok, false);
});

test('decide on nothing held is an error', () => {
  const { native } = setup();
  const r = native.decide(99, true);
  assert.equal(r.ok, false);
  assert.match((r as any).error, /no longer held/);
});

test('recover fails pending permission cards left from before a restart', async () => {
  const { native, store, logs } = setup();
  await native.start({ name: 'probe-7', cwd: '/repo', brief: 'b' });
  void native.permissionRequest({ session_id: SESSION, tool_name: 'Bash', tool_input: { command: 'x' } });
  const id = store.pendingApprovals()[0].id;
  await native.recover();
  assert.equal(store.approval(id)?.status, 'failed');
  assert.equal(store.approval(id)?.result, 'jarvisd restarted before the owner answered');
  assert.equal(native.get('deabc023')?.state, 'working');
  assert.ok(logs.some(l => l.startsWith('native: recovered {"failedPermissionCards":1')));
});

test('the Stop hook stores the report word for word and DONE or FAILED sets the outcome', async () => {
  const { native, reports, logs, notices } = setup();
  await native.start({ name: 'probe-7', cwd: '/repo', brief: 'b' });
  // No line and nothing pending: sent back once with the nudge.
  assert.deepEqual(native.stopHook({ session_id: SESSION, transcript_path: '/t/s.jsonl', stop_hook_active: false, last_assistant_message: 'Still looking.\n\nMore to come.' }), { decision: 'block', reason: REPORT_NUDGE });
  let w = native.get('deabc023')!;
  assert.equal(w.report, 'Still looking.\n\nMore to come.');
  assert.equal(w.outcome, null);
  assert.equal(w.state, 'working');
  assert.equal(w.transcript, '/t/s.jsonl');
  assert.deepEqual(reports, [['Still looking.\n\nMore to come.', false]]);

  // The answer to the block (stop_hook_active) is stored too; still no line, so the brain hears it now and it is not sent back again.
  assert.deepEqual(native.stopHook({ session_id: SESSION, stop_hook_active: true, last_assistant_message: 'Still nothing.' }), {});
  assert.equal(native.get('deabc023')?.report, 'Still nothing.');
  assert.deepEqual(notices, ['Worker probe-7 ended its turn without a DONE or FAILED line. Its last words: Still nothing.']);

  native.stopHook({ session_id: SESSION, stop_hook_active: false, last_assistant_message: '  done: the list is fixed\nbranch x, commit y' });
  w = native.get('deabc023')!;
  assert.equal(w.outcome, 'done');
  assert.equal(w.state, 'done');
  assert.equal(w.report, '  done: the list is fixed\nbranch x, commit y');
  assert.deepEqual(reports[2], ['  done: the list is fixed\nbranch x, commit y', true]);
  assert.ok(logs.some(l => l.startsWith('native worker reported {"worker":"deabc023","final":true')));

  native.stopHook({ session_id: SESSION, last_assistant_message: 'FAILED: no access' });
  assert.equal(native.get('deabc023')?.outcome, 'failed');
  native.stopHook({ session_id: 'nobody', last_assistant_message: 'x' });
  assert.equal(reports.length, 4);
});

test('preToolUse denies AskUserQuestion and nothing else', () => {
  const { native } = setup();
  const r: any = native.preToolUse({ tool_name: 'AskUserQuestion' });
  assert.equal(r.hookSpecificOutput.permissionDecision, 'deny');
  assert.deepEqual(native.preToolUse({ tool_name: 'Bash' }), {});
});

test('poll maps agent states to rows and tells each finding once', async () => {
  const { native, fake, notices, tick } = setup();
  await native.start({ name: 'fix-dead-list-412', cwd: '/w/fix-dead-list-412', brief: 'b' });
  fake.agent.status = 'waiting'; fake.agent.state = 'blocked'; fake.agent.waitingFor = 'input needed';
  await native.poll();
  await native.poll();
  assert.deepEqual(notices, ['Worker fix-dead-list-412 is blocked: input needed']);
  let r = native.rows()[0];
  assert.equal(r.state, 'waiting');
  assert.equal(r.note, 'input needed');
  assert.equal(r.native?.state, 'blocked');

  fake.agent.status = 'busy'; fake.agent.state = 'working'; delete fake.agent.waitingFor;
  await native.poll();
  assert.equal(native.get('deabc023')?.waiting_for, null);
  assert.equal(native.rows()[0].state, 'working');
  assert.equal(native.rows()[0].endedAt, undefined, 'a working row has no finish time');

  fake.agent.state = 'failed'; delete fake.agent.pid; delete fake.agent.status;
  await native.poll();
  await native.poll();
  assert.deepEqual(notices.slice(1), ['Worker fix-dead-list-412 failed']);
  assert.equal(native.get('deabc023')?.outcome, 'failed');
  assert.equal(native.rows()[0].state, 'exited');
  assert.equal(native.rows()[0].steer, 'none');

  // A turn ended without a DONE line and was sent back, but the next Stop hook never arrived (a restart): the backstop tells
  // the brain once the report is two minutes old.
  const { native: n2, fake: f2, notices: no2, tick: t2 } = setup();
  await n2.start({ name: 'probe-7', cwd: '/repo', brief: 'b' });
  n2.stopHook({ session_id: SESSION, last_assistant_message: 'I think that is all.' });
  f2.agent.state = 'done'; delete f2.agent.pid;
  await n2.poll();
  assert.deepEqual(no2, []);
  t2(SILENT_DONE_MS);
  await n2.poll();
  await n2.poll();
  assert.deepEqual(no2, ['Worker probe-7 ended its turn without a DONE or FAILED line. Its last words: I think that is all.']);
  r = n2.rows()[0];
  assert.equal(r.state, 'idle');
  assert.equal(r.note, 'Done 2 min ago');
  assert.equal(r.endedAt, n2.get(r.native!.id)!.report_at, 'a done row carries its finish time for the Done fold');
  assert.equal(r.steer, 'auto');
  void tick;
});

test('rows have the contract shape and finished rows leave after a day', async () => {
  const { native, fake, tick } = setup();
  const w = await native.start({ name: 'fix-dead-list-412', cwd: '/w/fix-dead-list-412', brief: 'b', approvalId: 412 });
  assert.deepEqual(native.rows(), [{
    id: 'n:deabc023', kind: 'worker', dispatch: 'n:deabc023', title: 'fix-dead-list-412', group: 'other', state: 'working',
    worktree: 'fix-dead-list-412', steer: 'auto',
    native: { id: 'deabc023', sessionId: SESSION, name: 'fix-dead-list-412', state: 'working', waitingFor: null, outcome: null, kind: 'background' },
  }]);
  assert.equal(native.list()[0].id, w.id);
  await native.stop('n:deabc023');
  assert.equal(native.get('deabc023')?.state, 'stopped');
  assert.equal(native.rows()[0].state, 'exited');
  tick(25 * 3_600_000);
  assert.deepEqual(native.rows(), []);
  await native.abandon('deabc023');
  assert.ok(fake.calls.some(c => c[0] === 'rm' && c[1] === 'deabc023'));
  assert.equal(native.get('deabc023')?.state, 'abandoned');
  assert.equal((await native.reply('deabc023', 'x', 'owner')).ok, false);
});

test('reply respawns a stopped worker, relays through SendMessage and records the reply item', async () => {
  const { native, fake, store, logs } = setup();
  await native.start({ name: 'probe-7', cwd: '/repo', brief: 'b' });
  await native.stop('deabc023');
  const r = await native.reply('n:deabc023', 'hello 42', 'owner');
  assert.deepEqual(r, { ok: true });
  const order = fake.calls.map(c => c[0]);
  assert.ok(order.indexOf('respawn') > order.indexOf('stop'));
  assert.ok(order.indexOf('-p') > order.indexOf('respawn'));
  const relay = fake.calls.find(c => c[0] === '-p')!;
  assert.ok(relay.includes('SendMessage'));
  assert.match(relay[relay.length - 1], /to the session named probe-7: <<<\nhello 42\n>>>/);
  assert.equal(native.get('deabc023')?.state, 'working');
  const items = store.db.prepare(`SELECT * FROM items WHERE source = 'native'`).all() as any[];
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'reply');
  assert.equal(items[0].dispatch_id, 'n:deabc023');
  assert.equal(items[0].body, 'hello 42');
  assert.equal(items[0].answered_by, null);
  assert.ok(logs.some(l => l.startsWith('native worker respawned')));
  assert.ok(logs.some(l => l.startsWith('native reply {"worker":"deabc023","by":"owner"')));

  // Alive now (one fresh listing says so), so the next reply goes straight to the relay; the brain's reply is marked as its own.
  const before = fake.calls.length;
  assert.deepEqual(await native.reply('deabc023', 'and again', 'jarvis'), { ok: true });
  assert.deepEqual(fake.calls.slice(before).map(c => c[0]), ['agents', '-p']);
  const again = store.db.prepare(`SELECT * FROM items WHERE source = 'native' ORDER BY id DESC LIMIT 1`).get() as any;
  assert.equal(again.answered_by, 'jarvis');

  fake.setRelay('No agent named probe-7 is reachable');
  const bad = await native.reply('deabc023', 'lost', 'owner');
  assert.equal(bad.ok, false);
  assert.match((bad as any).error, /did not confirm/);
});

test('transcriptFile is the stored path, else the computed one when it exists', async () => {
  const { native } = setup();
  await native.start({ name: 'probe-7', cwd: '/repo', brief: 'b' });
  assert.equal(native.transcriptFile('deabc023'), undefined);
  native.stopHook({ session_id: SESSION, transcript_path: '/t/s.jsonl', last_assistant_message: 'x' });
  assert.equal(native.transcriptFile('n:deabc023'), '/t/s.jsonl');
  assert.equal(native.transcriptFile('nobody'), undefined);
});

// ---- Interactive sessions (the default kind since 2026-11-07) ----

const ISESSION = '00000000-0000-4000-8000-000000000002';

/**
 * A stand-in for the pseudo-terminal path: `spawnPty` records argv, cwd and fifo and adds the session to the listing, in the
 * worktree folder when `-w` was passed, the way `claude agents` reports it live; `killGroup` drops the pid from the listing.
 */
function setupInteractive(nowMs = 1_800_000_000_000) {
  const store = openStore(':memory:');
  const listing: any[] = [];
  const spawns: { argv: string[]; cwd: string; fifo?: string }[] = [], killed: number[] = [], fifos: string[] = [];
  let nextPgid = 5000, started = 0;
  const calls: string[][] = [];
  const claude = async (args: string[]) => {
    calls.push(args);
    const help = helpRun(args); if (help) return help;
    if (args[0] === '--version') return { code: 0, out: '2.1.316 (Claude Code)\n', err: '' };
    if (args[0] === 'agents') return { code: 0, out: JSON.stringify(listing), err: '' };
    if (args[0] === '-p') return { code: 0, out: JSON.stringify({ type: 'result', is_error: false, result: 'SENT' }), err: '' };
    return { code: 0, out: '', err: '' };
  };
  const changes: NativeWorker[] = [], notices: string[] = [], logs: string[] = [], reports: [string, boolean][] = [], cards: Approval[] = [];
  let t = nowMs;
  const native = makeNative({
    store, log: (m, f) => logs.push(`${m} ${JSON.stringify(f ?? {})}`), jarvisUrl: 'http://127.0.0.1:7788', dataDir: mkdtempSync(join(tmpdir(), 'native-')),
    onChange: w => changes.push(w), onReport: (_w, text, final) => reports.push([text, final]), onCard: a => cards.push(a), onNotice: (_w, text) => notices.push(text),
    claude, now: () => t,
    mkfifo: f => { fifos.push(f); },
    spawnPty: (argv, cwd, fifo) => {
      spawns.push({ argv, cwd, fifo });
      const pgid = nextPgid++;
      const name = argv[argv.indexOf('--name') + 1];
      const wt = argv.indexOf('-w');
      const resume = argv.indexOf('--resume');
      listing.push({ pid: pgid + 1, pgid, cwd: wt >= 0 ? `${cwd}/.claude/worktrees/${argv[wt + 1]}` : cwd, kind: 'interactive', sessionId: resume >= 0 ? argv[resume + 1] : started++ === 0 ? ISESSION : `${String(started).padStart(8, '0')}-0000-0000-0000-000000000000`, name, status: 'busy' });
      return pgid;
    },
    killGroup: pgid => { killed.push(pgid); for (const a of listing) if (a.pgid === pgid) delete a.pid; },
  });
  return { store, native, listing, spawns, killed, fifos, calls, changes, notices, logs, reports, cards, tick: (ms: number) => { t += ms; } };
}

test('an interactive start passes -w and the flags, stores what a resume replays, and takes its cwd from the listing', async () => {
  const { native, spawns, fifos, store, logs } = setupInteractive();
  const w = await native.start({ name: 'mockups-401', cwd: '/repo', brief: 'draw it', model: 'claude-sonnet-5-5', permissionMode: 'default', approvalId: 401, worktree: true, interactive: true });
  assert.equal(spawns.length, 1);
  const { argv, cwd, fifo } = spawns[0];
  assert.deepEqual(argv.slice(0, 7), ['claude', '--name', 'mockups-401', '--permission-mode', 'default', '--model', 'claude-sonnet-5-5']);
  assert.equal(argv[7], '--settings');
  assert.deepEqual(argv.slice(9, 11), ['-w', 'mockups-401']);
  assert.equal(argv[argv.length - 1], 'draw it');
  assert.equal(cwd, '/repo');
  assert.ok(fifo?.endsWith('/pty/mockups-401-r0.in'), fifo);
  assert.deepEqual(fifos, [fifo]);
  assert.equal(w.id, ISESSION.slice(0, 8));
  assert.equal(w.kind, 'interactive');
  assert.equal(w.pgid, 5000);
  assert.equal(w.state, 'working');
  assert.equal(w.repo, '/repo');
  assert.equal(w.cwd, '/repo/.claude/worktrees/mockups-401');
  assert.equal(w.model, 'claude-sonnet-5-5');
  assert.equal(w.permission_mode, 'default');
  assert.equal(w.resumes, 0);
  assert.equal(w.in_fifo, fifo);
  assert.equal(store.nativeWorker(w.id)?.in_fifo, fifo);
  assert.equal(native.rows()[0].worktree, 'mockups-401');
  assert.ok(logs.some(l => l.startsWith('native worker started') && l.includes('"worktree":true') && l.includes('"kind":"interactive"')));

  // Without a worktree: no -w, the folder is the repo, and the defaults are the stored flags.
  const s2 = setupInteractive();
  const w2 = await s2.native.start({ name: 'plain-402', cwd: '/repo', brief: 'b', interactive: true });
  assert.ok(!s2.spawns[0].argv.includes('-w'));
  assert.equal(w2.cwd, '/repo');
  assert.equal(w2.model, 'claude-opus-5-5');
  assert.equal(w2.permission_mode, 'auto');
});

test('the poll moves an interactive cwd to the folder the listing names, once', async () => {
  const { native, listing, changes } = setupInteractive();
  const w = await native.start({ name: 'late-403', cwd: '/repo', brief: 'b', interactive: true });
  assert.equal(w.cwd, '/repo');
  listing[0].cwd = '/repo/.claude/worktrees/late-403';
  await native.poll();
  assert.equal(native.get(w.id)?.cwd, '/repo/.claude/worktrees/late-403');
  const n = changes.length;
  await native.poll();
  assert.equal(changes.length, n, 'a second poll with the same listing changes nothing');
  // A listing without a pid names nothing: the stored folder stays (the worker is done, so its death is not resumed).
  native.stopHook({ session_id: ISESSION, last_assistant_message: 'DONE: drawn' });
  delete listing[0].pid; listing[0].cwd = '/elsewhere';
  await native.poll();
  assert.equal(native.get(w.id)?.cwd, '/repo/.claude/worktrees/late-403');
});

test('stop and abandon end an interactive group and leave the row stopped or abandoned', async () => {
  const { native, killed, listing } = setupInteractive();
  const w = await native.start({ name: 'k-404', cwd: '/repo', brief: 'b', interactive: true });
  await native.stop(`${ROW_PREFIX}${w.id}`);
  assert.deepEqual(killed, [5000]);
  assert.equal(native.get(w.id)?.state, 'stopped');
  assert.equal(listing[0].pid, undefined);
  await native.poll();
  assert.equal(native.get(w.id)?.state, 'stopped', 'a stopped row stays stopped while its process is gone');
  await native.abandon(w.id);
  assert.deepEqual(killed, [5000, 5000]);
  assert.equal(native.get(w.id)?.state, 'abandoned');
  assert.deepEqual(native.rows(), []);
});

test('projectDir names the transcript folder the way Claude Code does, dots included', () => {
  assert.equal(projectDir('/Users/owner/Repos/jarvis'), '-Users-owner-Repos-jarvis');
  assert.equal(projectDir('/Users/owner/Repos/jarvis/.claude/worktrees/x-1'), '-Users-owner-Repos-jarvis--claude-worktrees-x-1');
});

// ---- Stage 2: supervision and resume ----

const argvOf = (s: { argv: string[] }) => s.argv;

test('a dead unfinished terminal is resumed once in its cwd with the stored flags, no -w, and the nudge', async () => {
  const { native, listing, spawns, store, notices, logs } = setupInteractive();
  const w = await native.start({ name: 'dies-410', cwd: '/repo', brief: 'b', model: 'claude-sonnet-5-5', permissionMode: 'default', worktree: true, interactive: true });
  delete listing[0].pid; // the process is gone, the row is still working
  await native.poll();
  assert.equal(spawns.length, 2);
  const a = argvOf(spawns[1]);
  assert.deepEqual(a.slice(0, 9), ['claude', '--resume', ISESSION, '--name', 'dies-410', '--permission-mode', 'default', '--model', 'claude-sonnet-5-5']);
  assert.ok(!a.includes('-w'));
  assert.equal(a[a.length - 1], NUDGE);
  assert.equal(spawns[1].cwd, '/repo/.claude/worktrees/dies-410');
  assert.ok(spawns[1].fifo?.endsWith('dies-410-r1.in'));
  const r = native.get(w.id)!;
  assert.equal(r.state, 'working');
  assert.equal(r.pgid, 5001);
  assert.equal(r.resumes, 1);
  assert.ok(r.last_resume_at);
  assert.equal(r.in_fifo, spawns[1].fifo);
  assert.deepEqual(notices, ['Worker dies-410 was resumed in a new terminal (its terminal died)']);
  const ev = (store.db.prepare(`SELECT kind, body, status FROM items WHERE source = 'native' AND dispatch_id = ?`).all(`${ROW_PREFIX}${w.id}`) as any[]).map(r => ({ ...r }));
  assert.deepEqual(ev, [{ kind: 'event', body: 'Worker dies-410 was resumed in a new terminal (its terminal died)', status: 'done' }]);
  assert.ok(logs.some(l => l.startsWith('native worker died')));
  assert.ok(logs.some(l => l.startsWith('native worker resumed')));
  // Alive again: a second poll resumes nothing.
  await native.poll();
  assert.equal(spawns.length, 2);
});

test('a pid listed on the session refuses the resume; a message after the Desktop handoff takes it back', async () => {
  const s = setupInteractive();
  const w = await s.native.start({ name: 'held-411', cwd: '/repo', brief: 'b', interactive: true });
  // Something else (the desktop app, the owner's own terminal) holds the session: a second writer would branch it.
  delete s.listing[0].pid;
  s.listing.push({ pid: 777, cwd: '/repo', kind: 'interactive', sessionId: ISESSION, name: 'held-411', status: 'idle' });
  await assert.rejects(s.native.resume(w.id, 'test'), /another process \(pid 777\) holds/);
  assert.equal(s.spawns.length, 1);
  // The poll sees a pid on the session, so the row is alive, not dead.
  await s.native.poll();
  assert.equal(s.spawns.length, 1);

  // Desktop, then a message: the daemon ends the desktop-held process before resuming in a pty.
  const t = setupInteractive();
  const killedPids: number[] = [];
  const w2 = await t.native.start({ name: 'desk-412', cwd: '/repo', brief: 'b', interactive: true });
  await t.native.desktop(w2.id);
  assert.equal(t.native.get(w2.id)?.state, 'stopped');
  assert.equal(t.native.get(w2.id)?.waiting_for, 'Open in the Claude desktop app');
  assert.equal(t.native.rows()[0].steer, 'auto', 'a stopped interactive row still takes a message');
  t.listing.push({ pid: 888, cwd: '/repo', kind: 'interactive', sessionId: ISESSION, name: 'desk-412', status: 'idle' });
  const n2 = makeNative({ store: t.store, log: () => {}, jarvisUrl: 'http://x', dataDir: mkdtempSync(join(tmpdir(), 'native-')), onChange: () => {}, onReport: () => {}, onCard: () => {}, onNotice: () => {},
    claude: async (args: string[]) => helpRun(args) ?? (args[0] === 'agents' ? { code: 0, out: JSON.stringify(t.listing), err: '' } : { code: 0, out: JSON.stringify({ type: 'result', result: 'SENT' }), err: '' }),
    mkfifo: () => {}, spawnPty: (argv, cwd, fifo) => { t.spawns.push({ argv, cwd, fifo }); t.listing.push({ pid: 999, pgid: 6000, cwd, kind: 'interactive', sessionId: ISESSION, name: 'desk-412', status: 'busy' }); return 6000; },
    killGroup: () => {}, alivePgid: () => false, killPid: pid => { killedPids.push(pid); for (const a of t.listing) if (a.pid === pid) delete a.pid; } });
  assert.deepEqual(await n2.reply(w2.id, 'back here', 'owner'), { ok: true });
  assert.deepEqual(killedPids, [888]);
  assert.equal(t.spawns.length, 2);
  assert.ok(!argvOf(t.spawns[1]).includes(NUDGE), 'a stopped session was not mid-task: no nudge');
  assert.equal(n2.get(w2.id)?.state, 'working');
  assert.equal(t.listing.filter(a => a.sessionId === ISESSION && a.pid).length, 1, 'never two pids on the session');
});

test('a fourth death in ten minutes fails the row with one notice; a message resumes it once more', async () => {
  const { native, listing, spawns, notices, tick } = setupInteractive();
  const w = await native.start({ name: 'loop-413', cwd: '/repo', brief: 'b', interactive: true });
  for (let i = 0; i < 3; i++) { for (const a of listing) delete a.pid; await native.poll(); tick(60_000); }
  assert.equal(spawns.length, 4);
  assert.equal(native.get(w.id)?.resumes, 3);
  for (const a of listing) delete a.pid;
  await native.poll();
  await native.poll();
  assert.equal(spawns.length, 4, 'no fourth resume');
  const r = native.get(w.id)!;
  assert.equal(r.state, 'failed');
  assert.equal(r.outcome, null);
  assert.match(r.waiting_for!, /Died 3 times in 10 minutes/);
  assert.equal(native.rows()[0].note, r.waiting_for);
  assert.equal(notices.filter(n => /died 3 times/.test(n)).length, 1);
  assert.equal(notices.filter(n => /^Worker loop-413 failed$/.test(n)).length, 0, 'the generic failed notice does not double it');
  // A reply forces a resume.
  assert.deepEqual(await native.reply(w.id, 'try again', 'owner'), { ok: true });
  assert.equal(spawns.length, 5);
  assert.equal(native.get(w.id)?.state, 'working');
  assert.equal(native.get(w.id)?.waiting_for, null);
  // After the window the count resets.
  const s2 = setupInteractive();
  await s2.native.start({ name: 'slow-414', cwd: '/repo', brief: 'b', interactive: true });
  for (let i = 0; i < 4; i++) { for (const a of s2.listing) delete a.pid; await s2.native.poll(); s2.tick(11 * 60_000); }
  assert.equal(s2.spawns.length, 5);
});

test('a done or stopped session is not resumed on its own, and a message resumes it without the nudge', async () => {
  const { native, listing, spawns, notices } = setupInteractive();
  const w = await native.start({ name: 'fin-415', cwd: '/repo', brief: 'b', interactive: true });
  native.stopHook({ session_id: ISESSION, last_assistant_message: 'DONE: finished' });
  for (const a of listing) delete a.pid;
  await native.poll();
  assert.equal(spawns.length, 1, 'a finished worker whose process ended is left alone');
  assert.equal(native.get(w.id)?.state, 'done');
  assert.deepEqual(await native.reply(w.id, 'one more thing', 'jarvis'), { ok: true });
  assert.equal(spawns.length, 2);
  assert.ok(!argvOf(spawns[1]).includes(NUDGE));
  assert.equal(argvOf(spawns[1])[argvOf(spawns[1]).length - 1], '--settings' === argvOf(spawns[1])[argvOf(spawns[1]).length - 2] ? argvOf(spawns[1])[argvOf(spawns[1]).length - 1] : argvOf(spawns[1])[argvOf(spawns[1]).length - 1]);
  assert.deepEqual(notices, [], 'a resume for a message is not a finding for the brain');
  // The stop Jarvis made stays stopped too.
  await native.stop(w.id);
  for (const a of listing) delete a.pid;
  await native.poll();
  assert.equal(spawns.length, 2);
  assert.equal(native.get(w.id)?.state, 'stopped');
});

test('recover keeps a live row, resumes a dead unfinished one, re-prompts one stuck on a lost card, and reads a lost DONE from the transcript', async () => {
  const { native, listing, spawns, store, reports, logs, cards } = setupInteractive();
  // Three workers on three sessions: the fake lists by the argv name, so give each its own session id through --resume-free starts.
  const w1 = await native.start({ name: 'alive-416', cwd: '/repo', brief: 'b', interactive: true });
  const w2 = await native.start({ name: 'dead-417', cwd: '/repo', brief: 'b', interactive: true });
  const w3 = await native.start({ name: 'stuck-418', cwd: '/repo', brief: 'b', interactive: true });
  // w2 died; w3 is blocked on a card jarvisd held; w1 finished while jarvisd was down and its hook was lost.
  delete listing[1].pid;
  void native.permissionRequest({ session_id: listing[2].sessionId, tool_name: 'Bash', tool_input: { command: 'x' } });
  assert.equal(native.get(w3.id)?.state, 'blocked');
  const dir = mkdtempSync(join(tmpdir(), 'jsonl-'));
  const file = join(dir, 'alive.jsonl');
  writeFileSync(file, [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'do it' } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Working on it.' }] } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: {} }] } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'DONE: all three files written\n\nbranch x' }] } }),
  ].join('\n') + '\n');
  store.updateNativeWorker(w1.id, { transcript: file });
  listing[0].status = 'idle';
  const before = spawns.length;
  await native.recover();
  // w1: alive, state kept, report recovered word for word.
  const r1 = native.get(w1.id)!;
  assert.equal(r1.outcome, 'done');
  assert.equal(r1.state, 'done');
  assert.equal(r1.report, 'DONE: all three files written\n\nbranch x');
  assert.deepEqual(reports.at(-1), ['DONE: all three files written\n\nbranch x', true]);
  // w2: resumed with the nudge.
  const s2 = spawns.slice(before).find(s => s.argv.includes(listing[1].sessionId))!;
  assert.ok(s2, 'the dead one was resumed');
  assert.equal(s2.argv.at(-1), NUDGE);
  assert.equal(native.get(w2.id)?.state, 'working');
  // w3: its card failed, its group killed, resumed with the nudge.
  assert.equal(store.approval(cards[0].id)?.status, 'failed');
  const s3 = spawns.slice(before).find(s => s.argv.includes(listing[2].sessionId))!;
  assert.ok(s3, 'the stuck one was resumed');
  assert.equal(s3.argv.at(-1), NUDGE);
  assert.equal(native.get(w3.id)?.state, 'working');
  assert.ok(logs.some(l => l.startsWith('native: recovered') && l.includes('"alive":1') && l.includes('"resuming":2') && l.includes('"reportsFromTranscripts":1')));
  // A second recover changes nothing: the report is the stored one already.
  const n = reports.length;
  await native.recover();
  assert.equal(reports.length, n);
});

test('the poll recovers a lost DONE instead of calling the turn silent', async () => {
  const { native, listing, store, notices, reports, tick } = setupInteractive();
  const w = await native.start({ name: 'quiet-419', cwd: '/repo', brief: 'b', interactive: true });
  native.stopHook({ session_id: ISESSION, last_assistant_message: 'Looking into it.' });
  const file = join(mkdtempSync(join(tmpdir(), 'jsonl-')), 's.jsonl');
  writeFileSync(file, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'DONE: it is fixed' }] } }) + '\n');
  store.updateNativeWorker(w.id, { transcript: file });
  listing[0].status = 'idle';
  tick(SILENT_DONE_MS);
  await native.poll();
  assert.equal(native.get(w.id)?.outcome, 'done');
  assert.equal(native.get(w.id)?.report, 'DONE: it is fixed');
  assert.deepEqual(reports.at(-1), ['DONE: it is fixed', true]);
  assert.deepEqual(notices, []);
});

test('the reaper ends a finished session idle for an hour, not a busy one, and a message resumes it', async () => {
  const { native, listing, killed, spawns, tick, store } = setupInteractive();
  const w = await native.start({ name: 'idle-420', cwd: '/repo', brief: 'b', interactive: true });
  native.stopHook({ session_id: ISESSION, last_assistant_message: 'DONE: finished' });
  listing[0].status = 'idle';
  await native.poll();
  tick(IDLE_REAP_MS - 1);
  await native.poll();
  assert.deepEqual(killed, [], 'not before the hour');
  tick(2);
  await native.poll();
  assert.deepEqual(killed, [5000]);
  const r = native.get(w.id)!;
  assert.equal(r.state, 'stopped');
  assert.equal(r.waiting_for, 'Idle, resumes on a message');
  assert.equal(native.rows()[0].note, 'Idle, resumes on a message');
  assert.equal(native.rows()[0].steer, 'auto');
  await native.poll();
  assert.equal(native.get(w.id)?.state, 'stopped', 'stays stopped while its process is gone');
  assert.deepEqual(await native.reply(w.id, 'more', 'owner'), { ok: true });
  assert.equal(spawns.length, 2);
  assert.equal(native.get(w.id)?.state, 'working');

  // Busy, or idle with no outcome and no open ask: never reaped.
  const s2 = setupInteractive();
  const w2 = await s2.native.start({ name: 'busy-421', cwd: '/repo', brief: 'b', interactive: true });
  await s2.native.poll(); s2.tick(IDLE_REAP_MS + 1); await s2.native.poll();
  assert.deepEqual(s2.killed, []);
  s2.listing[0].status = 'idle';
  await s2.native.poll(); s2.tick(IDLE_REAP_MS + 1); await s2.native.poll();
  assert.deepEqual(s2.killed, [], 'idle without a report or an ask is a silent turn, not a finished one');
  // Waiting on an ask counts as finished for the reaper.
  s2.store.insertItem({ source: 'native', external_id: `ask:${w2.id}:1`, kind: 'question', dispatch_id: `${ROW_PREFIX}${w2.id}`, body: 'apple or pear?', status: 'spoken' });
  await s2.native.poll(); s2.tick(IDLE_REAP_MS + 1); await s2.native.poll();
  assert.deepEqual(s2.killed, [5000]);
  void store;
});

test('a done session that turns busy with no new turn (a resume, a compaction) is done again once idle', async () => {
  // 5276-keep-the-muse-digest (2026-11-09): reported DONE, went busy for a compaction, and stayed "working" in Stories.
  const { native, listing } = setupInteractive();
  const w = await native.start({ name: 'muse-463', cwd: '/repo', brief: 'b', interactive: true });
  native.stopHook({ session_id: ISESSION, last_assistant_message: 'DONE: PR #5297 is READY.' });
  listing[0].status = 'busy';
  await native.poll();
  assert.equal(native.get(w.id)?.state, 'working');
  listing[0].status = 'idle';
  await native.poll();
  assert.equal(native.get(w.id)?.state, 'done');
  assert.equal(native.rows()[0].state, 'idle');

  // A turn after the DONE that ends without DONE or FAILED is new work in progress: idle does not call it done.
  listing[0].status = 'busy';
  await native.poll();
  native.stopHook({ session_id: ISESSION, last_assistant_message: 'Waiting for CI on the new head.' });
  listing[0].status = 'idle';
  await native.poll();
  assert.equal(native.get(w.id)?.state, 'working');
});

// ---- Stage 3: typing into the session ----

test('typedBytes wraps the text in a bracketed paste and ends with a carriage return; escapes are dropped', () => {
  assert.equal(typedBytes('apple').toString('latin1'), '\x1b[200~apple\x1b[201~\r');
  assert.equal(typedBytes('line one\r\nline two\rthree').toString('latin1'), '\x1b[200~line one\nline two\nthree\x1b[201~\r');
  assert.equal(typedBytes('no \x1b[201~ early end').toString('latin1'), '\x1b[200~no [201~ early end\x1b[201~\r');
  assert.equal(typedBytes('é ✓').toString('utf8'), '\x1b[200~é ✓\x1b[201~\r');
});

test('a reply to an interactive worker is typed into its pipe, verbatim, with the item recorded; the relay is the fallback', async () => {
  const typed: { fifo: string; bytes: Buffer }[] = [];
  let fail: string | undefined;
  const store = openStore(':memory:');
  const listing: any[] = [];
  const calls: string[][] = [];
  const logs: string[] = [];
  const native = makeNative({
    store, log: (m, f) => logs.push(`${m} ${JSON.stringify(f ?? {})}`), jarvisUrl: 'http://x', dataDir: mkdtempSync(join(tmpdir(), 'native-')),
    onChange: () => {}, onReport: () => {}, onCard: () => {}, onNotice: () => {},
    claude: async (args: string[]) => { calls.push(args); const help = helpRun(args); if (help) return help; return args[0] === 'agents' ? { code: 0, out: JSON.stringify(listing), err: '' } : args[0] === '-p' ? { code: 0, out: JSON.stringify({ type: 'result', result: 'SENT' }), err: '' } : { code: 0, out: '2.1.316', err: '' }; },
    mkfifo: () => {}, alivePgid: () => true, killGroup: () => {},
    spawnPty: (argv, cwd, fifo) => { listing.push({ pid: 11, cwd, kind: 'interactive', sessionId: ISESSION, name: argv[2], status: 'idle' }); return 10; },
    writeFifo: (fifo, bytes) => { if (fail) { const e: any = new Error(fail); e.code = fail; throw e; } typed.push({ fifo, bytes }); },
  });
  const w = await native.start({ name: 'typed-430', cwd: '/repo', brief: 'b', interactive: true });
  assert.deepEqual(await native.reply(`${ROW_PREFIX}${w.id}`, 'apple\nnot pear', 'owner'), { ok: true });
  assert.equal(typed.length, 1);
  assert.equal(typed[0].fifo, w.in_fifo);
  assert.equal(typed[0].bytes.toString('latin1'), '\x1b[200~apple\nnot pear\x1b[201~\r');
  assert.ok(!calls.some(c => c[0] === '-p'), 'no relay session was started');
  let items = store.db.prepare(`SELECT kind, body, answered_by FROM items WHERE source = 'native' ORDER BY id`).all() as any[];
  assert.equal(items.length, 1);
  assert.equal(items[0].body, 'apple\nnot pear');
  assert.equal(items[0].answered_by, null);
  assert.ok(logs.some(l => l.startsWith('native reply {') && l.includes('"via":"terminal"')));

  // The pipe has no reader: the relay carries it, and the item is still recorded once.
  fail = 'ENXIO';
  assert.deepEqual(await native.reply(w.id, 'pear then', 'jarvis'), { ok: true });
  assert.equal(typed.length, 1);
  const relay = calls.find(c => c[0] === '-p')!;
  assert.match(relay[relay.length - 1], /<<<\npear then\n>>>/);
  items = store.db.prepare(`SELECT kind, body, answered_by FROM items WHERE source = 'native' ORDER BY id`).all() as any[];
  assert.equal(items.length, 2);
  assert.equal(items[1].answered_by, 'jarvis');
  assert.ok(logs.some(l => l.startsWith('native reply: typing into the terminal failed') && l.includes('"error":"ENXIO"')));
  assert.ok(logs.some(l => l.startsWith('native reply {') && l.includes('"via":"relay"')));
});

test('a session waiting at a permission prompt with no card held is ended and resumed after two polls; one with a held card is left alone', async () => {
  const { native, listing, spawns, killed, logs, cards } = setupInteractive();
  const w = await native.start({ name: 'prompt-440', cwd: '/repo', brief: 'b', interactive: true });
  // The hook is held: the listing says waiting on a permission prompt, and that is fine.
  void native.permissionRequest({ session_id: ISESSION, tool_name: 'Bash', tool_input: { command: 'touch a' } });
  listing[0].status = 'waiting'; listing[0].waitingFor = 'permission prompt';
  await native.poll(); await native.poll(); await native.poll();
  assert.equal(spawns.length, 1);
  assert.deepEqual(killed, []);
  assert.equal(native.get(w.id)?.state, 'blocked');
  // The card is gone (a restart failed it) but the session still waits at its own prompt: ended and resumed with the nudge.
  native.decide(cards[0].id, true);
  await native.poll();
  assert.equal(spawns.length, 1, 'the first sighting only notes it');
  await native.poll();
  assert.equal(spawns.length, 2);
  assert.deepEqual(killed, [5000]);
  assert.equal(spawns[1].argv.at(-1), NUDGE);
  assert.equal(native.get(w.id)?.state, 'working');
  assert.ok(logs.some(l => l.startsWith('native worker stuck at a prompt jarvisd cannot answer')));
  // Alive again and busy: nothing more.
  await native.poll(); await native.poll();
  assert.equal(spawns.length, 2);
});

test('a session in the desktop app stays stopped through the polls, so a later message still takes it back', async () => {
  const { native, listing, spawns, tick } = setupInteractive();
  const w = await native.start({ name: 'desk-450', cwd: '/repo', brief: 'b', interactive: true });
  await native.desktop(w.id);
  listing.push({ pid: 777, cwd: '/repo', kind: 'interactive', sessionId: ISESSION, name: 'desk-450', status: 'busy' });
  for (let i = 0; i < 3; i++) { tick(30_000); await native.poll(); }
  const r = native.get(w.id)!;
  assert.equal(r.state, 'stopped');
  assert.equal(r.waiting_for, 'Open in the Claude desktop app');
  assert.equal(spawns.length, 1, 'the desktop-held session is not treated as dead');
});

// ---- The work list's sections and stale rows (2026-11-09) ----

test('a story worker sorts by its approved task title, not by its name, which drops the "#"', async () => {
  const { native, store } = setupInteractive();
  const a = store.addApproval({ action: 'worker-start', say: 'Start?', args: JSON.stringify({ taskTitle: '#4886 Check the price Facebook kept on a widget update', spec: 'Run pick-and-ship on issue #4886.' }) });
  await native.start({ name: '4886-check-the-price-facebook-kept-on-a--443', cwd: '/repo', brief: 'b', interactive: true, approvalId: a.id });
  const r = native.rows()[0];
  assert.equal(r.group, 'story');
  assert.equal(r.label, '#4886');
  assert.equal(r.title, '4886-check-the-price-facebook-kept-on-a--443', 'the title stays the name');

  // No story in the title: Other. No start card at all (a session continued on the phone): the name decides.
  const s2 = setupInteractive();
  const b = s2.store.addApproval({ action: 'worker-start', say: 'Start?', args: JSON.stringify({ taskTitle: 'Teal and mint app theme' }) });
  await s2.native.start({ name: 'teal-and-mint-app-theme-420', cwd: '/repo', brief: 'b', interactive: true, approvalId: b.id });
  assert.equal(s2.native.rows()[0].group, 'other');
  const s3 = setupInteractive();
  await s3.native.start({ name: 'issue-4412-fix', cwd: '/repo', brief: 'b', interactive: true });
  assert.equal(s3.native.rows()[0].label, '#4412');
});

test('a worker the reaper stopped while it waits on an ask is waiting, not exited, so its request never reads failed', async () => {
  const { native, listing, tick, store } = setupInteractive();
  const w = await native.start({ name: '4886-check-443', cwd: '/repo', brief: 'b', interactive: true });
  native.stopHook({ session_id: ISESSION, last_assistant_message: 'STORY: #4886\nQUESTION: How do I test it?' });
  store.insertItem({ source: 'native', external_id: `ask:${w.id}:1`, kind: 'question', dispatch_id: `${ROW_PREFIX}${w.id}`, subject: 'How do I test it?', body: 'b', status: 'spoken' });
  listing[0].status = 'idle';
  await native.poll(); tick(IDLE_REAP_MS + 1); await native.poll();
  assert.equal(native.get(w.id)?.state, 'stopped', 'reaped');
  const r = native.rows()[0];
  assert.equal(r.state, 'waiting');
  assert.equal(r.note, 'How do I test it?');
  assert.equal(r.endedAt, undefined, 'an open ask keeps it out of the Done fold');
  // The request layer reads the row as waiting on the owner, never failed.
  assert.equal(statusOf(r, undefined, true, null, undefined, false), 'waiting');
  tick(25 * 3_600_000);
  assert.equal(native.rows().length, 1, 'and in the list while the ask is open');
});

test('rowState maps each native state to the work list', () => {
  assert.equal(rowState({ state: 'stopped', waiting_for: IDLE_STOPPED }, false), 'idle');
  assert.equal(rowState({ state: 'stopped', waiting_for: IDLE_STOPPED }, true), 'waiting');
  assert.equal(rowState({ state: 'stopped', waiting_for: DESKTOP_WAITING }, false), 'idle');
  assert.equal(rowState({ state: 'stopped', waiting_for: null }, false), 'exited');
  assert.equal(rowState({ state: 'failed', waiting_for: null }, true), 'exited');
  assert.equal(rowState({ state: 'done', waiting_for: null }, false), 'idle');
  assert.equal(rowState({ state: 'done', waiting_for: null }, true), 'waiting');
  assert.equal(rowState({ state: 'working', waiting_for: null }, false), 'working');
  assert.equal(rowState({ state: 'blocked', waiting_for: 'x' }, false), 'waiting');
});

test('a finished row leaves a day after its report, not a day after the reaper stopped it', async () => {
  const { native, listing, tick } = setupInteractive();
  const w = await native.start({ name: 'chat-approve-433', cwd: '/repo', brief: 'b', interactive: true });
  native.stopHook({ session_id: ISESSION, last_assistant_message: 'DONE: shipped' });
  const reportAt = native.get(w.id)!.report_at!;
  listing[0].status = 'idle';
  await native.poll(); tick(IDLE_REAP_MS + 1); await native.poll();
  assert.equal(native.get(w.id)?.state, 'stopped');
  assert.equal(native.rows()[0].endedAt, reportAt, 'its finish time is the report, not the reap');
  assert.equal(finishedAt(native.get(w.id)!), Date.parse(reportAt));
  // The request leaves DONE_KEEP_MS after it turned done, which follows the report. The row must not outlive it.
  tick(24 * 3_600_000 - IDLE_REAP_MS);
  assert.deepEqual(native.rows(), [], 'gone a day after the report, before its request leaves Completed');
});

test('missingFeatures: the real Claude Code help has everything the driver runs, and a missing piece is named', () => {
  assert.deepEqual(missingFeatures(CLAUDE_HELP, AGENTS_HELP), []);
  // A description that only mentions a flag does not count as having it.
  const noBg = CLAUDE_HELP.replace(/^  --bg, --background/m, '  --background      ');
  assert.deepEqual(missingFeatures(noBg, AGENTS_HELP), ['the --bg option']);
  const noRespawn = CLAUDE_HELP.replace(/^  respawn \[options\] \[id\]/m, '  respawnx');
  assert.deepEqual(missingFeatures(noRespawn, AGENTS_HELP), ['the claude respawn command']);
  assert.deepEqual(missingFeatures(CLAUDE_HELP, AGENTS_HELP.replace(/^  --json/m, '  --jsonl')), ['the claude agents --json option']);
  // A longer option with the same start is not the option.
  assert.deepEqual(missingFeatures(CLAUDE_HELP.replace(/^  --remote-control \[name\]/m, '  --remote-controlx'), AGENTS_HELP), ['the --remote-control option']);
});

test('start works on any version that has the features, with no warning, and fails with the missing feature named', async () => {
  for (const version of ['2.1.316 (Claude Code)', '2.4.0 (Claude Code)']) {
    const { fake } = setup();
    const logs: string[] = [];
    const inner = fake.claude;
    const claude = async (args: string[]) => args[0] === '--version' ? { code: 0, out: `${version}\n`, err: '' } : inner(args);
    const n = makeNative({ store: openStore(':memory:'), log: (m, f) => logs.push(`${m} ${JSON.stringify(f ?? {})}`), jarvisUrl: 'http://x', dataDir: mkdtempSync(join(tmpdir(), 'native-')), onChange: () => {}, onReport: () => {}, onCard: () => {}, onNotice: () => {}, claude });
    await n.start({ name: 'probe-7', cwd: '/repo', brief: 'b' });
    assert.ok(logs.some(l => l.startsWith('native: claude has what the driver needs') && l.includes(version)), version);
    assert.ok(!logs.some(l => /differs|pinned|lacks/.test(l)), version);
  }
  const calls: string[][] = [];
  let help = CLAUDE_HELP.replace(/^  --bg, --background/m, '  --background      ');
  const claude = async (args: string[]) => { calls.push(args); return args[0] === '--help' ? { code: 0, out: help, err: '' } : helpRun(args) ?? { code: 0, out: '9.0.0 (Claude Code)', err: '' }; };
  const n = makeNative({ store: openStore(':memory:'), log: () => {}, jarvisUrl: 'http://x', dataDir: mkdtempSync(join(tmpdir(), 'native-')), onChange: () => {}, onReport: () => {}, onCard: () => {}, onNotice: () => {}, claude });
  await assert.rejects(n.start({ name: 'p', cwd: '/x', brief: 'b' }), /Claude Code 9\.0\.0 \(Claude Code\) lacks the --bg option, which Jarvis's native workers need\. Update Claude Code/);
  assert.ok(!calls.some(a => a.includes('--bg')), 'nothing started');
  // Only a pass is remembered: after an update the next start checks again and goes on.
  help = CLAUDE_HELP;
  await assert.rejects(n.start({ name: 'p', cwd: '/x', brief: 'b' }), /claude --bg did not start/);
  assert.equal(calls.filter(a => a[0] === '--help').length, 2);
});

test('start says so when claude --help cannot be read', async () => {
  const claude = async () => ({ code: 127, out: '', err: 'command not found' });
  const n = makeNative({ store: openStore(':memory:'), log: () => {}, jarvisUrl: 'http://x', dataDir: mkdtempSync(join(tmpdir(), 'native-')), onChange: () => {}, onReport: () => {}, onCard: () => {}, onNotice: () => {}, claude });
  await assert.rejects(n.start({ name: 'p', cwd: '/x', brief: 'b' }), /could not read `claude --help` \(exit 127\)/);
});

/** A worker transcript: a prompt, then the assistant lines given, each a list of content blocks. */
function transcriptWith(...assistant: any[][]): string {
  const f = join(mkdtempSync(join(tmpdir(), 'turn-')), 's.jsonl');
  const lines = [{ type: 'user', message: { role: 'user', content: 'Do the task.' } },
    ...assistant.flatMap((content, i) => [{ type: 'assistant', message: { role: 'assistant', content } }, { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: 'ok' }] } }])];
  writeFileSync(f, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return f;
}
const send = (to: string, message: string) => ({ type: 'tool_use', id: 'x', name: 'SendMessage', input: { to, message } });

test('lastTurnMessages: what the last turn sent to a session, from the last prompt on', () => {
  const f = transcriptWith([send('jarvis-brain', 'STORY: 1\nQUESTION: a?\nOPTIONS: x because y')], [send('other', 'hi')], [{ type: 'text', text: 'Asked.' }]);
  assert.deepEqual(lastTurnMessages(f, 'jarvis-brain'), ['STORY: 1\nQUESTION: a?\nOPTIONS: x because y']);
  // A new prompt (here a cross-session reply) starts a new turn; a meta line (a system reminder) does not.
  writeFileSync(f, `${JSON.stringify({ type: 'user', isMeta: true, message: { role: 'user', content: '<system-reminder>x</system-reminder>' } })}\n`, { flag: 'a' });
  assert.equal(lastTurnMessages(f, 'jarvis-brain').length, 1);
  writeFileSync(f, `${JSON.stringify({ type: 'user', isMeta: true, turnOrigin: 'peer', message: { role: 'user', content: 'green' } })}\n`, { flag: 'a' });
  assert.deepEqual(lastTurnMessages(f, 'jarvis-brain'), []);
});

test('a turn with no report line is sent back once; its answer with DONE is the report, with no notice', async () => {
  const { native, reports, notices, logs } = setup();
  await native.start({ name: 'question-386', cwd: '/repo', brief: 'b' });
  assert.deepEqual(native.stopHook({ session_id: SESSION, stop_hook_active: false, last_assistant_message: 'bin/jarvis-native is a small Node tool.' }), { decision: 'block', reason: REPORT_NUDGE });
  assert.ok(logs.some(l => l.includes('"sentBack":true')));
  assert.deepEqual(native.stopHook({ session_id: SESSION, stop_hook_active: true, last_assistant_message: 'DONE: answered\n\nbin/jarvis-native is a small Node tool.' }), {});
  const w = native.get('deabc023')!;
  assert.equal(w.outcome, 'done');
  assert.equal(w.report, 'DONE: answered\n\nbin/jarvis-native is a small Node tool.');
  assert.deepEqual(reports.map(r => r[1]), [false, true]);
  assert.deepEqual(notices, []);
  // The nudge names the three ways out and keeps the DONE line the spec asks for.
  assert.match(REPORT_NUDGE, /`DONE: <one sentence>`/);
  assert.match(REPORT_NUDGE, /`WAITING:`/);
  assert.match(REPORT_NUDGE, /SendMessage/);
});

test('a pause is quiet: a WAITING line, an ask to the brain, a background task, a scheduled wake-up, a side chat', async () => {
  const cases: [string, (s: ReturnType<typeof setup>) => Promise<any>][] = [
    ['waiting line', async () => ({ last_assistant_message: 'WAITING: CI on the head commit' })],
    ['ask to the brain', async () => ({ last_assistant_message: 'Asked Jarvis.', transcript_path: transcriptWith([send('jarvis-brain', 'STORY: 386\nQUESTION: Which one?\nOPTIONS: A because b')]) })],
    ['background task', async () => ({ last_assistant_message: 'The wait checks every 30 seconds.', background_tasks: [{ id: 'b1', type: 'shell', status: 'running', description: 'wait for CI', command: 'sleep 25' }] })],
    ['scheduled wake-up', async () => ({ last_assistant_message: 'Next wave in 20 minutes.', session_crons: [{ id: 'c1' }] })],
    ['conversation', async s => { const a = s.store.addApproval({ action: 'side-chat', args: '{}', say: '' }); s.store.updateNativeWorker('deabc023', { approval_id: a.id }); return { last_assistant_message: 'Sure, what next?' }; }],
  ];
  for (const [name, body] of cases) {
    const s = setup();
    await s.native.start({ name: 'probe-7', cwd: '/repo', brief: 'b' });
    const extra = await body(s);
    assert.deepEqual(s.native.stopHook({ session_id: SESSION, stop_hook_active: false, ...extra }), {}, name);
    assert.deepEqual(s.notices, [], name);
    assert.ok(s.logs.some(l => l.startsWith('native worker reported') && l.includes('"pause":')), name);
    // The two-minute backstop stays quiet for it too.
    s.fake.agent.state = 'done'; delete s.fake.agent.pid;
    s.tick(SILENT_DONE_MS);
    await s.native.poll();
    assert.deepEqual(s.notices, [], `${name}: backstop`);
  }
  // A NOTICE to the brain is not an ask: that turn is still sent back.
  const s = setup();
  await s.native.start({ name: 'probe-7', cwd: '/repo', brief: 'b' });
  assert.deepEqual(s.native.stopHook({ session_id: SESSION, last_assistant_message: 'Pushed.', transcript_path: transcriptWith([send('jarvis-brain', 'NOTICE: CI runs now')]) }), { decision: 'block', reason: REPORT_NUDGE });
  // A finished background task is not pending.
  const s2 = setup();
  await s2.native.start({ name: 'probe-7', cwd: '/repo', brief: 'b' });
  assert.equal((s2.native.stopHook({ session_id: SESSION, last_assistant_message: 'ok', background_tasks: [{ id: 'b1', status: 'completed' }] }) as any).decision, 'block');
});

test('the backstop and the told state survive a jarvisd restart, so the notice is not repeated', async () => {
  const s = setup();
  await s.native.start({ name: 'probe-7', cwd: '/repo', brief: 'b' });
  s.native.stopHook({ session_id: SESSION, stop_hook_active: false, last_assistant_message: 'Hmm.' });
  s.native.stopHook({ session_id: SESSION, stop_hook_active: true, last_assistant_message: 'Hmm again.' });
  assert.equal(s.notices.length, 1);
  // A new daemon on the same database: its poll does not tell the brain a second time.
  const notices: string[] = [];
  const n2 = makeNative({ store: s.store, log: () => {}, jarvisUrl: 'http://x', dataDir: mkdtempSync(join(tmpdir(), 'native-')), onChange: () => {}, onReport: () => {}, onCard: () => {}, onNotice: (_w, t) => notices.push(t), claude: s.fake.claude, now: () => 1_800_000_000_000 + SILENT_DONE_MS * 2 });
  s.fake.agent.state = 'done'; delete s.fake.agent.pid;
  await n2.poll();
  assert.deepEqual(notices, []);
});

test('a worker is sent back at most three times in ten minutes, whatever the hook body says', async () => {
  const s = setup();
  await s.native.start({ name: 'probe-7', cwd: '/repo', brief: 'b' });
  const blocks = [1, 2, 3, 4].map(() => (s.native.stopHook({ session_id: SESSION, stop_hook_active: false, last_assistant_message: 'no line' }) as any).decision);
  assert.deepEqual(blocks, ['block', 'block', 'block', undefined]);
  assert.equal(s.notices.length, 1, 'the fourth is told at once');
});
