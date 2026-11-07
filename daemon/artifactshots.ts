import { readFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname, resolve, basename, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';

// Readable previews of an artifact for the chat: one PNG per board, each cropped to that board, rendered by headless
// Chrome at a fixed viewport. The visible Chrome window is not used, so its width does not matter. A screenshot of a
// whole design canvas is about 340 px wide and unreadable on a phone; a board here is at least MIN_WIDTH pixels wide
// and drawn at 2x or more. Used by bin/artifact-shots.ts.

export const MIN_WIDTH = 1000;
export const MIN_SCALE = 2;

export interface Board { file: string; title: string; width: number; height: number }
export interface Shot extends Board { scale: number; out: string }

/** The boards of a Design canvas (project/canvas.json), in the canvas's order. Files are resolved next to canvas.json. */
export function canvasBoards(canvasPath: string): Board[] {
  const canvas = JSON.parse(readFileSync(canvasPath, 'utf8'));
  const boards: Record<string, { w?: number; h?: number; title?: string }> = canvas?.boards ?? {};
  const order: string[] = Array.isArray(canvas?.order) ? canvas.order.filter((k: string) => boards[k]) : [];
  const keys = [...order, ...Object.keys(boards).filter(k => !order.includes(k))];
  if (!keys.length) throw new Error(`${canvasPath} lists no boards`);
  return keys.map(k => {
    const b = boards[k];
    if (!(Number(b.w) > 0 && Number(b.h) > 0)) throw new Error(`board ${k} has no width and height in ${canvasPath}`);
    return { file: resolve(dirname(canvasPath), k), title: b.title || k, width: Math.round(b.w!), height: Math.round(b.h!) };
  });
}

/** Lowercase words joined by dashes, for file names. */
export const slug = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'board';

/** The pixel density that makes a board at least MIN_WIDTH pixels wide, never below MIN_SCALE. */
export const scaleFor = (width: number) => Math.max(MIN_SCALE, Math.ceil(MIN_WIDTH / width));

/** Where each board's PNG goes: <outDir>/<name>-<nn>-<board title>.png. */
export function plan(boards: Board[], name: string, outDir: string): Shot[] {
  const pad = Math.max(2, String(boards.length).length);
  return boards.map((b, i) => ({ ...b, scale: scaleFor(b.width), out: join(outDir, `${slug(name)}-${String(i + 1).padStart(pad, '0')}-${slug(b.title)}.png`) }));
}

/** The Chrome binary: $CHROME, else Google Chrome, else Chromium. */
export function chromePath(env = process.env): string {
  const found = [env.CHROME, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium']
    .find(p => p && existsSync(p));
  if (!found) throw new Error('No Chrome found. Set CHROME to the browser binary.');
  return found;
}

/** The PNG's width and height, read from its header. */
export function pngSize(path: string): { width: number; height: number } {
  const b = readFileSync(path);
  if (b.length < 24 || b.toString('ascii', 12, 16) !== 'IHDR') throw new Error(`${path} is not a PNG`);
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

/** Render one board with headless Chrome at its own size and density, then check the PNG is the size asked for. */
export function shoot(shot: Shot, chrome = chromePath()): { width: number; height: number } {
  mkdirSync(dirname(shot.out), { recursive: true });
  const profile = join(tmpdir(), `jarvis-artifact-shots-${process.pid}`);
  execFileSync(chrome, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
    `--user-data-dir=${profile}`, `--force-device-scale-factor=${shot.scale}`, `--window-size=${shot.width},${shot.height}`,
    // Lets web fonts and layout settle before the picture is taken.
    '--virtual-time-budget=5000', `--screenshot=${shot.out}`, pathToFileURL(shot.file).href,
  ], { stdio: 'pipe', timeout: 60_000 });
  if (!existsSync(shot.out) || !statSync(shot.out).size) throw new Error(`Chrome wrote no picture for ${shot.file}`);
  const size = pngSize(shot.out);
  if (size.width < MIN_WIDTH) throw new Error(`${shot.out} is ${size.width} px wide, under ${MIN_WIDTH}`);
  return size;
}

/** Boards for a canvas.json, a folder holding one (or project/canvas.json), or a single HTML page at the given size. */
export function boardsFor(target: string, page = { width: 1280, height: 900 }): Board[] {
  const abs = resolve(target);
  if (existsSync(abs) && statSync(abs).isDirectory()) {
    const c = [join(abs, 'canvas.json'), join(abs, 'project', 'canvas.json')].find(existsSync);
    if (!c) throw new Error(`${abs} has no canvas.json or project/canvas.json`);
    return canvasBoards(c);
  }
  if (basename(abs) === 'canvas.json') return canvasBoards(abs);
  if (['.html', '.htm'].includes(extname(abs).toLowerCase())) return [{ file: abs, title: basename(abs).replace(/(\.dc)?\.html?$/i, ''), ...page }];
  throw new Error(`${target}: give a canvas.json, its folder, or an .html page`);
}
