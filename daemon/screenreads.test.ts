import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from './store.ts';
import { helpRun } from './fakeclaude.ts';
import { makeNative, workerSettings, typedText, START_READ_MS, QUIET_READ_MS } from './native.ts';
import { nativeRoute } from './nativeroutes.ts';
import type { WorkerTmux } from './screen.ts';

// The screen reads of a native worker in tmux (native.ts readScreen): each trigger, what a read sets, and that a read
// without a known prompt changes nothing. A fake tmux stands in, so the clock can move; screen.test.ts runs the real one.

const FIX = join(fileURLToPath(import.meta.url), '..', 'fixtures');
const TRUST = readFileSync(join(FIX, 'screen-trust.txt'), 'utf8');
const IDLE = '⏺ Done.\n\n────\n❯ \n────\n  ? for shortcuts';
const RUNNING_SILENT = '⏺ Bash(npm test)\n  ⎿  Running…\n✻ Testing… (5m 2s · esc to interrupt)\n────\n❯ \n────';
const LOGIN_ERROR = '⏺ API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired."}} · Please run /login\n────\n❯ \n────';
const SID = '00000000-0000-4000-8000-0000000000aa';

function setup(o: { listed?: boolean } = {}) {
  const store = openStore(':memory:');
  const listing: any[] = [];
  let t = 1_800_000_000_000, autoTick = 0, wrote = 0;
  const screens = new Map<string, string>();
  const starts: { argv: string[]; cwd: string; session: string; lastFile: string }[] = [], typed: { session: string; text: string }[] = [], captures: string[] = [];
  const killed: number[] = [];
  let pid = 7000;
  const wt: WorkerTmux = {
    start(argv, cwd, session, lastFile) {
      starts.push({ argv, cwd, session, lastFile });
      const p = pid++;
      const resume = argv.indexOf('--resume');
      if (o.listed !== false) listing.push({ pid: p, pgid: p, cwd, kind: 'interactive', sessionId: resume >= 0 ? argv[resume + 1] : SID, name: argv[argv.indexOf('--name') + 1], status: 'busy' });
      screens.set(session, IDLE);
      return p;
    },
    async type(session, text) { typed.push({ session, text }); },
    async capture(session) { captures.push(session); const s = screens.get(session); if (s === undefined) throw new Error(`can't find session: ${session}`); return s; },
  };
  const claude = async (args: string[]) => {
    const help = helpRun(args); if (help) return help;
    if (args[0] === '--version') return { code: 0, out: '2.1.322 (Claude Code)\n', err: '' };
    if (args[0] === 'agents') { t += autoTick; return { code: 0, out: JSON.stringify(listing), err: '' }; }
    return { code: 0, out: '', err: '' };
  };
  const logs: [string, any][] = [], notices: string[] = [];
  const native = makeNative({
    store, log: (m, f) => logs.push([m, f]), jarvisUrl: 'http://127.0.0.1:7788', dataDir: mkdtempSync(join(tmpdir(), 'screenreads-')),
    onChange: () => {}, onReport: () => {}, onCard: () => {}, onNotice: (_w, text) => notices.push(text),
    claude, now: () => t, workerTmux: wt, alivePgid: p => listing.some(a => a.pgid === p && a.pid) || !killed.includes(p),
    killGroup: p => { killed.push(p); for (const a of listing) if (a.pgid === p) delete a.pid; }, written: () => { if (!wrote) throw new Error('none'); return wrote; },
  });
  const reads = () => logs.filter(l => l[0] === 'native screen read').map(l => l[1]);
  return { store, native, listing, screens, starts, typed, captures, killed, logs, notices, reads,
    tick: (ms: number) => { t += ms; }, now: () => t, autoTick: (ms: number) => { autoTick = ms; }, write: (at: number) => { wrote = at; } };
}
const start = (n: ReturnType<typeof setup>['native']) => n.start({ name: 'story-501', cwd: '/repo', brief: 'do the story', interactive: true, worktree: true });

