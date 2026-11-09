import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from './store.ts';
import { makeNative, ROW_PREFIX, IDLE_REAP_MS } from './native.ts';
import { findSession, holdersIn, sessionName } from './resume.ts';
import { nativeRoute } from './nativeroutes.ts';

// Continue on phone (2026-11-08): a session resumed as itself, with Remote Control on, in a native interactive terminal.
const SID = '9b765826-0357-4702-af45-87f6fec95026';
const JSONL = [
  '{"type":"permission-mode","permissionMode":"default","sessionId":"' + SID + '"}',
  '{"type":"assistant","message":{"model":"claude-opus-5-5","content":[]}}',
  '{"type":"custom-title","customTitle":"Photo \\"sync\\" dry runs","sessionId":"' + SID + '"}',
].join('\n');

/** A stand-in for `claude`, the pseudo-terminal launcher, `ps` and the transcript, with the session idle and unheld. */
function setup(o: { written?: number } = {}) {
  const store = openStore(':memory:');
  const listing: any[] = [];
  const ps: string[] = ['  1 /sbin/launchd'];
  const spawns: { argv: string[]; cwd: string; fifo?: string }[] = [], killedGroups: number[] = [], killedPids: number[] = [], calls: string[][] = [], logs: string[] = [];
  let t = 1_800_000_000_000;
  let nextPgid = 7000;
  const claude = async (args: string[]) => {
    calls.push(args);
    if (args[0] === '--version') return { code: 0, out: '2.1.316 (Claude Code)\n', err: '' };
    if (args[0] === 'agents') return { code: 0, out: JSON.stringify(listing), err: '' };
    if (args[0] === 'stop') { for (const a of listing) if (a.id === args[1]) delete a.pid; return { code: 0, out: `stopped ${args[1]}`, err: '' }; }
    return { code: 0, out: '', err: '' };
  };
  const native = makeNative({
    store, log: (m, f) => logs.push(`${m} ${JSON.stringify(f ?? {})}`), jarvisUrl: 'http://127.0.0.1:7788', dataDir: mkdtempSync(join(tmpdir(), 'phone-')),
    onChange: () => {}, onReport: () => {}, onCard: () => {}, onNotice: () => {}, claude, now: () => t,
    mkfifo: () => {},
    spawnPty: (argv, cwd, fifo) => {
      spawns.push({ argv, cwd, fifo });
      const pgid = nextPgid++;
      listing.push({ pid: pgid + 1, pgid, cwd, kind: 'interactive', sessionId: argv[argv.indexOf('--resume') + 1], name: argv[argv.indexOf('--name') + 1], status: 'idle' });
      return pgid;
    },
    killGroup: pgid => { killedGroups.push(pgid); for (const a of listing) if (a.pgid === pgid) delete a.pid; },
    alivePgid: pgid => listing.some(a => a.pgid === pgid && a.pid),
    killPid: pid => { killedPids.push(pid); for (const a of listing) if (a.pid === pid) delete a.pid; const i = ps.findIndex(l => l.trim().startsWith(`${pid} `)); if (i >= 0) ps.splice(i, 1); },
    processes: async () => [...ps],
    written: () => t - (o.written ?? 60_000),
    tail: () => JSONL,
  });
  return { store, native, listing, ps, spawns, killedGroups, killedPids, calls, logs, tick: (ms: number) => { t += ms; } };
}

test('holdersIn names the Claude processes whose command line has the session id, not shells or greps that mention it', () => {
  const lines = [
    `  501 claude --resume ${SID} --remote-control=x`,
    `  502 /bin/sh -c grep ${SID} file`,
    `  503 grep ${SID}`,
    `  504 node something-else`,
    `  ${process.pid} node ${SID}`,
    `  505 /Applications/Claude.app/Contents/MacOS/claude --desktop --resume ${SID}`,
    `  506 /bin/zsh -c source snapshot.sh && cd /x && claude --resume ${SID}`,
    `  507 node /opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js --resume ${SID}`,
    `  508 tail -f /home/x/.claude/projects/p/${SID}.jsonl`,
  ];
  assert.deepEqual(holdersIn(lines, SID).map(h => h.pid), [501, 505, 507]);
  assert.match(holdersIn(lines, SID)[0].what, /^claude --resume/);
});

test('sessionName reads the last custom title, unescaped, and falls back to the agent name', () => {
  assert.equal(sessionName(JSONL), 'Photo "sync" dry runs');
  assert.equal(sessionName('{"type":"agent-name","agentName":"only-agent"}'), 'only-agent');
  assert.equal(sessionName('{"type":"user"}'), undefined);
});

