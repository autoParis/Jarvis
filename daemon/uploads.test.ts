import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { saveUpload, sniff, UPLOAD_LIMIT } from './uploads.ts';
import { imageFile } from './images.ts';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
const GIF = Buffer.from('GIF89a\x01\x00', 'latin1');
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]);
const tmp = () => join(realpathSync(mkdtempSync(join(tmpdir(), 'jarvis-up-'))), 'uploads');

test('the type comes from the bytes: png, jpg, gif and webp pass, anything else is refused', () => {
  assert.equal(sniff(PNG), '.png');
  assert.equal(sniff(JPG), '.jpg');
  assert.equal(sniff(GIF), '.gif');
  assert.equal(sniff(WEBP), '.webp');
  const dir = tmp();
  for (const bad of [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), Buffer.from('%PDF-1.7'), Buffer.from('#!/bin/sh\nrm -rf ~'),
    Buffer.from('ftypheic'), Buffer.from('RIFF\0\0\0\0WAVE'), Buffer.alloc(0)]) {
    assert.deepEqual(saveUpload(bad, dir), { error: 'only png, jpg, webp and gif images', status: 415 });
  }
  assert.throws(() => readdirSync(dir)); // nothing written, not even the folder
});

test('files over 10 MB are refused, 10 MB exactly is kept', () => {
  const dir = tmp();
  const big = Buffer.alloc(UPLOAD_LIMIT + 1); PNG.copy(big);
  assert.deepEqual(saveUpload(big, dir), { error: 'larger than 10 MB', status: 413 });
  const max = Buffer.alloc(UPLOAD_LIMIT); PNG.copy(max);
  assert.ok('path' in saveUpload(max, dir));
});

test('the daemon picks the name: a fresh file in the upload folder, served by the /image allowlist', () => {
  const dir = tmp();
  const a = saveUpload(JPG, dir, new Date('2026-10-29T20:15:03.120Z'));
  const b = saveUpload(JPG, dir, new Date('2026-10-29T20:15:03.120Z'));
  assert.ok('path' in a && 'path' in b);
  assert.equal(dirname(a.path), dir);
  assert.match(basename(a.path), /^20261029T201503-[0-9a-f]{8}\.jpg$/);
  assert.notEqual(a.path, b.path); // same second, no overwrite
  assert.deepEqual(readFileSync(a.path), JPG);
  assert.equal(imageFile(a.path, [dir]), a.path);
  assert.equal(readdirSync(dir).length, 2);
});
