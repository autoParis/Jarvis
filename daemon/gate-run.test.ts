import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fakeOrca } from './fakeorca.ts';

const orca = fakeOrca();
const { openStore } = await import('./store.ts');
const { makeGate, connectorsToDeny } = await import('./gate.ts');
const id = { run: 'run_x', handle: 'term_x' };

test('an automatic question starts one worker, logs it with its ids, and a repeat does not start another', async () => {
  const s = openStore(':memory:');
  const lines: string[] = [];
  const gate = makeGate(s, id, () => {}, (m, f) => lines.push(`${m} ${JSON.stringify(f)}`));
  orca.answer(JSON.stringify({ ok: true, result: { dispatchId: 'ctx_9', taskId: 'task_9' } }));
  const args = { repo: '/r', orca: true, question: 'Why is the build slow?' };
  const a = await gate.propose('question', args, 'Looking into it.');
  assert.equal(a.status, 'done');
  assert.match(a.result!, /ctx_9/);
  const again = await gate.propose('question', args, 'Looking into it.');
  assert.equal(again.id, a.id);
  assert.equal(orca.calls().filter(c => c.includes('worker-start')).length, 1);
  assert.match(lines.join('\n'), /gate done .*"run":"run_x","approval":1,"action":"question".*ctx_9/);
});

test('Orca saying ok with no dispatch id is recorded as unknown, not done', async () => {
  const s = openStore(':memory:');
  const gate = makeGate(s, id, () => {});
  s.addTurn({ role: 'owner', text: 'start it' });
  const p = await gate.propose('worker-start', { repo: '/r', orca: true, spec: 'Do #2' }, 'Start #2?');
  s.addTurn({ role: 'owner', text: 'yes' });
  orca.answer(JSON.stringify({ ok: true, result: {} }));
  const a = await gate.confirm(p.id);
  assert.equal(a.status, 'unknown');
  assert.match(a.result!, /no dispatch id/);
});

