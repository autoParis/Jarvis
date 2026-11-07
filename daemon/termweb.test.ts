import test from 'node:test';
import assert from 'node:assert/strict';
import { cells, lineHtml, keyFor, ctrlChar, fit, applyFrame, color256, statusText, keyboardInset, keepVisible } from '../web/terminal.js';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const k = (key: string, mods: Partial<KeyboardEvent> = {}) => ({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, isComposing: false, ...mods }) as any;

test('tmux lines become styled cells, and the cursor cell is inverted', () => {
  const c = cells('\x1b[31mred\x1b[0m ok\x1b[1;38;5;216m!');
  assert.equal(c.map(x => x.ch).join(''), 'red ok!');
  assert.equal(c[0].st.fg, '#e06c6c'); assert.equal(c[3].st.fg, null);
  assert.equal(c[6].st.bold, true); assert.equal(c[6].st.fg, color256(216));
  assert.equal(cells('\x1b[38;2;1;2;3mx')[0].st.fg, 'rgb(1,2,3)');
  assert.equal(lineHtml('a<b', null, esc), 'a&lt;b');
  assert.match(lineHtml('ab', 1, esc), /^a<span class="cur" style="[^"]*">b<\/span>$/);
  assert.match(lineHtml('', 3, esc), /^ {3}<span class="cur"/, 'the cursor past the end still shows');
  assert.equal(color256(232), 'rgb(8,8,8)'); assert.equal(color256(16), 'rgb(0,0,0)');
});

test('keys: named keys by tmux name, Ctrl as control characters, Cmd+[ goes back, other Cmd keys stay the browser\'s', () => {
  assert.deepEqual(keyFor(k('a')), [{ text: 'a' }]);
  assert.deepEqual(keyFor(k('ArrowUp')), [{ key: 'Up' }]);
  assert.deepEqual(keyFor(k('Tab', { shiftKey: true })), [{ key: 'BTab' }]);
  assert.deepEqual(keyFor(k('Backspace')), [{ key: 'BSpace' }]);
  assert.deepEqual(keyFor(k('c', { ctrlKey: true })), [{ text: '\x03' }]);
  assert.deepEqual(keyFor(k('c'), true), [{ text: '\x03' }], 'the phone\'s lit Ctrl');
  assert.deepEqual(keyFor(k('[', { metaKey: true })), { back: true });
  assert.equal(keyFor(k('v', { metaKey: true })), null);
  assert.equal(keyFor(k('c', { metaKey: true })), null);
  assert.equal(keyFor(k('Shift')), null);
  assert.equal(keyFor(k('a', { isComposing: true })), null);
  assert.deepEqual(keyFor(k('F5')), [{ key: 'F5' }]);
  assert.equal(ctrlChar('['), '\x1b'); assert.equal(ctrlChar('?'), '\x7f'); assert.equal(ctrlChar('é'), undefined);
});

test('the screen fits its box and redraws only the rows that changed', () => {
  assert.deepEqual(fit(800, 400, 8, 20), { cols: 100, rows: 20 });
  assert.deepEqual(fit(100, 40, 8, 20), { cols: 20, rows: 5 });
  const s = { lines: [] as string[], cursor: null as any, cols: 0, rows: 0 };
  assert.deepEqual([...applyFrame(s, { cols: 3, rows: 2, cursor: [0, 0], lines: ['a', 'b'] })].sort(), [0, 1]);
  assert.deepEqual([...applyFrame(s, { cols: 3, rows: 2, cursor: [0, 1], d: [] })].sort(), [0, 1], 'the cursor moved rows');
  assert.deepEqual([...applyFrame(s, { cols: 3, rows: 2, cursor: [0, 1], d: [[1, 'c']] })], [1]);
  assert.deepEqual(s.lines, ['a', 'c']);
  assert.equal(statusText(112, 30, true)[0], 'Live, 112 × 30');
});

test('the phone keyboard: the key row moves up by the hidden part of the layout, and a pan does not count twice', () => {
  assert.deepEqual(keyboardInset(915, 915, 0), { inset: 0, open: false }, 'no keyboard');
  assert.deepEqual(keyboardInset(915, 545, 0), { inset: 370, open: true }, 'keyboard up, no pan');
  assert.deepEqual(keyboardInset(915, 545, 370), { inset: 0, open: true }, 'the browser panned the page by the keyboard: still open, no extra room');
  assert.deepEqual(keyboardInset(915, 545, 100), { inset: 270, open: true });
  assert.deepEqual(keyboardInset(915, 860, 0), { inset: 55, open: false }, 'a toolbar change is not a keyboard');
});

test('the cursor row stays in view while the screen is taller than its box', () => {
  assert.equal(keepVisible(0, 300, 100, 120), 0, 'already visible');
  assert.equal(keepVisible(0, 300, 450, 470), 170, 'below: scroll so its bottom shows');
  assert.equal(keepVisible(200, 300, 50, 70), 50, 'above: scroll up to it');
  assert.equal(keepVisible(170, 400, 450, 470), 170, 'the box grew: it shows, no move');
});
