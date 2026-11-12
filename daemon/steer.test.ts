import test from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from './store.ts';
import { makeGate } from './gate.ts';
import { stop } from './steer.ts';
import type { WorkRow } from './work.ts';

const row = (extra: Partial<WorkRow>): WorkRow => ({ id: 'n:1', kind: 'worker', dispatch: 'n:1', title: 'pick-and-ship #4460', group: 'story', state: 'working', steer: 'auto', ...extra });

test('Stop asks for Approve, and a row that is not a worker cannot be stopped from here', async () => {
  const gate = makeGate(openStore(':memory:'), () => {});
  const a = await stop(row({}), gate);
  assert.equal(a.body.approval!.action, 'worker-stop');
  assert.equal(a.body.approval!.status, 'pending');
  assert.equal((await stop(row({ id: 't:c', kind: 'session', dispatch: undefined }), gate)).status, 409);
});