test('the Side chat button starts a full worker in the repo at once, and the brain cannot propose one', async () => {
  const s = openStore(':memory:');
  const gate = makeGate(s, id, () => {});
  await assert.rejects(gate.propose('side-chat', { repo: '/r', orca: true, text: 'hi' }, 'x'), /only from the owner's button/);
  orca.answer(JSON.stringify({ ok: true, result: { dispatchId: 'ctx_s', taskId: 'task_s' } }));
  const a = await gate.pressed('side-chat', { repo: '/r', orca: true, text: 'Why is staging slow?' }, 'Side chat: Why is staging slow?');
  assert.equal(a.status, 'done');
  assert.equal(a.decided_by, 'button');
  // The spec has line breaks, so the recorded call spans several lines.
  const call = orca.calls().join('\n').slice(orca.calls().join('\n').lastIndexOf('orchestration worker-start'));
  assert.match(call, /worker-start --run run_x --from term_x --worktree path:\/r --agent claude/);
  assert.match(call, /--task-title Side chat: Why is staging slow\?/);
  assert.doesNotMatch(call, /Read-only/);
  orca.answer(JSON.stringify({ ok: true, result: {} }));
  const closed = await gate.pressed('side-chat-close', { dispatch: 'ctx_s' }, 'Close');
  assert.equal(closed.status, 'done');
  assert.match(orca.calls().at(-1)!, /orchestration worker-stop --dispatch ctx_s --json/);
  await assert.rejects(gate.pressed('worker-stop', { dispatch: 'ctx_s' }, 'x'), /not a work-list button/);
});

test('Approve tells every page at once that the action is running, before Orca answers', async () => {
  const s = openStore(':memory:');
  const changes: string[] = [];
  const gate = makeGate(s, id, a => changes.push(a.status));
  const p = await gate.propose('worker-stop', { dispatch: 'ctx_w' }, 'Stop it?');
  orca.answer(JSON.stringify({ ok: true, result: {} }));
  const a = await gate.button(p.id, true);
  assert.equal(a.status, 'done');
  assert.deepEqual(changes, ['pending', 'approved', 'done']);
  await assert.rejects(gate.button(p.id, true), /already decided/);
});

test('Close on a side chat whose dispatch is gone fails with dispatch_inactive in the result', async () => {
  const s = openStore(':memory:');
  const gate = makeGate(s, id, () => {});
  orca.answer(JSON.stringify({ ok: false, error: { code: 'dispatch_inactive', message: 'ctx_000000000001 is not active' } }));
  const a = await gate.pressed('side-chat-close', { dispatch: 'ctx_000000000001' }, 'Close side chat: test');
  assert.equal(a.status, 'failed');
  assert.match(a.result!, /^error dispatch_inactive:/);
});

const REQUEST = '00000000-0000-4000-8000-000000000003';
const blocked = JSON.stringify({ ok: false, error: { code: 'agent_prompt_blocked', message: `agent_prompt_blocked The agent is showing a permission or trust prompt; to answer it, send --text and --enter as separate commands. Terminal prompt request ID: ${REQUEST}. Re-issue the exact command with --retry-request ${REQUEST} --wait-submit <seconds>; do not retry it without that ID.` } });
const accepted = JSON.stringify({ ok: true, result: { send: { accepted: true, bytesWritten: 1 } } });

/** Approves a terminal-send on the button with the queued Orca answers. Returns the approval and only the calls this run made. */
async function approveSend(text: string, ...answers: string[]) {
  const s = openStore(':memory:');
  const lines: string[] = [];
  const gate = makeGate(s, id, () => {}, (m, f) => lines.push(`${m} ${JSON.stringify(f)}`), undefined, undefined, { readBackMs: 0 });
  const before = orca.calls().length;
  const p = await gate.propose('terminal-send', { terminal: 'term_other', text }, 'Answer the prompt?');
  orca.answers(...answers);
  const a = await gate.button(p.id, true);
  return { a, calls: orca.calls().slice(before), lines: lines.join('\n') };
}

test('a menu refusal answers the prompt with the text, then a separate Enter', async () => {
  const { a, calls, lines } = await approveSend('1', blocked, accepted, accepted);
  assert.equal(a.status, 'done');
  assert.deepEqual(calls, [
    'terminal send --terminal term_other --text 1 --enter --json',
    'terminal send --terminal term_other --text 1 --json',
    'terminal send --terminal term_other --enter --json',
  ]);
  // Orca refuses --retry-request on a split send, so the id is kept in the record instead.
  assert.match(a.result!, new RegExp(REQUEST));
  assert.match(lines, new RegExp(`gate done .*${REQUEST}`));
});

const screen = (...tail: string[]) => JSON.stringify({ ok: true, result: { terminal: { tail } } });
const RESUME = 'claude --resume 9b765826-0000-4000-8000-000000000001 --remote-control';

test('a terminal-send is done only when the terminal shows the text after the send', async () => {
  // The text wraps across two lines on a narrow terminal.
  const seen = await approveSend(RESUME, accepted, screen('$ claude --resume 9b765826-0000-4000', '-8000-000000000001 --remote-control', ''));
  assert.equal(seen.a.status, 'done');
  assert.deepEqual(seen.calls, [
    `terminal send --terminal term_other --text ${RESUME} --enter --json`,
    'terminal read --terminal term_other --limit 200 --json',
  ]);
  assert.match(seen.a.result!, /terminal shows it/);
});

test('a terminal-send Orca answers with an empty result is failed, not done', async () => {
  // Approvals 417 and 434: ok true, result {}, and nothing typed.
  const { a, calls } = await approveSend(RESUME, JSON.stringify({ ok: true, result: {} }));
  assert.equal(a.status, 'failed');
  assert.match(a.result!, /did not accept the input/);
  assert.equal(calls.length, 1);
});

test('a terminal-send whose text is not on the terminal afterwards is failed, and a read that fails is unknown', async () => {
  const missing = await approveSend(RESUME, accepted, screen('$ ', ''));
  assert.equal(missing.a.status, 'failed');
  assert.match(missing.a.result!, /does not show it/);
  const unread = await approveSend(RESUME, accepted, JSON.stringify({ ok: false, error: { code: 'terminal_gone', message: 'gone' } }));
  assert.equal(unread.a.status, 'unknown');
  assert.match(unread.a.result!, /could not read the terminal back/);
  const pasted = await approveSend('line one\nline two', accepted, screen('> [Pasted text #1 +2 lines]'));
  assert.equal(pasted.a.status, 'done');
});

test('a send that is not refused for a menu stays one send', async () => {
  const sent = await approveSend('go', accepted, screen('> go'));
  assert.equal(sent.a.status, 'done');
  assert.equal(sent.calls.filter(c => c.startsWith('terminal send')).length, 1);
  const gone = await approveSend('go', JSON.stringify({ ok: false, error: { code: 'terminal_gone', message: 'gone' } }));
  assert.equal(gone.a.status, 'failed');
  assert.equal(gone.calls.length, 1);
});

test('the text step failing or being lost sends no Enter', async () => {
  const lost = await approveSend('1', blocked, 'not json');
  assert.equal(lost.a.status, 'unknown');
  assert.equal(lost.calls.length, 2);
  const refused = await approveSend('1', blocked, JSON.stringify({ ok: false, error: { code: 'terminal_gone', message: 'gone' } }));
  assert.equal(refused.a.status, 'failed');
  assert.equal(refused.calls.length, 2);
  assert.match(refused.a.result!, /terminal_gone/);
  const notTaken = await approveSend('1', blocked, JSON.stringify({ ok: true, result: { send: { accepted: false } } }));
  assert.equal(notTaken.a.status, 'failed');
  assert.equal(notTaken.calls.length, 2);
});

test('the Enter step failing says the text is typed and is not retried', async () => {
  const refused = await approveSend('1', blocked, accepted, JSON.stringify({ ok: false, error: { code: 'terminal_gone', message: 'gone' } }));
  assert.equal(refused.a.status, 'failed');
  assert.equal(refused.calls.length, 3);
  assert.match(refused.a.result!, /text was typed.*terminal_gone/);
  const lost = await approveSend('1', blocked, accepted, 'not json');
  assert.equal(lost.a.status, 'unknown');
  assert.equal(lost.calls.length, 3);
  assert.match(lost.a.result!, /text was typed/);
});

test('text with control characters never goes out raw, since a split send writes it to the terminal verbatim', async () => {
  for (const text of ['1\u001b[A', 'yes\nrm -rf x']) {
    const { a, calls } = await approveSend(text, blocked);
    assert.equal(a.status, 'failed');
    assert.equal(calls.filter(c => c.startsWith('terminal send')).length, 1);
    assert.match(a.result!, /control characters/);
    assert.match(a.result!, new RegExp(REQUEST));
  }
});

test('the split send stays behind the button and the own-terminal guard', async () => {
  const s = openStore(':memory:');
  const gate = makeGate(s, id, () => {});
  const before = orca.calls().length;
  await assert.rejects(gate.propose('terminal-send', { terminal: id.handle, text: '1' }, 'x'), /own terminal/);
  const p = await gate.propose('terminal-send', { terminal: 'term_other', text: '1' }, 'Answer it?');
  s.addTurn({ role: 'owner', text: 'yes' });
  await assert.rejects(gate.confirm(p.id), /only when the owner taps Approve/);
  assert.equal(orca.calls().length, before);
});

test('prompt-key types one digit with no Enter, and a key Orca did not accept is not called done', async () => {
  const store = openStore(':memory:');
  const gate = makeGate(store, id, () => {});
  orca.answers(JSON.stringify({ ok: true, result: { send: { accepted: true } } }), JSON.stringify({ ok: true, result: { send: { accepted: false } } }));
  const before = orca.calls().length;
  assert.equal((await gate.pressed('prompt-key', { terminal: 'term_other', key: '2' }, 'Answer')).status, 'done');
  assert.equal(orca.calls().slice(before)[0], 'terminal send --terminal term_other --text 2 --json');
  assert.equal((await gate.pressed('prompt-key', { terminal: 'term_other', key: '2' }, 'Answer')).status, 'failed');
});

test('session-type from the box runs at once and records the owner\'s words; a sentence on an open menu types nothing', async () => {
  const records: string[] = [];
  const store = openStore(':memory:');
  const gate = makeGate(store, id, a => records.push(a.status));
  orca.answers(JSON.stringify({ ok: true, result: { send: { accepted: true } } }));
  const before = orca.calls().length;
  const a = await gate.pressed('session-type', { terminal: 'term_other', text: 'keep going' }, 'Message');
  assert.equal(a.status, 'done');
  assert.equal(a.decided_by, 'button');
  assert.match(orca.calls().slice(before)[0], /terminal send --terminal term_other --text keep going --enter --wait-submit 5 --json/);
  await assert.rejects(gate.propose('session-type', { terminal: 'term_other', text: 'x' }, 'x'), /only from the owner's button/);

  const blocked = JSON.stringify({ ok: false, error: { code: 'agent_prompt_blocked', message: 'blocked --retry-request r1 now' } });
  orca.answers(blocked);
  const n = orca.calls().length;
  const menu = await gate.pressed('session-type', { terminal: 'term_other', text: 'please carry on' }, 'Message');
  assert.equal(menu.status, 'failed');
  assert.match(menu.result!, /prompt_open/);
  assert.equal(orca.calls().length, n + 1, 'no second send');

  const sent = JSON.stringify({ ok: true, result: { send: { accepted: true } } });
  orca.answers(blocked, sent, sent);
  const m = orca.calls().length;
  const num = await gate.pressed('session-type', { terminal: 'term_other', text: '2' }, 'Message');
  assert.equal(num.status, 'done');
  assert.deepEqual(orca.calls().slice(m).slice(1), ['terminal send --terminal term_other --text 2 --json', 'terminal send --terminal term_other --enter --json']);

  orca.answers(JSON.stringify({ ok: true, result: { send: { accepted: false } } }));
  assert.equal((await gate.pressed('session-type', { terminal: 'term_other', text: 'x' }, 'Message')).status, 'failed');
});

test('a worker whose spec names neither connector gets a worktree that denies both, before the agent starts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-wt-'));
  const s = openStore(':memory:');
  const gate = makeGate(s, id, () => {});
  s.addTurn({ role: 'owner', text: 'start it' });
  const p = await gate.propose('worker-start', { repo: '/r', orca: true, spec: 'Fix the login page', taskTitle: '#7 Login', baseBranch: 'dev' }, 'Start?');
  s.addTurn({ role: 'owner', text: 'yes' });
  const before = orca.calls().length;
  orca.answers(JSON.stringify({ ok: true, result: { worktree: { path: dir } } }), JSON.stringify({ ok: true, result: { dispatchId: 'ctx_c' } }));
  const a = await gate.confirm(p.id);
  assert.equal(a.status, 'done');
  const calls = orca.calls().slice(before).join('\n');
  assert.match(calls, /^worktree create --name 7-login-\d+ --repo path:\/r --no-parent --setup run --json --base-branch dev/);
  assert.match(calls, new RegExp(`worker-start .*--worktree path:${dir} --agent claude --model \\S+ --keep-open --task-title #7 Login`, 's'));
  // After the spec, whose footer quotes a --repo flag for workers.
  assert.doesNotMatch(calls.slice(calls.indexOf('--worktree path:')), /--repo|--base-branch/);
  const settings = JSON.parse(readFileSync(join(dir, '.claude', 'settings.local.json'), 'utf8'));
  assert.deepEqual(settings.permissions.deny, ['mcp__vercel', 'mcp__claude_ai_Voiceflow']);
});

