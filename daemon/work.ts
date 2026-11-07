import { execFile } from 'node:child_process';
import { basename } from 'node:path';
import type { OrcaResult } from './orca.ts';
import type { Log } from './log.ts';
import { promptKey } from './prompt.ts';

// What the owner's workers and Orca sessions are doing, across every Run on this Orca host. One poller every
// 30 s feeds the app's work list, the brain's state brief and the quiet "Done" line; nothing here speaks,
// pushes or wakes the brain.

export type WorkGroup = 'story' | 'babysit' | 'side' | 'terminal' | 'other';
export type WorkRow = {
  /** The dispatch id for a worker, `s:<Orca session key>` for a session the owner or a manager runs by hand. */
  id: string;
  /** A supervised worker in a Run, or an Orca agent session that no Run dispatched (a manager chat, a terminal agent). */
  kind: 'worker' | 'session';
  dispatch?: string; run?: string; title: string; group: WorkGroup;
  /** "#4460" for a story, "PR #4533" for a babysitter. */
  label?: string;
  /** The PR a session's workspace is linked to, when its label is the story number. */
  pr?: string;
  state: 'waiting' | 'working' | 'idle' | 'exited';
  /** Why it waits (the ask's subject), or how long a side chat or session has been idle. */
  note?: string;
  /** When it finished (done, failed or stopped), as an ISO time. The app folds a row finished over an hour ago. Absent while it runs. */
  endedAt?: string;
  worktree?: string; terminal?: string;
  /** A side chat the owner started with the button. Only those get a Close button. */
  sideChat: boolean;
  /**
   * How the message box reaches it. auto: `orchestration send` or reply (Jarvis's own worker). type: typed into its live terminal agent.
   * resume: no process to type into, so the daemon resumes the session. card: only after Approve (another Run's chat-tab worker). none: exited.
   */
  steer: 'auto' | 'type' | 'resume' | 'card' | 'none';
  /** Set on a background Claude Code session jarvisd started itself (native.ts). Absent on Orca rows. */
  native?: { id: string; sessionId: string | null; name: string; state: NativeState; waitingFor: string | null; outcome: 'done' | 'failed' | null; kind?: 'background' | 'interactive' };
  /** Set on a project terminal or Codex session from the new-session picker (terminal.ts). */
  tmux?: { name: string; project: string; kind: 'terminal' | 'codex'; cwd: string; branch: string };
};
/** Where a background Claude Code session is in its life (native.ts). */
export type NativeState = 'starting' | 'working' | 'blocked' | 'done' | 'failed' | 'stopped' | 'abandoned';
export type DoneLine = { dispatch: string; at: string; title: string; subject: string; pr?: string; url?: string };
export type Work = { at: string; rows: WorkRow[]; done: DoneLine[]; error?: string };
/** Every worker Orca listed, finished ones included, for the Requests sidebar (requests.ts). */
export type WorkerInfo = { dispatch: string; outcome?: string; path?: string; session?: string;
  /** Orca sees it live and its agent working, background work included. */
  running?: boolean;
};
/** The note on a worker parked at a prompt only a human can answer, with no ask behind it. */
export const AT_PROMPT = 'Waiting at a prompt in Orca';
/** Where the transcript pane reads a row from. */
export type Source =
  | { kind: 'worker'; dispatch: string; chat?: ChatRef }
  | { kind: 'terminal'; handle: string; chat?: ChatRef }
  | ({ kind: 'chat' } & ChatRef);
/**
 * How to find a session's transcript file. `query` is words for `orca search`. A chat tab's hit names its session key;
 * a terminal agent's hit does not, so `probe` (the start of its last message) must be in the file.
 */
export type ChatRef = { key: string; cwd: string; query: string; probe?: string };

export const SIDE_CHAT_PREFIX = 'Side chat: ';
export const IDLE_MS = 60 * 60_000;
/** Sessions nobody touched for this long drop off the list, unless they are working or waiting at a prompt. */
export const SESSION_MAX_AGE_MS = 48 * 3_600_000;
/** Jarvis's own coordinator chat (workspace ~/Repos). It is this app, so it never gets a row. */
export const JARVIS_CHAT_TITLE = 'Jarvis';
/** A finished worker's chat touched less than this after the worker finished is the worker's own last turn, not the owner talking. */
const AFTER_FINISH_MS = 60_000;
/** Orca's status can lag a stop notice by a moment, so a running worker clears the notice only once it is this old. Under the first push's 90 s. */
export const STOP_SETTLE_MS = 60_000;

