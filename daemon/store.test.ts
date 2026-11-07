import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from './store.ts';

test('a replayed Orca delivery is stored once and open asks exclude answered ones', () => {
  const s = openStore(':memory:');
  const m = { source: 'orca', external_id: 'msg_1', kind: 'question', body: 'Skip the step?' };
  assert.ok(s.insertItem(m));
  assert.equal(s.insertItem(m), undefined);
  assert.equal(s.openItems().length, 1);
  s.markItem('msg_1', 'answered', 'yes');
  assert.equal(s.openItems().length, 0);
});

test('a reply claims the ask once; a refused reply reopens it', () => {
  const s = openStore(':memory:');
  s.insertItem({ source: 'orca', external_id: 'msg_1', kind: 'question' });
  assert.equal(s.claimReply('msg_1'), 'claimed');
  assert.equal(s.claimReply('msg_1'), 'replying');
  assert.equal(s.openItems()[0].status, 'replying'); // still in the brief, flagged
  s.releaseReply('msg_1');
  assert.equal(s.claimReply('msg_1'), 'claimed');
  s.markItem('msg_1', 'answered', 'yes');
  assert.equal(s.claimReply('msg_1'), 'answered');
  s.releaseReply('msg_1'); // only undoes a claim, never an answer
  assert.equal(s.item('msg_1')!.status, 'answered');
  assert.equal(s.claimReply('msg_unknown'), 'untracked');
});

test('the same proposal is found while pending or recent, not after it failed', () => {
  const s = openStore(':memory:');
  const a = s.addApproval({ action: 'question', args: '{"q":1}', say: 'x' });
  assert.equal(s.sameApproval('question', '{"q":1}')!.id, a.id);
  assert.equal(s.sameApproval('question', '{"q":2}'), undefined);
  s.finishApproval(a.id, 'done', '{}');
  assert.equal(s.sameApproval('question', '{"q":1}')!.id, a.id);
  s.db.prepare(`UPDATE approvals SET created_at = datetime('now', '-11 minutes') WHERE id = ?`).run(a.id);
  assert.equal(s.sameApproval('question', '{"q":1}'), undefined);
  const b = s.addApproval({ action: 'question', args: '{"q":3}', say: 'x' });
  s.finishApproval(b.id, 'failed', 'boom');
  assert.equal(s.sameApproval('question', '{"q":3}'), undefined);
});

test('messages from before settled_at are not in question; a new one waits until it is settled', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'jarvis-store-')), 'old.db');
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE turns (id INTEGER PRIMARY KEY, role TEXT NOT NULL, text TEXT NOT NULL, session_id TEXT, input_tokens INTEGER, cache_read INTEGER, cache_write INTEGER, output_tokens INTEGER, latency_ms INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    INSERT INTO turns (role, text) VALUES ('owner', 'old message');`);
  old.close();
  const s = openStore(path);
  assert.deepEqual(s.unsettledTurns(), []);
  const id = s.addTurn({ role: 'owner', text: 'new message' });
  s.addTurn({ role: 'jarvis', text: 'not a message from the owner' });
  assert.deepEqual(s.unsettledTurns().map(t => t.text), ['new message']);
  s.settleTurns([id]);
  assert.deepEqual(s.unsettledTurns(), []);
});

test('answering a worker\'s later ask closes the asks it raised before; later and other workers\' asks stay open', () => {
  const s = openStore(':memory:');
  const ask = (id: string, dispatch: string | null, kind = 'question') => s.insertItem({ source: 'orca', external_id: id, kind, dispatch_id: dispatch });
  ask('old_q', 'd_1'); ask('old_e', 'd_1', 'escalation'); ask('sending', 'd_1'); ask('answered', 'd_1'); ask('newer', 'd_1'); ask('other', 'd_2'); ask('no_worker', null);
  s.claimReply('sending');
  assert.deepEqual(s.closeEarlierAsks(), [], 'nothing answered yet');
  s.markItem('answered', 'answered', 'yes');
  assert.deepEqual(s.closeEarlierAsks().sort(), ['old_e', 'old_q']);
  assert.equal(s.item('old_q')!.status, 'done');
  assert.equal(s.item('sending')!.status, 'replying', 'a reply going out is left to finish');
  assert.deepEqual(s.openItems().map(i => i.external_id), ['sending', 'newer', 'other', 'no_worker']);
  assert.deepEqual(s.closeEarlierAsks(), []);
  s.markItem('newer', 'answered', 'no');
  assert.deepEqual(s.openItems().map(i => i.external_id), ['sending', 'other', 'no_worker']);
});

test('a work row is read back by id, and no other turn can be read that way', () => {
  const store = openStore(':memory:');
  const work = store.addTurn({ role: 'jarvis-work', text: '{"ms":5,"steps":[]}' });
  const said = store.addTurn({ role: 'owner', text: 'private' });
  assert.equal(store.workSteps(work), '{"ms":5,"steps":[]}');
  assert.equal(store.workSteps(said), undefined);
  assert.equal(store.recentTurns(5)[0].id, work);
});

test('a worker\'s answers come oldest first, without open asks or other workers', () => {
  const s = openStore(join(mkdtempSync(join(tmpdir(), 'jarvis-store-')), 'j.db'));
  const ask = (id: string, dispatch: string) => s.insertItem({ source: 'orca', external_id: id, kind: 'question', dispatch_id: dispatch });
  ask('a', 'd1'); ask('b', 'd1'); ask('c', 'd2'); ask('open', 'd1');
  s.markItem('a', 'answered', 'first');
  s.markItem('b', 'answered', 'second', 'jarvis');
  s.markItem('c', 'answered', 'other worker');
  assert.deepEqual(s.answersTo('d1').map(i => [i.external_id, i.answer, i.answered_by]), [['a', 'first', null], ['b', 'second', 'jarvis']]);
});