test('a worker whose spec names both connectors keeps them, and starts the usual way', async () => {
  const s = openStore(':memory:');
  const gate = makeGate(s, id, () => {});
  s.addTurn({ role: 'owner', text: 'start it' });
  const p = await gate.propose('worker-start', { repo: '/r', orca: true, spec: 'Compare the VERCEL deploy with the Voiceflow agent' }, 'Start?');
  s.addTurn({ role: 'owner', text: 'yes' });
  const before = orca.calls().length;
  orca.answer(JSON.stringify({ ok: true, result: { dispatchId: 'ctx_k' } }));
  assert.equal((await gate.confirm(p.id)).status, 'done');
  const calls = orca.calls().slice(before).join('\n');
  assert.doesNotMatch(calls, /worktree create/);
  assert.match(calls, /--worktree new-top-level --repo path:\/r/);
});

test('naming one connector denies only the other, and a failed worktree still starts the worker', async () => {
  assert.deepEqual(connectorsToDeny('Check the vercel.app preview'), ['mcp__claude_ai_Voiceflow']);
  assert.deepEqual(connectorsToDeny('Update the Voiceflow prompt'), ['mcp__vercel']);
  const s = openStore(':memory:');
  const gate = makeGate(s, id, () => {});
  s.addTurn({ role: 'owner', text: 'start it' });
  const p = await gate.propose('worker-start', { repo: '/r', orca: true, spec: 'Fix the footer' }, 'Start?');
  s.addTurn({ role: 'owner', text: 'yes' });
  orca.answers(JSON.stringify({ ok: false, error: { code: 'x', message: 'no' } }), JSON.stringify({ ok: true, result: { dispatchId: 'ctx_f' } }));
  assert.equal((await gate.confirm(p.id)).status, 'done');
  assert.match(orca.calls().join('\n').slice(orca.calls().join('\n').lastIndexOf('orchestration worker-start')), /--worktree new-top-level/);
});

