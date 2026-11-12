import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { randomBytes } from 'node:crypto';

// Pictures the owner attaches in the chat. The daemon names the file; nothing the client sends reaches the path.
export const UPLOAD_LIMIT = 10 * 1024 * 1024;
export const uploadDir = (repo: string) => join(repo, 'data', 'uploads');

// The extension for an allowed image, read from its first bytes rather than from the client's content type.
export function sniff(buf: Buffer): string | undefined {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return '.png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg';
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.subarray(0, 6).toString('latin1'))) return '.gif';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return '.webp';
}

// The `[image: path]` lines for the pictures a voice clip names (`image` query parameters). Only a file this daemon
// saved with saveUpload passes: a direct child of `dir` with its stamped name. Any other path is in `refused`.
export function pictureLines(paths: string[], dir: string): { lines: string[]; refused: string[] } {
  const lines: string[] = [], refused: string[] = [];
  for (const p of paths) {
    const ok = dirname(p) === dir && /^\d{8}T\d{6}-[0-9a-f]{8}\.(png|jpg|gif|webp)$/.test(basename(p)) && existsSync(p);
    if (ok) lines.push(`[image: ${p}]`); else refused.push(p);
  }
  return { lines, refused };
}

// Saves an uploaded image under `dir` and returns its absolute path, or an error the route turns into a status code.
export function saveUpload(buf: Buffer, dir: string, now = new Date()): { path: string } | { error: string; status: number } {
  if (buf.length > UPLOAD_LIMIT) return { error: 'larger than 10 MB', status: 413 };
  const ext = sniff(buf);
  if (!ext) return { error: 'only png, jpg, webp and gif images', status: 415 };
  mkdirSync(dir, { recursive: true });
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..*/, '');
  const path = join(dir, `${stamp}-${randomBytes(4).toString('hex')}${ext}`);
  writeFileSync(path, buf, { flag: 'wx' });
  return { path };
}
