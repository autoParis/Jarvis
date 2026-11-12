import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore, type SupportReply } from './store.ts';
import { makeCheck } from './check.ts';
import { checkLive, makeReplies, replyRoute, repliesBrief, ticketHold, LIVE_REPO, type Gh } from './replies.ts';
import { makeTicketWorker, parseRun, type SendResult } from './replyworker.ts';

const R = `repos/${LIVE_REPO}`;
const UUID = '11111111-2222-3333-4444-555555555555';
const MERGE = 'a'.repeat(40), PROD = 'b'.repeat(40), STAGING_TIP = 'c'.repeat(40);
const WORDS = 'Bonjour Marie,\n\nLe correctif est en production. Ça devrait fonctionner maintenant.\n\nOwner';
const VERCEL = { state: 'success', environment_url: 'https://acmeapp-nextjs-abc-exampleco.vercel.app', description: 'Deployment has completed' };
const MIGRATE = { state: 'success', environment_url: '', log_url: 'https://github.com/x/actions/runs/1/job/2' };
const STARTED = { state: 'in_progress', environment_url: '' };

/** A GitHub as read on 2026-11-05: story PR 4733 merged into staging and named by release PR 4768. */
function fakeGh(over: Record<string, unknown> = {}): Gh & { calls: string[] } {
  const routes: Record<string, unknown> = {
    [`${R}/pulls/4733`]: { number: 4733, state: 'closed', merged: true, merge_commit_sha: MERGE, base: { ref: 'staging' }, labels: [] },
    [`${R}/deployments?environment=production&ref=main&per_page=1`]: [{ id: 7531960351, ref: 'main', environment: 'production', sha: PROD }],
    [`${R}/deployments/7531960351/statuses?per_page=100`]: [VERCEL, MIGRATE, STARTED],
    [`${R}/compare/${MERGE}...${PROD}?per_page=1`]: { status: 'ahead' },
    [`${R}/pulls?state=closed&base=main&sort=updated&direction=desc&per_page=100`]: [
      { number: 4768, merged_at: '2026-11-03T22:10:01Z', head: { ref: 'staging' }, title: '🚀 main [#4671 #4733 #4773]', body: '', labels: [] },
    ],
    ...over,
  };
  const calls: string[] = [];
  const api = (async (path: string) => {
    calls.push(path);
    if (!(path in routes)) throw new Error(`fake gh: nothing at ${path}`);
    const v = routes[path];
    if (v instanceof Error) throw v;
    return v;
  }) as Gh & { calls: string[] };
  api.calls = calls;
  return api;
}

const openTicket = (over = {}) => ({
  reference: 'TICKET-1045', statut: 'En cours', resolu_le: null,
  fil: [
    { de: 'Marie Tanner', le: '2020-01-01T10:00:00Z', contenu: 'Ça ne marche pas' },
    { de: 'the owner (support Exampleco)', le: '2020-01-01T11:00:00Z', contenu: 'On regarde' },
  ],
  ...over,
});

function setup(o: { api?: Gh; ticket?: unknown; send?: () => Promise<SendResult>; paused?: boolean } = {}) {
  const store = openStore(':memory:');
  const wakes: string[] = [], sent: SupportReply[] = [], reads: SupportReply[] = [];
  const logs: string[] = [];
  const replies = makeReplies({
    store, log: m => logs.push(m), api: o.api ?? fakeGh(), paused: () => !!o.paused, wake: t => wakes.push(t),
    worker: {
      read: async r => { reads.push(r); if (o.ticket instanceof Error) throw o.ticket; return o.ticket ?? openTicket(); },
      send: async r => { sent.push(r); assert.equal(store.supportReply(r.id)!.status, 'sending', 'the attempt is on disk before the call'); return o.send ? o.send() : { status: 'sent', messageId: 'm1', sentAt: '2026-11-05T15:00:00Z', ticketStatus: 'En cours' }; },
    },
  });
  const row = store.addSupportReply({ reference: 'TICKET-1045', dealership: 'Dealer Six', dealership_id: UUID, text: WORDS, repo: LIVE_REPO, pr: 4733 });
  return { store, replies, wakes, sent, reads, row, get: () => store.supportReply(row.id)!, logs };
}

// ---- Is it live ----

test('a released story PR is live, through its merge commit', async () => {
  assert.deepEqual(await checkLive(fakeGh(), LIVE_REPO, 4733), { state: 'live', sha: PROD, releasePr: 4768, manualSteps: false });
});

