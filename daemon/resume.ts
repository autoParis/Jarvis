import { spawn as nodeSpawn, execFile } from 'node:child_process';
import { basename } from 'node:path';
import { openSync, readSync, closeSync, statSync } from 'node:fs';
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
  return [...jsonl.matchAll(/"model":"(claude-[\w.-]+)"/g)].pop()?.[1];
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
