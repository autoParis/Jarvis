import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from './store.ts';
import { auditEntries, askCard } from './asks.ts';
import { makeRequests, requestDetail, DONE_KEEP_MS } from './requests.ts';
import { mergeWork, workListHtml, COMPLETED_KEEP_MS, requestDetailHtml, groupOf, groupOpen, doneLine, approvalTag, approvalDetail, approvalButtons, approvalOutcomeText } from '../web/worklist.js';
import { requestListHtml } from '../web/requestlist.js';

const NOW = Date.parse('2026-11-02T15:00:00Z');
const at = (min = 5) => new Date(NOW - min * 60_000).toISOString();
const row = (id: string, extra: object = {}) => ({ id, kind: 'worker', dispatch: id, title: `Row ${id}`, group: 'other', state: 'working', steer: 'auto', ...extra });
const req = (id: number, status: string, extra: object = {}) => ({ id, title: `Req ${id}`, words: null, status, at: at(), startedAt: at(60), ...extra });
const none: Record<string, string> = {};
const itemsOf = (m: any, g: string) => m.groups.find((x: any) => x.key === g).items;
const ctx = { shut: new Set<string>(), closedWaiting: new Set<string>(), folders: {}, now: NOW };

test('a request and its row are one item, with the request\'s title, status and age', () => {
  const m = mergeWork([row('a', { group: 'story' })], [req(1, 'working', { row: 'a', title: '#1 The ask' })], none);
  assert.equal(itemsOf(m, 'story').length, 1);
  const html = workListHtml(m, ctx);
  assert.match(html, /#1 The ask/);
  assert.doesNotMatch(html, /Row a/);
  assert.match(html, /data-complete data-request="1" data-row-id="a"/, 'the × moves both to Completed');
});

test('nothing in the work list hides a row any more: no Show hidden, no ↺', () => {
  const out = workListHtml(mergeWork([row('a'), row('b')], [], { b: at(1) }, NOW), { ...ctx, folders: { done: true } });
  assert.doesNotMatch(out, /data-unhide|showhidden|↺|hidden-row|Hide from this list/);
  const page = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(page, /hiddenCount|\/api\/work\/hide|\/api\/requests\/hide|type === 'hidden'/);
});

test('a working, waiting or failed request with no row still shows, in the group its title implies, with status and its ×', () => {
  const m = mergeWork([], [req(1, 'working', { title: '#4 Story' }), req(2, 'waiting', { title: 'Babysit PR #9' }), req(3, 'failed', { title: 'One-off' })], none);
  assert.equal(itemsOf(m, 'story')[0].req.id, 1);
  assert.equal(itemsOf(m, 'babysit')[0].req.id, 2);
  assert.equal(itemsOf(m, 'other')[0].req.id, 3);
  const html = workListHtml(m, ctx);
  for (const id of [1, 2, 3]) assert.match(html, new RegExp(`data-complete data-request="${id}"`));
  assert.match(html, /Working/);
  assert.match(html, /Waiting on you/);
  assert.match(html, /g-failed/);
  assert.match(html, /data-id="req:3"/, 'a row with no conversation still opens');
  assert.match(html, /Conversation closed\. Showing what Jarvis recorded\./);
  assert.match(html, /Conversation not listed right now/, 'a request still working is not called closed');
  assert.doesNotMatch(html, /no longer listed/);
});

test('two requests on one row: the first takes the row and the second keeps its own, which opens the same conversation', () => {
  const m = mergeWork([row('a')], [req(1, 'waiting', { row: 'a' }), req(2, 'working', { row: 'a' })], none);
  const list = itemsOf(m, 'other');
  assert.equal(list.length, 2);
  assert.equal(list[0].row.id, 'a');
  assert.equal(list[0].req.id, 1);
  assert.equal(list[1].row, undefined);
  assert.match(workListHtml(m, ctx), /data-id="a"[^]*data-id="a"/);
});

test('a moved row leaves its group for good, but an open request on it does not vanish', () => {
  const m = mergeWork([row('a')], [req(1, 'waiting', { row: 'a' })], { a: at(1) }, NOW);
  const [only] = itemsOf(m, 'other');
  assert.equal(only.row, undefined);
  assert.equal(only.req.id, 1);
  assert.equal(m.done.length, 0, 'the open request stands for the row, so the row is not in Completed twice');
});

test('a moved row with no request shows in Completed for a day from the press, then nowhere', () => {
  const rows = [row('a', { title: 'Babysit PR #12', state: 'idle' }), row('b')];
  const fresh = mergeWork(rows, [], { a: at(10) }, NOW);
  assert.deepEqual(itemsOf(fresh, 'other').map((i: any) => i.row.id), ['b'], 'a moved working row leaves its group too');
  assert.deepEqual(fresh.done.map((r: any) => [r.row, r.status, r.title]), [['a', 'done', 'Babysit PR #12']]);
  const html = workListHtml(fresh, { ...ctx, folders: { done: true } });
  assert.match(html, /Completed<span class="n">1<\/span>/);
  assert.match(html, /data-row="a"/, 'it still opens its conversation');
  assert.match(html, /class="hide" data-remove data-row-id="a" aria-label="Remove Babysit PR #12 from Completed"/);
  const later = mergeWork(rows, [], { a: at(24 * 60 + 1) }, NOW);
  assert.equal(later.done.length, 0, 'gone from Completed after a day');
  assert.deepEqual(itemsOf(later, 'other').map((i: any) => i.row.id), ['b'], 'and it does not come back in its group');
  assert.equal(COMPLETED_KEEP_MS, DONE_KEEP_MS, 'the same purge as a done request');
});

test('the × on a working row whose request waits for merge moves that request to Completed too', () => {
  const m = mergeWork([row('a', { state: 'working' })], [req(1, 'review', { row: 'a' })], none, NOW);
  assert.match(workListHtml(m, ctx), /data-complete data-request="1" data-row-id="a"/);
});

test('a finished request moves to its folder and takes an idle row with it; a row still active stays too', () => {
  const idle = mergeWork([row('a', { kind: 'session', state: 'idle' })], [req(1, 'review', { row: 'a' })], none);
  assert.equal(itemsOf(idle, 'other').length, 0);
  assert.deepEqual(idle.review.map((r: any) => r.id), [1]);
  const active = mergeWork([row('a', { kind: 'session', state: 'working' })], [req(1, 'done', { row: 'a' })], none);
  assert.equal(itemsOf(active, 'other').length, 1);
  assert.deepEqual(active.done.map((r: any) => r.id), [1]);
});

test('order within a group: waiting, failed, working, idle, exited', () => {
  const m = mergeWork([row('x', { state: 'exited' }), row('i', { state: 'idle' }), row('k'), row('w', { state: 'waiting' })], [req(1, 'failed')], none);
  assert.deepEqual(itemsOf(m, 'other').map((i: any) => i.row?.id ?? 'failed'), ['w', 'failed', 'k', 'i', 'x']);
});

test('groupOf reads the title as the work list classifies it', () => {
  assert.equal(groupOf('#4524 Keep the page'), 'story');
  assert.equal(groupOf('Fix #4524 again'), 'other');
  assert.equal(groupOf('#4524 Babysit the PR'), 'babysit');
});

test('a group that holds something waiting opens itself and says how many; a hand close lasts until nothing waits', () => {
  const shut = new Set(['other']), closedWaiting = new Set<string>();
  const waiting = { key: 'other', waiting: 1 }, quiet = { key: 'other', waiting: 0 };
  assert.equal(groupOpen(waiting, shut, closedWaiting), true);
  closedWaiting.add('other');
  assert.equal(groupOpen(waiting, shut, closedWaiting), false);
  assert.equal(groupOpen(quiet, shut, closedWaiting), false);
  assert.equal(closedWaiting.size, 0);
  assert.equal(groupOpen(waiting, shut, closedWaiting), true);
  assert.match(workListHtml(mergeWork([row('a', { state: 'waiting' })], [], none), ctx), /1 waiting/);
});

test('there is no Stories folder, and empty groups are not drawn', () => {
  const html = workListHtml(mergeWork([row('a', { group: 'story' })], [], none), ctx);
  assert.doesNotMatch(html, /data-folder="stories"/);
  assert.match(html, /data-group="story"/);
  assert.doesNotMatch(html, /data-group="side"/);
  assert.match(workListHtml(mergeWork([], [], none), ctx), /No work running/);
});

test('a Waiting for merge row starts with the story number, linked to the PR; without one, the PR number', () => {
  const url = 'https://github.com/o/r/pull/7';
  const html = requestListHtml([req(1, 'review', { title: 'Do #4612 now', pr: 'PR #7', url }), req(2, 'review', { title: 'Plain', pr: 'PR #8', url })], { review: true }, NOW);
  assert.match(html, /<a href="https:\/\/github.com\/o\/r\/pull\/7" class="num" target="_blank" rel="noopener">#4612<\/a>/);
  assert.match(html, />PR #8<\/a>/);
});

test('the × on a folder row names its conversation row too, or the row would come back in its group', () => {
  assert.match(requestListHtml([req(1, 'review', { row: 'a' })], { review: true }, NOW), /data-complete data-request="1" data-row-id="a"/, 'Waiting for merge moves to Completed');
  assert.match(requestListHtml([req(1, 'done', { row: 'a' })], { done: true }, NOW), /data-remove data-request="1" data-row-id="a"/, 'Completed removes now');
});

test('the done line counts what finished today and what waits for merge', () => {
  assert.equal(doneLine([req(1, 'done'), req(2, 'done'), req(3, 'review'), req(4, 'working')], NOW), '2 finished today · 1 waiting for merge');
  assert.equal(doneLine([req(1, 'done', { at: at(60 * 72) })], NOW), '');
});

test('an approval\'s tag comes from its action and arguments', () => {
  assert.equal(approvalTag('gmail-send', { to: 'teammate@x.test' }), 'Email to teammate@x.test');
  assert.equal(approvalTag('gmail-send', { to: 'teammate@x.test', cc: 'leo@x.test, max@x.test' }), 'Email to teammate@x.test, cc leo@x.test, max@x.test');
  assert.equal(approvalTag('worker-start', { taskTitle: '#4640 Alert' }), 'Story 4640');
  assert.equal(approvalTag('worker-start', { taskTitle: 'Alert' }), 'Start a worker');
  assert.equal(approvalTag('github-issue', {}), 'Github issue');
});

// ---- a background worker's permission prompt (daemon/native.ts stores it as an ordinary approval) ----
const PERM = { worker: 'deabc023', name: 'fix-dead-list-412', tool: 'Bash', input: { command: 'rm -rf /tmp/x' }, summary: 'rm -rf /tmp/x' };

test('a worker-permission card names the worker, shows the tool and its command, and reads Allow and Deny', () => {
  assert.equal(approvalTag('worker-permission', PERM), 'Permission: fix-dead-list-412');
  assert.equal(approvalTag('worker-permission', {}), 'Permission: a worker');
  assert.equal(approvalDetail(PERM), 'Bash: rm -rf /tmp/x');
  assert.equal(approvalDetail({ ...PERM, tool: 'Edit', summary: '/w/x/daemon/main.ts' }), 'Edit: /w/x/daemon/main.ts');
  assert.equal(approvalDetail({ runs: 'gh pr close 4' }), 'gh pr close 4', 'a named action still shows its command');
  assert.deepEqual(approvalButtons('worker-permission'), ['Allow', 'Deny']);
  assert.deepEqual(approvalButtons('worker-stop'), ['Approve', 'Reject']);
});

test('a decided worker-permission card says Allowed or Denied, never Approved', () => {
  const a = (status: string, result?: string) => ({ action: 'worker-permission', status, result });
  assert.equal(approvalOutcomeText(a('pending')), '');
  assert.equal(approvalOutcomeText(a('done', 'allowed')), 'Allowed');
  assert.equal(approvalOutcomeText(a('done', 'denied')), 'Denied');
  assert.equal(approvalOutcomeText(a('rejected')), 'Denied');
  assert.equal(approvalOutcomeText(a('failed', 'jarvisd restarted before the owner answered')), 'Not answered: jarvisd restarted before the owner answered');
  assert.equal(approvalOutcomeText({ action: 'worker-stop', status: 'done' }), 'Approved', 'other actions keep their words');
});

test('a native row renders like any other: a short Done note in the age column, Exited for a stopped one', () => {
  const native = (state: string, extra: object) => row('n:deabc023', { title: 'fix-dead-list-412', state, native: { id: 'deabc023', name: 'fix-dead-list-412', state }, ...extra });
  const idle = workListHtml(mergeWork([native('idle', { note: 'Done 5 min ago', steer: 'auto' })], [], none), ctx);
  assert.match(idle, /<span class="ago">Done 5 min ago<span class="sr"> Idle<\/span>/);
  assert.doesNotMatch(idle, /class="note"/, 'a note that fits the age column is not repeated under the row');
  const exited = workListHtml(mergeWork([native('exited', { steer: 'none' })], [], none), ctx);
  assert.match(exited, /class="wrow s-exited"[^>]*title="Exited"/);
  assert.match(exited, /g-stopped/);
  const blocked = workListHtml(mergeWork([native('waiting', { note: 'rm -rf /tmp/x', steer: 'auto' })], [], none), ctx);
  assert.match(blocked, /title="Waiting on you: rm -rf \/tmp\/x"/);
  assert.match(blocked, /1 waiting/);
});

test('the audit log has answered asks and decided approvals, newest first, and nothing else', () => {
  const store = openStore(':memory:');
  const add = (id: string, status: string, answer?: string) => { store.insertItem({ source: 'native', external_id: id, kind: 'question', subject: 'Q', body: `STORY: 1 x\nQUESTION: ${id}?`, options: JSON.stringify(['Yes']) }); store.markItem(id, status, answer); };
  add('answered', 'answered', 'Yes');
  add('closed', 'done');
  add('open', 'spoken');
  const decided = (action: string, status: string, by: string, result?: string) => {
    const a = store.addApproval({ action, args: JSON.stringify({ to: 'teammate@x.test' }), say: `Do ${action}?` });
    store.decide(a.id, 'approved', by);
    store.finishApproval(a.id, status, result ?? '');
    return a;
  };
  decided('gmail-send', 'failed', 'button', 'refused');
  decided('question', 'done', 'automatic');
  decided('side-chat', 'done', 'button');
  store.addApproval({ action: 'worker-stop', args: '{}', say: 'Pending?' });
  const list = auditEntries(store, i => askCard(i), new Set(['side-chat']));
  assert.deepEqual(list.map(x => x.question).sort(), ['Do gmail-send?', 'answered?']);
  const mail = list.find(x => x.kind === 'approval')!;
  assert.equal(mail.tag, 'Email to teammate@x.test');
  assert.match(mail.answer, /failed: refused/);
  assert.equal(mail.failed, true);
  assert.equal(list.find(x => x.kind === 'ask')!.answer, 'Yes');
});

test('a row with a conversation opens that conversation and shows no closed note', () => {
  const html = workListHtml(mergeWork([row('a')], [req(1, 'failed', { row: 'a' })], none), ctx);
  assert.match(html, /data-id="a"/);
  assert.doesNotMatch(html, /req:1|Conversation closed/);
});

test('a folder row with no conversation opens its record, and its × still removes it', () => {
  const html = requestListHtml([req(1, 'done')], { done: true }, NOW);
  assert.match(html, /data-row="req:1"/);
  assert.match(html, /Conversation closed/);
  assert.match(html, /data-remove data-request="1"/);
  assert.match(requestListHtml([req(2, 'done', { row: 'a' })], { done: true }, NOW), /data-row="a"/);
});

// ---- a request whose worker left the list ----
const DISPATCH = 'ctx_stopped';

test('a stopped worker Jarvis knows nothing more about still opens, with the record and no transcript', async () => {
  const store = openStore(':memory:');
  const reqs = makeRequests({ store, log: () => {}, repoOf: async () => undefined, onChange: () => {} });
  const a = store.addApproval({ action: 'worker-start', args: JSON.stringify({ taskTitle: 'Stopped one' }), say: 'Start?' });
  store.decide(a.id, 'approved', 'button');
  store.finishApproval(a.id, 'done', JSON.stringify({ dispatchId: DISPATCH }));
  store.addRequest({ dispatch_id: DISPATCH, approval_id: a.id, action: 'worker-start', title: 'Stopped one', words: 'Fix the link' });
  const id = store.requests()[0].id;
  await reqs.sync({ at: '', rows: [] });
  const read = (await reqs.read(id, undefined, new Map()))!;
  assert.equal(read.lines.length, 0);
  assert.equal(read.detail!.title, 'Stopped one');
  assert.equal(read.detail!.transcript, false);
  assert.match(requestDetailHtml(read.detail), /Its transcript was not found/);
  assert.equal(await reqs.read(9999, undefined, new Map()), undefined);
});

test('the record holds the request, its messages with answers, and stop events in Eastern time', () => {
  const store = openStore(':memory:');
  const a = store.addApproval({ action: 'worker-start', args: JSON.stringify({ taskTitle: 'T' }), say: 'Start?' });
  store.decide(a.id, 'approved', 'button');
  store.finishApproval(a.id, 'done', JSON.stringify({ dispatchId: DISPATCH }));
  const stop = store.addApproval({ action: 'worker-stop', args: JSON.stringify({ dispatch: DISPATCH }), say: 'Stop the <worker>?' });
  store.decide(stop.id, 'approved', 'button');
  store.finishApproval(stop.id, 'done', JSON.stringify({ dispatchId: DISPATCH, state: 'stopped' }));
  // Another worker's spec quotes this dispatch. That approval is not part of this history.
  const quote = store.addApproval({ action: 'worker-start', args: JSON.stringify({ spec: `see ${DISPATCH}` }), say: 'Other worker' });
  store.decide(quote.id, 'approved', 'button');
  store.finishApproval(quote.id, 'done', JSON.stringify({ dispatchId: 'ctx_other' }));
  store.addRequest({ dispatch_id: DISPATCH, approval_id: a.id, action: 'worker-start', title: 'Request: T', words: 'Fix it' });
  const id = store.requests()[0].id;
  const put = (external_id: string, kind: string, f: object) => store.insertItem({ source: 'native', external_id, kind, dispatch_id: DISPATCH, ...f } as any);
  put('msg_q', 'question', { subject: 'Question', body: 'STORY: 1 x\nQUESTION: Read prod?\nCONTEXT: Needed.', options: '["Yes"]' });
  store.markItem('msg_q', 'answered', 'Yes');
  put('msg_e1', 'escalation', { subject: 'Blocked', body: 'Draft PR at https://github.com/o/r/pull/4667 is up.' });
  put('msg_done', 'worker_done', { subject: 'Finished', body: 'All done', meta: JSON.stringify({ outcome: 'failed' }) });
  store.db.prepare(`UPDATE requests SET status = 'failed', status_at = '2026-11-02 20:48:26', worktree = 'cockle' WHERE id = ?`).run(id);
  store.db.prepare(`UPDATE approvals SET decided_at = '2026-11-02 20:48:08' WHERE id = ?`).run(stop.id);
  const log = `2026-11-02T20:13:52.755Z request status {"dispatch":"${DISPATCH}","from":"working","to":"waiting"}\n2026-11-02T20:48:26.779Z request status {"dispatch":"${DISPATCH}","from":"working","to":"failed"}\n2026-11-02T20:48:27.000Z request status {"dispatch":"ctx_other","from":"working","to":"failed"}\nnot json\n`;
  const d = requestDetail(store, id, log)!;
  assert.equal(d.title, 'T');
  assert.equal(d.pr, 'PR #4667');
  assert.equal(d.url, 'https://github.com/o/r/pull/4667');
  assert.equal(d.history.filter(h => h.title.startsWith('Status')).length, 1, 'only the closing status, and only this worker');
  assert.ok(!d.history.some(h => h.text === 'Other worker'));
  assert.equal(d.history.find(h => h.kind === 'question')!.answer, 'Yes');
  assert.match(d.history.find(h => h.kind === 'question')!.text!, /Read prod\?\n\nNeeded\./);
  assert.match(d.history.find(h => h.title === 'Blocked')!.text!, /Draft PR/);
  assert.equal(d.history.find(h => h.kind === 'worker_done')!.failed, true);
  const html = requestDetailHtml({ ...d, transcript: true });
  assert.match(html, /Failed, 11-02 3:48 p\.m\./, 'Eastern time');
  assert.match(html, /Worktree/);
  assert.match(html, /Worker stop: done by button/);
  assert.match(html, /Stop the &lt;worker&gt;\?/, 'text is escaped');
  assert.doesNotMatch(html, /<button|<textarea|<input/, 'read-only');
  assert.doesNotMatch(html, /transcript was not found/);
});

test('every web file is in the STATIC map, since the daemon serves nothing else', () => {
  const main = readFileSync(new URL('./webfiles.ts', import.meta.url), 'utf8');
  const map = /const STATIC[^=]*= (\{[^}]*\})/.exec(main)![1];
  for (const f of readdirSync(new URL('../web/', import.meta.url))) assert.ok(map.includes(`'${f}'`), `${f} is not in STATIC`);
});

test('a worker with no request that reported DONE goes to Completed once stopped or idle; a FAILED one stays in its group', () => {
  // side-chat-new-in-evalauto-nextjs-524 (2026-11-11): a side chat has no request. It reported DONE, was stopped, and sat
  // in Other under a "Done (1)" fold instead of in Completed.
  const done = (state: string, extra: object = {}) => ({ state, endedAt: at(30), native: { id: 'x', state: 'stopped', outcome: 'done' }, ...extra });
  const rows = [
    row('n:stopped', done('exited', { title: 'side-chat-new-in-evalauto-nextjs-524' })),
    row('n:idle', done('idle')),
    row('n:busy', done('working', { endedAt: undefined })),
    row('n:asks', done('waiting', { endedAt: undefined })),
    row('n:failed', { state: 'exited', endedAt: at(30), native: { id: 'f', state: 'failed', outcome: 'failed' } }),
    row('n:stopped-early', { state: 'exited', endedAt: at(30), native: { id: 's', state: 'stopped', outcome: null } }),
    row('n:old-done', done('idle', { endedAt: at(300) })),
  ];
  const m = mergeWork(rows, [req(9, 'done', { row: 'other-row' })], none);
  assert.deepEqual(m.done.map((d: any) => String(d.id ?? d.row)).sort(), ['9', 'n:idle', 'n:old-done', 'n:stopped']);
  assert.deepEqual(itemsOf(m, 'other').map((i: any) => i.row.id).sort(), ['n:asks', 'n:busy', 'n:failed', 'n:stopped-early']);
  assert.equal(m.groups.find((g: any) => g.key === 'other').old, undefined, 'there is no Done fold any more');

  const html = workListHtml(m, { ...ctx, folders: { done: true } });
  assert.doesNotMatch(html, /Done \(/);
  assert.match(html, /Completed<span class="n">4<\/span>/);
  const entry = /<div class="rrow done" data-row="n:stopped"[^]*?<\/div><\/div>|<div class="rrow done" data-row="n:stopped"[^]*?×<\/button>/.exec(html)?.[0] ?? '';
  assert.match(entry, /side-chat-new-in-evalauto-nextjs-524/, 'it opens its chat from Completed');
  assert.match(entry, /data-remove data-row-id="n:stopped"/, 'its × removes it from Completed now');
  assert.doesNotMatch(entry, /data-request=/, 'no request, only the row');
});

test('a worker with no request is in Completed once, and one removed from Completed is not there', () => {
  const r = row('n:a', { state: 'idle', endedAt: at(10), native: { id: 'a', state: 'done', outcome: 'done' } });
  assert.equal(mergeWork([r], [], none).done.length, 1);
  assert.equal(mergeWork([r], [req(1, 'done', { row: 'n:a' })], none).done.length, 1, 'its request is the entry');
  assert.equal(mergeWork([r], [], { 'n:a': at(1) }, NOW).done.length, 1, 'moved with × it is still one entry');
  assert.equal(mergeWork([r], [], { 'n:a': new Date(0).toISOString() }, NOW).done.length, 0, 'removed from Completed');
  assert.equal(mergeWork([r], [req(1, 'working', { row: 'n:a' })], none).done.length, 0, 'an open request keeps it in its group');
});

test('a blocked row says its reason under its title, and every row with a status names it', async () => {
  const { mergeWork, workListHtml } = await import('../web/worklist.js');
  const rows = [
    { id: 'n:a', kind: 'worker', title: 'story-501', group: 'other', state: 'waiting', status: { name: 'blocked', reason: 'login' }, note: 'Blocked: login', steer: 'auto' },
    { id: 'n:b', kind: 'worker', title: 'story-502', group: 'other', state: 'working', status: { name: 'working' }, steer: 'auto' },
    { id: 't:ev-1', kind: 'session', title: 'Terminal in Jarvis', group: 'terminal', state: 'idle', status: { name: 'idle' }, note: 'ev-1', steer: 'none', tmux: { name: 'ev-1', project: 'jarvis', kind: 'terminal', cwd: '/r', branch: 'm' } },
  ];
  const html = workListHtml(mergeWork(rows, []), { shut: new Set(), closedWaiting: new Set(), folders: {}, now: Date.now() });
  assert.match(html, /<div class="wrow s-waiting st-blocked"[^>]*title="Blocked: login[^"]*">.*?<div class="note blocked">Blocked: login<\/div>/s);
  assert.match(html, /st-working"[^>]*title="Working"/);
  assert.match(html, /title="Running in tmux session ev-1 · Idle"/);
});
