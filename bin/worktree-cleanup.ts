// The worktree cleanup's dry run, by hand: what the daily jarvisd task (daemon/worktrees.ts) would remove and keep, with
// every reason, written as a Markdown report. It never removes anything: only the jarvisd task removes.
//   node bin/worktree-cleanup.ts [--cards <dir>] [--db <jarvis.db>] [--out <report.md>] [--no-sizes]
// The defaults are this checkout's vault/projects, data/jarvis.db and data/reports/worktree-cleanup-dry-run.md.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { cleanWorktrees, projectRepos, reportMarkdown, execIn, type Worker } from '../daemon/worktrees.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const cards = arg('--cards') ?? join(ROOT, 'vault', 'projects');
const dbPath = arg('--db') ?? join(ROOT, 'data', 'jarvis.db');
const out = arg('--out') ?? join(ROOT, 'data', 'reports', 'worktree-cleanup-dry-run.md');

const repos = projectRepos(cards);
if (!repos.length) { console.error(`No project card with a repo path in ${cards}.`); process.exit(2); }
let workers: Worker[] = [];
if (existsSync(dbPath)) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  workers = db.prepare('SELECT id, name, cwd, state, outcome FROM native_workers').all() as Worker[];
  db.close();
} else console.error(`No ${dbPath}: native workers are not checked.`);

const exec = execIn();
const result = await cleanWorktrees({ repos: () => repos, workers: () => workers, exec, log: (m, f) => console.log(m, JSON.stringify(f ?? {})) }, 'dry-run');
const sizes = new Map<string, number>();
if (!process.argv.includes('--no-sizes')) for (const i of result.items) {
  const kb = Number((await exec('du', ['-sk', i.path])).stdout.split('\t')[0]);
  if (kb) sizes.set(i.path, kb);
}
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, reportMarkdown(result, repos, sizes));
console.log(`Wrote ${out}: would remove ${result.items.filter(i => i.verdict.remove).length}, keep ${result.items.filter(i => !i.verdict.remove).length}.`);
