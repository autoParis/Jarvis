import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { decide, finished, parseWorktrees, parseLsof, projectRepos, cleanWorktrees, summarize, execIn, MIN_AGE_MS, type Facts, type Exec, type Worker } from './worktrees.ts';
import { makeTasks, calendarHit, type Run } from './tasks.ts';

const NOW = Date.parse('2026-11-12T15:00:00Z');
const OLD = NOW - MIN_AGE_MS - 3_600_000;
const ok: Facts = { path: '/r/.claude/worktrees/a', branch: 'a', head: 'abc123def', locked: false, inBase: true, prs: [], changes: 0, workers: [], procs: [], lastChange: OLD };
const w = (state: string, outcome: string | null): Worker => ({ id: 'x', name: 'wk', cwd: ok.path, state, outcome });

test('the rule removes a worktree only when all four conditions hold', () => {
  assert.deepEqual(decide(ok, 'staging', NOW), { remove: true, reasons: [] });
  // 1. merged into the base, or its PR merged or closed; an open PR always keeps it
  assert.match(decide({ ...ok, inBase: false }, 'staging', NOW).reasons.join(), /branch a is not merged into staging, and it has no merged or closed PR/);
  assert.equal(decide({ ...ok, inBase: false, prs: [{ number: 7, state: 'MERGED' }] }, 'staging', NOW).remove, true);
  assert.equal(decide({ ...ok, inBase: false, prs: [{ number: 7, state: 'CLOSED' }] }, 'staging', NOW).remove, true);
  assert.match(decide({ ...ok, prs: [{ number: 7, state: 'CLOSED' }, { number: 9, state: 'OPEN' }] }, 'staging', NOW).reasons.join(), /PR #9 is still open/);
  assert.match(decide({ ...ok, inBase: false, prs: null }, 'staging', NOW).reasons.join(), /GitHub could not be asked/);
  assert.equal(decide({ ...ok, inBase: null, prs: [] }, 'staging', NOW).remove, false);
  // 2. no uncommitted or untracked change
  assert.match(decide({ ...ok, changes: 2 }, 'staging', NOW).reasons.join(), /2 uncommitted or untracked changes/);
  assert.equal(decide({ ...ok, changes: null }, 'staging', NOW).remove, false);
  // 3. no worker that is not finished, no process with its folder as cwd
  for (const x of [w('working', null), w('blocked', 'done'), w('starting', null), w('stopped', null), w('abandoned', null), w('working', 'done')]) {
    assert.equal(decide({ ...ok, workers: [x] }, 'staging', NOW).remove, false, `${x.state}/${x.outcome}`);
  }
  for (const x of [w('done', 'done'), w('stopped', 'failed'), w('done', 'failed')]) assert.equal(decide({ ...ok, workers: [x] }, 'staging', NOW).remove, true, `${x.state}/${x.outcome}`);
  assert.match(decide({ ...ok, procs: [{ pid: 42, command: 'node', cwd: ok.path }] }, 'staging', NOW).reasons.join(), /node pid 42/);
  assert.match(decide({ ...ok, procs: null }, 'staging', NOW).reasons.join(), /could not list/);
  // 4. last change more than 2 days ago
  assert.match(decide({ ...ok, lastChange: NOW - MIN_AGE_MS }, 'staging', NOW).reasons.join(), /last change 2\.0 days ago/);
  assert.equal(decide({ ...ok, lastChange: null }, 'staging', NOW).remove, false);
  assert.equal(decide({ ...ok, locked: true }, 'staging', NOW).remove, false);
  // every reason is listed at once
  assert.equal(decide({ ...ok, inBase: false, changes: 1, workers: [w('working', null)], lastChange: NOW }, 'staging', NOW).reasons.length, 4);
  assert.equal(finished(w('done', 'done')), true);
});

test('the parsers read git, lsof and the project cards', () => {
  const list = 'worktree /r\nHEAD aaa\nbranch refs/heads/master\n\nworktree /r/.claude/worktrees/a\nHEAD bbb\nbranch refs/heads/worktree-a\n\nworktree /r/.claude/worktrees/b\nHEAD ccc\ndetached\nlocked reason\n\nworktree /gone\nHEAD ddd\nprunable gitdir file points to non-existent location\n';
  assert.deepEqual(parseWorktrees(list), [
    { path: '/r/.claude/worktrees/a', head: 'bbb', branch: 'worktree-a', locked: false, prunable: false },
    { path: '/r/.claude/worktrees/b', head: 'ccc', branch: null, locked: true, prunable: false },
    { path: '/gone', head: 'ddd', branch: null, locked: false, prunable: true },
  ]);
  assert.deepEqual(parseLsof('p12\ncnode\nfcwd\nn/r/x\np13\nczsh\nfcwd\nn/\n'), [{ pid: 12, command: 'node', cwd: '/r/x' }, { pid: 13, command: 'zsh', cwd: '/' }]);
  const dir = mkdtempSync(join(tmpdir(), 'wt-cards-'));
  writeFileSync(join(dir, 'app.md'), '# App\n- Repo: `/x/app`, GitHub `o/app`. Base branch `staging`.\n');
  writeFileSync(join(dir, 'self.md'), '- Repo: `/x/self/`. Base branch `master`.\n');
  writeFileSync(join(dir, 'tpl.md'), '- Repo: `<absolute path of the local clone>`. Base branch `<main or staging>`.\n');
  writeFileSync(join(dir, 'none.md'), 'no repo line\n');
  assert.deepEqual(projectRepos(dir), [{ name: 'app', path: '/x/app', base: 'staging' }, { name: 'self', path: '/x/self', base: 'master' }]);
});

// A real repo with four worktrees in .claude/worktrees. lsof and gh are faked; git is real.
function fixture() {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'wt-repo-')));
  const git = (...a: string[]) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  git('init', '-q', '-b', 'master');
  writeFileSync(join(repo, 'f'), '1');
  git('add', 'f'); git('commit', '-qm', 'one');
  const wt = (n: string) => join(repo, '.claude', 'worktrees', n);
  mkdirSync(join(repo, '.claude', 'worktrees'), { recursive: true });
  for (const n of ['merged', 'dirty', 'busy', 'open', 'closedpr']) git('worktree', 'add', '-q', '-b', `worktree-${n}`, wt(n));
  writeFileSync(join(wt('dirty'), 'new.txt'), 'x');
  for (const n of ['open', 'closedpr']) { writeFileSync(join(wt(n), 'g'), n); execFileSync('git', ['-C', wt(n), 'add', 'g']); execFileSync('git', ['-C', wt(n), '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', n]); }
  writeFileSync(join(repo, 'unmerged-note'), '');
  const real = execIn();
  const exec: Exec = async (cmd, args, cwd) => cmd === 'lsof' ? { code: 0, stdout: 'p1\nczsh\nn/\n', stderr: '' }
    : cmd === 'gh' ? { code: 0, stdout: JSON.stringify([{ number: 5, state: 'OPEN', headRefName: 'worktree-open' }, { number: 6, state: 'CLOSED', headRefName: 'worktree-closedpr' }]), stderr: '' }
    : real(cmd, args, cwd);
  const workers: Worker[] = [{ id: 'w1', name: 'busy-worker', cwd: wt('busy'), state: 'working', outcome: null }];
  return { repo, git, wt, exec, workers, deps: { repos: () => [{ name: 'app', path: repo, base: 'master' }], workers: () => workers, exec, now: () => Date.now() + MIN_AGE_MS + 3_600_000 } };
}

