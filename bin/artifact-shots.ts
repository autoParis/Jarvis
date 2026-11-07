// Readable chat previews of an artifact: one PNG per board, each cropped to that board, drawn by headless Chrome at
// 2x and at least 1000 px wide. Design workers run this on the local files they published, instead of screenshotting
// the visible Chrome window (whose width is capped and gave a 340 px wide picture of the whole canvas).
//
//   node bin/artifact-shots.ts <canvas.json | folder with (project/)canvas.json | page.html> --name <artifact-name>
//        [--out <dir>]                  default docs/screens/artifacts in this repo
//        [--width 1280 --height 900]    viewport for a single .html page (a canvas gives each board's own size)
//
// Prints one `[image: <path>]` line per board, in the canvas's order, after a line with the board's title and size.
// Exits 1 with the reason on any failure; a board narrower than 1000 px after scaling counts as a failure.
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardsFor, plan, shoot } from '../daemon/artifactshots.ts';

const args = process.argv.slice(2);
const flag = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const target = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
const name = flag('name');
if (!target || !name) {
  console.error('usage: node bin/artifact-shots.ts <canvas.json | folder | page.html> --name <artifact-name> [--out dir] [--width W --height H]');
  process.exit(2);
}
const out = flag('out') ?? join(dirname(dirname(fileURLToPath(import.meta.url))), 'docs', 'screens', 'artifacts');
try {
  const shots = plan(boardsFor(target, { width: Number(flag('width') ?? 1280), height: Number(flag('height') ?? 900) }), name, out);
  for (const s of shots) {
    const size = shoot(s);
    console.log(`${s.title} (${size.width}x${size.height})`);
    console.log(`[image: ${s.out}]`);
  }
} catch (e) {
  console.error(`artifact-shots: ${(e as Error).message}`);
  process.exit(1);
}
