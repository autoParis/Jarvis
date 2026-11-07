import { realpathSync, statSync, readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join, extname, sep, basename } from 'node:path';

// Long documents for the owner to read in the app: story drafts, worker reports, research. The brain and workers write
// markdown files here, and the chat links one with a `[report: /abs/path.md]` line. Only this folder is served.
export const reportsDir = (repo: string) => join(repo, 'data', 'reports');

// `[report: /abs/path.md]` shows a card in the chat and is never read aloud, like `[image: ...]`.
export const REPORT_MARKER = /\[report:\s*[^\]\n]+\]/g;

const LIST_MAX = 200;
const HEADING = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/;
const FENCE = /^\s*(```|~~~)/;

// The real path of a .md file under `dir`, or undefined. Both sides go through realpath, so `..` and symlinks
// that point outside the folder are refused, and a folder that is itself a symlink still works.
export function reportFile(path: string, dir: string): string | undefined {
  if (typeof path !== 'string' || !path.startsWith('/') || path.includes('\0')) return;
  let real: string, root: string;
  try { real = realpathSync(path); root = realpathSync(dir); } catch { return; }
  if (extname(real).toLowerCase() !== '.md' || !real.startsWith(root + sep)) return;
  try { if (!statSync(real).isFile()) return; } catch { return; }
  return real;
}

// The first markdown heading outside a code block, else the file name without .md and with dashes as spaces.
export function reportTitle(body: string, file: string): string {
  let fence: string | null = null;
  for (const line of body.split(/\r?\n/)) {
    const f = FENCE.exec(line);
    if (fence) { if (line.trimStart().startsWith(fence)) fence = null; continue; }
    if (f) { fence = f[1]; continue; }
    const h = HEADING.exec(line);
    if (h && h[1]) return h[1].replace(/[*_`]/g, '').trim();
  }
  return basename(file).replace(/\.md$/i, '').replace(/[-_]+/g, ' ').trim();
}

export type ReportEntry = { path: string; title: string; at: string };

// Every .md file under `dir`, subfolders included, newest change first. A missing folder is created and lists nothing.
export function listReports(dir: string): ReportEntry[] {
  try { mkdirSync(dir, { recursive: true }); } catch {}
  let names: string[];
  try { names = readdirSync(dir, { recursive: true }) as string[]; } catch { return []; }
  const out: (ReportEntry & { ms: number })[] = [];
  for (const name of names) {
    if (extname(name).toLowerCase() !== '.md') continue;
    const real = reportFile(join(dir, name), dir);
    if (!real) continue;
    try {
      const ms = statSync(real).mtimeMs;
      out.push({ path: join(dir, name), title: reportTitle(readFileSync(real, 'utf8').slice(0, 20_000), real), at: new Date(ms).toISOString(), ms });
    } catch {}
  }
  return out.sort((a, b) => b.ms - a.ms).slice(0, LIST_MAX).map(({ ms, ...r }) => r);
}

// One report for GET /api/reports/file, or undefined when the path is outside the folder or not a .md file.
export function readReport(path: string, dir: string): (ReportEntry & { body: string }) | undefined {
  const real = reportFile(path, dir);
  if (!real) return;
  try {
    const body = readFileSync(real, 'utf8');
    return { path, title: reportTitle(body, real), at: statSync(real).mtime.toISOString(), body };
  } catch { return; }
}
