import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BLOCKING_PROMPTS, BOTTOM_LINES, attachCommand, findTmux, makeWorkerTmux, matchScreen, needsReason, workerSession } from './screen.ts';
import { makeTerminals, parseList } from './terminal.ts';
import { terminalRows, terminalStatus } from './termrows.ts';
import { BLOCKED_REASONS } from '../web/contract.js';

const FIX = join(fileURLToPath(import.meta.url), '..', 'fixtures');
const fixture = (f: string) => readFileSync(join(FIX, f), 'utf8');
const TMUX = findTmux();
const HAVE_TMUX = TMUX !== 'tmux' || (() => { try { execFileSync('tmux', ['-V'], { stdio: 'ignore' }); return true; } catch { return false; } })();
const ENV = { PATH: '/usr/bin:/bin', HOME: process.env.HOME, TERM: 'xterm-256color', SHELL: '/bin/sh', LANG: 'en_US.UTF-8' };
const until = async (ok: () => boolean | Promise<boolean>, what = '') => { for (let i = 0; i < 250; i++) { if (await ok()) return; await new Promise(r => setTimeout(r, 20)); } assert.fail(`timed out: ${what}`); };

test('the real Claude Code start screens match their reason', () => {
  assert.equal(matchScreen(fixture('screen-trust.txt')), 'trust prompt');
  assert.equal(matchScreen(fixture('screen-login.txt')), 'login');
  assert.equal(matchScreen(fixture('screen-first-run.txt')), 'login');
  assert.equal(matchScreen(fixture('screen-paste-code.txt')), 'login');
});

test('the other known dialogs match, and the generic dialog footer comes last', () => {
  const perm = ' Bash command\n   rm -rf build\n Do you want to proceed?\n ❯ 1. Yes\n   2. Yes, and don\'t ask again for rm commands\n   3. No, and tell Claude what to do differently (esc)\n';
  assert.equal(matchScreen(perm), 'permission');
  assert.equal(matchScreen(' New MCP server found in .mcp.json: figma\n ❯ 1. Use this and all future MCP servers in this project\n   2. Continue without\n Enter to confirm · Esc to cancel'), 'mcp servers');
  assert.equal(matchScreen(' Settings Error\n Found 1 invalid settings file\n ❯ 1. Exit and fix manually\n   2. Continue without these settings'), 'settings error');
  assert.equal(matchScreen(' Auto mode is new. Turn it on?\n ❯ Yes\n   No\n Enter to confirm · Esc to exit'), 'prompt on screen');
  assert.equal(matchScreen('⏺ API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired."}} · Please run /login\n\n────\n❯ \n────\n  ? for shortcuts'), 'login');
  for (const p of BLOCKING_PROMPTS) assert.ok(BLOCKED_REASONS.includes(p.reason), `${p.reason} is a contract reason`);
});

test('a working screen, an idle prompt and old output above the bottom never match', () => {
  // A turn under way: the spinner line wins, even with a dialog's words in the output (a worker writing about logins).
  assert.equal(matchScreen('⏺ I will check the Select login method screen.\n ❯ 1. Claude account with subscription\n✻ Running tests… (2m 10s · esc to interrupt)\n────\n❯ \n────'), undefined);
  // Idle at its prompt after a long silent test run: nothing to report.
  assert.equal(matchScreen('⏺ Bash(npm test)\n  ⎿  # pass 1046\n\n────\n❯ \n────\n  ⏵⏵ auto mode on (shift+tab to cycle)'), undefined);
  const old = fixture('screen-login.txt') + '\n' + Array.from({ length: BOTTOM_LINES }, (_, i) => `⏺ line ${i}`).join('\n') + '\n────\n❯ \n────';
  assert.equal(matchScreen(old), undefined, 'a login screen scrolled above the bottom lines is old output');
  assert.equal(matchScreen(''), undefined);
});

test('Claude Code\'s own words in the listing name the reason, with no screen read', () => {
  assert.equal(needsReason('login required — run /login'), 'login');
  assert.equal(needsReason('cloud credentials unavailable — check or refresh them'), 'login');
  assert.equal(needsReason('usage limit reached — check plan'), 'usage limit');
  assert.equal(needsReason('permission prompt'), 'permission');
  assert.equal(needsReason('input needed'), 'prompt on screen');
  assert.equal(needsReason(null), 'prompt on screen');
  for (const r of ['login', 'usage limit', 'permission', 'prompt on screen']) assert.ok(BLOCKED_REASONS.includes(r));
});

