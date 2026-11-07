import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fakeTool, fakeOrca } from './fakeorca.ts';

// Stand-ins on PATH, set before gate.ts copies the environment. The stand-in node records the folder it ran in.
const REAL_NODE = process.execPath;
const gh = fakeTool('gh');
const node = fakeTool('node');
const orca = fakeOrca();
const { openStore } = await import('./store.ts');
const { makeGate, BUTTON_ONLY, buildCommand } = await import('./gate.ts');
const { FBM_REPO, namedActionIn, refusedByPermissionLayer } = await import('./namedactions.ts');
const { askCard, answerAsk, NAMED_ACTION } = await import('./asks.ts');
const { approvalDetail, approvalOutcomeText, approvalTag } = await import('../web/worklist.js');
const id = { run: 'run_x', handle: 'term_x' };

const CLOSE = { repo: 'example-org/acmeapp_nextjs', number: 4667, comment: "Closed as superseded by #4733, the owner's decision." };
const PAUSE = { client: 'dealereleven', hours: 720 };
const closed = (comment = CLOSE.comment) => JSON.stringify({ state: 'CLOSED', url: 'https://github.com/x/y/pull/4667', comments: [{ body: 'older' }, { body: comment }] });
const later = (hours: number) => new Date(Date.now() + hours * 3_600_000 + 5_000).toISOString();
const state = (fields: object) => JSON.stringify({ found: true, name: 'Dealer Eleven', enabled: true, ...fields });

async function approve(action: string, args: any) {
  const gate = makeGate(openStore(':memory:'), id, () => {});
  const p = await gate.propose(action, args, 'Do it?');
  return { p, a: await gate.button(p.id, true) };
}

test('gh-pr-close runs on Approve, and the card shows the exact command', async () => {
  gh.answers('closed', closed());
  const before = gh.calls().length;
  const { p, a } = await approve('gh-pr-close', CLOSE);
  const args = JSON.parse(p.args);
  assert.equal(approvalDetail(args), `gh pr close 4667 --repo example-org/acmeapp_nextjs --comment 'Closed as superseded by #4733, the owner'\\''s decision.'\n\nThen reads the PR back: its state and this comment.`);
  assert.equal(approvalTag('gh-pr-close', args), 'Close PR 4667');
  assert.equal(a.status, 'done');
  assert.match(a.result!, /^Verified: PR 4667 is closed and your comment is on it/);
  assert.equal(approvalOutcomeText(a), `Approved. ${a.result}`);
  const calls = gh.calls().slice(before);
  assert.match(calls[0], /^pr close 4667 --repo example-org\/acmeapp_nextjs --comment Closed as superseded/);
  assert.match(calls[1], /pr view 4667 --repo example-org\/acmeapp_nextjs --json state,url,comments/);
});

test('the close result comes from the read-back, not the exit code', async () => {
  gh.answers('ok', JSON.stringify({ state: 'OPEN', comments: [] }));
  const open = (await approve('gh-pr-close', CLOSE)).a;
  assert.equal(open.status, 'failed');
  assert.match(open.result!, /Not closed: PR 4667 reads OPEN/);

  gh.answers('ok', JSON.stringify({ state: 'MERGED', comments: [] }));
  assert.match((await approve('gh-pr-close', CLOSE)).a.result!, /reads MERGED/);

  gh.answers('already closed', closed('someone else wrote this'));
  const silent = (await approve('gh-pr-close', CLOSE)).a;
  assert.equal(silent.status, 'failed', 'gh exits 0 on a closed PR and posts nothing');
  assert.match(silent.result!, /your comment is not on it/);

  gh.answers('EXIT1:network down', closed());
  assert.equal((await approve('gh-pr-close', CLOSE)).a.status, 'done', 'the error came after the close landed');

  gh.answers('ok', 'EXIT1:no answer');
  const lost = (await approve('gh-pr-close', CLOSE)).a;
  assert.equal(lost.status, 'unknown');
  assert.match(approvalOutcomeText(lost), /^Approved, outcome unknown: Could not read PR 4667 back/);
});

