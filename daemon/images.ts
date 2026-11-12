import { realpathSync, statSync, createReadStream } from 'node:fs';
import { join, extname, sep } from 'node:path';
import { homedir } from 'node:os';
import type http from 'node:http';
import { uploadDir } from './uploads.ts';
import { reportsDir } from './reports.ts';

// Images the chat may show with an `[image: /abs/path.png]` marker. Only these folders, only these types.
// data/uploads holds the pictures the owner attaches. data/reports holds the pictures a report shows with `![alt](path)`.
export const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
export const imageRoots = (repo: string) => [join(repo, 'docs', 'screens'), join(homedir(), 'Desktop'), join(homedir(), 'Downloads'), uploadDir(repo), reportsDir(repo)];

// The real path of an allowed image file, or undefined. Both sides go through realpath, so `..` and symlinks
// pointing outside a root are refused, and a root that is itself a symlink still works.
export function imageFile(path: string, roots: string[]): string | undefined {
  if (typeof path !== 'string' || !path.startsWith('/') || path.includes('\0')) return;
  let real: string;
  try { real = realpathSync(path); } catch { return; }
  if (!IMAGE_TYPES[extname(real).toLowerCase()] || !statSync(real).isFile()) return;
  for (const root of roots) {
    let r: string;
    try { r = realpathSync(root); } catch { continue; }
    if (real.startsWith(r + sep)) return real;
  }
}

/**
 * GET /image?path=<abs path>: the pictures in `[image: ...]` markers and in a report's `![alt](path)`, only from `roots`.
 * Answers true for /image, false for any other URL. main.ts checks access before any route runs.
 */
export function imageRoute(roots: string[], req: http.IncomingMessage, res: http.ServerResponse, url: string): boolean {
  if (req.method !== 'GET' || url !== '/image') return false;
  const file = imageFile(new URL(req.url ?? '/', 'http://x').searchParams.get('path') ?? '', roots);
  if (!file) { res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'Only pictures in the allowed folders can be shown.' })); return true; }
  res.writeHead(200, { 'content-type': IMAGE_TYPES[extname(file).toLowerCase()], 'cache-control': 'private, max-age=300' });
  createReadStream(file).pipe(res);
  return true;
}
