// A worker ask with a report (its REPORT line): the contract parser, the report's summary, the ask card and its HTML,
// the request row and its HTML, and the phone push. Each test goes through the interface the next layer reads.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { openStore, type Item } from './store.ts';
import { askReportPath, reportPathIn, ASK_FIELDS, workerBrief, REPORTS_DIR } from './workercontract.ts';
import { reportSummary } from './reports.ts';
import { imageFile } from './images.ts';
import { askCard } from './asks.ts';
import { askMessage, pushOpenAsks, type PushMessage } from './push.ts';
import { makeRequests, requestDoc, type RequestView } from './requests.ts';
import { docLinkHtml, requestListHtml } from '../web/requestlist.js';
import { docHref, docRoute } from '../web/report.js';
import { docHref as contractHref } from '../web/contract.js';

const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

/** A data/reports folder with one report that shows three pictures, one of them twice, and names two that are not served. */
function reports() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'jarvis-reportasks-')));
  const dir = join(base, 'data', 'reports');
  mkdirSync(join(dir, 'shots'), { recursive: true });
  for (const n of ['01', '02', '03']) writeFileSync(join(dir, 'shots', `${n}.png`), PNG);
  const path = join(dir, '4812-seller-footer.md');
  writeFileSync(path, [
    '# #4812: let a seller edit the footer', '', 'Intro.', '',
    '![Listing tab](shots/01.png)', '', '![Templates](<shots/02.png> "the templates")', '',
    '```', '![in a code block](shots/03.png)', '```', '',
    `[image: ${join(dir, 'shots', '03.png')}]`, '', '![again](./shots/01.png)', '',
    '![missing](shots/gone.png)', '', '![web](https://example.test/x.png)',
  ].join('\n'));
  const shown = (p: string) => Boolean(imageFile(p, [dir]));
  const reportOf = (p: string) => reportSummary(p, dir, shown);
  return { base, dir, path, shown, reportOf };
}

const ask = (body: string, extra: Partial<Item> = {}): Item => ({ id: 1, source: 'native', external_id: 'q1', kind: 'question', dispatch_id: 'n:w1',
  subject: 'Question from w1', body, options: null, status: 'spoken', answer: null, created_at: '2026-11-10 12:00:00', pushes: 0, pushed_at: null, meta: null, ...extra } as Item);

const shaped = (report: string) => `STORY: 4812 seller footer\nWHERE: I wrote the design.\nQUESTION: Which design?\nCONTEXT: Two designs.\nREPORT: ${report}\nOPTIONS: Option A because sellers edit it\nOption B because admins keep it`;

// ---- the contract ----

test('the REPORT line sits between CONTEXT and OPTIONS in the brief, names the reports folder, and reads back in every form', () => {
  assert.ok(ASK_FIELDS.indexOf('REPORT') > ASK_FIELDS.indexOf('CONTEXT') && ASK_FIELDS.indexOf('REPORT') < ASK_FIELDS.indexOf('OPTIONS'));
  const brief = workerBrief();
  assert.match(brief, new RegExp(`^REPORT: <optional, the absolute path of the \\.md report in ${REPORTS_DIR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'm'));
  assert.match(brief, /give its path on the REPORT line/);
  const p = '/srv/jarvis/data/reports/a b.md'.replace(' ', '-');
  for (const form of [p, `\`${p}\``, `[report: ${p}]`, `<${p}>`]) assert.equal(askReportPath(shaped(form)), p, form);
  assert.equal(askReportPath(shaped('see the design doc')), undefined, 'a line that is not a path names no report');
  assert.equal(askReportPath(shaped('/srv/x.png')), undefined, 'only a .md file');
  assert.equal(askReportPath('STORY: 1\nQUESTION: Go?\nOPTIONS: yes because ok'), undefined, 'an ask without the line stays valid');
});

test('a data/reports path anywhere in a text is found, with its punctuation left out', () => {
  assert.equal(reportPathIn('CONTEXT: the design is in /srv/jarvis/data/reports/4812-design.md. Read it.'), '/srv/jarvis/data/reports/4812-design.md');
  assert.equal(reportPathIn('DONE: wrote it\n- report: `/srv/jarvis/data/reports/sub/x.md`'), '/srv/jarvis/data/reports/sub/x.md');
  assert.equal(reportPathIn('[report: /srv/jarvis/data/reports/y.md]'), '/srv/jarvis/data/reports/y.md');
  assert.equal(reportPathIn('see /srv/jarvis/docs/x.md and data/reports/rel.md'), undefined);
  assert.equal(reportPathIn(null), undefined);
});

