import test from 'node:test';
import assert from 'node:assert/strict';
import { makeLog } from './log.ts';

test('log lines carry the base ids, read at call time, plus the event fields', () => {
  const lines: string[] = [];
  const base: { run?: string } = {};
  const log = makeLog(base, l => lines.push(l));
  log('starting');
  base.run = 'run_x1';
  log('gate done', { approval: 4 });
  assert.match(lines[0], /^\d{4}-\d\d-\d\dT\S+ starting$/);
  assert.deepEqual(JSON.parse(lines[1].slice(lines[1].indexOf('{'))), { run: 'run_x1', approval: 4 });
});
