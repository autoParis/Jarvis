import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { openStore } from './store.ts';
import { requestReport, makeRequests } from './requests.ts';
import { badgeOf, parseBlocks, splitReport, linkImages, reportHtml } from '../web/report.js';
import { reportHref, requestListHtml } from '../web/requestlist.js';
import { mergeWork, workListHtml } from '../web/worklist.js';
import { SAMPLE_REPORTS } from '../bin/preview-reports.ts';

const vm: { markdown?: (text: string, shot: (path: string) => string) => string } = {};
runInNewContext(readFileSync(new URL('../web/markdown.js', import.meta.url), 'utf8'), vm);
const ctx = { markdown: vm.markdown!, shot: (p: string) => `<SHOT ${p}>` };
const AT = Date.parse('2026-10-30T12:00:00Z');
const req = (extra: object) => ({ id: 7, status: 'done', title: 'Sheet update', at: new Date(AT).toISOString(), ...extra });

// ---- the link ----

test('a row with a report and no PR link gets Report; a PR link wins; no report means no link', () => {
  assert.equal(reportHref(req({ report: true })), '#report/7');
  assert.equal(reportHref(req({ report: true, pr: 'PR #4', url: 'https://github.com/o/r/pull/4' })), '');
  assert.equal(reportHref(req({})), '');
  // A PR number with no address is not a link, so the report is the way in.
  assert.equal(reportHref(req({ report: true, pr: 'PR #4' })), '#report/7');
});