type AskRef = { external_id: string; kind: string; dispatch_id: string | null; created_at: string };
/** Orca's own notice that a worker ended a turn without worker_done, as opposed to an escalation the worker wrote. */
export const isStopNotice = (i: Pick<AskRef, 'external_id' | 'kind'>) => i.kind === 'escalation' && i.external_id.startsWith('msg_stop_');

/**
 * Stop notices that no longer wait on the owner: the worker resumed, finished or was released, or it is a side chat, which
 * ends every turn this way. `complete` is false when a Run's list failed, so a missing worker proves nothing.
 */
export function passedStopNotices(asks: AskRef[], rows: WorkRow[], workers: WorkerInfo[], complete: boolean, now: number): string[] {
  const listed = new Map(workers.map(w => [w.dispatch, w]));
  return asks.filter(i => {
    if (!isStopNotice(i) || !i.dispatch_id) return false;
    const w = listed.get(i.dispatch_id);
    if (!w) return complete;
    const row = rows.find(r => r.id === i.dispatch_id);
    if (w.outcome !== 'in_progress' || !row || row.sideChat) return true;
    return !!w.running && now - Date.parse(`${i.created_at.replace(' ', 'T')}Z`) >= STOP_SETTLE_MS;
  }).map(i => i.external_id);
}

/**
 * Every stop notice after the first one open for its dispatch and prompt. Orca repeats them. A new prompt from the same
 * worker is not a repeat: its first notice closes once the worker leaves that prompt, and this one has to stay.
 */
export function duplicateStopNotices(asks: (Pick<AskRef, 'external_id' | 'kind' | 'dispatch_id'> & { body?: string | null })[]): string[] {
  const first = new Set<string>();
  return asks.filter(i => {
    if (!isStopNotice(i) || !i.dispatch_id) return false;
    const key = `${i.dispatch_id}\n${promptKey(i.body ?? null)}`;
    if (!first.has(key)) { first.add(key); return false; }
    return true;
  }).map(i => i.external_id);
}

