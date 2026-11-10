import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chatLines, readChatFile, withEvents, fileCursor, CLIP } from './transcript.ts';

test('long text is clipped and marked, and a tool call is one short line', () => {
  const jsonl = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'x'.repeat(CLIP + 10) }, { type: 'tool_use', name: 'Bash', input: { command: 'npm\n test' } }] } }) + '\n';
  assert.deepEqual(chatLines(jsonl, 0).map(l => [l.role, l.text.length > 50 ? l.text.length : l.text, !!l.clipped]), [
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