test('only a deployment of main is read: a production record with ref staging is never asked for', async () => {
  const api = fakeGh();
  await checkLive(api, LIVE_REPO, 4733);
  assert.ok(api.calls.includes(`${R}/deployments?environment=production&ref=main&per_page=1`));
  assert.ok(!api.calls.some(c => c.includes('deployments?') && !c.includes('ref=main')));
  // A GitHub that ignored the filter and returned the DB migrate record is unreadable, not live.
  const wrong = fakeGh({ [`${R}/deployments?environment=production&ref=main&per_page=1`]: [{ id: 1, ref: 'staging', environment: 'production', sha: STAGING_TIP }] });
  await assert.rejects(checkLive(wrong, LIVE_REPO, 4733), /no production deployment of main/);
});

test('the migrate job\'s success is not enough: Vercel has to finish', async () => {
  const api = fakeGh({ [`${R}/deployments/7531960351/statuses?per_page=100`]: [MIGRATE, STARTED] });
  assert.deepEqual(await checkLive(api, LIVE_REPO, 4733), { state: 'waiting', why: 'the latest production deployment has no finished Vercel status' });
});

test('a failed or running latest deployment is not live, even with an older success on it', async () => {
  for (const state of ['error', 'failure', 'in_progress', 'inactive']) {
    const api = fakeGh({ [`${R}/deployments/7531960351/statuses?per_page=100`]: [{ state }, VERCEL] });
    assert.equal((await checkLive(api, LIVE_REPO, 4733)).state, 'waiting', state);
  }
  assert.equal((await checkLive(fakeGh({ [`${R}/deployments/7531960351/statuses?per_page=100`]: [] }), LIVE_REPO, 4733)).state, 'waiting');
});

test('a commit not in the production sha is not live', async () => {
  for (const status of ['behind', 'diverged']) {
    const api = fakeGh({ [`${R}/compare/${MERGE}...${PROD}?per_page=1`]: { status } });
    assert.equal((await checkLive(api, LIVE_REPO, 4733)).state, 'waiting', status);
  }
});

test('identical counts as in the commit', async () => {
  assert.equal((await checkLive(fakeGh({ [`${R}/compare/${MERGE}...${PROD}?per_page=1`]: { status: 'identical' } }), LIVE_REPO, 4733)).state, 'live');
});

test('an open PR waits and a PR closed without merging is held', async () => {
  assert.equal((await checkLive(fakeGh({ [`${R}/pulls/4733`]: { number: 4733, state: 'open', merged: false } }), LIVE_REPO, 4733)).state, 'waiting');
  assert.equal((await checkLive(fakeGh({ [`${R}/pulls/4733`]: { number: 4733, state: 'closed', merged: false } }), LIVE_REPO, 4733)).state, 'hold');
});

test('whatever cannot be read throws, so unknown never counts as live', async () => {
  const cases: Record<string, unknown>[] = [
    { [`${R}/pulls/4733`]: new Error('HTTP 502') },
    { [`${R}/pulls/4733`]: {} },
    { [`${R}/pulls/4733`]: { number: 4733, state: 'closed', merged: true, merge_commit_sha: null } },
    { [`${R}/deployments?environment=production&ref=main&per_page=1`]: [] },
    { [`${R}/deployments?environment=production&ref=main&per_page=1`]: { message: 'x' } },
    { [`${R}/deployments/7531960351/statuses?per_page=100`]: { message: 'x' } },
    { [`${R}/compare/${MERGE}...${PROD}?per_page=1`]: new Error('HTTP 404') },
    { [`${R}/compare/${MERGE}...${PROD}?per_page=1`]: {} },
    { [`${R}/pulls?state=closed&base=main&sort=updated&direction=desc&per_page=100`]: new Error('HTTP 500') },
    { [`${R}/pulls?state=closed&base=main&sort=updated&direction=desc&per_page=100`]: [] },
  ];
  for (const c of cases) await assert.rejects(checkLive(fakeGh(c), LIVE_REPO, 4733), Object.keys(c)[0]);
});

test('a number inside a longer number does not name the PR, and an unmerged release does not count', async () => {
  const list = `${R}/pulls?state=closed&base=main&sort=updated&direction=desc&per_page=100`;
  await assert.rejects(checkLive(fakeGh({ [list]: [{ number: 1, merged_at: 'x', head: { ref: 'staging' }, title: '🚀 main [#47331]', labels: [] }] }), LIVE_REPO, 4733), /no merged release/);
  await assert.rejects(checkLive(fakeGh({ [list]: [{ number: 1, merged_at: null, head: { ref: 'staging' }, title: '🚀 main [#4733]', labels: [] }] }), LIVE_REPO, 4733), /no merged release/);
});

