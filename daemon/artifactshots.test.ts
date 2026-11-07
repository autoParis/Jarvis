import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { canvasBoards, boardsFor, plan, scaleFor, slug, shoot, chromePath, pngSize, MIN_WIDTH } from './artifactshots.ts';

const canvasDir = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'jarvis-shots-')));
  mkdirSync(join(dir, 'project'));
  writeFileSync(join(dir, 'project', 'canvas.json'), JSON.stringify({
    boards: { 'B.dc.html': { w: 400, h: 300, title: 'B. Orb dock' }, 'Main.dc.html': { w: 1600, h: 880, title: 'Today: the bar' } },
    order: ['Main.dc.html', 'B.dc.html'],
  }));
  writeFileSync(join(dir, 'project', 'Main.dc.html'), '<body style="margin:0;background:#123">hi</body>');
  writeFileSync(join(dir, 'project', 'B.dc.html'), '<body style="margin:0;background:#321">b</body>');
  return dir;
};

test('a canvas gives one board per entry, in its order, with each board\'s own size and title', () => {
  const dir = canvasDir();
  const boards = boardsFor(dir);
  assert.deepEqual(boards.map(b => [b.title, b.width, b.height]), [['Today: the bar', 1600, 880], ['B. Orb dock', 400, 300]]);
  assert.equal(boards[0].file, join(dir, 'project', 'Main.dc.html'));
  assert.deepEqual(boardsFor(join(dir, 'project', 'canvas.json')), boards);
});

test('every board comes out at 2x or more and at least 1000 px wide, named after the artifact and the board', () => {
  assert.equal(scaleFor(1600), 2);
  assert.equal(scaleFor(400), 3);
  assert.ok(scaleFor(390) * 390 >= MIN_WIDTH);
  const shots = plan(canvasBoards(join(canvasDir(), 'project', 'canvas.json')), 'Bottom bar options', '/out');
  assert.deepEqual(shots.map(s => s.out), ['/out/bottom-bar-options-01-today-the-bar.png', '/out/bottom-bar-options-02-b-orb-dock.png']);
  for (const s of shots) assert.ok(s.width * s.scale >= MIN_WIDTH && s.scale >= 2);
  assert.equal(slug('  '), 'board');
});

test('a single html page is one board at the size given; anything else is refused', () => {
  const dir = canvasDir();
  assert.deepEqual(boardsFor(join(dir, 'project', 'Main.dc.html'), { width: 1280, height: 900 }).map(b => [b.title, b.width]), [['Main', 1280]]);
  assert.throws(() => boardsFor(join(dir, 'nothing.txt')), /canvas.json/);
  writeFileSync(join(dir, 'empty.json'), '{}');
  assert.throws(() => canvasBoards(join(dir, 'empty.json')), /no boards/);
});

let chrome: string | undefined;
try { chrome = chromePath(); } catch {}
test('headless Chrome renders a board at its size times the density', { skip: !chrome && 'no Chrome on this machine' }, () => {
  const dir = canvasDir();
  const [main, small] = plan(boardsFor(dir), 'probe', join(dir, 'out'));
  assert.deepEqual(shoot(main, chrome), { width: 3200, height: 1760 });
  assert.deepEqual(shoot(small, chrome), { width: 1200, height: 900 });
  assert.deepEqual(pngSize(small.out), { width: 1200, height: 900 });
});
