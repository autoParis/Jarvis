import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeBackNav, makeDrafts, BACK_BUTTON } from '../web/backnav.js';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

// A browser window with a history stack. back() fires popstate, as a real Back does.
function fakeWindow() {
  const listeners = new Map<string, ((e: any) => void)[]>();
  const stack: { state: any; href: string }[] = [{ state: null, href: 'http://jarvis/' }];
  let at = 0;
  const win = {
    location: { get href() { return stack[at].href; } },
    history: {
      get state() { return stack[at].state; },
      pushState(state: any, _: string, href: string) { stack.splice(at + 1); stack.push({ state, href }); at++; },
      replaceState(state: any, _: string, href: string) { stack[at] = { state, href }; },
    },
    addEventListener(type: string, fn: (e: any) => void) { listeners.set(type, [...(listeners.get(type) ?? []), fn]); },
  };
  const fire = (type: string, e: any = {}) => { for (const fn of listeners.get(type) ?? []) fn(e); return e; };
  const back = () => { if (at > 0) { at--; fire('popstate', { state: stack[at].state }); } };
  const mouseup = (button: number) => {
    const e = { button, defaultPrevented: false, preventDefault() { e.defaultPrevented = true; } };
    return fire('mouseup', e);
  };
  return { win, stack, back, mouseup, depth: () => at };
}

// The app's pane state, as web/index.html keeps it: a worker's pane id, a terminal, or a report.
function setup() {
  const w = fakeWindow();
  const app = { pane: null as string | null, term: false, report: null as string | null, leaves: 0 };
  const nav = makeBackNav({
    win: w.win,
    current: () => app.term || app.pane ? 'worker' : app.report ? 'report' : null,
    leave: () => { app.leaves++; app.pane = null; app.term = false; app.report = null; },
  });
  const openPane = (id: string) => { app.pane = id; nav.opened(); };
  return { w, app, nav, openPane };
}

test('the mouse back button on a worker pane returns to the main conversation', () => {
  const { w, app, openPane } = setup();
  openPane('w:1');
  const e = w.mouseup(BACK_BUTTON);
  assert.equal(app.pane, null);
  assert.equal(app.leaves, 1);
  // Cancelled, so the browser does not also go back a page.
  assert.equal(e.defaultPrevented, true);
});

test('the mouse back button leaves a terminal and a report too', () => {
  const { w, app, nav } = setup();
  app.term = true; nav.opened();
  w.mouseup(BACK_BUTTON);
  assert.equal(app.term, false);
  app.report = 'report:7';
  w.mouseup(BACK_BUTTON);
  assert.equal(app.report, null);
  assert.equal(app.leaves, 2);
});

test('on the main conversation the mouse back button does nothing new', () => {
  const { w, app } = setup();
  const e = w.mouseup(BACK_BUTTON);
  assert.equal(app.leaves, 0);
  // Not cancelled: the browser keeps its own behaviour.
  assert.equal(e.defaultPrevented, false);
});

test('other mouse buttons do nothing', () => {
  const { w, app, openPane } = setup();
  openPane('w:1');
  for (const b of [0, 1, 2, 4]) assert.equal(w.mouseup(b).defaultPrevented, false);
  assert.equal(app.pane, 'w:1');
});

test("the browser's Back on a worker pane returns to the main conversation and stays in the app", () => {
  const { w, app, openPane } = setup();
  openPane('w:1');
  assert.equal(w.depth(), 1);
  w.back();
  assert.equal(app.pane, null);
  assert.equal(w.depth(), 0);
});

test('moving from pane to pane adds no history entry, so one Back always reaches the main conversation', () => {
  const { w, app, openPane } = setup();
  openPane('w:1'); openPane('w:2'); openPane('w:3');
  assert.equal(w.stack.length, 2);
  w.back();
  assert.equal(app.pane, null);
});

test('a pane closed by its own Back button leaves no extra entry for the next pane', () => {
  const { w, app, openPane } = setup();
  openPane('w:1');
  app.pane = null; // the Back button, Escape or the Jarvis row
  openPane('w:2');
  assert.equal(w.stack.length, 2);
  // A Back on the main conversation after that entry is used does nothing.
  w.back(); w.back();
  assert.equal(app.leaves, 1);
});

test("a report's address change is left to its own route", () => {
  const { w, app } = setup();
  app.report = 'report:7';
  w.back();
  assert.equal(app.leaves, 0);
});

test('a draft survives leaving the pane and comes back on return, per pane', () => {
  const d = makeDrafts();
  d.keep('w:1', 'half a sentence');
  d.keep('w:2', 'other');
  assert.equal(d.take('w:1'), 'half a sentence');
  assert.equal(d.take('w:2'), 'other');
  assert.equal(d.take('w:3'), '');
  // A sent message empties the box, and the empty box replaces the old draft.
  d.keep('w:1', '');
  assert.equal(d.take('w:1'), '');
  d.keep(null, 'no pane');
});

// The daemon serves only listed files. An unlisted module would stop the whole page script from loading.
test('the daemon serves the module', () => {
  assert.match(read('./main.ts'), /'\/backnav\.js': 'backnav\.js'/);
});

test('the page wires the back button to the pane, the terminal and the draft', () => {
  const page = read('../web/index.html');
  const fn = (name: string) => page.slice(page.indexOf(`function ${name}(`), page.indexOf('\n}\n', page.indexOf(`function ${name}(`)));
  assert.match(page, /import \{ makeBackNav, makeDrafts \} from '\/backnav\.js'/);
  assert.match(page, /leave: \(\) => \$\('pane-back'\)\.click\(\)/);
  assert.match(fn('openPane'), /backNav\.opened\(\)/);
  assert.match(fn('openPane'), /steerDrafts\.take\(id\)/);
  assert.match(fn('openTerm'), /backNav\.opened\(\)/);
  // The draft is kept before the box is emptied.
  const close = fn('closePane');
  assert.ok(close.indexOf('steerDrafts.keep(pane.id') >= 0);
  assert.ok(close.indexOf('steerDrafts.keep(pane.id') < close.indexOf("$('steer-text').value = ''"));
});
