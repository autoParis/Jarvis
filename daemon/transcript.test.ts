import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { workerLines, chatLines, readChatFile, readSource, findChatFile, orcaMessage, showReplies, withEvents, fileCursor, CLIP, type Answer, type Line, type ReplyMemo } from './transcript.ts';

test('worker messages become text and one-line tool calls; clipped text is marked', () => {
  const lines = workerLines([
    { id: 'm1', role: 'user', timestamp: 1, blocks: [{ type: 'text', text: 'Do the thing\n… (truncated)' }] },
    { id: 'm2', role: 'reasoning', blocks: [{ type: 'text', text: 'thinking' }] },
    { id: 'm3', role: 'assistant', timestamp: 2, blocks: [{ type: 'text', text: 'x'.repeat(CLIP + 10) }, { type: 'tool-call', name: 'Bash', input: { command: 'npm\n test' } }, { type: 'tool-result', output: 'ok' }] },
  ]);
  assert.deepEqual(lines.map(l => [l.role, l.text.length > 50 ? l.text.length : l.text, !!l.clipped]), [
    ['user', 'Do the thing', true],
    ['agent', CLIP, true],
    ['tool', 'Bash: npm test', false],
  ]);
});

test('Claude Code and Codex transcripts read alike, without injected turns or tool output', () => {
  const jsonl = [
    { type: 'user', message: { content: '<system-reminder>x</system-reminder>' } },
    { type: 'user', timestamp: '2026-10-30T10:00:00Z', message: { content: 'keep going!' } },
    { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'hm' }, { type: 'text', text: 'On it.' }, { type: 'tool_use', name: 'Read', input: { file_path: '/a.ts' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', content: 'file body' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Drafts saved.' }] } },
    { type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{"command":"ls"}' } },
    { type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'rules' }] } },
  ].map(e => JSON.stringify(e)).join('\n') + '\n';
  assert.deepEqual(chatLines(jsonl, 0).map(l => [l.role, l.text]), [
    ['user', 'keep going!'], ['agent', 'On it.'], ['tool', 'Read: /a.ts'], ['agent', 'Drafts saved.'], ['tool', 'shell: ls'],
  ]);
});

test('a chat file is read from its cursor, complete lines only', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'jarvis-tr-')), 's.jsonl');
  const line = (text: string) => JSON.stringify({ type: 'assistant', message: { content: text } }) + '\n';
  writeFileSync(file, line('one') + line('two'));
  const first = readChatFile(file);
  assert.deepEqual(first.lines.map(l => l.text), ['one', 'two']);
  assert.deepEqual(readChatFile(file, first.cursor).lines, []);
  appendFileSync(file, line('three') + '{"type":"assistant","mess');
  const second = readChatFile(file, first.cursor);
  assert.deepEqual(second.lines.map(l => l.text), ['three'], 'the half-written line waits for the next read');
  appendFileSync(file, 'age":{"content":"four"}}\n');
  assert.deepEqual(readChatFile(file, second.cursor).lines.map(l => l.text), ['four']);
  assert.equal(readChatFile(file, 'f:999999').reset, true);
});

test('a worker read pages forward until the cursor stops moving, and restarts when the source changed', async () => {
  const pages = [[{ id: 'a', role: 'assistant', blocks: [{ type: 'text', text: 'first' }] }], [{ id: 'b', role: 'assistant', blocks: [{ type: 'text', text: 'second' }] }]];
  const calls: string[][] = [];
  const orca = async (args: string[]) => {
    calls.push(args);
    const at = args.includes('--cursor') ? Number(args[args.indexOf('--cursor') + 1]) : 0;
    if (at === 9) return { ok: false, error: { code: 'source_changed', message: '' } };
    // Orca 1.4.244 says limited even on the last, empty page.
    return { ok: true, result: { transcript: { messages: pages[at] ?? [], nextCursor: String(Math.min(at + 1, pages.length)), limited: true } } };
  };
  const r = await readSource(orca, { kind: 'worker', dispatch: 'd' }, undefined, new Map());
  assert.deepEqual(r.lines.map(l => l.text), ['first', 'second']);
  assert.equal(r.cursor, '2');
  assert.equal(r.more, false);
  assert.equal(calls.length, 3);
  assert.deepEqual(await readSource(orca, { kind: 'worker', dispatch: 'd' }, '9', new Map()), { lines: [], reset: true });
});

