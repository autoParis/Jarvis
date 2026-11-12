import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import { imageFile, imageRoots, imageRoute } from './images.ts';
import { reportsDir } from './reports.ts';

function fakeRes() {
  const s: any = new PassThrough();
  const chunks: Buffer[] = [];
  s.on('data', (c: Buffer) => chunks.push(c));
  s.writeHead = (status: number, headers: object) => { s.status = status; s.headers = headers; return s; };
  s.done = () => new Promise<string>(resolve => s.on('end', () => resolve(Buffer.concat(chunks).toString())));
  return s;
}
const get = (path: string, method = 'GET') => ({ method, headers: {}, url: `/image?path=${encodeURIComponent(path)}` }) as any;

test('GET /image serves a picture in data/reports and refuses traversal, other files and other folders', async () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'jarvis-repo-')));
  const reports = reportsDir(repo), shots = join(reports, '4812-shots');
  mkdirSync(shots, { recursive: true });
  writeFileSync(join(shots, '01.png'), 'png bytes');
  writeFileSync(join(reports, 'a.md'), '# not a picture');
  writeFileSync(join(repo, 'secret.png'), 'outside');
  const roots = imageRoots(repo);
  assert.ok(roots.includes(reports));

  let res = fakeRes();
  assert.equal(imageRoute(roots, get(join(shots, '01.png')), res, '/image'), true);
  assert.equal(await res.done(), 'png bytes');
  assert.deepEqual([res.status, res.headers['content-type']], [200, 'image/png']);
  for (const path of [`${shots}/../../secret.png`, join(reports, 'a.md'), join(repo, 'secret.png'), '4812-shots/01.png', join(shots, 'none.png')]) {
    res = fakeRes();
    assert.equal(imageRoute(roots, get(path), res, '/image'), true);
    assert.equal(res.status, 404, path);
  }
  assert.equal(imageRoute(roots, get(join(shots, '01.png'), 'POST'), fakeRes(), '/image'), false);
  assert.equal(imageRoute(roots, get(join(shots, '01.png')), fakeRes(), '/api/reports'), false);
});

test('only images inside an allowed folder are served, traversal and symlinks out are refused', () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'jarvis-img-')));
  const root = join(base, 'screens'), outside = join(base, 'secret');
  mkdirSync(join(root, 'sub'), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(root, 'sub', 'a.png'), 'x');
  writeFileSync(join(root, 'notes.txt'), 'x');
  writeFileSync(join(outside, 'b.png'), 'x');
  symlinkSync(join(outside, 'b.png'), join(root, 'link.png'));
  const roots = [root];

  assert.equal(imageFile(join(root, 'sub', 'a.png'), roots), join(root, 'sub', 'a.png'));
  assert.equal(imageFile(`${root}/sub/../sub/a.png`, roots), join(root, 'sub', 'a.png'));
  assert.equal(imageFile(`${root}/../secret/b.png`, roots), undefined); // traversal
  assert.equal(imageFile(`${root}/sub/../../secret/b.png`, roots), undefined);
  assert.equal(imageFile(join(root, 'link.png'), roots), undefined); // symlink out
  assert.equal(imageFile(join(root, 'notes.txt'), roots), undefined); // not an image
  assert.equal(imageFile(join(root, 'missing.png'), roots), undefined);
  assert.equal(imageFile('sub/a.png', roots), undefined); // relative
  assert.equal(imageFile(`${root}-evil/a.png`, roots), undefined); // prefix lookalike
  assert.equal(imageFile(root, roots), undefined); // the folder itself
});
