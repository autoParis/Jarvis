import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  schedSentence, everySentence, fromCron, toCron, parsePrint, marks, statusOf, lastErrorOf, orcaOutcome, rruleSentence,
  makeTasks, execRun, humanize, frequent, tasksRoute, type Run, type Sched,
} from './tasks.ts';
import { fixMessage, markLabel, listHtml } from '../web/tasks.js';

const HOUR = 3_600_000;
const NOW = Date.parse('2026-11-09T15:30:00Z'); // 10:30 AM Eastern

test('a schedule reads as one short plain sentence', () => {
  assert.equal(everySentence(120), 'Every 2 minutes');
  assert.equal(everySentence(3600), 'Every hour');
  assert.equal(everySentence(7200), 'Every 2 hours');
  assert.equal(everySentence(86400), 'Every day');
  assert.equal(everySentence(45), 'Every 45 seconds');
  assert.equal(schedSentence({ calendar: [{ Weekday: 5, Hour: 9, Minute: 0 }] }), 'Every Friday at 9 AM');
  assert.equal(schedSentence({ calendar: [{ Hour: 5, Minute: 30 }] }), 'Every day at 5:30 AM');
  assert.equal(schedSentence({ calendar: [{ Hour: 14 }] }), 'Every day at 2 PM');
  // The yearly follow-ups the research found: shown as they really are.
  assert.equal(schedSentence({ calendar: [{ Month: 9, Day: 18, Hour: 9, Minute: 15 }] }), 'Every year on Sep 18 at 9:15 AM');
  assert.equal(schedSentence({ calendar: [{ Day: 1, Hour: 8, Minute: 15 }] }), 'Every month on day 1 at 8:15 AM');
  assert.equal(schedSentence({ calendar: [{ Minute: 0 }] }), 'Every hour at :00');
  assert.equal(schedSentence({ calendar: [{ Weekday: 0, Hour: 12 }] }), 'Every Sunday at 12 PM');
});

test('the cron field round-trips launchd schedules and refuses bad input', () => {
  const cases: Sched[] = [{ interval: 120 }, { interval: 7200 }, { interval: 90 }, { calendar: [{ Minute: 30, Hour: 5 }] }, { calendar: [{ Minute: 15, Hour: 9, Day: 18, Month: 9 }] }];
  for (const s of cases) assert.deepEqual(fromCron(toCron(s)), s);
  assert.equal(toCron({ calendar: [{ Weekday: 5, Hour: 9, Minute: 0 }] }), '0 9 * * 5');
  assert.deepEqual(fromCron('0 9,17 * * 1-2'), { calendar: [{ Minute: 0, Hour: 9, Weekday: 1 }, { Minute: 0, Hour: 9, Weekday: 2 }, { Minute: 0, Hour: 17, Weekday: 1 }, { Minute: 0, Hour: 17, Weekday: 2 }] });
  assert.deepEqual(fromCron('*/20 * * * *'), { calendar: [{ Minute: 0 }, { Minute: 20 }, { Minute: 40 }] });
  assert.deepEqual(fromCron('@every 30m'), { interval: 1800 });
  assert.deepEqual(fromCron('0 9 * * 5; 30 17 * * 5'), { calendar: [{ Minute: 0, Hour: 9, Weekday: 5 }, { Minute: 30, Hour: 17, Weekday: 5 }] });
  for (const bad of ['', '0 9 * *', '61 * * * *', '0 25 * * *', 'x * * * *', '@every 30s']) assert.ok('error' in fromCron(bad), bad);
});

test('launchctl print gives the run count, the last exit code and the state', () => {
  const text = 'gui/501/x = {\n\tactive count = 0\n\tpath = /a/x.plist\n\tstate = not running\n\truns = 11422\n\tlast exit code = 0\n\tresource coalition = {\n\t\tstate = active\n\t}\n}';
  assert.deepEqual(parsePrint(text), { running: false, runs: 11422, lastExit: 0, path: '/a/x.plist' });
  assert.equal(parsePrint('\tstate = running\n\truns = 1\n\tlast exit code = (never exited)\n').lastExit, null);
  assert.equal(parsePrint('\tstate = running\n\truns = 1\n\tlast exit code = -15\n').running, true);
});

