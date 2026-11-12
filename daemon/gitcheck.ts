// The start-up check that a worker can still commit. On 2026-11-08 two workers finished with passing tests and no
// commit: a Claude Code hook rewrote `git` to `rtk git`, and Claude Code refuses that in a worker's worktree. An update
// of that hook can bring it back, so jarvisd replays a worker's `git add` and `git commit` through the same Bash hooks
// in a scratch worktree each time it starts, and tells the owner which hook stopped them.
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** One PreToolUse hook command and the settings file it came from. */
export type Hook = { command: string; from: string };
export type Exec = (cmd: string, args: string[], o: { cwd: string; input?: string }) => Promise<{ code: number; out: string; err: string }>;
export type GitCheck = { ok: true } | { ok: false; hook?: string; why: string };

/** The settings files Claude Code reads hooks from for a session in `repo`, in its order. */
export const settingsFiles = (repo: string) =>
  [join(homedir(), '.claude', 'settings.json'), join(repo, '.claude', 'settings.json'), join(repo, '.claude', 'settings.local.json')];

/** A hook matcher is a tool name or a pattern. Empty and `*` match every tool. */
function matchesBash(m: unknown): boolean {
  if (m === undefined || m === '' || m === '*') return true;
  if (typeof m !== 'string') return false;
  try { return new RegExp(`^(?:${m})$`).test('Bash'); } catch { return m === 'Bash'; }
}

/** Every PreToolUse command hook that runs on a Bash call, from the files that exist, in order. */
export function bashHooks(files: string[]): Hook[] {
  const hooks: Hook[] = [];
  for (const from of files) {
    let s: any;
    try { s = JSON.parse(readFileSync(from, 'utf8')); } catch { continue; }
    for (const group of s?.hooks?.PreToolUse ?? []) {
      if (!matchesBash(group?.matcher)) continue;
      for (const h of group?.hooks ?? []) if (h?.type === 'command' && typeof h.command === 'string') hooks.push({ command: h.command, from });
    }
  }
  return hooks;
}

export const exec: Exec = (cmd, args, { cwd, input }) => new Promise(resolve => {
  const p = execFile(cmd, args, { cwd, timeout: 30_000, env: { ...process.env, CLAUDE_PROJECT_DIR: cwd } }, (err, out, errOut) => {
    const code = !err ? 0 : typeof (err as any).code === 'number' ? (err as any).code : 1;
    resolve({ code, out: String(out), err: String(errOut || (err ? err.message : '')) });
  });
  p.stdin?.end(input ?? '');
});

/** The hook path as the owner would type it. */
export const shortPath = (s: string) => s.split(homedir()).join('~');

/**
 * A Bash command through the hooks, the way a worker's Claude Code runs it: each hook gets the tool call on stdin and
 * may block it or rewrite it. Returns the command as the hooks left it, or the hook that stopped it.
 */
export async function throughHooks(hooks: Hook[], command: string, cwd: string, run: Exec = exec): Promise<{ ok: true; command: string } | { ok: false; hook: string; why: string }> {
  let cmd = command;
  for (const h of hooks) {
    const input = JSON.stringify({ session_id: 'jarvis-selfcheck', transcript_path: '', cwd, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: cmd, description: 'Jarvis start-up git check' } });
    const r = await run('/bin/sh', ['-c', h.command], { cwd, input });
    let out: any;
    try { out = JSON.parse(r.out); } catch {}
    const spec = out?.hookSpecificOutput;
    if (r.code === 2 || spec?.permissionDecision === 'deny' || out?.decision === 'block') {
      const reason = String(spec?.permissionDecisionReason ?? out?.reason ?? r.err).trim().slice(0, 200);
      return { ok: false, hook: h.command, why: `it blocked \`${cmd}\`${reason ? `: ${reason}` : ''}` };
    }
    const next = spec?.updatedInput?.command;
    if (typeof next === 'string' && next !== cmd) {
      // Claude Code refuses a git call in a worktree session when the command no longer starts with plain git.
      if (!/^git\s/.test(next)) return { ok: false, hook: h.command, why: `it changed \`${cmd}\` to \`${next}\`, and Claude Code refuses that in a worker's worktree` };
      cmd = next;
    }
  }
  return { ok: true, command: cmd };
}

/**
 * In a scratch worktree of `repo` under `.claude/worktrees/`, where workers run, does `git add` and `git commit`
 * through the Bash hooks, then removes the worktree. The worktree is detached, so no branch is left behind.
 */
export async function gitSelfCheck(repo: string, o: { hooks?: Hook[]; run?: Exec } = {}): Promise<GitCheck> {
  const run = o.run ?? exec;
  const hooks = o.hooks ?? bashHooks(settingsFiles(repo));
  const dir = join(repo, '.claude', 'worktrees', `jarvis-selfcheck-${process.pid}`);
  const made = await run('git', ['-C', repo, 'worktree', 'add', '--detach', dir, 'HEAD'], { cwd: repo });
  if (made.code) return { ok: false, why: `could not make the scratch worktree: ${(made.err || made.out).trim().slice(0, 200)}` };
  try {
    writeFileSync(join(dir, 'jarvis-selfcheck.txt'), `${new Date().toISOString()}\n`);
    for (const command of ['git add jarvis-selfcheck.txt', 'git commit -m "Jarvis start-up git check"']) {
      const h = await throughHooks(hooks, command, dir, run);
      if (!h.ok) return h;
      const r = await run('/bin/sh', ['-c', h.command], { cwd: dir });
      if (r.code) return { ok: false, why: `\`${h.command}\` failed: ${(r.err || r.out).trim().slice(0, 200)}` };
    }
    return { ok: true };
  } finally {
    await run('git', ['-C', repo, 'worktree', 'remove', '--force', dir], { cwd: repo });
  }
}

/** The one line the owner gets when the check fails. */
export function gitNotice(r: Exclude<GitCheck, { ok: true }>): string {
  if (r.hook) return `Workers cannot commit. The hook ${shortPath(r.hook)} stops it: ${r.why}.`;
  return `Workers may not be able to commit. The start-up git check failed: ${r.why}.`;
}
