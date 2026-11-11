import { OWNER_CAP, OWNER } from './config.ts';
import { WAITING_LINE, REPORT_NUDGE, STALL_MS, outcomeOf } from './workercontract.ts';
export { NATIVE_FOOTER, REPORT_NUDGE, WAITING_LINE, STALL_MS } from './workercontract.ts';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { closeSync, constants, existsSync, mkdirSync, openSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { basename, join } from 'node:path';
import { cleanEnv } from './config.ts';
import { classify, type NativeState, type WorkRow } from './work.ts';
import type { Approval, NativeWorkerRow, Store } from './store.ts';
import type { Log } from './log.ts';
import { lastAssistantText, lastTurnMessages } from './transcript.ts';
import { FRESH_WRITE_MS, holdersIn, lastModel, processTable, sessionName, tailOf, type Holder } from './resume.ts';

// Claude Code background sessions (`claude --bg`) as Jarvis's own workers (Jarvis 2.0, stage B).
// jarvisd starts one, the session's hooks post back here over http (a permission prompt becomes an Approve card, each
// turn's last message becomes the report), `claude agents` tells us whether it lives, and a reply goes in through a
// short-lived Claude session, because SendMessage from another session is the only way into a running background one.
// Background sessions are a research preview. The output shapes parsed here were checked live on 2026-11-06 (2.1.316).
// No version is pinned: the first start checks that `claude` has every command and option the driver runs
// (missingFeatures), and each parse below fails with its own message when a shape changes.

export type { NativeState } from './work.ts';
export type NativeWorker = {
  /** The short id `claude --bg` printed, e.g. "deabc023". */
  id: string;
  /** The full uuid once `claude agents` lists it. */
  session_id: string | null;
  /** `--name`, unique per worker: "<slug>-<approval id>". */
  name: string;
  cwd: string;
  approval_id: number | null;
  state: NativeState;
  /** `claude agents` waitingFor, or the pending permission's one-line summary. */
  waiting_for: string | null;
  /** The last Stop hook's last_assistant_message, word for word. */
  report: string | null;
  report_at: string | null;
  /** Set when a report's first line starts with DONE or FAILED, or the session failed. */
  outcome: 'done' | 'failed' | null;
  /** transcript_path from the first hook, else computed from cwd and session_id. */
  transcript: string | null;
  created_at: string; updated_at: string;
  /** interactive (the default since 2026-11-07): a detached pseudo-terminal session jarvisd types into, with the Artifact tool. background: `claude --bg`, the opt-out and the fallback. */
  kind: 'background' | 'interactive';
  /** The interactive session's process group, for stopping it. */
  pgid: number | null;
  /** Interactive: the folder the start ran in. `cwd` is the session's real folder (its worktree once the listing names it). */
  repo: string | null;
  /** Interactive: the flags a resume replays. */
  model: string | null; permission_mode: string | null;
  resumes: number; last_resume_at: string | null;
  /** Interactive: the named pipe its terminal reads as stdin, so jarvisd can type into it. */
  in_fifo: string | null;
  /** Continue on phone: the Remote Control name the session runs with. A resume keeps it, and the idle reaper leaves the row alone. */
  remote: string | null;
};
/** What Continue on phone did: the row it runs as, or why not and which processes hold the session. */
export type PhoneResult = { ok: true; worker: NativeWorker; already?: boolean } | { ok: false; error: string; holders?: Holder[] };
/** The permission modes an adopted session keeps from its transcript. Anything else (bypassPermissions) becomes default. */
const KEPT_MODES = new Set(['auto', 'default', 'acceptEdits', 'plan']);
export type ClaudeRun = { code: number | null; out: string; err: string };
export type Claude = (args: string[], cwd?: string) => Promise<ClaudeRun>;

/** A work-list row id is `n:<short id>`. */
export const ROW_PREFIX = 'n:';
/** The `claude` options the driver passes: starts, resumes, the relay, Continue on phone and the Desktop button. */
export const NEEDED_OPTIONS = ['--bg', '--name', '--settings', '--permission-mode', '--model', '--worktree', '--resume', '--remote-control', '--desktop',
  '--print', '--output-format', '--tools', '--strict-mcp-config', '--mcp-config'];
/** The `claude` commands the driver runs on background sessions. */
export const NEEDED_COMMANDS = ['agents', 'attach', 'respawn', 'rm', 'stop'];
/** `claude agents --json --all` is the liveness listing every poll reads. */
export const NEEDED_AGENT_OPTIONS = ['--json', '--all'];

/** True when `help` defines `flag` on an option line ("  -n, --name <name>", "  --bg, --background"), not only names it in a description. */
const hasOption = (help: string, flag: string) => new RegExp(`^\\s+(?:-\\w,\\s+)?(?:--[\\w-]+,\\s+)*${flag}(?![\\w-])`, 'm').test(help);
/** True when the Commands section of `help` lists `cmd`, alone or as one of its names ("  stop|kill <id>"). */
const hasCommand = (help: string, cmd: string) => {
  const at = help.search(/^Commands:/m);
  return at >= 0 && new RegExp(`^\\s+(?:[\\w-]+\\|)*${cmd}(?:\\|[\\w-]+)*(?:\\s|$)`, 'm').test(help.slice(at));
};
/**
 * What the driver needs and this Claude Code lacks, from `claude --help` and `claude agents --help`. Empty when it has
 * everything. A check of what is used, not of a version number, so an update that keeps these passes with no warning.
 */
export function missingFeatures(help: string, agentsHelp: string): string[] {
  return [
    ...NEEDED_OPTIONS.filter(f => !hasOption(help, f)).map(f => `the ${f} option`),
    ...NEEDED_COMMANDS.filter(c => !hasCommand(help, c)).map(c => `the claude ${c} command`),
    ...(hasCommand(help, 'agents') ? NEEDED_AGENT_OPTIONS.filter(f => !hasOption(agentsHelp, f)).map(f => `the claude agents ${f} option`) : []),
  ];
}
export const DEFAULT_MODEL = 'claude-opus-5-5';
export const RELAY_MODEL = 'claude-haiku-5-5';
/** The short-lived session that carries a reply in. The worker sees its messages as coming from this name. */
export const RELAY_NAME = 'jarvis-brain-relay';
export const DENY_MESSAGE = `${OWNER_CAP} denied it from the Jarvis app`;
/**
 * The backstop for a turn whose Stop hook never reached jarvisd (a restart): a done turn without a DONE or FAILED line is
 * reported to the brain once the report is this old. A Stop hook that arrives settles the turn at once (stopHook).
 */
export const SILENT_DONE_MS = 2 * 60_000;
/** The state key that says a worker's report at this time needs no silent-turn notice: it was a pause, or the notice went out. */
const quietKey = (id: string) => `nativeQuiet:${id}`;
/**
 * The state key that holds the report time of a WAITING line that waits on the owner: no background task, no scheduled
 * wake-up and no ask to the brain in that turn. Worker 5361 (2026-11-11): its ask was answered "you sign in later", it
 * ended on WAITING, and its row showed a spinner for 4 hours.
 */
const ownerWaitKey = (id: string) => `nativeOwnerWait:${id}`;
/** The state key that holds a follow-up turn's FAILED report on a worker that already reported DONE: `{ text, at, outcome }`. */
const followUpKey = (id: string) => `nativeFollowUp:${id}`;
/** The follow-up result kept beside a done story, or undefined. */
export function followUpOf(store: Pick<Store, 'getState'>, id: string): { text: string; at: string; outcome: 'failed' } | undefined {
  try { const v = JSON.parse(store.getState(followUpKey(id)) || 'null'); return v && typeof v.text === 'string' ? v : undefined; } catch { return undefined; }
}
/** The first line of a report, for a one-line note. */
const firstLine = (s: string) => (s.trim().split('\n')[0] ?? '').slice(0, 200);
/** The words after "WAITING:" on the report's first line, for the row's note and the check's finding. */
export const waitingText = (report: string) => (report.trim().split('\n')[0] ?? '').replace(WAITING_LINE, '').trim().slice(0, 200) || 'Waiting';
/** At most this many REPORT_NUDGE blocks per worker in this window, whatever Claude Code says about the chain. */
const NUDGE_MAX = 3, NUDGE_WINDOW_MS = 10 * 60_000;
/** The state key that holds the activity time of the last stall told, so a jarvisd restart does not tell the same stall twice. */
const stallKey = (id: string) => `nativeStall:${id}`;
/** What the brain hears about a stuck worker (stalledFrom). It names the next step, so a night notice is not answered SILENT. */
export const stalledText = (w: Pick<NativeWorker, 'name' | 'report'>, idleMs: number) => `Worker ${w.name} is stuck: its task is unfinished and it wrote nothing for ${Math.round(idleMs / 60_000)} min. Its last report: ${JSON.stringify((w.report ?? '(none)').slice(0, 300))}. It may wait on something that never comes, such as a helper session it started. Nudge it now: tell it to stop waiting, check what it waits on, then finish the task or report FAILED. Tell ${OWNER} in one sentence.`;
/** What the brain hears about a turn that ended with no DONE or FAILED line. vault/CLAUDE.md matches its start. */
const silentText = (w: Pick<NativeWorker, 'name' | 'report'>) => `Worker ${w.name} ended its turn without a DONE or FAILED line. Its last words: ${(w.report ?? '').slice(0, 300)}`;
/** Finished workers leave the work list after this. */
export const ROW_MAX_AGE_MS = 24 * 3_600_000;
const SESSION_WAIT_MS = 15_000, RESPAWN_WAIT_MS = 60_000, TICK_MS = 500;
/** An interactive session that died by accident is resumed at most this many times in this window, then the row fails until a message asks again. */
export const RESUME_MAX = 3, RESUME_WINDOW_MS = 10 * 60_000;
/** An interactive session that reported DONE or FAILED, or waits on an ask, and sat idle this long has its process ended; a message resumes it. */
export const IDLE_REAP_MS = 3_600_000;
export const IDLE_STOPPED = 'Idle, resumes on a message';
export const DESKTOP_WAITING = 'Open in the Claude desktop app';
/** The first message of a resumed session whose task was unfinished when its terminal died. */
export const NUDGE = 'Your terminal was restarted by Jarvis. Continue the task from where you stopped. Check the result of your last action before repeating it. Report DONE or FAILED as before.';


/** The settings file every background worker starts with: its hooks point at jarvisd. */
export function workerSettings(jarvisUrl: string): object {
  const hook = (path: string, timeout: number) => ({ hooks: [{ type: 'http', url: `${jarvisUrl}/api/hooks/${path}`, timeout }] });
  return {
    crossSessionInbound: 'accept',
    dialogExpiry: 'never',
    permissions: { deny: ['AskUserQuestion'] },
    hooks: {
      PermissionRequest: [hook('permission', 86_400)],
      Stop: [hook('stop', 30)],
      PreToolUse: [{ matcher: 'AskUserQuestion', ...hook('pre', 30) }],
    },
  };
}

const ALLOW = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } };
const DENY = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: DENY_MESSAGE } } };
const NO_ASK = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Ask Jarvis with SendMessage instead' } };

