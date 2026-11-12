import test from 'node:test';
import assert from 'node:assert/strict';
import { makeComposer, refusal, IMAGE_MAX } from '../web/composer.js';
import { withReadLine, withoutReadLine, READ_PICTURES } from '../web/compose.js';

// web/composer.js touches a textarea, a tray element and the thumbnails it makes. These stand-ins hold only that.
function fakeBox() {
  const on: Record<string, ((e: any) => void)[]> = {};
  return { value: '', addEventListener: (ev: string, f: any) => { (on[ev] ??= []).push(f); }, removeEventListener() {}, fire: (ev: string, e: any = {}) => on[ev]?.forEach(f => f(e)) };
}
function fakeDoc() {
  return { createElement: () => {
    const kids: Record<string, any> = { img: { src: '' }, '.thumb-open': {}, '.thumb-remove': {} };
    const el: any = { className: '', innerHTML: '', parent: null, querySelector: (s: string) => kids[s], remove() { if (el.parent) el.parent.kids = el.parent.kids.filter((k: any) => k !== el); el.parent = null; } };
    return el;
  } };
}
function setup(send = async (_m: string, o: any) => { o.clear(); return true; }) {
  const box = fakeBox(), trayEl: any = { kids: [] as any[], append(el: any) { el.parent = trayEl; trayEl.kids.push(el); } };
  const notes: string[] = [], sent: { message: string; key: string }[] = [];
  let n = 0;
  const c = makeComposer({
    doc: fakeDoc(), box, trayEl, notify: (t: string) => notes.push(t), openViewer() {},
    upload: async () => `/up/${++n}.png`, urls: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
    send: async (message: string, o: any) => { sent.push({ message, key: o.key }); return send(message, o); },
  });
  return { c, box, trayEl, notes, sent };
}
const png = (name = 'a.png') => ({ name, type: 'image/png', size: 10 });

test('the tray refuses a file that is not a picture or is too big, and says why', () => {
  assert.equal(refusal(png()), '');
  assert.match(refusal({ name: 'a.pdf', type: 'application/pdf', size: 1 }), /only png, jpg, webp and gif/);
  assert.match(refusal({ name: 'big.png', type: 'image/png', size: IMAGE_MAX + 1 }), /larger than 10 MB/);
  const { c, notes } = setup();
  c.attach({ name: 'a.pdf', type: 'application/pdf', size: 1 });
  assert.equal(c.items().length, 0);
  assert.equal(notes.length, 1);
});

test('each worker keeps its own pictures, and only the open one shows', () => {
  const { c, trayEl } = setup();
  c.switchTo('n:a');
  c.attach(png('for a.png'));
  c.switchTo('n:b');
  assert.equal(c.items().length, 0);
  assert.equal(trayEl.kids.length, 0, 'the other worker\'s picture leaves the tray');
  c.switchTo('n:a');
  assert.equal(c.items().length, 1);
  assert.equal(trayEl.kids.length, 1);
});

test('a picture with no words sends one [image: path] line to the open key, and leaves the tray', async () => {
  const { c, sent } = setup();
  c.switchTo('n:a');
  c.attach(png());
  await c.send();
  assert.deepEqual(sent, [{ message: '[image: /up/1.png]', key: 'n:a' }]);
  assert.equal(c.items().length, 0);
});

test('words and a picture go as one message, and the box clears only through the send', async () => {
  const { c, box, sent } = setup(async () => false);
  box.value = 'look at this';
  c.attach(png());
  await c.send();
  assert.equal(sent[0].message, 'look at this\n[image: /up/1.png]');
  assert.equal(box.value, 'look at this', 'a refused send keeps the words');
  assert.equal(c.items().length, 1, 'and the picture');
});

test('Send waits for late dictated words before it reads the box', async () => {
  const { c, box, sent } = setup();
  box.value = 'hello';
  const going = c.send(true);
  setTimeout(() => { box.value = 'hello there'; box.fire('input'); }, 50);
  await going;
  assert.equal(sent[0].message, 'hello there');
  assert.equal(box.value, '');
});

test('a switch to another worker during the wait sends nothing', async () => {
  const { c, box, sent } = setup();
  c.switchTo('n:a');
  box.value = 'for a';
  const going = c.send(true);
  c.switchTo('n:b');
  await going;
  assert.deepEqual(sent, []);
});

test('the read line goes under a picture once, and the pane takes it out again', () => {
  const msg = 'what is this?\n[image: /up/1.png]';
  assert.equal(withReadLine(msg), `${msg}\n${READ_PICTURES}`);
  assert.equal(withReadLine(withReadLine(msg)), withReadLine(msg));
  assert.equal(withReadLine('no picture'), 'no picture');
  assert.equal(withoutReadLine(withReadLine(msg)), msg);
});