test('fbm-client-pause runs only the pause script from the FBM repo, then reads the client back', async () => {
  const before = node.calls().length;
  node.answers('paused', state({ pauseUntil: later(720) }));
  const { p, a } = await approve('fbm-client-pause', PAUSE);
  assert.equal(approvalDetail(JSON.parse(p.args)), `cd ${FBM_REPO}\nnode functions/scripts/reusable/pause-client.js --client dealereleven --hours 720\n\nThen reads back _fbMarketplace.pauseUntil and enabled.`);
  assert.equal(a.status, 'done');
  assert.match(a.result!, /^Verified: dealereleven \(Dealer Eleven\) is paused until .* Eastern, and enabled is still true\.$/);
  const calls = node.calls().slice(before);
  assert.equal(calls[0], `${FBM_REPO} functions/scripts/reusable/pause-client.js --client dealereleven --hours 720`);
  assert.match(calls[1], new RegExp(`^${FBM_REPO} \\S+/bin/fbm-client-state\\.cjs --client dealereleven$`));
  assert.equal(calls.length, 2);
});

test('the pause result comes from the read-back: too short, disabled, unknown client, lost read', async () => {
  node.answers('paused', state({ pauseUntil: later(2) }));
  const short = (await approve('fbm-client-pause', PAUSE)).a;
  assert.equal(short.status, 'failed');
  assert.match(short.result!, /Not paused: .*short of the 720 hours/);

  node.answers('paused', state({ pauseUntil: later(720), enabled: false }));
  const off = (await approve('fbm-client-pause', PAUSE)).a;
  assert.equal(off.status, 'failed');
  assert.match(off.result!, /enabled reads false/);

  node.answers('EXIT1:✗ dealereleven: client doc not found', JSON.stringify({ found: false }));
  const gone = (await approve('fbm-client-pause', PAUSE)).a;
  assert.equal(gone.status, 'failed');
  assert.match(gone.result!, /No client dealereleven.*client doc not found/);

  node.answers('paused', state({ pauseUntil: later(1000) }));
  assert.match((await approve('fbm-client-pause', PAUSE)).a.result!, /A longer pause was already in place/);

  node.answers('paused', JSON.stringify({ error: 'read failed' }));
  assert.equal((await approve('fbm-client-pause', PAUSE)).a.status, 'unknown');
});

test('a failed pause never copies a credential from the script\'s output into the record', async () => {
  const leak = 'SyntaxError: Unexpected token in "private_key": "-----BEGIN PRIVATE KEY-----abc"';
  node.answers(`EXIT1:${leak}`, JSON.stringify({ error: 'read failed' }));
  const lines: string[] = [];
  const gate = makeGate(openStore(':memory:'), id, () => {}, (m, f) => lines.push(`${m} ${JSON.stringify(f)}`));
  const a = await gate.button((await gate.propose('fbm-client-pause', PAUSE, 'Pause?')).id, true);
  assert.equal(a.status, 'unknown');
  for (const text of [a.result!, lines.join('\n')]) assert.doesNotMatch(text, /PRIVATE KEY|private_key|abc/);
});

test('the read-back script prints its few fields and nothing else from the document, against a stand-in Firestore', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-fbm-'));
  mkdirSync(join(dir, 'functions/scripts/lib'), { recursive: true });
  writeFileSync(join(dir, 'functions/scripts/lib/firestore-init.js'), `
    const docs = { real: { name: 'Real', enabled: true, password: 'hunter2', _fbMarketplace: { pauseUntil: { toDate: () => new Date('2026-12-04T22:10:35Z') }, cookies: 'secret' } } };
    module.exports = { db: { collection: c => ({ doc: id => ({ get: async () => { if (id === 'boom') throw new Error('private_key leak'); return { exists: c === 'client' && id in docs, data: () => docs[id] }; } }) }) } };`);
  const script = join(import.meta.dirname, '../bin/fbm-client-state.cjs');
  const read = (client: string) => { try { return execFileSync(REAL_NODE, [script, '--client', client], { cwd: dir, encoding: 'utf8', stdio: 'pipe' }).trim(); } catch (e: any) { return e.stdout.trim(); } };
  assert.deepEqual(JSON.parse(read('real')), { found: true, name: 'Real', enabled: true, pauseUntil: '2026-12-04T22:10:35.000Z' });
  assert.deepEqual(JSON.parse(read('missing')), { found: false });
  assert.deepEqual(JSON.parse(read('boom')), { error: 'read failed' });
  assert.deepEqual(JSON.parse(read('--flag')), { error: 'bad client id' });
});