test('the page address of a report is one helper, shared by the contract and the report page', () => {
  assert.equal(docHref, contractHref);
  assert.equal(docRoute(contractHref('/srv/data/reports/a.md')), '/srv/data/reports/a.md');
});

// ---- the report's summary ----

test('a report summary has the first heading, the first served picture, and the count of served pictures', () => {
  const { dir, path, reportOf } = reports();
  const s = reportOf(path)!;
  assert.equal(s.title, '#4812: let a seller edit the footer');
  assert.equal(s.image, join(dir, 'shots', '01.png'), 'a relative path reads against the report folder');
  assert.equal(s.pictures, 3, 'the code block, the repeat, the missing file and the web address do not count');
  assert.equal(reportOf(join(dir, '..', 'secret.md')), undefined);
  writeFileSync(join(dir, 'plain.md'), '# Plain\n\nNo pictures.');
  assert.deepEqual(reportOf(join(dir, 'plain.md')), { path: join(dir, 'plain.md'), title: 'Plain', pictures: 0 });
});

// ---- the ask card ----

const ctx: { markdown?: (t: string, shot: (p: string) => string) => string; askCardHtml?: (c: any, md: (t: string) => string) => string } = {};
runInNewContext(readFileSync(new URL('../web/markdown.js', import.meta.url), 'utf8'), ctx);
runInNewContext(readFileSync(new URL('../web/askcard.js', import.meta.url), 'utf8'), ctx);
const html = (c: any) => ctx.askCardHtml!(c, t => ctx.markdown!(t, p => `<SHOT ${p}>`));

