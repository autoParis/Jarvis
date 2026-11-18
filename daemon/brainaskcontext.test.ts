// A brain ask that approves words carries them: --context shows under the question, and --report gets the worker ask's
// report button and opens first from the phone push. Each test goes through the route jarvis-act posts to.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { openStore } from './store.ts';
import { brainAskRoute, briefLine } from './brainasks.ts';
import { reportSummary } from './reports.ts';
import { askCard } from './asks.ts';
import { askMessage } from './push.ts';
import { docHref } from '../web/contract.js';

const re = (s: string) => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

function setup() {
  const dir = join(realpathSync(mkdtempSync(join(tmpdir(), 'jarvis-brainctx-'))), 'data', 'reports');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'ticket-1052-reply.md');
  writeFileSync(path, '# TICKET-1052: the reply to Malik\n\nBonjour Malik, the fix is live.\n');
  const reportOf = (p: string) => reportSummary(p, dir, () => false);
  const store = openStore(':memory:');
  const changed: string[] = [];
  const o = { store, log: () => {}, changed: (id: string) => { changed.push(id); }, reportOf };
  const ask = async (extra: Record<string, unknown>) =>
    brainAskRoute(o, 'POST', '/api/internal/ask', async () => ({ question: 'Queue this reply on TICKET-1052?', options: ['Queue it', 'Change it'], about: 'TICKET-1052 reply', ...extra }));
  return { dir, path, store, changed, reportOf, ask };
}

const ctx: { markdown?: (t: string, shot: (p: string) => string) => string; askCardHtml?: (c: any, md: (t: string) => string) => string } = {};
runInNewContext(readFileSync(new URL('../web/markdown.js', import.meta.url), 'utf8'), ctx);
runInNewContext(readFileSync(new URL('../web/askcard.js', import.meta.url), 'utf8'), ctx);
const html = (c: any) => ctx.askCardHtml!(c, t => ctx.markdown!(t, p => `<SHOT ${p}>`));

test('--context shows under the question on the card, before the options, and in the brief', async () => {
  const s = setup();
  const r = await s.ask({ context: 'Bonjour Malik, the fix for the photo import is live.' });
  assert.equal(r?.status, 200);
  const id = (r!.body as any).id;
  const card = askCard(s.store.item(id)!, undefined, undefined, s.reportOf)!;
  assert.deepEqual(card.parts, { context: 'Bonjour Malik, the fix for the photo import is live.' });
  assert.equal(card.report, undefined);
  assert.deepEqual((r!.body as any).ask.parts, card.parts, 'the route returns the same card');
  const h = html(card);
  const q = h.indexOf('Queue this reply on TICKET-1052?'), c = h.indexOf('Bonjour Malik, the fix for the photo import is live.'), opts = h.indexOf('ask-options');
  assert.ok(q >= 0 && c > q && opts > c, 'the question, then the context, then the options');
  assert.match(h, /class="ask-body ask-context md"/);
  assert.doesNotMatch(h, /<summary>More<\/summary>/, 'the context is never behind More');
  assert.match(briefLine(s.store.item(id)!), /context="Bonjour Malik, the fix for the photo import is live\."/);
  assert.deepEqual(s.changed, [id]);
});

test('--report gets the worker ask report button, and the phone push opens the report first', async () => {
  const s = setup();
  const r = await s.ask({ report: s.path });
  assert.equal(r?.status, 200);
  const item = s.store.item((r!.body as any).id)!;
  const card = askCard(item, undefined, undefined, s.reportOf)!;
  assert.deepEqual(card.report, { path: s.path, title: 'TICKET-1052: the reply to Malik', pictures: 0, href: docHref(s.path) });
  const h = html(card);
  assert.match(h, re(`class="ask-report" href="${docHref(s.path)}"`));
  assert.match(h, /Read the report first/);
  const push = askMessage(item, s.reportOf);
  assert.equal(push.title, 'Jarvis is asking');
  assert.equal(push.url, `/?item=${encodeURIComponent(item.external_id)}${docHref(s.path)}`);
  assert.equal(push.body, 'Read the report first: TICKET-1052: the reply to Malik\nTICKET-1052 reply', 'the report title, then the topic, as before');
  assert.match(briefLine(item), re(`report=${s.path}`));
});

test('a report outside data/reports, not a .md file, relative or missing is refused, and nothing is stored', async () => {
  const s = setup();
  const outside = join(s.dir, '..', 'notes.md');
  writeFileSync(outside, '# Not a report\n');
  for (const report of [outside, join(s.dir, 'gone.md'), 'data/reports/ticket-1052-reply.md', join(s.dir, 'shot.png')]) {
    const r = await s.ask({ report });
    assert.equal(r?.status, 400, report);
    assert.match((r!.body as any).error, /--report must be the absolute path of a \.md file that exists in data\/reports/);
  }
  const long = await s.ask({ context: 'x'.repeat(1501) });
  assert.equal(long?.status, 400);
  assert.match((long!.body as any).error, /--report/, 'a long context points to a report');
  assert.deepEqual(s.store.openItems(), []);
  assert.deepEqual(s.changed, []);
});

test('an ask without --context or --report keeps the plain card and push', async () => {
  const s = setup();
  const r = await s.ask({});
  const item = s.store.item((r!.body as any).id)!;
  assert.equal(item.meta, null);
  const card = askCard(item, undefined, undefined, s.reportOf)!;
  assert.deepEqual(card.parts, {});
  assert.equal(card.report, undefined);
  assert.equal(askMessage(item, s.reportOf).url, `/?item=${encodeURIComponent(item.external_id)}`);
});