test('the strip shows 24 hourly marks for a frequent task and the last 8 runs for the rest', () => {
  const runs = [
    { at: NOW - 30 * 60_000, outcome: 'ok' as const }, { at: NOW - 20 * 60_000, outcome: 'fail' as const, note: 'Exit code 1.' },
    { at: NOW - 3 * HOUR, outcome: 'fail' as const, note: 'boom' }, { at: NOW - 30 * HOUR, outcome: 'fail' as const },
  ];
  const h = marks(runs, true, NOW);
  assert.equal(h.length, 24);
  assert.equal(h[23].state, 'warn'); // this hour: one fine, one failed
  assert.equal(h[23].runs, 2);
  assert.equal(h[20].state, 'fail');
  assert.equal(h[0].state, 'none'); // 30 hours ago is off the strip, and nothing ran 23 hours ago
  const r = marks(runs, false, NOW);
  assert.equal(r.length, 8);
  assert.deepEqual(r.slice(0, 4).map(m => m.state), ['none', 'none', 'none', 'none']);
  assert.equal(r[7].state, 'fail'); // newest on the right: 20 minutes ago
  assert.equal(r[6].state, 'ok');
  assert.equal(markLabel(r[0], 'runs', NOW), 'No run seen yet');
  assert.match(markLabel(h[23], 'hourly', NOW), /^10 AM hour: some runs failed, 2 runs\. Exit code 1\.$/);
});

test('status: Failing when the last run failed, Warning when one in the strip did, Off when not loaded', () => {
  const ok = { at: NOW, outcome: 'ok' as const }, bad = { at: NOW - HOUR, outcome: 'fail' as const };
  assert.equal(statusOf([bad, ok], marks([bad, ok], true, NOW), false), 'Warning');
  assert.equal(statusOf([ok, { ...bad, at: NOW + 1 }], [], false), 'Failing');
  assert.equal(statusOf([ok], marks([ok], true, NOW), false), 'OK');
  assert.equal(statusOf([bad], [], true), 'Off');
  assert.equal(statusOf([], [], false, true), 'Failing'); // no history yet, but launchd's last exit code is not 0
  const e = lastErrorOf([ok, { at: NOW + HOUR, outcome: 'fail', note: 'a' }, { at: NOW + 2 * HOUR, outcome: 'fail', note: 'b' }]);
  assert.equal(e?.text, 'b');
  assert.equal(e?.since, new Date(NOW + HOUR).toISOString());
});

test('Orca runs: a timed-out precheck is a failure, a completed run is fine', () => {
  assert.deepEqual(orcaOutcome({ scheduledFor: 5, status: 'skipped_precheck', precheckResult: { error: 'Precheck timed out after 300s.', timedOut: true } }),
    { at: 5, outcome: 'fail', note: 'Precheck timed out after 300s. The run was skipped.' });
  assert.equal(orcaOutcome({ scheduledFor: 5, status: 'completed' })?.outcome, 'ok');
  assert.equal(orcaOutcome({ scheduledFor: 5, status: 'skipped_precheck', precheckResult: { exitCode: 1 } })?.outcome, 'ok');
  assert.equal(orcaOutcome({ scheduledFor: 5, status: 'running' }), null);
  assert.equal(rruleSentence('FREQ=HOURLY;BYMINUTE=0'), 'Every hour');
  assert.equal(rruleSentence('FREQ=DAILY;BYHOUR=9;BYMINUTE=30'), 'Every day at 9:30 AM');
  assert.equal(rruleSentence('FREQ=WEEKLY;BYDAY=FR;BYHOUR=9;BYMINUTE=0'), 'Every Friday at 9 AM');
});

