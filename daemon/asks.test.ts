import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { openStore, type Item } from './store.ts';
import { askCard, answerAsk, auditEntries, closeSteeredAsks, fields, markedList } from './asks.ts';
import { sentences } from './voice.ts';

const item = (extra: Partial<Item>): Item => ({
  id: 1, source: 'orca', external_id: 'msg_1', kind: 'question', dispatch_id: 'd_1', subject: '', body: '', options: null,
  status: 'spoken', answer: null, created_at: '', pushes: 0, pushed_at: null, meta: null, ...extra,
});

const SHAPED = `STORY: 4412, onboarding wizard
WHERE: Adding the Muse step, step 3 of 5
QUESTION: Should the step be skipped when the dealer has **no Muse key**?
CONTEXT: The extension flow skips it.
OPTIONS: 1) skip it because matches the extension flow 2) show it disabled because clearer 3) block the wizard because safest`;

test('an ask in the jarvis-ask shape becomes a card: story as title, where and question as the body, options in order', () => {
  const c = askCard(item({ body: SHAPED, options: JSON.stringify(['skip it', 'show it disabled', 'block the wizard']) }))!;
  assert.equal(c.title, '4412, onboarding wizard');
  assert.equal(c.body, 'Adding the Muse step, step 3 of 5\n\nShould the step be skipped when the dealer has **no Muse key**?\n\nThe extension flow skips it.');
  assert.deepEqual(c.options, [
    { value: 'skip it', label: 'skip it', detail: 'matches the extension flow' },
    { value: 'show it disabled', label: 'show it disabled', detail: 'clearer' },
    { value: 'block the wizard', label: 'block the wizard', detail: 'safest' },
  ]);
  assert.equal(c.status, 'open');
  // Without --options, the OPTIONS field alone gives the buttons.
  assert.deepEqual(askCard(item({ body: SHAPED }))!.options.map(o => o.value), ['skip it', 'show it disabled', 'block the wizard']);
});

test('a free-form ask: short --options are matched to the (a) (b) wording, and the options leave the body', () => {
  const body = "#4531-engine, holding the drive slot. Doctor fails on 1000001 (provider 15). Options: (a) the owner removes these three too, then I drive; (b) I drive with doctor red (only creates 3 VERIFY accounts, e.g. a stub); (c) I release the slot and wait. Reply GO plus a/b/c.";
  const c = askCard(item({ subject: 'Question', body, options: JSON.stringify(['GO a', 'GO b', 'wait']) }), 'pick-and-ship #4531')!;
  assert.equal(c.title, 'pick-and-ship #4531', 'a bare "Question" subject falls back to the work-list title');
  assert.deepEqual(c.options, [
    { value: 'GO a', label: 'GO a', detail: 'the owner removes these three too, then I drive' },
    { value: 'GO b', label: 'GO b', detail: 'I drive with doctor red (only creates 3 VERIFY accounts, e.g. a stub)' },
    { value: 'wait', label: 'wait' },
  ]);
  assert.equal(c.body, '#4531-engine, holding the drive slot. Doctor fails on 1000001 (provider 15).\n\nReply GO plus a/b/c.');
});

test('a repeated --options flag loses choices in Orca, so the card builds its buttons from the OPTIONS field', () => {
  // msg_81728794bdde: --options "Merged" --options "Not yet" reached Jarvis as ["Not yet"].
  const body = `STORY: 4828 bilingual migration needs merging
WHERE: ready to prove the onboarding on staging data
QUESTION: Can you merge migration PR #4858 into staging?
OPTIONS: Merged because CI then applies it to staging; Not yet because you want to read it first`;
  const c = askCard(item({ subject: 'Question', body, options: JSON.stringify(['Not yet']) }))!;
  assert.deepEqual(c.options, [
    { value: 'Merged', label: 'Merged', detail: 'CI then applies it to staging' },
    { value: 'Not yet', label: 'Not yet', detail: 'you want to read it first' },
  ]);
  // A free-form list loses its wording from the body, so it must not lose its buttons either.
  const free = askCard(item({ body: 'Which one? Options: (a) left; (b) right', options: JSON.stringify(['GO b']) }))!;
  assert.deepEqual(free.options.map(o => o.value), ['a) left', 'b) right']);
  // msg_8715a014dd3a: an intact payload still gives the buttons.
  const intact = askCard(item({ body, options: JSON.stringify(['Merge it', 'Wait']) }))!;
  assert.deepEqual(intact.options.map(o => o.value), ['Merge it', 'Wait']);
});

