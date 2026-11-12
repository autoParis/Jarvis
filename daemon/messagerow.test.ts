import test from 'node:test';
import assert from 'node:assert/strict';
import { messageRow, rowText, copyMessage, tapLine } from '../web/messagerow.js';
import { messageFootHtml, COPIED_ICON } from '../web/workfold.js';

// web/messagerow.js builds DOM nodes. This stand-in holds only what it touches.
function fakeDoc() {
  const el = (tag: string): any => ({
    tag, className: '', innerHTML: '', kids: [] as any[], foot: '',
    append(...k: any[]) { this.kids.push(...k); },
    insertAdjacentHTML(_where: string, html: string) { this.foot += html; },
  });
  return { createElement: el };
}

test('a message row carries the body, then what sits between, then the copy row', () => {
  const doc = fakeDoc(), between = { tag: 'decide' };
  const line: any = messageRow({ doc, lineClass: 'line line-jarvis', bodyClass: 'msg jarvis md', bodyHtml: '<p>hi</p>', text: 'hi **there**', at: '2026-11-02T20:18:00Z', between });
  assert.equal(line.className, 'line line-jarvis');
  assert.equal(line.kids[0].innerHTML, '<p>hi</p>');
  assert.equal(line.kids[1], between);
  assert.ok(line.foot.includes('msg-copy'));
  assert.ok(line.foot.includes('class="ago"'), 'a row with a time shows it');
  assert.equal(rowText(line), 'hi **there**', 'copy takes the text as written, not the drawn html');
});

test('a row with no time has the copy button and no empty time', () => {
  const html = messageFootHtml(undefined);
  assert.ok(html.includes('msg-copy'));
  assert.ok(!html.includes('class="ago"'));
});

test('a speaker id that is not a number is escaped into its attribute', () => {
  const html = messageFootHtml(undefined, { id: 'n:ab|"f:12', clips: 2 });
  assert.ok(html.includes('data-turn="n:ab|&quot;f:12"'));
});

test('copy writes the row text and shows the check, and a refused clipboard says so', async () => {
  const attrs: Record<string, string> = {};
  const doc = fakeDoc();
  const line: any = messageRow({ doc, lineClass: 'line', bodyClass: 'pl agent', bodyHtml: 'x', text: 'the words' });
  const b: any = { closest: () => line, innerHTML: '', title: '', setAttribute: (k: string, v: string) => { attrs[k] = v; } };
  const wrote: string[] = [];
  await copyMessage(b, { writeText: async (t: string) => { wrote.push(t); } });
  assert.deepEqual(wrote, ['the words']);
  assert.equal(b.innerHTML, COPIED_ICON);
  clearTimeout(b.resetTimer);
  await copyMessage(b, { writeText: async () => { throw new Error('denied'); } });
  assert.equal(b.title, 'Could not copy');
  clearTimeout(b.resetTimer);
});

test('a tap shows the row of the message tapped and hides the others, only on a touch screen', () => {
  const classes = () => { const s = new Set<string>(); return { contains: (c: string) => s.has(c), add: (c: string) => s.add(c), remove: (c: string) => s.delete(c) }; };
  const other: any = { classList: classes() }, line: any = { classList: classes() };
  other.classList.add('shown');
  const root: any = { ownerDocument: { getSelection: () => ({ isCollapsed: true }) }, querySelectorAll: () => [other] };
  const e: any = { target: { closest: (s: string) => s === '.line' ? line : null } };
  tapLine(e, root, false);
  assert.ok(other.classList.contains('shown'), 'a mouse uses hover, so a click changes nothing');
  tapLine(e, root, true);
  assert.ok(line.classList.contains('shown'));
  assert.ok(!other.classList.contains('shown'));
});