test('the worker settings send the prompt and notification hooks that the screen reads need', () => {
  const s: any = workerSettings('http://127.0.0.1:7788');
  assert.equal(s.hooks.UserPromptSubmit[0].hooks[0].url, 'http://127.0.0.1:7788/api/hooks/prompt');
  assert.equal(s.hooks.Notification[0].hooks[0].url, 'http://127.0.0.1:7788/api/hooks/notification');
});

test('an interactive worker starts in tmux: its session, no pipe, the brief as the last item, a status on its row', async () => {
  const s = setup();
  const w = await start(s.native);
  assert.equal(s.starts.length, 1);
  assert.equal(s.starts[0].session, 'story-501-r0');
  assert.equal(s.starts[0].argv.at(-1), 'do the story');
  assert.match(s.starts[0].lastFile, /pty\/story-501-r0\.arg$/);
  assert.equal(w.tmux, 'story-501-r0');
  assert.equal(w.in_fifo, null);
  const [r] = s.native.rows();
  assert.deepEqual(r.status, { name: 'working' });
  assert.deepEqual(r.native?.tmux, { session: 'story-501-r0', attach: 'tmux -L jarvis-workers attach -t story-501-r0' });
  assert.equal(s.reads().length, 0, 'a start that is listed reads nothing');
});

test('a start held at the trust prompt keeps its row, blocked: trust prompt, tells the brain once, and binds when it passes', async () => {
  const s = setup({ listed: false });
  s.screens.set('story-501-r0', TRUST);
  s.autoTick(15_000);
  const startP = start(s.native);
  // The fake session shows the trust screen as soon as it starts; the start reads it after the listing wait.
  setTimeout(() => s.screens.set('story-501-r0', TRUST), 0);
  const w = await startP;
  s.autoTick(0);
  assert.equal(w.session_id, null);
  assert.equal(w.block, 'trust prompt');
  const [r] = s.native.rows();
  assert.deepEqual(r.status, { name: 'blocked', reason: 'trust prompt' });
  assert.equal(r.state, 'waiting');
  assert.equal(r.note, 'Blocked: trust prompt');
  assert.equal(s.notices.length, 1);
  assert.match(s.notices[0], /^Worker story-501 is blocked: trust prompt\. .*tmux -L jarvis-workers attach -t story-501-r0$/);
  assert.match(s.reads()[0].why, /^not listed 30 s after its start$/);
  assert.equal(s.killed.length, 0, 'the session waits for the owner, it is not ended');
  // Polls while it waits: no resume (it has no session), no second notice.
  await s.native.poll(); await s.native.poll();
  assert.equal(s.notices.length, 1);
  assert.equal(s.starts.length, 1);
  // The owner trusts the folder in the terminal: the listing names it, the poll binds it and the block ends.
  s.listing.push({ pid: 7000, pgid: 7000, cwd: '/repo/.claude/worktrees/story-501', kind: 'interactive', sessionId: SID, name: 'story-501', status: 'busy' });
  await s.native.poll();
  const bound = s.native.get(w.id)!;
  assert.equal(bound.session_id, SID);
  assert.equal(bound.block, null);
  assert.deepEqual(s.native.rows()[0].status, { name: 'working' });
});

test('a start held at no known prompt still fails and ends its terminal', async () => {
  const s = setup({ listed: false });
  s.autoTick(15_000);
  await assert.rejects(start(s.native), /not listed by claude agents/);
  assert.equal(s.killed.length, 1);
  assert.equal(s.native.rows().length, 0);
});