test('the release is found in the body too, and its label is read', async () => {
  const list = `${R}/pulls?state=closed&base=main&sort=updated&direction=desc&per_page=100`;
  const live = await checkLive(fakeGh({ [list]: [{ number: 4599, merged_at: 'x', head: { ref: 'staging' }, title: '🚀 main', body: '| #4733 Fix |', labels: [{ name: 'manual-steps-needed' }] }] }), LIVE_REPO, 4733);
  assert.deepEqual(live, { state: 'live', sha: PROD, releasePr: 4599, manualSteps: true });
});

test('a PR merged straight into main is its own release', async () => {
  const live = await checkLive(fakeGh({ [`${R}/pulls/4733`]: { number: 4733, state: 'closed', merged: true, merge_commit_sha: MERGE, base: { ref: 'main' }, labels: [{ name: 'manual-steps-needed' }] } }), LIVE_REPO, 4733);
  assert.deepEqual(live, { state: 'live', sha: PROD, releasePr: 4733, manualSteps: true });
});

// ---- The ticket ----

test('an open ticket with no new customer message passes', () => {
  assert.equal(ticketHold(openTicket(), 'TICKET-1045', '2026-11-05 14:00:00'), undefined);
  for (const statut of ['Reçu', 'En cours', 'Received', 'In progress']) assert.equal(ticketHold(openTicket({ statut }), 'TICKET-1045', '2026-11-05 14:00:00'), undefined, statut);
});

test('a resolved or closed ticket holds, in either language', () => {
  for (const statut of ['Résolu', 'Fermé', 'Resolved', 'Closed']) assert.match(ticketHold(openTicket({ statut }), 'TICKET-1045', '2026-11-05 14:00:00')!, /already/, statut);
  assert.match(ticketHold(openTicket({ resolu_le: '2026-11-05T10:00:00Z' }), 'TICKET-1045', '2026-11-05 14:00:00')!, /already/);
});

test('a customer message after approval holds; ours and the system\'s do not', () => {
  const after = { le: '2026-11-05T14:00:01Z', contenu: 'x' };
  assert.match(ticketHold(openTicket({ fil: [{ de: 'Marie Tanner', ...after }] }), 'TICKET-1045', '2026-11-05 14:00:00')!, /customer wrote/);
  assert.match(ticketHold(openTicket({ fil: [{ de: 'Client', ...after }] }), 'TICKET-1045', '2026-11-05 14:00:00')!, /customer wrote/);
  assert.equal(ticketHold(openTicket({ fil: [{ de: 'Sam Lee (support Exampleco)', ...after }, { de: 'système', ...after }] }), 'TICKET-1045', '2026-11-05 14:00:00'), undefined);
});

test('a ticket read as something else is unreadable', () => {
  assert.throws(() => ticketHold(openTicket({ reference: 'TICKET-9' }), 'TICKET-1045', '2026-11-05 14:00:00'), /returned TICKET-9/);
  assert.throws(() => ticketHold(openTicket({ statut: 'Bizarre' }), 'TICKET-1045', '2026-11-05 14:00:00'), /do not know/);
  assert.throws(() => ticketHold(openTicket({ fil: undefined }), 'TICKET-1045', '2026-11-05 14:00:00'), /thread/);
  assert.throws(() => ticketHold(openTicket({ fil: [{ de: 'Marie', le: 'nope' }] }), 'TICKET-1045', '2026-11-05 14:00:00'), /time/);
  assert.throws(() => ticketHold(undefined, 'TICKET-1045', '2026-11-05 14:00:00'));
});

// ---- A tick ----

test('live and clear: the stored text goes out once, is recorded, and the owner hears one sentence', async () => {
  const s = setup();
  await s.replies.tick();
  assert.equal(s.sent.length, 1);
  assert.equal(s.sent[0].text, WORDS);
  const r = s.get();
  assert.equal(r.status, 'sent');
  assert.match(r.outcome!, /message m1/);
  assert.equal(r.release_pr, 4768);
  assert.equal(r.live_sha, PROD);
  assert.ok(r.attempted_at && r.finished_at);
  assert.equal(s.wakes.length, 1);
  assert.match(s.wakes[0], /^\[check\] Support reply, tell the owner in one sentence: TICKET-1045 for Dealer Six: the approved reply went out/);
  await s.replies.tick();
  assert.equal(s.sent.length, 1, 'the next tick sends nothing');
  assert.equal(s.wakes.length, 1, 'and says nothing');
});

test('not live yet: no ticket read, no send, no model call, nothing said', async () => {
  const s = setup({ api: fakeGh({ [`${R}/compare/${MERGE}...${PROD}?per_page=1`]: { status: 'diverged' } }) });
  await s.replies.tick();
  assert.equal(s.reads.length, 0);
  assert.equal(s.sent.length, 0);
  assert.deepEqual(s.wakes, []);
  assert.equal(s.get().status, 'waiting');
  assert.match(s.get().note!, /not in the production commit/);
});

