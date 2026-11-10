import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { openStore } from './store.ts';
import { Brain } from './brain.ts';
import { answerAsk } from './asks.ts';
import { addBrainAsk, isRefusal, toBrain } from './brainasks.ts';
import { replyRoute, LIVE_REPO } from './replies.ts';
import { TICKET_PREFIX } from './config.ts';

// The owner approves a support reply with a tap or a typed answer on one of the brain's own ask cards. That turn counts as
// his message for reply-add, through the same wiring as main.ts: answerAsk, toBrain, Brain, replyRoute.

// A stand-in for `claude`: one result for each message it gets.
const FAKE = `#!/usr/bin/env node
require('readline').createInterface({ input: process.stdin }).on('line', () => {
  console.log(JSON.stringify({ type: 'result', result: 'SILENT', is_error: false, usage: {} }));
});
`;

const REF = `${TICKET_PREFIX}-1052`;
const QUESTION = `Do I queue the French reply to Malik on ${REF}, sent when PR 5357 is in production?`;
const ADD = { ref: REF, dealership: 'Example Motors', dealershipId: '11111111-2222-3333-4444-555555555555', repo: LIVE_REPO, pr: 5357, text: 'Bonjour Malik,\n\nLe correctif est en production.' };

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-card-'));
  writeFileSync(join(dir, 'claude'), FAKE);
  chmodSync(join(dir, 'claude'), 0o755);
  const brain = new Brain({ cwd: dir, env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, systemPrompt: () => '', brief: () => '[session start] brief' });
  brain.on('log', () => {});
  brain.on('notice', () => {});
  const store = openStore(':memory:');
  const note = toBrain(brain);
  const replyAdd = () => replyRoute(store, () => {}, 'POST', '/api/internal/replies', ADD, { fromOwner: () => brain.answeringOwner, fromOwnerCard: () => brain.answeringOwnerCard })!;
  const ask = (options = ['Yes, as drafted', 'Not yet']) => addBrainAsk(store, { question: QUESTION, options, about: `${REF}, reply` }).body.id!;
  return { brain, store, note, replyAdd, ask };
}

test('a tap on "Yes, as drafted" on a brain ask lets reply-add queue the reply in that turn', async () => {
  const { brain, store, note, replyAdd, ask } = setup();
  try {
    const done = once(brain, 'reply');
    assert.deepEqual(await answerAsk({ id: ask(), value: 'Yes, as drafted', store, log: () => {}, note }), { status: 200 });
    assert.equal(brain.busy, true, 'the answer starts a turn, it does not wait as a held notice');
    assert.equal(brain.answeringOwner, false, 'today --go and --owner-asked still need a chat message');
    const r = replyAdd();
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(store.openSupportReplies().length, 1);
    await done;
    assert.equal(brain.answeringOwnerCard, false, 'the approval ends with the turn');
    assert.equal(replyAdd().status, 409, 'after the turn, nothing counts as his approval');
  } finally { brain.stop(); }
});

test('a typed answer on a brain ask counts too, and a typed or tapped refusal does not', async () => {
  const { brain, store, note, replyAdd, ask } = setup();
  try {
    let done = once(brain, 'reply');
    await answerAsk({ id: ask(), value: 'Not yet', store, log: () => {}, note });
    assert.equal(brain.busy, true);
    assert.equal(replyAdd().status, 409, 'he tapped the refusal');
    await done;
    done = once(brain, 'reply');
    await answerAsk({ id: ask(), value: "no, wait for Sam's check first", store, log: () => {}, note });
    assert.equal(replyAdd().status, 409, 'he typed a refusal');
    await done;
    done = once(brain, 'reply');
    await answerAsk({ id: ask(), value: 'Go ahead, queue it', store, log: () => {}, note });
    const r = replyAdd();
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await done;
  } finally { brain.stop(); }
});

test('a tap on a worker ask, a held notice, or a [check] or [work list] line does not count', async () => {
  const { brain, store, note, replyAdd } = setup();
  try {
    store.insertItem({ source: 'native', external_id: 'msg_1', kind: 'question', dispatch_id: 'n:1', subject: 'x', body: QUESTION, options: JSON.stringify(['Yes', 'No']), status: 'spoken' });
    const native = { reply: async () => ({ ok: true as const }) };
    assert.deepEqual(await answerAsk({ id: 'msg_1', value: 'Yes', store, log: () => {}, note, native }), { status: 200 });
    assert.equal(brain.busy, false, 'a worker ask tap waits as a held notice');
    assert.equal(brain.heldCount, 1);
    const done = once(brain, 'reply');
    brain.send('[check] Your own ask unanswered for 15 min\n\n[work list] the owner told a worker: yes');
    assert.equal(brain.heldCount, 0, 'the held tap rides in this turn');
    const r = replyAdd();
    assert.equal(r.status, 409);
    assert.match((r.body as any).error, /own message, or his answer on your ask card/);
    assert.equal(store.openSupportReplies().length, 0);
    await done;
  } finally { brain.stop(); }
});

test('isRefusal reads the start of the answer, in English and French', () => {
  for (const no of ['No', 'Not yet', 'nope', "Don't send it", 'Do not queue it', 'Wait for the release', 'Hold', 'Cancel', 'Later', 'Non', 'Pas encore', "N'envoie pas", 'Attends', '- no']) assert.equal(isRefusal(no), true, no);
  for (const yes of ['Yes, as drafted', 'Yes', 'Oui', 'Go ahead', 'Queue it', 'Send it when live', 'Nothing to change, queue it']) assert.equal(isRefusal(yes), false, yes);
});