test('a semicolon inside a reason does not become a button', () => {
  // msg_98354c96ed00: two intact options, the first reason holding a semicolon.
  const lines = askCard(item({
    body: "QUESTION: Close it?\nOPTIONS:\nClose as already fixed because no code remains to change; a person replies and updates the seller's widget\nKeep open until seller confirms because nobody has seen the fix live on Facebook",
    options: JSON.stringify(['Close as already fixed', 'Keep open until seller confirms']),
  }))!;
  assert.deepEqual(lines.options, [
    { value: 'Close as already fixed', label: 'Close as already fixed', detail: "no code remains to change; a person replies and updates the seller's widget" },
    { value: 'Keep open until seller confirms', label: 'Keep open until seller confirms', detail: 'nobody has seen the fix live on Facebook' },
  ]);
  // msg_7990f8b3ca5d: pipes between the choices, semicolons inside the reasons, and a payload that lost choices.
  const pipes = askCard(item({
    body: 'QUESTION: Which?\nOPTIONS: Only open a report because it claims nothing false; a refused car returns sooner | Two buttons because refusals keep the wait; undoes the single button | Change nothing because only 4 clicks; wrong tickets continue',
    options: JSON.stringify(['Change nothing']),
  }))!;
  assert.deepEqual(pipes.options.map(o => [o.value, o.detail]), [
    ['Only open a report', 'it claims nothing false; a refused car returns sooner'],
    ['Two buttons', 'refusals keep the wait; undoes the single button'],
    ['Change nothing', 'only 4 clicks; wrong tickets continue'],
  ]);
  // Semicolons with no reasons at all still separate choices.
  assert.deepEqual(askCard(item({ body: 'QUESTION: Which?\nOPTIONS: left; right' }))!.options.map(o => o.value), ['left', 'right']);
});

test('a blocked escalation has a plain headline, with no Failed line unless the worker wrote FAILED', () => {
  const c = askCard(item({
    kind: 'escalation', subject: 'Blocked: cannot delete import 1000006 (permission denied)',
    body: 'The classifier denied my delete. Options: (1) the owner deletes it himself, then tells me; (2) the owner adds a permission rule. Meanwhile I push.',
  }), 'pick-and-ship #4531')!;
  assert.equal(c.kind, 'escalation');
  assert.equal(c.title, 'pick-and-ship #4531');
  assert.equal(c.question, 'Cannot delete import 1000006 (permission denied)');
  assert.equal(c.failed, undefined);
  assert.equal(c.proposes, undefined, 'the recommended button already says this');
  assert.deepEqual(c.options.map(o => o.value), ['1) the owner deletes it himself, then tells me', '2) the owner adds a permission rule']);
  assert.equal(c.body, 'Cannot delete import 1000006 (permission denied)\n\nThe classifier denied my delete.\n\nMeanwhile I push.');
  const labeled = askCard(item({ kind: 'escalation', subject: 'Blocked', body: 'STORY: 4460 drive\nFAILED: tests red on CI\nPROPOSES: skip the flaky one\nQUESTION: OK?' }))!;
  assert.deepEqual([labeled.title, labeled.failed, labeled.proposes, labeled.body], ['4460 drive', 'tests red on CI', 'skip the flaky one', 'OK?']);
  assert.deepEqual(labeled.options.map(o => o.label), ['Retry', 'Stop', 'Tell it what to do']);
  const named = askCard(item({ kind: 'escalation', subject: 'Blocked: CI is down', body: 'QUESTION: Wait for it?' }))!;
  assert.deepEqual([named.title, named.question], ['CI is down', 'Wait for it?'], 'the subject still shows when the worker wrote its own question');
});