test('a chat transcript path comes from the search hit for that exact session, inside the transcript folders only', async () => {
  const hits = [
    { structuredSession: { sessionId: 'other' }, source: { filePath: '/home/.claude/projects/x/other.jsonl' } },
    { structuredSession: { sessionId: 'claude_88' }, source: { filePath: '/home/.claude/projects/x/88.jsonl' } },
    { structuredSession: { sessionId: 'evil' }, source: { filePath: '/etc/passwd' } },
  ];
  const orca = async () => ({ ok: true, result: { hits } });
  const src = (key: string) => ({ kind: 'chat' as const, key, cwd: '/w', query: 'words' });
  assert.equal(await findChatFile(orca, src('claude_88'), ['/home/.claude/projects/']), '/home/.claude/projects/x/88.jsonl');
  assert.equal(await findChatFile(orca, src('evil'), ['/home/.claude/projects/']), undefined);
  assert.equal(await findChatFile(orca, src('missing'), ['/home/.claude/projects/']), undefined);
});

test('a terminal agent\'s transcript is the file holding its last message, never a chat tab\'s or another folder\'s', async () => {
  const hits = [
    { cwd: '/w/a', structuredSession: { sessionId: 'tab' }, source: { filePath: '/home/.claude/projects/x/tab.jsonl' } },
    { cwd: '/w/b', source: { filePath: '/home/.claude/projects/x/other-folder.jsonl' } },
    { cwd: '/w/a', source: { filePath: '/home/.claude/projects/x/one-word-match.jsonl' } },
    { cwd: '/w/a', source: { filePath: '/home/.claude/projects/x/right.jsonl' } },
  ];
  const orca = async () => ({ ok: true, result: { hits } });
  const tail = (f: string) => f.endsWith('right.jsonl') || f.endsWith('tab.jsonl') || f.endsWith('other-folder.jsonl') ? '{"text":"All \\"done\\" here"}' : '{"text":"other"}';
  const ref = { key: 'pane:1', cwd: '/w/a', query: 'All done here', probe: 'All "done" here' };
  assert.equal(await findChatFile(orca, ref, ['/home/.claude/projects/'], tail), '/home/.claude/projects/x/right.jsonl');
  assert.equal(await findChatFile(orca, { ...ref, probe: undefined }, ['/home/.claude/projects/'], tail), undefined);
  assert.equal(await findChatFile(orca, { ...ref, probe: 'not there' }, ['/home/.claude/projects/'], tail), undefined);
});

test('an ask and a worker_done read as whole messages, however the command is written', () => {
  const long = 'x'.repeat(1972);
  assert.deepEqual(orcaMessage(`git status; orca orchestration ask --from term_1 --options "A,B" --question "STORY: 12 fold\nQUESTION: ${long}?"`),
    { kind: 'ask', text: `STORY: 12 fold\nQUESTION: ${long}?\n\nOptions: A, B` });
  assert.equal(orcaMessage(`orca orchestration ask --question "STORY: 1\nOPTIONS:\n- A because b" --options "A"`)?.text, 'STORY: 1\nOPTIONS:\n- A because b', 'options already in the question are not repeated');
  assert.deepEqual(orcaMessage(`git push && orca orchestration send --from t --type worker_done --subject "It's done" --body 'He said "ok" and it'\\''s in' --task-id t1 --outcome succeeded 2>&1 | tail -1`),
    { kind: 'done', text: `**It's done**\n\nHe said "ok" and it's in` });
  assert.deepEqual(orcaMessage(`orca orchestration send --type=worker_done --outcome=failed --body="cost \\$5\\nsee \\"log\\""`),
    { kind: 'done', text: 'cost $5\nsee "log"', failed: true });
  assert.deepEqual(orcaMessage(`orca orchestration send --type escalation --subject "Blocked: tests" --body "Red"`), { kind: 'blocked', text: '**Blocked: tests**\n\nRed' });
  assert.equal(orcaMessage(`/opt/bin/jarvis-orca ask --question "Which one?"`)?.text, 'Which one?');
  assert.deepEqual(orcaMessage(`orca orchestration send --type worker_done --subject S --body "$(cat <<'EOF'\nline one's\n\nline two\nEOF\n)"`), { kind: 'done', text: `**S**\n\nline one's\n\nline two` });
});

