import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { splitPictures, shotRowHtml, makeInk, toImagePoint, paint, INK } from '../web/draw.js';

const esc = (s: string) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

test('the picture markers of an owner message come out, the words stay', () => {
  const sent = 'Look at the header\n[image: /r/data/uploads/a1.png]\n[image: /r/data/uploads/b2.jpg]';
  assert.deepEqual(splitPictures(sent), { text: 'Look at the header', paths: ['/r/data/uploads/a1.png', '/r/data/uploads/b2.jpg'] });
  assert.deepEqual(splitPictures('[image: /x.png]'), { text: '', paths: ['/x.png'] });
  assert.deepEqual(splitPictures('No picture\nhere'), { text: 'No picture\nhere', paths: [] });
});

test('the row has one square per picture, at most 4 columns, and no file name', () => {
  const four = shotRowHtml(['/u/20261109-aaaa.png', '/u/b.png', '/u/c.png', '/u/d.png'], esc);
  assert.match(four, /class="shots" style="--n:4"/);
  assert.equal(four.match(/class="shot"/g)!.length, 4);
  assert.doesNotMatch(four, /20261109-aaaa\.png</);
  assert.doesNotMatch(four, /<span/);
  assert.match(four, /aria-label="Open picture 2 of 4"/);
  assert.match(shotRowHtml(Array(6).fill('/p.png'), esc), /--n:4/);
  assert.match(shotRowHtml(['/p.png'], esc), /--n:1.*aria-label="Open the picture"/);
  assert.equal(shotRowHtml([], esc), '');
});

test('a path with quotes cannot break out of the attribute', () => {
  assert.doesNotMatch(shotRowHtml(['/a"onerror="x.png'], esc), /"onerror="x/);
});

test('undo removes the last stroke, and undo after clear brings the strokes back', () => {
  const ink = makeInk();
  ink.begin([1, 1], INK[0], 4); ink.move([5, 5]);
  ink.begin([9, 9], INK[1], 4);
  assert.equal(ink.strokes.length, 2);
  ink.undo();
  assert.deepEqual(ink.strokes.map(s => s.points), [[[1, 1], [5, 5]]]);
  ink.clear();
  assert.equal(ink.strokes.length, 0);
  assert.equal(ink.canUndo, true, 'Undo stays on after Clear, so Clear can be undone');
  ink.undo();
  assert.equal(ink.strokes.length, 1);
  ink.undo();
  assert.equal(ink.canUndo, false);
});

test('strokes from an earlier opening come back and undo can still take them off', () => {
  const first = makeInk();
  first.begin([0, 0], INK[0], 4);
  const saved = first.strokes;
  const again = makeInk(saved);
  assert.equal(again.strokes, saved, 'no change keeps the same list, so closing does not export again');
  again.undo();
  assert.equal(again.strokes.length, 0);
  assert.equal(saved.length, 1, 'the saved list is not changed in place');
});

test('a pointer position maps to the picture pixels at its real size', () => {
  const rect = { left: 100, top: 50, width: 400, height: 300 };
  assert.deepEqual(toImagePoint(300, 200, rect, 2000, 1500), [1000, 750]);
  assert.deepEqual(toImagePoint(0, 9999, rect, 2000, 1500), [0, 1500], 'a stroke off the edge stays on the picture');
});

test('paint draws a line for a stroke and a dot for a tap', () => {
  const calls: string[] = [];
  const ctx: any = new Proxy({}, { get: (o: any, k: string) => k in o ? o[k] : (...a: unknown[]) => { calls.push(`${k}(${a.join(',')})`); }, set: (o: any, k, v) => { o[k] = v; return true; } });
  paint(ctx, [{ color: '#FF3B30', width: 6, points: [[0, 0], [10, 10]] }, { color: '#FFD60A', width: 6, points: [[4, 4]] }]);
  assert.ok(calls.includes('moveTo(0,0)') && calls.includes('lineTo(10,10)') && calls.includes('stroke()'));
  assert.ok(calls.some(c => c.startsWith('arc(4,4,3')) && calls.includes('fill()'));
});

test('the page opens composer pictures in the viewer and waits for the marks before upload', () => {
  const page = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  assert.match(readFileSync(new URL('../web/composer.js', import.meta.url), 'utf8'), /\.thumb-open'\)\.onclick = \(\) => openViewer\(item\.baseUrl, item\)/);
  assert.equal(page.match(/openViewer: \(src, item\) => openViewer\(src, item\)/g)?.length, 2, 'both boxes open their pictures in the viewer with the pen');
  assert.match(readFileSync(new URL('../web/compose.js', import.meta.url), 'utf8'), /await p\.ready;/);
  assert.match(page, /item\.file = file;\n\s*delete item\.path;/, 'a marked picture drops the path of an earlier upload');
  assert.match(readFileSync(new URL('../web/chatview.js', import.meta.url), 'utf8'), /shotRowHtml\(p\.paths, esc\)/);
});
