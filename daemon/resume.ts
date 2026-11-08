import { spawn as nodeSpawn, execFile } from 'node:child_process';
import { basename, join } from 'node:path';
import { openSync, readSync, closeSync, statSync, readdirSync, existsSync } from 'node:fs';
import { cleanEnv } from './orca.ts';
import type { Log } from './log.ts';

// Continues a session that has no process Jarvis can type into: `claude -p --resume` or `codex exec resume`, one run per message.
// Two writers on one session are the danger. Claude does not refuse a second process, the session file branches, and the next
// resume follows one branch, so the other process's turn is lost (tried 2026-11-02). So this refuses while anything else writes.

/** No output from a run for this long means it hung; it is killed and the pane says so. */
export const RESUME_HANG_MS = 20 * 60_000;
/** A transcript written this recently has a writer we may not see. */
export const FRESH_WRITE_MS = 10_000;
/** Orca's chat tabs start Claude with this plugin. Such a process sits idle between turns and Orca has no verb to reach it. */
const ORCA_CHAT = 'native-chat-visuals';
const TAIL = 256 * 1024;

export type ResumeTarget = { rowId: string; file: string; cwd: string };
/** `warning`: it went out, but Orca's open chat tab will not see this turn. */
export type ResumeStart = { started: true; warning?: string } | { started: false; error: string };
type Spawned = { stdin: any; stdout: any; stderr: any; on: (ev: string, f: (...a: any[]) => void) => any; kill: () => any };

/** The session id in a transcript path: a Claude file is `<id>.jsonl`, a Codex file ends in `-<id>.jsonl`. */
export function sessionIdOf(file: string): string | undefined {
  return basename(file).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=\.jsonl$)/)?.[0];
}

/** The model of the session's last answer, so a resume does not switch model. */
export function lastModel(jsonl: string): string | undefined {
  // An answer's own record is `"model":"…","id":"msg_…"`. Other records name models too (a deferred tool's definition
  // said claude-opus-5-5 in a haiku session, 2026-11-08), so they count only when no answer is in the tail.
  return [...jsonl.matchAll(/"model":"(claude-[\w.-]+)","id":"msg_/g)].pop()?.[1] ?? [...jsonl.matchAll(/"model":"(claude-[\w.-]+)"/g)].pop()?.[1];
}

export function tailOf(file: string, bytes = TAIL): string {
  const size = statSync(file).size;
  const len = Math.min(bytes, size);
  const buf = Buffer.alloc(len);
  const fd = openSync(file, 'r');
  try { readSync(fd, buf, 0, len, size - len); } finally { closeSync(fd); }
  return buf.toString('utf8');
}

/** The exact command for one message. The text goes in on stdin, so it can never be read as a flag. */
export function resumeArgv(file: string, id: string, model?: string): string[] {
  if (file.includes('/.codex/')) return ['codex', 'exec', 'resume', '--json', '--skip-git-repo-check', '-c', 'sandbox_mode="workspace-write"', id, '-'];
  return ['claude', '-p', '--resume', id, '--output-format', 'stream-json', '--verbose', '--permission-mode', 'auto', ...(model ? ['--model', model] : []),
    // The hard lines the owner set for the brain hold here too: Sam merges, and nothing gets force-pushed.
    '--disallowedTools', 'Bash(gh pr merge:*)', 'Bash(git push --force:*)', 'Bash(git push -f:*)'];
}

const processList = () => new Promise<string[]>((resolve, reject) => execFile('ps', ['-axo', 'command'], { maxBuffer: 20 * 1024 * 1024 }, (err, out) => err ? reject(err) : resolve(out.split('\n'))));
/** `ps -axo pid=,command=`: one "<pid> <command line>" per process, for `holdersIn`. */
export const processTable = () => new Promise<string[]>((resolve, reject) => execFile('ps', ['-axo', 'pid=,command='], { maxBuffer: 20 * 1024 * 1024 }, (err, out) => err ? reject(err) : resolve(out.split('\n'))));

/** A process that has a session open, by its pid and what it is (its command line, or the listing's kind and name). */
export type Holder = { pid: number; what: string };
/**
 * The processes in a `processTable` whose command line names the session: a terminal's `claude --resume <id>`, the desktop
 * app's, an Orca chat tab's. A background session's host does not name its id, so callers add the `claude agents` pids too.
 */
export function holdersIn(lines: string[], id: string, self = process.pid): Holder[] {
  const out: Holder[] = [];
  for (const l of lines) {
    const m = l.match(/^\s*(\d+)\s+(.*)$/);
    if (!m || !m[2].includes(id) || Number(m[1]) === self) continue;
    // Only a Claude program writes a session: `claude`, the desktop app, or node running Claude Code. A shell, `grep` or
    // `tail` that only names the id is not a writer (a live check on 2026-11-08 caught a shell whose script named it).
    const [exe, arg1 = ''] = m[2].split(/\s+/);
    if (!/claude/i.test(basename(exe)) && !(/^(node|bun)$/.test(basename(exe)) && /claude/i.test(arg1))) continue;
    out.push({ pid: Number(m[1]), what: m[2].slice(0, 160) });
  }
  return out;
}

/**
 * A Claude session's transcript by its id, in any project folder under `<home>/.claude/projects`, and the folder it ran in
 * (the first `cwd` the file records). Undefined when no file has that id.
 */
export function findSession(id: string, home = process.env.HOME ?? ''): { file: string; cwd: string } | undefined {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) return undefined;
  const root = join(home, '.claude', 'projects');
  let dirs: string[] = [];
  try { dirs = readdirSync(root); } catch { return undefined; }
  for (const d of dirs) {
    const file = join(root, d, `${id}.jsonl`);
    if (!existsSync(file)) continue;
    const head = Buffer.alloc(Math.min(64 * 1024, statSync(file).size));
    const fd = openSync(file, 'r');
    try { readSync(fd, head, 0, head.length, 0); } finally { closeSync(fd); }
    const m = head.toString('utf8').match(/"cwd":"((?:[^"\\]|\\.)*)"/);
    if (!m) continue;
    try { return { file, cwd: JSON.parse(`"${m[1]}"`) }; } catch { continue; }
  }
  return undefined;
}