/** Sorts a task or session into Stories, Babysitting, Side chats (started from the app) or Other. */
export function classify(title: string, spec = ''): { group: WorkGroup; label?: string } {
  if (title.startsWith(SIDE_CHAT_PREFIX)) return { group: 'side' };
  const head = `${title}\n${spec.slice(0, 300)}`;
  if (/babysit|watch(ing)?\s+(the\s+)?pr\b|pr watcher/i.test(head)) {
    const pr = head.match(/pull\/(\d+)|\bPR\s*#?(\d+)|#(\d+)/i);
    return { group: 'babysit', label: pr ? `PR #${pr[1] ?? pr[2] ?? pr[3]}` : undefined };
  }
  // "pick-and-ship #4460", a workspace named "issue-4498", or "issue #4412" near the top of the spec.
  const n = title.match(/#(\d{2,})|\b(?:issue|story)[-\s#]*(\d{3,})/i) ?? head.match(/\b(?:issue|story)[-\s#]*(\d{2,})/i);
  if (n) return { group: 'story', label: `#${n[1] ?? n[2]}` };
  return { group: 'other' };
}

/** The first PR a finished worker named: a full link if it wrote one, otherwise its number. */
export function findPr(text: string): { pr?: string; url?: string } {
  const url = text.match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/(\d+)/);
  if (url) return { pr: `PR #${url[1]}`, url: url[0] };
  const n = text.match(/\bPR\s*#(\d+)/i);
  return n ? { pr: `PR #${n[1]}` } : {};
}


type Task = { id: string; task_title?: string; display_name?: string; spec?: string; result?: string | null };
type Worker = {
  dispatchId: string; taskId: string; runId: string; agentTerminalHandle?: string;
  resource?: { worktreeId?: string; endpointIncarnation?: string; releaseCompletedAt?: string | null };
  projection?: { outcome?: string; liveness?: { verdict?: string; observedAt?: number }; stage?: { activity?: string } };
};
type Agent = {
  paneKey: string; state?: string; agentType?: string; prompt?: string; lastAssistantMessage?: string; updatedAt?: number;
  /** `monitoring` while the agent only waits on a background command (a manager's `check --wait`). */
  workingMode?: string;
};
type Terminal = { handle: string; recordedPaneKey?: string; tabId?: string; leafId?: string;
  /** Set while an agent runs in the terminal. Gone once it exits to the shell, where typed text would run as a command. */
  agentIdentity?: string;
};
type Worktree = {
  path: string; displayName?: string; isArchived?: boolean; status?: string; workspaceStatus?: string;
  linkedIssue?: { number?: number } | null; linkedPR?: { number?: number; state?: string } | null; agents?: Agent[];
};
type Orca = (args: string[]) => Promise<OrcaResult>;

const parse = (s: unknown): any => { try { return typeof s === 'string' ? JSON.parse(s) : s; } catch { return null; } };
const worktreePath = (w: Worker) => w.resource?.worktreeId?.split('::')[1];
/** The workspace's work is finished: its PR was merged or closed, or Orca marked the workspace completed. */
const workFinished = (w: Worktree) => w.linkedPR?.state === 'merged' || w.linkedPR?.state === 'closed' || w.workspaceStatus === 'completed';
/** The session part of a pane key: `structured-agent-session-<key>:<leaf>` for a chat tab, the whole key for a terminal agent. */
const sessionKey = (paneKey: string) => paneKey.startsWith('structured-agent-session-') ? paneKey.slice(25).split(':')[0] : paneKey;
/** A terminal's pane key as `worktree ps` writes it: `<tabId>:<leafId>`. Orca records it only on some terminals. */
const terminalPane = (t: Terminal) => t.recordedPaneKey ?? (t.tabId && t.leafId ? `${t.tabId}:${t.leafId}` : undefined);
/** When Orca last saw a finished worker: its last status, or the release. */
const finishedAt = (w: Worker) => Math.max(w.projection?.liveness?.observedAt ?? 0, Date.parse(`${w.resource?.releaseCompletedAt?.replace(' ', 'T')}Z`) || 0);
const ago = (ms: number) => ms < 3_600_000 ? `${Math.max(1, Math.round(ms / 60_000))} min ago` : ms < 172_800_000 ? `${Math.round(ms / 3_600_000)} h ago` : `${Math.round(ms / 86_400_000)} d ago`;
/** A few plain words from the session's last message, for finding its transcript with `orca search`. */
const searchWords = (s = '') => s.replace(/https?:\/\/\S+/g, ' ').replace(/[^\p{L}\p{N}\s]+/gu, ' ').split(/\s+/).filter(Boolean).slice(0, 8).join(' ');

const chatRef = (a: Agent, key: string, cwd: string): ChatRef => ({
  key, cwd, query: searchWords(a.lastAssistantMessage || a.prompt),
  ...(key === a.paneKey ? { probe: (a.lastAssistantMessage || a.prompt || '').slice(0, 40) } : {}),
});

/** `git remote` of the worker's checkout as a GitHub web URL, so "PR #12" can become a link. */
export function githubRepo(dir: string): Promise<string | undefined> {
  return new Promise(resolve => execFile('git', ['-C', dir, 'remote', 'get-url', 'origin'], { timeout: 5_000 }, (err, out) => {
    const m = !err && out.trim().match(/github\.com[:/]([\w.-]+\/[\w.-]+?)(\.git)?$/);
    resolve(m ? `https://github.com/${m[1]}` : undefined);
  }));
}

export function makeWorkPoller(opts: {
  orca: Orca; log: Log; jarvisRun: string;
  /** Dispatch id to the subject of the ask or escalation it is waiting on the owner for. */
  openAsks: () => Map<string, string>;
  /** The same for open stop notices, which wait on the owner only while the worker is not running. */
  stopNotices?: () => Map<string, string>;
  onChange: (w: Work) => void;
  /** After every poll Orca answered, with the list just published. `complete` is false when a Run's list failed, so a missing worker proves nothing. */
  onPolled?: (w: Work, workers: WorkerInfo[], complete: boolean) => void;
  now?: () => number; repoOf?: (dir: string) => Promise<string | undefined>;
  /** Rows Orca already called gone (dispatch_inactive, terminal_handle_stale), kept across restarts. */
  gone?: string[]; onGone?: (ids: string[]) => void;
}) {
  const now = opts.now ?? Date.now;
  const repoOf = opts.repoOf ?? githubRepo;
  let work: Work = { at: new Date(0).toISOString(), rows: [], done: [] };
  // Finished dispatches already seen. The first poll only fills this, so a restart announces nothing old.
  let finished: Set<string> | undefined;
  // Side chats: transcript cursor and time of the last message, for the 1-hour idle offer.
  const activity = new Map<string, { cursor?: string; last: number }>();
  // Row id to where its transcript is read from; refreshed every poll.
  let sources = new Map<string, Source>();
  // Sessions from the last good `worktree ps`, kept when Orca does not answer.
  let lastSessions: { rows: WorkRow[]; sources: [string, Source][] } = { rows: [], sources: [] };
  let polling: Promise<Work> | undefined;
  // Orca still lists some dead workers as in progress; once Close or Open said they are gone, they stay off the list.
  const gone = new Set(opts.gone ?? []);

  async function tasksOf(runs: Set<string>): Promise<Map<string, Task>> {
    const tasks = new Map<string, Task>();
    await Promise.all([...runs].map(async run => {
      const r = await opts.orca(['orchestration', 'task-list', '--run', run, '--full']).catch(() => undefined);
      if (!r?.ok) return opts.log('work: task-list failed', { run, error: r?.error?.code });
      for (const t of r.result.tasks as Task[]) tasks.set(t.id, t);
    }));
    return tasks;
  }

  /**
   * One Run's workers, every page, or undefined when Orca did not answer. Since 1.4.246 Orca prints a concise view
   * without `projection` unless asked for `--full`; a list without it is a failure, not a list of workers with no outcome.
   */
  async function workersOf(run: string): Promise<Worker[] | undefined> {
    const all: Worker[] = [];
    let cursor: string | undefined;
    do {
      const l = await opts.orca(['orchestration', 'worker-list', '--run', run, '--limit', '100', '--full', ...(cursor ? ['--cursor', cursor] : [])]).catch(() => undefined);
      const page = l?.result?.workers as Worker[] | undefined;
      if (!l?.ok || !page || page.some(w => !w.projection)) { opts.log('work: worker-list failed', { run, error: l?.error?.code ?? 'no projection' }); return undefined; }
      all.push(...page);
      cursor = l.result.nextCursor;
    } while (cursor);
    return all;
  }

  /** Every Run's workers: `run-list`, then `worker-list --run` for each, so no Run is cut off by the 100-row page. */
  async function allWorkers(): Promise<{ workers: Worker[]; complete: boolean } | { error: string }> {
    const r = await opts.orca(['orchestration', 'run-list', '--limit', '100']).catch(e => ({ ok: false, error: { code: 'cli_failed', message: String(e) } }) as OrcaResult);
    if (!r.ok) { opts.log('work: run-list failed', { error: r.error?.code }); return { error: `Orca: ${r.error?.code ?? 'no answer'}` }; }
    const runs = (r.result.runs as { id: string; legacy?: number }[]).filter(x => !x.legacy).map(x => x.id);
    const lists = await Promise.all(runs.map(workersOf));
    const failed = lists.filter(l => !l).length;
    if (runs.length && failed === runs.length) return { error: 'Orca: worker-list failed' };
    return { workers: lists.flatMap(l => l ?? []), complete: failed === 0 };
  }

  /** True when Orca saw the worker parked on a prompt only a human can answer. */
  async function parked(dispatch: string): Promise<boolean> {
    const r = await opts.orca(['orchestration', 'worker-show', '--dispatch', dispatch, '--full']).catch(() => undefined);
    return !!r?.ok && !!r.result?.observation?.agentWait;
  }

  /** Reads a side chat's new transcript messages and returns when the last one was written. */
  async function lastActivity(dispatch: string): Promise<number> {
    const a = activity.get(dispatch) ?? { last: now() };
    activity.set(dispatch, a);
    for (let page = 0; page < 20; page++) {
      const args = ['orchestration', 'worker-read', '--dispatch', dispatch, '--limit', '100'];
      if (a.cursor) args.push('--cursor', a.cursor);
      const r = await opts.orca(args).catch(() => undefined);
      if (!r?.ok) { if (r?.error?.code === 'source_changed') a.cursor = undefined; break; }
      const t = r.result.transcript ?? {};
      for (const m of t.messages ?? []) if (typeof m.timestamp === 'number') a.last = Math.max(a.last, m.timestamp);
      const next = t.nextCursor ?? r.result.cursor ?? a.cursor;
      // `limited` stays true at the end of a transcript (Orca 1.4.244); an empty page or a cursor that did not move is the end.
      const more = t.limited && t.messages?.length && next !== a.cursor;
      a.cursor = next;
      if (!more) break;
    }
    return a.last;
  }

  /** `worktree ps` and `terminal list` for this poll. `trees` is undefined when Orca did not answer `ps`. */
  async function orcaView(): Promise<{ trees?: Worktree[]; terminals: Terminal[] }> {
    const [ps, tl] = await Promise.all([
      opts.orca(['worktree', 'ps']).catch(() => undefined),
      opts.orca(['terminal', 'list']).catch(() => undefined),
    ]);
    if (!ps?.ok) opts.log('work: worktree ps failed', { error: ps?.error?.code });
    return {
      trees: ps?.ok ? (ps.result.worktrees as Worktree[]).filter(w => !w.isArchived && w.agents?.length) : undefined,
      terminals: tl?.ok ? tl.result.terminals as Terminal[] : [],
    };
  }

  /**
   * Agent sessions in Orca's workspaces that no Run dispatched: manager chats, the owner's own chats, terminal agents.
   * A live worker's own chat is left to its worker row; a finished worker's chat shows only if the owner talked in it since.
   * `paneOf` maps a worker to `<workspace path>\n<session key>`.
   */
  function sessions(view: { trees?: Worktree[]; terminals: Terminal[] }, live: Worker[], settled: Worker[], paneOf: (w: Worker) => string | undefined): { rows: WorkRow[]; sources: [string, Source][] } {
    if (!view.trees) return lastSessions;
    const livePanes = new Set(live.map(paneOf).filter(Boolean));
    const livePaths = new Set(live.map(worktreePath).filter(Boolean));
    const ended = new Map(settled.flatMap(w => { const p = paneOf(w); return p ? [[p, finishedAt(w)] as const] : []; }));
    const handles = new Map(view.terminals.flatMap(t => { const p = terminalPane(t); return p ? [[p, t.handle] as const] : []; }));
    const agentTerminals = new Set(view.terminals.filter(t => t.agentIdentity).map(t => t.handle));
    const found: { w: Worktree; a: Agent; key: string }[] = [];
    for (const w of view.trees) {
      if (w.displayName === JARVIS_CHAT_TITLE) continue;
      for (const a of w.agents!) {
        const key = sessionKey(a.paneKey);
        const pane = `${w.path}\n${key}`;
        const busy = a.state === 'working' || a.state === 'blocked' || a.state === 'waiting';
        if (livePanes.has(pane) || (!busy && now() - (a.updatedAt ?? 0) > SESSION_MAX_AGE_MS)) continue;
        // A Done chat whose PR or workspace is finished has nothing left to show.
        if (!busy && workFinished(w)) continue;
        // A Done chat in a workspace a live worker now runs in is an older chat of the same story.
        if (!busy && livePaths.has(w.path)) continue;
        // A finished worker's chat, untouched since it finished.
        if (ended.has(pane) && !busy && (a.updatedAt ?? 0) <= ended.get(pane)! + AFTER_FINISH_MS) continue;
        found.push({ w, a, key });
      }
    }
    const rows: WorkRow[] = [];
    const srcs: [string, Source][] = [];
    for (const { w, a, key } of found) {
      const name = w.displayName || basename(w.path);
      const several = found.filter(f => f.w === w).length > 1;
      const title = several && a.agentType ? `${name} (${a.agentType})` : name;
      const cls = classify(name, a.prompt ?? '');
      const story = cls.group === 'other' && w.linkedIssue?.number ? { group: 'story' as const, label: `#${w.linkedIssue.number}` } : cls;
      const terminal = key === a.paneKey ? handles.get(a.paneKey) : undefined;
      const row: WorkRow = {
        id: `s:${key}`, kind: 'session', title, ...story, state: 'working', worktree: basename(w.path), terminal, sideChat: false,
        steer: terminal && agentTerminals.has(terminal) ? 'type' : 'resume',
      };
      if (w.linkedPR?.number && row.label !== `PR #${w.linkedPR.number}`) row.pr = `PR #${w.linkedPR.number}`;
      if (a.state === 'blocked' || a.state === 'waiting' || w.status === 'permission') { row.state = 'waiting'; row.note = 'Waiting at a prompt in Orca'; }
      else if (a.state === 'working' && a.workingMode === 'monitoring') { row.state = 'idle'; row.note = 'Monitoring'; }
      else if (a.state !== 'working') { row.state = 'idle'; row.note = `Done ${ago(now() - (a.updatedAt ?? now()))}`; row.endedAt = new Date(a.updatedAt ?? now()).toISOString(); }
      rows.push(row);
      const chat = chatRef(a, key, w.path);
      srcs.push([row.id, terminal && row.steer === 'type' ? { kind: 'terminal', handle: terminal, chat } : { kind: 'chat', ...chat }]);
    }
    lastSessions = { rows, sources: srcs };
    return lastSessions;
  }

  async function poll(): Promise<Work> {
    const answer = await allWorkers();
    if ('error' in answer) return publish({ ...work, error: answer.error });
    const { workers, complete } = answer;
    const live = workers.filter(w => w.projection?.outcome === 'in_progress');
    const succeeded = workers.filter(w => w.projection?.outcome === 'succeeded');
    const fresh = finished ? succeeded.filter(w => !finished!.has(w.dispatchId)) : [];
    finished ??= new Set();
    for (const w of succeeded) finished.add(w.dispatchId);

    const settled = workers.filter(w => w.projection?.outcome !== 'in_progress');
    const [tasks, view] = await Promise.all([tasksOf(new Set([...live, ...fresh].map(w => w.runId))), orcaView()]);
    // A chat-tab worker names its session in `structured:<key>`; a terminal worker is found through its terminal's pane.
    const panes = new Map(view.terminals.map(t => [t.handle, terminalPane(t)]));
    const paneOf = (w: Worker) => {
      const inc = w.resource?.endpointIncarnation;
      const key = inc?.startsWith('structured:') ? inc.slice(11) : w.agentTerminalHandle && panes.get(w.agentTerminalHandle);
      const path = worktreePath(w);
      return key && path ? `${path}\n${key}` : undefined;
    };
    const agents = new Map((view.trees ?? []).flatMap(t => t.agents!.map(a => [`${t.path}\n${sessionKey(a.paneKey)}`, a] as const)));
    const others = sessions(view, live, settled, paneOf);
    const agentHandles = new Set(view.terminals.filter(t => t.agentIdentity).map(t => t.handle));
    const hasAgent = (w: Worker) => !!w.agentTerminalHandle && agentHandles.has(w.agentTerminalHandle);
    // A worker Orca cannot see may show a stale "working", so only a live verdict proves it runs.
    const running = (w: Worker) => {
      const pane = paneOf(w);
      const a = pane ? agents.get(pane) : undefined;
      return w.projection?.liveness?.verdict === 'live' && (a?.state === 'working' || w.projection.stage?.activity === 'working');
    };
    const asks = opts.openAsks();
    const stops = opts.stopNotices?.() ?? new Map<string, string>();
    const rows = await Promise.all(live.map(async (w): Promise<WorkRow> => {
      const t = tasks.get(w.taskId);
      const title = t?.display_name || t?.task_title || w.taskId;
      const { group, label } = classify(title, t?.spec);
      const sideChat = w.runId === opts.jarvisRun && title.startsWith(SIDE_CHAT_PREFIX);
      const row: WorkRow = {
        id: w.dispatchId, kind: 'worker', dispatch: w.dispatchId, run: w.runId, title: sideChat ? title.slice(SIDE_CHAT_PREFIX.length) : title, group, label,
        state: 'working', worktree: worktreePath(w) && basename(worktreePath(w)!), terminal: w.agentTerminalHandle, sideChat,
        // A side chat is a plain conversation, so the owner's words go in as his own. A Run's other workers keep Orca's message path.
        steer: hasAgent(w) && (sideChat || w.runId !== opts.jarvisRun) ? 'type' : w.runId === opts.jarvisRun ? 'auto' : 'card',
      };
      if (w.projection?.liveness?.verdict === 'exited') { row.state = 'exited'; row.steer = 'none'; }
      else if (asks.has(w.dispatchId)) { row.state = 'waiting'; row.note = asks.get(w.dispatchId); }
      else if (stops.has(w.dispatchId) && !sideChat && !running(w)) { row.state = 'waiting'; row.note = stops.get(w.dispatchId); }
      else if (await parked(w.dispatchId)) { row.state = 'waiting'; row.note = AT_PROMPT; }
      else if (w.projection?.liveness?.verdict === 'unverifiable' && view.trees) {
        // Orca cannot tell whether it runs. Show what its chat says; never release on this alone (spec, failure table).
        const pane = paneOf(w);
        const a = pane ? agents.get(pane) : undefined;
        const idle = a ? now() - (a.updatedAt ?? 0) : Infinity;
        if (a?.state !== 'working' && idle >= IDLE_MS) {
          row.state = 'idle';
          row.note = a ? `No activity for ${Math.floor(idle / 3_600_000)} h, Orca cannot see it` : 'Orca cannot see it';
        }
      }
      else if (sideChat) {
        const idle = now() - await lastActivity(w.dispatchId);
        if (idle >= IDLE_MS) { row.state = 'idle'; row.note = `Idle ${Math.floor(idle / 3_600_000)} h`; }
      }
      return row;
    }));
    for (const d of activity.keys()) if (!live.some(w => w.dispatchId === d)) activity.delete(d);
    sources = new Map([...live.map(w => {
      const pane = paneOf(w), a = pane ? agents.get(pane) : undefined;
      const src: Source = { kind: 'worker', dispatch: w.dispatchId, ...(a ? { chat: chatRef(a, pane!.split('\n')[1], worktreePath(w)!) } : {}) };
      return [w.dispatchId, src] as [string, Source];
    }), ...others.sources]);

    const done = [...work.done];
    for (const w of fresh) {
      const t = tasks.get(w.taskId);
      const res = parse(t?.result) ?? {};
      const subject = String(res.subject || t?.display_name || t?.task_title || w.taskId);
      const found = findPr(`${subject}\n${res.body ?? ''}`);
      if (found.pr && !found.url && worktreePath(w)) {
        const repo = await repoOf(worktreePath(w)!);
        if (repo) found.url = `${repo}/pull/${found.pr.slice(4)}`;
      }
      const line: DoneLine = { dispatch: w.dispatchId, at: new Date(now()).toISOString(), title: t?.display_name || t?.task_title || '', subject, ...found };
      done.unshift(line);
      opts.log('work: worker finished', { dispatch: w.dispatchId, run: w.runId, subject });
    }
    const all = [...rows, ...others.rows];
    // Forget a gone id once Orca stops listing it, so the set never grows.
    const listed = new Set(all.map(r => r.id));
    if ([...gone].some(id => !listed.has(id))) { for (const id of gone) if (!listed.has(id)) gone.delete(id); opts.onGone?.([...gone]); }
    const out = publish({ at: new Date(now()).toISOString(), rows: all.filter(r => !gone.has(r.id)), done: done.slice(0, 5) });
    opts.onPolled?.(out, workers.map(w => ({
      dispatch: w.dispatchId, outcome: w.projection?.outcome, path: worktreePath(w),
      session: w.resource?.endpointIncarnation?.startsWith('structured:') ? w.resource.endpointIncarnation.slice(11) : undefined,
      running: running(w),
    })), complete);
    return out;
  }

  function publish(next: Work): Work {
    const same = JSON.stringify({ ...next, at: '' }) === JSON.stringify({ ...work, at: '' });
    work = next;
    if (!same) opts.onChange(work);
    return work;
  }

  const api = {
    /** Runs one poll, or joins the one already running, so the 30 s timer and a button press share it. */
    poll(): Promise<Work> {
      polling ??= poll().finally(() => { polling = undefined; });
      return polling;
    },
    current: (): Work => work,
    /** Takes a row off the list because Orca said it no longer exists. It does not come back while Orca lists it. */
    drop(id: string) {
      gone.add(id);
      opts.onGone?.([...gone]);
      opts.log('work: dropped a row Orca called gone', { row: id });
      return publish({ ...work, rows: work.rows.filter(r => r.id !== id) });
    },
    /** Where the transcript pane reads a listed row from. */
    source: (id: string): Source | undefined => sources.get(id),
    start(intervalMs = 30_000) {
      const tick = () => api.poll().catch(e => opts.log(`work: poll failed: ${e}`));
      tick();
      return setInterval(tick, intervalMs);
    },
  };
  return api;
}

/** The work list as short lines for the brain's state brief. */
export function briefLines(w: Work): string {
  if (!w.rows.length) return 'No workers or sessions running.';
  return w.rows.map(r => `- ${r.group} ${r.label ?? ''} ${JSON.stringify(r.title)} ${r.state}${r.note ? ` (${r.note})` : ''} ${r.kind === 'worker' ? `dispatch=${r.dispatch} run=${r.run}` : `session in ${r.worktree}`}`).join('\n');
}
