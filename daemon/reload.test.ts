import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { STATIC, webVersion, versionEvent, webVersionRoute } from './webfiles.ts';
import { makeReloader, makeTyped, busyReason, RETRY_MS, QUIET_MS } from '../web/reload.js';
import { EVENTS } from '../web/contract.js';

// 2026-11-10: after a jarvisd restart with new web code, an open page kept the old JS until Simon reloaded it by hand.
// He tested a fix on the stale page and saw it broken. jarvisd now sends the web code's version, and the page reloads.

const WEB = new URL('../web/', import.meta.url).pathname;
const copyOfWeb = () => { const d = mkdtempSync(join(tmpdir(), 'jarvis-web-')); cpSync(WEB, d, { recursive: true }); return d; };

test('the web version is stable for the same files and changes when any served file changes', () => {
  const dir = copyOfWeb();
  const v = webVersion(dir);
  assert.match(v, /^[0-9a-f]{16}$/);
  assert.equal(webVersion(dir), v, 'same files, same version');
  assert.equal(webVersion(WEB), v, 'the copy and the real folder agree');
  writeFileSync(join(dir, 'reload.js'), readFileSync(join(dir, 'reload.js'), 'utf8') + '\n// changed');
  assert.notEqual(webVersion(dir), v, 'a changed module gives a new version');
  const v2 = webVersion(dir);
  writeFileSync(join(dir, 'not-served.txt'), 'x');
  assert.equal(webVersion(dir), v2, 'a file jarvisd does not serve changes nothing');
  assert.ok(Object.values(STATIC).includes('reload.js'));
});

test('jarvisd sends the version on /api/events and answers GET /api/version', () => {
  assert.ok(EVENTS.includes('version'));
  assert.deepEqual(versionEvent('abc'), { type: 'version', version: 'abc' });
  assert.deepEqual(webVersionRoute('abc', 'GET', '/api/version'), { status: 200, body: { version: 'abc' } });
  assert.equal(webVersionRoute('abc', 'POST', '/api/version'), undefined);
  assert.equal(webVersionRoute('abc', 'GET', '/api/events'), undefined);
  const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
  const events = main.slice(main.indexOf("url === '/api/events'"));
  assert.match(events.slice(0, events.indexOf('clients.add(res)')), /versionEvent\(WEB_VERSION\)/, 'each connect gets the version');
  assert.match(main, /webVersionRoute\(WEB_VERSION, method, url\)/);
});

const fakeTimers = () => {
  const t = { fns: new Map<number, () => unknown>(), n: 0, setInterval: (f: () => unknown, ms: number) => { assert.equal(ms, RETRY_MS); t.fns.set(++t.n, f); return t.n; }, clearInterval: (id: number) => { t.fns.delete(id); }, tick: () => { for (const f of [...t.fns.values()]) f(); } };
  return t;
};
const page = (why = '') => {
  const p = { why, reloads: 0, button: false, timers: fakeTimers() };
  const r = makeReloader({ reload: () => { p.reloads++; }, busy: () => p.why, button: (s: boolean) => { p.button = s; }, timers: p.timers });
  return { p, r };
};

test('the first version is the one the page loaded with; the same version again never reloads', () => {
  const { p, r } = page();
  assert.equal(r.seen('v1'), 'current');
  assert.equal(r.seen('v1'), 'current', 'a reconnect to the same daemon');
  assert.equal(r.seen(undefined), 'current', 'an old daemon sends no version');
  assert.equal(p.reloads, 0);
});

test('a new version reloads at once when the owner is idle', () => {
  const { p, r } = page();
  r.seen('v1');
  assert.equal(r.seen('v2'), 'reloaded');
  assert.equal(p.reloads, 1);
  assert.equal(p.button, false);
});

test('a new version while the owner is busy shows the Reload button, and reloads once he is idle', () => {
  const { p, r } = page('typing');
  r.seen('v1');
  assert.equal(r.seen('v2'), 'typing');
  assert.equal(p.reloads, 0);
  assert.equal(p.button, true);
  p.timers.tick();
  assert.equal(p.reloads, 0, 'still typing');
  r.seen('v2');
  assert.equal(p.timers.fns.size, 1, 'one retry timer, not one per event');
  p.why = '';
  p.timers.tick();
  assert.equal(p.reloads, 1);
  assert.equal(p.timers.fns.size, 0, 'the timer stops');
});

test('the resume check finds a version the sleeping stream missed', () => {
  const { p, r } = page();
  r.seen('v1'); // the stream's connect
  r.seen('v2'); // GET /api/version after visibilitychange
  assert.equal(p.reloads, 1);
});

const box = (value = '', extra: Record<string, unknown> = {}) => ({ value, isConnected: true, matches: (s: string) => s.includes('textarea'), ...extra });
const idle = { active: null, typed: makeTyped(), recording: false, overlay: false, quietFor: QUIET_MS + 1 };

test('the page is busy while the owner types, records, has a dialog open, left an unsent text, or just tapped', () => {
  assert.equal(busyReason(idle), '');
  assert.equal(busyReason({ ...idle, active: box('half a sen') }), 'typing');
  assert.equal(busyReason({ ...idle, active: box('') }), '', 'the empty chat box keeps the focus on the Mac all day');
  assert.equal(busyReason({ ...idle, active: box('x', { readOnly: true }) }), '');
  assert.equal(busyReason({ ...idle, recording: true }), 'recording');
  assert.equal(busyReason({ ...idle, overlay: true }), 'dialog');
  assert.equal(busyReason({ ...idle, quietFor: 1000 }), 'active');
});

test('a box with text the owner typed keeps the page, until the page sends it or replaces it', () => {
  const typed = makeTyped(), answer = box('Use the');
  typed.input(answer);
  assert.equal(busyReason({ ...idle, typed }), 'draft', 'a half-written card answer, focus elsewhere');
  answer.value = '';
  assert.equal(busyReason({ ...idle, typed }), '', 'sent: the page cleared the box');
  const draft = box('Hello,');
  typed.input(draft);
  draft.value = 'The next email draft';
  assert.equal(typed.dirty(), false, 'the page filled the box with new text');
  const gone = box('typed');
  typed.input(gone);
  gone.isConnected = false;
  assert.equal(typed.dirty(), false, 'a box that is gone from the page');
});

test('the page wires the version event, the resume check and a reload that keeps the address', () => {
  const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  assert.match(html, /e\.type === 'version'\) reloader\.seen\(e\.version\)/);
  assert.match(html, /visibilitychange', \(\) => \{ if \(document\.visibilityState === 'visible'\) checkVersion\(\)/);
  assert.match(html, /fetch\('\/api\/version'\)/);
  assert.match(html, /reload: \(\) => location\.reload\(\)/, 'location.reload keeps the hash, so the open report comes back');
  assert.match(html, /id="reload-btn"/);
});
