import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { enterSends } from '../web/enterkey.js';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('on a desktop, Enter sends and Shift+Enter does not', () => {
  assert.equal(enterSends({ key: 'Enter', shiftKey: false }, false), true);
  assert.equal(enterSends({ key: 'Enter', shiftKey: true }, false), false);
});

test('on a touch screen, Enter never sends', () => {
  assert.equal(enterSends({ key: 'Enter', shiftKey: false }, true), false);
  assert.equal(enterSends({ key: 'Enter', shiftKey: true }, true), false);
});

test('other keys never send', () => {
  assert.equal(enterSends({ key: 'a', shiftKey: false }, false), false);
});

test('the touch default reads the pointer media query', () => {
  const real = globalThis.matchMedia;
  try {
    globalThis.matchMedia = ((q: string) => ({ matches: q === '(pointer: coarse)' })) as typeof matchMedia;
    assert.equal(enterSends({ key: 'Enter', shiftKey: false }), false);
    globalThis.matchMedia = (() => ({ matches: false })) as unknown as typeof matchMedia;
    assert.equal(enterSends({ key: 'Enter', shiftKey: false }), true);
  } finally { globalThis.matchMedia = real; }
});

// The daemon serves only listed files. An unlisted module would stop the whole page script from loading.
test('the daemon serves the module', () => {
  assert.match(read('./main.ts'), /'\/enterkey\.js': 'enterkey\.js'/);
});

test('every box that sends on Enter goes through the rule', () => {
  const page = read('../web/index.html');
  assert.match(page, /t\.onkeydown = e => \{ if \(enterSends\(e\)\)/);
  assert.match(page, /\$\('steer-text'\)\.addEventListener\('keydown', e => \{ if \(enterSends\(e\)\)/);
  assert.match(page, /\$\('req-free-text'\)\.addEventListener\('keydown', e => \{ if \(enterSends\(e\)\)/);
  // A one-line input cannot hold a line break, and pressing Enter in it submits the form whatever the device.
  assert.match(page, /<textarea id="req-free-text"/);
  // The one exception is the Today box: there Enter is meant to add the row on every device, so several go in quickly.
  // A checkbox (the picker's Worktree switch) holds no text, so Enter has nothing to send there.
  // The terminal's pairing code is one short number: Enter pairs on every device.
  assert.doesNotMatch(page, /<input(?![^>]*type="(?:file|checkbox)")(?![^>]*id="(?:today-text|term-pair-code)")/);
});