const WALL = "The owner approved read-only access, but Claude Code's auto-mode check still denies it because chat approval does not reach that check. The owner needs to add this one line to permissions.allow in ~/.claude/settings.json by hand: Bash(node .claude/skills/prove-it/bin/db-read.mjs:*). That rule allows this script's GET and HEAD reads on staging and production in any session; I will not edit permissions or reach production another way. Meanwhile I am opening the draft PR and working on the part that needs no production data. Tell me when the rule is added, or if I should ship without the proof.";

test('an escalation that is a wall of text renders like an ask: headline, short parts, default buttons, no Failed', () => {
  const c = askCard(item({ kind: 'escalation', subject: 'Blocked: permission check still denies production reads', body: WALL }), 'Worker title')!;
  assert.equal(c.title, 'Worker title');
  assert.equal(c.question, 'Permission check still denies production reads');
  const [head, ...parts] = c.body.split('\n\n');
  assert.equal(head, c.question);
  assert.ok(parts.length >= 3, c.body);
  for (const p of parts) assert.ok(p.length <= 260, p);
  assert.equal(parts.join(' '), WALL, 'splitting drops no words');
  assert.match(c.body, /Bash\(node \.claude\/skills\/prove-it\/bin\/db-read\.mjs:\*\)\./, 'a path with dots stays in one piece');

  assert.deepEqual(c.options.map(o => o.label), ['Stop', 'Tell it what to do'], 'the auto-mode check refused it, so a retry cannot work');
  assert.equal(c.suggested, true);
  const [stop, tell] = c.options;
  assert.match(stop.value, /stop/i);
  assert.deepEqual([tell.value, tell.compose], ['', true], 'this button opens the box and sends nothing');

  const out = html(c);
  assert.doesNotMatch(out, /Failed|Recommended|Retry</, 'nobody recommended anything and nothing failed');
  assert.match(out, /<div class="ask-line"><span>Refused<\/span>A retry cannot clear this/);
  assert.match(out, /<p class="ask-q" role="heading" aria-level="2">Permission check still denies production reads<\/p>/);
  assert.match(out, /data-i="1"><span class="n">2<\/span><span class="l">Tell it what to do/);
});

test('short parts leave markdown blocks and abbreviations alone', () => {
  const list = '- one item that is long enough to matter here. And it goes on. '.repeat(6).trim();
  const fence = '```\n' + 'code. Next line. '.repeat(30).trim() + '\n\nStill code. Yes.\n```';
  const c = askCard(item({ kind: 'escalation', subject: 'Blocked: x', body: `${list}\n\n${fence}` }))!;
  assert.equal(c.body, `X\n\n${list}\n\n${fence}`);
  const prose = askCard(item({ kind: 'escalation', subject: 'Blocked: x', body: `${'Word '.repeat(40)}, e.g. Foo stays with it. ${'More '.repeat(40)}.` }))!;
  assert.match(prose.body, /e\.g\. Foo stays/);
});

