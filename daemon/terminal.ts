import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import type { Log } from './log.ts';
import { PRODUCT_KEY } from './config.ts';

// Project terminals from the new-session picker. Each one is a tmux session, so it
// has a real pty and tmux draws vim, top and Claude Code. jarvisd never parses escape codes itself: it reads tmux's own
// screen with `capture-pane -e` and sends it to the page line by line. tmux keeps the sessions, so they survive a
// jarvisd restart, and `tmux attach -t <name>` picks one up in Terminal.app.
// Who may reach a terminal is decided in termgate.ts; this file trusts its caller.

export const TMUX = process.env.JARVIS_TMUX ?? '/opt/homebrew/bin/tmux';
export type TermKind = 'terminal' | 'codex';
export type TermInfo = { name: string; project: string; kind: TermKind; cwd: string; branch: string; createdAt: string; attached: number };
/** One screen as the page draws it: tmux's lines with their colour codes, and the cursor. */
export type Screen = { cols: number; rows: number; cursor: [number, number] | null; lines: string[] };
export type Frame = { cols: number; rows: number; cursor: [number, number] | null; lines?: string[]; d?: [number, string][] } | { ended: string };
export type TermViewer = (f: Frame) => void;

/** Short names for the session: `ev-1` for AcmeApp. */
const PREFIX: Record<string, string> = { jarvis: 'jv', [PRODUCT_KEY]: 'ev', fbm: 'fbm' };
export const NAME = /^[a-z]{1,8}-\d{1,4}$/;
export function sessionName(project: string, taken: string[]): string {
  const p = PREFIX[project] ?? (project.toLowerCase().replace(/[^a-z]/g, '').slice(0, 6) || 'term');
  for (let n = 1; ; n++) if (!taken.includes(`${p}-${n}`)) return `${p}-${n}`;
}

