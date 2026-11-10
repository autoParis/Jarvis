// Sample tasks for `npm run preview` (the Scheduled tasks screen), built with the same strip and status code as jarvisd.
// PREVIEW_TASKS=real reads the real launchd jobs instead, read-only, with an in-memory run history.
import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fixMessage } from '../web/tasks.js';
import { marks, statusOf, lastErrorOf, fromCron, toCron, schedSentence, makeTasks, execRun, tasksRoute, type Task, type Outcome } from '../daemon/tasks.ts';

const HOUR = 3_600_000;
type Spec = { id: string; name: string; cron: string; source: Task['source']; label: string; hourly: boolean; every: number; bad?: number[]; failAll?: string; description: string; editable?: boolean };
const SPECS: Spec[] = [
  { id: 'jarvisd:gmail', name: 'Gmail watcher', cron: '', source: 'jarvisd', label: 'jarvisd timer (gmail)', hourly: true, every: 10, description: 'Reads new mail from the people in vault/people.md and stores it.' },
  { id: 'launchd:io.autoroot.repo-context-harvest', name: 'Repo context harvest', cron: '30 5 * * *', source: 'launchd', label: 'launchd job io.autoroot.repo-context-harvest', hourly: false, every: 24 * 60, description: 'Collects repo context notes for the FBM uploader.', editable: true },
  { id: 'launchd:io.autoroot.claude-fast-ship', name: 'Ship .claude changes', cron: '0 9 * * 5', source: 'launchd', label: 'launchd job io.autoroot.claude-fast-ship', hourly: false, every: 7 * 24 * 60, description: 'Ships local .claude drift as one PR per subtree.', editable: true },
  { id: 'launchd:io.autoroot.story-board-sync', name: 'Story board sync', cron: '@every 2m', source: 'launchd', label: 'launchd job io.autoroot.story-board-sync', hourly: true, every: 2, description: 'Moves cmux story board cards to their stage.', editable: true },
  { id: 'launchd:io.autoroot.factory-retro', name: 'Story factory retro', cron: '0 2 * * *', source: 'launchd', label: 'launchd job io.autoroot.factory-retro', hourly: false, every: 24 * 60, description: 'Scans last day of story factory runs for lessons.', editable: true },
  { id: 'launchd:io.autoroot.factory-runner', name: 'Story factory tick', cron: '@every 2m', source: 'launchd', label: 'launchd job io.autoroot.factory-runner', hourly: true, every: 2, bad: [4, 7, 9], description: 'Moves each story factory run one step.', editable: true },
  { id: 'jarvisd:check', name: 'Ten-minute check', cron: '', source: 'jarvisd', label: 'jarvisd timer (check)', hourly: true, every: 10, description: 'Wakes the brain on a new finding or a due reminder.' },
  { id: 'jarvisd:today', name: 'Today list backstop', cron: '', source: 'jarvisd', label: 'jarvisd timer (today)', hourly: true, every: 30, description: 'Catches Today items that an event missed.' },
  { id: 'launchd:io.autoroot.tripwire-poll', name: 'Tripwire check', cron: '@every 30m', source: 'launchd', label: 'launchd job io.autoroot.tripwire-poll', hourly: true, every: 30, description: 'Checks the FBM tripwire.', editable: true },
  { id: 'launchd:io.autoroot.worktree-cleanup', name: 'Worktree cleanup', cron: '0 * * * *', source: 'launchd', label: 'launchd job io.autoroot.worktree-cleanup', hourly: true, every: 60, failAll: 'Precheck timed out after 300s. The run was skipped.', description: '', editable: true },
];
const SCHEDULE: Record<string, string> = { 'jarvisd:gmail': 'Every 10 minutes', 'jarvisd:check': 'Every 10 minutes, 8 AM to 4 PM', 'jarvisd:today': 'Every 30 minutes' };