test('Completed: Report sits where the PR link would be, and the title keeps its story number', () => {
  const html = requestListHtml([req({ report: true, title: '#4612 Export history' })], { done: true }, AT);
  assert.match(html, /<a href="#report\/7" class="num"[^>]*>Report<\/a><div class="t">#4612 Export history<\/div>/);
  const withPr = requestListHtml([req({ report: true, title: '#4612 Export history', pr: 'PR #4', url: 'https://x/pull/4' })], { done: true }, AT);
  assert.doesNotMatch(withPr, /Report/);
  assert.match(withPr, /href="https:\/\/x\/pull\/4" class="num"[^>]*>#4612</);
  assert.doesNotMatch(requestListHtml([req({})], { done: true }, AT), /#report/);
});

test('an open row in a work group gets the link too, and a plain conversation row does not', () => {
  const ctxList = { hidden: new Set(), shut: new Set(), closedWaiting: new Set(), folders: {}, now: AT };
  const row = { id: 'ctx_1', kind: 'worker', title: 'Plain', group: 'other', state: 'idle' };
  const failed = req({ id: 3, status: 'failed', report: true, title: 'Lead import' });
  const html = workListHtml(mergeWork([row], [failed], new Set()), ctxList);
  assert.match(html, /href="#report\/3"/);
  assert.equal(html.match(/#report/g)!.length, 1);
});

// ---- the data ----

function withRequest() {
  const store = openStore(':memory:');
  const a = store.addApproval({ action: 'question', args: '{}', say: 'Ask it' });
  store.addRequest({ dispatch_id: 'ctx_a', approval_id: a.id, action: 'question', title: 'Request: why slow', words: null });
  const id = store.requests()[0].id;
  const reqs = makeRequests({ store, log: () => {}, repoOf: async () => undefined, onChange: () => {} });
  const done = (n: string, body: string, outcome = 'succeeded') => store.insertItem({ source: 'native', external_id: n, kind: 'worker_done', dispatch_id: 'ctx_a', subject: `Subject ${n}`, body, meta: JSON.stringify({ outcome }) });
  return { store, id, reqs, done };
}

test('a request with no worker_done, or a blank body, has no report', () => {
  const { store, id, reqs, done } = withRequest();
  assert.equal(requestReport(store, id), undefined);
  assert.equal(reqs.list()[0].report, undefined);
  done('m1', ' \n\t ');
  assert.equal(requestReport(store, id), undefined);
  assert.equal(reqs.list()[0].report, undefined);
  assert.equal(requestReport(store, 999), undefined);
});

test('the report is the last worker_done with a body, with its subject and outcome', () => {
  const { store, id, reqs, done } = withRequest();
  done('m1', 'First answer');
  done('m2', 'Second answer', 'failed');
  done('m3', '   ');
  const r = requestReport(store, id)!;
  assert.deepEqual([r.subject, r.body, r.failed, r.title], ['Subject m2', 'Second answer', true, 'why slow']);
  assert.equal(reqs.list()[0].report, true);
});

test('a hidden request keeps its report', () => {
  const { store, id, done } = withRequest();
  done('m1', 'Answer');
  store.hideRequest(id);
  assert.equal(requestReport(store, id)!.body, 'Answer');
});

// ---- splitting ----

test('a short report is only a summary, with no sections', () => {
  const s = splitReport('Fixed the sheet. Nothing is left.');
  assert.equal(s.summary, 'Fixed the sheet. Nothing is left.');
  assert.deepEqual(s.sections, []);
});

test('the first paragraph is the summary; what follows it without a heading is Details', () => {
  const s = splitReport('The answer.\nStill the answer.\n\nFile: a.ts\n\n- more');
  assert.equal(s.summary, 'The answer.\nStill the answer.');
  assert.deepEqual(s.sections.map(x => x.title), ['Details']);
  assert.equal(s.sections[0].lines, 2);
});

test('headings split sections; deeper ones nest; a lone top heading is the title', () => {
  const s = splitReport('# Audit\n\nIntro line.\n\n## One\n\nText\n\n### Deep\n\nMore\n\n## Two\n\nText two');
  assert.equal(s.title, 'Audit');
  assert.equal(s.summary, 'Intro line.');
  assert.deepEqual(s.sections.map(x => x.title), ['One', 'Two']);
  assert.deepEqual(s.sections[0].sections.map((x: { title: string }) => x.title), ['Deep']);
});

test('a # inside a code fence is not a heading', () => {
  const s = splitReport('Summary.\n\n## Real\n\n```\n# not a heading\n## nor this\n```');
  assert.deepEqual(s.sections.map(x => x.title), ['Real']);
  assert.match(s.sections[0].blocks[0].text, /# not a heading/);
});

test('a bold line alone is a heading, a bold badge is not', () => {
  const s = splitReport('Summary.\n\n**What I tried**\n\n- one\n\n**Left:**\n\nNothing\n\n**PASS**');
  assert.deepEqual(s.sections.map(x => x.title), ['What I tried', 'Left']);
  assert.deepEqual(s.counts, { PASS: 1 });
});

test('a report that opens with a heading takes its summary from the first section, which goes when emptied', () => {
  const s = splitReport('## Summary\n\nAll good.\n\n## Findings\n\n- LOW: a thing');
  assert.equal(s.summary, 'All good.');
  assert.deepEqual(s.sections.map(x => x.title), ['Findings']);
});

test('a report with no paragraph has no summary and loses nothing', () => {
  const s = splitReport('- one\n- two\n\n| a | b |\n| - | - |\n| 1 | 2 |');
  assert.equal(s.summary, '');
  assert.deepEqual(s.sections[0].blocks.map((b: { type: string }) => b.type), ['md', 'table']);
});

test('a very long first paragraph is cut at a sentence, and the rest stays readable under Details', () => {
  const long = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} is here.`).join(' ');
  const s = splitReport(long);
  assert.ok(s.summary.length <= 600);
  assert.ok(s.summary.endsWith('.'));
  const rest = s.sections[0].blocks[0].text;
  assert.equal(`${s.summary} ${rest}`, long);
});

test('nothing in the body is lost by the split', () => {
  const { body } = SAMPLE_REPORTS[22];
  const s = splitReport(body);
  assert.ok(s.lines > 500, `${s.lines} lines with text`);
  assert.ok(body.split('\n').length > 600, `the sample has ${body.split('\n').length} lines`);
  const html = reportHtml({ id: 1, title: 'T', status: 'done', at: new Date(AT).toISOString(), subject: 'S', body, failed: false }, ctx);
  for (const needle of ['mobile-layout/step18.ts:57', 'Mobile layout case 10', 'Note 12 on mobile layout', '# this hash line is output']) assert.ok(html.includes(needle), needle);
  assert.equal(s.sections.length, 12);
  assert.equal(s.sections[0].sections.length, 3);
  assert.equal(html.match(/<details/g)!.length, 48);
  assert.doesNotMatch(html, /<details[^>]* open/);
});

// ---- badges ----

test('the ways a worker writes a badge', () => {
  const cases: [string, string, string][] = [
    ['HIGH: charged twice', 'HIGH', 'charged twice'],
    ['- MEDIUM - receipt early', 'MEDIUM', 'receipt early'],
    ['1. **LOW** two log lines', 'LOW', 'two log lines'],
    ['**FAIL:** the bank test', 'FAIL', 'the bank test'],
    ['- [PASS] unit tests', 'PASS', 'unit tests'],
    ['* PASSED all 12', 'PASS', 'all 12'],
    ['**High**: lower case in bold', 'HIGH', 'lower case in bold'],
    ['Low: with a colon', 'LOW', 'with a colon'],
    ['**HIGH risk in auth**: see below', 'HIGH', '**risk in auth**: see below'],
    ['FAIL', 'FAIL', ''],
  ];
  for (const [line, label, text] of cases) {
    const b = badgeOf(line);
    assert.deepEqual([b?.label, b?.text], [label, text], line);
  }
  assert.equal(badgeOf('1. HIGH: x')!.num, '1');
  assert.equal(badgeOf('HIGH: x')!.tone, 'bad');
  assert.equal(badgeOf('MEDIUM: x')!.tone, 'warn');
  assert.equal(badgeOf('LOW: x')!.tone, 'quiet');
  assert.equal(badgeOf('PASS: x')!.tone, 'good');
});

test('plain sentences are not badges', () => {
  for (const line of ['Low battery on the phone', 'High traffic this week', 'HIGH-level summary', 'OK so the test ran', 'Pass the token along', 'Done with the sheet', '(HIGH risk) maybe', 'Highlights', 'constructor: x', '']) {
    assert.equal(badgeOf(line), undefined, line);
  }
});

test('badge rows group into one list, keep wrapped lines, and end at a plain line', () => {
  const blocks = parseBlocks('Intro\n\n1. HIGH: one\n   wrapped\n\n2. LOW: two\n\nOutro'.split('\n'));
  assert.deepEqual(blocks.map((b: { type: string }) => b.type), ['md', 'ranked', 'md']);
  assert.deepEqual(blocks[1].items.map((i: { label: string; text: string }) => [i.label, i.text]), [['HIGH', 'one\nwrapped'], ['LOW', 'two']]);
});

test('counts add up through nested sections and table cells, worst first on the page', () => {
  const s = splitReport('Sum.\n\n## A\n\n### B\n\n- LOW: x\n\n### C\n\n| Check | Result |\n| --- | --- |\n| one | **FAIL** |\n| two | PASS |\n| three | PASSES a lot |');
  assert.deepEqual(s.counts, { LOW: 1, FAIL: 1, PASS: 1 });
  const html = reportHtml({ id: 1, title: 'T', status: 'done', at: new Date(AT).toISOString(), subject: '', body: 'Sum.\n\n## A\n\n- LOW: x\n- HIGH: y', failed: false }, ctx);
  assert.match(html, /rp-chips"><span class="rp-badge bad">1 HIGH<\/span><span class="rp-badge quiet">1 LOW/);
});

// ---- tables and pictures ----

test('a table: head, rows, escaped pipes, a short row filled out', () => {
  const [t] = parseBlocks('| A | B |\n|---|:-:|\n| 1 | x \\| y |\n| 2 |'.split('\n'));
  assert.deepEqual([t.head, t.rows], [['A', 'B'], [['1', 'x | y'], ['2', '']]]);
});

test('a | in a sentence is not a table, and neither is a table inside a code fence', () => {
  assert.deepEqual(parseBlocks(['a | b', 'next line'])[0].type, 'md');
  assert.deepEqual(parseBlocks(['```', '| a |', '|---|', '```']).map((b: { type: string }) => b.type), ['md']);
});

test('[image: path] lines and bare image paths become pictures, code keeps its own', () => {
  assert.equal(linkImages('See /a/b.png, and /c.JPG'), 'See [image: /a/b.png], and [image: /c.JPG]');
  assert.equal(linkImages('[image: /a/b.png]'), '[image: /a/b.png]');
  assert.equal(linkImages('run `open /a/b.png` now'), 'run `open /a/b.png` now');
  assert.equal(linkImages('```\n/a/b.png\n```'), '```\n/a/b.png\n```');
  assert.equal(linkImages('see /a/b.txt or a/b.png'), 'see /a/b.txt or a/b.png');
  const s = splitReport('Sum.\n\n## Screens\n\n[image: /a.png]\n\nand /b.png');
  assert.equal(s.sections[0].images, 2);
  const html = reportHtml({ id: 1, title: 'T', status: 'done', at: new Date(AT).toISOString(), subject: '', body: 'Sum.\n\n## Screens\n\n[image: /a.png]\n\nand /b.png', failed: false }, ctx);
  assert.match(html, /<SHOT \/a.png>/);
  assert.match(html, /<SHOT \/b.png>/);
  assert.match(html, /2 pictures/);
});

// ---- the page ----

test('everything in the page is escaped', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const html = reportHtml({ id: 1, title: evil, status: `<b>`, at: new Date(AT).toISOString(), subject: evil, body: `${evil}\n\n## ${evil}\n\n- HIGH: ${evil}\n\n| ${evil} |\n|---|\n| ${evil} |`, failed: false }, ctx);
  assert.doesNotMatch(html, /<img/);
  assert.doesNotMatch(html, /<b>/);
});

test('sections start closed; the summary and Expand all are outside them; a report with no sections has no button', () => {
  const r = { id: 1, title: 'T', status: 'done', at: new Date(AT).toISOString(), subject: 'Subj', failed: false };
  const html = reportHtml({ ...r, body: 'Sum.\n\n## A\n\ntext' }, ctx);
  assert.match(html, /rp-summary.*Subj.*Sum\..*rp-all.*<details class="rp-sec">/s);
  assert.doesNotMatch(html, /<details[^>]* open/);
  assert.doesNotMatch(reportHtml({ ...r, body: 'Sum.' }, ctx), /rp-all/);
});

test('a worker that reported failure says so on the page', () => {
  const html = reportHtml({ id: 1, title: 'T', status: 'done', at: new Date(AT).toISOString(), subject: '', body: 'Sum.', failed: true }, ctx);
  assert.match(html, /reported a failure/);
});