/** One line that says what the tool wants to do, for the card and the row. */
export function summarize(tool: string, input: any): string {
  if (tool === 'Bash' && typeof input?.command === 'string') return input.command;
  if ((tool === 'Edit' || tool === 'Write') && typeof input?.file_path === 'string') return input.file_path;
  return JSON.stringify(input ?? {}).slice(0, 200);
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const ago = (ms: number) => ms < 3_600_000 ? `${Math.max(1, Math.round(ms / 60_000))} min ago` : ms < 172_800_000 ? `${Math.round(ms / 3_600_000)} h ago` : `${Math.round(ms / 86_400_000)} d ago`;

/**
 * When a finished row finished, in ms: its DONE or FAILED report, else its last change. The report time does not move when
 * the reaper stops the session an hour later, so the row leaves the list a day after the report, no later than its request
 * (requests.ts DONE_KEEP_MS, counted from the request's done time, which follows the report). Counted from the last change,
 * the row outlived its request by that hour and fell into its group's Done fold.
 */
export function finishedAt(w: Pick<NativeWorker, 'outcome' | 'report_at' | 'updated_at'>): number {
  return Date.parse(w.outcome && w.report_at ? w.report_at : w.updated_at);
}

/**
 * The work-list state of a native worker. A session Jarvis stopped itself (the idle reaper, the desktop handoff) did not
 * exit: it waits on the owner when an ask is open, and is idle otherwise. As `exited` the request layer read it as failed
 * (requests.ts statusOf), so a worker waiting on an ask was reported failed. Only a stop or a death keeps `exited`.
 */
export function rowState(w: Pick<NativeWorker, 'state' | 'waiting_for'>, asking: boolean): WorkRow['state'] {
  if (w.state === 'blocked') return 'waiting';
  if (w.state === 'working' || w.state === 'starting') return asking ? 'waiting' : 'working';
  if (asking && (w.state === 'done' || w.state === 'stopped')) return 'waiting';
  if (w.state === 'done') return 'idle';
  if (w.state === 'stopped' && (w.waiting_for === IDLE_STOPPED || w.waiting_for === DESKTOP_WAITING)) return 'idle';
  return 'exited';
}

export function runClaude(args: string[], cwd?: string): Promise<ClaudeRun> {
  return new Promise(resolve => execFile('claude', args, { cwd, env: { ...cleanEnv, HOME: process.env.HOME }, timeout: 10 * 60_000, maxBuffer: 20 * 1024 * 1024 },
    (err, out, errOut) => resolve({ code: err ? (err as any).code ?? 1 : 0, out: String(out), err: String(errOut) })));
}

/**
 * Starts `claude` in a pseudo-terminal that outlives jarvisd: `script` gives the tty and the group is detached. Its stdin is
 * a reader loop on the named pipe `fifo` (`while :; do cat fifo; done`), which blocks while nothing writes, so the terminal
 * sits open and silent, and jarvisd can type into the session by writing to the pipe. Without a pipe, `tail -f /dev/null`
 * keeps stdin open as before. The brief rides in as `$0` of the shell, so no quoting touches it. Returns the group id.
 */
export function runPty(argv: string[], cwd: string, fifo?: string): number {
  const quoted = argv.slice(0, -1).map(x => `'${x.replace(/'/g, `'\\''`)}'`).join(' ');
  const stdin = fifo ? 'while :; do cat "$1"; done' : 'tail -f /dev/null';
  const p = spawn('sh', ['-c', `${stdin} | exec script -q /dev/null ${quoted} "$0"`, argv[argv.length - 1], ...(fifo ? [fifo] : [])],
    { cwd, env: { ...cleanEnv, HOME: process.env.HOME }, detached: true, stdio: 'ignore' });
  p.on('error', () => {});
  p.unref();
  return p.pid!;
}

/** Creates the named pipe, replacing a stale one of the same name. */
export function makeFifo(path: string): void {
  try { unlinkSync(path); } catch {}
  execFileSync('mkfifo', [path]);
}

/**
 * The bytes that type `text` into Claude Code's prompt: a bracketed paste (ESC[200~ … ESC[201~), so newlines stay inside
 * one message, then a carriage return to send it. Escape bytes in the text are dropped (they would end the paste early);
 * a carriage return in it becomes a newline. Probed live on 2026-11-07: one `user` turn with the newlines intact, 32 ms
 * from write to transcript; typed while a turn runs, the text is queued and folded into that turn (`queue-operation`,
 * then an `attachment` of type `queued_command`), and the model answers it in the same message.
 */
export function typedBytes(text: string): Buffer {
  const clean = text.replace(/\r\n?/g, '\n').replace(/\x1b/g, '');
  return Buffer.from(`\x1b[200~${clean}\x1b[201~\r`, 'utf8');
}

/**
 * Writes to the session's stdin pipe. Opened non-blocking so a pipe with no reader (the terminal is gone) fails at once
 * with ENXIO instead of hanging; a full pipe (EAGAIN) is retried for up to about three seconds. Throws on failure.
 */
export function writeFifo(fifo: string, bytes: Buffer): void {
  const fd = openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK);
  try {
    let off = 0;
    const until = Date.now() + 3_000;
    while (off < bytes.length) {
      try { off += writeSync(fd, bytes, off, bytes.length - off); }
      catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EAGAIN' || Date.now() >= until) throw e;
        const t = Date.now() + 50; while (Date.now() < t) { /* spin 50 ms: the pipe reader drains it in far less */ }
      }
    }
  } finally { closeSync(fd); }
}

/** Claude Code's folder under ~/.claude/projects for a cwd: every character outside [A-Za-z0-9] becomes a dash. */
export const projectDir = (cwd: string) => cwd.replace(/[^A-Za-z0-9]/g, '-');

type Agent = { id?: string; kind?: string; sessionId?: string; name?: string; pid?: number; status?: string; state?: string; waitingFor?: string; cwd?: string };

export function makeNative(o: {
  store: Store; log: Log; jarvisUrl: string;
  /** data/, where worker-settings.json is written at makeNative time. */
  dataDir: string;
  onChange: (w: NativeWorker) => void;
  /** A Stop hook was stored; `final` when it set the outcome. */
  onReport: (w: NativeWorker, text: string, final: boolean, followUp?: boolean) => void;
  /** A worker-permission approval was created or decided. */
  onCard: (a: Approval) => void;
  /** A liveness finding for the brain: failed, blocked with no card, done without a DONE line. */
  onNotice: (w: NativeWorker, text: string) => void;
  claude?: Claude; now?: () => number;
  /** Test seams for interactive sessions: start the detached pseudo-terminal (returns its pgid), end a process group, make the stdin pipe. */
  spawnPty?: (argv: string[], cwd: string, fifo?: string) => number;
  killGroup?: (pgid: number) => void;
  mkfifo?: (path: string) => void;
  /** Whether the terminal's process group leader still answers `kill -0`; and ending one process (the Desktop handoff's). */
  alivePgid?: (pgid: number) => boolean;
  killPid?: (pid: number) => void;
  /** Typing into an interactive session's stdin pipe (throws when it cannot). */
  writeFifo?: (fifo: string, bytes: Buffer) => void;
  /** Continue on phone: `ps -axo pid=,command=` lines, a transcript's last write time and its tail. */
  processes?: () => Promise<string[]>;
  written?: (file: string) => number;
  tail?: (file: string) => string;
}) {
  const { store, log } = o;
  const claude = o.claude ?? runClaude;
  const spawnPty = o.spawnPty ?? runPty;
  const killGroup = o.killGroup ?? ((pgid: number) => { try { process.kill(-pgid, 'SIGTERM'); } catch {} });
  const mkfifo = o.mkfifo ?? makeFifo;
  const alivePgid = o.alivePgid ?? ((pgid: number) => { try { process.kill(pgid, 0); return true; } catch { return false; } });
  const killPid = o.killPid ?? ((pid: number) => { try { process.kill(pid, 'SIGTERM'); } catch {} });
  const typeInto = o.writeFifo ?? writeFifo;
  const processes = o.processes ?? processTable;
  const written = o.written ?? ((f: string) => statSync(f).mtimeMs);
  const tail = o.tail ?? ((f: string) => tailOf(f));
  // Sessions a Continue on phone press is under way for, so a double tap cannot start two terminals.
  const phoning = new Set<string>();
  const now = o.now ?? Date.now;
  const iso = () => new Date(now()).toISOString();
  const settingsPath = join(o.dataDir, 'worker-settings.json');
  writeFileSync(settingsPath, JSON.stringify(workerSettings(o.jarvisUrl), null, 2) + '\n');
  // One named pipe per interactive terminal, `data/pty/<name>-r<resumes>.in`.
  const ptyDir = join(o.dataDir, 'pty');
  mkdirSync(ptyDir, { recursive: true });
  const fifoFor = (name: string, resumes: number) => { const f = join(ptyDir, `${name}-r${resumes}.in`); mkfifo(f); return f; };
  // Permission prompts held open: approval id to the resolver of the hook's http reply.
  const held = new Map<number, { worker: string; resolve: (reply: object) => void }>();
  // Workers the last poll found stuck (stalledFrom), and the time their last activity was. rows() shows it; the ten-minute check reports it.
  const stalled = new Map<string, number>();
  // Liveness findings already told, `<id>:<kind>`, cleared when the condition goes away.
  const noticed = new Set<string>();
  // Workers sent back with REPORT_NUDGE in the current chain of their turn, and when, for the cap.
  const nudgedChain = new Set<string>();
  const nudgeTimes = new Map<string, number[]>();
  /** The report needs no silent-turn notice: it was a pause, or the brain was told. */
  const quiet = (w: Pick<NativeWorker, 'id' | 'report_at'>) => !!w.report_at && !!store.getState(quietKey(w.id))?.endsWith(`:${w.report_at}`);
  /** The last report was a pause (a WAITING line, an ask, a background task): the worker still has its task. */
  const paused = (w: Pick<NativeWorker, 'id' | 'report_at'>) => !!w.report_at && store.getState(quietKey(w.id)) === `pause:${w.report_at}`;
  // From the last `claude agents` listing: the ids whose process is alive.
  let alive = new Set<string>();
  let featuresOk = false;
  // Accidental resumes per interactive worker, for the backoff; and when each one was first seen idle, for the reaper.
  const resumeTimes = new Map<string, number[]>();
  // Resumes under way, so an overlapping poll does not start a second one.
  const resuming = new Set<string>();
  // Interactive rows seen once at a permission prompt jarvisd holds no card for; a second sighting ends and resumes them.
  const stuckSeen = new Map<string, number>();
  let polling = false;
  let replySeq = 0;

  const asWorker = (r: NativeWorkerRow): NativeWorker => ({ ...r, state: r.state as NativeState, outcome: r.outcome as NativeWorker['outcome'], kind: r.kind === 'interactive' ? 'interactive' : 'background' });
  const row = (id: string) => { const r = store.nativeWorker(id); return r ? asWorker(r) : undefined; };
  const find = (key: string): NativeWorker | undefined => {
    if (!key) return undefined;
    const id = key.startsWith(ROW_PREFIX) ? key.slice(ROW_PREFIX.length) : key;
    return row(id) ?? store.nativeWorkers().map(asWorker).find(w => w.session_id === key);
  };
  const update = (id: string, f: Partial<Omit<NativeWorkerRow, 'id' | 'name' | 'created_at'>>): NativeWorker => {
    store.updateNativeWorker(id, { ...f, updated_at: iso() });
    const w = row(id)!;
    o.onChange(w);
    return w;
  };
  /**
   * The words the work list sorts a row by: the task title and spec the owner approved. The name is only their slug, which
   * drops the "#" of "#4886 Check the price", so classify put every story worker in Other. A row with no start card (a
   * session continued on the phone) falls back to its name.
   */
  const taskOf = (w: NativeWorker): { title: string; spec?: string } => {
    const a = w.approval_id ? store.approval(w.approval_id) : undefined;
    let args: any;
    try { args = a ? JSON.parse(a.args) : undefined; } catch {}
    return typeof args?.taskTitle === 'string' && args.taskTitle.trim()
      ? { title: args.taskTitle, spec: typeof args.spec === 'string' ? args.spec : undefined }
      : { title: w.name };
  };
  const pendingCard = (id: string) => [...held.values()].some(h => h.worker === id);
  /** A task still under way: the only state a dead terminal is resumed from on its own, and the one that gets the nudge. */
  const unfinished = (w: NativeWorker) => ['starting', 'working', 'blocked'].includes(w.state) && !w.outcome;
  /** When a finished session, or one waiting on an ask, started idling: the latest of its last report, its last resume and its newest open ask. Undefined when it is neither. */
  const idleFrom = (w: NativeWorker): number | undefined => {
    const asks = store.openItems().filter(i => i.source === 'native' && i.dispatch_id === `${ROW_PREFIX}${w.id}`);
    if (!w.outcome && !asks.length) return undefined;
    const times = [w.report_at, w.last_resume_at, ...asks.map(i => i.created_at.replace(' ', 'T') + (i.created_at.includes('Z') ? '' : 'Z'))].filter((t): t is string => !!t).map(t => Date.parse(t)).filter(t => !Number.isNaN(t));
    return times.length ? Math.max(...times) : undefined;
  };
  /**
   * Its last turn ended on a WAITING line that only the owner ends (stopHook: no background task, no scheduled wake-up,
   * no ask), and no report came since. An open ask shows as the ask instead (rows).
   */
  const waitsOnOwner = (w: NativeWorker) => w.state === 'working' && !w.outcome && !!w.report_at
    && store.getState(ownerWaitKey(w.id)) === w.report_at;
  /**
   * When a stuck worker last did anything, or undefined when it is not stuck. Stuck: its task is unfinished, it is not a
   * conversation (a side chat, a phone session), no ask or permission card of its own waits on the owner, and nothing
   * happened for STALL_MS: no start, report or resume, and no write to its transcript. A worker idle on a WAITING line counts,
   * and so does a busy one whose tool hangs. With no transcript to read, a busy worker is never called stuck.
   * Worker 579 (2026-11-11): "working" for 8 hours on a WAITING line, and nothing told anyone.
   */
  const stalledFrom = (w: NativeWorker, a: Agent | undefined): number | undefined => {
    if (!unfinished(w) || w.state === 'blocked' || w.remote || pendingCard(w.id)) return undefined;
    // A worker that waits on the owner is not stuck, and nudging it does nothing. The check repeats its finding instead.
    if (waitsOnOwner(w)) return undefined;
    if (w.approval_id && store.approval(w.approval_id)?.action === 'side-chat') return undefined;
    if (store.openItems().some(i => i.source === 'native' && i.dispatch_id === `${ROW_PREFIX}${w.id}`)) return undefined;
    let wrote: number | undefined;
    const file = api.transcriptFile(w.id);
    try { if (file) wrote = written(file); } catch {}
    if (wrote === undefined && a?.status === 'busy') return undefined;
    const last = Math.max(...[w.created_at, w.report_at, w.last_resume_at].filter((t): t is string => !!t).map(t => Date.parse(t)).filter(t => !Number.isNaN(t)), wrote ?? 0);
    return now() - last >= STALL_MS ? last : undefined;
  };
  /** Closes the permission cards held for a worker whose process is gone: nothing can answer that hook any more. */
  const failHeld = (id: string, reason: string) => {
    for (const [approvalId, h] of [...held]) {
      if (h.worker !== id) continue;
      store.decide(approvalId, 'failed', 'automatic');
      store.finishApproval(approvalId, 'failed', reason);
      held.delete(approvalId);
      h.resolve({});
      o.onCard(store.approval(approvalId)!);
    }
  };

  async function agents(): Promise<Agent[]> {
    const r = await claude(['agents', '--json', '--all']);
    try { const list = JSON.parse(r.out); return Array.isArray(list) ? list : []; } catch { log('native: agents listing unreadable', { out: r.out.slice(0, 200), err: r.err.slice(0, 200) }); return []; }
  }
  // An interactive session is listed by its full session id (no short id); a running one also by its name while it has no session id yet.
  // Two entries can share a session (a dead terminal's and the resumed one's): the one with a pid is the live one.
  const listed = (list: Agent[], w: NativeWorker) => {
    const mine = list.filter(a => w.kind === 'interactive'
      ? (w.session_id ? a.sessionId === w.session_id : a.kind === 'interactive' && a.name === w.name && !!a.pid)
      : a.id === w.id || (!!w.session_id && a.sessionId === w.session_id));
    return mine.find(a => !!a.pid) ?? mine[0];
  };
  /**
   * An interactive session's liveness from `status` (busy, waiting, idle) while its process lives; nothing once it is gone.
   * Idle after a DONE or FAILED that is still its last report is that outcome again: a busy spell with no new turn (a
   * resume or a compaction) left 5276-keep-the-muse-digest "working" in Stories for good (2026-11-09).
   */
  const interactiveState = (a: Agent | undefined, w: NativeWorker): NativeState | undefined =>
    !a?.pid ? undefined : a.status === 'busy' ? 'working' : a.status === 'waiting' ? 'blocked' : w.remote && a.status === 'idle' ? 'done'
      : w.outcome ? (a.status === 'idle' && outcomeOf(w.report ?? '') === w.outcome ? w.outcome : w.state) : w.report && !paused(w) ? 'done' : 'working';

  /** Polls `claude agents` until `ok(entry)` holds for the worker, or the time is up. */
  async function waitFor(w: NativeWorker, ok: (a: Agent) => boolean, ms: number): Promise<Agent | undefined> {
    const until = now() + ms;
    for (;;) {
      const a = listed(await agents(), w);
      if (a && ok(a)) return a;
      if (now() >= until) return undefined;
      await sleep(TICK_MS);
    }
  }

  /**
   * Before the first start: does this `claude` have every command and option the driver runs? Throws with the missing
   * ones named, so the start fails with that reason instead of a parse error later. Only a pass is remembered, so an
   * update of Claude Code is picked up at the next start with no jarvisd restart.
   */
  async function checkClaude() {
    if (featuresOk) return;
    const [v, help, agentsHelp] = await Promise.all([claude(['--version']), claude(['--help']), claude(['agents', '--help'])]);
    const version = v.out.trim() || 'of unknown version';
    const text = (r: ClaudeRun) => `${r.out}\n${r.err}`;
    if (!/^Commands:/m.test(text(help))) {
      log('native: claude --help unreadable', { version, code: help.code, out: help.out.slice(0, 200), err: help.err.slice(0, 200) });
      throw new Error(`Jarvis could not read \`claude --help\` (exit ${help.code}), so it cannot check that Claude Code ${version} has what native workers need.`);
    }
    const missing = missingFeatures(text(help), text(agentsHelp));
    if (missing.length) {
      log('native: claude lacks what the driver needs', { version, missing });
      throw new Error(`Claude Code ${version} lacks ${missing.join(', ')}, which Jarvis's native workers need. Update Claude Code (claude update), then start the worker again.`);
    }
    featuresOk = true;
    log('native: claude has what the driver needs', { version });
  }

  const api = {
    async start(a: { name: string; cwd: string; brief: string; model?: string; permissionMode?: 'auto' | 'default'; approvalId?: number; worktree?: boolean; interactive?: boolean }): Promise<NativeWorker> {
      await checkClaude();
      if (a.interactive) return startInteractive(a);
      const args = ['--bg', '--name', a.name, '--permission-mode', a.permissionMode ?? 'auto', '--model', a.model ?? DEFAULT_MODEL,
        '--settings', settingsPath, ...(a.worktree ? ['-w', a.name] : []), a.brief];
      const r = await claude(args, a.cwd);
      const m = r.out.match(/backgrounded\s*·\s*([\w-]+)\s*·/);
      if (!m) {
        log('native worker failed to start', { name: a.name, approval: a.approvalId ?? null, code: r.code, out: r.out.slice(0, 300), err: r.err.slice(0, 300) });
        throw new Error(`claude --bg did not start: ${(r.err || r.out).trim().slice(0, 300) || `exit ${r.code}`}`);
      }
      const id = m[1];
      const t = iso();
      store.addNativeWorker({ id, session_id: null, name: a.name, cwd: a.cwd, approval_id: a.approvalId ?? null, state: 'starting',
        waiting_for: null, report: null, report_at: null, outcome: null, transcript: null, created_at: t, updated_at: t });
      const seen = await waitFor(row(id)!, x => !!x.sessionId, SESSION_WAIT_MS);
      const w = update(id, { session_id: seen?.sessionId ?? null, state: seen?.state === 'failed' ? 'failed' : 'working' });
      log('native worker started', { worker: id, session: w.session_id, name: a.name, approval: a.approvalId ?? null, cwd: a.cwd });
      return w;
    },

    async stop(id: string): Promise<void> {
      const w = find(id); if (!w) throw new Error(`no worker ${id}`);
      if (w.kind === 'interactive') { if (w.pgid) killGroup(w.pgid); alive.delete(w.id); update(w.id, { state: 'stopped', waiting_for: null }); log('native worker stopped', { worker: w.id, pgid: w.pgid }); return; }
      const r = await claude(['stop', w.id]);
      update(w.id, { state: 'stopped', waiting_for: null });
      log('native worker stopped', { worker: w.id, code: r.code });
    },

    async abandon(id: string): Promise<void> {
      const w = find(id); if (!w) throw new Error(`no worker ${id}`);
      if (w.kind === 'interactive') { if (w.pgid) killGroup(w.pgid); alive.delete(w.id); update(w.id, { state: 'abandoned', waiting_for: null }); log('native worker abandoned', { worker: w.id }); return; }
      await claude(['stop', w.id]);
      const r = await claude(['rm', w.id]);
      update(w.id, { state: 'abandoned', waiting_for: null });
      log('native worker abandoned', { worker: w.id, code: r.code });
    },

    async respawn(id: string): Promise<void> {
      const w = find(id); if (!w) throw new Error(`no worker ${id}`);
      if (w.kind === 'interactive') { await api.resume(w.id, 'a message arrived', { force: true, quiet: true, takeOver: w.waiting_for === DESKTOP_WAITING }); return; }
      const r = await claude(['respawn', w.id]);
      const seen = await waitFor(w, a => !!a.pid, RESPAWN_WAIT_MS);
      if (seen) alive.add(w.id);
      update(w.id, { state: seen ? 'working' : w.state, session_id: seen?.sessionId ?? w.session_id });
      log('native worker respawned', { worker: w.id, code: r.code, alive: !!seen, out: r.out.trim().slice(0, 120) });
      if (!seen) throw new Error(`claude respawn ${w.id}: not listed alive after ${RESPAWN_WAIT_MS / 1000} s (${(r.err || r.out).trim().slice(0, 200)})`);
    },

    /**
     * The same conversation in a new pseudo-terminal, in the stored folder (its worktree) with the stored model and permission
     * mode. Refuses while another process is listed on the session (two writers branch a transcript), unless `takeOver`
     * (a message after the Desktop handoff), which ends that process first. An accidental death gets the backoff
     * (RESUME_MAX in RESUME_WINDOW_MS, then the row fails until a message asks with `force`). A task that was unfinished
     * gets NUDGE as the resumed session's first message. Returns false when the backoff refused.
     */
    async resume(id: string, reason: string, opt: { force?: boolean; takeOver?: boolean; quiet?: boolean } = {}): Promise<boolean> {
      const w = find(id); if (!w) throw new Error(`no worker ${id}`);
      if (w.kind !== 'interactive') throw new Error(`${w.name} is a background session; respawn applies`);
      if (!w.session_id) throw new Error('This worker has no session id to resume.');
      if (resuming.has(w.id)) throw new Error('a resume is already under way');
      resuming.add(w.id);
      try {
        const other = (await agents()).find(a => a.sessionId === w.session_id && !!a.pid);
        if (other) {
          if (!opt.takeOver) throw new Error(`another process (pid ${other.pid}) holds session ${w.session_id}; not resumed, two writers would branch it`);
          killPid(other.pid!);
          log('native resume: took the session back from another process', { worker: w.id, pid: other.pid, reason });
          const until = now() + 10_000;
          while ((await agents()).some(a => a.sessionId === w.session_id && !!a.pid)) { if (now() >= until) throw new Error(`pid ${other.pid} still holds session ${w.session_id}`); await sleep(TICK_MS); }
        }
        if (w.pgid && alivePgid(w.pgid)) killGroup(w.pgid);
        if (!opt.force) {
          const times = (resumeTimes.get(w.id) ?? []).filter(t => now() - t < RESUME_WINDOW_MS);
          if (times.length >= RESUME_MAX) {
            resumeTimes.set(w.id, times);
            failHeld(w.id, `the worker's terminal died before ${OWNER} answered`);
            const next = update(w.id, { state: 'failed', waiting_for: `Died ${RESUME_MAX} times in ${RESUME_WINDOW_MS / 60_000} minutes; a message resumes it` });
            noticed.add(`${w.id}:failed`);
            log('native worker died too often, not resumed', { worker: w.id, reason, deaths: times.length });
            o.onNotice(next, `Worker ${w.name} died ${RESUME_MAX} times in ${RESUME_WINDOW_MS / 60_000} minutes and was not resumed again (${reason}). A message to it resumes it once more.`);
            return false;
          }
          times.push(now());
          resumeTimes.set(w.id, times);
        }
        const nudge = unfinished(w);
        failHeld(w.id, `the worker's terminal died before ${OWNER} answered`);
        const resumes = w.resumes + 1;
        const fifo = fifoFor(w.name, resumes);
        const pgid = spawnPty(['claude', '--resume', w.session_id, '--name', w.name, ...(w.remote ? [`--remote-control=${w.remote}`] : []), '--permission-mode', w.permission_mode ?? 'auto', '--model', w.model ?? DEFAULT_MODEL,
          '--settings', settingsPath, ...(nudge ? [NUDGE] : [])], w.cwd, fifo);
        update(w.id, { pgid, in_fifo: fifo, resumes, last_resume_at: iso(), waiting_for: null });
        const seen = await waitFor(row(w.id)!, a => !!a.pid, RESPAWN_WAIT_MS);
        if (seen) alive.add(w.id);
        update(w.id, { state: seen ? 'working' : w.state });
        log('native worker resumed', { worker: w.id, reason, pgid, resumes, nudge, alive: !!seen, cwd: w.cwd, model: w.model, mode: w.permission_mode });
        if (!seen) throw new Error(`the resumed session was not listed alive after ${RESPAWN_WAIT_MS / 1000} s`);
        const line = `Worker ${w.name} was resumed in a new terminal (${reason})`;
        store.insertItem({ source: 'native', external_id: `event:${w.id}:${now()}`, kind: 'event', dispatch_id: `${ROW_PREFIX}${w.id}`, body: line, status: 'done' });
        if (!opt.quiet) o.onNotice(row(w.id)!, line);
        return true;
      } finally { resuming.delete(w.id); }
    },

    /**
     * Continue on phone: the same session, by its own id, in a native interactive terminal with `--remote-control=<title>`,
     * so the Claude app reaches it and the work list keeps it as an `n:` row. Never `claude --bg --resume` with flags: on a
     * background session that keeps saved options, that starts a copy under a new id (approval 434, 2026-11-08, reproduced
     * on 2.1.316). A session jarvisd already runs is ended first and resumed with the flag. Any other process on the session
     * (a terminal, the desktop app, a background host) refuses it and is named, unless its pid is in `stop`:
     * then it is ended first, because two writers on one session lose a turn. No message goes in, so no turn starts.
     */
    async phone(a: { sessionId: string; cwd: string; title: string; transcript?: string; approvalId?: number; stop?: number[] }): Promise<PhoneResult> {
      const sid = a.sessionId;
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(sid)) return { ok: false, error: 'This session has no id Jarvis can resume.' };
      if (phoning.has(sid)) return { ok: false, error: 'Continue on phone is already under way for this session.' };
      phoning.add(sid);
      try {
        await checkClaude();
        let mine = find(sid);
        if (mine && mine.session_id !== sid) mine = undefined;
        const onSession = (list: Agent[]) => list.filter(x => x.sessionId === sid && !!x.pid);
        let list = await agents();
        if (mine?.remote && mine.kind === 'interactive' && !!mine.pgid && alivePgid(mine.pgid) && onSession(list).length) return { ok: true, worker: mine, already: true };
        if (onSession(list).some(x => x.status === 'busy') && mine) return { ok: false, error: 'It is in the middle of a turn. Try again when it is idle, so the turn is not cut off.' };
        const file = (mine && api.transcriptFile(mine.id)) || a.transcript;
        if (mine) {
          // Our own process on it is ended first; it is not a second writer.
          if (mine.kind === 'interactive') { if (mine.pgid && alivePgid(mine.pgid)) killGroup(mine.pgid); }
          else if (onSession(list).length) await claude(['stop', mine.id]);
          alive.delete(mine.id);
          await waitGone(mine, 10_000);
          // Its shell and `script` name the session id too, and leave `ps` a moment after the listing.
          const until = now() + 5_000;
          try { while (holdersIn(await processes(), sid).length && now() < until) await sleep(TICK_MS); } catch {}
          list = await agents();
        } else if (file) {
          let age = Infinity;
          try { age = now() - written(file); } catch {}
          if (age < FRESH_WRITE_MS) return { ok: false, error: 'This session was written to seconds ago. Try again once it settles.' };
        }
        const holders = new Map<number, Holder>();
        // A background session is stopped through its supervisor (`claude stop <id>`), which a bare kill would not tell.
        const viaStop = new Map<number, string>();
        for (const x of onSession(list)) {
          holders.set(x.pid!, { pid: x.pid!, what: `a ${x.kind ?? 'Claude'} session${x.name ? ` named "${x.name}"` : ''}${x.status ? `, ${x.status}` : ''}` });
          if (x.kind === 'background' && x.id) viaStop.set(x.pid!, x.id);
        }
        let table: string[] = [];
        try { table = await processes(); } catch (e) { return { ok: false, error: `Not continued: could not check who else has this session open (${(e as Error).message}).` }; }
        for (const h of holdersIn(table, sid)) if (!holders.has(h.pid)) holders.set(h.pid, h);
        if (holders.size) {
          const stop = new Set(a.stop ?? []);
          const others = [...holders.values()].filter(h => !stop.has(h.pid));
          if (others.length) {
            log('native phone: refused, another process holds the session', { session: sid, holders: others.map(h => h.pid) });
            return { ok: false, error: `Another process has this session open: ${others.map(h => `pid ${h.pid}, ${h.what}`).join('; ')}. Two writers would lose a turn.`, holders: others };
          }
          for (const h of holders.values()) { const bg = viaStop.get(h.pid); if (bg) await claude(['stop', bg]); else killPid(h.pid); }
          log('native phone: ended the processes that held the session', { session: sid, pids: [...holders.keys()] });
          const until = now() + 10_000;
          const still = async () => onSession(await agents()).length > 0 || holdersIn(await processes(), sid).length > 0;
          while (await still()) { if (now() >= until) return { ok: false, error: `The process that held it (pid ${[...holders.keys()].join(', ')}) did not end within 10 s. Nothing was started.` }; await sleep(TICK_MS); }
        }
        let jsonl = '';
        try { if (file) jsonl = tail(file); } catch {}
        const mode = mine?.permission_mode ?? [...jsonl.matchAll(/"permissionMode":"(\w+)"/g)].map(m => m[1]).filter(m => KEPT_MODES.has(m)).pop() ?? 'default';
        const model = mine?.model ?? lastModel(jsonl) ?? DEFAULT_MODEL;
        // The Remote Control name: the caller's title, else the session's own name, else its short id.
        const remote = mine?.remote ?? ((a.title.trim() || sessionName(jsonl) || '').replace(/\s+/g, ' ').trim().slice(0, 80) || sid.slice(0, 8));
        const id = mine?.id ?? sid.slice(0, 8);
        if (!mine && row(id)) return { ok: false, error: `Row ${ROW_PREFIX}${id} already belongs to another session.` };
        const name = mine?.name ?? `${remote.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'session'}-${id}`;
        const cwd = mine?.cwd ?? a.cwd;
        const resumes = mine ? mine.resumes + 1 : 0;
        const fifo = fifoFor(name, resumes);
        const pgid = spawnPty(['claude', '--resume', sid, '--name', name, `--remote-control=${remote}`, '--permission-mode', mode, '--model', model, '--settings', settingsPath], cwd, fifo);
        const t = iso();
        if (mine) update(id, { kind: 'interactive', pgid, in_fifo: fifo, resumes, last_resume_at: t, remote, model, permission_mode: mode, state: 'done', waiting_for: null });
        else {
          store.addNativeWorker({ id, session_id: sid, name, cwd, approval_id: a.approvalId ?? null, state: 'done', waiting_for: null, report: null, report_at: null, outcome: 'done',
            transcript: file ?? null, created_at: t, updated_at: t, kind: 'interactive', pgid, repo: cwd, model, permission_mode: mode, resumes, last_resume_at: t, in_fifo: fifo, remote });
          o.onChange(row(id)!);
        }
        const seen = await waitFor(row(id)!, x => !!x.pid, RESPAWN_WAIT_MS);
        if (!seen) {
          killGroup(pgid);
          update(id, { state: 'stopped', waiting_for: 'Continue on phone did not start' });
          log('native phone: the session was not listed alive', { worker: id, session: sid, pgid });
          return { ok: false, error: `The session did not come up within ${RESPAWN_WAIT_MS / 1000} s. Nothing else holds it now; try again.` };
        }
        alive.add(id);
        const w = update(id, { state: 'done' });
        store.insertItem({ source: 'native', external_id: `event:${id}:${now()}`, kind: 'event', dispatch_id: `${ROW_PREFIX}${id}`, body: `Continued on the phone: Remote Control as "${remote}"`, status: 'done' });
        log('native phone: continued on the phone', { worker: id, session: sid, adopted: !mine, pgid, remote, model, mode, cwd, stopped: [...holders.keys()] });
        return { ok: true, worker: w };
      } finally { phoning.delete(sid); }
    },

    /** The PermissionRequest http hook. Resolves when the owner taps Allow or Deny. */
    permissionRequest(body: any): Promise<object> {
      const w = find(String(body?.session_id ?? ''));
      if (!w) { log('hook from an unknown session', { hook: 'PermissionRequest', session: body?.session_id ?? null }); return Promise.resolve({}); }
      const tool = String(body.tool_name ?? '?');
      const summary = summarize(tool, body.tool_input);
      const a = store.addApproval({ action: 'worker-permission', args: JSON.stringify({ worker: w.id, name: w.name, tool, input: body.tool_input ?? null, summary }), say: `Allow ${tool} in ${w.name}?` });
      update(w.id, { waiting_for: summary, state: 'blocked', ...(body.transcript_path && !w.transcript ? { transcript: body.transcript_path } : {}) });
      log('native permission asked', { worker: w.id, approval: a.id, tool });
      return new Promise(resolve => { held.set(a.id, { worker: w.id, resolve }); o.onCard(a); });
    },

    /** the owner's Allow or Deny button. */
    decide(approvalId: number, allow: boolean): { ok: true } | { ok: false; error: string } {
      const h = held.get(approvalId);
      if (!h) return { ok: false, error: 'This prompt is no longer held: it timed out or jarvisd restarted. The worker was denied.' };
      if (!store.decide(approvalId, allow ? 'approved' : 'rejected', 'button')) return { ok: false, error: 'already decided' };
      store.finishApproval(approvalId, 'done', allow ? 'allowed' : 'denied');
      held.delete(approvalId);
      h.resolve(allow ? ALLOW : DENY);
      update(h.worker, { waiting_for: null, state: 'working' });
      log('native permission answered', { worker: h.worker, approval: approvalId, allow });
      o.onCard(store.approval(approvalId)!);
      return { ok: true };
    },

    /**
     * The Stop http hook: each turn's last message is the report. A turn with no DONE or FAILED line is settled here, at
     * once, never by the clock: a pause (a WAITING line, an ask to the brain, a background task or a scheduled wake-up
     * that Claude Code lists in the hook body) is quiet; a side chat or a phone session is a conversation and is quiet;
     * anything else is sent back once with REPORT_NUDGE (`decision: block`), and if the turn then still ends with no
     * line, the brain hears it right away. Returns the hook's reply.
     */
    stopHook(body: any): object {
      const w = find(String(body?.session_id ?? ''));
      if (!w) { log('hook from an unknown session', { hook: 'Stop', session: body?.session_id ?? null }); return {}; }
      const text = String(body.last_assistant_message ?? '');
      const outcome = outcomeOf(text);
      const transcript = body.transcript_path ?? w.transcript;
      if (outcome === 'failed' && w.outcome === 'done') {
        // A follow-up turn (a steer from the brain or the owner) ended FAILED on a story that already reported DONE. The
        // story stays done with its DONE report; the follow-up result is kept beside it. Worker fe594be3 (4967),
        // 2026-11-11 12:24Z: it refused to change a verdict, correctly, and that FAILED turned the done row red.
        const t = iso();
        store.setState(followUpKey(w.id), JSON.stringify({ text, at: t, outcome }));
        // report_at moves to now: the steer came after the DONE, and requests.ts reopens a request whose report is older
        // than the last message sent to its worker. The report text stays the DONE report.
        const next = update(w.id, { state: 'done', report_at: t, transcript, waiting_for: null });
        log('native follow-up reported failed, the story stays done', { worker: w.id, chars: text.length });
        o.onReport(next, text, true, true);
        return {};
      }
      if (outcome === 'done') store.setState(followUpKey(w.id), '');
      // A stop that is not the answer to a block starts a new chain of the turn: it may be sent back once.
      if (!body.stop_hook_active) nudgedChain.delete(w.id);
      let pause: string | undefined;
      let ownerWait = false;
      if (!outcome) {
        const action = w.approval_id ? store.approval(w.approval_id)?.action : undefined;
        const tasks = Array.isArray(body.background_tasks) ? body.background_tasks.filter((t: any) => !t?.status || t.status === 'running' || t.status === 'pending') : [];
        const crons = Array.isArray(body.session_crons) ? body.session_crons : [];
        let asked = false;
        try { asked = !!transcript && lastTurnMessages(transcript, 'jarvis-brain').some(m => !/^\s*(notice|done|failed)\s*:/i.test(m)); }
        catch (e) { log('native: transcript unreadable at stop', { worker: w.id, error: (e as Error).message }); }
        pause = w.remote || action === 'side-chat' ? 'conversation'
          : WAITING_LINE.test(text) ? 'waiting line'
          : asked ? 'ask to the brain'
          : tasks.length ? `background task${tasks.length > 1 ? 's' : ''}: ${tasks.map((t: any) => t?.description ?? t?.command ?? t?.id).join('; ').slice(0, 160)}`
          : crons.length ? 'scheduled wake-up' : undefined;
        // A WAITING line with nothing that ends by itself (a task, a wake-up, an ask) waits on the owner. rows() shows it.
        ownerWait = pause === 'waiting line' && !tasks.length && !crons.length && !asked;
      }
      const t = iso();
      const nudges = (nudgeTimes.get(w.id) ?? []).filter(x => now() - x < NUDGE_WINDOW_MS);
      const nudge = !outcome && !pause && !nudgedChain.has(w.id) && nudges.length < NUDGE_MAX;
      const next = update(w.id, { report: text, report_at: t, transcript, ...(outcome ? { outcome, state: outcome } : w.remote ? { state: 'done' } : pause || nudge ? { state: 'working' } : {}) });
      if (pause) store.setState(quietKey(w.id), `pause:${t}`);
      store.setState(ownerWaitKey(w.id), ownerWait ? t : '');
      log('native worker reported', { worker: w.id, final: !!outcome, chars: text.length, ...(pause ? { pause } : {}), ...(nudge ? { sentBack: true } : {}) });
      o.onReport(next, text, !!outcome);
      if (nudge) {
        nudgedChain.add(w.id);
        nudgeTimes.set(w.id, [...nudges, now()]);
        return { decision: 'block', reason: REPORT_NUDGE };
      }
      if (!outcome && !pause) {
        // Sent back once and still no line: the brain hears it now, not two minutes later, and the poll's backstop stays quiet.
        store.setState(quietKey(w.id), `told:${t}`);
        noticed.add(`${w.id}:silent`);
        log('native notice', { worker: w.id, kind: 'silent' });
        o.onNotice(next, silentText(next));
      }
      return {};
    },

    preToolUse(body: any): object {
      return body?.tool_name === 'AskUserQuestion' ? NO_ASK : {};
    },

    /** One `claude agents` round: states, liveness and the findings the brain should hear. */
    async poll(): Promise<void> {
      if (polling) return;
      polling = true;
      try { await pollOnce(); } finally { polling = false; }
    },

    /**
     * An interactive session that reported DONE or FAILED, or waits on an ask, and has sat idle for IDLE_REAP_MS: its
     * process is ended and the row says so; a message resumes it (the background supervisor's one-hour stop, by hand).
     */
    reap(w: NativeWorker): void {
      if (w.pgid) killGroup(w.pgid);
      alive.delete(w.id);
      update(w.id, { state: 'stopped', waiting_for: IDLE_STOPPED });
      log('native worker reaped after an hour idle', { worker: w.id, pgid: w.pgid, outcome: w.outcome });
    },

    /**
     * A report whose Stop hook never arrived (jarvisd was down): the transcript's last assistant text, when it starts with
     * DONE or FAILED and is not the stored report already, becomes the report word for word. True when it did.
     */
    recoverReport(id: string): boolean {
      const w = find(id); if (!w || w.outcome) return false;
      const file = api.transcriptFile(w.id); if (!file) return false;
      let text: string | undefined;
      try { text = lastAssistantText(file); } catch (e) { log('native: transcript unreadable', { worker: w.id, error: (e as Error).message }); return false; }
      if (!text || text === (w.report ?? '').trim()) return false;
      const outcome = outcomeOf(text); if (!outcome) return false;
      const next = update(w.id, { report: text, report_at: iso(), outcome, state: outcome, transcript: file, waiting_for: null });
      log('native worker report recovered from its transcript', { worker: w.id, outcome, chars: text.length });
      o.onReport(next, text, true);
      return true;
    },

    rows(): WorkRow[] {
      const onPhone = (w: NativeWorker) => !!w.remote && alive.has(w.id) && w.state !== 'stopped';
      // An open ask holds the row in view as waiting, whatever its process does (rowState).
      const asks = new Map(store.openItems().filter(i => i.source === 'native' && i.dispatch_id).map(i => [i.dispatch_id!, i.subject || 'A question for you'] as const));
      const asking = (w: NativeWorker) => asks.has(`${ROW_PREFIX}${w.id}`);
      // It waits on the owner (waitsOnOwner), with no open ask. It is never stuck, so the row stays Waiting on you.
      const ownerWait = (w: NativeWorker) => !asking(w) && waitsOnOwner(w);
      return api.list().filter(w => w.state !== 'abandoned' && !(['done', 'failed', 'stopped'].includes(w.state) && now() - finishedAt(w) > ROW_MAX_AGE_MS && !onPhone(w) && !asking(w))).map(w => {
        const task = taskOf(w);
        const r: WorkRow = {
          id: `${ROW_PREFIX}${w.id}`, kind: 'worker', dispatch: `${ROW_PREFIX}${w.id}`, title: w.name, ...classify(task.title, task.spec),
          state: rowState(w, asking(w) || ownerWait(w)),
          worktree: basename(w.cwd),
          // An interactive session takes a message in any state: a stopped or failed one is resumed first.
          steer: w.kind === 'interactive' || ['done', 'working', 'blocked', 'starting'].includes(w.state) ? 'auto' : 'none',
          native: { id: w.id, sessionId: w.session_id, name: w.name, state: w.state, waitingFor: w.waiting_for, outcome: w.outcome, kind: w.kind, ...(w.remote ? { remote: w.remote } : {}),
            ...(stalled.has(w.id) ? { stalledSince: new Date(stalled.get(w.id)!).toISOString() } : {}),
            ...(ownerWait(w) ? { waitingOn: { text: waitingText(w.report ?? ''), since: w.report_at! } } : {}),
            ...(w.outcome === 'done' && followUpOf(store, w.id) ? { followUp: { text: firstLine(followUpOf(store, w.id)!.text), at: followUpOf(store, w.id)!.at, outcome: 'failed' as const } } : {}) },
        };
        if (w.state === 'blocked' && w.waiting_for) r.note = w.waiting_for;
        else if (asking(w)) r.note = asks.get(`${ROW_PREFIX}${w.id}`);
        else if (ownerWait(w)) r.note = waitingText(w.report ?? '');
        else if (stalled.has(w.id)) r.note = `Stuck: nothing for ${ago(now() - stalled.get(w.id)!).replace(' ago', '')}`;
        else if (w.state === 'done' && onPhone(w)) r.note = `In the Claude app as "${w.remote}"`;
        else if (w.state === 'done') r.note = `Done ${ago(now() - Date.parse(w.report_at ?? w.updated_at))}`;
        else if (w.state === 'stopped') r.note = w.waiting_for ?? 'Stopped';
        else if (w.state === 'failed') r.note = w.waiting_for ?? 'Failed';
        if (['done', 'failed', 'stopped'].includes(w.state) && !onPhone(w) && !asking(w)) r.endedAt = new Date(finishedAt(w)).toISOString();
        return r;
      });
    },

    list: (): NativeWorker[] => store.nativeWorkers().map(asWorker),
    get: (id: string): NativeWorker | undefined => find(id),

    /** the owner's or the brain's words, into the worker's running session. A worker with no live process is respawned first. */
    async reply(id: string, text: string, by: 'owner' | 'jarvis'): Promise<{ ok: true } | { ok: false; error: string }> {
      const w = find(id);
      if (!w) return { ok: false, error: `no worker ${id}` };
      if (w.state === 'abandoned') return { ok: false, error: 'This worker was abandoned.' };
      const t0 = now();
      let live: boolean;
      if (w.kind === 'interactive') {
        // The terminal's group leader answers `kill -0` while the session lives; a stopped or failed row is resumed whatever it answers.
        live = !!w.pgid && alivePgid(w.pgid) && !['stopped', 'failed'].includes(w.state);
      } else {
        // One fresh listing: the 30 s poll may not have run since the worker started, and `claude stop` leaves it listed as done with no pid.
        const seen = listed(await agents(), w);
        if (seen?.pid) alive.add(w.id); else alive.delete(w.id);
        live = !!seen?.pid && w.state !== 'stopped';
      }
      if (!live) {
        log('native reply: worker not alive, respawning first', { worker: w.id, state: w.state, kind: w.kind });
        try { await api.respawn(w.id); } catch (e) { log('native reply', { worker: w.id, by, ok: false, error: (e as Error).message }); return { ok: false, error: `Could not respawn the worker: ${(e as Error).message}` }; }
      }
      // An interactive session has a terminal: the exact bytes go in through its stdin pipe, in about a millisecond, verbatim.
      // The relay (a haiku session carrying SendMessage, about 8 s) is the fallback when the pipe has no reader, and the only way into a background session.
      const cur = find(w.id)!;
      let r: { ok: true } | { ok: false; error: string }, via = 'relay';
      if (cur.kind === 'interactive' && cur.in_fifo) {
        try { typeInto(cur.in_fifo, typedBytes(text)); r = { ok: true }; via = 'terminal'; }
        catch (e) { log('native reply: typing into the terminal failed, relaying instead', { worker: w.id, fifo: cur.in_fifo, error: (e as NodeJS.ErrnoException).code ?? (e as Error).message }); r = await relay(cur, text); }
      } else r = await relay(cur, text);
      log('native reply', { worker: w.id, by, via, chars: text.length, ms: now() - t0, ok: r.ok, ...(r.ok ? {} : { error: r.error }) });
      if (r.ok) {
        const ext = `reply:${w.id}:${now()}:${++replySeq}`; // two replies in one millisecond (typing is that fast) must not share an id
        store.insertItem({ source: 'native', external_id: ext, kind: 'reply', dispatch_id: `${ROW_PREFIX}${w.id}`, body: text, status: 'done' });
        if (by === 'jarvis') store.markItem(ext, 'done', undefined, 'jarvis');
      }
      return r;
    },

    /** The Open button: a Terminal window attached to the session. */
    async attach(id: string): Promise<void> {
      const w = find(id); if (!w) throw new Error(`no worker ${id}`);
      if (w.kind === 'interactive') throw new Error('This worker runs in its own pseudo-terminal, which nothing can attach to. Use Desktop.');
      await new Promise<void>((resolve, reject) => execFile('osascript', ['-e', `tell application "Terminal" to do script "claude attach ${w.id}"`, '-e', 'tell application "Terminal" to activate'],
        { timeout: 15_000 }, err => err ? reject(err) : resolve()));
      log('native worker attached in Terminal', { worker: w.id });
    },

    /** The Desktop button: stop the session and open it in the Claude desktop app. A message to the row takes it back. */
    async desktop(id: string): Promise<void> {
      const w = find(id); if (!w) throw new Error(`no worker ${id}`);
      if (!w.session_id) throw new Error('This worker has no session id yet.');
      if (w.kind === 'interactive') { if (w.pgid) killGroup(w.pgid); alive.delete(w.id); } else await claude(['stop', w.id]);
      const p = spawn('script', ['-q', '/dev/null', 'claude', '--desktop', '--resume', w.session_id], { cwd: w.cwd, env: { ...cleanEnv, HOME: process.env.HOME }, detached: true, stdio: 'ignore' });
      p.on('error', e => log('native desktop open failed', { worker: w.id, error: e.message }));
      p.unref();
      update(w.id, { state: 'stopped', waiting_for: DESKTOP_WAITING });
      log('native worker handed to the desktop app', { worker: w.id, session: w.session_id });
    },

    transcriptFile(id: string): string | undefined {
      const w = find(id);
      if (!w) return undefined;
      if (w.transcript) return w.transcript;
      if (!w.session_id) return undefined;
      const f = join(process.env.HOME ?? '', '.claude', 'projects', projectDir(w.cwd), `${w.session_id}.jsonl`);
      return existsSync(f) ? f : undefined;
    },

    /**
     * At start. A prompt held when jarvisd last exited was lost, so its card is closed as failed. Then every interactive
     * row: one with a pid is alive and keeps its state; one that was blocked on a lost card is stuck at Claude Code's own
     * prompt, so it is ended and resumed (the tool call runs again and its prompt makes a fresh card); one with no pid and
     * an unfinished task is resumed; and a report whose Stop hook fired while jarvisd was down is read from the transcript.
     */
    async recover(): Promise<void> {
      const stale = store.pendingApprovals().filter(a => a.action === 'worker-permission');
      const stuck = new Set<string>();
      for (const a of stale) {
        store.decide(a.id, 'failed', 'automatic');
        store.finishApproval(a.id, 'failed', `jarvisd restarted before ${OWNER} answered`);
        const worker = (() => { try { return JSON.parse(a.args).worker as string; } catch { return undefined; } })();
        if (worker && row(worker)?.state === 'blocked') { update(worker, { waiting_for: null, state: 'working' }); stuck.add(worker); }
      }
      const list = await agents();
      let kept = 0, resumed = 0, reports = 0;
      const resumes: Promise<unknown>[] = [];
      for (const r of store.nativeWorkers()) {
        const w = asWorker(r);
        if (w.kind !== 'interactive' || w.state === 'abandoned') continue;
        const a = listed(list, w);
        if (a?.pid && w.state !== 'stopped' && stuck.has(w.id)) {
          if (w.pgid) killGroup(w.pgid);
          log('native: ended a session stuck at a prompt jarvisd lost', { worker: w.id, pgid: w.pgid });
          resumed++;
          resumes.push(waitGone(w, 10_000).then(() => api.resume(w.id, 'it was stuck at a permission prompt jarvisd lost in its restart')).catch(e => log('native: resume at start failed', { worker: w.id, error: (e as Error).message })));
          continue;
        }
        if (a?.pid) { kept++; alive.add(w.id); if (a.cwd && a.cwd !== w.cwd) update(w.id, { cwd: a.cwd }); }
        else if (unfinished(w)) { resumed++; resumes.push(api.resume(w.id, 'jarvisd restarted and found it gone').catch(e => log('native: resume at start failed', { worker: w.id, error: (e as Error).message }))); }
        if (!w.outcome && (!a?.pid || a.status === 'idle') && api.recoverReport(w.id)) reports++;
      }
      log('native: recovered', { failedPermissionCards: stale.length, workers: store.nativeWorkers().length, alive: kept, resuming: resumed, reportsFromTranscripts: reports });
      await Promise.all(resumes);
    },
  };

  /** Waits until the listing shows no pid for the worker's session, or the time is up. */
  async function waitGone(w: NativeWorker, ms: number): Promise<void> {
    const until = now() + ms;
    while ((await agents()).some(a => a.sessionId === w.session_id && !!a.pid)) { if (now() >= until) return; await sleep(TICK_MS); }
  }

  async function pollOnce(): Promise<void> {
      const list = await agents();
      alive = new Set(list.filter(a => a.pid).map(a => a.id));
      for (const r of store.nativeWorkers()) {
        const w = asWorker(r);
        if (w.state === 'abandoned') continue;
        const a = listed(list, w);
        const f: Partial<NativeWorkerRow> = {};
        if (a?.sessionId && a.sessionId !== w.session_id) f.session_id = a.sessionId;
        if (w.kind === 'interactive' && a?.pid) alive.add(w.id);
        // The listing names the session's real folder (its worktree when it took one); a resume must run there.
        if (w.kind === 'interactive' && a?.pid && a.cwd && a.cwd !== w.cwd) f.cwd = a.cwd;
        const state = w.kind === 'interactive' ? interactiveState(a, w) : a?.state as NativeState | undefined;
        // `claude stop` leaves the session listed as done with no pid, so a stop Jarvis made stays stopped until something wakes it.
        // A session handed to the desktop app is listed with that app's pid: it stays stopped here, so a message still takes it back.
        const keepStopped = w.state === 'stopped' && (!a?.pid || w.waiting_for === DESKTOP_WAITING);
        if (state && ['working', 'blocked', 'done', 'failed', 'stopped'].includes(state) && state !== w.state && !keepStopped) f.state = state;
        if (state === 'failed' && !w.outcome) f.outcome = 'failed';
        // A stopped or failed interactive row's waiting_for is Jarvis's own note (idle, desktop, died too often): the listing does not overwrite it.
        const ownNote = w.kind === 'interactive' && ['stopped', 'failed'].includes(w.state);
        if (!pendingCard(w.id) && !ownNote) { const wf = a?.status === 'waiting' ? a.waitingFor ?? null : null; if (wf !== w.waiting_for) f.waiting_for = wf; }
        let next = Object.keys(f).length ? update(w.id, f) : w;
        if (w.kind === 'interactive' && !resuming.has(w.id)) {
          // Stuck at Claude Code's own permission prompt, which nobody sees: the listing says it waits on one and jarvisd holds no
          // card for it (the hook was lost in a restart, or never reached here). Two polls in a row, so a hook on its way is not
          // mistaken for it; then the group is ended and the session resumed, and the tool call prompts again through the hook.
          const atPrompt = !!a?.pid && a.status === 'waiting' && /permission/i.test(a.waitingFor ?? '') && !pendingCard(w.id) && next.state !== 'stopped';
          if (!atPrompt) stuckSeen.delete(w.id);
          else if (!stuckSeen.has(w.id)) stuckSeen.set(w.id, now());
          else {
            stuckSeen.delete(w.id);
            log('native worker stuck at a prompt jarvisd cannot answer', { worker: w.id, pgid: w.pgid, waitingFor: a!.waitingFor });
            if (w.pgid) killGroup(w.pgid);
            await waitGone(w, 10_000);
            await api.resume(w.id, 'it was stuck at a permission prompt jarvisd could not answer').catch(e => log('native: resume failed', { worker: w.id, error: (e as Error).message }));
            next = row(w.id) ?? next;
            continue;
          }
          // Dead by accident: unfinished, no process, and not a stop Jarvis made. Resumed, within the backoff.
          if (!a?.pid && unfinished(next)) {
            log('native worker died', { worker: w.id, state: next.state, pgid: w.pgid });
            await api.resume(w.id, 'its terminal died').catch(e => log('native: resume failed', { worker: w.id, error: (e as Error).message }));
          }
          // A DONE whose hook fired while jarvisd was down, before the silent-turn notice could call it silence.
          if (!next.outcome && (!a?.pid || a.status === 'idle')) api.recoverReport(w.id);
          next = row(w.id) ?? next;
          // The reaper: finished or waiting on an ask, and idle for an hour since its last report, its last resume or that ask
          // (the row's own timestamps, so a jarvisd restart does not reset the hour).
          // A session on the phone gets the same hour, counted from its last phone turn or its Continue on phone: left running,
          // it kept its row open for good (teal-and-mint-app-theme-420, idle from 2026-11-08 to 11-09). A message resumes it with
          // its Remote Control name, and Continue on phone brings it back to the Claude app.
          if (a?.pid && a.status === 'idle' && next.state !== 'stopped') {
            const since = idleFrom(next);
            if (since !== undefined && now() - since >= IDLE_REAP_MS) { api.reap(next); next = row(w.id) ?? next; }
          }
        }
        const notice = (kind: string, holds: boolean, text: () => string) => {
          const key = `${w.id}:${kind}`;
          if (!holds) { noticed.delete(key); return; }
          if (noticed.has(key)) return;
          noticed.add(key);
          log('native notice', { worker: w.id, kind });
          o.onNotice(next, text());
        };
        notice('failed', next.state === 'failed', () => `Worker ${w.name} failed`);
        // Stuck: at any hour, once per stall, also across a jarvisd restart (the state key holds the activity time told).
        // New activity clears it, and a later stall is told again.
        const since = stalledFrom(next, listed(list, next));
        if (since === undefined) stalled.delete(w.id);
        else {
          stalled.set(w.id, since);
          if (store.getState(stallKey(w.id)) !== String(since)) {
            store.setState(stallKey(w.id), String(since));
            log('native notice', { worker: w.id, kind: 'stalled', idleMin: Math.round((now() - since) / 60_000) });
            o.onNotice(next, stalledText(next, now() - since));
          }
        }
        notice('blocked', next.state === 'blocked' && !!next.waiting_for && !pendingCard(w.id), () => `Worker ${w.name} is blocked: ${next.waiting_for}`);
        // The backstop for a Stop hook that never arrived. A pause, or a turn stopHook already told the brain about, stays quiet,
        // also after a jarvisd restart (the state key holds the report's time).
        notice('silent', next.state === 'done' && !next.outcome && !!next.report && now() - Date.parse(next.report_at!) >= SILENT_DONE_MS && !quiet(next),
          () => { store.setState(quietKey(w.id), `told:${next.report_at}`); return silentText(next); });
      }
  }

  /**
   * An interactive session in a detached pseudo-terminal (the default kind since 2026-11-07; the only kind with the Artifact
   * tool). `claude agents` lists it by name once it is up; its id is the session id's first 8 characters, like a background id.
   * `-w <name>` makes its worktree, and the listing then names that folder as `cwd`, which a resume runs in. The model and
   * permission mode are stored so a resume replays them; its stdin is a named pipe jarvisd can type into.
   */
  async function startInteractive(a: { name: string; cwd: string; brief: string; model?: string; permissionMode?: 'auto' | 'default'; approvalId?: number; worktree?: boolean }): Promise<NativeWorker> {
    const model = a.model ?? DEFAULT_MODEL, mode = a.permissionMode ?? 'auto';
    const fifo = fifoFor(a.name, 0);
    const pgid = spawnPty(['claude', '--name', a.name, '--permission-mode', mode, '--model', model, '--settings', settingsPath, ...(a.worktree ? ['-w', a.name] : []), a.brief], a.cwd, fifo);
    const t = iso();
    const probe: NativeWorker = { id: '', session_id: null, name: a.name, cwd: a.cwd, approval_id: a.approvalId ?? null, state: 'starting', waiting_for: null, report: null, report_at: null, outcome: null, transcript: null, created_at: t, updated_at: t, kind: 'interactive', pgid,
      repo: a.cwd, model, permission_mode: mode, resumes: 0, last_resume_at: null, in_fifo: fifo };
    const seen = await waitFor(probe, x => !!x.sessionId, SESSION_WAIT_MS * 2);
    if (!seen?.sessionId) {
      killGroup(pgid);
      log('native worker failed to start', { name: a.name, approval: a.approvalId ?? null, kind: 'interactive', pgid });
      throw new Error(`the interactive session ${a.name} was not listed by claude agents within ${SESSION_WAIT_MS * 2 / 1000} s`);
    }
    const id = seen.sessionId.slice(0, 8);
    store.addNativeWorker({ ...probe, id, session_id: seen.sessionId, state: 'working', cwd: seen.cwd || a.cwd });
    alive.add(id);
    const w = row(id)!;
    o.onChange(w);
    log('native worker started', { worker: id, session: w.session_id, name: a.name, approval: a.approvalId ?? null, cwd: w.cwd, repo: a.cwd, worktree: !!a.worktree, kind: 'interactive', pgid, fifo });
    return w;
  }

  /** One short Claude session whose only job is SendMessage to the worker, verbatim. */
  async function relay(w: NativeWorker, text: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const settings = { crossSessionInbound: 'refuse', enabledPlugins: { 'superpowers@claude-plugins-official': false, 'ui-ux-pro-max@ui-ux-pro-max-skill': false, 'claude-code-setup@claude-plugins-official': false } };
    const prompt = `Use SendMessage to send this exact text, verbatim, nothing added or removed, to the session named ${w.name}: <<<\n${text}\n>>>. Reply with SENT or the error.`;
    const r = await claude(['-p', '--model', RELAY_MODEL, '--name', RELAY_NAME, '--tools', 'SendMessage', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
      '--settings', JSON.stringify(settings), '--output-format', 'json', '--permission-mode', 'auto', prompt], w.cwd);
    let res: any;
    try { res = JSON.parse(r.out); } catch { return { ok: false, error: `relay printed no JSON (exit ${r.code}): ${(r.err || r.out).trim().slice(0, 200)}` }; }
    const answer = String(res?.result ?? '');
    if (res?.is_error || !/\bSENT\b/.test(answer)) return { ok: false, error: `relay did not confirm: ${answer.slice(0, 200) || res?.subtype || `exit ${r.code}`}` };
    return { ok: true };
  }

  return api;
}

export type Native = ReturnType<typeof makeNative>;