test('it goes out on the tick after production catches up', async () => {
  let status = 'diverged';
  const live = fakeGh();
  const api: Gh = p => p.includes('/compare/') ? Promise.resolve({ status }) : live(p);
  const s = setup({ api });
  await s.replies.tick();
  assert.equal(s.sent.length, 0);
  status = 'ahead';
  await s.replies.tick();
  assert.equal(s.sent.length, 1);
});

test('the manual steps label holds it and tells the owner, and resume lets it go', async () => {
  const list = `${R}/pulls?state=closed&base=main&sort=updated&direction=desc&per_page=100`;
  const s = setup({ api: fakeGh({ [list]: [{ number: 4599, merged_at: 'x', head: { ref: 'staging' }, title: '#4733', labels: [{ name: 'manual-steps-needed' }] }] }) });
  await s.replies.tick();
  assert.equal(s.sent.length, 0);
  assert.equal(s.reads.length, 0);
  assert.equal(s.get().status, 'held');
  assert.equal(s.get().hold_kind, 'manual');
  assert.match(s.wakes[0], /on hold and nothing was sent, because release PR #4599 has the manual-steps-needed label/);
  await s.replies.tick();
  assert.equal(s.wakes.length, 1, 'told once');
  const done = replyRoute(s.store, () => {}, 'POST', `/api/internal/replies/${s.row.id}/resume`, {}, { fromOwner: () => true })!;
  assert.equal(done.status, 200);
  await s.replies.tick();
  assert.equal(s.sent.length, 1);
  assert.equal(s.get().status, 'sent');
});

test('a resolved ticket or a new customer message holds it, and resume is refused', async () => {
  const later = new Date(Date.now() + 60_000).toISOString();
  for (const ticket of [openTicket({ statut: 'Résolu' }), openTicket({ fil: [{ de: 'Marie', le: later }] })]) {
    const s = setup({ ticket });
    await s.replies.tick();
    assert.equal(s.sent.length, 0);
    assert.equal(s.get().status, 'held');
    assert.equal(s.get().hold_kind, 'ticket');
    assert.equal(s.wakes.length, 1);
    assert.equal(replyRoute(s.store, () => {}, 'POST', `/api/internal/replies/${s.row.id}/resume`, {}, { fromOwner: () => true })!.status, 409);
  }
});

test('a PR closed without merging holds it', async () => {
  const s = setup({ api: fakeGh({ [`${R}/pulls/4733`]: { number: 4733, state: 'closed', merged: false } }) });
  await s.replies.tick();
  assert.equal(s.get().hold_kind, 'pr');
  assert.equal(s.sent.length, 0);
});

test('GitHub unreadable: nothing is sent, the owner hears it once, and the next good tick sends', async () => {
  let down = true;
  const live = fakeGh();
  const api: Gh = p => down ? Promise.reject(new Error('gh api: HTTP 502')) : live(p);
  const s = setup({ api });
  await s.replies.tick();
  await s.replies.tick();
  assert.equal(s.sent.length, 0);
  assert.equal(s.get().status, 'waiting');
  assert.equal(s.wakes.length, 1);
  assert.match(s.wakes[0], /could not read the state: gh api: HTTP 502/);
  down = false;
  await s.replies.tick();
  assert.equal(s.sent.length, 1);
  assert.equal(s.get().problem, null);
});

test('the ticket unreadable: nothing is sent and the owner hears it', async () => {
  const s = setup({ ticket: new Error('the read worker returned no ticket') });
  await s.replies.tick();
  assert.equal(s.sent.length, 0);
  assert.equal(s.get().status, 'waiting');
  assert.match(s.wakes[0], /could not read the state: the read worker returned no ticket/);
});

test('an unknown send is never sent again, by a tick or by resume', async () => {
  const s = setup({ send: async () => ({ status: 'unknown', why: 'the call ran and its answer was lost' }) });
  await s.replies.tick();
  assert.equal(s.get().status, 'unknown');
  assert.match(s.wakes[0], /I do not know whether the reply went out.*I will not send it again/);
  await s.replies.tick();
  assert.equal(s.sent.length, 1);
  assert.equal(replyRoute(s.store, () => {}, 'POST', `/api/internal/replies/${s.row.id}/resume`, {}, { fromOwner: () => true })!.status, 409);
  assert.throws(() => s.store.setSupportReply(s.row.id, { status: 'waiting' }), /never goes out again/);
  assert.equal(s.store.claimSupportSend(s.row.id), false);
});

test('a sender that throws counts as unknown', async () => {
  const s = setup({ send: async () => { throw new Error('boom'); } });
  await s.replies.tick();
  assert.equal(s.get().status, 'unknown');
});

test('a failed send stays failed until the owner says, then goes through again', async () => {
  let result: SendResult = { status: 'failed', why: 'the send worker did not get the call through, so nothing went out' };
  const s = setup({ send: async () => result });
  await s.replies.tick();
  await s.replies.tick();
  assert.equal(s.sent.length, 1, 'no retry on its own');
  assert.equal(s.get().status, 'failed');
  result = { status: 'sent', messageId: 'm2' };
  assert.equal(replyRoute(s.store, () => {}, 'POST', `/api/internal/replies/${s.row.id}/resume`, {}, { fromOwner: () => true })!.status, 200);
  await s.replies.tick();
  assert.equal(s.get().status, 'sent');
});

test('a restart during a send makes it unknown, and it survives the restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'replies-'));
  const db = join(dir, 'jarvis.db');
  const first = openStore(db);
  const row = first.addSupportReply({ reference: 'TICKET-1045', dealership: 'Dealer Six', dealership_id: UUID, text: WORDS, repo: LIVE_REPO, pr: 4733 });
  assert.equal(first.claimSupportSend(row.id), true);
  first.db.close();
  const store = openStore(db);
  assert.equal(store.supportReply(row.id)!.text, WORDS);
  const wakes: string[] = [];
  let sends = 0;
  const replies = makeReplies({ store, log: () => {}, api: fakeGh(), paused: () => false, wake: t => wakes.push(t), worker: { read: async () => openTicket(), send: async () => { sends++; return { status: 'sent', messageId: 'x' }; } } });
  replies.recover();
  await replies.tick();
  assert.equal(sends, 0);
  assert.equal(store.supportReply(row.id)!.status, 'unknown');
  assert.match(wakes[0], /jarvisd restarted during the send/);
});

