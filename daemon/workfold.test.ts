import test from 'node:test';
import assert from 'node:assert/strict';
import { addSteps, finishSteps, type Step } from './worksteps.ts';
import { formatDuration, formatStamp, summarize, groupSteps, callLine, stepsHtml, foldHtml, eventMessages, eventSubject, messageFoldHtml, answerFoldHtml, fewWords, messageFootHtml, toolRunSummary, toolRunHtml, paneTag } from '../web/workfold.js';

const tool = (name: string, input = '{}'): Step => ({ kind: 'tool', name, input });
const note = (text: string): Step => ({ kind: 'note', text });
const thought = (text: string): Step => ({ kind: 'thought', text });
const update = (text: string): Step => ({ kind: 'update', text });

test('the duration reads as seconds, minutes and seconds, or hours and minutes', () => {
  assert.equal(formatDuration(488_000), '8m 8s');
  assert.equal(formatDuration(8_000), '8s');
  assert.equal(formatDuration(60_000), '1m 0s');
  assert.equal(formatDuration(59_600), '1m 0s', 'rounding up crosses the minute');
  assert.equal(formatDuration(3_725_000), '1h 2m');
  assert.equal(formatDuration(120), '1s', 'never 0s');
  assert.equal(formatDuration(undefined), '1s');
});

test('the stamp is month-day and a 12-hour time in Eastern, whatever the machine; a bad date shows nothing', () => {
  assert.equal(formatStamp('2026-09-25T12:58:00Z'), '09-25 8:58 a.m.', 'summer: UTC minus 4');
  assert.equal(formatStamp('2026-11-02T05:05:00Z'), '11-02 12:05 a.m.', 'winter: UTC minus 5, and midnight is 12');
  assert.equal(formatStamp('2026-11-02T20:18:00Z'), '11-02 3:18 p.m.');
  assert.equal(formatStamp('2026-11-02T17:00:00Z'), '11-02 12:00 p.m.', 'noon is p.m.');
  assert.equal(formatStamp('2026-11-02T02:30:00Z'), '11-01 9:30 p.m.', 'the date is the Eastern date too');
  assert.equal(formatStamp('nonsense'), '');
  assert.equal(formatStamp(undefined), '');
});

test('a group summary counts each kind in the order it first happened, and leaves thoughts out', () => {
  assert.equal(summarize([tool('WebFetch'), tool('WebFetch'), tool('WebSearch'), thought('hm'), tool('Bash'), tool('Read')]), 'Used 3 tools, searched the web 1 time, and ran 1 command');
  assert.equal(summarize([tool('Bash'), tool('Bash'), update('tests passed')]), 'Ran 2 commands and received 1 update');
  assert.equal(summarize([update('a'), tool('Bash')]), 'Received 1 update and ran 1 command');
  assert.equal(summarize([update('a'), update('b'), tool('Bash'), tool('Bash'), tool('Bash')]), 'Received 2 updates and ran 3 commands');
  assert.equal(summarize([tool('Bash')]), 'Ran 1 command');
  assert.equal(summarize([thought('hm')]), 'Thought');
});

test('notes split the steps into groups, in order, and each group gets the icon of what it holds', () => {
  const groups = groupSteps([thought('plan'), note('First'), tool('Read'), tool('Bash'), note('Second'), note('Third'), tool('Bash'), update('u'), tool('WebSearch')]);
  assert.deepEqual(groups.map(g => g.type === 'note' ? g.text : [g.summary, g.icon, g.steps.length]), [
    ['Thought', 'brain', 1],
    'First',
    ['Used 1 tool and ran 1 command', 'wrench', 2],
    'Second',
    'Third',
    ['Ran 1 command, received 1 update, and searched the web 1 time', 'terminal', 3],
  ]);
  assert.deepEqual(groupSteps([]), []);
});

test('a call line is one line: a command as typed, any other tool with its name', () => {
  assert.equal(callLine({ kind: 'tool', name: 'Bash', input: 'npm\n  test' }), 'npm test');
  assert.equal(callLine(tool('Read', '{"file_path":"/a.ts"}')), 'Read: {"file_path":"/a.ts"}');
  assert.equal(callLine({ kind: 'tool', name: 'Skill', input: '' }), 'Skill');
  assert.equal(callLine(thought('a\nb')), 'a b');
  assert.equal(callLine(tool('Read', 'x'.repeat(5000))).length, 300);
});