// Special keys the page may send, by tmux's own names, so tmux encodes them for the program's current mode.
export const KEYS = new Set(['Up', 'Down', 'Left', 'Right', 'Home', 'End', 'PageUp', 'PageDown', 'Delete', 'Insert', 'BTab', 'Enter', 'Tab', 'BSpace', 'Escape',
  ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`)]);
export type Key = { key: string } | { text: string };

/** The tmux commands that type `keys`: printable and control ASCII as hex bytes, anything else as literal UTF-8. */
export function keyCommands(name: string, keys: Key[]): string[] {
  const out: string[] = [];
  for (const k of keys) {
    if ('key' in k) { if (KEYS.has(k.key)) out.push(`send-keys -t ${name} ${k.key}`); continue; }
    if (typeof k.text !== 'string') continue;
    // Runs of ASCII and of non-ASCII. A non-ASCII run has no quote in it, so single quotes hold it as is.
    for (const run of k.text.match(/[\x00-\x7f]+|[^\x00-\x7f]+/g) ?? []) {
      if (run.charCodeAt(0) < 0x80) {
        for (let i = 0; i < run.length; i += 128) {
          out.push(`send-keys -t ${name} -H ${[...run.slice(i, i + 128)].map(c => c.charCodeAt(0).toString(16).padStart(2, '0')).join(' ')}`);
        }
      } else out.push(`send-keys -t ${name} -l '${run}'`);
    }
  }
  return out;
}

/** Lines that changed since `prev`, or every line when the size changed. */
export function diffScreen(prev: Screen | undefined, next: Screen): Frame {
  const head = { cols: next.cols, rows: next.rows, cursor: next.cursor };
  if (!prev || prev.cols !== next.cols || prev.rows !== next.rows || prev.lines.length !== next.lines.length) return { ...head, lines: next.lines };
  const d: [number, string][] = [];
  next.lines.forEach((l, i) => { if (l !== prev.lines[i]) d.push([i, l]); });
  return { ...head, d };
}

/** `display-message` output: cursor x, y, width, height, cursor shown. */
export function parseDisplay(s: string): { cols: number; rows: number; cursor: [number, number] | null } | undefined {
  const m = /^(\d+) (\d+) (\d+) (\d+) ([01])/.exec(s.trim());
  if (!m) return undefined;
  return { cols: Number(m[3]), rows: Number(m[4]), cursor: m[5] === '1' ? [Number(m[1]), Number(m[2])] : null };
}

const LIST_FORMAT = '#{session_name}\t#{@jarvis}\t#{@jarvis_project}\t#{@jarvis_kind}\t#{session_created}\t#{pane_current_path}\t#{session_attached}';
export function parseList(out: string): Omit<TermInfo, 'branch'>[] {
  return out.split('\n').map(l => l.split('\t')).filter(f => f.length >= 7 && f[1] === '1' && NAME.test(f[0])).map(f => ({
    name: f[0], project: f[2], kind: f[3] === 'codex' ? 'codex' : 'terminal', cwd: f[5],
    createdAt: new Date(Number(f[4]) * 1000).toISOString(), attached: Number(f[6]) || 0,
  }));
}

type Opts = { log: Log; env?: NodeJS.ProcessEnv; socket?: string; tmux?: string; throttleMs?: number };

export function makeTerminals({ log, env = process.env, socket, tmux = TMUX, throttleMs = 30 }: Opts) {
  const base = socket ? ['-L', socket] : [];
  const run = (args: string[], input?: string) => new Promise<string>((resolve, reject) => {
    const c = execFile(tmux, [...base, ...args], { timeout: 5000, env, maxBuffer: 4e6 }, (err, out, errOut) => err ? reject(new Error(String(errOut || err.message).trim())) : resolve(out));
    if (input !== undefined) { c.stdin?.end(input); }
  });
  const git = (cwd: string, args: string[]) => new Promise<string>(resolve =>
    execFile('/usr/bin/git', ['-C', cwd, ...args], { timeout: 5000, env }, (err, out) => resolve(err ? '' : out.trim())));

  let cache: TermInfo[] = [];
  async function list(): Promise<TermInfo[]> {
    const out = await run(['list-sessions', '-F', LIST_FORMAT]).catch(() => ''); // no server yet: no sessions
    const found = parseList(out);
    cache = await Promise.all(found.map(async t => ({ ...t, branch: cache.find(c => c.name === t.name && c.cwd === t.cwd)?.branch || await git(t.cwd, ['branch', '--show-current']) })));
    return cache;
  }
  const get = (name: string) => cache.find(t => t.name === name);

  /** A new session in `cwd`. A Codex session types `codex` into its shell, so the shell stays when Codex exits. */
  async function nextName(project: string): Promise<string> { await list(); return sessionName(project, cache.map(t => t.name)); }
  async function open(a: { project: string; cwd: string; kind: TermKind; cols?: number; rows?: number; name?: string }): Promise<TermInfo> {
    const name = a.name ?? await nextName(a.project);
    const cols = clamp(a.cols ?? 120, 20, 400), rows = clamp(a.rows ?? 36, 5, 200);
    await run(['new-session', '-d', '-s', name, '-c', a.cwd, '-x', String(cols), '-y', String(rows), '-e', 'JARVIS_TERMINAL=1']);
    await run(['set-option', '-t', name, '@jarvis', '1']);
    await run(['set-option', '-t', name, '@jarvis_project', a.project]);
    await run(['set-option', '-t', name, '@jarvis_kind', a.kind]);
    if (a.kind === 'codex') await run(['send-keys', '-t', name, '-l', 'codex']).then(() => run(['send-keys', '-t', name, 'Enter']));
    log('terminal started', { name, project: a.project, kind: a.kind, cwd: a.cwd });
    await list();
    return get(name)!;
  }

  type Live = { child: ChildProcess; queue: ((out: string, ok: boolean) => void)[]; viewers: Map<TermViewer, Screen | undefined>; dirty: boolean; busy: boolean; timer?: NodeJS.Timeout; last?: Screen; ended?: string };
  const live = new Map<string, Live>();

  /** One control client per session, shared by every page that shows it, and gone when the last page leaves. */
  function control(name: string): Live {
    const have = live.get(name);
    if (have) return have;
    const child = spawn(tmux, [...base, '-C', 'attach-session', '-t', name], { env, stdio: ['pipe', 'pipe', 'ignore'] });
    const l: Live = { child, queue: [], viewers: new Map(), dirty: true, busy: false };
    live.set(name, l);
    const decoder = new StringDecoder('utf8');
    let buf = '', block: string[] | null = null, mine = false;
    child.stdout!.on('data', (chunk: Buffer) => {
      buf += decoder.write(chunk);
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (block) {
          if (/^%(end|error) \d+ \d+ \d+$/.test(line)) {
            const ok = line.startsWith('%end');
            if (mine) l.queue.shift()?.(block.join('\n'), ok);
            block = null;
          } else block.push(line);
          continue;
        }
        const begin = /^%begin \d+ \d+ (\d+)$/.exec(line);
        // Flag 1 marks a command this client sent; the attach itself answers with flag 0.
        if (begin) { block = []; mine = (Number(begin[1]) & 1) === 1; continue; }
        if (line.startsWith('%output') || line.startsWith('%layout-change') || line.startsWith('%window') || line.startsWith('%session')) schedule(l, name);
        if (line.startsWith('%exit')) end(l, name, 'the session ended');
      }
    });
    child.stdin!.on('error', () => {});
    child.on('close', () => end(l, name, 'the session ended'));
    return l;
  }

  function command(l: Live, cmd: string): Promise<{ out: string; ok: boolean }> {
    return new Promise(resolve => {
      if (l.ended) return resolve({ out: '', ok: false });
      l.queue.push((out, ok) => resolve({ out, ok }));
      l.child.stdin!.write(`${cmd}\n`);
    });
  }

  function schedule(l: Live, name: string) {
    l.dirty = true;
    if (l.busy || l.timer || l.ended) return;
    l.timer = setTimeout(() => { l.timer = undefined; void refresh(l, name); }, throttleMs);
  }

  async function refresh(l: Live, name: string) {
    if (l.busy || l.ended) return;
    l.busy = true;
    while (l.dirty && !l.ended) {
      l.dirty = false;
      const d = await command(l, `display-message -p -t ${name} '#{cursor_x} #{cursor_y} #{pane_width} #{pane_height} #{cursor_flag}'`);
      const c = await command(l, `capture-pane -p -e -N -t ${name}`);
      const head = d.ok ? parseDisplay(d.out) : undefined;
      if (!head || !c.ok) continue;
      const lines = c.out.split('\n').slice(0, head.rows);
      while (lines.length < head.rows) lines.push('');
      const screen: Screen = { ...head, lines };
      l.last = screen;
      for (const [v, prev] of l.viewers) { l.viewers.set(v, screen); v(diffScreen(prev, screen)); }
    }
    l.busy = false;
  }

  function end(l: Live, name: string, reason: string) {
    if (l.ended) return;
    l.ended = reason;
    clearTimeout(l.timer);
    for (const cb of l.queue.splice(0)) cb('', false);
    for (const v of l.viewers.keys()) v({ ended: `The terminal ended: ${reason}.` });
    l.viewers.clear();
    if (live.get(name) === l) live.delete(name);
    try { l.child.kill(); } catch { /* gone */ }
  }

  /** A page shows the session from now on, at its size. Returns the call that removes it; the session keeps running. */
  function attach(name: string, v: TermViewer, size?: { cols: number; rows: number }): () => void {
    const l = control(name);
    l.viewers.set(v, undefined);
    if (size) void resize(name, size.cols, size.rows);
    if (l.last) { l.viewers.set(v, l.last); v(diffScreen(undefined, l.last)); }
    schedule(l, name);
    return () => {
      l.viewers.delete(v);
      if (!l.viewers.size && live.get(name) === l) { live.delete(name); l.ended = 'no page'; l.child.stdin!.end(); setTimeout(() => { try { l.child.kill(); } catch {} }, 1000); }
    };
  }

  async function resize(name: string, cols: number, rows: number) {
    const l = live.get(name);
    if (!l) return false;
    return (await command(l, `refresh-client -C ${clamp(cols, 20, 400)}x${clamp(rows, 5, 200)}`)).ok;
  }

  /** the owner's keys. Never logged: a terminal is where passwords are typed. */
  async function input(name: string, keys: Key[]): Promise<boolean> {
    const l = live.get(name);
    if (!l) return false;
    for (const cmd of keyCommands(name, keys)) if (!(await command(l, cmd)).ok) return false;
    return true;
  }

  /** A paste goes through a tmux buffer, bracketed when the program asked for it, so a multi-line paste does not run line by line. */
  async function paste(name: string, text: string): Promise<boolean> {
    const l = live.get(name);
    if (!l || !text) return false;
    const buffer = `jarvis-paste-${name}`;
    try { await run(['load-buffer', '-b', buffer, '-'], text); } catch { return false; }
    return (await command(l, `paste-buffer -p -d -b ${buffer} -t ${name}`)).ok;
  }

  /** End: kills the tmux session. Only a session Jarvis started. */
  async function kill(name: string): Promise<boolean> {
    await list();
    if (!get(name)) return false;
    const l = live.get(name);
    if (l) end(l, name, 'you tapped End');
    await run(['kill-session', '-t', name]).catch(() => {});
    log('terminal ended', { name });
    await list();
    return true;
  }

  return { list, get, nextName, open, attach, resize, input, paste, kill, current: () => cache };
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(Number(n) || lo)));