test('trigger a: no hook 60 s after the start reads the screen once; a hook before then reads nothing', async () => {
  const s = setup();
  await start(s.native);
  s.tick(START_READ_MS - 1_000);
  await s.native.poll();
  assert.equal(s.reads().length, 0, 'not yet');
  s.screens.set('story-501-r0', fixtureLogin());
  s.tick(2_000);
  await s.native.poll(); await s.native.poll();
  assert.equal(s.reads().length, 1, 'one read for this start');
  assert.match(s.reads()[0].why, /^no hook 61 s after its start$/);
  assert.equal(s.reads()[0].found, 'login');
  assert.deepEqual(s.native.rows()[0].status, { name: 'blocked', reason: 'login' });
  assert.equal(s.notices.filter(n => /is blocked: login/.test(n)).length, 1);

  const h = setup();
  await start(h.native);
  await h.native.promptHook({ session_id: SID });
  h.tick(START_READ_MS * 2);
  await h.native.poll();
  assert.equal(h.reads().length, 0, 'the brief reached the model: past its start prompts');
});

test('trigger b: five quiet minutes read once; a silent long command stays working, a login error is blocked: login', async () => {
  const s = setup();
  const w = await start(s.native);
  await s.native.promptHook({ session_id: SID });
  s.store.updateNativeWorker(w.id, { transcript: '/t/x.jsonl' });
  s.write(s.now());
  s.screens.set('story-501-r0', RUNNING_SILENT);
  s.tick(QUIET_READ_MS - 1_000);
  await s.native.poll();
  assert.equal(s.reads().length, 0);
  s.tick(2_000);
  await s.native.poll(); await s.native.poll();
  assert.equal(s.reads().length, 1, 'one read for the quiet spell');
  assert.match(s.reads()[0].why, /^working, no hook and no transcript write for 5 min$/);
  assert.equal(s.reads()[0].found, null);
  assert.deepEqual(s.native.rows()[0].status, { name: 'working' }, 'silence alone changes nothing');
  assert.equal(s.notices.length, 0);
  // Another quiet spell (the transcript grew, then stopped) ends on the API error of an expired login.
  s.write(s.now());
  s.screens.set('story-501-r0', LOGIN_ERROR);
  s.tick(QUIET_READ_MS + 1_000);
  await s.native.poll();
  assert.equal(s.reads().length, 2);
  assert.deepEqual(s.native.rows()[0].status, { name: 'blocked', reason: 'login' });
  assert.equal(s.notices.length, 1);
  // The owner logs in, the worker writes again: the block ends with no read.
  s.write(s.now() + 1_000);
  await s.native.poll();
  assert.deepEqual(s.native.rows()[0].status, { name: 'working' });
  assert.ok(s.logs.some(l => l[0] === 'native screen block cleared' && l[1].why === 'its transcript grew'));
});

test('trigger c: a Notification that it waits reads the screen; other notifications and the hook route read nothing', async () => {
  const s = setup();
  await start(s.native);
  await s.native.promptHook({ session_id: SID });
  s.screens.set('story-501-r0', ' Settings Error\n Found 1 invalid settings file\n ❯ 1. Exit and fix manually\n   2. Continue without these settings');
  const store = s.store, log = () => {};
  const r = await nativeRoute({ native: s.native, store, log, askChanged: () => {} } as any, 'POST', '/api/hooks/notification', { session_id: SID, message: 'Claude is waiting for your input' } as any);
  assert.deepEqual(r, { status: 200, body: {} });
  await new Promise(res => setTimeout(res, 10));
  assert.equal(s.reads().length, 1);
  assert.match(s.reads()[0].why, /^notification: Claude is waiting for your input$/);
  assert.deepEqual(s.native.rows()[0].status, { name: 'blocked', reason: 'settings error' });
  await s.native.notificationHook({ session_id: SID, message: 'Task finished' });
  await new Promise(res => setTimeout(res, 10));
  assert.equal(s.reads().length, 1);
  // A Notification does not end the block; the next prompt hook does.
  assert.equal(s.native.get(SID)?.block, 'settings error');
  const p = await nativeRoute({ native: s.native, store, log, askChanged: () => {} } as any, 'POST', '/api/hooks/prompt', { session_id: SID } as any);
  assert.deepEqual(p, { status: 200, body: {} });
  assert.equal(s.native.get(SID)?.block, null);
});

