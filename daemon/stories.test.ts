import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore, type Store } from './store.ts';
import { makeGate } from './gate.ts';
import { IDLE_STOPPED } from './native.ts';
import { STORY_START_HOUR, STORY_END_HOUR, STORY_ZONE, STORY_MAX } from './config.ts';
import { inStoryHours, makeStories, runningStories, storyRoute, storyNumberOf, queueStartSpec, STORY_HOURS } from './stories.ts';
import { queueHtml } from '../web/today.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// 2026-11-11 is in Eastern Standard Time (UTC-5): 13:00Z is 8 AM, 21:00Z is 4 PM.
const at = (iso: string) => Date.parse(iso);
const EIGHT_AM = at('2026-11-11T13:00:00Z'), NOON = at('2026-11-11T17:00:00Z'), FOUR_PM = at('2026-11-11T21:00:00Z');

test('the defaults are 8 AM to 4 PM Toronto time and 3 at a time', () => {
  assert.equal(STORY_ZONE, 'America/Toronto');
  assert.equal(STORY_START_HOUR, 8);
  assert.equal(STORY_END_HOUR, 16);
  assert.equal(STORY_MAX, 3);
  assert.deepEqual(STORY_HOURS, { zone: 'America/Toronto', start: 8, end: 16 });
});

test('the hours start at 8:00 and end before 16:00 Eastern, in winter and in summer time', () => {
  assert.equal(inStoryHours(at('2026-11-11T12:59:59Z')), false, '7:59 AM');
  assert.equal(inStoryHours(EIGHT_AM), true, '8:00 AM');
  assert.equal(inStoryHours(at('2026-11-11T20:59:59Z')), true, '3:59 PM');
  assert.equal(inStoryHours(FOUR_PM), false, '4:00 PM');
  assert.equal(inStoryHours(at('2026-11-12T03:00:00Z')), false, '10 PM');
  // July is daylight time (UTC-4): 12:00Z is 8 AM, 20:00Z is 4 PM.
  assert.equal(inStoryHours(at('2026-07-01T11:59:00Z')), false);
  assert.equal(inStoryHours(at('2026-07-01T12:00:00Z')), true);
  assert.equal(inStoryHours(at('2026-07-01T20:00:00Z')), false);
  assert.equal(inStoryHours(NOON, { zone: 'America/Toronto', start: 8, end: 8 }), false, 'an empty window never opens');
});

test('a story number comes only from a title that starts with #<n>', () => {
  assert.equal(storyNumberOf('#4412 onboarding wizard'), 4412);
  assert.equal(storyNumberOf('Babysit PR #88'), undefined);
  assert.equal(storyNumberOf('Dealer migration draft'), undefined);
});

let seq = 0;
/** A native worker row for a story started by an approval, in the given state. */
function worker(s: Store, title: string, f: { state?: string; outcome?: 'done' | 'failed' | null; waiting_for?: string | null; action?: string } = {}) {
  const a = s.addApproval({ action: f.action ?? 'worker-start', args: JSON.stringify({ repo: '/repos/product', taskTitle: title, spec: 'x' }), say: 'x' });
  const id = `w${++seq}`, t = new Date().toISOString();
  s.addNativeWorker({ id, session_id: null, name: `${id}-name`, cwd: '/repos/product', approval_id: a.id, state: (f.state ?? 'working') as any, waiting_for: f.waiting_for ?? null, report: null, report_at: null, outcome: f.outcome ?? null, transcript: null, created_at: t, updated_at: t });
  return id;
}

test('a story worker holds its slot until DONE, FAILED or a stop, also while it waits on an ask', () => {
  const s = openStore(':memory:');
  worker(s, '#1 working');
  worker(s, '#2 asking', { state: 'blocked', waiting_for: 'an ask' });
  worker(s, '#3 asked, then idle-stopped', { state: 'stopped', waiting_for: IDLE_STOPPED });
  worker(s, '#4 from Today', { action: 'today-start' });
  worker(s, '#5 reported done', { outcome: 'done' });
  worker(s, '#6 reported failed', { state: 'failed', outcome: 'failed' });
  worker(s, '#7 stopped by the owner', { state: 'stopped' });
  worker(s, '#8 abandoned', { state: 'abandoned' });
  worker(s, 'Babysit PR #9');
  worker(s, 'Question about #10', { action: 'question' });
  assert.deepEqual(runningStories(s).map(r => r.number).sort((a, b) => a - b), [1, 2, 3, 4]);
});

