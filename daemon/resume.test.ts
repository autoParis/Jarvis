import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { makeResumer, resumeArgv, sessionIdOf, lastModel } from './resume.ts';

const ID = '00000000-0000-4000-8000-000000000005';
const FILE = `/home/.claude/projects/x/${ID}.jsonl`;
const target = { rowId: 's:c', file: FILE, cwd: '/w/a' };

function fakeProc() {
  const p: any = new EventEmitter();
  p.stdout = new EventEmitter(); p.stderr = new EventEmitter();
  p.input = '';
  p.stdin = Object.assign(new EventEmitter(), { end: (t: string) => { p.input = t; } });
  p.kill = () => {};
  return p;
}
function setup(o: { ps?: string[]; age?: number } = {}) {
  const procs: any[] = [], argvs: string[][] = [], done: [string, boolean][] = [];
  const r = makeResumer({
    log: () => {}, now: () => 1_000_000, processes: async () => o.ps ?? [], written: () => 1_000_000 - (o.age ?? 60_000),
    tail: () => '{"message":{"model":"claude-opus-5-5"}}',
    spawn: (argv, cwd) => { argvs.push([cwd, ...argv]); const p = fakeProc(); procs.push(p); return p; },
    onDone: (id, ok) => done.push([id, ok]),
  });
  return { r, procs, argvs, done };
}
const finish = (p: any, line: object, code = 0) => { p.stdout.emit('data', Buffer.from(JSON.stringify(line) + '\n')); p.emit('close', code); };

test('session ids and models come out of the transcript', () => {
  assert.equal(sessionIdOf(FILE), ID);
  assert.equal(sessionIdOf(`/home/.codex/sessions/2026/rollout-2026-11-02T10-00-00-${ID}.jsonl`), ID);
  assert.equal(sessionIdOf('/home/.claude/projects/x/nope.jsonl'), undefined);
  assert.equal(lastModel('{"model":"claude-haiku-5-5"}\n{"model":"claude-opus-5-5"}'), 'claude-opus-5-5');
  assert.deepEqual(resumeArgv(`/home/.codex/sessions/${ID}.jsonl`, ID).slice(0, 3), ['codex', 'exec', 'resume']);
});

test('one message runs one process in the session\'s folder, on its model, with the text on stdin', async () => {
  const t = setup();
  assert.deepEqual(await t.r.send(target, '--not-a-flag'), { started: true });
  assert.equal(t.argvs[0][0], '/w/a');
  assert.deepEqual(t.argvs[0].slice(1, 5), ['claude', '-p', '--resume', ID]);
  assert.ok(t.argvs[0].includes('claude-opus-5-5'));
  assert.ok(!t.argvs[0].includes('--not-a-flag'));
  assert.ok(t.argvs[0].includes('Bash(gh pr merge:*)'), 'Sam merges');
  assert.equal(t.procs[0].input, '--not-a-flag');
  assert.equal(t.r.busy('s:c'), true);
  assert.match((await t.r.send(target, 'again') as any).error, /still answering/);
  assert.equal(t.procs.length, 1);
  finish(t.procs[0], { type: 'result', is_error: false, result: 'OK' });
  assert.equal(t.r.busy('s:c'), false);
  assert.deepEqual(t.done, [['s:c', true]]);
  assert.equal(t.r.failure('s:c'), undefined);
});

test('a second writer is refused: another process on the session, or a file written seconds ago', async () => {
  const other = setup({ ps: [`claude --resume ${ID}`] });
  assert.match((await other.r.send(target, 'hi') as any).error, /another process/);
  assert.equal(other.procs.length, 0);
  assert.equal(other.r.busy('s:c'), false);
  const fresh = setup({ age: 2_000 });
  assert.match((await fresh.r.send(target, 'hi') as any).error, /seconds ago/);
  assert.equal(fresh.procs.length, 0);
});

test('an idle Orca chat tab on the session does not block, but the reply warns its tab will not see the turn', async () => {
  const t = setup({ ps: [`/opt/homebrew/bin/claude --plugin-dir /Applications/Orca.app/Contents/Resources/native-chat-visuals --session-id=${ID}`] });
  const r: any = await t.r.send(target, 'hi');
  assert.equal(r.started, true);
  assert.match(r.warning, /Orca tab/);
  assert.equal(t.procs.length, 1);
});

test('no success result is a failure, even with exit code 0, and the next message clears it', async () => {
  const t = setup();
  await t.r.send(target, 'hi');
  t.procs[0].stderr.emit('data', Buffer.from('boom'));
  t.procs[0].emit('close', 0);
  assert.equal(t.r.failure('s:c'), 'boom');
  await t.r.send(target, 'again');
  assert.equal(t.r.failure('s:c'), undefined);
  finish(t.procs[1], { type: 'result', is_error: true, result: 'Credit balance too low' }, 1);
  assert.equal(t.r.failure('s:c'), 'Credit balance too low');
  await t.r.send(target, 'codex');
  finish(t.procs[2], { type: 'turn.completed' });
  assert.equal(t.r.failure('s:c'), undefined);
});