test('both are button only: a spoken yes and jarvis-act confirm are refused and nothing runs', async () => {
  for (const [action, args] of [['gh-pr-close', CLOSE], ['fbm-client-pause', PAUSE]] as const) {
    assert.ok(BUTTON_ONLY.has(action));
    const s = openStore(':memory:');
    const gate = makeGate(s, id, () => {});
    const runs = gh.calls().length + node.calls().length;
    const p = await gate.propose(action, args, 'Do it?');
    s.addTurn({ role: 'owner', text: 'yes' });
    await assert.rejects(gate.confirm(p.id), /runs only when the owner taps Approve/);
    assert.equal(s.approval(p.id)!.status, 'pending');
    assert.equal(gh.calls().length + node.calls().length, runs);
  }
});

test('bad input is refused before anything is stored, and the brain cannot put its own words on the card', async () => {
  const s = openStore(':memory:');
  const gate = makeGate(s, id, () => {});
  for (const [action, args, why] of [
    ['gh-pr-close', { ...CLOSE, repo: '--help' }, /owner\/name/],
    ['gh-pr-close', { ...CLOSE, number: '4667; rm -rf x' }, /PR number/],
    ['gh-pr-close', { ...CLOSE, number: 0 }, /PR number/],
    ['gh-pr-close', { repo: CLOSE.repo, number: 1 }, /comment is required/],
    ['fbm-client-pause', { client: '--all', hours: 1 }, /client id/],
    ['fbm-client-pause', { client: '../other', hours: 1 }, /client id/],
    ['fbm-client-pause', { client: 'x' }, /hours/],
    ['fbm-client-pause', { client: 'x', hours: 0 }, /hours/],
    ['fbm-client-pause', { client: 'x', hours: 721 }, /hours/],
    ['fbm-client-pause', { client: 'x', hours: '1e3' }, /hours/],
  ] as const) await assert.rejects(gate.propose(action, args, 'x'), why);
  assert.equal(s.pendingApprovals().length, 0);

  const p = await gate.propose('gh-pr-close', { ...CLOSE, runs: 'echo harmless', extra: 'x' }, 'Close?');
  assert.doesNotMatch(p.args, /echo harmless|extra/);
  assert.deepEqual(buildCommand('fbm-client-pause', { client: 'x', hours: '48', runs: 'rm -rf /' }, id), ['node', 'functions/scripts/reusable/pause-client.js', '--client', 'x', '--hours', '48']);
  assert.throws(() => buildCommand('gh-pr-merge', { repo: 'a/b', number: 1 }, id), /unknown action/);
  assert.throws(() => buildCommand('git-push-force', {}, id), /unknown action/);
});

const item = (over: object): any => ({ external_id: 'msg_1', kind: 'escalation', dispatch_id: 'ctx_1', status: 'new', subject: 'Blocked', body: '', options: null, created_at: '2026-11-04 12:00:00', updated_at: null, answer: null, meta: null, ...over });
const stopNotice = (output: string) => `Worker term_a ended its turn without sending worker_done for task "Babysit PR #4667" (task_1).\nThe Dispatch is still open. Answer it with your Orca CLI's \`orchestration send\`, retry it, or stop the worker.\nLast output:\n${output}\nFull output: orchestration worker-read --dispatch ctx_1`;

test('the refusals of 2026-11-04 read as refusals, and other denials do not', () => {
  for (const said of [
    'The permissions layer denied the command',
    'The permission system refused `gh pr close` as an external write',
    'the permission classifier refused gh pr close (External System Writes)',
    'Permission for this action was denied by the Claude Code auto mode classifier. Reason: [Auto-Mode Bypass].',
    "Claude Code's permission check denied the full removal pass",
    'The Claude Code auto mode permission check then denied the full pass',
    'then the permission check flagged the next batch as a bypass, blocked again',
  ]) assert.ok(refusedByPermissionLayer(said), said);
  for (const said of [
    'zsh: permission denied: ./run.sh',
    'git@github.com: Permission denied (publickey).',
    'CI is down, so the deploy is blocked.',
    'I added a permission check. The API refused the old key.',
  ]) assert.ok(!refusedByPermissionLayer(said), said);
});

test('a refused escalation offers no Retry, says why, and offers the named action its words spell out', () => {
  const c = askCard(item({ subject: 'Blocked: permission denied on dealereleven pause', body: "The permissions layer denied the command 'node functions/scripts/reusable/pause-client.js --client dealereleven --hours 720', so I wrote nothing." }))!;
  assert.match(c.refused!, /A retry cannot clear this/);
  assert.deepEqual(c.options.map(o => o.label), ['Pause dealereleven for 720 hours', 'Stop', 'Tell it what to do']);
  assert.equal(c.options[0].value, NAMED_ACTION);
  assert.equal(c.suggested, true, 'nobody recommended these');
});