// 2026-11-06: five starts approved in one second. Orca typed three of the tasks before Claude Code was ready, saw no turn
// within 30s and answered ok with state outcome_unknown. The gate recorded them done, so three workers sat at an empty prompt.
const unobserved = (dispatch: string) => JSON.stringify({ ok: true, result: { dispatchId: dispatch, taskId: 'task_u', state: 'outcome_unknown' } });
const noTranscript = JSON.stringify({ ok: true, result: { dispatchId: 'ctx_u', source: 'terminal', fallbackReason: 'transcript_missing', terminal: { handle: 'term_u', status: 'running', tail: [] } } });
const transcript = JSON.stringify({ ok: true, result: { dispatchId: 'ctx_u', source: 'transcript', transcript: { messages: [{ role: 'assistant', blocks: [{ type: 'text', text: 'Reading the code.' }] }] } } });
const noWorktree = JSON.stringify({ ok: false, error: { code: 'x', message: 'no worktree' } });

async function startUnobserved(...after: string[]) {
  const s = openStore(':memory:');
  const changes: string[] = [];
  const lines: string[] = [];
  const gate = makeGate(s, id, a => changes.push(`${a.status} ${a.result ?? ''}`), (m, f) => lines.push(`${m} ${JSON.stringify(f)}`), undefined, undefined, { startCheckMs: 1, startChecks: 2 });
  const p = await gate.propose('worker-start', { repo: '/r', orca: true, spec: 'Fix #4880', taskTitle: '#4880 settings' }, 'Start #4880?');
  orca.answers(noWorktree, unobserved('ctx_u'), ...after);
  const before = orca.calls().length;
  const a = await gate.button(p.id, true);
  await gate.checking();
  return { a, s, gate, changes, lines: lines.join('\n'), calls: orca.calls().slice(before), final: s.approval(p.id)! };
}

