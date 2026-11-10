import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openStore } from './store.ts';
import { askCard, answerAsk, auditEntries } from './asks.ts';
import { addBrainAsk, brainAskDone, briefLine } from './brainasks.ts';
import { findings, ASK_WAIT_MS } from './check.ts';
import { askMessage } from './push.ts';

const T = Date.parse('2026-11-09T15:00:00Z');
const NEW = { question: 'Which verdict rule should 4686 use?', options: ['Strict match', 'Loose match', 'Ask the dealer'], recommended: 1, about: '4686, verdict rule' };

test('jarvis-act ask stores a question card: the topic as title, the recommended option first, open, no worker', () => {
  const store = openStore(':memory:');
  const r = addBrainAsk(store, NEW, () => T);
  assert.equal(r.status, 200);
  assert.equal(r.body.id, `brain:${T}`);
  const c = askCard(store.item(`brain:${T}`)!)!;
  assert.equal(c.title, '4686, verdict rule');
  assert.equal(c.kind, 'question');
  assert.equal(c.dispatch, null);
  assert.equal(c.question, 'Which verdict rule should 4686 use?');
  assert.deepEqual(c.options.map(o => o.label), ['Loose match', 'Strict match', 'Ask the dealer']);
  assert.equal(c.status, 'open');
  assert.deepEqual(c.parts, {}, 'the heading layout without "What the worker is doing"');
  assert.equal(c.suggested, undefined, 'the first option is a real recommendation');
  // It is an open ask: the push sweep, the brief and the check read openItems().
  assert.deepEqual(store.openItems().map(i => i.external_id), [`brain:${T}`]);
  assert.equal(askMessage(store.item(`brain:${T}`)!).title, 'Jarvis is asking');
  assert.deepEqual(store.recentAsks().map(i => i.external_id), [`brain:${T}`], 'the card is in the chat history after a reload');
});

test('a second ask in the same millisecond gets its own id', () => {
  const store = openStore(':memory:');
  assert.equal(addBrainAsk(store, NEW, () => T).body.id, `brain:${T}`);
  assert.equal(addBrainAsk(store, NEW, () => T).body.id, `brain:${T + 1}`);
});

test('an ask without a question, with one option, or with a bad --recommended is refused and stores nothing', () => {
  const store = openStore(':memory:');
  assert.equal(addBrainAsk(store, { ...NEW, question: ' ' }).status, 400);
  assert.equal(addBrainAsk(store, { ...NEW, options: ['Only one', 'Only one'] }).status, 400);
  assert.equal(addBrainAsk(store, { ...NEW, options: 'a,b' }).status, 400);
  assert.equal(addBrainAsk(store, { ...NEW, recommended: 3 }).status, 400);
  assert.equal(addBrainAsk(store, { ...NEW, recommended: 'x' }).status, 400);
  assert.equal(addBrainAsk(store, { ...NEW, options: ['1', '2', '3', '4', '5', '6', '7'] }).status, 400);
  assert.equal(store.openItems().length, 0);
  assert.equal(addBrainAsk(store, { ...NEW, recommended: undefined }).status, 200, 'no --recommended means the first option');
});


test('a tap on a brain ask closes the card and sends the brain the question and the chosen option', async () => {
  const store = openStore(':memory:');
  const id = addBrainAsk(store, NEW, () => T).body.id!;
  const notes: string[] = [];
  const r = await answerAsk({ id, value: 'Loose match', store, log: () => {}, note: n => notes.push(n) });
  assert.deepEqual(r, { status: 200 });
  assert.deepEqual(notes, [`[ask card answer] Which verdict rule should 4686 use? -> Loose match (message_id=${id}, tapped in the app, about "4686, verdict rule")`]);
  const c = askCard(store.item(id)!)!;
  assert.equal(c.status, 'answered');
  assert.equal(c.answer, 'Loose match');
  assert.equal(store.openItems().length, 0);
  // A second tap is refused and tells the brain nothing.
  const again = await answerAsk({ id, value: 'Strict match', store, log: () => {}, note: n => notes.push(n) });
  assert.equal(again.status, 409);
  assert.equal(notes.length, 1);
  // The audit log lists it with the label.
  const audit = auditEntries(store, i => askCard(i), new Set());
  assert.equal(audit[0].question, 'Which verdict rule should 4686 use?');
  assert.equal(audit[0].answer, 'Loose match');
});

