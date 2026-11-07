import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { join } from "node:path";

// Actions jarvisd runs itself when the owner taps Approve, because Claude Code's permission check refuses a worker that tries
// them, whatever the owner said. Each is one fixed command. Each result comes from reading the thing back, not the exit code.

export const FBM_REPO = process.env.JARVIS_FBM_REPO || join(homedir(), "Repos", "FB-marketplace-uploader");
const PAUSE_SCRIPT = 'functions/scripts/reusable/pause-client.js';
const CLIENT_STATE = fileURLToPath(new URL('../bin/fbm-client-state.cjs', import.meta.url));
/** 30 days, the longest pause anyone has asked for (dealereleven, 2026-11-04). */
const MAX_PAUSE_HOURS = 720;
/** A pause further out than the requested end by more than this was there before, since the script keeps the later one. */
const EARLIER_PAUSE_MS = 10 * 60_000;

export const NAMED_ACTIONS = new Set(['gh-pr-close', 'fbm-client-pause']);

export type Named = { action: string; args: any };
type Exec = (argv: string[], cwd?: string) => Promise<{ ok: boolean | 'unknown'; out: string }>;
type Outcome = { status: 'done' | 'failed' | 'unknown'; result: string };

function prArgs(args: any): { repo: string; number: number; comment: string } {
  const repo = String(args.repo ?? '');
  if (!/^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*$/.test(repo)) throw new Error(`repo must be owner/name, got ${JSON.stringify(args.repo)}`);
  if (!/^[1-9]\d*$/.test(String(args.number ?? ''))) throw new Error(`number must be a PR number, got ${JSON.stringify(args.number)}`);
  if (typeof args.comment !== 'string' || !args.comment.trim()) throw new Error('comment is required: it says why the PR closed');
  return { repo, number: Number(args.number), comment: args.comment };
}

function pauseArgs(args: any): { client: string; hours: number } {
  const client = String(args.client ?? '');
  // A Firestore document id. The first character keeps it from reading as a flag.
  if (!/^[A-Za-z0-9][\w-]{0,99}$/.test(client)) throw new Error(`client must be a client id like dealereleven, got ${JSON.stringify(args.client)}`);
  const hours = Number(args.hours);
  if (!/^\d+(\.\d+)?$/.test(String(args.hours ?? '')) || hours <= 0 || hours > MAX_PAUSE_HOURS) throw new Error(`hours must be above 0 and at most ${MAX_PAUSE_HOURS}, got ${JSON.stringify(args.hours)}`);
  return { client, hours };
}

const checked = (action: string, args: any) => action === 'gh-pr-close' ? prArgs(args) : pauseArgs(args);

/** The exact argv. Throws on bad input, before anything is stored. */
export function namedCommand(action: string, args: any): string[] {
  if (action === 'gh-pr-close') {
    const { repo, number, comment } = prArgs(args);
    return ['gh', 'pr', 'close', String(number), '--repo', repo, '--comment', comment];
  }
  const { client, hours } = pauseArgs(args);
  return ['node', PAUSE_SCRIPT, '--client', client, '--hours', String(hours)];
}

export const namedCwd = (action: string): string | undefined => action === 'fbm-client-pause' ? FBM_REPO : undefined;

const quoted = (s: string) => /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * What gets stored and what the card shows: the checked args and the command they build. The gate computes `runs` here,
 * so anything the brain sent under that name is dropped.
 */
export function namedCardArgs(action: string, args: any): any {
  const line = namedCommand(action, args).map(quoted).join(' ');
  const runs = action === 'gh-pr-close'
    ? `${line}\n\nThen reads the PR back: its state and this comment.`
    : `cd ${FBM_REPO}\n${line}\n\nThen reads back _fbMarketplace.pauseUntil and enabled.`;
  return { ...checked(action, args), runs };
}

export function namedLabel({ action, args }: Named): string {
  return action === 'gh-pr-close' ? `Close PR ${args.number}` : `Pause ${args.client} for ${args.hours} hours`;
}

export function namedQuestion({ action, args }: Named): string {
  return action === 'gh-pr-close' ? `Close PR ${args.number} in ${args.repo}?` : `Pause ${args.client} for ${args.hours} hours?`;
}

const eastern = (d: Date) => `${d.toLocaleString('en-CA', { timeZone: 'America/Toronto', dateStyle: 'medium', timeStyle: 'short' })} Eastern`;

/** A failed command's words, kept only from lines these scripts write themselves, so a stack trace or a parse error quoting the key file stays out of the record. */
function safeFailure(out: string): string {
  const lines = out.split('\n').filter(l => /^(✗|Invalid --hours|Usage:|Fatal:|\[firestore-init\])/.test(l.trim()) && !/private|client_email|BEGIN /i.test(l));
  return lines.join(' ').slice(0, 300) || 'it gave no message Jarvis keeps';
}

