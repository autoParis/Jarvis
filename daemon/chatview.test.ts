import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chatHtml, chatLine, makeList, makeChat } from '../web/chatview.js';
import { rowText } from '../web/messagerow.js';

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const esc = (s: string) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

// A stand-in element: listeners, classes, attributes, children. It holds only what web/chatview.js and the modules it
// calls (messagerow, composer, mic) touch.
function el(tag = 'div'): any {
  const on: Record<string, ((e: any) => void)[]> = {}, cls = new Set<string>(), attrs: Record<string, string> = {};
  const e: any = {
    tag, className: '', innerHTML: '', value: '', style: {}, dataset: {}, kids: [] as any[], foot: '', scrollTop: 0, scrollHeight: 1000, clientHeight: 400,
    classList: { add: (c: string) => cls.add(c), remove: (c: string) => cls.delete(c), contains: (c: string) => cls.has(c), toggle: (c: string, on?: boolean) => ((on ?? !cls.has(c)) ? cls.add(c) : cls.delete(c)) },
    setAttribute: (k: string, v: string) => { attrs[k] = v; }, attrs,
    addEventListener: (ev: string, f: any) => { (on[ev] ??= []).push(f); }, removeEventListener() {},
    fire: (ev: string, x: any = {}) => on[ev]?.forEach(f => f(x)),
    append(...k: any[]) { this.kids.push(...k); }, appendChild(k: any) { this.kids.push(k); },
    insertAdjacentHTML(_w: string, html: string) { this.foot += html; },
    querySelector: () => el(), focus() {},
  };
  return e;
}
const doc: any = { createElement: el, addEventListener() {} };

test('the chat and the pane draw the same chat: same parts, same classes, in the same order', () => {
  const chat = chatHtml({ ids: { box: 't', go: 'wave' }, label: 'Message', handsFree: true });
  const pane = chatHtml({ ids: { box: 'steer-text', go: 'steer-go' }, label: 'Message' });
  const classes = (h: string) => [...h.matchAll(/class="([^"]+)"/g)].map(m => m[1]).filter(c => !/^(wave|send|vdot)$/.test(c));
  const handsOnly = (h: string) => h.replace(/<button id="keys"[\s\S]*<\/button>(?=<\/div><\/div>)/, '');
  // The send button is the one class that differs: the pane's always shows its arrow.
  assert.deepEqual(classes(handsOnly(pane)).map(c => c.replace('chat-go send', 'chat-go')), classes(handsOnly(chat)));
  for (const part of ['chat-log', 'chat-items', 'dock chat-dock', 'working-line', 'tray chat-tray', 'field chat-bar', 'ib chat-add', 'chat-file', 'chat-box', 'ib chat-mic']) {
    assert.ok(pane.includes(`class="${part}"`), part);
  }
});

test('hands-free is only in the chat: its controls, and a send button that is not a plain submit', () => {
  const chat = chatHtml({ ids: { go: 'wave' }, label: 'Message', handsFree: true });
  const pane = chatHtml({ label: 'Message' });
  for (const id of ['keys', 'voice-state', 'hands-end']) { assert.ok(chat.includes(`id="${id}"`)); assert.ok(!pane.includes(`id="${id}"`)); }
  assert.match(chat, /id="wave" type="button" class="chat-go"/);
  assert.match(pane, /type="submit" class="chat-go send"/);
  assert.ok(!pane.includes('class="wave"'), 'the pane has no hands-free wave');
});

test('a part with no id has none, and `above` and `below` sit around the box', () => {
  const html = chatHtml({ label: 'Message', above: '<p id="a"></p>', below: '<p id="b"></p>' });
  assert.ok(!html.includes(' id=""') && !html.includes('id="undefined"'));
  assert.ok(html.indexOf('id="a"') < html.indexOf('chat-tray') && html.indexOf('chat-bar') < html.indexOf('id="b"'));
});

