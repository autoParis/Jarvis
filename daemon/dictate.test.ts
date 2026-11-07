import test from 'node:test';
import assert from 'node:assert/strict';
import { withTyped, boxAfterSend } from '../web/dictate.js';

test('typed text goes in front of the dictated words with one space', () => {
  assert.equal(withTyped('Merge 412', 'and restart the daemon'), 'Merge 412 and restart the daemon');
  assert.equal(withTyped('  Merge 412 \n', ' and restart '), 'Merge 412 and restart', 'outer spaces and line ends are trimmed');
  assert.equal(withTyped('line one\nline two', 'then this'), 'line one\nline two then this', 'line breaks inside the typed text stay');
});

test('an empty box sends the words as today', () => {
  assert.equal(withTyped(null, 'start 4412'), 'start 4412');
  assert.equal(withTyped('', 'start 4412'), 'start 4412');
  assert.equal(withTyped('   ', 'start 4412'), 'start 4412');
  assert.equal(withTyped(undefined, 'start 4412'), 'start 4412');
});

test('nothing heard sends nothing, even with typed text', () => {
  assert.equal(withTyped('Merge 412', ''), '');
  assert.equal(withTyped('Merge 412', '   '), '');
  assert.equal(withTyped(null, ''), '');
});

test('the box clears after the send, and keeps text typed during the transcription', () => {
  assert.equal(boxAfterSend('Merge 412', 'Merge 412'), '');
  assert.equal(boxAfterSend('Merge 412 also 415', 'Merge 412'), 'also 415');
  assert.equal(boxAfterSend('something else', 'Merge 412'), 'something else', 'a box changed in another way is left alone');
  assert.equal(boxAfterSend('typed after', ''), 'typed after', 'an empty box at the tap stays as it is');
});
