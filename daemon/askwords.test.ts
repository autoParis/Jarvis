import test from 'node:test';
import assert from 'node:assert/strict';
import { askCodeWords, codeWords, codeWordsRefusal } from './workercontract.ts';

// Real worker asks from data/jarvis.db (items 840, 843 and 847, 2026-11-13), and a plain rewrite of each.
const ASK_5600 = `STORY: #5600 widget held-listing refusal reported as failure
WHERE: I proved the cause on production. No code is written yet. PR #5689 is a draft claim.
QUESTION: How should this PR handle a held refusal on a duplicate the search found?
CONTEXT: The server's guard refused correctly all 3 times, and nothing was lost. The widget files it as a bucket C failure, so it opens a P1 issue. PR #5073 predicted this and Pat left bucket C or A as a product decision. Separately, 12 queued rows on 7 accounts have a VIN that is already live on the same account under another vehicle, and the queue hands them out again and again (case 2 came back 5 times). Options 1 and 2 change the widget, so they need a new extension build and a Chrome check.
OPTIONS:
- Move to A, file queue fix because seller fixes it, no false P1
- Move to A, fix queue here because twins also stop coming back
- Close, no code because guard and widget work as designed`;

const PLAIN_5600 = `STORY: #5600 widget reports a refused duplicate as a bug
WHERE: I proved the cause on production. No code is written yet. PR #5689 is a draft.
QUESTION: Facebook refused a listing because the same car is already live. Should the widget tell the seller instead of opening an urgent issue?
CONTEXT: The refusal protected the account all 3 times, and nothing was lost. Today the widget reports it as a bug, so each one opens a P1 issue. PR #5073 left this choice to product. Also, 12 cars on 7 accounts have a VIN that is already live under another vehicle, and the queue offers them again and again. Options 1 and 2 need a new extension build and a Chrome check. https://github.com/Groupe-Beaucage/evalauto_nextjs/pull/5689
OPTIONS:
- Tell the seller, file queue fix because no false urgent issue, seller removes the old ad
- Tell the seller, fix queue here because the same cars stop coming back
- Close, no code because the refusal already protects the account`;

const ASK_5670 = `STORY: #5670 too few own photos warning
WHERE: The issue's proposal 3 says a model with one shared photo and few own photos attracts duplicates. It has no acceptance criterion.
QUESTION: Should this PR also raise or warn on min_photos.new, or should it go to a new issue?
CONTEXT: Desjardins Subaru has min_photos.new = 1, so one render can publish alone. The issue calls it a product decision. In the account's stock, 159 of 219 units carry a manufacturer or render photo (prod-sim, 2026-11-13).
OPTIONS:
- File a P3 issue because no criterion asks for it
- Warn the seller here because it widens this PR`;

const PLAIN_5670 = `STORY: #5670 too few own photos warning
WHERE: The issue says a car with one stock photo and few real photos gets flagged as a duplicate. No test in the issue asks for a fix.
QUESTION: Should this PR warn the seller when a new car has too few real photos, or should a new issue handle it?
CONTEXT: Desjardins Subaru lets a new car publish with only 1 photo, so one stock render can go live alone. In its stock, 159 of 219 cars have a manufacturer or render photo. Stock numbers R1831, R1832 and R1933 are examples. Le concessionnaire a été prévenu.
OPTIONS:
- File a P3 issue because no test in the issue asks for it
- Warn the seller here because it makes this PR bigger`;

const ASK_5646 = `STORY: #5646 seller scope for senior and junior salespeople
WHERE: The draft PR #5686 is open and the problem is proven. Types 5 and 6 will join the seller list.
QUESTION: Can "My leads" also become the default list for senior and junior salespeople?
CONTEXT: The seller list is shared. It also sets the default of the "My leads" toggle on the leads list (components/leads/MyLeadsToggle.tsx:20). The issue names only Marketplace. A user can still switch the toggle to all leads. Reach in production: 44 active type 5 and 21 active type 6 users. PR: https://github.com/Groupe-Beaucage/evalauto_nextjs/pull/5686
OPTIONS:
- Yes, shared list because one list, matches the issue's line 13
- No, Marketplace only because leads default stays as today, adds a second list`;

const PLAIN_5646 = `STORY: #5646 Marketplace access for senior and junior salespeople
WHERE: Draft PR #5686 is open. Senior and junior salespeople will get the Marketplace seller access.
QUESTION: When they open the leads page, should it also show only their own leads at first?
CONTEXT: The same seller setting picks what the "My leads" switch on the leads page shows at first. The issue names only Marketplace. A user can still switch to all leads. In production, 44 senior and 21 junior salespeople are active. PR: https://github.com/Groupe-Beaucage/evalauto_nextjs/pull/5686
OPTIONS:
- Yes, same setting because one setting, matches the issue
- No, Marketplace only because the leads page stays as today`;

test('the real asks with code words are found, and their plain rewrites pass', () => {
  assert.deepEqual(askCodeWords(ASK_5600), ['bucket C', 'to A']);
  assert.deepEqual(askCodeWords(ASK_5670), ['min_photos.new']);
  assert.deepEqual(askCodeWords(ASK_5646), ['components/leads/MyLeadsToggle.tsx:20']);
  for (const [name, plain] of [['5600', PLAIN_5600], ['5670', PLAIN_5670], ['5646', PLAIN_5646]]) assert.deepEqual(askCodeWords(plain), [], name);
});

test('each kind of code word is found', () => {
  assert.deepEqual(codeWords('the `duplicate_flagged` report'), ['`duplicate_flagged`']);
  assert.deepEqual(codeWords('it needs marketplace_settings:read and fb:publish.'), ['marketplace_settings:read', 'fb:publish']);
  assert.deepEqual(codeWords('see daemon/asks.ts and run.py, also config.ts:12'), ['daemon/asks.ts', 'run.py', 'config.ts:12']);
  assert.deepEqual(codeWords('in /Users/x/data or ~/notes, or app/leads/page'), ['/Users/x/data', '~/notes', 'app/leads/page']);
  assert.deepEqual(codeWords('the dealershipId and the stock_status column'), ['dealershipId', 'stock_status']);
  assert.deepEqual(codeWords('STATUS_ON_ORDER rows'), ['STATUS_ON_ORDER']);
  assert.deepEqual(codeWords('it calls class_doubt() first'), ['class_doubt']);
});

test('plain words, numbers, links and names pass', () => {
  for (const text of [
    'Le véhicule R1831 est « Démonstrateur », pas « En stock ». Ça arrive à Saint-Jérôme.',
    'A seller can see it. I checked the VIN 1HGCM82633A004352 and stock 5600-B.',
    'PR #5689 and issue #5073 are open: https://github.com/o/r/pull/5689?tab=files#diff-1_2',
    'It runs 24/7 at 10:30, km/h, P1 and P3, and on order/in transit.',
    'The iPhone app, Node.js and the macOS build, e.g. the Chrome check.',
    'Sold in DMS; status: Vendu, 159 of 219 units (2026-11-13).',
    'Is this a problem? Yes, and a dealer can fix it.',
    'The plan is in /Users/simonparis/Repos/jarvis/data/reports/4812-seller-template-design.md.',
  ]) assert.deepEqual(codeWords(text), [], text);
});

test('the refusal names the words found and asks for plain words', () => {
  const r = codeWordsRefusal(['bucket C', 'min_photos.new']);
  assert.match(r, /bucket C, min_photos\.new/);
  assert.match(r, /plain words/);
  assert.match(r, /dealer or the seller/);
});