test('the fold escapes what tools and thoughts wrote, and only the note goes through markdown', () => {
  const html = stepsHtml([note('**hi**'), { kind: 'tool', name: 'Bash', input: '<img src=x>', output: '<script>', failed: true }, thought('<b>')], t => `MD(${t})`);
  assert.ok(html.includes('MD(**hi**)'));
  assert.ok(!html.includes('<img') && !html.includes('<script>') && !html.includes('<b>'));
  assert.ok(html.includes('&lt;script&gt;') && html.includes('fold-label failed'), 'a failed call labels its output Error');
  const none = stepsHtml([{ kind: 'tool', name: 'Bash', input: 'ls' }], t => t);
  assert.ok(none.includes('No output recorded'), 'a call cut off by a restart says so');
  const row = foldHtml({ id: 12, ms: 488_000, at: '2026-09-25T12:58:00Z' });
  assert.ok(row.includes('Worked for 8m 8s') && row.includes('09-25 8:58 a.m.') && row.includes('data-fold="12"'));
});

test('an event turn splits into one message per item, and other lines stay with the one above', () => {
  assert.deepEqual(eventMessages('- [worker_done] a\n- [email] b'), ['- [worker_done] a', '- [email] b']);
  assert.deepEqual(eventMessages('[check] Found by the check.\n- one\n- two'), ['[check] Found by the check.\n- one\n- two']);
  assert.deepEqual(eventMessages('[work list] the owner sent a message.'), ['[work list] the owner sent a message.']);
});

test('the subject comes from the subject field only, escapes included', () => {
  assert.equal(eventSubject('- [worker_done] message_id=m dispatch=d subject="Dealer B \\"done\\"" body="x"'), 'Dealer B "done"');
  assert.equal(eventSubject('- [email] item=g from="Sam" subject="Bonjour" summary="s" draft="d"'), 'Bonjour');
  assert.equal(eventSubject('- [escalation] message_id=m subject="" body="text"'), '');
  assert.equal(eventSubject('- [worker_done] body="not_a subject=here"'), '');
  assert.equal(eventSubject('[gmail event] New email'), '');
  assert.equal(eventSubject('- [worker_done] subject="broken'), '');
});

test('a received message folds to one row, opens to its full text, and escapes the subject', () => {
  const text = '- [worker_done] message_id=m subject="<b>Done</b>" body="full body"';
  const html = messageFoldHtml({ text, at: '2026-11-02T20:18:00Z' }, t => `R(${t})`);
  const title = messageFoldHtml({ text, at: '2026-11-02T20:18:00Z' }, () => '');
  assert.ok(title.includes('Message received: &lt;b&gt;Done&lt;/b&gt;') && !title.includes('<b>Done'));
  assert.ok(html.includes('class="fold-toggle fold-head"') && html.includes('11-02 3:18 p.m.'));
  assert.ok(html.includes('<div class="fold-body" hidden>') && html.includes(`R(${text})`), 'the full text starts closed');
  assert.ok(!html.includes('data-fold'), 'the text is on the page, so opening it fetches nothing');
  const bare = messageFoldHtml({ text: '[check] Found something', at: '2026-11-02T20:18:00Z' }, t => t);
  assert.ok(bare.includes('>Message received<'), 'no subject, no colon');
});

test('the row under a message with no turn id has the Eastern time and a copy button, and nothing else', () => {
  const html = messageFootHtml('2026-11-02T20:18:00Z');
  assert.ok(html.includes('11-02 3:18 p.m.') && html.includes('class="msg-copy"'));
  assert.equal(html.match(/<button/g)?.length, 1, 'no reply button without a turn to quote');
});

test('only a message with words to read gets a speaker, to the right of copy', () => {
  const html = messageFootHtml('2026-11-02T20:18:00Z', { id: 41, clips: 3 });
  assert.ok(html.indexOf('msg-copy') < html.indexOf('msg-speak'));
  assert.ok(html.includes('data-turn="41"') && html.includes('data-clips="3"'));
  assert.ok(!messageFootHtml('2026-11-02T20:18:00Z', null).includes('msg-speak'));
});