/** The fill rule with a fake gate that records each start and adds the worker row a real start makes. */
function setup(o: { now: number; max?: number; status?: string; throws?: string }) {
  const s = openStore(':memory:');
  const starts: any[] = [], told: string[] = [], notices: string[] = [];
  let changes = 0;
  const gate = {
    async queued(args: any, say: string) {
      if (o.throws) throw new Error(o.throws);
      starts.push({ args, say });
      const a = s.addApproval({ action: 'worker-start', args: JSON.stringify(args), say });
      s.decide(a.id, 'approved', 'queue');
      s.finishApproval(a.id, o.status ?? 'done', '{}');
      if ((o.status ?? 'done') === 'done') {
        const t = new Date().toISOString();
        s.addNativeWorker({ id: `q${a.id}`, session_id: null, name: `q${a.id}`, cwd: args.repo, approval_id: a.id, state: 'starting', waiting_for: null, report: null, report_at: null, outcome: null, transcript: null, created_at: t, updated_at: t });
      }
      return s.approval(a.id)!;
    },
  };
  const stories = makeStories({
    store: s, gate, repo: () => '/repos/product', log: () => {}, paused: () => false,
    told: (line, notice) => { told.push(line); notices.push(notice); }, onChange: () => { changes++; },
    now: () => o.now, max: o.max, skillFor: () => 'pick-and-ship-v3',
  });
  return { s, stories, starts, told, notices, changes: () => changes };
}