test('findTmux takes JARVIS_TMUX, then the usual places, then the PATH; names are tmux-safe', () => {
  assert.equal(findTmux({ JARVIS_TMUX: '/x/tmux' }, () => false), '/x/tmux');
  assert.equal(findTmux({}, p => p === '/usr/bin/tmux'), '/usr/bin/tmux');
  assert.equal(findTmux({}, () => false), 'tmux');
  assert.equal(workerSession('fix.it:now-412', 2), 'fix-it-now-412-r2');
  assert.equal(attachCommand('a-r0', 'sock'), 'tmux -L sock attach -t a-r0');
});

test('the worker tmux driver starts argv with its last item from a file, types exact bytes and reads the screen', { skip: !HAVE_TMUX && 'no tmux' }, async () => {
  const socket = `jvscreen-${process.pid}`;
  const wt = makeWorkerTmux({ socket, env: ENV, cols: 80, rows: 10 });
  const dir = mkdtempSync(join(tmpdir(), 'screen-'));
  try {
    const long = `brief ${'x'.repeat(20_000)} end`; // past tmux's message size limit, so only a file can carry it
    const pid = wt.start(['sh', '-c', 'printf "LEN=%s\\n" "${#1}"; IFS= read -r line; printf "GOT=%s\\n" "$line"; sleep 30', 'zero', long], dir, 'w-r0', join(dir, 'w-r0.arg'));
    assert.ok(pid > 0);
    process.kill(pid, 0);
    await until(async () => (await wt.capture('w-r0')).includes(`LEN=${long.length}`), 'the long last argument arrived');
    await wt.type('w-r0', 'typed é words');
    await until(async () => (await wt.capture('w-r0')).includes('GOT=typed é words'), 'the typed bytes arrived');
    process.kill(-pid, 'SIGTERM');
    await until(async () => wt.capture('w-r0').then(() => false, () => true), 'the session ends with its process group');
  } finally { try { execFileSync(TMUX, ['-L', socket, 'kill-server'], { stdio: 'ignore' }); } catch {} }
});

test('a terminal row is idle at a shell, working with a program, blocked with the reason a read found', () => {
  assert.deepEqual(terminalStatus({ command: 'zsh' }), { name: 'idle' });
  assert.deepEqual(terminalStatus({ command: '-bash' }), { name: 'idle' });
  assert.deepEqual(terminalStatus({ command: 'node' }), { name: 'working' });
  assert.deepEqual(terminalStatus({ command: 'claude', block: 'trust prompt' }), { name: 'blocked', reason: 'trust prompt' });
  const [r] = terminalRows([{ name: 'ev-1', project: 'jarvis', kind: 'codex', cwd: '/r', branch: 'm', createdAt: '', attached: 0, command: 'claude', block: 'login' }]);
  assert.equal(r.state, 'waiting');
  assert.deepEqual(r.status, { name: 'blocked', reason: 'login' });
  const [p] = parseList('ev-1\t1\tjarvis\tterminal\t1700000000\t/r\t0\tnode\t1700000100\n');
  assert.equal(p.command, 'node');
  assert.equal(p.activity, new Date(1_700_000_100_000).toISOString());
});

test('a project terminal is read once per quiet spell of a program, never at a shell or while output flows', { skip: !HAVE_TMUX && 'no tmux' }, async () => {
  const socket = `jvtermread-${process.pid}`;
  const logs: [string, any][] = [];
  let skew = 0;
  const terms = makeTerminals({ log: (m, f) => { logs.push([m, f]); }, env: ENV, socket, tmux: TMUX, now: () => Date.now() + skew });
  try {
    const t = await terms.open({ project: 'jarvis', cwd: tmpdir(), kind: 'terminal', cols: 80, rows: 12 });
    await terms.list();
    assert.equal(logs.filter(l => l[0] === 'terminal screen read').length, 0, 'a shell prompt is never read');
    execFileSync(TMUX, ['-L', socket, 'send-keys', '-t', t.name, '-l', 'printf " Select login method:\\n"; sleep 30'], { env: ENV });
    execFileSync(TMUX, ['-L', socket, 'send-keys', '-t', t.name, 'Enter'], { env: ENV });
    await until(async () => (await terms.list()).find(x => x.name === t.name)?.command === 'sleep', 'sleep runs');
    assert.equal(logs.filter(l => l[0] === 'terminal screen read').length, 0, 'fresh output is not read');
    skew = 61_000;
    const [blocked] = await terms.list();
    assert.equal(blocked.block, 'login');
    await terms.list();
    const reads = logs.filter(l => l[0] === 'terminal screen read');
    assert.equal(reads.length, 1, 'one read for the quiet spell');
    assert.match(reads[0][1].why, /^sleep wrote nothing for \d+ s$/);
    assert.equal(reads[0][1].found, 'login');
    assert.deepEqual(terminalRows(terms.current())[0].status, { name: 'blocked', reason: 'login' });
  } finally { try { execFileSync(TMUX, ['-L', socket, 'kill-server'], { stdio: 'ignore' }); } catch {} }
});
