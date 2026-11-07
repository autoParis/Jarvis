import { realpathSync, statSync } from 'node:fs';
import { join, extname, sep } from 'node:path';
import { homedir } from 'node:os';
import { uploadDir } from './uploads.ts';

// Images the chat may show with an `[image: /abs/path.png]` marker. Only these folders, only these types.
// data/uploads holds the pictures the owner attaches.
export const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
export const imageRoots = (repo: string) => [join(repo, 'docs', 'screens'), join(homedir(), 'Desktop'), join(homedir(), 'Downloads'), join(homedir(), 'orca', 'workspaces'), uploadDir(repo)];

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
