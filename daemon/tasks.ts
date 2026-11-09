// The Scheduled tasks screen: one flat list of the owner's scheduled tasks, read fresh from their real sources each time.
// launchd jobs are the only editable source. Jarvis keeps no copy of a schedule: it reads the plist (plutil) and
// `launchctl print` on every list, and a Save writes the plist, reloads the job and reads it back.
// The one-line description lives in the plist itself (key JarvisDescription; launchd ignores keys it does not know,
// checked on 2026-11-09 with a throwaway job), so it cannot drift from the job.
// Run history: launchd keeps only the last exit code and a run count. jarvisd samples `launchctl print` every minute
// and stores one row per new run it sees (task_runs). The Orca automation keeps its own run history. jarvisd's own
// timers write a row when they tick.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, renameSync, copyFileSync, statSync, openSync, readSync, closeSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

export type Run = (cmd: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
export const execRun = (env?: NodeJS.ProcessEnv): Run => (cmd, args) => new Promise(resolve => {
  execFile(cmd, args, { timeout: 30_000, maxBuffer: 16 * 1024 * 1024, env }, (err, stdout, stderr) => {
    const code = !err ? 0 : typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1;
    resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') || (err ? err.message : '') });
  });
});

export type Outcome = 'ok' | 'warn' | 'fail';
export type Mark = { at: string; state: Outcome | 'none'; runs: number; note?: string };
export type Status = 'OK' | 'Warning' | 'Failing' | 'Off';
export type Task = {
  id: string; source: 'launchd' | 'orca' | 'jarvisd'; sourceLabel: string; name: string;
  schedule: string; cron?: string; editable: boolean; editNote?: string; description: string;
  status: Status; strip: 'hourly' | 'runs'; marks: Mark[];
  lastError?: { at?: string; text: string; since?: string };
  logTail?: { file: string; at: string; text: string };
};
type RunRow = { at: number; outcome: Outcome; note?: string };

const HOUR = 3_600_000;
const RUNS_SHOWN = 8;
const KEEP_MS = 70 * 24 * HOUR;

// ---- launchd schedules: plain sentences and a cron form for the edit field ----
type Cal = { Minute?: number; Hour?: number; Day?: number; Month?: number; Weekday?: number };
export type Sched = { interval: number } | { calendar: Cal[] };
const CAL_KEYS = ['Minute', 'Hour', 'Day', 'Month', 'Weekday'] as const;

export function schedOf(plist: Record<string, unknown>): Sched | null {
  if (typeof plist.StartInterval === 'number' && plist.StartInterval > 0) return { interval: plist.StartInterval };
  const c = plist.StartCalendarInterval;
  const list = Array.isArray(c) ? c : c && typeof c === 'object' ? [c] : [];
  return list.length ? { calendar: list as Cal[] } : null;
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const plural = (n: number, unit: string) => n === 1 ? `Every ${unit}` : `Every ${n} ${unit}s`;
export function everySentence(seconds: number): string {
  if (seconds % 86400 === 0) return plural(seconds / 86400, 'day');
  if (seconds % 3600 === 0) return plural(seconds / 3600, 'hour');
  if (seconds % 60 === 0) return plural(seconds / 60, 'minute');
  return plural(seconds, 'second');
}
const clock = (h: number, m: number) => `${h % 12 || 12}${m ? `:${String(m).padStart(2, '0')}` : ''} ${h < 12 ? 'AM' : 'PM'}`;
function calSentence(c: Cal): string {
  const time = c.Hour !== undefined ? ` at ${clock(c.Hour, c.Minute ?? 0)}` : '';
  if (c.Hour === undefined) {
    const min = c.Minute !== undefined ? ` at :${String(c.Minute).padStart(2, '0')}` : '';
    const when = c.Weekday !== undefined ? ` on ${DAYS[c.Weekday]}` : c.Day !== undefined ? ` on day ${c.Day}` : '';
    return c.Minute === undefined ? `Every minute${when}` : `Every hour${min}${when}`;
  }
  if (c.Month !== undefined && c.Day !== undefined) return `Every year on ${MONTHS[c.Month - 1]} ${c.Day}${time}`;
  if (c.Month !== undefined) return `Every day in ${MONTHS[c.Month - 1]}${time}`;
  if (c.Weekday !== undefined && c.Day !== undefined) return `Every ${DAYS[c.Weekday]} and on day ${c.Day}${time}`;
  if (c.Weekday !== undefined) return `Every ${DAYS[c.Weekday]}${time}`;
  if (c.Day !== undefined) return `Every month on day ${c.Day}${time}`;
  return `Every day${time}`;
}
export function schedSentence(s: Sched): string {
  if ('interval' in s) return everySentence(s.interval);
  const parts = s.calendar.map(calSentence);
  return parts.length <= 3 ? parts.join(', and ') : `${parts.length} set times: ${parts.slice(0, 2).join(', ')}, and more`;
}
/** True when the task runs at least once an hour: its strip then shows the last 24 hours, one mark per hour. */
export const frequent = (s: Sched | null) => !!s && ('interval' in s ? s.interval <= 3600 : s.calendar.some(c => c.Hour === undefined));

export function toCron(s: Sched): string {
  if ('interval' in s) {
    const n = s.interval;
    return n % 3600 === 0 ? `@every ${n / 3600}h` : n % 60 === 0 ? `@every ${n / 60}m` : `@every ${n}s`;
  }
  return s.calendar.map(c => CAL_KEYS.map(k => c[k] ?? '*').join(' ')).join('; ');
}

const RANGES: Record<typeof CAL_KEYS[number], [number, number]> = { Minute: [0, 59], Hour: [0, 23], Day: [1, 31], Month: [1, 12], Weekday: [0, 7] };
function field(text: string, key: typeof CAL_KEYS[number]): number[] | null | string {
  const [lo, hi] = RANGES[key];
  if (text === '*') return null;
  const out = new Set<number>();
  for (const part of text.split(',')) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (!m) return `"${part}" is not a number, a range or a step`;
    let [a, b] = m[1] === '*' ? [lo, hi] : m[1].split('-').map(Number) as [number, number?];
    if (b === undefined) b = m[2] ? hi : a;
    const step = m[2] ? Number(m[2]) : 1;
    if (a < lo || b > hi || a > b || step < 1) return `${key.toLowerCase()} must be ${lo} to ${hi}`;
    for (let v = a; v <= b; v += step) out.add(v);
  }
  return [...out].sort((x, y) => x - y);
}
/** The edit field: `@every 30m` (or 45s, 2h) for an interval, or cron lines (minute hour day month weekday), several separated by `;`. */
export function fromCron(text: string): Sched | { error: string } {
  const t = text.trim();
  const every = /^@every\s+(\d+)\s*([smh])$/i.exec(t);
  if (every) {
    const n = Number(every[1]) * ({ s: 1, m: 60, h: 3600 } as const)[every[2].toLowerCase() as 's' | 'm' | 'h'];
    return n >= 60 ? { interval: n } : { error: 'The shortest interval is 1 minute.' };
  }
  const calendar: Cal[] = [];
  for (const line of t.split(';').map(x => x.trim()).filter(Boolean)) {
    const parts = line.split(/\s+/);
    if (parts.length !== 5) return { error: `"${line}" needs 5 fields: minute hour day month weekday. Or write @every 30m.` };
    let combos: Cal[] = [{}];
    for (let i = 0; i < 5; i++) {
      const key = CAL_KEYS[i], v = field(parts[i], key);
      if (typeof v === 'string') return { error: `In "${line}": ${v}.` };
      if (v) combos = combos.flatMap(c => v.map(n => ({ ...c, [key]: n })));
    }
    calendar.push(...combos);
  }
  if (!calendar.length) return { error: 'Write a schedule, for example 0 9 * * 5 or @every 30m.' };
  if (calendar.length > 100) return { error: `That is ${calendar.length} start times. launchd takes one entry per time, so keep it under 100, or use @every.` };
  return { calendar };
}

// ---- launchctl print ----
export type Print = { loaded: boolean; running: boolean; runs: number; lastExit: number | null; path?: string; error?: string };
export function parsePrint(text: string): Omit<Print, 'loaded'> {
  const get = (k: string) => new RegExp(`^\\t${k} = (.+)$`, 'm').exec(text)?.[1].trim();
  const exit = get('last exit code');
  return { running: get('state') === 'running', runs: Number(get('runs') ?? 0), lastExit: exit && /^-?\d+$/.test(exit) ? Number(exit) : null, path: get('path') };
}

/** The last non-empty lines of a log file, read from its last 4 KB. */
export function tail(file: string, lines = 3): { at: string; text: string } | undefined {
  try {
    const st = statSync(file);
    if (!st.size) return undefined;
    const n = Math.min(4096, st.size), buf = Buffer.alloc(n), fd = openSync(file, 'r');
    try { readSync(fd, buf, 0, n, st.size - n); } finally { closeSync(fd); }
    const text = buf.toString('utf8').split('\n').map(l => l.trimEnd()).filter(Boolean).slice(-lines).join('\n');
    return text ? { at: new Date(st.mtimeMs).toISOString(), text } : undefined;
  } catch { return undefined; }
}

// ---- marks and status, shared by every source ----
export function marks(runs: RunRow[], hourly: boolean, now: number): Mark[] {
  const sorted = [...runs].sort((a, b) => a.at - b.at);
  if (!hourly) {
    const last = sorted.slice(-RUNS_SHOWN).map(r => ({ at: new Date(r.at).toISOString(), state: r.outcome, runs: 1, ...(r.note ? { note: r.note } : {}) }) as Mark);
    // Empty slots on the left keep 8 marks per row: an empty slot is a run not seen yet, with no time.
    return [...Array.from({ length: RUNS_SHOWN - last.length }, () => ({ at: '', state: 'none', runs: 0 }) as Mark), ...last];
  }
  const end = Math.floor(now / HOUR) * HOUR + HOUR;
  return Array.from({ length: 24 }, (_, i) => {
    const from = end - (24 - i) * HOUR;
    const inside = sorted.filter(r => r.at >= from && r.at < from + HOUR);
    const bad = inside.filter(r => r.outcome !== 'ok');
    const state = !inside.length ? 'none' : !bad.length ? 'ok' : bad.length === inside.length && bad.every(r => r.outcome === 'fail') ? 'fail' : 'warn';
    const note = bad.at(-1)?.note;
    return { at: new Date(from).toISOString(), state, runs: inside.length, ...(note ? { note } : {}) } as Mark;
  });
}
export function statusOf(runs: RunRow[], shown: Mark[], off: boolean, fallbackFailed = false): Status {
  if (off) return 'Off';
  const last = [...runs].sort((a, b) => a.at - b.at).at(-1);
  if (last ? last.outcome === 'fail' : fallbackFailed) return 'Failing';
  return shown.some(m => m.state === 'fail' || m.state === 'warn') || last?.outcome === 'warn' ? 'Warning' : 'OK';
}
export function lastErrorOf(runs: RunRow[]): Task['lastError'] {
  const sorted = [...runs].sort((a, b) => a.at - b.at);
  const bad = sorted.filter(r => r.outcome !== 'ok').at(-1);
  if (!bad) return undefined;
  let i = sorted.length - 1;
  while (i > 0 && sorted[i - 1].outcome !== 'ok') i--;
  const streak = sorted.length - i;
  return { at: new Date(bad.at).toISOString(), text: bad.note ?? 'The run failed.', ...(streak >= 2 && sorted.at(-1)!.outcome !== 'ok' ? { since: new Date(sorted[i].at).toISOString() } : {}) };
}

// ---- Orca automations (read-only) ----
const RR_DAYS: Record<string, string> = { MO: 'Monday', TU: 'Tuesday', WE: 'Wednesday', TH: 'Thursday', FR: 'Friday', SA: 'Saturday', SU: 'Sunday' };
export function rruleSentence(rrule: string): string {
  const p = Object.fromEntries(rrule.split(';').map(kv => kv.split('=')));
  const n = Number(p.INTERVAL ?? 1), h = p.BYHOUR !== undefined ? Number(p.BYHOUR) : undefined, m = Number(p.BYMINUTE ?? 0);
  const at = h !== undefined && !p.BYHOUR.includes(',') ? ` at ${clock(h, m)}` : '';
  if (p.FREQ === 'MINUTELY') return plural(n, 'minute');
  if (p.FREQ === 'HOURLY') return plural(n, 'hour');
  if (p.FREQ === 'DAILY') return `${plural(n, 'day')}${at}`;
  if (p.FREQ === 'WEEKLY' && p.BYDAY) return `Every ${p.BYDAY.split(',').map((d: string) => RR_DAYS[d] ?? d).join(' and ')}${at}`;
  return rrule;
}
type OrcaRun = { scheduledFor?: number; createdAt?: number; status?: string; error?: string | null; precheckResult?: { error?: string | null; timedOut?: boolean; exitCode?: number | null } | null };
export function orcaOutcome(r: OrcaRun): RunRow | null {
  const at = r.scheduledFor ?? r.createdAt;
  if (!at || r.status === 'running' || r.status === 'pending' || r.status === 'queued') return null;
  const pre = r.precheckResult;
  const err = pre?.error || (pre?.timedOut ? 'The precheck timed out.' : '') || r.error || '';
  if (r.status === 'completed' && !r.error) return { at, outcome: 'ok' };
  if (r.status?.startsWith('skipped') && !err) return { at, outcome: 'ok', note: 'Skipped by its precheck.' };
  return { at, outcome: 'fail', note: `${err || `Run ended as ${r.status}.`}${r.status === 'skipped_precheck' ? ' The run was skipped.' : ''}` };
}

// ---- the reader ----
export type JarvisdTask = { id: string; name: string; schedule: string; everyMs: number; description: string };
export type TasksDeps = {
  db: DatabaseSync; run: Run; uid: number; agentsDir: string; prefixes: string[];
  /** Labels never offered for editing: jarvisd's own job, which a reload would stop mid-request. */
  locked: string[];
  jarvisd: JarvisdTask[]; orca: boolean; now?: () => number; log?: (m: string, f?: object) => void;
  getState: (k: string) => string | undefined; setState: (k: string, v: string) => void;
};

export function makeTasks(d: TasksDeps) {
  const now = d.now ?? Date.now;
  d.db.exec(`CREATE TABLE IF NOT EXISTS task_runs (id INTEGER PRIMARY KEY, task TEXT NOT NULL, at INTEGER NOT NULL, outcome TEXT NOT NULL, note TEXT);
    CREATE INDEX IF NOT EXISTS task_runs_task_at ON task_runs (task, at);`);
  const insert = d.db.prepare('INSERT INTO task_runs (task, at, outcome, note) VALUES (?, ?, ?, ?)');
  const select = d.db.prepare('SELECT at, outcome, note FROM task_runs WHERE task = ? AND at >= ? ORDER BY at');
  const lastFew = d.db.prepare('SELECT at, outcome, note FROM task_runs WHERE task = ? ORDER BY at DESC LIMIT ?');
  const prune = d.db.prepare('DELETE FROM task_runs WHERE at < ?');
  const record = (task: string, outcome: Outcome, note?: string, at = now()) => { insert.run(task, at, outcome, note ?? null); };
  const stored = (task: string, hourly: boolean): RunRow[] => (hourly ? select.all(task, now() - 25 * HOUR) : (lastFew.all(task, RUNS_SHOWN) as unknown[]).reverse())
    .map(r => { const x = r as { at: number; outcome: Outcome; note: string | null }; return { at: x.at, outcome: x.outcome, ...(x.note ? { note: x.note } : {}) }; });

  const plistFiles = () => existsSync(d.agentsDir)
    ? readdirSync(d.agentsDir).filter(f => f.endsWith('.plist') && d.prefixes.some(p => f.startsWith(p))).sort() : [];
  async function readPlist(file: string): Promise<{ plist?: Record<string, unknown>; error?: string }> {
    const r = await d.run('plutil', ['-convert', 'json', '-o', '-', file]);
    if (r.code) return { error: (r.stderr || r.stdout).trim().replace(`${file}: `, '') || 'plutil could not read it' };
    try { return { plist: JSON.parse(r.stdout) }; } catch { return { error: 'plutil gave no JSON' }; }
  }
  async function print(label: string): Promise<Print> {
    const r = await d.run('launchctl', ['print', `gui/${d.uid}/${label}`]);
    if (r.code) return { loaded: false, running: false, runs: 0, lastExit: null, error: r.stderr.trim() };
    return { loaded: true, ...parsePrint(r.stdout) };
  }

  /** Every launchd job with a schedule. Always-on services (KeepAlive, no schedule) are not scheduled tasks and stay out. */
  async function launchdJobs() {
    return (await Promise.all(plistFiles().map(async f => {
      const file = join(d.agentsDir, f), label = f.slice(0, -'.plist'.length);
      const { plist, error } = await readPlist(file);
      const sched = plist ? schedOf(plist) : null;
      if (plist && !sched) return null;
      return { file, label: typeof plist?.Label === 'string' ? plist.Label : label, plist, error, sched, state: await print(typeof plist?.Label === 'string' ? plist.Label : label) };
    }))).filter(x => x !== null);
  }

  /** One sample: a row per new run launchd counted since the last sample. A running job waits for the next sample. */
  async function sample() {
    const seen = JSON.parse(d.getState('launchdRuns') ?? '{}') as Record<string, number>;
    for (const j of await launchdJobs()) {
      const s = j.state;
      if (!s.loaded || s.running) continue;
      const before = seen[j.label];
      seen[j.label] = s.runs;
      // The first sample, or the run count went back to zero (a reload or a restart of the Mac), only sets the baseline.
      const fresh = before === undefined ? 0 : s.runs >= before ? s.runs - before : s.runs;
      if (!fresh || s.lastExit === null) continue;
      const errLog = typeof j.plist?.StandardErrorPath === 'string' ? tail(j.plist.StandardErrorPath, 1) : undefined;
      const recentLog = errLog && now() - Date.parse(errLog.at) < 10 * 60_000 ? ` Error log: ${errLog.text}` : '';
      const many = fresh > 1 ? ` ${fresh} runs since the last sample; launchd keeps only the last exit code.` : '';
      record(`launchd:${j.label}`, s.lastExit === 0 ? 'ok' : 'fail', s.lastExit === 0 ? (many.trim() || undefined) : `Exit code ${s.lastExit}.${recentLog}${many}`);
    }
    d.setState('launchdRuns', JSON.stringify(seen));
    prune.run(now() - KEEP_MS);
  }

  function launchdTask(j: Awaited<ReturnType<typeof launchdJobs>>[number]): Task {
    const id = `launchd:${j.label}`, hourly = frequent(j.sched);
    const runs = stored(id, hourly), shown = marks(runs, hourly, now());
    const name = typeof j.plist?.JarvisName === 'string' ? j.plist.JarvisName : humanize(j.label);
    const errFile = typeof j.plist?.StandardErrorPath === 'string' ? j.plist.StandardErrorPath : undefined;
    const logTail = errFile ? tail(errFile) : undefined;
    const lockedWhy = d.locked.includes(j.label) ? 'Jarvis runs as this job, so the screen does not edit it.' : undefined;
    const status = j.error ? 'Warning' : statusOf(runs, shown, !j.state.loaded || j.plist?.Disabled === true, j.state.lastExit !== null && j.state.lastExit !== 0);
    const lastError = j.error ? { text: `The plist does not parse, so the next reload fails: ${j.error}` }
      : lastErrorOf(runs) ?? (j.state.lastExit ? { text: `launchd's last exit code is ${j.state.lastExit}.` } : undefined);
    return {
      id, source: 'launchd', sourceLabel: `launchd job ${j.label} (${j.file})`, name,
      schedule: j.sched ? schedSentence(j.sched) : 'Schedule unreadable', ...(j.sched ? { cron: toCron(j.sched) } : {}),
      editable: !j.error && !!j.sched && !lockedWhy, ...(j.error ? { editNote: 'The plist does not parse, so the screen does not write it.' } : lockedWhy ? { editNote: lockedWhy } : !j.state.loaded ? { editNote: 'This job is not loaded. Save writes the plist and leaves the job off.' } : {}),
      description: typeof j.plist?.JarvisDescription === 'string' ? j.plist.JarvisDescription : '',
      status, strip: hourly ? 'hourly' : 'runs', marks: shown,
      ...(lastError ? { lastError } : {}), ...(logTail && errFile ? { logTail: { file: errFile, ...logTail } } : {}),
    };
  }

  async function orcaTasks(): Promise<Task[]> {
    const list = await d.run('orca', ['automations', 'list', '--json']);
    if (list.code) { d.log?.('tasks: orca automations list failed', { error: list.stderr.slice(0, 200) }); return []; }
    const autos = (JSON.parse(list.stdout).result?.automations ?? []) as { id: string; name: string; rrule: string; enabled: boolean }[];
    return Promise.all(autos.map(async a => {
      const r = await d.run('orca', ['automations', 'runs', '--id', a.id, '--limit', '100', '--json']);
      const runs = r.code ? [] : ((JSON.parse(r.stdout).result?.runs ?? []) as OrcaRun[]).map(orcaOutcome).filter((x): x is RunRow => !!x);
      const hourly = /FREQ=(HOURLY|MINUTELY)/.test(a.rrule);
      const shown = marks(runs.filter(x => !hourly || x.at >= now() - 25 * HOUR), hourly, now());
      const lastError = lastErrorOf(runs);
      return {
        id: `orca:${a.id}`, source: 'orca', sourceLabel: `Orca automation "${a.name}" (${a.id})`, name: sentenceCase(a.name),
        schedule: rruleSentence(a.rrule), editable: false, editNote: 'Orca keeps this schedule. Change it in Orca.', description: '',
        status: statusOf(runs, shown, !a.enabled), strip: hourly ? 'hourly' : 'runs', marks: shown,
        ...(r.code ? { lastError: { text: `Could not read its run history: ${r.stderr.trim().slice(0, 200)}` } } : lastError ? { lastError } : {}),
      } satisfies Task;
    }));
  }

  function jarvisdTask(t: JarvisdTask): Task {
    const hourly = t.everyMs <= HOUR, runs = stored(t.id, hourly), shown = marks(runs, hourly, now());
    const lastError = lastErrorOf(runs);
    return {
      id: t.id, source: 'jarvisd', sourceLabel: `jarvisd timer (${t.id.slice('jarvisd:'.length)})`, name: t.name, schedule: t.schedule,
      editable: false, editNote: 'This timer is part of jarvisd. Its schedule is in the code.', description: t.description,
      status: statusOf(runs, shown, false), strip: hourly ? 'hourly' : 'runs', marks: shown, ...(lastError ? { lastError } : {}),
    };
  }

  async function list(): Promise<Task[]> {
    const [jobs, orca] = await Promise.all([launchdJobs(), d.orca ? orcaTasks().catch(e => { d.log?.(`tasks: orca read failed: ${e}`); return []; }) : []]);
    return [...jobs.map(launchdTask), ...orca, ...d.jarvisd.map(jarvisdTask)].sort((a, b) => a.name.localeCompare(b.name));
  }

  let saving = false;
  /**
   * Writes a launchd job's schedule and description. Order: check the input, back up the plist, edit a copy with plutil,
   * lint it, move it in place, reload the job if it was loaded, then read both back. Any failure before the move changes
   * nothing. A failed reload puts the backup back and loads it again.
   */
  async function save(id: string, cronText: string, description: string): Promise<{ status: number; error?: string; task?: Task }> {
    if (saving) return { status: 409, error: 'Another save is running. Try again in a moment.' };
    const label = id.startsWith('launchd:') ? id.slice('launchd:'.length) : '';
    const job = (await launchdJobs()).find(j => j.label === label);
    if (!job) return { status: 404, error: 'Only a launchd job with a schedule can be edited here.' };
    if (d.locked.includes(label)) return { status: 403, error: 'Jarvis runs as this job, so the screen does not edit it.' };
    if (job.error || !job.plist) return { status: 409, error: `The plist does not parse, so the screen does not write it: ${job.error}` };
    const sched = fromCron(String(cronText ?? ''));
    if ('error' in sched) return { status: 400, error: sched.error };
    const desc = String(description ?? '').replace(/\s+/g, ' ').trim();
    if (desc.length > 200) return { status: 400, error: 'Keep the description to one line, under 200 characters.' };
    saving = true;
    try {
      const backups = join(d.agentsDir, 'jarvis-backups');
      mkdirSync(backups, { recursive: true });
      const stamp = new Date(now()).toISOString().replace(/[-:]/g, '').replace(/\..*/, '');
      // Backups and the work copy sit in a subfolder: launchd loads every .plist in LaunchAgents at login, not the ones below it.
      const backup = join(backups, `${label}.${stamp}.plist`), work = join(backups, `${label}.${stamp}.new.plist`);
      copyFileSync(job.file, backup);
      copyFileSync(job.file, work);
      const edits: string[][] = [['-remove', 'StartInterval'], ['-remove', 'StartCalendarInterval']];
      if ('interval' in sched) edits.push(['-insert', 'StartInterval', '-integer', String(sched.interval)]);
      else edits.push(['-insert', 'StartCalendarInterval', '-json', JSON.stringify(sched.calendar.length === 1 ? sched.calendar[0] : sched.calendar)]);
      edits.push(desc ? ['-replace', 'JarvisDescription', '-string', desc] : ['-remove', 'JarvisDescription']);
      for (const e of edits) {
        const r = await d.run('plutil', [...e, work]);
        if (r.code && e[0] !== '-remove') { unlinkSync(work); return { status: 500, error: `plutil ${e[0]} ${e[1]} failed: ${r.stderr.trim()}. The plist is unchanged.` }; }
      }
      const lint = await d.run('plutil', ['-lint', work]);
      if (lint.code) { unlinkSync(work); return { status: 500, error: `The new plist failed plutil -lint: ${(lint.stderr || lint.stdout).trim()}. The plist is unchanged.` }; }
      renameSync(work, job.file);
      d.log?.('tasks: plist written', { label, schedule: toCron(sched), backup });
      if (job.state.loaded) {
        const reload = await reloadJob(label, job.file);
        if (reload) {
          copyFileSync(backup, job.file);
          const back = await reloadJob(label, job.file);
          d.log?.('tasks: reload failed, backup restored', { label, error: reload, restoreError: back });
          return { status: 500, error: `launchd refused the new plist (${reload}). The old plist is back${back ? `, but it did not load again either: ${back}` : ' and loaded'}.` };
        }
      }
      // Read back what is really on disk and in launchd now.
      const after = await readPlist(job.file), state = await print(label);
      const got = after.plist ? schedOf(after.plist) : null;
      const problems = [
        !got || toCron(got) !== toCron(sched) ? `the schedule reads back as ${got ? toCron(got) : 'nothing'}` : '',
        (after.plist?.JarvisDescription ?? '') !== desc ? 'the description reads back differently' : '',
        job.state.loaded && !state.loaded ? 'launchd does not list the job any more' : '',
        job.state.loaded && state.path && state.path !== job.file ? `launchd loaded ${state.path}` : '',
      ].filter(Boolean);
      const task = (await launchdJobs()).find(j => j.label === label);
      if (problems.length) { d.log?.('tasks: read-back differs', { label, problems }); return { status: 500, error: `Saved, but ${problems.join(', and ')}. Backup: ${backup}`, ...(task ? { task: launchdTask(task) } : {}) }; }
      d.log?.('tasks: saved and read back', { label, schedule: toCron(sched) });
      return { status: 200, ...(task ? { task: launchdTask(task) } : {}) };
    } finally { saving = false; }
  }

  /** bootout then bootstrap. launchd can need a moment after bootout, so bootstrap gets three tries. Returns an error text, or undefined. */
  async function reloadJob(label: string, file: string): Promise<string | undefined> {
    await d.run('launchctl', ['bootout', `gui/${d.uid}/${label}`]);
    let last = '';
    for (let i = 0; i < 3; i++) {
      const r = await d.run('launchctl', ['bootstrap', `gui/${d.uid}`, file]);
      if (!r.code) return undefined;
      last = (r.stderr || r.stdout).trim();
      await new Promise(res => setTimeout(res, 500));
    }
    return last || 'bootstrap failed';
  }

  return { list, sample, save, record };
}

export const humanize = (label: string) => sentenceCase(label.split('.').at(-1)!.replace(/[-_]+/g, ' '));
const sentenceCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The routes. GET lists, POST /api/tasks/save edits one launchd job. */
export async function tasksRoute(t: ReturnType<typeof makeTasks>, method: string, url: string, body: () => Promise<Record<string, unknown>>) {
  if (method === 'GET' && url === '/api/tasks') return { status: 200, body: { tasks: await t.list(), at: new Date().toISOString() } };
  if (method === 'POST' && url === '/api/tasks/save') {
    const b = await body();
    if (typeof b.id !== 'string' || typeof b.cron !== 'string') return { status: 400, body: { error: 'id and cron are required' } };
    const r = await t.save(b.id, b.cron, typeof b.description === 'string' ? b.description : '');
    return { status: r.status, body: { error: r.error, task: r.task } };
  }
  return undefined;
}