test('a start whose turn Orca did not see is not recorded as done', async () => {
  const { a } = await startUnobserved(noTranscript, noTranscript);
  assert.equal(a.status, 'unknown');
  assert.match(a.result!, /outcome_unknown/);
  assert.match(a.result!, /ctx_u/);
});

test('a start whose task never reached the agent becomes a clear failure within the check window', async () => {
  const { final, changes, lines, calls } = await startUnobserved(noTranscript, noTranscript);
  assert.equal(final.status, 'failed');
  assert.match(final.result!, /never reached the agent/);
  assert.match(final.result!, /ctx_u/);
  assert.equal(calls.filter(c => c.startsWith('orchestration worker-read --dispatch ctx_u')).length, 2);
  assert.match(changes.at(-1)!, /^failed .*never reached the agent/);
  assert.match(lines, /gate worker start: task never reached the agent .*ctx_u/);
});

test('a slow start that shows a transcript at the check is recorded done', async () => {
  const { final, changes } = await startUnobserved(noTranscript, transcript);
  assert.equal(final.status, 'done');
  assert.match(final.result!, /ctx_u/);
  assert.match(changes.at(-1)!, /^done /);
});

test('worker starts run one at a time, so Claude Code boots alone', async () => {
  const { oneAtATime } = await import('./gate.ts');
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

test('after a restart the gate picks up a start check that was still running', async () => {
  const s = openStore(':memory:');
  const changes: string[] = [];
  const gate = makeGate(s, id, a => changes.push(a.status), () => {}, undefined, undefined, { startCheckMs: 1, startChecks: 1 });
  const a = s.addApproval({ action: 'worker-start', args: JSON.stringify({ repo: '/r', orca: true, spec: 'x' }), say: 'Start?' });
  s.decide(a.id, 'approved', 'button');
  s.finishApproval(a.id, 'unknown', JSON.stringify({ dispatchId: 'ctx_r', taskId: 't', state: 'outcome_unknown', check: 'looking' }));
  orca.answers(transcript);
  assert.equal(gate.resumeChecks(), 1);
  await gate.checking();
  const done = s.approval(a.id)!;
  assert.equal(done.status, 'done');
  assert.deepEqual(JSON.parse(done.result!), { dispatchId: 'ctx_r', taskId: 't', state: 'outcome_unknown' });
});