test('stream events become steps: output joins its call, empty thinking and subagent events are skipped', () => {
  const steps: Step[] = [];
  for (const e of [
    { type: 'system', subtype: 'init', session_id: 's' },
    { type: 'assistant', message: { content: [{ type: 'thinking', thinking: '', signature: 'x' }, { type: 'thinking', thinking: ' Check the log. ' }, { type: 'text', text: 'Looking.' }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls -la', description: 'list' } }, { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: '/a' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: [{ type: 'text', text: 'body' }, { type: 'image' }] }, { type: 'tool_result', tool_use_id: 't1', content: 'boom', is_error: true }] } },
    { type: 'assistant', parent_tool_use_id: 't9', message: { content: [{ type: 'text', text: 'from a subagent' }] } },
    { type: 'user', message: { content: 'A background task finished.' } },
    { type: 'system', subtype: 'task_notification', summary: 'Sleep finished' },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Done.' }] } },
  ]) addSteps(steps, e);
  assert.deepEqual(finishSteps(steps, 'Done.'), [
    { kind: 'thought', text: 'Check the log.' },
    { kind: 'note', text: 'Looking.' },
    { kind: 'tool', name: 'Bash', input: 'ls -la', output: 'boom', failed: true },
    { kind: 'tool', name: 'Read', input: '{"file_path":"/a"}', output: 'body\n[image]' },
    { kind: 'update', text: 'A background task finished.' },
    { kind: 'update', text: 'Sleep finished' },
  ]);
});

test('the final reply stays out of the fold, SILENT included, and an earlier note with other words stays in', () => {
  assert.deepEqual(finishSteps([note('Working on it'), tool('Bash', 'ls'), note('SILENT')], 'SILENT').map(s => s.kind), ['note', 'tool']);
  assert.deepEqual(finishSteps([note('Same'), tool('Bash', 'ls'), note('Same')], 'Same').map(s => s.kind), ['note', 'tool']);
  assert.deepEqual(finishSteps([note('Before the crash')], ''), [{ kind: 'note', text: 'Before the crash' }], 'no reply: every note stays');
});

test('long input, output and text are shortened and marked', () => {
  const [call, text] = finishSteps([{ kind: 'tool', id: 'x', name: 'Bash', input: 'a'.repeat(9000), output: 'b'.repeat(20000) }, thought('c'.repeat(20000))], '') as any[];
  assert.deepEqual([call.input.length, call.output.length, call.clipped, call.id], [8000, 16000, true, undefined]);
  assert.deepEqual([text.text.length, text.clipped], [16000, true]);
});

test('an answer folds to one row with a few words, and the full text waits under it', () => {
  const answer = 'Show them as Not set up and keep the row in the list for now';
  const html = answerFoldHtml({ tag: 'Story 4612', answer, at: '2026-11-02T20:18:00Z' }, (t: string) => `<R>${t}</R>`);
  assert.match(html, /<span class="fold-title">You answered, Story 4612: Show them as Not set up…<\/span>/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /<div class="fold-body" hidden><div class="msg event"><R>Show them as Not set up and keep the row in the list for now<\/R><\/div>/);
  assert.match(html, /11-02 3:18 p\.m\./);
  assert.doesNotMatch(html, /data-fold/, 'the text is already on the page, so opening it reads nothing');
});

test('the brain steering on its own is labelled Jarvis steered, folded the same way', () => {
  const html = answerFoldHtml({ tag: 'Story 164', answer: 'Keep going', by: 'jarvis' }, (t: string) => t);
  assert.match(html, />Jarvis steered, Story 164: Keep going</);
  assert.doesNotMatch(html, /You answered/);
  assert.match(html, /fold-body" hidden/);
});

test('a failed outcome stays marked while folded, and the row never becomes markup', () => {
  assert.match(answerFoldHtml({ tag: 'S', answer: 'Approved, then failed: no slot', failed: true }, (t: string) => t), /class="fold fold-answer failed"/);
  assert.doesNotMatch(answerFoldHtml({ tag: 'S', answer: 'Approved' }, (t: string) => t), /failed/);
  const html = answerFoldHtml({ tag: '<i>S</i>', answer: '<b>x</b>' }, (t: string) => t.replace(/</g, '&lt;'));
  assert.doesNotMatch(html, /<i>|<b>/);
});

test('a few words: short text is whole, long text is cut with a mark, and line breaks flatten', () => {
  assert.equal(fewWords('Two'), 'Two');
  assert.equal(fewWords('one two\n\nthree  four five six'), 'one two three four five six');
  assert.equal(fewWords('one two three four five six seven'), 'one two three four five six…');
});

test('a run of tool rows folds to one line that counts Claude and Codex commands alike', () => {
  assert.equal(toolRunSummary(['Bash: npm test', 'shell: ls', 'exec_command: pwd', 'Read: /a.ts', 'WebSearch: x']), 'Ran 3 commands, used 1 tool, and searched the web 1 time');
  assert.equal(toolRunSummary(['Bash: a: b']), 'Ran 1 command');
  assert.match(toolRunHtml(), /aria-expanded="false".*class="fold-calls" hidden/);
});

test('messages taken out of tool calls say what they are', () => {
  assert.deepEqual([{ kind: 'reply' }, { kind: 'reply', by: 'jarvis' }, {}].map(paneTag), ['You answered', 'Jarvis answered', '']);
});
