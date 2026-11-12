import test from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from './store.ts';
import { makeGate, buildCommand } from './gate.ts';
import { KINDS, orderRepos, projectLabel, restore, view, startBody, termStart, startedRow, segHtml, stepRadio } from '../web/newpick.js';

const REPOS = [{ name: 'acmeapp', path: '/r/acmeapp' }, { name: 'fbm', path: '/r/fbm' }, { name: 'jarvis', path: '/r/jarvis' }];
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

test('the picker lists Jarvis, AcmeApp, FBM and opens on the last choice', () => {
  assert.deepEqual(orderRepos(REPOS).map(r => projectLabel(r.name)), ['Jarvis', 'AcmeApp', 'FBM']);
  assert.deepEqual(KINDS.map(k => k.label), ['Claude', 'Codex', 'Terminal']);
  assert.deepEqual(restore(JSON.stringify({ kind: 'codex', repo: '/r/fbm', worktree: true }), REPOS), { kind: 'codex', repo: '/r/fbm', worktree: true });
  // A stale or broken value falls back instead of breaking the popover.
  assert.deepEqual(restore('{"kind":"vim","repo":"/gone"}', REPOS), { kind: 'claude', repo: '/r/acmeapp', worktree: false });
  assert.deepEqual(restore('not json', REPOS).kind, 'claude');
});

test('every kind can start; Terminal hides the Worktree switch, and Codex keeps it', () => {
  assert.deepEqual(view({ kind: 'claude', repo: '/r/jarvis', worktree: false }), { showWorktree: true, canStart: true, why: '' });
  const codex = view({ kind: 'codex', repo: '/r/jarvis', worktree: false });
  assert.equal(codex.canStart, true); assert.equal(codex.showWorktree, true);
  const term = view({ kind: 'terminal', repo: '/r/jarvis', worktree: true });
  assert.equal(term.canStart, true); assert.equal(term.showWorktree, false);
  assert.equal(view({ kind: 'claude', repo: '', worktree: false }).canStart, false);
  assert.deepEqual(startBody({ kind: 'claude', repo: '/r/jarvis', worktree: false }), { repo: '/r/jarvis' });
  assert.deepEqual(startBody({ kind: 'claude', repo: '/r/jarvis', worktree: true }), { repo: '/r/jarvis', worktree: true });
  // The terminal route: Codex takes the switch, Terminal never does.
  assert.deepEqual(termStart({ kind: 'codex', repo: '/r/jarvis', worktree: true }), { repo: '/r/jarvis', kind: 'codex', worktree: true });
  assert.deepEqual(termStart({ kind: 'codex', repo: '/r/jarvis', worktree: false }), { repo: '/r/jarvis', kind: 'codex' });
  assert.deepEqual(termStart({ kind: 'terminal', repo: '/r/jarvis', worktree: true }), { repo: '/r/jarvis', kind: 'terminal' });
});

test('segments are radios with one tab stop, and arrows wrap', () => {
  const html = segHtml([{ value: 'a', label: 'A' }, { value: 'b', label: '<B>' }], 'b', esc);
  assert.match(html, /role="radio" aria-checked="false" tabindex="-1" data-v="a">A</);
  assert.match(html, /aria-checked="true" tabindex="0" data-v="b">&lt;B></);
  assert.equal(stepRadio(['a', 'b', 'c'], 'c', 'ArrowRight'), 'a');
  assert.equal(stepRadio(['a', 'b', 'c'], 'a', 'ArrowLeft'), 'c');
  assert.equal(stepRadio(['a', 'b', 'c'], 'b', 'End'), 'c');
  assert.equal(stepRadio(['a', 'b', 'c'], 'b', 'x'), null);
  assert.equal(startedRow({ result: JSON.stringify({ worker: 'n:abc' }) }), 'n:abc');
  assert.equal(startedRow({ result: 'oops' }), null);
});

test('a side chat from the picker starts with no first message, in a worktree only when asked', async () => {
  const sc = buildCommand('side-chat', { repo: '/r/jarvis', text: '' });
  assert.equal(sc[0], 'native'); assert.match(sc[3], /He has not written yet/); assert.doesNotMatch(sc[3], /His first message/);
  assert.match(buildCommand('side-chat', { repo: '/r/jarvis', text: 'hi' })[3], /His first message:\n\nhi/);
  assert.throws(() => buildCommand('side-chat', { repo: 'r/jarvis', text: '' }), /absolute path/);

  const starts: any[] = [];
  const native = { start: async (a: any) => { starts.push(a); return { id: `w${starts.length}`, session_id: 's', name: a.name, state: 'starting' } as any; }, stop: async () => {}, abandon: async () => {} };
  const gate = makeGate(openStore(':memory:'), () => {}, () => {}, undefined, undefined, native);
  const plain = await gate.pressed('side-chat', { repo: '/r/jarvis', text: '' }, 'Side chat: new in jarvis');
  assert.equal(plain.status, 'done'); assert.equal(JSON.parse(plain.result!).worker, 'n:w1');
  assert.equal(starts[0].worktree, false); assert.match(starts[0].name, /^side-chat-new-in-jarvis-\d+$/);
  await gate.pressed('side-chat', { repo: '/r/jarvis', text: '', worktree: true }, 'Side chat: new in jarvis');
  assert.equal(starts[1].worktree, true);
});