export function sampleTasks(now = Date.now()): Task[] {
  return SPECS.map(s => {
    const runs: { at: number; outcome: Outcome; note?: string }[] = [];
    const span = s.hourly ? 24 * HOUR : 8 * s.every * 60_000;
    for (let at = now - span + 60_000; at <= now; at += s.every * 60_000) {
      const hoursAgo = Math.floor((now - at) / HOUR);
      const failed = s.failAll ? true : s.bad?.includes(hoursAgo) && (at / 60_000) % 6 < 2;
      runs.push(failed ? { at, outcome: 'fail', note: s.failAll ?? 'Exit code 1. Error log: fatal: Not possible to fast-forward, aborting.' } : { at, outcome: 'ok' });
    }
    const shown = marks(runs, s.hourly, now);
    const lastError = lastErrorOf(runs);
    const sched = s.cron ? fromCron(s.cron) : null;
    return {
      id: s.id, source: s.source, sourceLabel: s.label, name: s.name,
      schedule: SCHEDULE[s.id] ?? (sched && !('error' in sched) ? schedSentence(sched) : s.cron), ...(s.cron ? { cron: s.cron } : {}),
      editable: !!s.editable, ...(s.editable ? {} : { editNote: 'This timer is part of jarvisd. Its schedule is in the code.' }),
      description: s.description, status: statusOf(runs, shown, false), strip: s.hourly ? 'hourly' : 'runs', marks: shown,
      ...(lastError ? { lastError: s.failAll ? { ...lastError, since: new Date(now - 65 * HOUR).toISOString() } : lastError } : {}),
    } satisfies Task;
  });
}

/** The preview's /api/tasks routes. Sample Saves change this process's memory only; real mode refuses Save. */
export function makePreviewTasks() {
  const real = process.env.PREVIEW_TASKS === 'real';
  const state = new Map<string, string>();
  const tasks = real ? makeTasks({
    db: new DatabaseSync(':memory:'), run: execRun(), uid: process.getuid?.() ?? 501, agentsDir: join(homedir(), 'Library', 'LaunchAgents'),
    prefixes: ['io.autoroot.', 'com.fbm.'], locked: ['io.autoroot.jarvis'], jarvisd: [],
    getState: k => state.get(k), setState: (k, v) => { state.set(k, v); }, log: (m, f) => console.log(m, f ?? ''),
  }) : undefined;
  // The real mode samples launchd like jarvisd does, so its strips fill from the minute the preview starts.
  if (tasks) { const tick = () => tasks.sample().catch(e => console.log(`tasks sample: ${e}`)); tick(); setInterval(tick, 60_000); }
  let list = sampleTasks();
  return async (method: string, url: string, body: () => Promise<any>) => {
    if (method === 'GET' && url === '/api/tasks') return { status: 200, body: { tasks: tasks ? await tasks.list() : list, at: new Date().toISOString() } };
    if (method === 'POST' && url === '/api/tasks/save') {
      if (tasks) return { status: 403, body: { error: 'The preview reads real jobs but never writes them.' } };
      const b = await body(), s = fromCron(String(b.cron ?? ''));
      if ('error' in s) return { status: 400, body: { error: s.error } };
      list = list.map(t => t.id === b.id ? { ...t, cron: toCron(s), schedule: schedSentence(s), description: String(b.description ?? '') } : t);
      return { status: 200, body: { task: list.find(t => t.id === b.id) } };
    }
    // Hide or show: real mode keeps the hidden ids in this process's memory (the state map), sample mode in the sample list.
    if (method === 'POST' && url === '/api/tasks/hide') {
      if (tasks) return tasksRoute(tasks, method, url, body);
      const b = await body();
      if (typeof b.id !== 'string' || typeof b.hidden !== 'boolean') return { status: 400, body: { error: 'id and hidden (true or false) are required' } };
      list = list.map(t => t.id === b.id ? { ...t, hidden: b.hidden || undefined } : t);
      return { status: 200, body: { hidden: list.filter(t => t.hidden).map(t => t.id) } };
    }
    if (method === 'POST' && url === '/api/tasks/ask-fix') {
      const b = await body(), t = (tasks ? await tasks.list() : list).find(x => x.id === b.id);
      if (!t) return { status: 404, body: { error: 'That task is not in the list any more.' } };
      console.log(`ask-fix (preview, not sent): ${fixMessage(t)}`);
      return { status: 200, body: { sent: true } };
    }
    return undefined;
  };
}