test('findSession finds a transcript by id in any project folder and reads its cwd', () => {
  const home = mkdtempSync(join(tmpdir(), 'home-'));
  const dir = join(home, '.claude', 'projects', '-Users-x-Repos-app');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${SID}.jsonl`), `{"type":"user","cwd":"/home/x/Repos/app","sessionId":"${SID}"}\n`);
  assert.deepEqual(findSession(SID, home), { file: join(dir, `${SID}.jsonl`), cwd: '/home/x/Repos/app' });
  assert.equal(findSession('00000000-0000-4000-8000-000000000009', home), undefined);
  assert.equal(findSession('not-an-id', home), undefined);
});

test('a session nobody holds is resumed as itself, never with --bg, with Remote Control, its own mode and model', async () => {
  const { native, spawns, calls, store } = setup();
  const r = await native.phone({ sessionId: SID, cwd: '/repo', title: 'Photo sync dry runs', transcript: '/t.jsonl', approvalId: 9 });
  assert.equal(r.ok, true);
  assert.equal(spawns.length, 1);
  const argv = spawns[0].argv;
  assert.deepEqual(argv.slice(0, 3), ['claude', '--resume', SID], 'the same session id, not a copy');
  assert.ok(!argv.includes('--bg') && !argv.includes('--fork-session'));
  assert.ok(argv.includes('--remote-control=Photo sync dry runs'));
  assert.deepEqual(argv.slice(argv.indexOf('--permission-mode'), argv.indexOf('--permission-mode') + 4), ['--permission-mode', 'default', '--model', 'claude-opus-5-5']);
  assert.ok(argv.includes('--settings'));
  assert.equal(spawns[0].cwd, '/repo');
  assert.ok(!calls.some(c => c[0] === '--bg'));
  const w = r.ok ? r.worker : undefined!;
  assert.equal(w.id, SID.slice(0, 8));
  assert.equal(w.kind, 'interactive');
  assert.equal(w.remote, 'Photo sync dry runs');
  assert.equal(w.outcome, 'done', 'no task runs, so nothing auto-resumes it or waits for a DONE line');
  assert.equal(w.approval_id, 9);
  const row = native.rows().find(x => x.id === `${ROW_PREFIX}${w.id}`)!;
  assert.equal(row.state, 'idle');
  assert.equal(row.note, 'In the Claude app as "Photo sync dry runs"');
  assert.equal(row.native?.remote, 'Photo sync dry runs');
  assert.equal(row.endedAt, undefined, 'a row on the phone does not fold away as finished');
  assert.ok(store.openItems().length === 0);

  // A second press while it runs changes nothing.
  const again = await native.phone({ sessionId: SID, cwd: '/repo', title: 'Photo sync dry runs' });
  assert.equal(again.ok && again.already, true);
  assert.equal(spawns.length, 1);
});

test('another process on the session refuses it, names it, and ends it only when its pid is chosen', async () => {
  const { native, ps, listing, spawns, killedPids, calls } = setup();
  ps.push(`  4100 claude --resume ${SID} --remote-control=Old`);
  listing.push({ id: '9b765826', pid: 4200, kind: 'background', sessionId: SID, name: 'Photo sync', status: 'idle', state: 'done' });
  const r = await native.phone({ sessionId: SID, cwd: '/repo', title: 'T' });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.deepEqual(r.holders?.map(h => h.pid).sort(), [4100, 4200]);
  assert.match(r.error, /pid 4200, a background session named "Photo sync", idle/);
  assert.match(r.error, /pid 4100, claude --resume/);
  assert.equal(spawns.length, 0, 'nothing starts while another writer has it');

  // Only one of the two chosen: still refused, nothing ended.
  const half = await native.phone({ sessionId: SID, cwd: '/repo', title: 'T', stop: [4100] });
  assert.equal(half.ok, false);
  assert.deepEqual(killedPids, []);

  // Both chosen: the terminal is killed, the background session is stopped through its supervisor, then it starts.
  const ok = await native.phone({ sessionId: SID, cwd: '/repo', title: 'T', stop: [4100, 4200] });
  assert.equal(ok.ok, true);
  assert.deepEqual(killedPids, [4100]);
  assert.ok(calls.some(c => c[0] === 'stop' && c[1] === '9b765826'));
  assert.equal(spawns.length, 1);
});

test('a transcript written seconds ago is refused, so a live writer it cannot see keeps its turn', async () => {
  const { native, spawns } = setup({ written: 2_000 });
  const r = await native.phone({ sessionId: SID, cwd: '/repo', title: 'T', transcript: '/t.jsonl' });
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.error : '', /written to seconds ago/);
  assert.equal(spawns.length, 0);
});

test('a worker jarvisd runs is ended and resumed with the flag; a busy one is refused; later resumes keep the flag', async () => {
  const seed = (x: ReturnType<typeof setup>, status: string) => {
    const at = '2026-11-08T12:00:00.000Z';
    x.store.addNativeWorker({ id: SID.slice(0, 8), session_id: SID, name: 'photos-12', cwd: '/repo/wt', approval_id: 12, state: 'done', waiting_for: null, report: 'DONE: counted', report_at: at,
      outcome: 'done', transcript: null, created_at: at, updated_at: at, kind: 'interactive', pgid: 6000, repo: '/repo', model: 'claude-sonnet-5-5', permission_mode: 'auto', resumes: 0, in_fifo: '/f' });
    x.listing.push({ pid: 6001, pgid: 6000, cwd: '/repo/wt', kind: 'interactive', sessionId: SID, name: 'photos-12', status });
  };
  const busy = setup();
  seed(busy, 'busy');
  const r1 = await busy.native.phone({ sessionId: SID, cwd: '/elsewhere', title: 'ignored' });
  assert.equal(r1.ok, false);
  assert.match(!r1.ok ? r1.error : '', /middle of a turn/);
  assert.deepEqual(busy.killedGroups, []);

  const s = setup();
  seed(s, 'idle');
  const r = await s.native.phone({ sessionId: SID, cwd: '/elsewhere', title: 'Photos' });
  assert.equal(r.ok, true);
  assert.deepEqual(s.killedGroups, [6000], 'its own terminal is ended first, not refused as a second writer');
  const argv = s.spawns[0].argv;
  assert.deepEqual(argv.slice(0, 5), ['claude', '--resume', SID, '--name', 'photos-12']);
  assert.ok(argv.includes('--remote-control=Photos'));
  assert.ok(argv.includes('claude-sonnet-5-5') && argv.includes('auto'), 'the stored model and mode, not the transcript\'s');
  assert.equal(s.spawns[0].cwd, '/repo/wt');
  const w = s.native.get(SID)!;
  assert.equal(w.remote, 'Photos');
  assert.equal(w.resumes, 1);
  assert.equal(w.report, 'DONE: counted', 'its report stays');

  // A later resume (a message after its terminal died) keeps Remote Control on.
  for (const a of s.listing) delete a.pid;
  await s.native.resume(w.id, 'a message arrived', { force: true, quiet: true });
  assert.ok(s.spawns[s.spawns.length - 1].argv.includes('--remote-control=Photos'));
});

test('the idle reaper ends a phone session idle for an hour, so its row does not stay open for good', async () => {
  const s = setup();
  const r = await s.native.phone({ sessionId: SID, cwd: '/repo', title: 'Photos' });
  assert.equal(r.ok, true);
  await s.native.poll();
  s.tick(IDLE_REAP_MS - 60_000);
  await s.native.poll();
  assert.deepEqual(s.killedGroups, [], 'not before the hour from Continue on phone');
  assert.match(s.native.rows()[0].note ?? '', /In the Claude app/);
  s.tick(2 * 60_000);
  await s.native.poll();
  assert.equal(s.killedGroups.length, 1, 'idle an hour on the phone: ended like any finished session');
  assert.equal(s.native.get(SID)?.state, 'stopped');
  assert.equal(s.native.get(SID)?.remote, 'Photos', 'a message resumes it with its Remote Control name');
  assert.equal(s.native.rows()[0].state, 'idle');
  s.tick(25 * 3_600_000);
  assert.deepEqual(s.native.rows(), [], 'and its row leaves after the day like any finished row');
});

test('a Stop hook on a phone session leaves it idle, not working', async () => {
  const { native, listing } = setup();
  await native.phone({ sessionId: SID, cwd: '/repo', title: 'Photos' });
  listing[0].status = 'busy';
  await native.poll();
  assert.equal(native.get(SID)?.state, 'working');
  native.stopHook({ session_id: SID, last_assistant_message: 'Here is the count.' });
  assert.equal(native.get(SID)?.state, 'done');
  listing[0].status = 'idle';
  await native.poll();
  assert.equal(native.get(SID)?.state, 'done');
});

test('the brain route finds an unlisted session by id, names it from its transcript, and never stops a holder', async () => {
  const { native, ps, spawns } = setup();
  const store = openStore(':memory:');
  const route = (body: any) => nativeRoute({ native, store, log: () => {}, askChanged: () => {}, findSession: id => id === SID ? { file: '/t.jsonl', cwd: '/repo' } : undefined }, 'POST', '/api/internal/native/phone', body);
  assert.equal((await route({}))?.status, 400);
  assert.equal((await route({ session: '00000000-0000-4000-8000-000000000009' }))?.status, 404);
  ps.push(`  4100 claude --resume ${SID}`);
  const held = await route({ session: SID, stop: [4100] });
  assert.equal(held?.status, 409);
  assert.deepEqual((held?.body as any).holders.map((h: any) => h.pid), [4100]);
  assert.equal(spawns.length, 0);
  ps.pop();
  const ok = await route({ session: SID });
  assert.equal(ok?.status, 200);
  assert.equal((ok?.body as any).remoteControl, 'Photo "sync" dry runs');
  assert.ok(spawns[0].argv.includes('--remote-control=Photo "sync" dry runs'));
});
