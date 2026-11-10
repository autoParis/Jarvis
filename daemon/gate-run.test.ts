import test from 'node:test';
import assert from 'node:assert/strict';
import { oneAtATime } from './gate.ts';

test('worker starts run one at a time, so Claude Code boots alone', async () => {
  const queue = oneAtATime();
  let running = 0, most = 0;
  const job = () => queue(async () => { running++; most = Math.max(most, running); await new Promise(r => setTimeout(r, 5)); running--; return 'ok'; });
  const done = await Promise.all([job(), job(), job(), job(), job()]);
  assert.deepEqual(done, ['ok', 'ok', 'ok', 'ok', 'ok']);
  assert.equal(most, 1);
  // A job that throws does not stop the next one.
  await assert.rejects(queue(async () => { throw new Error('boom'); }), /boom/);
  assert.equal(await queue(async () => 'next'), 'next');
});
