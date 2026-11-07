import { spawn, execFile, execFileSync, type ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { homedir } from 'node:os';
import type { Log } from './log.ts';

// The one-off shell pane. One shell at a time, on a pty that jarvisd owns. Orca is not
// involved. macOS `script` provides the pty, so the project keeps its zero dependencies.
// The rules for who may reach it are in access.ts: this file trusts its caller.

export const SHELL_GRACE_MS = 3 * 60_000;
const BUFFER_CHARS = 256_000;
const COLS = 100, ROWS = 40;
// Printed once by the wrapper: the shell's tty, which the kill and the echo check need.
const TTY_MARK = /\x1e(\/dev\/[\w/]+)\x1e/;

export type ShellEvent = { out: string; at: number } | { ended: string };
export type Viewer = (e: ShellEvent) => void;

/** True when the terminal is reading a password: canonical input with echo off. A shell line editor has `-icanon`. */
export function hiddenInput(stty: string): boolean {
  const has = (flag: string) => new RegExp(`(^|\\s)${flag}(\\s|$)`).test(stty);
  return has('-echo') && has('icanon');
}

function killTty(tty: string | undefined) {
  if (!tty) return;
  try { execFileSync('/usr/bin/pkill', ['-KILL', '-t', tty.replace('/dev/', '')], { stdio: 'ignore' }); } catch { /* nothing left on it */ }
}
function killGroup(pid: number, signal: NodeJS.Signals) {
  try { process.kill(-pid, signal); } catch { /* already gone */ }
}

type State = { getState(k: string): string | undefined; setState(k: string, v: string): void };
type Opts = { store: State; log: Log; env?: NodeJS.ProcessEnv; graceMs?: number; command?: string };

export function makeShell({ store, log, env = process.env, graceMs = SHELL_GRACE_MS, command }: Opts) {
  type Live = { child: ChildProcess; pid: number; tty?: string; startedAt: number; reason?: string };
  let cur: Live | undefined;
  let buffer = '', total = 0;
  let lastEnded = '';
  let grace: NodeJS.Timeout | undefined;
  const viewers = new Set<Viewer>();

  const remember = () => store.setState('shell', cur ? JSON.stringify({ pid: cur.pid, tty: cur.tty }) : '');

  function publish(e: ShellEvent) { for (const v of viewers) v(e); }
  function watchGrace() {
    clearTimeout(grace);
    grace = undefined;
    if (cur && !viewers.size) grace = setTimeout(() => close('its page stayed closed'), graceMs);
  }

  function open(): { started: boolean } {
    if (cur) return { started: false };
    const shellPath = env.SHELL || '/bin/zsh';
    // TERM=dumb and no pager: the pane prints lines. It is not a full-screen terminal.
    const wrapper = `stty cols ${COLS} rows ${ROWS}; printf '\\036%s\\036' "$(tty)"; exec ${command ?? `"${shellPath}" -il`}`;
    // Node's stdin pipe is a socket, and `script` refuses a socket. `cat` hands it a real pipe. All share a process group, and `kill 0` ends `cat` once the shell has exited.
    const quote = (x: string) => `'${x.replace(/'/g, `'\\''`)}'`;
    const child = spawn('/bin/sh', ['-c', `/bin/cat | { /usr/bin/script -q /dev/null /bin/sh -c ${quote(wrapper)}; kill -TERM 0; }`], {
      cwd: homedir(), detached: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...env, TERM: 'dumb', PAGER: 'cat', GIT_PAGER: 'cat', JARVIS_SHELL: '1' },
    });
    const live: Live = { child, pid: child.pid!, startedAt: Date.now() };
    cur = live;
    buffer = ''; total = 0; lastEnded = '';
    remember();
    log('shell started', { pid: live.pid });
    const decoder = new StringDecoder('utf8');
    const onData = (chunk: Buffer) => {
      let text = decoder.write(chunk);
      if (!live.tty) {
        const m = TTY_MARK.exec(text);
        if (m) { live.tty = m[1]; text = text.replace(TTY_MARK, ''); remember(); log('shell tty', { pid: live.pid, tty: live.tty }); }
      }
      if (!text) return;
      buffer = (buffer + text).slice(-BUFFER_CHARS);
      total += text.length;
      publish({ out: text, at: total });
    };
    child.stdout!.on('data', onData);
    child.stderr!.on('data', onData);
    child.stdin!.on('error', () => {});
    child.on('error', e => { log('shell failed', { error: String(e) }); finish(live, `it could not start: ${e.message}`); });
    child.on('close', () => finish(live, live.reason ?? 'the shell exited'));
    watchGrace();
    return { started: true };
  }

  function finish(live: Live, reason: string) {
    if (cur !== live) return;
    killTty(live.tty);
    cur = undefined;
    lastEnded = `The shell ended: ${reason}.`;
    remember();
    clearTimeout(grace);
    log('shell ended', { pid: live.pid, reason, seconds: Math.round((Date.now() - live.startedAt) / 1000) });
    publish({ ended: lastEnded });
  }

  function close(reason: string): boolean {
    const live = cur;
    if (!live) return false;
    live.reason = reason;
    killGroup(live.pid, 'SIGHUP');
    const hard = setTimeout(() => { killGroup(live.pid, 'SIGKILL'); killTty(live.tty); }, 1500);
    live.child.once('close', () => clearTimeout(hard));
    return true;
  }

  /** Writes the owner's words to the pty and logs them, unless the terminal is reading a password. Output is never logged. */
  async function input(text: string): Promise<boolean> {
    const live = cur;
    if (!live) return false;
    const lines = text.replace(/\r\n?/g, '\n').replace(/\n+$/, '');
    let hidden = true; // with no answer from stty, the words stay out of the log
    if (live.tty) {
      hidden = await new Promise<boolean>(done => execFile('/bin/stty', ['-f', live.tty!, '-a'], { timeout: 2000 }, (err, out) => done(err ? true : hiddenInput(out))));
    }
    if (hidden) log('shell input not logged (the terminal had echo off)', { pid: live.pid, chars: lines.length });
    else for (const command of lines.split('\n')) if (command.trim()) log('shell command', { pid: live.pid, command });
    live.child.stdin!.write(`${lines}\n`);
    return true;
  }

  function interrupt(): boolean {
    if (!cur) return false;
    log('shell interrupt', { pid: cur.pid });
    cur.child.stdin!.write('\x03');
    return true;
  }

  /** Adds a page that shows the output, from its last character on. Returns the call that removes it. */
  function attach(v: Viewer, from = 0): () => void {
    const start = total - buffer.length;
    const skip = Math.max(0, from - start);
    if (skip < buffer.length) v({ out: buffer.slice(skip), at: total });
    if (!cur) {
      v({ ended: lastEnded || 'The shell ended: jarvisd restarted, which kills it.' });
      return () => {};
    }
    viewers.add(v);
    watchGrace();
    return () => { viewers.delete(v); watchGrace(); };
  }

  /** On SIGTERM: nothing may outlive jarvisd. */
  function killNow(reason: string) {
    if (!cur) return;
    log('shell ended', { pid: cur.pid, reason, seconds: Math.round((Date.now() - cur.startedAt) / 1000) });
    clearTimeout(grace);
    killGroup(cur.pid, 'SIGKILL');
    killTty(cur.tty);
    cur = undefined;
    remember();
  }

  /** At start: a shell left over from a jarvisd that died without its SIGTERM. Checks the pid is still that `script`. */
  function reapLeftover() {
    const saved = store.getState('shell');
    if (!saved) return;
    store.setState('shell', '');
    const { pid, tty } = JSON.parse(saved) as { pid: number; tty?: string };
    let command = '';
    try { command = execFileSync('/bin/ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }); } catch { /* gone */ }
    if (!command.includes('script -q /dev/null')) return log('shell from the last jarvisd was already gone', { pid });
    killGroup(pid, 'SIGKILL');
    killTty(tty);
    log('shell ended', { pid, reason: 'left over from the last jarvisd' });
  }

  return { open, close, input, interrupt, attach, killNow, reapLeftover, live: () => Boolean(cur) };
}