test('a refused stop notice finds a PR close, its repo from a link, and without a whole command offers Stop and Tell', () => {
  const full = askCard(item({ external_id: 'msg_stop_1', subject: 'Worker stopped without reporting', body: stopNotice('I could not close [#4667](https://github.com/example-org/acmeapp_nextjs/pull/4667). The permission system refused `gh pr close` and I did not get around it.\nType this: `! gh pr close 4667 --comment "Closed as superseded by #4733."`') }))!;
  assert.deepEqual(full.options.map(o => o.label), ['Close PR 4667', 'Stop', 'Tell it what to do']);
  const noRepo = askCard(item({ subject: 'Blocked: permission denied closing PR 4667', body: "The permission classifier refused gh pr close. To close it, the owner runs: gh pr close 4667 --comment 'Superseded.'" }))!;
  assert.deepEqual(noRepo.options.map(o => o.label), ['Stop', 'Tell it what to do'], 'Jarvis does not guess the repo');
  assert.match(noRepo.refused!, /retry cannot/);
});

test('a worker\'s own Retry goes, its other options stay, and an escalation with no refusal keeps Retry', () => {
  const own = askCard(item({ subject: 'Blocked', body: 'The classifier denied my delete.', options: JSON.stringify(['Retry it', 'The owner adds a permission rule then retry']) }))!;
  assert.deepEqual(own.options.map(o => o.label), ['The owner adds a permission rule then retry']);
  const plain = askCard(item({ subject: 'Blocked: CI is down', body: 'Tests cannot run.' }))!;
  assert.equal(plain.options[0].label, 'Retry');
  assert.equal(plain.refused, undefined);
  assert.deepEqual(namedActionIn('gh pr close 12 --repo a/b'), undefined, 'no comment, no action');
  const asked = askCard(item({ kind: 'question', subject: 'Which?', body: 'The permission check refused it. Which next?' }))!;
  assert.equal(asked.refused, undefined);
});

test('tapping the named action opens one Approve card and tells the worker not to retry; nothing runs until Approve', async () => {
  const s = openStore(':memory:');
  const gate = makeGate(s, id, () => {});
  s.insertItem({ source: 'orca', external_id: 'm1', kind: 'escalation', dispatch_id: 'ctx_1', subject: 'Blocked: permission denied', body: 'The permissions layer denied gh pr close 4667 --repo a/b --comment "Superseded."' });
  const sends: string[][] = [];
  const answers = { id: 'm1', value: NAMED_ACTION, run: 'r', handle: 'h', store: s, log: () => {}, note: () => {}, gate };
  const runs = gh.calls().length;

  const lost = await answerAsk({ ...answers, orca: async () => { throw new Error('down'); } });
  assert.equal(lost.status, 502);
  const r = await answerAsk({ ...answers, orca: async (a: string[]) => { sends.push(a); return { ok: true } as any; } });
  assert.equal(r.status, 200);
  assert.match(sends[0].at(-1)!, /Do not retry the refused step.*Close PR 4667/);
  assert.equal(s.item('m1')!.answer, NAMED_ACTION);
  assert.equal(s.approval(1)!.action, 'gh-pr-close');
  assert.equal(s.approval(1)!.status, 'pending');
  assert.equal(s.approval(2), undefined, 'the retried tap found the same card');
  assert.equal(gh.calls().length, runs, 'nothing ran');
  assert.equal((await answerAsk({ ...answers, orca: async () => ({ ok: true }) as any })).status, 409);
});

test('the named value does nothing on a card that offers no action', async () => {
  const s = openStore(':memory:');
  s.insertItem({ source: 'orca', external_id: 'm2', kind: 'escalation', dispatch_id: 'ctx_1', subject: 'Blocked: CI is down', body: 'gh pr close 4667 --repo a/b --comment "x"' });
  const r = await answerAsk({ id: 'm2', value: NAMED_ACTION, run: 'r', handle: 'h', store: s, log: () => {}, note: () => {}, gate: makeGate(s, id, () => {}), orca: async () => ({ ok: true }) as any });
  assert.equal(r.status, 409);
  assert.equal(s.approval(1), undefined);
  assert.equal(orca.calls().length, 0);
});
