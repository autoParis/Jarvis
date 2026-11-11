import { execFile } from 'node:child_process';
import { basename, join } from 'node:path';
import { openSync, readSync, closeSync, statSync, readdirSync, existsSync } from 'node:fs';

// Reading a Claude Code session from outside: its id, its model, its name, its tail, and who has it open. Two writers on
// one session are the danger. Claude does not refuse a second process, the session file branches, and the next resume
// follows one branch, so the other process's turn is lost (tried 2026-11-02). native.ts uses these checks before it
// resumes a session (Continue on phone, a native worker's respawn).

/** A transcript written this recently has a writer we may not see. */
export const FRESH_WRITE_MS = 10_000;
const TAIL = 256 * 1024;

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

/** `ps -axo pid=,command=`: one "<pid> <command line>" per process, for `holdersIn`. */
export const processTable = () => new Promise<string[]>((resolve, reject) => execFile('ps', ['-axo', 'pid=,command='], { maxBuffer: 20 * 1024 * 1024 }, (err, out) => err ? reject(err) : resolve(out.split('\n'))));

/** A process that has a session open, by its pid and what it is (its command line, or the listing's kind and name). */
export type Holder = { pid: number; what: string };
/**
 * The processes in a `processTable` whose command line names the session: a terminal's `claude --resume <id>`, the desktop
 * app's. A background session's host does not name its id, so callers add the `claude agents` pids too.
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