test('an ask with a REPORT line gets a report button: title, first picture, count, and the viewer address', () => {
  const { dir, path, shown, reportOf } = reports();
  const card = askCard(ask(shaped(path)), undefined, shown, reportOf)!;
  assert.deepEqual(card.report, { path, title: '#4812: let a seller edit the footer', image: join(dir, 'shots', '01.png'), pictures: 3, href: docHref(path) });
  assert.doesNotMatch(card.parts?.more ?? '', /4812-seller-footer/, 'the path is not repeated as text');
  const out = html(card);
  assert.match(out, new RegExp(`<a class="ask-report" href="${docHref(path).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
  assert.match(out, /<img class="ask-report-img" src="\/image\?path=[^"]*01\.png"/);
  assert.match(out, /Read the report first · 3 pictures<\/span><span class="ask-report-t">#4812: let a seller edit the footer<\/span>/);
  assert.ok(out.indexOf('ask-report') < out.indexOf('The question'), 'the button is above the question');
});

test('a report with no pictures shows the document icon, and the old ask that named it only in CONTEXT gets the button too', () => {
  const { dir, shown, reportOf } = reports();
  writeFileSync(join(dir, 'plain.md'), '# Plain');
  const old = `STORY: 1\nQUESTION: Go?\nCONTEXT: The design is in ${join(dir, 'plain.md')}.\nOPTIONS: yes because ok`;
  const card = askCard(ask(old), undefined, shown, reportOf)!;
  assert.equal(card.report?.title, 'Plain');
  const out = html(card);
  assert.match(out, /<span class="ask-report-img"><svg/);
  assert.match(out, />Read the report first<\/span>/);
});

test('a REPORT line the daemon cannot open shows its path as text, and an ask with no report has no button', () => {
  const { base, shown, reportOf } = reports();
  const outside = join(base, 'secret.md');
  writeFileSync(outside, '# no');
  const card = askCard(ask(shaped(outside)), undefined, shown, reportOf)!;
  assert.equal(card.report, undefined);
  assert.match(card.parts?.more ?? '', /Report \(not found in data\/reports\): `[^`]*secret\.md`/);
  const plain = askCard(ask('STORY: 1\nQUESTION: Go?\nOPTIONS: yes because ok'), undefined, shown, reportOf)!;
  assert.equal(plain.report, undefined);
  assert.doesNotMatch(html(plain), /ask-report/);
});

// ---- the phone push ----

test('the push for an ask with a report opens the report and says to read it; without one it opens the ask', () => {
  const { path, reportOf } = reports();
  const m = askMessage(ask(shaped(path)), reportOf);
  assert.equal(m.url, `/?item=q1${docHref(path)}`);
  assert.match(m.body, /^Read the report first: #4812: let a seller edit the footer\nWhich design\?/);
  assert.ok(m.body.length <= 180);
  assert.equal(m.tag, 'item-q1');
  const plain = askMessage(ask('QUESTION: Go?\nOPTIONS: yes because ok'), reportOf);
  assert.deepEqual([plain.url, plain.body], ['/?item=q1', 'Go?']);
  assert.equal(askMessage(ask(shaped(path))).url, '/?item=q1', 'with no reader the push is as before');
  // The service worker reads the address the push carries.
  const at = new URL(m.url, 'https://jarvis.test');
  assert.equal(at.searchParams.get('item'), 'q1');
  assert.equal(docRoute(at.hash), path);
});

test('the push sweep carries the report into the push it sends', async () => {
  const { path, reportOf } = reports();
  const s = openStore(':memory:');
  s.db.prepare(`INSERT INTO items (source, external_id, kind, body, created_at) VALUES ('native', 'q9', 'question', ?, datetime('now', '-1 hour'))`).run(shaped(path));
  const sent: PushMessage[] = [];
  await pushOpenAsks(s, async m => { sent.push(m); return 1; }, Date.now(), reportOf);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, `/?item=q9${docHref(path)}`);
});

// ---- the request row ----

function requests(reportOf: (p: string) => { path: string; title: string } | undefined) {
  const store = openStore(':memory:');
  const views: RequestView[][] = [];
  const reqs = makeRequests({ store, log: () => {}, onChange: v => views.push(v), repoOf: async () => undefined, reportOf });
  const a = store.addApproval({ action: 'worker-start', args: JSON.stringify({ repo: '/r', taskTitle: '#4812 seller footer', spec: 's' }), say: 'Start it?' });
  store.decide(a.id, 'approved', 'button');
  store.finishApproval(a.id, 'done', JSON.stringify({ dispatchId: 'n:w1', taskId: 't', state: 'ready' }));
  reqs.started(store.approval(a.id)!);
  const addAsk = (id: string, body: string) => store.db.prepare(`INSERT INTO items (source, external_id, kind, dispatch_id, body, status) VALUES ('native', ?, 'question', 'n:w1', ?, 'spoken')`).run(id, body);
  const done = (body: string) => store.db.prepare(`INSERT INTO items (source, external_id, kind, dispatch_id, body, meta) VALUES ('native', 'd1', 'worker_done', 'n:w1', ?, '{"outcome":"succeeded"}')`).run(body);
  return { store, reqs, addAsk, done };
}

test('a request whose open ask has a report gets the doc, marked as waiting, and loses the mark once answered', () => {
  const { path, reportOf } = reports();
  const r = requests(reportOf);
  assert.equal(r.reqs.list()[0].doc, undefined, 'no report yet');
  r.addAsk('q1', shaped(path));
  assert.deepEqual(r.reqs.list()[0].doc, { path, title: '#4812: let a seller edit the footer', href: docHref(path), waits: true });
  r.store.markItem('q1', 'answered', 'Option A');
  assert.equal(r.reqs.list()[0].doc?.waits, false, 'the report stays, but nothing waits on it');
});

test('a request whose DONE report names a data/reports file gets the doc with nothing waiting', () => {
  const { path, reportOf } = reports();
  const r = requests(reportOf);
  r.done(`DONE: the design is written.\n\n- Report: ${path}`);
  assert.deepEqual(requestDoc(r.store, 'n:w1', reportOf), { path, title: '#4812: let a seller edit the footer', href: docHref(path), waits: false });
  assert.equal(requestDoc(r.store, 'n:other', reportOf), undefined);
});

test('the row shows a report icon that opens the report, with "Read first" only when a question waits on it', () => {
  const doc = { path: '/srv/data/reports/a.md', title: 'Design <A>', href: docHref('/srv/data/reports/a.md') };
  const reads = docLinkHtml({ doc: { ...doc, waits: true } });
  assert.match(reads, /^<a href="#reports\/%2Fsrv%2Fdata%2Freports%2Fa\.md" class="rdoc needs" aria-label="A question waits on this report\. Read it first: Design &lt;A&gt;"/);
  assert.match(reads, /<span>Read first<\/span><\/a>$/);
  const quiet = docLinkHtml({ doc: { ...doc, waits: false } });
  assert.match(quiet, /class="rdoc" aria-label="Read the report: Design &lt;A&gt;"/);
  assert.doesNotMatch(quiet, /Read first/);
  assert.equal(docLinkHtml({}), '');
  // A Completed row draws it beside its age.
  const row = { id: 1, title: '#4812 seller footer', words: null, status: 'done', at: '2026-11-10T12:00:00Z', startedAt: '2026-11-10T11:00:00Z', doc: { ...doc, waits: false } };
  const list = requestListHtml([row], { done: true }, Date.parse('2026-11-10T12:05:00Z'));
  assert.match(list, /<span class="wend"><a href="#reports\/[^"]+" class="rdoc"/);
});
