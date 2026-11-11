import test from 'node:test';
import assert from 'node:assert/strict';
import { lastModel } from './resume.ts';

test('the model comes out of the transcript', () => {
  assert.equal(lastModel('{"model":"claude-haiku-5-5"}\n{"model":"claude-opus-5-5"}'), 'claude-opus-5-5');
  assert.equal(lastModel('{"message":{"model":"claude-haiku-5-5","id":"msg_1"}}\n{"tools":[{"model":"claude-opus-5-5","defer_loading":true}]}'), 'claude-haiku-5-5', 'an answer\'s model wins over a tool definition after it');
});
