import { realpathSync, statSync, readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join, extname, sep, basename, dirname, resolve } from 'node:path';
import type { RouteResult } from './route.ts';

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

// A picture a report shows: `![alt](path)` (with an optional "title"), or an `[image: /abs/path]` line.
const PICTURE = /!\[[^\]\n]*\]\(\s*<?([^\s)>]+)>?(?:\s+"[^"\n]*")?\s*\)|\[image:\s*([^\]\n]+?)\s*\]/g;

/** What an ask card and a request row show of a report: its title, its first picture and how many it has. */
export type ReportSummary = { path: string; title: string; image?: string; pictures: number };

/**
 * The summary of one report in `dir`, or undefined when the path is outside it or not a .md file. A relative picture
 * path is read against the report's folder, as the report page does. `shown` says whether /image serves a picture,
 * and only those count.
 */
export function reportSummary(path: string, dir: string, shown: (path: string) => boolean): ReportSummary | undefined {
  const r = readReport(path, dir);
  if (!r) return;
  const folder = dirname(path);
  const lines = r.body.split(/\r?\n/);
  let fence: string | null = null;
  const pictures: string[] = [];
  for (const line of lines) {
    const f = FENCE.exec(line);
    if (fence) { if (line.trimStart().startsWith(fence)) fence = null; continue; }
    if (f) { fence = f[1]; continue; }
    for (const m of line.matchAll(PICTURE)) {
      const p = (m[1] ?? m[2]).trim();
      if (/^[a-z][a-z0-9+.-]*:/i.test(p)) continue; // a web address or another scheme is not a file here
      const abs = resolve(folder, p);
      if (shown(abs) && !pictures.includes(abs)) pictures.push(abs);
    }
  }
  return { path, title: r.title, ...(pictures[0] ? { image: pictures[0] } : {}), pictures: pictures.length };
}

/** Long documents in data/reports, read-only. A path outside that folder, or not a .md file, is refused. */
export function reportsRoute(dir: string, method: string, url: string, query: URLSearchParams): RouteResult | undefined {
  if (method !== 'GET') return undefined;
  if (url === '/api/reports') return { status: 200, body: listReports(dir) };
  if (url === '/api/reports/file') {
    const r = readReport(query.get('path') ?? '', dir);
    return r ? { status: 200, body: r } : { status: 404, body: { error: 'Only .md files in data/reports can be opened.' } };
  }
  return undefined;
}