test('commands that only mention an ask stay tool rows', () => {
  for (const c of [
    'orca orchestration ask --help | head',
    'grep -n "orca orchestration ask --question x" web/index.html',
    'orca orchestration send --to dispatch:1 --subject Hi --body Yo',
    'orca orchestration send --type worker_done --body "$(make_report)"',
    'echo worker_done',
  ]) assert.equal(orcaMessage(c), undefined, c);
});

const CLAUDE_ASK = { type: 'assistant', timestamp: '2026-11-03T10:00:00Z', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: `orca orchestration ask --question "${'q'.repeat(500)}"` } }] } };
test('both session formats and Orca transcripts carry the whole message, past the 200 characters of a tool row', () => {
  const codex = (payload: object) => ({ type: 'response_item', payload });
  const q = 'q'.repeat(500);
  const lines = chatLines([
    CLAUDE_ASK,
    codex({ type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: `orca orchestration ask --question "${q}"` }) }),
    codex({ type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['bash', '-lc', `orca orchestration send --type worker_done --body "${q}"`] }) }),
    codex({ type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['ls', '-la'] }) }),
    codex({ type: 'custom_tool_call', name: 'shell', input: `orca orchestration ask --question "${q}"` }),
  ].map(e => JSON.stringify(e)).join('\n') + '\n', 0);
  assert.deepEqual(lines.map(l => [l.role, l.kind, l.text.length > 100 ? l.text.length : l.text]), [
    ['agent', 'ask', 500], ['agent', 'ask', 500], ['agent', 'done', 500], ['tool', undefined, 'shell: ls -la'], ['agent', 'ask', 500],
  ]);
  const [m] = workerLines([{ id: 'm', role: 'assistant', blocks: [{ type: 'tool-call', name: 'Bash', input: { command: `orca orchestration ask --question "${q}"` } }] }]);
  assert.deepEqual([m.role, m.kind, m.text.length], ['agent', 'ask', 500]);
});

