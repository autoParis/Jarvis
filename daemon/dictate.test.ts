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

// A tap on Send with a picture attached, while the phone's dictation still commits its words (2026-11-08):
// the words must go out with the picture as one message.
import { settleBox, withPictures } from '../web/dictate.js';

test('text and pictures go out as one message, and an empty box with no picture sends nothing', () => {
  assert.equal(withPictures(' look at this ', ['[image: /u/a.png]']), 'look at this\n[image: /u/a.png]');
  assert.equal(withPictures('', ['[image: /u/a.png]', '[image: /u/b.png]']), '[image: /u/a.png]\n[image: /u/b.png]');
  assert.equal(withPictures('just text', []), 'just text');
  assert.equal(withPictures('   ', []), '');
});

test('the send reads the box only after late dictated words arrive', async () => {
  const box = Object.assign(new EventTarget(), { value: '' });
  setTimeout(() => { box.value = 'what is this'; box.dispatchEvent(new Event('input')); }, 30);
  setTimeout(() => { box.value = 'what is this screen'; box.dispatchEvent(new Event('input')); }, 70);
  const t0 = Date.now();
  await settleBox(box, { quietMs: 60, maxMs: 1000 });
  assert.equal(withPictures(box.value, ['[image: /u/a.png]']), 'what is this screen\n[image: /u/a.png]');
  assert.ok(Date.now() - t0 >= 120, 'it waited a quiet period after the last input');
});

test('the wait stops at its cap, and an open composition holds it until it ends', async () => {
  const busy = Object.assign(new EventTarget(), { value: '' });
  const tick = setInterval(() => busy.dispatchEvent(new Event('input')), 10);
  let t0 = Date.now();
  await settleBox(busy, { quietMs: 50, maxMs: 150 });
  clearInterval(tick);
  assert.ok(Date.now() - t0 < 400, 'a box that never goes quiet still sends');

  let composing = true;
  const box = Object.assign(new EventTarget(), { value: '' });
  setTimeout(() => { composing = false; box.value = 'done'; box.dispatchEvent(new Event('compositionend')); }, 120);
  t0 = Date.now();
  await settleBox(box, { quietMs: 20, maxMs: 1000, composing: () => composing });
  assert.equal(box.value, 'done');
  assert.ok(Date.now() - t0 >= 120);
});