test('a waiting reply survives a restart too', () => {
  const db = join(mkdtempSync(join(tmpdir(), 'replies-')), 'jarvis.db');
  const first = openStore(db);
  first.addSupportReply({ reference: 'TICKET-7', dealership: 'D', dealership_id: UUID, text: 'x', repo: LIVE_REPO, pr: 1 });
  first.db.close();
  assert.equal(openStore(db).openSupportReplies()[0].reference, 'TICKET-7');
});

test('the kill switch stops the step, and what is owed is told after', async () => {
  let paused = true;
  const store = openStore(':memory:');
  const wakes: string[] = [];
  let sends = 0;
  store.addSupportReply({ reference: 'TICKET-1045', dealership: 'D', dealership_id: UUID, text: 'x', repo: LIVE_REPO, pr: 4733 });
  const replies = makeReplies({ store, log: () => {}, api: fakeGh(), paused: () => paused, wake: t => wakes.push(t), worker: { read: async () => openTicket(), send: async () => { sends++; return { status: 'sent', messageId: 'x' }; } } });
  await replies.tick();
  assert.equal(sends, 0);
  paused = false;
  await replies.tick();
  assert.equal(sends, 1);
  assert.equal(wakes.length, 1);
});

test('the text cannot be changed, and a ticket has one open reply', () => {
  const s = setup();
  assert.throws(() => s.store.db.prepare('UPDATE support_replies SET text = ? WHERE id = ?').run('other', s.row.id), /approved words do not change/);
  assert.throws(() => s.store.addSupportReply({ reference: 'TICKET-1045', dealership: 'D', dealership_id: UUID, text: 'other', repo: LIVE_REPO, pr: 1 }), /UNIQUE/);
});

test('the check runs the step inside its hours, and not outside them', async () => {
  const run = async (now: string) => {
    let ticks = 0;
    const check = makeCheck({ store: openStore(':memory:'), log: () => {}, now: () => Date.parse(now), paused: () => false, replies: async () => { ticks++; },
      poll: async () => ({ at: '', rows: [] }), requests: { synced: async () => {}, closing: () => false }, delivery: async () => ({ master: 'a', unmerged: [] }), running: 'a', brainBusy: () => false, wake: () => {} });
    await check.tick();
    return ticks;
  };
  assert.equal(await run('2026-11-05T15:00:00Z'), 1); // 10 AM Eastern
  assert.equal(await run('2026-11-05T23:00:00Z'), 0); // 6 PM Eastern
});