test("Orca's brief and wake-ups are marked, with their text intact, and a person's words are not", () => {
  const brief = 'Please carry out this task.\n\n<pasted_content id="1">\nYou are working inside Orca, a multi-agent IDE. --dispatch-id ctx_1\n=== TASK ===\nDo it';
  const user = (content: string) => ({ type: 'user', timestamp: '2026-11-03T10:00:00Z', message: { content } });
  const codexUser = (text: string) => ({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
  const lines = chatLines([
    user(brief), user('\nYou have 1 orchestration message. Run `orca orchestration check`.'), user('Why do you have 1 orchestration message?'),
    codexUser('You are working inside Orca, a multi-agent IDE.'), codexUser('You have 2 orchestration messages. Run `orca orchestration check --run r`.'),
  ].map(e => JSON.stringify(e)).join('\n') + '\n', 0);
  assert.deepEqual(lines.map(l => l.kind), ['preamble', 'wake', undefined, 'preamble', 'wake']);
  assert.equal(lines[0].text, brief, 'findWorkerSession looks for --dispatch-id in this text');
});

test('a wake-up shows the answer it stands for, once, and every pane shows the same', () => {
  const T = Date.parse('2026-11-03T10:00:00Z');
  const wake = (id: string, min: number): Line => ({ id, role: 'user', kind: 'wake', at: T + min * 60_000, text: 'You have 1 orchestration message.' });
  const a = (id: string, min: number, by?: 'jarvis'): Answer => ({ id, text: `answer ${id}`, at: T + min * 60_000, ...(by ? { by } : {}) });
  const memo: ReplyMemo = { used: new Set(), shown: new Map() };
  const answers = [a('one', 0), a('two', 10, 'jarvis'), a('three', 20), a('four', 20.1)];
  // A steer has no row in items, so its wake at minute 15 stays a wake, and the wake at 30 gets both answers it missed.
  const lines = [wake('w1', 1), wake('w2', 11), wake('w3', 15), wake('w4', 30)];
  showReplies(lines, answers, memo);
  assert.deepEqual(lines.map(l => [l.kind, l.text.startsWith('answer') ? l.text : '-', l.by]), [
    ['reply', 'answer one', undefined], ['reply', 'answer two', 'jarvis'], ['wake', '-', undefined], ['reply', 'answer three\n\nanswer four', undefined],
  ]);
  const again = [wake('w2', 11)];
  showReplies(again, answers, memo);
  assert.equal(again[0].text, 'answer two', 'a second pane reading the same line');
});

test('a wake-up before its answer is recorded, or in a read that starts partway, shows nothing false', () => {
  const T = 1_000_000_000;
  const wake: Line = { id: 'w', role: 'user', kind: 'wake', at: T, text: 'You have 1 orchestration message.' };
  const memo = (): ReplyMemo => ({ used: new Set(), shown: new Map() });
  const late = [{ ...wake }];
  showReplies(late, [{ id: 'a', text: 'later', at: T + 60_000 }], memo());
  assert.equal(late[0].kind, 'wake');
  const partway = [{ ...wake }];
  showReplies(partway, [{ id: 'a', text: 'old', at: T - 90_000 }, { id: 'b', text: 'newest', at: T - 1000 }], memo());
  assert.equal(partway[0].text, 'newest');
  const skew = [{ ...wake }];
  showReplies(skew, [{ id: 'a', text: 'just after', at: T + 1000 }], memo());
  assert.equal(skew[0].text, 'just after');
});

test('a native pane: a typed line is a plain user line, a mid-turn typed line comes from its queued_command attachment, a relayed one is a reply', () => {
  const jsonl = [
    { type: 'user', timestamp: '2026-11-07T01:51:43.378Z', turnOrigin: 'human', message: { role: 'user', content: 'pear' } },
    { type: 'queue-operation', operation: 'enqueue', content: 'Second message typed mid-turn.' },
    { type: 'attachment', timestamp: '2026-11-07T01:48:01.108Z', attachment: { type: 'queued_command', prompt: 'Second message typed mid-turn.', humanTurn: true } },
    { type: 'attachment', attachment: { type: 'hook_success', content: 'ignored' } },
    { type: 'user', isMeta: true, turnOrigin: 'peer', message: { content: '<cross-session-message from-name="jarvis-brain-relay">\ngreen\n</cross-session-message>' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'DONE: wrote pear' }] } },
  ].map(e => JSON.stringify(e)).join('\n') + '\n';
  assert.deepEqual(chatLines(jsonl, 0).map(l => [l.role, l.text, l.kind]), [
    ['user', 'pear', undefined], ['user', 'Second message typed mid-turn.', undefined], ['user', 'green', 'reply'], ['agent', 'DONE: wrote pear', undefined],
  ]);
});

test('withEvents appends jarvisd events once, as gap lines, and carries their position in the cursor', () => {
  const events = [{ id: 7, body: 'Worker x was resumed in a new terminal (its terminal died)', created_at: '2026-11-07 01:28:49' }, { id: 9, body: 'again', created_at: '2026-11-07T01:30:00.000Z' }];
  const first = withEvents({ lines: [{ id: 'f:0', role: 'agent', text: 'hi' }], cursor: 'f:120' }, events);
  assert.deepEqual(first.lines.map(l => [l.id, l.kind, l.text, l.at]), [
    ['f:0', undefined, 'hi', undefined],
    ['ev:7', 'event', 'Worker x was resumed in a new terminal (its terminal died)', Date.parse('2026-11-07T01:28:49Z')],
    ['ev:9', 'event', 'again', Date.parse('2026-11-07T01:30:00.000Z')],
  ]);
  assert.equal(first.cursor, 'f:120|e:9');
  assert.equal(fileCursor(first.cursor), 'f:120');
  assert.equal(fileCursor(undefined), undefined);
  // The next read with that cursor: nothing new, the cursor keeps the mark.
  const second = withEvents({ lines: [], cursor: 'f:120' }, events, first.cursor);
  assert.deepEqual(second.lines, []);
  assert.equal(second.cursor, 'f:120|e:9');
  // A newer event comes through alone.
  const third = withEvents({ lines: [], cursor: 'f:200' }, [...events, { id: 12, body: 'later', created_at: '2026-11-07 02:00:00' }], second.cursor);
  assert.deepEqual(third.lines.map(l => l.id), ['ev:12']);
  assert.equal(third.cursor, 'f:200|e:12');
  // No events and no file cursor: nothing is added.
  assert.deepEqual(withEvents({ lines: [] }, []), { lines: [] });
});