test('a real failure still says Failed, and the Failed line lays out as label and text', () => {
  const c = askCard(item({ kind: 'escalation', subject: 'Blocked: CI', body: 'FAILED: tests red on CI\nCONTEXT: Three in a row.' }))!;
  assert.match(html(c), /<div class="ask-line"><span>Failed<\/span>tests red on CI<\/div>/);
  assert.match(readFileSync(new URL('../web/app.css', import.meta.url), 'utf8'), /\.ask-line \{ display: grid;/);
});

test('a worker with its own options gets those, recommended first, and no default buttons', () => {
  const c = askCard(item({ kind: 'escalation', subject: 'Blocked: x', body: 'OPTIONS:\n- wait because CI is down\n- skip because flaky' }))!;
  assert.deepEqual(c.options.map(o => o.label), ['wait', 'skip']);
  assert.equal(c.suggested, undefined);
  assert.match(html(c), /Recommended/);
});

test('a default button sends its words to the worker as a message', async () => {
  const t = setup(() => ({ ok: true }));
  t.store.insertItem({ source: 'orca', external_id: 'msg_w', kind: 'escalation', dispatch_id: 'd_w', subject: 'Blocked: x', body: 'y', status: 'spoken' });
  const [retry] = askCard(t.store.item('msg_w')!)!.options;
  assert.deepEqual(await t.go('msg_w', retry.value), { status: 200 });
  assert.deepEqual(t.calls[0].slice(0, 2), ['orchestration', 'send']);
  assert.equal(t.calls[0][t.calls[0].indexOf('--body') + 1], retry.value);
  assert.equal(t.store.item('msg_w')!.answer, retry.value);
  const after = askCard(t.store.item('msg_w')!)!;
  assert.match(html(after), /class="ask-opt chosen"[^>]*disabled/);
});

test('field and list parsing', () => {
  assert.deepEqual(fields('STORY: a\nQUESTION: one\ntwo'), { STORY: 'a', QUESTION: 'one\ntwo' });
  assert.deepEqual(markedList('just text (a) only one').items, []);
  assert.equal(askCard(item({ kind: 'worker_done' })), undefined);
  assert.equal(askCard(item({ status: 'answered', answer: 'two' }))!.status, 'answered');
  assert.equal(askCard(item({ status: 'replying' }))!.status, 'sending');
});

function setup(answer: (args: string[]) => any) {
  const store = openStore(':memory:');
  const calls: string[][] = [], notes: string[] = [];
  const orca = async (args: string[]) => { calls.push(args); return answer(args); };
  const go = (id: string, value: string) => answerAsk({ id, value, run: 'run_j', handle: 'term_j', store, orca, log: () => {}, note: n => notes.push(n) });
  return { store, calls, notes, go };
}

test('a tapped option is the same reply as jarvis-orca reply, sent once, and marks the ask answered', async () => {
  const t = setup(() => ({ ok: true, result: {} }));
  t.store.insertItem({ source: 'orca', external_id: 'msg_q', kind: 'question', dispatch_id: 'd_1', status: 'spoken' });
  assert.equal((await t.go('msg_q', 'skip it')).status, 200);
  assert.deepEqual(t.calls[0], ['orchestration', 'reply', '--run', 'run_j', '--from', 'term_j', '--id', 'msg_q', '--body', 'skip it']);
  assert.equal(askCard(t.store.item('msg_q')!)!.status, 'answered');
  assert.equal(t.store.item('msg_q')!.answer, 'skip it');
  assert.match(t.notes[0], /msg_q.*Reply SILENT/);
  // A second tap (another page, or after a spoken answer) never reaches Orca.
  const again = await t.go('msg_q', 'block the wizard');
  assert.equal(again.status, 409);
  assert.equal(t.calls.length, 1);
});

test('Orca refusing a tapped answer reopens the ask; an escalation tap goes to the worker as a message', async () => {
  const t = setup(args => args[1] === 'reply' ? { ok: false, error: { code: 'busy', message: 'busy' } } : { ok: true, result: {} });
  t.store.insertItem({ source: 'orca', external_id: 'msg_q', kind: 'question', dispatch_id: 'd_1', status: 'spoken' });
  const r = await t.go('msg_q', 'skip it');
  assert.equal(r.status, 502);
  assert.equal(t.store.item('msg_q')!.status, 'spoken');
  t.store.insertItem({ source: 'orca', external_id: 'msg_e', kind: 'escalation', dispatch_id: 'd_2', status: 'spoken' });
  assert.equal((await t.go('msg_e', '1) delete it')).status, 200);
  assert.deepEqual(t.calls.at(-1), ['orchestration', 'send', '--run', 'run_j', '--from', 'term_j', '--to', 'dispatch:d_2', '--subject', 'From the owner', '--body', '1) delete it']);
  assert.equal(t.store.item('msg_e')!.status, 'answered');
  assert.equal((await t.go('nope', 'x')).status, 404);
});

// web/askcard.js is a browser script; run it in a vm with markdown.js, as the page does.
const ctx: { markdown?: (t: string, shot: (p: string) => string) => string; askCardHtml?: (c: any, md: (t: string) => string, err?: string) => string } = {};
runInNewContext(readFileSync(new URL('../web/markdown.js', import.meta.url), 'utf8'), ctx);
runInNewContext(readFileSync(new URL('../web/askcard.js', import.meta.url), 'utf8'), ctx);
const html = (c: any, err?: string) => ctx.askCardHtml!(c, t => ctx.markdown!(t, p => `<SHOT ${p}>`), err);

test('the card renders markdown, marks the recommended option, and shows the chosen one after an answer', () => {
  const c = askCard(item({ body: SHAPED, options: JSON.stringify(['skip it', 'show it disabled', 'block the wizard']) }))!;
  const open = html(c);
  assert.match(open, /<div class="ask-title">4412, onboarding wizard<\/div>/);
  assert.match(open, /<strong>no Muse key<\/strong>/);
  assert.match(open, /class="ask-opt rec" data-i="0">.*skip it.*Recommended/);
  assert.doesNotMatch(open, / disabled>/);
  const done = html({ ...c, status: 'answered', answer: 'show it disabled' });
  assert.match(done, /class="ask-opt chosen" data-i="1" disabled>.*Chosen/);
  assert.equal(done.match(/ disabled>/g)!.length, 3, 'every button is disabled once answered');
  // An answer in the owner's own words marks the card answered and shows the words.
  assert.match(html({ ...c, status: 'answered', answer: 'go with skipping but log it' }), /answered<\/span>go with skipping but log it/);
});

test('a whole ask in markdown stays one card: paragraphs, headings, bullets, bold and links all render, the long part behind More', () => {
  const body = `[image: /tmp/two-layouts.png]
## Background
The wizard has five steps.

STORY: 4412, onboarding wizard
WHERE: Adding the Muse step
QUESTION: Which layout for **step 3**?
CONTEXT: Two options were mocked.

- Left: a list
- Right: [the mock](https://example.com/mock)

### Notes
Both pass review.
OPTIONS: 1) left because matches step 2 2) right because roomier

See the PR for the full diff.`;
  const c = askCard(item({ body, options: JSON.stringify(['left', 'right']) }))!;
  assert.deepEqual(c.options.map(o => [o.value, o.detail]), [['left', 'matches step 2'], ['right', 'roomier']]);
  assert.match(c.body, /^\[image: \/tmp\/two-layouts.png\]\n\n## Background\nThe wizard has five steps\.\n\nAdding the Muse step/);
  assert.match(c.body, /Two options were mocked\.\n\n- Left: a list\n- Right/);
  assert.match(c.body, /See the PR for the full diff\.$/, 'prose after the options, past a blank line, stays in the body');
  const out = html(c);
  assert.match(out, /<div class="ask-body md"><p><SHOT \/tmp\/two-layouts.png><\/p><\/div>/);
  assert.match(out, /<strong>step 3<\/strong>/);
  assert.match(out, /<details class="card-more"><summary>More<\/summary><div class="ask-body md"><h3>Background<\/h3>/);
  assert.match(out, /<p>Two options were mocked\.<\/p><ul><li>Left: a list<\/li><li>Right: <a href="https:\/\/example.com\/mock"[^>]*>the mock<\/a><\/li><\/ul><h4>Notes<\/h4>/);
  assert.equal(out.indexOf('<SHOT'), out.indexOf('ask-body md') + 'ask-body md"><p>'.length, 'the image is the first thing in the card body');
  assert.ok(out.indexOf('ask-options') < out.indexOf('card-more'), 'the options come above the long part');
});

test('ask text never becomes markup on the card', () => {
  const c = askCard(item({
    subject: '<img src=x onerror=alert(1)>', kind: 'escalation',
    body: 'QUESTION: <script>x</script> [a](javascript:alert(1))\nOPTIONS: <b>bold</b> because "<i>"',
  }))!;
  const out = html(c, '<u>err</u>');
  assert.doesNotMatch(out, /<(img|script|b|i|u)[\s>]/);
  assert.doesNotMatch(out, /href="javascript/);
  assert.match(out, /&lt;b&gt;bold&lt;\/b&gt;/);
});

test('speech is unchanged: Jarvis still reads the options; the card adds nothing spoken', () => {
  assert.deepEqual(sentences('Story 4412, onboarding wizard. Should the step be skipped? One: skip it. Two: show it disabled.'),
    ['Story 4412, onboarding wizard.', 'Should the step be skipped?', 'One: skip it.', 'Two: show it disabled.']);
});

test('an ask with a picture shows it first in the card body, as the usual image marker', () => {
  const c = askCard(item({ body: `${SHAPED.replace('CONTEXT: The extension flow skips it.', 'CONTEXT: Two layouts.\n[image: /Users/owner/orca/workspaces/x/docs/screens/muse.png]')}` }))!;
  assert.equal(c.body, '[image: /Users/owner/orca/workspaces/x/docs/screens/muse.png]\n\nAdding the Muse step, step 3 of 5\n\nShould the step be skipped when the dealer has **no Muse key**?\n\nTwo layouts.');
  assert.match(html(c), /^<div class="ask-tag">.*?<\/div><div class="ask-body md"><p><SHOT \/Users\/owner\/orca\/workspaces\/x\/docs\/screens\/muse.png><\/p><\/div><h3 class="card-h">What the worker is doing<\/h3><div class="ask-body md"><p>Adding/);
  const free = askCard(item({ body: 'Which layout? [image: /tmp/a.png] Options: (a) left; (b) right' }))!;
  assert.equal(free.body, '[image: /tmp/a.png]\n\nWhich layout?');
  assert.equal(askCard(item({ body: 'No picture here.' }))!.body, 'No picture here.');
});

test('an IMAGE field attaches a picture: a thumbnail at the top, the path gone from the text, buttons and markdown intact', () => {
  const body = SHAPED.replace('CONTEXT: The extension flow skips it.', 'CONTEXT: The extension flow skips it.\nIMAGE: /Users/owner/Desktop/muse step.png');
  const c = askCard(item({ body, options: JSON.stringify(['skip it', 'show it disabled', 'block the wizard']) }))!;
  assert.equal(c.body, '[image: /Users/owner/Desktop/muse step.png]\n\nAdding the Muse step, step 3 of 5\n\nShould the step be skipped when the dealer has **no Muse key**?\n\nThe extension flow skips it.');
  assert.deepEqual(c.options.map(o => o.value), ['skip it', 'show it disabled', 'block the wizard']);
  const out = html(c);
  assert.match(out, /<div class="ask-body md"><p><SHOT \/Users\/owner\/Desktop\/muse step.png><\/p>/);
  assert.match(out, /<strong>no Muse key<\/strong>/);
  assert.match(out, /class="ask-opt rec" data-i="0">/);
  // The field may also hold a marker or a path in backticks; an escalation and a free-form ask take it too.
  assert.match(askCard(item({ body: SHAPED + '\nIMAGE: [image: /tmp/a.webp]' }))!.body, /^\[image: \/tmp\/a.webp\]\n\n/);
  assert.match(askCard(item({ kind: 'escalation', body: 'FAILED: CI red\nIMAGE: `/tmp/ci.jpg`\nQUESTION: Rerun?' }))!.body, /^\[image: \/tmp\/ci.jpg\]\n\nRerun\?$/);
  assert.equal(askCard(item({ body: 'Which layout?\nIMAGE: /tmp/a.gif' }))!.body, '[image: /tmp/a.gif]\n\nWhich layout?');
});

test('a plain screenshot path in the ask also shows as a thumbnail; the text keeps it', () => {
  const c = askCard(item({ body: SHAPED.replace('CONTEXT: The extension flow skips it.', 'CONTEXT: Mock at /Users/owner/orca/workspaces/x/docs/screens/muse.jpeg, left side.') }))!;
  assert.match(c.body, /^\[image: \/Users\/owner\/orca\/workspaces\/x\/docs\/screens\/muse.jpeg\]\n\nAdding/);
  assert.match(c.body, /Mock at \/Users\/owner\/orca\/workspaces\/x\/docs\/screens\/muse.jpeg, left side\.$/);
  assert.equal(askCard(item({ body: 'See https://example.com/a.png and docs/screens/b.png' }))!.body, 'See https://example.com/a.png and docs/screens/b.png', 'a URL or a relative path is not a picture to attach');
});

test('a picture outside the allowed folders shows as text, not as a broken thumbnail', () => {
  const allowed = (p: string) => p.startsWith('/Users/owner/Desktop/');
  const c = askCard(item({ body: SHAPED + '\nIMAGE: /etc/secret.png' }), undefined, allowed)!;
  assert.match(c.body, /^Image \(not in an allowed folder\): `\/etc\/secret.png`\n\nAdding/);
  assert.doesNotMatch(html(c), /<SHOT/);
  const marker = askCard(item({ body: 'Which one? [image: /etc/x.png]' }), undefined, allowed)!;
  assert.equal(marker.body, 'Which one? `/etc/x.png`');
  assert.equal(askCard(item({ body: SHAPED + '\nIMAGE: /Users/owner/Desktop/ok.png' }), undefined, allowed)!.body.split('\n')[0], '[image: /Users/owner/Desktop/ok.png]');
  // A card with no picture is unchanged.
  assert.equal(askCard(item({ body: SHAPED }), undefined, allowed)!.body, askCard(item({ body: SHAPED }))!.body);
});

test('a steer closes that worker\'s escalations and records whose words they were, for the card and the audit log', () => {
  const store = openStore(':memory:');
  const add = (external_id: string, dispatch_id: string, kind = 'escalation') => store.insertItem({ source: 'orca', external_id, kind, dispatch_id, subject: 'Blocked', body: 'QUESTION: Go on?' });
  add('own', 'd1'); add('spoken', 'd2'); add('question', 'd1', 'question'); add('other', 'd3');

  assert.deepEqual(closeSteeredAsks(store, 'd1', 'Keep going', false), ['own'], 'a question waits for a reply, and other workers are untouched');
  assert.deepEqual(closeSteeredAsks(store, 'd2', 'Use the second one', true), ['spoken']);
  assert.equal(store.item('question')!.status, 'new');
  assert.equal(store.item('other')!.status, 'new');

  const own = askCard(store.item('own')!);
  assert.equal(own.status, 'answered');
  assert.equal(own.answer, 'Keep going');
  assert.equal(own.answeredBy, 'jarvis');
  assert.equal(askCard(store.item('spoken')!).answeredBy, undefined, "The owner's spoken answer stays his");

  const audit = auditEntries(store, i => askCard(i), new Set());
  assert.equal(audit.find(x => x.key === 'ask:own')!.by, 'jarvis');
  assert.equal(audit.find(x => x.key === 'ask:spoken')!.by, undefined);
});

test('a later status change keeps who answered', () => {
  const store = openStore(':memory:');
  store.insertItem({ source: 'orca', external_id: 'a', kind: 'escalation', dispatch_id: 'd', subject: 'Blocked', body: 'x' });
  closeSteeredAsks(store, 'd', 'Keep going', false);
  store.markItem('a', 'done');
  assert.equal(store.item('a')!.answered_by, 'jarvis');
  assert.equal(store.item('a')!.answer, 'Keep going');
});
