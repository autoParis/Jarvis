// The short card shapes the owner asked for on 2026-11-06: an ask, an approval and a report each read under fixed headings,
// with long detail behind a More toggle. Cards from older workers, with no fields, render as before.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { openStore, type Item } from './store.ts';
import { askCard } from './asks.ts';
import { makeGate, buildCommand, cardJson, CARD_RULE, ISSUE_RULE } from './gate.ts';
import { approvalBodyHtml, approvalPairHtml, approvalCard } from '../web/worklist.js';
import { splitReport, reportHtml } from '../web/report.js';

const vm: { markdown?: (t: string, shot: (p: string) => string) => string; askCardHtml?: (c: any, md: (t: string) => string, err?: string) => string } = {};
runInNewContext(readFileSync(new URL('../web/markdown.js', import.meta.url), 'utf8'), vm);
runInNewContext(readFileSync(new URL('../web/askcard.js', import.meta.url), 'utf8'), vm);
const md = (t: string) => vm.markdown!(t, p => `<SHOT ${p}>`);
const html = (c: any) => vm.askCardHtml!(c, md);

const item = (extra: Partial<Item>): Item => ({
  id: 1, source: 'native', external_id: 'msg_1', kind: 'question', dispatch_id: 'd_1', subject: '', body: '', options: null,
  status: 'spoken', answer: null, created_at: '2026-11-06 12:00:00', pushes: 0, pushed_at: null, meta: null, ...extra,
});

const ASK = `STORY: 4688 Marketplace photo order
WHERE: Fixing the photo order sync for paused accounts.
QUESTION: Reorder the photos already on Marketplace?
CONTEXT: 41 listings on 3 accounts. About **6 minutes** per account.

- The rate limit is shared with the publish queue.
OPTIONS:
- Reorder all because dealers see the wrong cover now
- Only new listings because no delay for the publish queue`;

test('an ask in the fields shape reads: title, what the worker is doing, the question, options, then More', () => {
  const c = askCard(item({ body: ASK }))!;
  assert.deepEqual(c.parts, { doing: 'Fixing the photo order sync for paused accounts.', more: '41 listings on 3 accounts. About **6 minutes** per account.\n\n- The rate limit is shared with the publish queue.' });
  const out = html(c);
  const at = (s: string) => { const i = out.indexOf(s); assert.ok(i >= 0, `missing ${s}`); return i; };
  const order = [at('class="ask-title">4688 Marketplace photo order<'), at('>What the worker is doing</h3>'), at('>The question</h3>'), at('class="ask-q"'), at('>Options</h3>'), at('class="ask-opt rec"'), at('<details class="card-more"><summary>More</summary>')];
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'the parts come in the fixed order');
  // Markdown in the long part renders: bold and bullets, inside the closed toggle.
  assert.match(out, /<details class="card-more"><summary>More<\/summary><div class="ask-body md"><p>41 listings on 3 accounts\. About <strong>6 minutes<\/strong> per account\.<\/p><ul><li>The rate limit/);
  assert.doesNotMatch(out, /<details[^>]* open/, 'More starts closed');
  // The options keep their numbers, the recommended first, each with its one line.
  assert.match(out, /<span class="n">1<\/span><span class="l">Reorder all<span class="d">dealers see the wrong cover now<\/span><\/span><span class="tag">Recommended<\/span>/);
});

test('an ask with no CONTEXT has no More toggle, and one with no WHERE has no doing heading', () => {
  const out = html(askCard(item({ body: 'STORY: 1 x\nQUESTION: Ship it?\nOPTIONS: Yes because done; No because not done' }))!);
  assert.doesNotMatch(out, /card-more|What the worker is doing/);
  assert.match(out, />The question<\/h3><p class="ask-q"[^>]*>Ship it\?<\/p><h3 class="card-h">Options<\/h3>/);
});

test('an old free-form ask has no parts and renders as one block, as before', () => {
  const body = 'I need a call on the export screen. Three dealerships have no export account yet, and the screen can hide them or label them. Options: (a) label them; (b) hide them';
  const c = askCard(item({ body }))!;
  assert.equal(c.parts, undefined);
  const out = html(c);
  assert.doesNotMatch(out, /card-h|card-more/);
  assert.match(out, /<div class="ask-body md"><p[^>]*>I need a call on the export screen\./);
  // An escalation with a headline and no fields stays as before too.
  const esc = askCard(item({ kind: 'escalation', subject: 'Blocked: tests red', body: 'The export tests failed three times. I stopped.' }))!;
  assert.equal(esc.parts, undefined);
  assert.doesNotMatch(html(esc), /card-h/);
});

