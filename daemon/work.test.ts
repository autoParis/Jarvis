import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, findPr } from './work.ts';

test('tasks sort into stories, babysitters, side chats and other', () => {
  assert.deepEqual(classify('pick-and-ship #4460'), { group: 'story', label: '#4460' });
  assert.deepEqual(classify('Fix onboarding', 'Run the pick-and-ship skill on issue #4412.'), { group: 'story', label: '#4412' });
  assert.deepEqual(classify('babysit PR #4533'), { group: 'babysit', label: 'PR #4533' });
  assert.deepEqual(classify('Drive it', 'Babysit https://github.com/o/r/pull/77 to READY'), { group: 'babysit', label: 'PR #77' });
  assert.deepEqual(classify('Side chat: why is #4460 slow?'), { group: 'side' });
  assert.deepEqual(classify('Question: why is the build slow'), { group: 'other' });
  assert.deepEqual(classify('issue-4531-screens'), { group: 'story', label: '#4531' });
  assert.deepEqual(classify('MANAGER', 'You have 1 orchestration message.'), { group: 'other' });
});

test('a finished worker\'s PR is a link when it wrote one, otherwise a number', () => {
  assert.deepEqual(findPr('Shipped, see https://github.com/o/r/pull/12 for it'), { pr: 'PR #12', url: 'https://github.com/o/r/pull/12' });
  assert.deepEqual(findPr('#4460 READY: PR #4533'), { pr: 'PR #4533' });
  assert.deepEqual(findPr('nothing here'), {});
});