// ---- launchd, end to end: a temp LaunchAgents folder, the real plutil, a fake launchctl ----
const plist = (label: string, body: string) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>/usr/bin/true</string></array>${body}</dict></plist>`;

function setup(opts: { failBootstrap?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-tasks-'));
  writeFileSync(join(dir, 'io.test.tick.plist'), plist('io.test.tick', '<key>StartInterval</key><integer>120</integer><key>StandardErrorPath</key><string>' + join(dir, 'tick.err') + '</string>'));
  writeFileSync(join(dir, 'io.test.weekly.plist'), plist('io.test.weekly', '<key>StartCalendarInterval</key><dict><key>Weekday</key><integer>5</integer><key>Hour</key><integer>9</integer><key>Minute</key><integer>0</integer></dict>'));
  writeFileSync(join(dir, 'io.test.service.plist'), plist('io.test.service', '<key>KeepAlive</key><true/>'));
  writeFileSync(join(dir, 'io.test.off.plist'), plist('io.test.off', '<key>StartInterval</key><integer>300</integer>'));
  writeFileSync(join(dir, 'io.test.broken.plist'), '<?xml version="1.0"?><plist><dict><key>Label</key><string>io.test.broken</string><key>StartInterval</key><integer>60</dict></plist>');
  writeFileSync(join(dir, 'io.test.jarvis.plist'), plist('io.test.jarvis', '<key>StartInterval</key><integer>60</integer>'));
  writeFileSync(join(dir, 'other.vendor.plist'), plist('other.vendor', '<key>StartInterval</key><integer>60</integer>'));
  // launchd's view: loaded jobs with a run count and last exit code. io.test.off is not loaded.
  const jobs: Record<string, { runs: number; exit: number; running?: boolean }> = { 'io.test.tick': { runs: 10, exit: 0 }, 'io.test.weekly': { runs: 2, exit: 0 }, 'io.test.broken': { runs: 1, exit: 0 }, 'io.test.jarvis': { runs: 1, exit: 0 } };
  const calls: string[] = [];
  let bootstrapFails = opts.failBootstrap ?? 0;
  const real = execRun();
  const run: Run = async (cmd, args) => {
    if (cmd === 'plutil') return real(cmd, args);
    if (cmd === 'orca') return { code: 1, stdout: '', stderr: 'no orca' };
    calls.push(args.join(' '));
    const label = args[1]?.split('/').at(-1) ?? '';
    if (args[0] === 'print') {
      const j = jobs[label];
      return j ? { code: 0, stderr: '', stdout: `x = {\n\tpath = ${join(dir, `${label}.plist`)}\n\tstate = ${j.running ? 'running' : 'not running'}\n\truns = ${j.runs}\n\tlast exit code = ${j.exit}\n}` } : { code: 113, stdout: '', stderr: 'Could not find service' };
    }
    if (args[0] === 'bootout') return { code: 0, stdout: '', stderr: '' };
    if (args[0] === 'bootstrap') return bootstrapFails-- > 0 ? { code: 5, stdout: '', stderr: 'Bootstrap failed: 5: Input/output error' } : { code: 0, stdout: '', stderr: '' };
    return { code: 1, stdout: '', stderr: 'unknown' };
  };
  const state = new Map<string, string>();
  let clock = NOW;
  const tasks = makeTasks({
    db: new DatabaseSync(':memory:'), run, uid: 501, agentsDir: dir, prefixes: ['io.test.'], locked: ['io.test.jarvis'], orca: true, now: () => clock,
    jarvisd: [{ id: 'jarvisd:check', name: 'Ten-minute check', schedule: 'Every 10 minutes, 8 AM to 4 PM', everyMs: 600_000, description: 'Wakes the brain.' }],
    getState: k => state.get(k), setState: (k, v) => { state.set(k, v); },
  });
  return { dir, jobs, calls, tasks, pass: (ms: number) => { clock += ms; } };
}

test('the list shows every scheduled launchd job, leaves out always-on services, and reads the plist each time', async () => {
  const { tasks, dir } = setup();
  const list = await tasks.list();
  const byId = Object.fromEntries(list.map(t => [t.id, t]));
  assert.deepEqual(list.map(t => t.id).sort(), ['jarvisd:check', 'launchd:io.test.broken', 'launchd:io.test.jarvis', 'launchd:io.test.off', 'launchd:io.test.tick', 'launchd:io.test.weekly']);
  assert.equal(byId['launchd:io.test.tick'].schedule, 'Every 2 minutes');
  assert.equal(byId['launchd:io.test.tick'].cron, '@every 2m');
  assert.equal(byId['launchd:io.test.tick'].strip, 'hourly');
  assert.equal(byId['launchd:io.test.weekly'].schedule, 'Every Friday at 9 AM');
  assert.equal(byId['launchd:io.test.weekly'].strip, 'runs');
  assert.equal(byId['launchd:io.test.off'].status, 'Off');
  assert.equal(byId['launchd:io.test.broken'].status, 'Warning');
  assert.equal(byId['launchd:io.test.broken'].editable, false);
  assert.match(byId['launchd:io.test.broken'].lastError!.text, /does not parse/);
  assert.equal(byId['launchd:io.test.jarvis'].editable, false);
  assert.equal(byId['jarvisd:check'].editable, false);
  // No copy: a change to the file shows on the next read.
  writeFileSync(join(dir, 'io.test.weekly.plist'), plist('io.test.weekly', '<key>StartCalendarInterval</key><dict><key>Hour</key><integer>2</integer><key>Minute</key><integer>0</integer></dict><key>JarvisDescription</key><string>Weekly ship.</string>'));
  const again = (await tasks.list()).find(t => t.id === 'launchd:io.test.weekly')!;
  assert.equal(again.schedule, 'Every day at 2 AM');
  assert.equal(again.description, 'Weekly ship.');
  assert.equal(humanize('io.autoroot.repo-context-harvest'), 'Repo context harvest');
  assert.equal(frequent({ calendar: [{ Hour: 2 }] }), false);
});

test('sampling stores one row per new run, waits while a job runs, and takes a reload as a new baseline', async () => {
  const { tasks, jobs, pass, dir } = setup();
  await tasks.sample(); // baseline only
  let tick = (await tasks.list()).find(t => t.id === 'launchd:io.test.tick')!;
  assert.equal(tick.marks.filter(m => m.state !== 'none').length, 0);
  jobs['io.test.tick'] = { runs: 11, exit: 0 }; pass(60_000); await tasks.sample();
  writeFileSync(join(dir, 'tick.err'), 'fatal: Not possible to fast-forward, aborting.\n');
  jobs['io.test.tick'] = { runs: 13, exit: 1 }; pass(60_000); await tasks.sample();
  jobs['io.test.tick'] = { runs: 14, exit: 1, running: true }; pass(60_000); await tasks.sample(); // running: skipped
  tick = (await tasks.list()).find(t => t.id === 'launchd:io.test.tick')!;
  assert.equal(tick.status, 'Failing');
  assert.match(tick.lastError!.text, /^Exit code 1\. Error log: fatal: Not possible to fast-forward, aborting\. 2 runs since the last sample/);
  assert.equal(tick.logTail?.text, 'fatal: Not possible to fast-forward, aborting.');
  jobs['io.test.tick'] = { runs: 2, exit: 0 }; pass(60_000); await tasks.sample(); // reloaded: 2 runs since
  tick = (await tasks.list()).find(t => t.id === 'launchd:io.test.tick')!;
  assert.equal(tick.status, 'Warning');
  tasks.record('jarvisd:check', 'warn', 'Skipped: Orca did not answer.');
  assert.equal((await tasks.list()).find(t => t.id === 'jarvisd:check')!.status, 'Warning');
});

test('Save writes the plist, keeps a backup, lints, reloads the job and reads it back', async () => {
  const { tasks, dir, calls } = setup();
  const file = join(dir, 'io.test.weekly.plist'), before = readFileSync(file, 'utf8');
  const r = await tasks.save('launchd:io.test.weekly', '30 8 * * 1-5', 'Ships the week\'s drift.\nAs one PR.');
  assert.equal(r.status, 200, r.error);
  assert.equal(r.task?.schedule, '5 set times: Every Monday at 8:30 AM, Every Tuesday at 8:30 AM, and more');
  assert.equal(r.task?.description, "Ships the week's drift. As one PR.");
  const after = readFileSync(file, 'utf8');
  assert.match(after, /<key>StartCalendarInterval<\/key>\s*<array>/);
  assert.match(after, /<integer>8<\/integer>/);
  assert.match(after, /<key>JarvisDescription<\/key>/);
  assert.deepEqual(calls.filter(c => c.startsWith('boot')), ['bootout gui/501/io.test.weekly', `bootstrap gui/501 ${file}`]);
  const backups = readdirSync(join(dir, 'jarvis-backups'));
  assert.equal(backups.length, 1);
  assert.equal(readFileSync(join(dir, 'jarvis-backups', backups[0]), 'utf8'), before);
  // A single time stays a dict, and an interval replaces the calendar.
  assert.equal((await tasks.save('launchd:io.test.weekly', '0 9 * * 5', '')).status, 200);
  assert.match(readFileSync(file, 'utf8'), /<key>StartCalendarInterval<\/key>\s*<dict>/);
  assert.doesNotMatch(readFileSync(file, 'utf8'), /JarvisDescription/);
  assert.equal((await tasks.save('launchd:io.test.weekly', '@every 2h', 'x')).task?.schedule, 'Every 2 hours');
  assert.doesNotMatch(readFileSync(file, 'utf8'), /StartCalendarInterval/);
});

test('Save on a job that is not loaded writes the file and leaves the job off', async () => {
  const { tasks, calls } = setup();
  const r = await tasks.save('launchd:io.test.off', '@every 10m', '');
  assert.equal(r.status, 200, r.error);
  assert.equal(r.task?.schedule, 'Every 10 minutes');
  assert.equal(r.task?.status, 'Off');
  assert.deepEqual(calls.filter(c => c.startsWith('boot')), []);
});

test('Save refuses bad input, locked and broken jobs, and changes nothing', async () => {
  const { tasks, dir, calls } = setup();
  const file = join(dir, 'io.test.tick.plist'), before = readFileSync(file, 'utf8');
  assert.equal((await tasks.save('launchd:io.test.tick', '99 * * * *', '')).status, 400);
  assert.equal((await tasks.save('launchd:io.test.tick', '@every 1m', 'x'.repeat(201))).status, 400);
  assert.equal((await tasks.save('launchd:io.test.jarvis', '@every 1m', '')).status, 403);
  assert.equal((await tasks.save('launchd:io.test.broken', '@every 1m', '')).status, 409);
  assert.equal((await tasks.save('launchd:io.test.service', '@every 1m', '')).status, 404);
  assert.equal((await tasks.save('launchd:other.vendor', '@every 1m', '')).status, 404);
  assert.equal((await tasks.save('orca:abc', '@every 1m', '')).status, 404);
  assert.equal(readFileSync(file, 'utf8'), before);
  assert.equal(existsSync(join(dir, 'jarvis-backups')), false);
  assert.deepEqual(calls.filter(c => c.startsWith('boot')), []);
});

test('a bootstrap that keeps failing puts the old plist back and loads it again', async () => {
  const { tasks, dir, calls } = setup({ failBootstrap: 3 });
  const file = join(dir, 'io.test.tick.plist'), before = readFileSync(file, 'utf8');
  const r = await tasks.save('launchd:io.test.tick', '@every 5m', '');
  assert.equal(r.status, 500);
  assert.match(r.error!, /launchd refused the new plist .*The old plist is back and loaded/);
  assert.equal(readFileSync(file, 'utf8'), before);
  assert.equal(calls.filter(c => c.startsWith('bootstrap')).length, 4);
});

test('Ask Jarvis to fix names the task, its source and its last error', () => {
  const t = {
    id: 'orca:1', source: 'orca', sourceLabel: 'Orca automation "worktree cleanup" (1)', name: 'Worktree cleanup', schedule: 'Every hour',
    editable: false, description: '', status: 'Failing', strip: 'hourly', marks: [],
    lastError: { at: new Date(NOW - 30 * 60_000).toISOString(), text: 'Precheck timed out after 300s.', since: '2026-11-06T21:00:00Z' },
  };
  const m = fixMessage(t, NOW);
  assert.match(m, /^Scheduled task "Worktree cleanup" shows Failing\. Source: Orca automation "worktree cleanup" \(1\)\./);
  assert.match(m, /Last error, today at 10:00 AM: Precheck timed out after 300s\. Every run since Nov 6, 4:00 PM failed\./);
  assert.match(m, /Ask me before you change the job/);
  const html = listHtml([t, { ...t, id: 'x', status: 'OK', lastError: undefined }], 'orca:1', NOW);
  assert.equal((html.match(/class="tk-fix"/g) ?? []).length, 2); // the row and the open panel, none on the OK row
  assert.match(html, /aria-expanded="true"/);
});

test('jarvisd serves the screen: Save needs an open app page, and the module is a static file', () => {
  const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
  assert.match(main, /const AS_OWNER = new Set\(\[[^\]]*'\/api\/tasks\/save'/);
  assert.match(main, /'\/tasks\.js': 'tasks\.js'/);
  const page = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  assert.match(page, /<button id="tasksbtn" type="button">Scheduled tasks<\/button>/);
  assert.match(main, /const AS_OWNER = new Set\(\[[^\]]*'\/api\/tasks\/ask-fix'/);
  assert.match(page, /fetch\('\/api\/tasks\/ask-fix', \{ method: 'POST', body: JSON\.stringify\(\{ id: t\.id \}\) \}\)/);
});

test('Ask Jarvis to fix: the daemon builds the message from a fresh read, only for a failing or warning task', async () => {
  const { tasks, jobs, pass } = setup();
  const said: string[] = [];
  const route = (id: string) => tasksRoute(tasks, 'POST', '/api/tasks/ask-fix', async () => ({ id }), t => said.push(t));
  assert.equal((await route('launchd:io.test.nope'))?.status, 404);
  assert.equal((await route('launchd:io.test.tick'))?.status, 409); // OK now: nothing to fix
  await tasks.sample();
  jobs['io.test.tick'] = { runs: 11, exit: 3 }; pass(60_000); await tasks.sample();
  assert.equal((await route('launchd:io.test.tick'))?.status, 200);
  assert.equal(said.length, 1);
  assert.match(said[0], /^Scheduled task "Tick" shows Failing\. Source: launchd job io\.test\.tick \(.*io\.test\.tick\.plist\)\./);
  assert.match(said[0], /Exit code 3\./);
});
