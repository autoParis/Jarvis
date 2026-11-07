import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from './store.ts';
import { quoteOf, quoteLine, replyIdOf, QUOTE_CHARS } from './quote.ts';
import { messageFootHtml, quoteHtml, quoteSnippet } from '../web/workfold.js';
import { replyLock, replyOffset, REPLY_SWIPE } from '../web/swipe.js';

test('the brain line names who wrote the quoted message and when, in Eastern time', () => {
  const line = quoteLine({ id: 4, role: 'jarvis', text: 'Merge PR 412 now?\nIt passed CI.', at: '2026-11-07T20:18:00Z' });
  assert.equal(line, '[replying to jarvis, 11-07 3:18 p.m. Eastern: "Merge PR 412 now? It passed CI."]');
  const own = quoteLine({ id: 5, role: 'owner', text: 'Say "yes" to it', at: '2026-11-07T13:05:00Z' });
  assert.equal(own, `[replying to his own message, 11-07 8:05 a.m. Eastern: "Say 'yes' to it"]`, 'inner double quotes cannot end the quote');
});

test('the brain line keeps the first 200 characters of a long message', () => {
  const line = quoteLine({ id: 4, role: 'jarvis', text: 'a'.repeat(500), at: '2026-11-07T20:18:00Z' });
  assert.ok(line.includes(`"${'a'.repeat(QUOTE_CHARS)}…"`));
});

test('only a message from the owner or Jarvis can be quoted', () => {
  const at = '2026-11-07 20:18:00';
  assert.deepEqual(quoteOf({ id: 3, role: 'jarvis', text: 'hi', created_at: at }), { id: 3, role: 'jarvis', text: 'hi', at: '2026-11-07T20:18:00Z' });
  assert.equal(quoteOf({ id: 3, role: 'event', text: '- [question] x', created_at: at }), undefined);
  assert.equal(quoteOf(undefined), undefined);
});

test('a bad reply id is dropped, so the message still goes out', () => {
  assert.equal(replyIdOf(12), 12);
  assert.equal(replyIdOf('12'), 12);
  for (const v of [0, -1, 1.5, '12a', null, undefined, {}]) assert.equal(replyIdOf(v), undefined);
});

test('the store keeps the quoted turn with the reply, and history brings it back', () => {
  const s = openStore(':memory:');
  const asked = s.addTurn({ role: 'jarvis', text: 'Merge PR 412 now?' });
  const answer = s.addTurn({ role: 'owner', text: 'Yes', reply_to: asked });
  const plain = s.addTurn({ role: 'owner', text: 'Thanks' });
  const rows = s.recentTurns(10);
  assert.equal(rows.find(r => r.id === answer)!.reply_to, asked);
  assert.equal(rows.find(r => r.id === plain)!.reply_to, null);
  assert.equal(quoteOf(s.turn(asked))!.text, 'Merge PR 412 now?');
});

test('an older database gets the reply_to column', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'jarvis-quote-')), 'old.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE turns (id INTEGER PRIMARY KEY, role TEXT NOT NULL, text TEXT NOT NULL, session_id TEXT,
    input_tokens INTEGER, cache_read INTEGER, cache_write INTEGER, output_tokens INTEGER, latency_ms INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), settled_at TEXT)`);
  db.close();
  const s = openStore(file);
  const id = s.addTurn({ role: 'owner', text: 'hi', reply_to: 1 });
  assert.equal(s.recentTurns(1)[0].reply_to, 1);
  assert.equal(s.turn(id)!.text, 'hi');
});

test('the reply button sits between copy and the speaker, and only on a message with a turn id', () => {
  const html = messageFootHtml('2026-11-02T20:18:00Z', { id: 41, clips: 3 }, 41);
  assert.ok(html.indexOf('msg-copy') < html.indexOf('msg-reply') && html.indexOf('msg-reply') < html.indexOf('msg-speak'));
  assert.ok(messageFootHtml('2026-11-02T20:18:00Z', null, 7).includes('msg-reply'), "The owner's own message has it too");
  assert.ok(!messageFootHtml('2026-11-02T20:18:00Z', null).includes('msg-reply'));
});

test('the quote shows who and the first line, and links to the quoted turn', () => {
  assert.equal(quoteSnippet('## Heading\n\nbody'), 'Heading');
  assert.equal(quoteSnippet('\n- **Merge** PR 412?'), 'Merge PR 412?');
  assert.equal(quoteSnippet('[image: /a/b.png]\nlook'), 'Picture');
  assert.ok(quoteSnippet('x'.repeat(300)).length <= 120);
  const html = quoteHtml({ id: 9, role: 'jarvis', text: 'Merge <now>?' });
  assert.ok(html.includes('data-quote="9"') && html.includes('<b>Jarvis</b>') && html.includes('Merge &lt;now&gt;?'));
  assert.ok(quoteHtml({ id: 9, role: 'owner', text: 'x' }).includes('<b>You</b>'));
  assert.equal(quoteHtml(undefined), '');
});

test('the swipe locks on a leftward drag only, and a short drag does not reach the threshold', () => {
  assert.equal(replyLock(-4, 2), null, 'too short to tell');
  assert.equal(replyLock(-30, 5), 'reply');
  assert.equal(replyLock(-20, 20), 'none', 'a diagonal is a scroll');
  assert.equal(replyLock(5, 40), 'none', 'a vertical scroll');
  assert.equal(replyLock(30, 0), 'none', 'a drag to the right');
  assert.equal(replyOffset(-30), -30, 'the message follows the finger');
  assert.equal(replyOffset(20), 0, 'never to the right');
  assert.ok(replyOffset(-400) >= -REPLY_SWIPE.max, 'never past max');
  assert.ok(replyOffset(-REPLY_SWIPE.threshold - 40) > -REPLY_SWIPE.threshold - 40, 'slower past the threshold');
});
