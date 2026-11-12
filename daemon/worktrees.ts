// The daily worktree cleanup (a jarvisd task on the Scheduled tasks screen, id jarvisd:worktree-cleanup).
// It looks at the Claude Code worktrees in <repo>/.claude/worktrees of every repo a worker can start in (the
// `- Repo:` line of each project card in vault/projects) and removes one only when ALL of these are true:
//   1. its branch is merged into the repo's base branch, or its GitHub PR is merged or closed (and no PR of it is open);
//   2. `git status` shows no uncommitted or untracked change;
//   3. no native worker that is not finished uses it, and no running process has its folder (or a folder in it) as cwd;
//   4. its last change is more than 2 days old.
// It removes with `git worktree remove` without --force, so git itself refuses a dirty tree, then runs `git worktree prune`.
// It never deletes a branch. Plain code: no model call at run time.
import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

export const MIN_AGE_MS = 2 * 24 * 3_600_000;
const DAY = 24 * 3_600_000;

export type Exec = (cmd: string, args: string[], cwd?: string) => Promise<{ code: number; stdout: string; stderr: string }>;
export const execIn = (env?: NodeJS.ProcessEnv): Exec => (cmd, args, cwd) => new Promise(res => {
  execFile(cmd, args, { cwd, timeout: 60_000, maxBuffer: 32 * 1024 * 1024, env }, (err, stdout, stderr) => {
    const code = !err ? 0 : typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1;
    res({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') || (err ? err.message : '') });
  });
});

export type Repo = { name: string; path: string; base: string };
/** The repos of the project cards: an absolute path on the `- Repo:` line, and the base branch the card names (default master). */
export function projectRepos(cardsDir: string): Repo[] {
  if (!existsSync(cardsDir)) return [];
  return readdirSync(cardsDir).filter(f => f.endsWith('.md')).sort().flatMap(f => {
    const line = readFileSync(join(cardsDir, f), 'utf8').match(/^- Repo: `([^`]+)`.*$/m);
    if (!line || !isAbsolute(line[1])) return [];
    const base = line[0].match(/Base branch `([\w./-]+)`/)?.[1] ?? 'master';
    return [{ name: f.replace(/\.md$/, ''), path: line[1].replace(/\/+$/, ''), base }];
  });
}

export type Worker = { id: string; name: string; cwd: string; state: string; outcome: string | null };
export type Proc = { pid: number; command: string; cwd: string };
export type Pr = { number: number; state: string };

/** Everything the rule needs to know about one worktree. A null field means the check could not run. */
export type Facts = {
  path: string; branch: string | null; head: string; locked: boolean;
  /** HEAD is an ancestor of the base branch (local or origin). */
  inBase: boolean | null;
  /** The PRs whose head branch is this branch. null when GitHub could not be asked. */
  prs: Pr[] | null;
  /** Lines of `git status --porcelain`: uncommitted and untracked changes. */
  changes: number | null;
  workers: Worker[]; procs: Proc[] | null;
  /** The newest of: the HEAD commit time, the last HEAD reflog entry, the index file's mtime. */
  lastChange: number | null;
};
export type Verdict = { remove: boolean; reasons: string[] };

const BUSY_STATES = new Set(['starting', 'working', 'blocked']);
/** Finished: a done or failed outcome, and the session is idle (not starting, working or blocked). Every other worker counts as using it. */
export const finished = (w: Worker) => (w.outcome === 'done' || w.outcome === 'failed') && !BUSY_STATES.has(w.state);
const under = (dir: string, root: string) => dir === root || dir.startsWith(`${root}/`);
const days = (ms: number) => `${(ms / DAY).toFixed(1)} days`;

/** The rule. Every reason that keeps the worktree is listed, so the report says all of them at once. */
export function decide(f: Facts, base: string, now: number): Verdict {
  const reasons: string[] = [];
  const open = (f.prs ?? []).filter(p => p.state === 'OPEN');
  const shut = (f.prs ?? []).filter(p => p.state === 'MERGED' || p.state === 'CLOSED');
  if (open.length) reasons.push(`PR ${open.map(p => `#${p.number}`).join(', ')} is still open`);
  else if (f.inBase !== true && !shut.length) {
    const where = f.branch ? `branch ${f.branch}` : `detached HEAD ${f.head.slice(0, 8)}`;
    reasons.push(f.inBase === null ? `could not check if ${where} is in ${base}` : `${where} is not merged into ${base}`
      + (f.prs === null ? ', and GitHub could not be asked about its PR' : f.branch ? ', and it has no merged or closed PR' : ''));
  }
  if (f.changes === null) reasons.push('git status failed');
  else if (f.changes > 0) reasons.push(`${f.changes} uncommitted or untracked change${f.changes === 1 ? '' : 's'}`);
  const busy = f.workers.filter(w => !finished(w));
  if (busy.length) reasons.push(`used by native worker ${busy.map(w => `${w.name} (state ${w.state}${w.outcome ? `, outcome ${w.outcome}` : ''})`).join(', ')}`);
  if (f.procs === null) reasons.push('could not list the folders of running processes');
  else if (f.procs.length) reasons.push(`a running process uses it as its folder: ${f.procs.slice(0, 3).map(p => `${p.command} pid ${p.pid}`).join(', ')}${f.procs.length > 3 ? ` and ${f.procs.length - 3} more` : ''}`);
  if (f.lastChange === null) reasons.push('could not read its last change time');
  else if (now - f.lastChange <= MIN_AGE_MS) reasons.push(`last change ${days(Math.max(0, now - f.lastChange))} ago, not more than 2 days`);
  if (f.locked) reasons.push('git has it locked');
  return { remove: !reasons.length, reasons };
}

/** `git worktree list --porcelain`: every worktree that is not the main checkout. */
export function parseWorktrees(text: string): { path: string; head: string; branch: string | null; locked: boolean; prunable: boolean }[] {
  return text.split(/\n\n+/).map(b => b.trim()).filter(Boolean).slice(1).map(b => {
    const get = (k: string) => b.split('\n').find(l => l === k || l.startsWith(`${k} `));
    return {
      path: get('worktree')!.slice('worktree '.length), head: get('HEAD')?.slice(5) ?? '',
      branch: get('branch')?.slice('branch refs/heads/'.length) ?? null, locked: !!get('locked'), prunable: !!get('prunable'),
    };
  });
}

/** `lsof -Fpcn -d cwd`: the working folder of every process this user can see. */
export function parseLsof(text: string): Proc[] {
  const out: Proc[] = [];
  let pid = 0, command = '';
  for (const l of text.split('\n')) {
    if (l.startsWith('p')) pid = Number(l.slice(1));
    else if (l.startsWith('c')) command = l.slice(1);
    else if (l.startsWith('n') && pid) out.push({ pid, command, cwd: l.slice(1) });
  }
  return out;
}

export type Item = { repo: string; path: string; branch: string | null; verdict: Verdict; removed?: boolean; error?: string };
export type Result = { at: number; mode: 'dry-run' | 'delete'; items: Item[]; repoErrors: string[] };

export type CleanDeps = {
  repos: () => Repo[]; workers: () => Worker[]; exec: Exec; now?: () => number;
  log?: (m: string, f?: Record<string, unknown>) => void;
};

/** One cleanup pass. `dry-run` decides and reports. `delete` also runs git worktree remove on each worktree the rule allows. */
export async function cleanWorktrees(d: CleanDeps, mode: 'dry-run' | 'delete'): Promise<Result> {
  const now = (d.now ?? Date.now)();
  const items: Item[] = [], repoErrors: string[] = [];
  const lsof = await d.exec('lsof', ['-n', '-P', '-w', '-d', 'cwd', '-Fpcn']);
  // lsof exits 1 when some process could not be read, but still prints the rest.
  const procs: Proc[] | null = lsof.stdout.trim() ? parseLsof(lsof.stdout) : null;
  const workers = d.workers();
  for (const repo of d.repos()) {
    const root = join(repo.path, '.claude', 'worktrees');
    const list = await d.exec('git', ['-C', repo.path, 'worktree', 'list', '--porcelain']);
    if (list.code) { repoErrors.push(`${repo.name}: git worktree list failed: ${list.stderr.trim()}`); d.log?.('worktree cleanup: repo skipped', { repo: repo.name, error: list.stderr.trim() }); continue; }
    const trees = parseWorktrees(list.stdout).filter(t => !t.prunable && t.path.startsWith(`${root}/`));
    const refs = ['--verify', '--quiet'];
    const bases = (await Promise.all([repo.base, `origin/${repo.base}`].map(async r => (await d.exec('git', ['-C', repo.path, 'rev-parse', ...refs, `${r}^{commit}`])).code ? null : r))).filter(Boolean) as string[];
    if (!bases.length) repoErrors.push(`${repo.name}: base branch ${repo.base} not found`);
    const prsByBranch = await prList(d.exec, repo.path);
    if (!prsByBranch) repoErrors.push(`${repo.name}: gh pr list failed, so only the merged-into-${repo.base} test counts`);
    for (const t of trees) {
      const f = await facts(d.exec, t, bases, prsByBranch, workers, procs);
      const verdict = decide(f, repo.base, now);
      const item: Item = { repo: repo.name, path: t.path, branch: t.branch, verdict };
      if (verdict.remove && mode === 'delete') {
        const r = await d.exec('git', ['-C', repo.path, 'worktree', 'remove', t.path]);
        item.removed = !r.code;
        if (r.code) item.error = r.stderr.trim() || `exit code ${r.code}`;
        d.log?.(r.code ? 'worktree cleanup: git refused the removal' : 'worktree cleanup: removed', { repo: repo.name, path: t.path, branch: t.branch, ...(item.error ? { error: item.error } : {}) });
      } else d.log?.(verdict.remove ? 'worktree cleanup: would remove (dry run)' : 'worktree cleanup: kept', { repo: repo.name, path: t.path, branch: t.branch, ...(verdict.remove ? {} : { reasons: verdict.reasons }) });
      items.push(item);
    }
    if (mode === 'delete') {
      const p = await d.exec('git', ['-C', repo.path, 'worktree', 'prune']);
      if (p.code) repoErrors.push(`${repo.name}: git worktree prune failed: ${p.stderr.trim()}`);
    }
  }
  return { at: now, mode, items, repoErrors };
}

async function prList(exec: Exec, repoPath: string): Promise<Map<string, Pr[]> | null> {
  const r = await exec('gh', ['pr', 'list', '--state', 'all', '--limit', '1000', '--json', 'number,state,headRefName'], repoPath);
  if (r.code) return null;
  try {
    const map = new Map<string, Pr[]>();
    for (const p of JSON.parse(r.stdout) as { number: number; state: string; headRefName: string }[]) map.set(p.headRefName, [...(map.get(p.headRefName) ?? []), { number: p.number, state: p.state }]);
    return map;
  } catch { return null; }
}

async function facts(exec: Exec, t: ReturnType<typeof parseWorktrees>[number], bases: string[], prs: Map<string, Pr[]> | null, workers: Worker[], procs: Proc[] | null): Promise<Facts> {
  const git = (...a: string[]) => exec('git', ['--no-optional-locks', '-C', t.path, ...a]);
  // Age first, before anything that could write the index.
  const times: number[] = [];
  const ct = await git('log', '-1', '--format=%ct', 'HEAD');
  if (!ct.code && /^\d+$/.test(ct.stdout.trim())) times.push(Number(ct.stdout.trim()) * 1000);
  const rl = await git('log', '-g', '-1', '--date=unix', '--format=%gd', 'HEAD');
  const rlAt = /\{(\d+)\}/.exec(rl.stdout)?.[1];
  if (rlAt) times.push(Number(rlAt) * 1000);
  const ix = await git('rev-parse', '--git-path', 'index');
  const ixPath = ix.code ? '' : resolve(t.path, ix.stdout.trim());
  try { if (ixPath) times.push(statSync(ixPath).mtimeMs); } catch { /* no index yet */ }
  const st = await git('status', '--porcelain');
  let inBase: boolean | null = bases.length ? false : null;
  for (const b of bases) {
    const r = await exec('git', ['-C', t.path, 'merge-base', '--is-ancestor', 'HEAD', b]);
    if (!r.code) { inBase = true; break; }
    if (r.code !== 1) inBase = inBase || null;
  }
  return {
    path: t.path, branch: t.branch, head: t.head, locked: t.locked, inBase,
    prs: prs === null ? null : t.branch ? prs.get(t.branch) ?? [] : [],
    changes: st.code ? null : st.stdout.split('\n').filter(Boolean).length,
    workers: workers.filter(w => under(w.cwd.replace(/\/+$/, ''), t.path)),
    procs: procs === null ? null : procs.filter(p => under(p.cwd, t.path)),
    lastChange: times.length ? Math.max(...times) : null,
  };
}

/** The run record: an outcome, a one-line note for the strip, and the full list for the run history. */
export function summarize(r: Result): { outcome: 'ok' | 'warn' | 'fail'; note: string; detail: string } {
  const removed = r.items.filter(i => i.removed), refused = r.items.filter(i => i.verdict.remove && i.error), would = r.items.filter(i => i.verdict.remove && r.mode === 'dry-run');
  const kept = r.items.filter(i => !i.verdict.remove);
  const head = r.mode === 'dry-run' ? `Dry run: would remove ${would.length}, keep ${kept.length}.` : `Removed ${removed.length}, kept ${kept.length}${refused.length ? `, git refused ${refused.length}` : ''}.`;
  const note = `${head}${r.repoErrors.length ? ` ${r.repoErrors.join(' ')}` : ''}`;
  const line = (i: Item) => `${i.repo} ${i.path.split('/').at(-1)} (${i.branch ?? 'detached'})`;
  const detail = [
    ...(r.mode === 'dry-run' ? would.map(i => `WOULD REMOVE ${line(i)}`) : removed.map(i => `REMOVED ${line(i)}`)),
    ...refused.map(i => `GIT REFUSED ${line(i)}: ${i.error}`),
    ...kept.map(i => `KEPT ${line(i)}: ${i.verdict.reasons.join('; ')}`),
    ...r.repoErrors.map(e => `REPO ${e}`),
  ].join('\n');
  const outcome = r.items.length === 0 && r.repoErrors.length && r.repoErrors.every(e => /worktree list failed|not found/.test(e)) ? 'fail'
    : refused.length || r.repoErrors.length ? 'warn' : 'ok';
  return { outcome, note, detail };
}

/** The dry-run report for the owner: what the rule would remove and what it keeps, with every reason. */
export function reportMarkdown(r: Result, repos: Repo[], sizesKb: Map<string, number> = new Map()): string {
  const at = new Date(r.at).toLocaleString('en-US', { timeZone: 'America/Toronto', dateStyle: 'medium', timeStyle: 'short' });
  const size = (kb: number) => kb >= 1024 * 1024 ? `${(kb / 1024 / 1024).toFixed(1)} GB` : `${Math.round(kb / 1024)} MB`;
  const sum = (list: Item[]) => list.reduce((n, i) => n + (sizesKb.get(i.path) ?? 0), 0);
  const sized = (list: Item[]) => sizesKb.size ? `, ${size(sum(list))}` : '';
  const rows = (list: Item[], why: boolean) => list.map(i => `| ${i.repo} | ${i.path.split('/').at(-1)} | ${i.branch ?? 'detached'} | ${sizesKb.has(i.path) ? size(sizesKb.get(i.path)!) : ''} |${why ? ` ${i.verdict.reasons.join('; ').replace(/\|/g, '/')} |` : ''}`).join('\n');
  const would = r.items.filter(i => i.verdict.remove), kept = r.items.filter(i => !i.verdict.remove);
  const per = repos.map(p => {
    const mine = r.items.filter(i => i.repo === p.name), w = mine.filter(i => i.verdict.remove), k = mine.filter(i => !i.verdict.remove);
    return `- ${p.name} (base \`${p.base}\`): ${mine.length} worktrees${sized(mine)}. Would remove ${w.length}${sized(w)}. Keep ${k.length}${sized(k)}.`;
  });
  const reasonCount = new Map<string, number>();
  for (const i of kept) for (const x of i.verdict.reasons) { const k = x.replace(/#\d+(, #\d+)*/g, '#N').replace(/[\d.]+ days/, 'N days').replace(/^\d+ uncommitted or untracked changes?/, 'N uncommitted or untracked changes').replace(/branch \S+|detached HEAD \S+/, 'the branch').replace(/worker .*$/, 'worker (not finished)').replace(/folder: .*$/, 'folder'); reasonCount.set(k, (reasonCount.get(k) ?? 0) + 1); }
  return `# Worktree cleanup: dry run

Run ${at} Eastern. Mode \`${r.mode}\`. Nothing was deleted.

## Summary

${per.join('\n')}
${r.repoErrors.length ? `\nRepo problems:\n${r.repoErrors.map(e => `- ${e}`).join('\n')}\n` : ''}
Why worktrees stay (one worktree can have several reasons):

${[...reasonCount].sort((a, b) => b[1] - a[1]).map(([k, n]) => `- ${n}: ${k}`).join('\n') || '- none'}

## Would remove (${would.length})

| Repo | Worktree | Branch | Size |
|---|---|---|---|
${rows(would, false)}

## Keep (${kept.length})

| Repo | Worktree | Branch | Size | Reasons |
|---|---|---|---|---|
${rows(kept, true)}
`;
}