test('the brief shows open replies as lines and tells the brain not to send them', () => {
  const s = setup();
  assert.equal(repliesBrief([]), '');
  const brief = repliesBrief(s.store.openSupportReplies());
  assert.match(brief, /never send one yourself/);
  assert.match(brief, /- \[reply \d+\] waiting TICKET-1045 for Dealer Six, PR #4733, approved /);
  s.store.setSupportReply(s.row.id, { status: 'held', hold_kind: 'manual', outcome: 'release PR #4599 has the label' });
  assert.match(repliesBrief(s.store.openSupportReplies()), /held TICKET-1045.*: release PR #4599 has the label/);
  s.store.setSupportReply(s.row.id, { status: 'dropped' });
  assert.equal(repliesBrief(s.store.openSupportReplies()), '');
});

// ---- The worker. Streams shaped like the real runs against AcmeApp staging on 2026-11-05 ----

const TOOL = 'mcp__acmeapp-prod__support_ticket_reply';
const GET = 'mcp__acmeapp-prod__support_ticket_get';
const init = JSON.stringify({ type: 'system', subtype: 'init', mcp_servers: [{ name: 'acmeapp-prod', status: 'connected' }] });
const use = (name: string, input: unknown, id = 'toolu_1') => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
const result = (content: unknown, is_error?: boolean, id = 'toolu_1') => JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content, tool_use_id: id, ...(is_error ? { is_error } : {}) }] } });
const end = (denials: unknown[] = []) => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Sent! Everything went fine.', permission_denials: denials });
const INPUT = { reference: 'TICKET-1045', dealership_id: UUID, content: WORDS };
const ROW = { id: 1, reference: 'TICKET-1045', dealership_id: UUID, text: WORDS };
const worker = (stream: string) => {
  const seen: { args: string[]; prompt: string }[] = [];
  const w = makeTicketWorker({ dataDir: mkdtempSync(join(tmpdir(), 'replyworker-')), exec: async (args, prompt) => { seen.push({ args, prompt }); return stream; } });
  return { w, seen };
};

test('sent needs ok, the reference and a message id from the tool itself', async () => {
  const ok = JSON.stringify({ ok: true, reference: 'TICKET-1045', message_id: 'abc', envoye_le: '2026-11-05T15:00:00Z', statut: 'En cours' });
  assert.deepEqual(await worker([init, use(TOOL, INPUT), result(ok), end()].join('\n')).w.send(ROW), { status: 'sent', messageId: 'abc', sentAt: '2026-11-05T15:00:00Z', ticketStatus: 'En cours' });
  assert.equal((await worker([use(TOOL, INPUT), result([{ type: 'text', text: ok }]), end()].join('\n')).w.send(ROW)).status, 'sent');
});

test('the model saying it worked counts for nothing', async () => {
  assert.equal((await worker([init, end()].join('\n')).w.send(ROW)).status, 'failed');
});

test('a guard refusal or a permission denial is failed, since nothing reached the tool', async () => {
  const guard = result(`PreToolUse:${TOOL} hook error: REPLY_GUARD_REFUSED content differs from the stored one`, true);
  const denied = result(`Permission to use ${TOOL} has been denied because Claude Code is running in don't ask mode.`, true);
  for (const stream of [[use(TOOL, INPUT), guard, end([{ tool_use_id: 'toolu_1' }])], [use(TOOL, INPUT), denied, end([{ tool_use_id: 'toolu_1' }])], [use(TOOL, INPUT), guard, end()]])
    assert.equal((await worker(stream.join('\n')).w.send(ROW)).status, 'failed');
});

test('everything else that may have reached the tool is unknown', async () => {
  const cases: Record<string, string[]> = {
    'stream cut after the call': [init, use(TOOL, INPUT)],
    'stream cut before any call': [init],
    'empty output': [''],
    'no JSON answer': [use(TOOL, INPUT), result('oops'), end()],
    'a server error': [use(TOOL, INPUT), result(JSON.stringify({ error: true, message: 'support_ticket_reply: insert failed' })), end()],
    'an is_error answer': [use(TOOL, INPUT), result('{"ok":true,"reference":"TICKET-1045","message_id":"a"}', true), end()],
    'another reference': [use(TOOL, INPUT), result(JSON.stringify({ ok: true, reference: 'TICKET-9', message_id: 'a' })), end()],
    'no message id': [use(TOOL, INPUT), result(JSON.stringify({ ok: true, reference: 'TICKET-1045' })), end()],
    'other words ran': [use(TOOL, { ...INPUT, content: 'other' }), result(JSON.stringify({ ok: true, reference: 'TICKET-1045', message_id: 'a' })), end()],
    'two calls ran': [use(TOOL, INPUT), result('{}'), use(TOOL, INPUT, 'toolu_2'), result('{}', false, 'toolu_2'), end()],
    'answer lost': [use(TOOL, INPUT), end()],
  };
  for (const [name, lines] of Object.entries(cases)) assert.equal((await worker(lines.join('\n')).w.send(ROW)).status, 'unknown', name);
});

