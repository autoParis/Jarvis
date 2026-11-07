import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeShell, hiddenInput } from './shell.ts';
import { makeScreen, feed, screenText } from '../web/shell.js';

function setup(opts: { graceMs?: number; command?: string } = {}) {
  const state = new Map<string, string>(), logged: [string, any][] = [];
  const store = { getState: (k: string) => state.get(k), setState: (k: string, v: string) => { state.set(k, v); } };
  const shell = makeShell({ store, log: (m, f) => { logged.push([m, f]); }, command: '/bin/sh', ...opts });
  let text = '', ended = '';
  const view = (e: any) => { if (e.out) text += e.out; if (e.ended) ended = e.ended; };
  const until = async (ok: () => boolean) => { for (let i = 0; i < 300 && !ok(); i++) await new Promise(r => setTimeout(r, 20)); assert.ok(ok(), `timed out; output: ${text}; ended: ${ended}`); };
  return { state, logged, store, shell, view, until, out: () => text, ended: () => ended };
}
const alive = (pattern: string) => { try { execFileSync('/usr/bin/pgrep', ['-f', pattern]); return true; } catch { return false; } };

test('a real pty: a pasted multi-line command runs with live output, and only the words go to the log', async () => {
  const t = setup();
  t.shell.open();
  t.shell.attach(t.view);
  await t.until(() => JSON.parse(t.state.get('shell')!).tty);
  await t.shell.input('tty\necho one-$((40+2))\n');
  await t.until(() => t.out().includes('one-42'));
  assert.match(t.out(), /\/dev\/ttys\d+/, 'it is a tty');
  const commands = t.logged.filter(([m]) => m === 'shell command').map(([, f]) => f.command);
  assert.deepEqual(commands, ['tty', 'echo one-$((40+2))']);
  assert.ok(!JSON.stringify(t.logged).includes('one-42'), 'no output in the log');
  t.shell.close('The owner tapped Close');
  await t.until(() => t.ended() !== '');
  assert.match(t.ended(), /The owner tapped Close/);
  assert.equal(t.state.get('shell'), '');
  assert.ok(t.logged.some(([m, f]) => m === 'shell ended' && f.reason === 'The owner tapped Close'));
});

test('Close ends a running command, and a page coming back replays what it missed', async () => {
  const t = setup();
  t.shell.open();
  const leave = t.shell.attach(t.view);
  await t.until(() => JSON.parse(t.state.get('shell')!).tty);
  await t.shell.input('echo first; sleep 7391');
  await t.until(() => t.out().includes('first\n') || t.out().includes('first\r'));
  leave();
  let again = '';
  t.shell.attach(e => { if ('out' in e) again += e.out; });
  assert.ok(again.includes('first'));
  assert.ok(alive('sleep 7391'));
  t.shell.close('The owner tapped Close');
  await t.until(() => !t.shell.live() && !alive('sleep 7391'));
});

test('Ctrl-C reaches the command', async () => {
  const t = setup();
  t.shell.open();
  t.shell.attach(t.view);
  await t.until(() => JSON.parse(t.state.get('shell')!).tty);
  await t.shell.input('sleep 7392; echo after-$((1+1))');
  await t.until(() => alive('sleep 7392'));
  t.shell.interrupt();
  await t.until(() => !alive('sleep 7392'));
  t.shell.killNow('test over');
});

test('the shell dies when no page has come back within the grace time, not while one is open', async () => {
  const t = setup({ graceMs: 150 });
  t.shell.open();
  const leave = t.shell.attach(t.view);
  await new Promise(r => setTimeout(r, 300));
  assert.ok(t.shell.live(), 'an open page keeps it');
  leave();
  await t.until(() => !t.shell.live());
  assert.ok(t.logged.some(([m, f]) => m === 'shell ended' && /page stayed closed/.test(f.reason)));
});

