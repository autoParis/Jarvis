// The brain's events, wired to a fake brain: what each one stores, says and sends to the open pages.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { openStore } from './store.ts';
import { makeChatLinks } from './chatlink.ts';
import { wireBrain } from './brainevents.ts';

function setup() {
  const store = openStore(':memory:');
  const brain = new EventEmitter();
  const seen: any = { events: [], said: [], pushed: [], logs: [], published: 0 };
  const chatLinks = makeChatLinks(store);
  wireBrain(brain, {
    store, log: m => seen.logs.push(m), broadcast: ev => seen.events.push(ev),
    say: (role, text) => { seen.said.push([role, text]); return store.addTurn({ role, text }); },
    notify: async (m, opts) => { seen.pushed.push([m, opts]); return 1; },
    chatLinks, native: {} as any, cardOf: () => undefined, publish: () => { seen.published++; }, info: () => ({ model: 'm' }),
  });
  return { store, brain, seen, chatLinks };
}

test('brain events: a reply is said and linked to the turn\'s proposals, SILENT says nothing, urgent pushes', () => {
  const { store, brain, seen, chatLinks } = setup();
  const a = store.addApproval({ action: 'email-send', args: '{}', say: 'Send?' });
  brain.emit('working', true);
  chatLinks.proposed(a);
  brain.emit('reply', 'Send it?', { is_error: false }, []);
  assert.deepEqual(seen.said, [['jarvis', 'Send it?']]);
  assert.deepEqual(seen.events.map((e: any) => e.type), ['working', 'approval']);
  brain.emit('reply', 'SILENT', { is_error: false }, []);
  assert.equal(seen.said.length, 1);
  brain.emit('reply', '[urgent] The build broke.', { is_error: false }, []);
  assert.equal(seen.pushed.length, 1);
  assert.deepEqual(seen.pushed[0][1], { urgent: true });
  assert.deepEqual(seen.said.at(-1), ['jarvis', 'The build broke.'], 'the marker is never said');
});

test('brain events: a worked turn is stored as a fold, notices are said, the model goes to the pages, logs pass through', () => {
  const { store, brain, seen } = setup();
  brain.emit('worked', { steps: ['read'], ms: 12 });
  const fold = seen.events.find((e: any) => e.type === 'fold');
  assert.equal(fold.ms, 12);
  assert.deepEqual(JSON.parse(store.workSteps(fold.id)!).steps, ['read']);
  brain.emit('notice', 'Switching model.');
  assert.deepEqual(seen.said, [['jarvis', 'Switching model.']]);
  brain.emit('model');
  assert.deepEqual(seen.events.at(-1), { type: 'brain', brain: { model: 'm' } });
  brain.emit('log', 'brain line');
  assert.deepEqual(seen.logs, ['brain line']);
});

test('brain events: a worker turn with no sender is kept on an unknown-sender card, nothing is said, and the brain is told', () => {
  const store = openStore(':memory:');
  const brain = new EventEmitter();
  const events: any[] = [], said: string[] = [], told: string[] = [];
  wireBrain(brain, {
    store, log: () => {}, broadcast: ev => events.push(ev), say: (_r, t) => { said.push(t); return 0; }, notify: async () => 1,
    chatLinks: makeChatLinks(store), native: { get: () => undefined, list: () => [] } as any, cardOf: () => undefined,
    publish: () => {}, info: () => ({}), tell: t => told.push(t),
  });
  // A peer message that names no worker jarvisd knows.
  brain.emit('worker', 'Story 4390 asks.', { is_error: false }, { from: 'someone-else', text: 'QUESTION: ship or wait?' });
  const item = store.openItems().find(i => i.subject === 'Message from an unknown sender');
  assert.ok(item, 'never dropped');
  assert.deepEqual(said, [], 'an answer to an unknown sender is not spoken');
  assert.ok(events.some(e => e.type === 'event' && /unknown sender/.test(e.text)));
  assert.equal(told.length, 1);
  assert.match(told[0], /^\[unknown sender\]/);
  assert.match(told[0], new RegExp(`--item ${item!.external_id}`));
  assert.match(told[0], /ship or wait\?/);
  // No peer message at all: the brain's own reply. Said, no card, nothing told.
  brain.emit('worker', 'Here is my answer to you.', { is_error: false }, undefined);
  assert.deepEqual(said, ['Here is my answer to you.']);
  assert.equal(store.openItems().filter(i => i.subject === 'Message from an unknown sender').length, 1);
  assert.equal(told.length, 1);
});