test('a real run removes only the worktrees the rule allows, keeps every branch, and a dry run removes nothing', async () => {
  const f = fixture();
  const dry = await cleanWorktrees(f.deps, 'dry-run');
  assert.deepEqual(dry.items.filter(i => i.verdict.remove).map(i => i.branch).sort(), ['worktree-closedpr', 'worktree-merged']);
  assert.ok(existsSync(f.wt('merged')) && existsSync(f.wt('closedpr')), 'the dry run removed nothing');
  const reasons = Object.fromEntries(dry.items.map(i => [i.branch, i.verdict.reasons.join('; ')]));
  assert.match(reasons['worktree-dirty'], /1 uncommitted or untracked change/);
  assert.match(reasons['worktree-busy'], /native worker busy-worker \(state working\)/);
  assert.match(reasons['worktree-open'], /PR #5 is still open/);

  const real = await cleanWorktrees(f.deps, 'delete');
  assert.deepEqual(real.items.filter(i => i.removed).map(i => i.branch).sort(), ['worktree-closedpr', 'worktree-merged']);
  assert.ok(!existsSync(f.wt('merged')) && !existsSync(f.wt('closedpr')));
  assert.ok(existsSync(f.wt('dirty')) && existsSync(join(f.wt('dirty'), 'new.txt')) && existsSync(f.wt('busy')) && existsSync(f.wt('open')));
  const branches = f.git('branch', '--format=%(refname:short)').split('\n').filter(Boolean);
  for (const n of ['merged', 'dirty', 'busy', 'open', 'closedpr']) assert.ok(branches.includes(`worktree-${n}`), `branch worktree-${n} kept`);
  assert.doesNotMatch(f.git('worktree', 'list'), /merged|closedpr/);
});

test('git itself refuses a dirty tree even when the rule is fooled', async () => {
  const f = fixture();
  // A lying status: the rule sees the dirty worktree as clean, so only git stands between it and the untracked file.
  const lying: Exec = async (cmd, args, cwd) => cmd === 'git' && args.includes('status') ? { code: 0, stdout: '', stderr: '' } : f.exec(cmd, args, cwd);
  const r = await cleanWorktrees({ ...f.deps, exec: lying }, 'delete');
  const dirty = r.items.find(i => i.branch === 'worktree-dirty')!;
  assert.equal(dirty.verdict.remove, true);
  assert.equal(dirty.removed, false);
  assert.match(dirty.error!, /untracked|modified/);
  assert.ok(existsSync(join(f.wt('dirty'), 'new.txt')));
  assert.equal(summarize(r).outcome, 'warn');
});

test('each run leaves a task_runs row with its time, outcome and every worktree removed or kept with the reason', async () => {
  const f = fixture();
  const db = new DatabaseSync(':memory:'), state = new Map<string, string>();
  const at = Date.parse('2026-11-12T11:00:00Z');
  const noRun: Run = async () => ({ code: 1, stdout: '', stderr: '' });
  const tasks = makeTasks({
    db, run: noRun, uid: 501, agentsDir: join(tmpdir(), 'no-such-agents-dir'), prefixes: ['x.'], locked: [], now: () => at,
    jarvisd: [{ id: 'jarvisd:worktree-cleanup', name: 'Worktree cleanup', schedule: 'Every day at 6 AM', cron: '0 6 * * *', everyMs: 86_400_000, description: 'd' }],
    getState: k => state.get(k), setState: (k, v) => { state.set(k, v); },
  });
  const s = summarize(await cleanWorktrees(f.deps, 'delete'));
  tasks.record('jarvisd:worktree-cleanup', s.outcome, s.note, undefined, s.detail);
  const row = db.prepare("SELECT at, outcome, note, detail FROM task_runs WHERE task = 'jarvisd:worktree-cleanup'").get() as { at: number; outcome: string; note: string; detail: string };
  assert.equal(row.at, at);
  assert.equal(row.outcome, 'ok');
  assert.equal(row.note, 'Removed 2, kept 3.');
  const lines = row.detail.split('\n');
  assert.ok(lines.includes('REMOVED app merged (worktree-merged)'));
  assert.ok(lines.includes('REMOVED app closedpr (worktree-closedpr)'));
  assert.ok(lines.some(l => /^KEPT app dirty \(worktree-dirty\): 1 uncommitted or untracked change$/.test(l)));
  assert.ok(lines.some(l => /^KEPT app busy \(worktree-busy\): used by native worker busy-worker/.test(l)));
  assert.ok(lines.some(l => /^KEPT app open \(worktree-open\): PR #5 is still open$/.test(l)));
  // The screen shows the run: its mark in the strip and the full list in the open row.
  const t = (await tasks.list()).find(x => x.id === 'jarvisd:worktree-cleanup')!;
  assert.equal(t.lastRun?.detail, row.detail);
  assert.equal(t.lastRun?.at, new Date(at).toISOString());
  assert.equal(t.marks.at(-1)?.note, 'Removed 2, kept 3.');
});

test('the cleanup schedule is daily by default, the screen can change it, and a start time fires once', async () => {
  const db = new DatabaseSync(':memory:'), state = new Map<string, string>();
  let at = new Date(2026, 10, 12, 5, 58).getTime();
  const tasks = makeTasks({
    db, run: async () => ({ code: 1, stdout: '', stderr: '' }), uid: 501, agentsDir: join(tmpdir(), 'no-such-agents-dir'), prefixes: ['x.'], locked: [], now: () => at,
    jarvisd: [{ id: 'jarvisd:wc', name: 'Worktree cleanup', schedule: 'Every day at 6 AM', cron: '0 6 * * *', everyMs: 86_400_000, description: 'default' },
      { id: 'jarvisd:check', name: 'Check', schedule: 'Every 10 minutes', everyMs: 600_000, description: '' }],
    getState: k => state.get(k), setState: (k, v) => { state.set(k, v); },
  });
  const id = 'jarvisd:wc', tick = (min: number) => { at += min * 60_000; return tasks.claimDue(id); };
  assert.equal(tasks.claimDue(id), false, 'the first call only sets the baseline');
  assert.equal(tick(1), false); // 5:59
  assert.equal(tick(1), true); // 6:00
  assert.equal(tick(1), false); // 6:01: fired once
  assert.equal(tick(24 * 60 + 30), true, 'a start time missed while jarvisd was down still runs on the next check');
  let t = (await tasks.list()).find(x => x.id === id)!;
  assert.equal(t.schedule, 'Every day at 6 AM');
  assert.equal(t.cron, '0 6 * * *');
  assert.equal(t.editable, true);
  assert.equal(t.strip, 'runs');
  // The owner moves it to 5:30 from the screen.
  assert.equal((await tasks.save(id, '30 5 * * *', 'my words')).status, 200);
  t = (await tasks.list()).find(x => x.id === id)!;
  assert.equal(t.schedule, 'Every day at 5:30 AM');
  assert.equal(t.description, 'my words');
  at = new Date(2026, 10, 14, 5, 29).getTime(); tasks.claimDue(id);
  assert.equal(tick(1), true); // 5:30
  assert.equal((await tasks.save(id, 'nonsense', '')).status, 400);
  assert.equal((await tasks.save('jarvisd:check', '0 6 * * *', '')).status, 403, 'a timer without a cron stays in the code');
  assert.equal((await tasks.list()).find(x => x.id === 'jarvisd:check')!.editable, false);
  assert.equal(calendarHit([{ Hour: 6, Minute: 0, Weekday: 7 }], new Date(2026, 10, 15, 5, 59).getTime(), new Date(2026, 10, 15, 6, 0).getTime()), true, 'weekday 7 is Sunday');
});