test('in the hours, jarvisd starts queued stories in order until 3 story workers run', async () => {
  const t = setup({ now: NOON });
  worker(t.s, '#100 already running');
  for (const [n, topic] of [[201, 'extension ticket'], [202, 'Muse fix'], [203, 'Marketplace photos'], [204, 'later one']] as const) t.s.queueStory(n, topic);
  assert.equal(await t.stories.fill(), 2);
  assert.deepEqual(t.starts.map(x => x.args.taskTitle), ['#201 extension ticket', '#202 Muse fix']);
  assert.deepEqual(t.starts[0].args, { repo: '/repos/product', taskTitle: '#201 extension ticket', spec: queueStartSpec(201, 'pick-and-ship-v3') });
  assert.match(t.starts[0].args.spec, /^Run the pick-and-ship-v3 skill on issue #201 \(do not pick a different issue\)/);
  assert.deepEqual(t.s.storyQueue().map(q => q.number), [203, 204], 'each started story left the queue');
  assert.deepEqual(t.told, ['Started #201 extension ticket from the queue', 'Started #202 Muse fix from the queue']);
  assert.match(t.notices[1], /^\[story queue\] Started #202 Muse fix from the queue .*3 of 3 story slots are in use\. 2 stories wait/);
  assert.equal(await t.stories.fill(), 0, 'all 3 slots are full');
});

test('a slot frees when a story reports DONE, and the next one starts', async () => {
  const t = setup({ now: NOON });
  const busy = [worker(t.s, '#1 a'), worker(t.s, '#2 b'), worker(t.s, '#3 c')];
  t.s.queueStory(4, 'next');
  assert.equal(await t.stories.fill(), 0);
  t.s.updateNativeWorker(busy[1], { outcome: 'done' });
  assert.equal(await t.stories.fill(), 1);
  assert.equal(t.starts[0].args.taskTitle, '#4 next');
});

test('the max is a setting', async () => {
  const t = setup({ now: NOON, max: 1 });
  t.s.queueStory(1, 'a'); t.s.queueStory(2, 'b');
  assert.equal(await t.stories.fill(), 1);
  assert.deepEqual(t.s.storyQueue().map(q => q.number), [2]);
});

test('nothing starts before 8 AM or from 4 PM on, and a running worker is left alone', async () => {
  for (const now of [at('2026-11-11T12:59:00Z'), FOUR_PM, at('2026-11-12T06:00:00Z')]) {
    const t = setup({ now });
    worker(t.s, '#1 running at the end hour');
    t.s.queueStory(2, 'waits for the morning');
    assert.equal(await t.stories.fill(), 0);
    assert.equal(t.starts.length, 0);
    assert.deepEqual(t.s.storyQueue().map(q => q.number), [2]);
    assert.deepEqual(runningStories(t.s).map(r => r.number), [1]);
  }
  const morning = setup({ now: EIGHT_AM });
  morning.s.queueStory(2, 'waits for the morning');
  assert.equal(await morning.stories.fill(), 1, 'it starts at 8:00');
});

test('a failed start leaves the queue, says so in the chat, and the next story still starts', async () => {
  const t = setup({ now: NOON, status: 'failed' });
  t.s.queueStory(7, 'broken');
  assert.equal(await t.stories.fill(), 0);
  assert.equal(t.s.storyQueue().length, 0);
  assert.match(t.told[0], /^Could not start #7 broken from the queue/);
  const dup = setup({ now: NOON, throws: 'A worker-start titled "#8 x" in /repos/product is already running' });
  dup.s.queueStory(8, 'x');
  await dup.stories.fill();
  assert.match(dup.told[0], /already running/);
});

test('a story already running is taken off the queue without a second start', async () => {
  const t = setup({ now: NOON });
  worker(t.s, '#5 running');
  t.s.queueStory(5, 'same story'); t.s.queueStory(6, 'other');
  assert.equal(await t.stories.fill(), 1);
  assert.deepEqual(t.starts.map(x => x.args.taskTitle), ['#6 other']);
  assert.match(t.told[0], /#5 is already running/);
});

test('the gate starts a queued story on the worker-start path, with no card, and refuses a second one', async () => {
  const s = openStore(':memory:');
  const starts: any[] = [];
  const native = { start: async (a: any) => { starts.push(a); return { id: 'abcd1234', session_id: null, name: a.name, state: 'working' } as any; }, stop: async () => {}, abandon: async () => {} };
  const gate = makeGate(s, { run: 'r', handle: 'h' }, () => {}, () => {}, undefined, undefined, undefined, native);
  const args = { repo: '/repos/product', taskTitle: '#42 extension ticket', spec: queueStartSpec(42, 'pick-and-ship-v3') };
  const a = await gate.queued(args, 'Start #42 extension ticket from the queue');
  assert.equal(a.status, 'done');
  assert.equal(a.action, 'worker-start');
  assert.equal(a.decided_by, 'queue');
  assert.equal(starts.length, 1);
  assert.equal(starts[0].worktree, true, 'a new worktree, like any worker-start');
  assert.match(starts[0].brief, /^Run the pick-and-ship-v3 skill on issue #42/);
  assert.match(starts[0].brief, /create-issue/, 'the issue rule of every worker-start');
  assert.equal(s.pendingApprovals().length, 0, 'no card waits');
  // The same guard as a proposal: a worker-start with the same title and repo that is still open is refused.
  const other = { ...args, taskTitle: '#43 Muse fix', spec: queueStartSpec(43, 'pick-and-ship-v3') };
  await gate.propose('worker-start', other, 'Start #43?');
  await assert.rejects(gate.queued(other, 'Start #43 Muse fix from the queue'), /already pending/);
  assert.equal(starts.length, 1);
});

/** jarvisd's internal route on a real port, for the CLI. */
async function serve(s: Store) {
  const stories = { view: () => ({ stories: s.storyQueue(), running: [], max: 3, hours: { ...STORY_HOURS, open: true } }), fill: async () => 0 };
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const r = storyRoute(s, stories, () => {}, req.method ?? '', req.url ?? '', body ? JSON.parse(body) : {}, () => {});
    res.writeHead(r?.status ?? 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify(r?.body ?? { error: 'not found' }));
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as any).port}`;
  const cli = (...argv: string[]) => new Promise<{ code: number; out: string; err: string }>(resolve =>
    execFile(process.execPath, [join(ROOT, 'bin', 'jarvis-stories'), ...argv], { env: { ...process.env, JARVIS_URL: url } }, (e, out, err) => resolve({ code: (e as any)?.code ?? 0, out, err })));
  return { cli, close: () => new Promise(r => server.close(r)) };
}

test('jarvis-stories adds, moves, removes and lists the queue', async () => {
  const s = openStore(':memory:');
  const { cli, close } = await serve(s);
  try {
    assert.equal((await cli('add', '11', '--topic', 'Muse fix')).code, 0);
    assert.equal((await cli('add', '12', '--topic', '  Marketplace   photos ')).code, 0);
    const first = await cli('add', '13', '--topic', 'extension ticket', '--at', '1');
    assert.equal(first.code, 0);
    assert.deepEqual(JSON.parse(first.out).stories.map((q: any) => q.number), [13, 11, 12]);
    assert.equal(s.storyQueue()[2].topic, 'Marketplace photos');
    const again = await cli('add', '11', '--topic', 'Muse fix');
    assert.equal(again.code, 1);
    assert.match(again.err, /already on the queue/);
    assert.deepEqual(JSON.parse((await cli('move', '12', '--to', '1')).out).stories.map((q: any) => q.number), [12, 13, 11]);
    assert.deepEqual(JSON.parse((await cli('move', '12', '--to', '9')).out).stories.map((q: any) => q.number), [13, 11, 12]);
    assert.deepEqual(JSON.parse((await cli('remove', '11')).out).stories.map((q: any) => q.number), [13, 12]);
    assert.match((await cli('remove', '11')).err, /not on the queue/);
    const list = await cli('list');
    assert.deepEqual(JSON.parse(list.out).stories.map((q: any) => [q.number, q.topic]), [[13, 'extension ticket'], [12, 'Marketplace photos']]);
    for (const bad of [['add', '14'], ['add', 'x', '--topic', 't'], ['move', '13'], ['remove'], ['frobnicate']]) assert.equal((await cli(...bad)).code, 2, bad.join(' '));
    assert.match((await cli('add', '15', '--topic', 'x'.repeat(101))).err, /at most 100/);
  } finally { await close(); }
});

test('the Today popup shows the queue in order, and nothing when it is empty', () => {
  assert.equal(queueHtml({ stories: [], running: [], max: 3, hours: { start: 8, end: 16, open: true } }), '');
  const html = queueHtml({ stories: [{ number: 13, topic: 'extension <ticket>' }, { number: 12, topic: 'Marketplace photos' }], running: [{ number: 1 }, { number: 2 }], max: 3, hours: { start: 8, end: 16, open: false } });
  assert.match(html, /2 of 3 running · starts 8 AM to 4 PM, closed now/);
  assert.match(html, /<li><span class="tq-n">#13<\/span> extension &lt;ticket&gt;<\/li><li><span class="tq-n">#12<\/span>/);
});
