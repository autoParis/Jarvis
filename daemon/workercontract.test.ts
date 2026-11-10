import test from 'node:test';
import assert from 'node:assert/strict';
import { ASK_FIELDS, REPORT_LABELS, CARD_RULE, NO_OPTIONS_REFUSAL, REPORT_NUDGE, fields, readReport, workerBrief, type WorkerKind } from './workercontract.ts';
import { askCard } from './asks.ts';
import { workerMessageKind } from './nativeroutes.ts';
import { parseReport } from './today.ts';
import type { Item } from './store.ts';

const BRIEFS: [string, string][] = (['native', 'orca'] as WorkerKind[]).flatMap(kind =>
  [false, true].map((issues): [string, string] => [`${kind}${issues ? ' with issues' : ''}`, workerBrief(kind, { issues })]));

/** The template lines of the ask shape a brief describes, as label and its placeholder. */
const askTemplate = (brief: string) => [...brief.matchAll(/^([A-Z]+): (.*)$/gm)].map(m => m[1]).filter(l => (ASK_FIELDS as readonly string[]).includes(l));

const item = (body: string): Item => ({ id: 1, source: 'native', external_id: 'q1', kind: 'question', dispatch_id: 'n:w1', subject: 'Question from w1',
  body, options: null, status: 'spoken', answer: null, created_at: '2026-11-10 12:00:00', pushes: 0, pushed_at: null, meta: null } as Item);

const SAMPLE: Record<string, string> = {
  STORY: '498 merge the audit changes', WHERE: 'I finished change 2. The tests pass.', QUESTION: 'Merge it now?',
  CONTEXT: 'CI is green on the branch.', IMAGE: '/tmp/shot.png',
  OPTIONS: 'Merge now because the tests pass\nWait because CI still runs',
};

test('every brief names the ask fields in the order the card reads them, and only fields the parser knows', () => {
  for (const [name, brief] of BRIEFS) {
    const labels = askTemplate(brief);
    for (const need of ['STORY', 'WHERE', 'QUESTION', 'OPTIONS']) assert.ok(labels.includes(need), `${name} brief names ${need}`);
    assert.deepEqual(labels, ASK_FIELDS.filter(l => labels.includes(l)), `${name} brief keeps the field order`);
    assert.ok(brief.endsWith(CARD_RULE), `${name} brief ends with the card rule`);
  }
});

test('an ask written in the shape of each brief reads back as a card with every field and both options', () => {
  for (const [name, brief] of BRIEFS) {
    const body = askTemplate(brief).map(l => `${l}: ${SAMPLE[l]}`).join('\n');
    const f = fields(body);
    for (const l of askTemplate(brief)) assert.equal(f[l], SAMPLE[l], `${name}: ${l} reads back`);
    const card = askCard(item(body), undefined, () => true)!;
    assert.equal(card.question, SAMPLE.QUESTION, name);
    assert.equal(card.parts?.doing, SAMPLE.WHERE, name);
    assert.match(card.parts?.more ?? '', /CI is green/, name);
    assert.deepEqual(card.options.map(o => [o.label, o.detail]), [['Merge now', 'the tests pass'], ['Wait', 'CI still runs']], name);
    assert.equal(workerMessageKind(body), 'ask', `${name}: the ask is routed as an ask`);
  }
});

test('every report line a brief asks for reads back with its label', () => {
  const native = workerBrief('native');
  const asked = new Set([...`${native}\n${CARD_RULE}\n${REPORT_NUDGE}`.matchAll(/`([A-Z]+): <[^>]+>`|`([A-Z]+):`/g)].map(m => m[1] ?? m[2]));
  assert.deepEqual([...asked].sort(), [...REPORT_LABELS].sort(), 'the native brief and its nudge name each report label');
  for (const label of REPORT_LABELS) {
    const r = readReport(`${label}: the sentence\n\n- a bullet`);
    assert.equal(r.label, label);
    assert.equal(r.line, 'the sentence');
    assert.equal(r.outcome, label === 'DONE' ? 'done' : label === 'FAILED' ? 'failed' : null);
  }
  assert.equal(workerMessageKind('NOTICE: CI runs now'), 'notice');
  assert.equal(workerMessageKind('DONE: merged'), 'notice');
  assert.equal(parseReport('', 'DONE: change 2 is in.\n\n- commit abc').result, 'change 2 is in.');
  assert.equal(readReport('Still looking.').label, null);
});

test('an ask with no options goes back, and the refusal names the two shapes that do get through', () => {
  assert.equal(workerMessageKind('STORY: 498\nQUESTION: Merge now?'), 'no-options');
  assert.match(NO_OPTIONS_REFUSAL, /OPTIONS line/);
  assert.match(NO_OPTIONS_REFUSAL, /`NOTICE:`/);
});