/** The session's name from its transcript: the last `custom-title`, else the last `agent-name`. */
export function sessionName(jsonl: string): string | undefined {
  const raw = [...jsonl.matchAll(/"customTitle":"((?:[^"\\]|\\.)*)"/g)].pop()?.[1] ?? [...jsonl.matchAll(/"agentName":"((?:[^"\\]|\\.)*)"/g)].pop()?.[1];
  if (raw === undefined) return undefined;
  try { return JSON.parse(`"${raw}"`) || undefined; } catch { return undefined; }
}

export function makeResumer(o: {
  log: Log; now?: () => number;
  /** Tests stand in for the process list, the file reads and the agent CLI. */
  processes?: () => Promise<string[]>;
  written?: (file: string) => number; tail?: (file: string) => string;
  spawn?: (argv: string[], cwd: string) => Spawned;
  onDone?: (rowId: string, ok: boolean) => void;
}) {
  const now = o.now ?? Date.now;
  const processes = o.processes ?? processList;
  const written = o.written ?? (f => statSync(f).mtimeMs);
  const tail = o.tail ?? (f => tailOf(f));
  const spawn = o.spawn ?? ((argv, cwd) => nodeSpawn(argv[0], argv.slice(1), { cwd, env: cleanEnv, stdio: ['pipe', 'pipe', 'pipe'] }));
  const running = new Set<string>();
  const failures = new Map<string, string>();

  return {
    busy: (rowId: string) => running.has(rowId),
    /** Why the last run failed, until the next message. */
    failure: (rowId: string) => failures.get(rowId),

    async send(t: ResumeTarget, text: string): Promise<ResumeStart> {
      const id = sessionIdOf(t.file);
      if (!id) return { started: false, error: 'This session has no id Jarvis can resume.' };
      if (running.has(t.rowId)) return { started: false, error: 'It is still answering your last message.' };
      running.add(t.rowId); // held across the checks, so a double tap cannot start two
      let holders: string[], age: number, model: string | undefined;
      try {
        holders = (await processes()).filter(l => l.includes(id));
        age = now() - written(t.file);
        model = lastModel(tail(t.file));
      } catch (e) {
        running.delete(t.rowId);
        return { started: false, error: `Not sent: could not check who else has this session open (${(e as Error).message}).` };
      }
      const orcaTab = holders.filter(l => l.includes(ORCA_CHAT));
      if (holders.length > orcaTab.length) { running.delete(t.rowId); return { started: false, error: 'Not sent: another process has this session open (a terminal or the Claude app). Two writers would lose a turn.' }; }
      if (age < FRESH_WRITE_MS) { running.delete(t.rowId); return { started: false, error: 'Not sent: this session was written to seconds ago. Send it again once it settles.' }; }

      failures.delete(t.rowId);
      const argv = resumeArgv(t.file, id, model);
      o.log('resume: started', { row: t.rowId, session: id, orcaTabOpen: orcaTab.length > 0 });
      const p = spawn(argv, t.cwd);
      let result: { ok: boolean; why?: string } | undefined;
      let stderr = '', partial = '';
      const finish = (ok: boolean, why?: string) => {
        if (!running.delete(t.rowId)) return;
        clearTimeout(hang);
        if (!ok) failures.set(t.rowId, why || 'The session did not answer.');
        o.log(ok ? 'resume: answered' : 'resume: failed', { row: t.rowId, session: id, ...(ok ? {} : { why }) });
        o.onDone?.(t.rowId, ok);
      };
      const armHang = () => setTimeout(() => { p.kill(); finish(false, 'It stopped answering, so Jarvis ended that run.'); }, RESUME_HANG_MS).unref();
      let hang = armHang();
      p.stdout.on('data', (d: Buffer) => {
        clearTimeout(hang);
        hang = armHang();
        partial += d;
        const lines = partial.split('\n');
        partial = lines.pop()!;
        for (const l of lines) {
          try {
            const e = JSON.parse(l);
            if (e.type === 'result') result = { ok: !e.is_error, why: e.is_error ? String(e.result ?? e.subtype ?? '').slice(0, 300) : undefined };
            if (e.type === 'turn.completed') result = { ok: true };
            if (e.type === 'turn.failed') result = { ok: false, why: String(e.error?.message ?? 'Codex failed').slice(0, 300) };
          } catch {}
        }
      });
      p.stderr.on('data', (d: Buffer) => { stderr = (stderr + d).slice(-300); });
      p.on('error', (e: Error) => finish(false, e.message));
      // "No error" is not an answer: only a success result from the CLI counts.
      p.on('close', (code: number | null) => finish(result?.ok === true, result?.why || stderr.trim() || `It exited with ${code} and no answer.`));
      p.stdin.on('error', () => {});
      p.stdin.end(text);
      return { started: true, ...(orcaTab.length ? { warning: "It went out, but this chat's Orca tab holds its own copy and won't see this turn. Keep this chat going in one place." } : {}) };
    },
  };
}