test('a worker that throws is unknown', async () => {
  const w = makeTicketWorker({ dataDir: mkdtempSync(join(tmpdir(), 'replyworker-')), exec: async () => { throw new Error('spawn failed'); } });
  assert.equal((await w.send(ROW)).status, 'unknown');
});

test('the sender has no allowlist entry: only the guard can let the call through', async () => {
  const { w, seen } = worker(end());
  await w.send(ROW);
  const { args, prompt } = seen[0];
  assert.ok(!args.includes('--allowedTools'));
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.equal(args[args.indexOf('--tools') + 1], '');
  assert.equal(args[args.indexOf('--setting-sources') + 1], '');
  assert.ok(args.includes('--strict-mcp-config'));
  assert.deepEqual(Object.keys(JSON.parse(args[args.indexOf('--mcp-config') + 1]).mcpServers), ['acmeapp-prod']);
  const hook = JSON.parse(args[args.indexOf('--settings') + 1]).hooks.PreToolUse[0];
  assert.equal(hook.matcher, TOOL);
  assert.match(hook.hooks[0].command, /reply-guard/);
  assert.ok(prompt.includes(JSON.stringify(INPUT)));
});

test('the reader has the read tool only, returns the tool\'s answer, and throws on anything else', async () => {
  const t = openTicket();
  const { w, seen } = worker([use(GET, { reference: 'TICKET-1045' }), result(JSON.stringify(t)), end()].join('\n'));
  assert.deepEqual(await w.read(ROW), t);
  const { args } = seen[0];
  assert.equal(args[args.indexOf('--allowedTools') + 1], GET);
  assert.ok(!args.join(' ').includes('support_ticket_reply'));
  await assert.rejects(worker(end()).w.read(ROW), /no ticket/);
  await assert.rejects(worker([use(GET, {}), result('nope'), end()].join('\n')).w.read(ROW), /no JSON/);
  await assert.rejects(worker([use(GET, {}), result(JSON.stringify({ error: true, message: 'Ticket introuvable.' })), end()].join('\n')).w.read(ROW), /introuvable/);
  await assert.rejects(worker([use(GET, {}), result('Permission to use x has been denied', true), end([{ tool_use_id: 'toolu_1' }])].join('\n')).w.read(ROW), /no ticket/);
});

test('parseRun ignores other tools and lines that are not JSON', () => {
  const p = parseRun(['garbage', use('mcp__x__other', {}), use(TOOL, INPUT, 'b'), result('{}', false, 'b'), end()].join('\n'), TOOL);
  assert.equal(p.ran.length, 1);
  assert.equal(p.complete, true);
});

// ---- The guard, the real script ----

const GUARD = fileURLToPath(new URL('../bin/reply-guard', import.meta.url));
function guard(spec: unknown, event: unknown) {
  const dir = mkdtempSync(join(tmpdir(), 'guard-'));
  const file = join(dir, 'spec.json');
  const claim = join(dir, 'claim');
  writeFileSync(file, typeof spec === 'string' ? spec : JSON.stringify({ ...(spec as object), claim }));
  const run = (ev = event) => {
    const r = spawnSync(process.execPath, [GUARD, file], { input: typeof ev === 'string' ? ev : JSON.stringify(ev), encoding: 'utf8' });
    assert.equal(r.status, 0);
    return JSON.parse(r.stdout).hookSpecificOutput as { permissionDecision: string; permissionDecisionReason: string };
  };
  return { run, claim };
}
const SPEC = { tool: TOOL, input: INPUT };
const EVENT = { hook_event_name: 'PreToolUse', tool_name: TOOL, tool_input: INPUT };

test('the guard allows the exact call once, and refuses the second', () => {
  const g = guard(SPEC, EVENT);
  assert.equal(g.run().permissionDecision, 'allow');
  assert.ok(existsSync(g.claim));
  const second = g.run();
  assert.equal(second.permissionDecision, 'deny');
  assert.match(second.permissionDecisionReason, /REPLY_GUARD_REFUSED this reply already had its one call/);
});

test('the guard denies other words, another ticket, an extra argument, another tool and bad input, and claims nothing', () => {
  const bad: unknown[] = [
    { ...EVENT, tool_input: { ...INPUT, content: `${WORDS} ` } },
    { ...EVENT, tool_input: { ...INPUT, reference: 'TICKET-1' } },
    { ...EVENT, tool_input: { ...INPUT, dealership_id: 'x' } },
    { ...EVENT, tool_input: { ...INPUT, status: 'resolu' } },
    { ...EVENT, tool_input: { reference: 'TICKET-1045', content: WORDS } },
    { ...EVENT, tool_name: 'mcp__acmeapp-prod__users_delete' },
    { ...EVENT, tool_input: undefined },
    'not json',
  ];
  for (const ev of bad) {
    const g = guard(SPEC, ev);
    const d = g.run();
    assert.equal(d.permissionDecision, 'deny', JSON.stringify(ev));
    assert.match(d.permissionDecisionReason, /REPLY_GUARD_REFUSED/);
    assert.ok(!existsSync(g.claim));
  }
  assert.equal(guard('not json', EVENT).run().permissionDecision, 'deny');
});