test('a typed answer on a brain ask goes to the brain as typed', async () => {
  const store = openStore(':memory:');
  const id = addBrainAsk(store, { question: 'Which design for 4060?', options: ['Design A', 'Design B'] }, () => T).body.id!;
  const notes: string[] = [];
  const r = await answerAsk({ id, value: 'B, but with the old header', store, log: () => {}, note: n => notes.push(n) });
  assert.equal(r.status, 200);
  assert.deepEqual(notes, [`[ask card answer] Which design for 4060? -> B, but with the old header (message_id=${id}, typed in the app)`]);
  assert.equal(askCard(store.item(id)!)!.title, 'Jarvis is asking');
});

test('jarvis-act ask-done closes the card with the owner\'s chat answer, once', () => {
  const store = openStore(':memory:');
  const id = addBrainAsk(store, NEW, () => T).body.id!;
  assert.equal(brainAskDone(store, { id, answer: '' }).status, 400);
  const r = brainAskDone(store, { id, answer: 'Strict, he said in the chat' });
  assert.equal(r.status, 200);
  assert.equal(r.body.ask?.status, 'answered');
  assert.equal(store.item(id)!.answer, 'Strict, he said in the chat');
  assert.equal(store.openItems().length, 0);
  assert.equal(brainAskDone(store, { id, answer: 'again' }).status, 409);
  // A worker's ask is not the brain's to close this way.
  store.insertItem({ source: 'native', external_id: 'msg_1', kind: 'question', dispatch_id: 'd_1', subject: 'x', status: 'spoken' });
  assert.equal(brainAskDone(store, { id: 'msg_1', answer: 'x' }).status, 404);
  assert.equal(store.item('msg_1')!.status, 'spoken');
});

test('the brief shows an open brain ask with its id, question, options and how to close it', () => {
  const store = openStore(':memory:');
  addBrainAsk(store, NEW, () => T);
  assert.equal(briefLine(store.openItems()[0]),
    `- [brain ask] message_id=brain:${T} about="4686, verdict rule" question="Which verdict rule should 4686 use?" options=["Loose match","Strict match","Ask the dealer"] (your own ask, on a card in the app; when the owner answers in the chat, run jarvis-act ask-done brain:${T} --answer "<his answer>")`);
});

test('the check reports a brain ask unanswered for 15 minutes, though it has no worker', () => {
  const store = openStore(':memory:');
  addBrainAsk(store, NEW, () => T);
  const base = { requests: [], rows: [], closing: () => false, delivery: { master: 'a', unmerged: [] }, lost: [] };
  const created = Date.parse(`${store.openItems()[0].created_at.replace(' ', 'T')}Z`);
  assert.deepEqual(findings({ ...base, asks: store.openItems(), now: created + ASK_WAIT_MS - 1 }), []);
  assert.deepEqual(findings({ ...base, asks: store.openItems(), now: created + ASK_WAIT_MS }), [
    { key: `ask:brain:${T}`, line: `Your own ask unanswered for 15 min: message_id=brain:${T} about="4686, verdict rule" question="Which verdict rule should 4686 use?"` },
  ]);
});

/** Runs bin/jarvis-act against a stand-in jarvisd and returns what it posted. */
function act(args: string[]): Promise<{ path?: string; body?: any; code: number; out: string }> {
  return new Promise(resolve => {
    let seen: { path?: string; body?: any } = {};
    const server = http.createServer((req, res) => {
      let b = ''; req.on('data', c => b += c); req.on('end', () => {
        seen = { path: req.url, body: JSON.parse(b) };
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ id: 'brain:7' }));
      });
    }).listen(0, '127.0.0.1', () => {
      const port = (server.address() as any).port;
      execFile(process.execPath, [fileURLToPath(new URL('../bin/jarvis-act', import.meta.url)), ...args], { env: { PATH: process.env.PATH, JARVIS_URL: `http://127.0.0.1:${port}` } }, (err, out) => {
        server.close();
        resolve({ ...seen, code: err ? (err as any).code : 0, out: out.trim() });
      });
    });
  });
}

test('jarvis-act ask sends every --option in order, and ask-done sends the id and the answer', async () => {
  const a = await act(['ask', '--question', 'Which rule?', '--option', 'Strict', '--option', 'Loose', '--recommended', '1', '--about', '4686']);
  assert.equal(a.path, '/api/internal/ask');
  assert.deepEqual(a.body, { question: 'Which rule?', options: ['Strict', 'Loose'], recommended: '1', about: '4686' });
  assert.equal(a.out, 'ok brain:7');
  const d = await act(['ask-done', 'brain:7', '--answer', 'Strict']);
  assert.equal(d.path, '/api/internal/ask-done');
  assert.deepEqual(d.body, { id: 'brain:7', answer: 'Strict' });
  const bad = await act(['ask-done', 'msg_1', '--answer', 'x']);
  assert.equal(bad.code, 2);
  assert.equal(bad.path, undefined, 'nothing was posted');
});
