import { execFile } from 'node:child_process';

// The work list's shapes: one row per native worker (native.ts) and per project terminal (termrows.ts). main.ts merges
// them for the app; nothing here speaks, pushes or wakes the brain.

export type WorkGroup = 'story' | 'babysit' | 'side' | 'terminal' | 'other';
export type WorkRow = {
  /** `n:<id>` for a native worker, `t:<name>` for a project terminal. */
  id: string;
  /** A worker Jarvis started, or a session the owner opened (a project terminal). */
  kind: 'worker' | 'session';
  dispatch?: string; title: string; group: WorkGroup;
  /** "#4460" for a story, "PR #4533" for a babysitter. */
  label?: string;
  /** The PR a session's workspace is linked to, when its label is the story number. */
  pr?: string;
  state: 'waiting' | 'working' | 'idle' | 'exited';
  /** Why it waits (the ask's subject), or how long it has been done. */
  note?: string;
  /** When it finished (done, failed or stopped), as an ISO time. A row with no request and a DONE report goes to Completed with this time (web/worklist.js). Absent while it runs. */
  endedAt?: string;
  worktree?: string;
  /** How the message box reaches it. auto: jarvisd types it into the worker's session. none: nothing to type into. */
  steer: 'auto' | 'none';
  /** Set on a background Claude Code session jarvisd started itself (native.ts). */
  native?: { id: string; sessionId: string | null; name: string; state: NativeState; waitingFor: string | null; outcome: 'done' | 'failed' | null; kind?: 'background' | 'interactive';
    /** Continue on phone: the Remote Control name it runs with in the Claude app. */
    remote?: string;
    /** Set while the worker is stuck (native.ts stalledFrom): when it last did anything, as an ISO time. */
    stalledSince?: string;
    /** Set while its last turn ended on a WAITING line that only the owner ends: the words after WAITING and the report time (ISO). */
    waitingOn?: { text: string; since: string };
    /** A follow-up turn's FAILED result on a story that stays done: its first line and when (ISO). */
    followUp?: { text: string; at: string; outcome: 'failed' } };
  /** Set on a project terminal or Codex session from the new-session picker (terminal.ts). */
  tmux?: { name: string; project: string; kind: 'terminal' | 'codex'; cwd: string; branch: string };
};
/** Where a background Claude Code session is in its life (native.ts). */
export type NativeState = 'starting' | 'working' | 'blocked' | 'done' | 'failed' | 'stopped' | 'abandoned';
export type Work = { at: string; rows: WorkRow[] };

export const SIDE_CHAT_PREFIX = 'Side chat: ';

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


/** `git remote` of the worker's checkout as a GitHub web URL, so "PR #12" can become a link. */
export function githubRepo(dir: string): Promise<string | undefined> {
  return new Promise(resolve => execFile('git', ['-C', dir, 'remote', 'get-url', 'origin'], { timeout: 5_000 }, (err, out) => {
    const m = !err && out.trim().match(/github\.com[:/]([\w.-]+\/[\w.-]+?)(\.git)?$/);
    resolve(m ? `https://github.com/${m[1]}` : undefined);
  }));
}