// ---- The route and the real CLI ----

const act = (url: string, ...args: string[]) => new Promise<{ code: number; out: string; err: string }>(resolve => {
  execFile(process.execPath, [fileURLToPath(new URL('../bin/jarvis-act', import.meta.url)), ...args], { env: { ...process.env, JARVIS_URL: url } }, (e, out, err) => resolve({ code: e ? (e.code as number) : 0, out, err }));
});
async function server(fromOwner = true) {
  const store = openStore(':memory:');
  const srv = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString();
    const r = replyRoute(store, () => {}, req.method!, req.url!, raw ? JSON.parse(raw) : {}, { fromOwner: () => fromOwner });
    res.writeHead(r?.status ?? 404);
    res.end(JSON.stringify(r?.body ?? {}));
  });
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(srv.address() as any).port}`;
  return { store, url, close: () => srv.close() };
}
const ADD = ['reply-add', '--ref', 'TICKET-1045', '--dealership', 'Dealer Six', '--dealership-id', UUID, '--repo', LIVE_REPO, '--pr', '4733', '--text', WORDS];
const without = (flag: string) => ADD.filter((a, i) => a !== flag && ADD[i - 1] !== flag);

test('jarvis-act adds, lists, drops; the exact text is stored', async () => {
  const s = await server();
  try {
    const added = await act(s.url, ...ADD);
    assert.equal(added.code, 0, added.err);
    const row = JSON.parse(added.out);
    assert.equal(row.status, 'waiting');
    assert.equal(s.store.supportReply(row.id)!.text, WORDS);
    const again = await act(s.url, ...ADD);
    assert.equal(JSON.parse(again.out).id, row.id, 'the same words again return the open row');
    assert.equal(JSON.parse((await act(s.url, 'reply-list')).out).length, 1);
    assert.equal((await act(s.url, 'reply-drop', String(row.id))).code, 0);
    assert.equal(JSON.parse((await act(s.url, 'reply-list')).out).length, 0);
    assert.equal((await act(s.url, ...ADD)).code, 0, 'a dropped reply can be added again');
  } finally { s.close(); }
});

test('jarvis-act refuses a reply with no PR number, and writes nothing', async () => {
  const s = await server();
  try {
    for (const args of [without('--pr'), [...without('--pr'), '--pr', 'abc'], [...without('--pr'), '--pr', '0']]) {
      const r = await act(s.url, ...args);
      assert.equal(r.code, 1);
      assert.match(r.err, /--pr is required/);
    }
    assert.equal(s.store.openSupportReplies().length, 0);
  } finally { s.close(); }
});

test('jarvis-act refuses bad fields, a second text on a ticket, and an unknown command shape', async () => {
  const s = await server();
  try {
    assert.match((await act(s.url, ...without('--ref'))).err, /--ref/);
    assert.match((await act(s.url, ...without('--dealership-id'))).err, /--dealership-id/);
    assert.match((await act(s.url, ...without('--text'))).err, /--text/);
    assert.match((await act(s.url, ...without('--repo'), '--repo', 'example-user/FB-marketplace-uploader')).err, /only repo/);
    await act(s.url, ...ADD);
    assert.match((await act(s.url, ...without('--text'), '--text', 'autre chose')).err, /already has a reply/);
    assert.equal((await act(s.url, 'reply-drop', 'x')).code, 2);
  } finally { s.close(); }
});

test('adding, resuming and dropping need the owner\'s message in the turn', async () => {
  const s = await server(false);
  try {
    const r = await act(s.url, ...ADD);
    assert.equal(r.code, 1);
    assert.match(r.err, /the owner's own message/);
    const row = s.store.addSupportReply({ reference: 'TICKET-1', dealership: 'D', dealership_id: UUID, text: 'x', repo: LIVE_REPO, pr: 1 });
    assert.match((await act(s.url, 'reply-drop', String(row.id))).err, /the owner's own message/);
    assert.equal(s.store.supportReply(row.id)!.status, 'waiting');
    assert.equal((await act(s.url, 'reply-list')).code, 0, 'reading needs nothing');
  } finally { s.close(); }
});
