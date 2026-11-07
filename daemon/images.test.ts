import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { imageFile } from './images.ts';

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