test('one row for both feeds: the owner bubble with his pictures, the agent markdown with read aloud', () => {
  const owner: any = chatLine({ doc, role: 'owner', text: 'look\n[image: /up/1.png]', esc, render: esc, speak: { id: 4, clips: 2 } });
  assert.equal(owner.className, 'line line-owner');
  assert.equal(owner.kids[0].className, 'msg owner');
  assert.ok(owner.kids[0].innerHTML.includes('class="shots"') && owner.kids[0].innerHTML.includes('<div class="msg-text">look</div>'));
  assert.ok(!owner.foot.includes('msg-speak'), 'the owner\'s own words are never read aloud');
  assert.equal(rowText(owner), 'look\n[image: /up/1.png]', 'copy takes the text as sent');
  const agent: any = chatLine({ doc, role: 'agent', text: '**hi**', bodyHtml: '<p><b>hi</b></p>', esc, render: esc, speak: { id: 'n%3Aa/f%3A1', clips: 1 } });
  assert.equal(agent.className, 'line line-jarvis');
  assert.equal(agent.kids[0].className, 'msg jarvis md');
  assert.ok(agent.foot.includes('msg-speak') && agent.foot.includes('data-turn="n%3Aa/f%3A1"'));
  const pending: any = chatLine({ doc, role: 'owner', text: 'sent', esc, render: esc, pending: true });
  assert.equal(pending.kids[0].className, 'msg owner pending');
});

test('the list pins to the newest row until the owner scrolls up, and his own message always scrolls', () => {
  const log = el(), items = el();
  const list = makeList({ log, items, Observer: null });
  log.scrollTop = 600; // at the bottom: 1000 - 600 - 400 = 0
  const row = el();
  list.append(row);
  assert.equal(log.scrollTop, 1000);
  assert.ok(row.classList.contains('rise'));
  log.scrollTop = 100; log.fire('scroll');
  assert.equal(list.pinned(), false);
  list.append(el(), { rise: false });
  assert.equal(log.scrollTop, 100, 'scrolled up: a new row does not move the view');
  list.append(el(), { force: true });
  assert.equal(log.scrollTop, 1000);
  list.toTop();
  assert.equal(log.scrollTop, 0);
  assert.equal(list.pinned(), false);
});

test('a click goes to the feed first, then copy, then read aloud', () => {
  const log = el(), items = el(), seen: string[] = [];
  makeList({ log, items, Observer: null, onClick: (e: any) => e.mine ? (seen.push('feed'), true) : false, onSpeak: (k: string, n: number) => seen.push(`speak ${k} ${n}`) });
  const speaker = { dataset: { turn: '12', clips: '3' } };
  items.fire('click', { mine: true, target: { closest: () => speaker } });
  items.fire('click', { target: { closest: (s: string) => s === '.msg-speak' ? speaker : null } });
  assert.deepEqual(seen, ['feed', 'speak 12 3']);
});

function chatParts() {
  const p: any = { form: el('form'), box: el('textarea'), tray: el(), add: el('button'), file: el('input'), mic: el('button'), go: el('button'), bar: el() };
  p.file.click = () => { p.picked = true; };
  return p;
}
const enter = { key: 'Enter', shiftKey: false, preventDefault() {} };

test('the box sends to the send target it was given, on Enter and on Send, and nowhere while canSend is false', async () => {
  const real = globalThis.matchMedia;
  globalThis.matchMedia = (() => ({ matches: false })) as unknown as typeof matchMedia; // a desktop: Enter sends
  try {
    const parts = chatParts(), sent: string[] = [];
    let open = false;
    makeChat({ parts, doc, win: { innerHeight: 800 }, upload: async () => '/up/1.png', canSend: () => open, notify() {}, onError() {}, openViewer() {}, pasteText: () => false,
      send: async (m: string, o: any) => { sent.push(m); o.clear(); return true; }, getStream: async () => ({}), onClip: async () => {} });
    parts.box.value = 'hello';
    parts.box.fire('keydown', enter);
    await new Promise(r => setTimeout(r, 0));
    assert.deepEqual(sent, [], 'no worker open: nothing goes');
    open = true;
    parts.box.fire('keydown', enter);
    await new Promise(r => setTimeout(r, 0));
    assert.deepEqual(sent, ['hello']);
    assert.equal(parts.box.value, '');
    parts.add.onclick();
    assert.ok(parts.picked, 'the attach button opens the picker');
  } finally { globalThis.matchMedia = real; }
});

test('the page makes both chats with makeChat, hands-free in the chat only, and the daemon serves the module', () => {
  const page = read('../web/index.html');
  assert.equal(page.match(/= makeChat\(\{/g)?.length, 2);
  assert.equal(page.match(/handsFree: true/g)?.length, 2, 'the chat\'s markup and its behaviour, nothing in the pane');
  assert.equal(page.match(/chatLine\(\{/g)?.length, 2, 'the brain feed and the worker feed draw the same row');
  assert.equal(page.match(/= makeList\(\{/g)?.length, 2);
  assert.ok(!/makeComposer\(|makeMic\(/.test(page), 'no box or mic of its own outside the chat module');
  assert.match(read('./webfiles.ts'), /'\/chatview\.js': 'chatview\.js'/);
});