test('exit in the shell ends it, and the page is told', async () => {
  const t = setup();
  t.shell.open();
  t.shell.attach(t.view);
  await t.until(() => JSON.parse(t.state.get('shell')!).tty);
  await t.shell.input('exit');
  await t.until(() => t.ended() !== '');
  assert.match(t.ended(), /shell exited/);
});

test('a jarvisd that restarts kills a leftover shell, and a page that asks is told why', async () => {
  const a = setup();
  a.shell.open();
  a.shell.attach(a.view);
  await a.until(() => JSON.parse(a.state.get('shell')!).tty);
  await a.shell.input('sleep 7393');
  await a.until(() => alive('sleep 7393'));
  // The next jarvisd, reading the same state.
  const logged: string[] = [];
  const next = makeShell({ store: a.store, log: m => { logged.push(m); } });
  next.reapLeftover();
  await a.until(() => !alive('sleep 7393'));
  assert.ok(logged.includes('shell ended'));
  let told = '';
  next.attach(e => { if ('ended' in e) told = e.ended; });
  assert.match(told, /jarvisd restarted/);
  await a.until(() => !a.shell.live());
});

test('a saved pid that is now another program is left alone', () => {
  const t = setup();
  t.state.set('shell', JSON.stringify({ pid: process.pid, tty: '/dev/ttys999' }));
  t.shell.reapLeftover();
  assert.ok(t.logged.some(([m]) => /already gone/.test(m)));
});

test('a password prompt stays out of the log; a shell line editor does not count as one', async () => {
  assert.equal(hiddenInput('lflags: icanon isig iexten -echo echoe'), true);
  assert.equal(hiddenInput('lflags: -icanon isig iexten -echo echoe'), false);
  assert.equal(hiddenInput('lflags: icanon isig iexten echo echoe'), false);
  const t = setup();
  t.shell.open();
  t.shell.attach(t.view);
  await t.until(() => JSON.parse(t.state.get('shell')!).tty);
  await t.shell.input('stty -echo; read secret; stty echo; echo got-${#secret}');
  await new Promise(r => setTimeout(r, 300));
  await t.shell.input('hunter2');
  await t.until(() => t.out().includes('got-7'));
  assert.ok(!JSON.stringify(t.logged).includes('hunter2'));
  assert.ok(t.logged.some(([m, f]) => /not logged/.test(m) && f.chars === 7));
  t.shell.killNow('test over');
});

test('the output screen handles carriage returns, backspaces, erase and escape codes', () => {
  const shown = (...chunks: string[]) => { const s = makeScreen(); for (const c of chunks) feed(s, c); return screenText(s); };
  assert.equal(shown('one\r\ntwo\n'), 'one\ntwo\n');
  assert.equal(shown('10%\r50%\r100%'), '100%');
  assert.equal(shown('abc\b\bX'), 'aXc');
  assert.equal(shown('long line\rshort\x1b[K'), 'short');
  assert.equal(shown('\x1b[1;31mred\x1b[0m'), 'red');
  assert.equal(shown('\x1b]0;title\x07text'), 'text');
  assert.equal(shown('a\x1b[3', '1mb'), 'ab', 'a code cut by a chunk');
});

test('the page never sends the shell routes through the shared event stream', () => {
  const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
  assert.ok(!/broadcast\([^)]*shell/i.test(main), 'output goes only to pages that passed the check');
  const gateAt = main.indexOf("url.startsWith('/api/shell/')"), staticAt = main.indexOf('if (req.method === \'GET\' && STATIC[url])');
  assert.ok(gateAt > 0 && gateAt < staticAt, 'the check runs before any route');
});

test('the page script parses: one duplicate name stops the whole app without failing any other test', () => {
  const page = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  const script = /<script type="module">([\s\S]*?)<\/script>/.exec(page)![1];
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-page-'));
  try {
    writeFileSync(join(dir, 'page.mjs'), script);
    execFileSync(process.execPath, ['--check', join(dir, 'page.mjs')], { stdio: 'pipe' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