test('ask text in the new parts never becomes markup', () => {
  const out = html(askCard(item({ body: 'STORY: <b>x</b>\nWHERE: <script>1</script>\nQUESTION: <img src=x onerror=1>?\nCONTEXT: [a](javascript:alert(1)) <u>u</u>' }))!);
  assert.doesNotMatch(out, /<(b|script|img|u)[\s>]/);
  assert.doesNotMatch(out, /href="javascript/);
});

const START = { id: 30, action: 'worker-start', args: '', say: 'Start story 4701 on Opus?', status: 'pending', created_at: '' };
const startArgs = { repo: '/r', taskTitle: '#4701 Lead alerts', spec: 'Run the pick-and-ship skill on issue #4701.' };

test('an approval with its two lines reads: the action, If you approve, It rests on, and the details behind More', () => {
  const a = { ...START, card: JSON.stringify({ approves: 'A worker starts in a new worktree.', restsOn: 'Issue #4701 is ready.' }) };
  const out = approvalBodyHtml(a, startArgs);
  assert.equal(out, '<h2 class="say">Start story 4701 on Opus?</h2>'
    + '<h3 class="card-h">If you approve</h3><p class="card-p">A worker starts in a new worktree.</p>'
    + '<h3 class="card-h">It rests on</h3><p class="card-p">Issue #4701 is ready.</p>'
    + '<details class="card-more"><summary>More</summary><div class="c-detail">/r\nRun the pick-and-ship skill on issue #4701.</div></details>');
});

test('an approval with no lines shows its details in view, as before', () => {
  assert.equal(approvalBodyHtml({ ...START, card: null }, startArgs), '<h2 class="say">Start story 4701 on Opus?</h2><div class="c-detail">/r\nRun the pick-and-ship skill on issue #4701.</div>');
  assert.equal(approvalBodyHtml({ ...START, card: 'not json' }, startArgs), approvalBodyHtml(START, startArgs));
  assert.deepEqual(approvalCard({ card: 'null' }), {});
});

test('a command that will run stays in view on a card with lines, because it is what the owner approves', () => {
  const a = { ...START, action: 'gh-pr-close', card: JSON.stringify({ approves: 'The PR closes.' }) };
  const out = approvalBodyHtml(a, { runs: 'gh pr close 4 --repo o/r' });
  assert.match(out, /<p class="card-p">The PR closes\.<\/p><div class="c-detail">gh pr close 4 --repo o\/r<\/div>$/);
  assert.doesNotMatch(out, /card-more/);
  const perm = approvalBodyHtml({ ...a, action: 'worker-permission' }, { tool: 'Bash', summary: 'rm -rf /tmp/x' });
  assert.match(perm, /<div class="c-detail cmd">Bash: rm -rf \/tmp\/x<\/div>$/);
});

test('approval text never becomes markup', () => {
  const out = approvalBodyHtml({ ...START, say: '<b>x</b>', card: JSON.stringify({ approves: '<script>1</script>', restsOn: '<img src=x>' }) }, { spec: '<u>u</u>' });
  assert.doesNotMatch(out, /<(b|script|img|u)[\s>]/);
});

test('Approve sits on the right of Reject, and Allow on the right of Deny', () => {
  assert.equal(approvalPairHtml(30, 'worker-start'), '<div class="pair" data-approval="30"><button type="button" class="no">Reject</button><button type="button" class="yes">Approve</button></div>');
  assert.match(approvalPairHtml(31, 'worker-permission'), /class="no">Deny<\/button><button type="button" class="yes">Allow<\/button><\/div>$/);
  const page = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  assert.match(page, /id="msg-handled">I'll handle it<\/button><button type="button" class="yes" id="msg-send">Send reply/, 'the email card puts Send reply on the right');
  assert.doesNotMatch(page, /class="yes"[^<]*<\/button><button type="button" class="no"/, 'no card puts its yes button first');
});

test('the gate stores the two lines with the proposal, and older callers store none', async () => {
  const s = openStore(':memory:');
  const gate = makeGate(s, () => {});
  const a = await gate.propose('worker-stop', { dispatch: 'ctx_1' }, 'Stop 4412?', { approves: ' The worker stops. ', restsOn: 'The owner asked for it.' });
  assert.deepEqual(JSON.parse(s.approval(a.id)!.card!), { approves: 'The worker stops.', restsOn: 'The owner asked for it.' });
  const b = await gate.propose('worker-stop', { dispatch: 'ctx_2' }, 'Stop 4415?');
  assert.equal(s.approval(b.id)!.card, null);
  assert.equal(cardJson({ approves: '  ', restsOn: 3 }), null);
  assert.equal(cardJson('text'), null);
  assert.equal(cardJson({ restsOn: 'x' }), '{"restsOn":"x"}');
});

test('an older database gets the card column', () => {
  const s = openStore(':memory:');
  const cols = (s.db.prepare('PRAGMA table_info(approvals)').all() as { name: string }[]).map(c => c.name);
  assert.ok(cols.includes('card'));
});

test('a report in the card shape: the result line leads, short bullets stay in view, headed detail folds', () => {
  const body = 'DONE: The lead alerts moved to the task queue.\n- Branch: lead-queue, commit abc1234\n- PR: https://github.com/o/r/pull/9\n- Not proven: the alert at night\n\n## Details\nLong notes here.';
  const r = splitReport(body);
  assert.equal(r.result, 'done');
  assert.equal(r.summary, 'The lead alerts moved to the task queue.\n\n- Branch: lead-queue, commit abc1234\n- PR: https://github.com/o/r/pull/9\n- Not proven: the alert at night');
  assert.deepEqual(r.sections.map(s => s.title), ['Details']);
  const out = reportHtml({ id: 1, status: 'done', title: 'Lead alerts', at: '2026-11-06T12:00:00Z', body, subject: 'lead-alerts-30' }, { markdown: vm.markdown!, shot: (p: string) => `<SHOT ${p}>` });
  assert.match(out, /<h3 class="card-h">Result<\/h3><div class="md"><p>The lead alerts moved to the task queue\.<\/p><ul><li>Branch: lead-queue/);
  assert.match(out, /<details class="rp-sec"><summary>.*Details/);
  assert.equal(splitReport('FAILED: Tests went red.').result, 'failed');
});

test('a report with a long intro under the result keeps only the result in view', () => {
  const long = Array.from({ length: 14 }, (_, i) => `- point ${i}`).join('\n');
  const r = splitReport(`DONE: Finished.\n${long}`);
  assert.equal(r.summary, 'Finished.');
  assert.equal(r.sections[0].title, 'Details');
});

test('an old report with no result line splits as before', () => {
  const r = splitReport('The sheet is updated with 12 rows.\n\n## Rows\n- a');
  assert.equal(r.result, undefined);
  assert.equal(r.summary, 'The sheet is updated with 12 rows.');
});

const specOf = (argv: string[]) => argv.includes('--spec') ? argv[argv.indexOf('--spec') + 1] : argv.at(-1)!;

test('every worker spec ends with the card rule: story, question, draft and side chat', () => {
  const specs = {
    nativeStart: specOf(buildCommand('worker-start', { repo: '/r', spec: 'Do #1' })),
    nativeQuestion: specOf(buildCommand('question', { repo: '/r', question: 'Why?' })),
    draft: specOf(buildCommand('today-draft', { repo: '/r', spec: 'Draft it', taskTitle: 'Draft: x' })),
    nativeSide: specOf(buildCommand('side-chat', { repo: '/r', text: 'hi' })),
  };
  for (const [name, spec] of Object.entries(specs)) assert.ok(spec.endsWith(CARD_RULE), `${name} ends with the card rule`);
  // The issue rule still sits before the footer on a story worker.
  assert.ok(specs.nativeStart.indexOf(ISSUE_RULE.trim().slice(0, 30)) < specs.nativeStart.indexOf(CARD_RULE.trim()));
});

test('the card rule names the skill and each heading the app draws', () => {
  assert.match(CARD_RULE, /asd-ste100 skill \(`~\/\.claude\/skills\/asd-ste100\/SKILL\.md`\)/);
  assert.match(CARD_RULE, /STE-flavored mode for sentences, Strict mode for option choices/);
  for (const heading of ['What the worker is doing', 'The question', 'More toggle', 'DONE: <the result in one sentence>', '## Details']) assert.ok(CARD_RULE.includes(heading), heading);
  assert.doesNotMatch(CARD_RULE, /;/, 'the rule follows its own no-semicolon line');
});

test('the brain is told to write its card lines and replies under the same skill', () => {
  const vault = readFileSync(new URL('../vault/CLAUDE.md', import.meta.url), 'utf8');
  assert.match(vault, /asd-ste100 skill/);
  assert.match(vault, /--approves "<what happens if he approves>" --rests-on "<the fact it rests on>"/);
  assert.match(vault, /Spoken replies still have no markdown/);
});
