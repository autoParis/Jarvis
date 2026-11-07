import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from './store.ts';
import { makeCheck, CHECK_MS, REMIND_MS } from './check.ts';
import { parseDue, eastern, reminderRoute } from './reminders.ts';

const at = (s: string) => Date.parse(s);
const DAY = at('2026-11-03T15:00:00Z'); // 10 AM Eastern
const MIN = 60_000;

function setup(start = DAY) {
  const store = openStore(':memory:');
  let clock = start;
  const wakes: string[] = [];
  const fail = { orca: undefined as string | undefined, git: undefined as string | undefined, paused: false };
  const check = makeCheck({
    store, jarvisRun: 'run_j', log: () => {}, now: () => clock, paused: () => fail.paused,
    poll: async () => ({ at: '', rows: [], done: [], ...(fail.orca ? { error: fail.orca } : {}) }) as any,
    requests: { synced: async () => {}, closing: () => false },
    delivery: async () => { if (fail.git) throw new Error(fail.git); return { master: 'a', unmerged: [] }; },
    running: 'a', brainBusy: () => false, wake: t => wakes.push(t),
  });
  /** Adds a reminder through the route, due `min` minutes from the clock. */
  const add = (text: string, min: number) => (reminderRoute(store, () => {}, 'POST', '/api/internal/reminders', { due: `+${min}m`, text }, clock)!.body as { id: number }).id;
  return { store, check, wakes, fail, add, pass: (ms: number) => { clock += ms; } };
}

test('the check runs every ten minutes and repeats a fired reminder every hour', () => {
  assert.equal(CHECK_MS, 10 * MIN);
  assert.equal(REMIND_MS, 60 * MIN);
});

test('--due takes an ISO time with an offset or a duration, and refuses the rest', () => {
  assert.equal(parseDue('2026-11-03T15:00:00-05:00', DAY), at('2026-11-03T20:00:00Z'));
  assert.equal(parseDue('2026-11-03T20:00Z', DAY), at('2026-11-03T20:00:00Z'));
  assert.equal(parseDue('+90m', DAY), DAY + 90 * MIN);
  assert.equal(parseDue('+1d4h', DAY), DAY + 28 * 60 * MIN);
  assert.throws(() => parseDue('2026-11-03T15:00:00', DAY), /offset/);
  assert.throws(() => parseDue('2026-11-03', DAY), /offset/);
  assert.throws(() => parseDue('tomorrow', DAY), /bad time/);
  assert.throws(() => parseDue('2026-11-31T10:00:00Z', DAY), /no such date/);
  assert.throws(() => parseDue('2026-11-02T10:00:00Z', DAY), /already passed/);
  for (const bad of ['+', '+0m', '+2x', '+2 h']) assert.throws(() => parseDue(bad, DAY), /bad duration/);
  assert.throws(() => parseDue(undefined, DAY), /required/);
});

test('eastern reads a database time on the owner\'s clock, across the DST change', () => {
  assert.equal(eastern('2026-11-03 15:00:00'), 'Nov 3, 10:00 AM');
  assert.equal(eastern('2026-07-15 15:00:00'), 'Jul 15, 11:00 AM');
});

test('a tick with nothing due makes no model call, and a reminder not yet due stays open', async () => {
  const { store, check, wakes, add } = setup();
  await check.tick();
  const id = add('Call Sam', 30);
  await check.tick();
  assert.deepEqual(wakes, []);
  assert.equal(store.reminder(id)!.status, 'open');
  assert.equal(store.reminder(id)!.fired_at, null);
});

test('a due reminder is reported once as a [check] line with its id and marked fired', async () => {
  const { store, check, wakes, add, pass } = setup();
  const id = add('Call Sam', 5);
  pass(10 * MIN);
  await check.tick();
  assert.equal(wakes.length, 1);
  assert.equal(wakes[0], `[check] Reminder due: Call Sam (id=${id}, due Nov 3, 10:05 AM Eastern)`);
  const r = store.reminder(id)!;
  assert.equal(r.status, 'fired');
  assert.equal(r.fired_at, '2026-11-03 15:10:00');
  pass(10 * MIN);
  await check.tick();
  assert.equal(wakes.length, 1);
});

test('a fired reminder repeats hourly until done, keeps its first fired_at, and done stops it', async () => {
  const { store, check, wakes, add, pass } = setup();
  const id = add('Call Sam', 5);
  pass(10 * MIN);
  await check.tick();
  for (let i = 0; i < 5; i++) { pass(10 * MIN); await check.tick(); }
  assert.equal(wakes.length, 1);
  pass(10 * MIN);
  await check.tick();
  assert.equal(wakes.length, 2);
  assert.match(wakes[1], /told before, still not done/);
  assert.equal(store.reminder(id)!.fired_at, '2026-11-03 15:10:00');
  assert.equal(store.reminder(id)!.told_at, '2026-11-03 16:10:00');
  store.doneReminder(id, '2026-11-03 16:15:00');
  pass(2 * REMIND_MS);
  await check.tick();
  assert.equal(wakes.length, 2);
  assert.equal(store.reminder(id)!.status, 'done');
  assert.equal(store.reminder(id)!.done_at, '2026-11-03 16:15:00');
});

test('several due reminders share one wake, and each line has the [check] prefix', async () => {
  const { check, wakes, add, pass } = setup();
  add('First', 5);
  add('Second', 6);
  pass(10 * MIN);
  await check.tick();
  assert.equal(wakes.length, 1);
  assert.match(wakes[0], /^\[check\] Reminder due: First .*\n\[check\] Reminder due: Second /);
});