async function verifyPrClose(args: any, command: { ok: boolean | 'unknown'; out: string }, exec: Exec): Promise<Outcome> {
  const { repo, number, comment } = prArgs(args);
  const said = command.ok === true ? '' : ` The close command said: ${command.out.slice(0, 300)}`;
  const read = await exec(['gh', 'pr', 'view', String(number), '--repo', repo, '--json', 'state,url,comments']);
  let pr: any;
  try { pr = read.ok === true ? JSON.parse(read.out) : undefined; } catch { /* handled below */ }
  if (typeof pr?.state !== 'string') return { status: 'unknown', result: `Could not read PR ${number} back, so its state is not known: ${read.out.slice(0, 200)}.${said}` };
  const clean = (s: unknown) => String(s ?? '').replace(/\r\n/g, '\n').trim();
  const commented = (pr.comments ?? []).some((c: any) => clean(c.body) === clean(comment));
  if (pr.state !== 'CLOSED') return { status: 'failed', result: `Not closed: PR ${number} reads ${pr.state} after the command.${said}` };
  // gh exits 0 on a PR that was already closed, and posts nothing.
  if (!commented) return { status: 'failed', result: `PR ${number} reads CLOSED, but your comment is not on it, so it may have closed earlier.${said}` };
  return { status: 'done', result: `Verified: PR ${number} is closed and your comment is on it. ${pr.url ?? ''}`.trim() };
}

async function verifyPause(args: any, command: { ok: boolean | 'unknown'; out: string }, startedAt: number, exec: Exec): Promise<Outcome> {
  const { client, hours } = pauseArgs(args);
  const said = command.ok === true ? '' : ` The pause command failed: ${safeFailure(command.out)}.`;
  const read = await exec(['node', CLIENT_STATE, '--client', client], FBM_REPO);
  let state: any;
  try { state = read.ok === true ? JSON.parse(read.out) : undefined; } catch { /* handled below */ }
  if (typeof state?.found !== 'boolean') return { status: 'unknown', result: `Could not read ${client} back, so its pause is not known.${said}` };
  if (!state.found) return { status: 'failed', result: `No client ${client} in Firestore, so nothing was paused.${said}` };
  const until = typeof state.pauseUntil === 'string' ? new Date(state.pauseUntil) : undefined;
  const wanted = startedAt + hours * 3_600_000;
  const name = state.name ? `${client} (${state.name})` : client;
  if (!until || until.getTime() < wanted) {
    return { status: 'failed', result: `Not paused: ${name} reads pauseUntil ${until ? eastern(until) : 'empty'}, short of the ${hours} hours asked.${said}` };
  }
  const paused = `${name} is paused until ${eastern(until)}`;
  if (state.enabled !== true) return { status: 'failed', result: `${paused}, but enabled reads ${JSON.stringify(state.enabled)}, not true. Check this client.` };
  const earlier = until.getTime() > wanted + EARLIER_PAUSE_MS ? ' A longer pause was already in place and stays.' : '';
  return { status: 'done', result: `Verified: ${paused}, and enabled is still true.${earlier}` };
}

/** Reads back what the command was meant to change. The read decides the status; no read means unknown, never done. */
export function verifyNamed(action: string, args: any, command: { ok: boolean | 'unknown'; out: string }, startedAt: number, exec: Exec): Promise<Outcome> {
  return action === 'gh-pr-close' ? verifyPrClose(args, command, exec) : verifyPause(args, command, startedAt, exec);
}

const LAYER = /\bpermissions?\s+(?:layer|system|check|classifier|rules?|policy)\b|\bpermission\s+for\s+this\s+action\b|\bauto[- ]mode\b|\bclassifier\b/i;
const REFUSED = /\b(?:den(?:y|ies|ied)|refus\w*|block\w*|reject\w*)\b/i;

/**
 * True when a worker says Claude Code's permission layer refused it: both in one sentence. A plain "permission denied" from
 * a file or an API does not count, since a retry can clear those. Words about an app's own permission check do count; the
 * card then loses only its Retry button.
 */
export function refusedByPermissionLayer(text: string): boolean {
  return text.split(/(?<=[.!?])\s+|\n+/).some(s => LAYER.test(s) && REFUSED.test(s));
}

const quotedFlag = (text: string, flags: string) =>
  new RegExp(`(?:${flags})[ =](?:"([^"]+)"|'([^']+)')`).exec(text)?.slice(1).find(Boolean);

/** The named action a worker's words spell out, whole and valid. A command missing its repo or comment is not one: Jarvis would be guessing. */
export function namedActionIn(text: string): Named | undefined {
  const flat = text.replace(/\\\n\s*/g, ' ');
  const candidates: Named[] = [];
  const pr = /\bgh\s+pr\s+close\s+(?:https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/)?#?(\d+)/.exec(flat);
  if (pr) {
    const number = pr[2];
    const repo = pr[1] ?? /(?:--repo|-R)[ =]["']?([\w.-]+\/[\w.-]+)/.exec(flat)?.[1] ?? new RegExp(`github\\.com/([\\w.-]+/[\\w.-]+)/pull/${number}\\b`).exec(flat)?.[1];
    candidates.push({ action: 'gh-pr-close', args: { repo, number, comment: quotedFlag(flat, '--comment|-c') } });
  }
  const pause = /pause-client\.js\b([^\n`]*)/.exec(flat)?.[1];
  if (pause) {
    const client = /--client[ =]["']?([\w-]+)/.exec(pause)?.[1], hours = /--hours[ =]["']?([\d.]+)/.exec(pause)?.[1];
    candidates.push({ action: 'fbm-client-pause', args: { client, hours: hours?.replace(/\.$/, '') } });
  }
  for (const c of candidates) {
    try { return { action: c.action, args: namedCardArgs(c.action, c.args) }; } catch { /* not whole */ }
  }
  return undefined;
}
