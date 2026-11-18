import { execFile, execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import type { BlockedReason } from './work.ts';

// A native worker's screen (Rex idea 1, data/reports/rex-multiplexer-research.md). Each interactive worker runs in its own
// tmux session on a socket of its own, so `tmux capture-pane` gives the visible screen and `paste-buffer` types into it.
// A screen read is that capture plus plain pattern matching here. It never calls a model. native.ts decides when to read.
// tmux runs on macOS and Linux; nothing in this file is Mac-only.

/** The tmux binary: JARVIS_TMUX, else the first one found in the usual places, else `tmux` on the PATH. launchd's PATH has no Homebrew. */
export function findTmux(env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = existsSync): string {
  if (env.JARVIS_TMUX) return env.JARVIS_TMUX;
  return ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux', '/bin/tmux'].find(exists) ?? 'tmux';
}

/** The tmux socket the workers run on (`tmux -L <socket>`), apart from the owner's own sessions and the project terminals. */
export const WORKER_SOCKET = process.env.JARVIS_WORKER_SOCKET?.trim() || 'jarvis-workers';
/** The command that opens a worker's live screen in any terminal. */
export const attachCommand = (session: string, socket = WORKER_SOCKET) => `tmux -L ${socket} attach -t ${session}`;
/** A tmux session name from a worker name and its resume count: tmux refuses `.` and `:` in a name. */
export const workerSession = (name: string, resumes: number) => `${name.replace(/[^A-Za-z0-9_-]/g, '-')}-r${resumes}`;

/**
 * Variables a session started inside Claude Code carries. With CLAUDE_CODE_CHILD_SESSION a worker saves no transcript and
 * `claude agents` does not list it. jarvisd under launchd has none of them; the pane drops them in case the tmux server
 * was started from such a session.
 */
const CHILD_VARS = ['CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_PID'];

export type WorkerTmux = {
  /** Starts `argv` in a new detached session. The last item goes through `lastFile`, so tmux's message size limit never meets a long brief. Returns the pane's pid, which is also its process group. */
  start(argv: string[], cwd: string, session: string, lastFile: string): number;
  /**
   * Types `text` into the session's pane as one paste, then Enter. tmux adds the paste brackets itself when the program
   * asked for them (Claude Code does), so newlines stay in one message. Rejects when tmux cannot.
   */
  type(session: string, text: string): Promise<void>;
  /** The visible screen as plain text. Rejects when the session is gone. */
  capture(session: string): Promise<string>;
};

export function makeWorkerTmux(o: { tmux?: string; socket?: string; env?: NodeJS.ProcessEnv; cols?: number; rows?: number } = {}): WorkerTmux {
  const tmux = o.tmux ?? findTmux();
  const base = ['-L', o.socket ?? WORKER_SOCKET, '-f', '/dev/null'];
  const env = o.env ?? process.env;
  const run = (args: string[], input?: Buffer) => new Promise<string>((resolve, reject) => {
    const c = execFile(tmux, [...base, ...args], { timeout: 5_000, env, maxBuffer: 4e6 }, (err, out, errOut) => err ? reject(new Error(String(errOut || err.message).trim())) : resolve(String(out)));
    if (input) c.stdin?.end(input);
  });
  return {
    start(argv, cwd, session, lastFile) {
      writeFileSync(lastFile, argv[argv.length - 1], { mode: 0o600 });
      const script = `unset ${CHILD_VARS.join(' ')}; exec "$@" "$(cat "$0")"`;
      const out = execFileSync(tmux, [...base, 'new-session', '-d', '-s', session, '-x', String(o.cols ?? 200), '-y', String(o.rows ?? 50), '-c', cwd,
        '-P', '-F', '#{pane_pid}', 'sh', '-c', script, lastFile, ...argv.slice(0, -1)], { env, timeout: 10_000 });
      const pid = Number(String(out).trim());
      if (!Number.isInteger(pid) || pid <= 0) throw new Error(`tmux new-session printed no pane pid: ${String(out).slice(0, 100)}`);
      return pid;
    },
    async type(session, text) {
      const buffer = `jarvis-type-${session}`;
      await run(['load-buffer', '-b', buffer, '-'], Buffer.from(text, 'utf8'));
      // -p: brackets when the program asked for bracketed paste. -r: newlines stay newlines. -d: the buffer goes after.
      // Raw escape bytes would not work: tmux 3.8 shows control characters in a paste as text (^[) unless -S, which
      // older tmux on Linux lacks. Probed live on 2026-11-18.
      await run(['paste-buffer', '-p', '-r', '-d', '-b', buffer, '-t', session]);
      await run(['send-keys', '-t', session, 'Enter']);
    },
    capture: session => run(['capture-pane', '-p', '-t', session]),
  };
}

/**
 * The blocking prompts jarvisd knows, matched against the bottom of the screen. Each needs every pattern of `all`.
 * The texts come from real screens (daemon/fixtures/screen-*.txt, Claude Code 2.1.322 on 2026-11-18), except the
 * permission, MCP and settings dialogs, which follow the wording Claude Code has used for them. Order matters: the first
 * match names the reason, and the generic dialog footer comes last.
 */
export const BLOCKING_PROMPTS: { reason: BlockedReason; all: RegExp[] }[] = [
  { reason: 'trust prompt', all: [/trust this folder|Is this a project you created or one you trust|Do you trust the files in this folder/i] },
  { reason: 'login', all: [/Select login method/i] },
  { reason: 'login', all: [/Paste code here if prompted/i] },
  { reason: 'login', all: [/Choose the text style that looks best/i] },
  // A turn that failed on an expired or missing login: Claude Code prints the API error and waits at its prompt.
  { reason: 'login', all: [/API Error[^\n]*(?:\b401\b|authentication_error)|Invalid API key · Please run \/login|OAuth token has expired/i] },
  { reason: 'mcp servers', all: [/New MCP servers? found|MCP servers? (?:found )?in (?:this project|\.mcp\.json)/i, /Enter to confirm|Use this and all future MCP servers/i] },
  { reason: 'settings error', all: [/Settings Error|invalid settings? files?/i, /Continue without|Exit and fix/i] },
  { reason: 'permission', all: [/Do you want to (?:proceed|make this edit|create|allow|run|fetch)/i, /\b1\. Yes\b/] },
  { reason: 'prompt on screen', all: [/Enter to confirm\s*·\s*Esc to (?:cancel|exit|go back)/i] },
];

/**
 * The reason in Claude Code's own words for a blocked session: the `waitingFor` text of `claude agents`, which jarvisd
 * already reads every 30 s. Claude Code writes these itself ("login required — run /login", "usage limit reached — check
 * plan"), from the same table it uses for its terminal status (OSC 7501). Plain matching, no model.
 */
export function needsReason(waitingFor: string | null | undefined): BlockedReason {
  const t = waitingFor ?? '';
  if (/permission/i.test(t)) return 'permission';
  if (/\/login|login required|OAuth|credentials|subscription|account on hold|verification required/i.test(t)) return 'login';
  if (/usage limit|rate limited|billing/i.test(t)) return 'usage limit';
  return 'prompt on screen';
}

/** How many non-blank lines at the bottom of the screen a prompt must be in. Text above that is old output, not a dialog. */
export const BOTTOM_LINES = 25;
/** A turn under way: Claude Code's spinner line. A screen with it is working, whatever else it shows. */
const RUNNING = /\besc to interrupt\b/i;

/**
 * The blocking prompt on a screen, or undefined. Plain pattern matching on the bottom lines, no model. A screen with a
 * turn under way is never blocked, so a long test run with no output stays working.
 */
export function matchScreen(screen: string): BlockedReason | undefined {
  const bottom = screen.split('\n').filter(l => l.trim()).slice(-BOTTOM_LINES).join('\n');
  if (!bottom || RUNNING.test(bottom)) return undefined;
  return BLOCKING_PROMPTS.find(p => p.all.every(r => r.test(bottom)))?.reason;
}