test('outside the hours nothing is told; a reminder from the night comes at the first tick after 8 AM', async () => {
  const { store, check, wakes, add, pass } = setup(at('2026-11-03T20:50:00Z')); // 3:50 PM Eastern
  const id = add('Evening', 30); // due 4:20 PM
  pass(40 * MIN);
  await check.tick();
  assert.deepEqual(wakes, []);
  assert.equal(store.reminder(id)!.status, 'open');
  pass(at('2026-11-04T13:00:00Z') - at('2026-11-03T21:30:00Z')); // 8:00 AM the next day
  await check.tick();
  assert.equal(wakes.length, 1);
});

test('a fired reminder not done by 4 PM is told again at 8 AM', async () => {
  const { check, wakes, add, pass } = setup(at('2026-11-03T20:40:00Z')); // 3:40 PM Eastern
  add('Late', 5);
  pass(10 * MIN);
  await check.tick();
  assert.equal(wakes.length, 1);
  pass(at('2026-11-04T13:00:00Z') - at('2026-11-03T20:50:00Z'));
  await check.tick();
  assert.equal(wakes.length, 2);
});

test('Orca or git failing does not hold back a reminder, and the kill switch does', async () => {
  const orca = setup();
  orca.add('A', 5);
  orca.pass(10 * MIN);
  orca.fail.orca = 'Orca: no answer';
  await orca.check.tick();
  assert.equal(orca.wakes.length, 1);

  const git = setup();
  git.add('B', 5);
  git.pass(10 * MIN);
  git.fail.git = 'git: no answer';
  await assert.rejects(git.check.tick(), /no answer/);
  assert.equal(git.wakes.length, 1);

  const kill = setup();
  const id = kill.add('C', 5);
  kill.pass(10 * MIN);
  kill.fail.paused = true;
  await kill.check.tick();
  assert.deepEqual(kill.wakes, []);
  assert.equal(kill.store.reminder(id)!.status, 'open');
});

test('at start only lost messages count, so a due reminder waits for a tick', () => {
  const { check, wakes, add, pass } = setup();
  add('A', 5);
  pass(10 * MIN);
  check.start();
  assert.deepEqual(wakes, []);
});

test('a reminder survives a reopen of the database file', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'jarvis-remind-')), 'j.db');
  const id = openStore(path).addReminder('Kept', '2026-11-03 15:00:00').id;
  assert.equal(openStore(path).reminder(id)!.text, 'Kept');
});

/** Runs the real CLI against the real routes on a test port. */
async function cli(store: ReturnType<typeof openStore>, ...args: string[]) {
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const r = reminderRoute(store, () => {}, req.method!, req.url!, raw ? JSON.parse(raw) : {}, DAY);
    res.writeHead(r?.status ?? 404);
    res.end(JSON.stringify(r?.body ?? {}));
  });
  await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok));
  const port = (server.address() as { port: number }).port;
  const bin = fileURLToPath(new URL('../bin/jarvis-remind', import.meta.url));
  try {
    return await new Promise<{ code: number; out: string; err: string }>(ok =>
      execFile(process.execPath, [bin, ...args], { env: { ...process.env, JARVIS_URL: `http://127.0.0.1:${port}` } }, (e, out, err) => ok({ code: e ? Number(e.code) : 0, out, err })));
  } finally { server.close(); }
}

test('jarvis-remind adds, lists and closes a reminder through the routes', async () => {
  const store = openStore(':memory:');
  const added = await cli(store, 'add', '--due', '+2h', '--text', 'Call  Sam\nback');
  assert.equal(added.code, 0);
  const r = JSON.parse(added.out);
  assert.equal(r.text, 'Call Sam back');
  assert.equal(r.due_at, '2026-11-03 17:00:00');
  assert.equal(r.due_eastern, 'Nov 3, 12:00 PM');
  assert.equal(r.note, undefined);
  assert.equal(JSON.parse((await cli(store, 'list')).out).length, 1);
  const done = await cli(store, 'done', String(r.id));
  assert.equal(JSON.parse(done.out).status, 'done');
  const again = await cli(store, 'done', String(r.id));
  assert.equal(JSON.parse(again.out).done_at, JSON.parse(done.out).done_at);
  assert.deepEqual(JSON.parse((await cli(store, 'list')).out), []);
});

test('jarvis-remind says when a reminder falls outside the check hours, and refuses bad input', async () => {
  const store = openStore(':memory:');
  assert.match(JSON.parse((await cli(store, 'add', '--due', '+8h', '--text', 'Evening')).out).note, /next 8 AM/);
  const noOffset = await cli(store, 'add', '--due', '2026-11-03T15:00:00', '--text', 'x');
  assert.equal(noOffset.code, 1);
  assert.match(noOffset.err, /offset/);
  assert.equal((await cli(store, 'add', '--due', '+1h')).code, 1);
  assert.equal((await cli(store, 'done', '99')).code, 1);
  assert.equal((await cli(store, 'done', 'abc')).code, 2);
  assert.equal((await cli(store)).code, 2);
  assert.equal(store.openReminders().length, 1);
});

test('jarvis-remind fails plainly when jarvisd is down', async () => {
  const bin = fileURLToPath(new URL('../bin/jarvis-remind', import.meta.url));
  const r = await new Promise<{ code: number; err: string }>(ok =>
    execFile(process.execPath, [bin, 'list'], { env: { ...process.env, JARVIS_URL: 'http://127.0.0.1:9' } }, (e, _o, err) => ok({ code: e ? Number(e.code) : 0, err })));
  assert.equal(r.code, 1);
  assert.match(r.err, /jarvisd unreachable/);
});
