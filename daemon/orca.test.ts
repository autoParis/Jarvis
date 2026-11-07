import test from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from './store.ts';
import { storeMessages, takeDelivery } from './orca.ts';

test('a replayed delivery is handed over again only if jarvisd stopped before handing it over', () => {
  const s = openStore(':memory:');
  const msgs = [
    { id: 'm1', type: 'question', subject: 'Skip?', payload: JSON.stringify({ dispatchId: 'ctx_1', options: ['a', 'b'] }) },
    { id: 'm2', type: 'heartbeat' },
  ];
  const first = storeMessages(s, msgs);
  assert.deepEqual(first.map(i => i.external_id), ['m1']);
  assert.equal(first[0].dispatch_id, 'ctx_1');
  assert.equal(s.item('m2')!.status, 'done');
  // Crash before onItems: m1 is stored but still 'new', so the replay brings it back.
  assert.deepEqual(storeMessages(s, msgs).map(i => i.external_id), ['m1']);
  // Handed over (main.ts marks it spoken): the replay is dropped.
  s.markItem('m1', 'spoken');
  assert.deepEqual(storeMessages(s, msgs), []);
});

test('a batch with no delivery id is still stored: Orca already marked it handled, so skipping it loses the mail', () => {
  const s = openStore(':memory:');
  const r = takeDelivery(s, { messages: [{ id: 'm9', type: 'worker_done', subject: 'Done', body: 'b', payload: '{"dispatchId":"ctx_1","outcome":"succeeded"}' }] });
  assert.deepEqual(r.fresh.map(i => i.external_id), ['m9']);
  assert.equal(r.ack, undefined);
  assert.equal(JSON.parse(s.item('m9')!.meta!).outcome, 'succeeded');
  assert.deepEqual(takeDelivery(s, { deliveryId: 'd', messages: [] }), { fresh: [] });
});
