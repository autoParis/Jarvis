// Approve on the chat message (asked 2026-11-08): the reply that asks for a proposal carries Approve and Reject,
// and they go away once the owner decides, on the message or on the Requests card.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from './store.ts';
import { makeGate } from './gate.ts';
import { makeChatLinks } from './chatlink.ts';
import { chatDecisionHtml } from '../web/worklist.js';

function setup() {
  const s = openStore(':memory:');
  const gate = makeGate(s, () => {});
  return { s, gate, links: makeChatLinks(s) };
}

test('the reply of the turn that proposed is the message the proposal links to', async () => {
  const { s, gate, links } = setup();
  s.addTurn({ role: 'owner', text: 'stop 4412' });
  links.turnStarted();
  const a = await gate.propose('worker-stop', { dispatch: 'ctx_1' }, 'Stop 4412?');
  links.proposed(a);
  const turn = s.addTurn({ role: 'jarvis', text: 'Stop 4412? Tap Approve if yes.' });
  const linked = links.replied(turn);
  assert.deepEqual(linked.map(x => x.id), [a.id]);
  assert.equal(s.approval(a.id)!.chat_turn, turn);
  // The page reads the link from the pending list it gets on load.
  assert.equal(s.pendingApprovals()[0].chat_turn, turn);
});

test('a SILENT turn links nothing, and its proposal never moves onto a later message', async () => {
  const { s, gate, links } = setup();
  links.turnStarted();
  links.proposed(await gate.propose('worker-stop', { dispatch: 'ctx_1' }, 'Stop?'));
  assert.deepEqual(links.replied(undefined), []);
  links.turnStarted();
  const later = s.addTurn({ role: 'jarvis', text: 'Something else.' });
  assert.deepEqual(links.replied(later), []);
  assert.equal(s.pendingApprovals()[0].chat_turn, null);
});

test('a turn that died without a reply leaves nothing for the next turn to link', async () => {
  const { s, gate, links } = setup();
  links.turnStarted();
  links.proposed(await gate.propose('worker-stop', { dispatch: 'ctx_1' }, 'Stop?'));
  links.turnStarted(); // the brain restarted and a new turn began
  assert.deepEqual(links.replied(s.addTurn({ role: 'jarvis', text: 'Hi.' })), []);
});

test('a proposal decided before the reply lands is not linked, and a repeat keeps its first message', async () => {
  const { s, gate, links } = setup();
  links.turnStarted();
  const a = await gate.propose('worker-stop', { dispatch: 'ctx_1' }, 'Stop?');
  links.proposed(a);
  const first = s.addTurn({ role: 'jarvis', text: 'Stop? Tap Approve.' });
  links.replied(first);
  // The brain proposes the same thing again in a later turn: the gate returns the same row, which keeps its message.
  links.turnStarted();
  const again = await gate.propose('worker-stop', { dispatch: 'ctx_1' }, 'Stop?');
  assert.equal(again.id, a.id);
  links.proposed(again);
  assert.deepEqual(links.replied(s.addTurn({ role: 'jarvis', text: 'Still waiting.' })), []);
  assert.equal(s.approval(a.id)!.chat_turn, first);
  // Decided before its reply: nothing to link.
  links.turnStarted();
  const b = await gate.propose('worker-stop', { dispatch: 'ctx_2' }, 'Stop the other?');
  links.proposed(b);
  await gate.button(b.id, false);
  assert.deepEqual(links.replied(s.addTurn({ role: 'jarvis', text: 'Stop the other?' })), []);
});

test('the chat message shows Approve and Reject while pending, and nothing once decided or tapped', async () => {
  const { s, gate, links } = setup();
  links.turnStarted();
  const a = await gate.propose('worker-stop', { dispatch: 'ctx_1' }, 'Stop 4412?');
  links.proposed(a);
  const turn = s.addTurn({ role: 'jarvis', text: 'Stop 4412? Tap Approve.' });
  links.replied(turn);
  const pending = s.pendingApprovals();
  const html = chatDecisionHtml(pending, turn);
  assert.match(html, new RegExp(`data-approval="${a.id}"`));
  assert.match(html, /class="chat-yes">Approve</);
  assert.match(html, /class="chat-no">Reject</);
  assert.ok(html.indexOf('chat-no') < html.indexOf('chat-yes'), 'Reject on the left, Approve on the right');
  assert.doesNotMatch(html, /chat-say/, 'one proposal needs no label');
  assert.equal(chatDecisionHtml(pending, turn + 1), '', 'another message gets no buttons');
  // Tapped on this page: gone at once, before the server answers.
  assert.equal(chatDecisionHtml(pending, turn, new Set([a.id])), '');
  // Decided anywhere (the Requests card uses the same gate.button): the broadcast row is no longer pending.
  // Reject here, so the test never runs a real command.
  await gate.button(a.id, false);
  assert.equal(s.approval(a.id)!.status, 'rejected');
  assert.equal(chatDecisionHtml([s.approval(a.id)!], turn), '');
});

test('two proposals on one message each name what they decide', () => {
  const rows = [
    { id: 7, action: 'worker-stop', say: 'Stop 4412?', status: 'pending', chat_turn: 3 },
    { id: 8, action: 'gh-pr-close', say: 'Close PR 12?', status: 'pending', chat_turn: 3 },
  ];
  const html = chatDecisionHtml(rows, 3);
  assert.match(html, /<span class="chat-say">Stop 4412\?<\/span>/);
  assert.match(html, /<span class="chat-say">Close PR 12\?<\/span>/);
  assert.equal(html.match(/chat-yes/g)!.length, 2);
});