test('trigger d: typing reads the screen first, types the exact bytes through tmux, and refuses at a blocking prompt', async () => {
  const s = setup();
  const w = await start(s.native);
  assert.deepEqual(await s.native.reply(w.id, 'go on\r\n\x1bline two', 'owner'), { ok: true });
  assert.equal(s.typed.length, 1);
  assert.equal(s.typed[0].session, 'story-501-r0');
  assert.equal(s.typed[0].text, 'go on\nline two');
  assert.equal(typedText('a\r\nb'), 'a\nb');
  assert.equal(s.reads()[0].why, 'just before typing');
  assert.ok(s.logs.some(l => l[0] === 'native reply' && l[1].via === 'terminal' && l[1].ok));
  s.screens.set('story-501-r0', TRUST);
  const r = await s.native.reply(w.id, 'yes', 'owner');
  assert.equal(r.ok, false);
  assert.match((r as any).error, /^Not typed: the worker's screen shows the question whether to trust its folder \(blocked: trust prompt\)\. Answer it in its terminal first: tmux -L jarvis-workers attach -t story-501-r0$/);
  assert.equal(s.typed.length, 1, 'nothing typed into the dialog');
});

test('a resume starts a new tmux session and ends the old block; a worker without tmux is never read', async () => {
  const s = setup();
  const w = await start(s.native);
  s.store.updateNativeWorker(w.id, { block: 'login', block_at: new Date(s.now()).toISOString() });
  s.listing[0].pid = undefined;
  await s.native.resume(w.id, 'test', { force: true });
  const r = s.native.get(w.id)!;
  assert.equal(r.tmux, 'story-501-r1');
  assert.equal(r.block, null);

  const p = setup();
  const t0 = new Date(p.now()).toISOString();
  p.store.addNativeWorker({ id: 'oldpipe1', session_id: SID, name: 'old', cwd: '/r', approval_id: null, state: 'working', waiting_for: null, report: null, report_at: null, outcome: null,
    transcript: null, created_at: t0, updated_at: t0, kind: 'interactive', pgid: 4, in_fifo: '/f' });
  p.listing.push({ pid: 4, pgid: 4, kind: 'interactive', sessionId: SID, name: 'old', status: 'busy', cwd: '/r' });
  p.tick(QUIET_READ_MS * 2);
  await p.native.poll();
  assert.equal(p.captures.length, 0);
  assert.deepEqual(p.native.rows()[0].status, { name: 'working' });
});

test('status: done, done: failed, blocked: question and blocked: permission', async () => {
  const s = setup();
  const w = await start(s.native);
  s.native.stopHook({ session_id: SID, last_assistant_message: 'FAILED: no access' });
  assert.deepEqual(s.native.rows()[0].status, { name: 'done', reason: 'failed' });
  s.store.updateNativeWorker(w.id, { outcome: 'done', state: 'done' });
  assert.deepEqual(s.native.rows()[0].status, { name: 'done' });
  s.store.updateNativeWorker(w.id, { outcome: null, state: 'working' });
  void s.native.permissionRequest({ session_id: SID, tool_name: 'Bash', tool_input: { command: 'ls' } });
  assert.deepEqual(s.native.rows()[0].status, { name: 'blocked', reason: 'permission' });
  s.native.decide(s.store.pendingApprovals()[0].id, true);
  // Claude Code's own words in the listing (waitingFor) name the reason with no screen read.
  s.store.updateNativeWorker(w.id, { state: 'blocked', waiting_for: 'login required — run /login' });
  assert.deepEqual(s.native.rows()[0].status, { name: 'blocked', reason: 'login' });
  assert.equal(s.captures.length, 0);
  s.store.updateNativeWorker(w.id, { state: 'working', waiting_for: null });
  s.store.insertItem({ source: 'native', external_id: 'ask:x:1', kind: 'question', dispatch_id: `n:${w.id}`, subject: 'Question from story-501', body: 'QUESTION: ok?', status: 'spoken' });
  assert.deepEqual(s.native.rows()[0].status, { name: 'blocked', reason: 'question' });
});

function fixtureLogin() { return readFileSync(join(FIX, 'screen-login.txt'), 'utf8'); }
