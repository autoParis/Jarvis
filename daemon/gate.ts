import { OWNER_CAP, OWNER } from './config.ts';
import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { cleanEnv } from './orca.ts';
import type { Store, Approval, Item } from './store.ts';
import { replyRaw, replyAll, selfAddresses, OWNER_EMAILS, withRecipients, fetchSignature, stripSignoff, gws as realGws, type EmailMeta, type Gws } from './gmail.ts';
import type { Log } from './log.ts';
import { SIDE_CHAT_PREFIX } from './work.ts';
import { shownTitle } from './requests.ts';
import { NAMED_ACTIONS, namedCardArgs, namedCommand, namedCwd, verifyNamed } from './namedactions.ts';
import { PROD_MCP_CALL, checkProdCall, makeProdMcp, type ProdMcp } from './prodmcp.ts';
import { PRODUCT_LABEL } from './config.ts';
import { NATIVE_FOOTER, ROW_PREFIX, type Native } from './native.ts';

/** Appended to every worker spec Jarvis dispatches, so asks arrive short enough to speak. */
export const ASK_FOOTER = `

## Asking the coordinator
Your coordinator is Jarvis, who reads your questions aloud to ${OWNER}. Ask only what needs a human decision. Phrase every \`orca orchestration ask\` exactly as:
STORY: <number and topic, at most 8 words>
WHERE: <what you are doing, one or two short sentences>
QUESTION: <one sentence>
CONTEXT: <optional, at most 3 sentences>
IMAGE: <optional, one absolute path to a .png .jpg .jpeg .webp or .gif>
OPTIONS: recommended first, at most 3, each "<choice> because <reason under 10 words>"
Pass the short choices in one --options flag, separated by commas: --options "Merged,Not yet". Do not repeat the flag, because Orca keeps only the last one. Orca splits on every comma, so write each choice without one. For anything visual, put a screenshot path in IMAGE (under the repo's docs/screens or data/uploads, ~/Desktop, ~/Downloads or ~/orca/workspaces) or a link in CONTEXT. ${OWNER_CAP} sees the picture on the ask card in the app.

If Claude Code's permission layer refuses a command, do not retry it or route around it: a retry hits the same refusal. Escalate, say the permission layer refused it, and quote the whole command. Jarvis itself can run two on ${OWNER}'s Approve tap, and his card offers them when your words give every value: \`gh pr close <number> --repo <owner/name> --comment "<why>"\` and, from the FBM repo, \`node functions/scripts/reusable/pause-client.js --client <id> --hours <hours>\`. It can also run one production ${PRODUCT_LABEL} MCP call on his tap: quote the exact tool name and the whole arguments JSON.

Before each batch of tool calls, write one plain sentence saying what you are about to do. ${OWNER_CAP} reads your conversation as a chat.`;

/**
 * Orca's own brief tells every worker "Don't post to Slack, GitHub, or other channels during the run", and Orca is not
 * modified. That line kept the story 3202 worker from filing the three bugs it proved, though pick-and-ship-v3 tells it to.
 * Story workers get this exception in their task; read-only workers, side chats and Today tasks do not.
 */
export const ISSUE_RULE = `

## Filing issues
The Orca brief above says not to post to GitHub. One exception: if this repo has a \`create-issue\` skill (\`.claude/skills/create-issue\`), you may file a GitHub issue for a real finding outside your task's scope, but only by invoking that skill and following it: its duplicate and already-shipped search, the tier, the P and type labels, the template sections and the \`**Tier:**\` line. Never a hand-rolled \`gh issue create\`. Skip its confirmation step, with these limits. Priority P2 or P3 only, never P0 or P1; say in the body why it might deserve more. When the search finds a live issue, comment on it instead of filing. List every issue you filed or commented on, by number, in your worker_done body. Without that skill, file nothing and put the findings in your report.`;

/** The two lines an approval card shows under its one-line question. Plain text, one or two short sentences each. */
export type ApprovalCard = { approves?: string; restsOn?: string };
/** The stored form of an ApprovalCard: JSON with only the non-empty lines, or null when there are none. */
export function cardJson(card: unknown): string | null {
  if (!card || typeof card !== 'object') return null;
  const c = card as Record<string, unknown>;
  const pick = (v: unknown) => typeof v === 'string' && v.trim() ? v.trim().slice(0, 600) : undefined;
  const out = { approves: pick(c.approves), restsOn: pick(c.restsOn) };
  return out.approves || out.restsOn ? JSON.stringify(out) : null;
}

/**
 * Appended to every worker spec, after the footer. The owner reads asks, escalations and reports on his phone, and a card
 * with one dense paragraph does not get read (his call, 2026-11-06). The app draws these fields under fixed headings.
 */
export const CARD_RULE = `

## How ${OWNER} reads your text
${OWNER_CAP} reads your asks, escalations and final report as cards on his phone. Each card must read in seconds. Follow the asd-ste100 skill (\`~/.claude/skills/asd-ste100/SKILL.md\`): STE-flavored mode for sentences, Strict mode for option choices.

An ask or an escalation uses the fields above. The card shows them under headings, in this order:
1. STORY is the title line: the story number and the topic.
2. WHERE is "What the worker is doing": one or two short sentences.
3. QUESTION is "The question": one sentence, at most 25 words.
4. OPTIONS: recommended first. Each choice is at most 5 words. Its reason says what that choice changes, in under 10 words.
5. CONTEXT goes behind a More toggle. Put long detail, numbers, paths and links there, not in QUESTION or WHERE.

Your final report has this shape:
- The first line: \`DONE: <the result in one sentence>\` or \`FAILED: <one sentence>\`. If your task gives an exact first line, use that line.
- Then at most 6 short bullets: what changed, the branch and commit, the PR link, what is not proven.
- Then long detail, if any, under \`## Details\` or other \`##\` headings. The app folds each heading.

Use active voice and simple tenses. Write one idea per sentence. Do not use semicolons.`;

const AUTOMATIC = new Set(['question']);
/** Buttons in the work list. Pressing one is the owner's decision, so they run at once, and the brain cannot propose them. */
export const PRESSED = new Set(['side-chat', 'side-chat-close', 'session-type', 'session-resume', 'prompt-key', 'today-issue', 'today-start', 'today-draft']);
/** Typing into another session, messaging another Run's worker, sending an email and the named actions run only on the Approve button, never on a relayed yes. */
/** A background worker's permission prompt, as a card. Only native.ts creates one; main.ts answers it through native.decide. */
export const WORKER_PERMISSION = 'worker-permission';
export const BUTTON_ONLY = new Set(['terminal-send', 'worker-send', 'gmail-send', ...NAMED_ACTIONS, PROD_MCP_CALL, WORKER_PERMISSION]);
/**
 * Since 2026-11-06 (The owner's call) a worker is a Claude background session by default: `worker-start`, `question` and
 * `side-chat` run through native.ts unless the proposal says `orca: true`. Today's starts and drafts followed on 2026-11-08
 * (idea 5, step one): a Today row keeps the `n:<id>` of its worker where it kept an Orca dispatch id. A stop or abandon
 * on an `n:<id>` row is native, and so is a `terminal-send` to one.
 */
export const NATIVE_BY_DEFAULT = new Set(['worker-start', 'question', 'side-chat', 'today-start', 'today-draft']);
export const isNativeArgs = (action: string, args: any) =>
  !!args && typeof args === 'object' && (NATIVE_BY_DEFAULT.has(action) ? args.orca !== true && args.native !== false
    : action === 'terminal-send' ? typeof args.terminal === 'string' && args.terminal.startsWith(ROW_PREFIX)
    : typeof args.dispatch === 'string' && args.dispatch.startsWith(ROW_PREFIX));
/** The issue rule for a worker that got no Orca brief. */
const NATIVE_ISSUE_RULE = ISSUE_RULE.replace('The Orca brief above says not to post to GitHub. One exception: if', 'One exception to not posting on GitHub: if');
/** A read-only question worker's task. `done` is how it reports: Orca's worker_done, or the native DONE line. */
const questionSpec = (question: string, done: string) => `Read-only research for ${OWNER}. Do not edit, create or delete files, do not commit, do not open or change PRs or issues, do not run anything that changes state.\n\nQuestion: ${question}\n\nUse the repo's own CLAUDE.md and skills. Then ${done} with a summary of at most 4 short sentences that can be read aloud, and put any detail (file paths, links) after a blank line in the same summary.`;
/** A native side chat: the same session as the Orca one, but it ends with a DONE line instead of worker_done, and asks nothing. */
export const nativeSideChatSpec = (text: string) => `Side chat with ${OWNER}. He started it from the Jarvis app to talk with you directly, apart from his main Jarvis conversation. This is a normal working session: read, edit, run and commit what he asks for.

He reads and answers you in this conversation from the Jarvis app, so talk to him here, in plain replies; every message of his arrives as a message from another session. Do not ask jarvis-brain anything. When ${OWNER} says he is done, end with a line starting DONE: and a one-sentence summary; until then, never write DONE or FAILED.

${text.trim() ? `His first message:

${text}` : 'He has not written yet. Reply with one short line saying you are ready and where you are working (the folder, and the branch if it is a worktree), then wait for his first message.'}`;
/**
 * The Orca Run and identity terminal, which an Orca command needs. With the Orca link off (JARVIS_ORCA, config.ts) jarvisd
 * makes neither, so an Orca start or message is refused before anything runs, with the reason.
 */
const orcaIds = (id: Identity): Identity => {
  if (!id.run || !id.handle) throw new Error('The Orca link is off (JARVIS_ORCA), so Jarvis has no Orca Run. Start a native worker instead: leave out "orca": true.');
  return id;
};
/** The `--name` of a native worker: the title's slug and the approval id, so it is unique and readable in `claude agents`. */
export const nativeName = (title: unknown, approval: number) => `${String(title ?? 'worker').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'worker'}-${approval}`;

type Identity = { run: string; handle: string };
const str = (v: unknown, name: string): string => {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`${name} is required`);
  return v;
};
const absPath = (v: unknown, name: string): string => {
  if (!str(v, name).startsWith('/')) throw new Error(`${name} must be an absolute path, got ${JSON.stringify(v)}`);
  return v as string;
};
// Actions that start a worker. Orca saying ok without a dispatch id is not proof that a worker exists.
const STARTS_WORKER = new Set(['worker-start', 'question', 'side-chat', 'today-start', 'today-draft']);

/** A side chat is a normal working session that the owner talks to in the app or in Orca, outside the Jarvis conversation. */
export const sideChatSpec = (text: string) => `Side chat with ${OWNER}. He started it from the Jarvis app to talk with you directly, apart from his main Jarvis conversation. This is a normal working session: read, edit, run and commit what he asks for.

He reads and answers you in this conversation, from the Jarvis app or from Orca, so talk to him here. Do not use \`orca orchestration ask\`, and do not send worker_done on your own. When ${OWNER} says he is done, send worker_done with a one-sentence summary.

${text.trim() ? `His first message:

${text}` : 'He has not written yet. Reply with one short line saying you are ready and where you are working (the folder, and the branch if it is a worktree), then wait for his first message.'}`;

/** Connectors few workers use, each with the deny rule that removes its tools. */
const OPTIONAL_CONNECTORS = [
  { name: /\bvercel\b/i, deny: 'mcp__vercel' },
  { name: /\bvoiceflow\b/i, deny: 'mcp__claude_ai_Voiceflow' },
];

/** Deny rules for the optional connectors a worker spec does not name. */
export const connectorsToDeny = (spec: string): string[] =>
  OPTIONAL_CONNECTORS.filter(c => !c.name.test(spec)).map(c => c.deny);

/**
 * Orca has no flag for a worker's connectors, so the deny rules go in the worktree's own settings before the agent
 * starts. That means creating the worktree first. The trim only saves tokens, so any failure here returns the args
 * unchanged and the worker starts the usual way, with every connector.
 */
async function withoutUnusedConnectors(args: any, approval: number, log: Log): Promise<any> {
  const deny = connectorsToDeny(args.spec);
  if ((args.worktree ?? 'new-top-level') !== 'new-top-level' || !deny.length) return args;
  const slug = String(args.taskTitle ?? 'worker').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  const name = `${slug || 'worker'}-${approval}`;
  const create = ['orca', 'worktree', 'create', '--name', name, '--repo', `path:${args.repo}`, '--no-parent', '--setup', 'run', '--json'];
  if (args.baseBranch) create.push('--base-branch', String(args.baseBranch));
  const r = await run(create);
  let path: unknown;
  try { path = JSON.parse(r.out).result?.worktree?.path; } catch {}
  if (r.ok !== true || typeof path !== 'string') {
    log('gate kept all connectors: no worktree', { approval, result: summarize(r.out) });
    return args;
  }
  // A worker in a worktree Orca did not create for it would close when it finishes, so ask for what a new one gets.
  const placed = { ...args, worktree: `path:${path}`, keepOpen: true };
  try {
    mkdirSync(join(path, '.claude'), { recursive: true });
    // wx: a repo that tracks this file keeps it. Git ignores this path through the owner's global ignore file.
    writeFileSync(join(path, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { deny } }, null, 2) + '\n', { flag: 'wx' });
    log('gate left connectors out', { approval, worktree: path, deny });
  } catch (e) {
    log('gate kept all connectors: settings not written', { approval, worktree: path, error: String(e) });
  }
  return placed;
}

/** Handles are ids like term_<uuid>. Anything else (a flag, a path) is refused, and so is Jarvis's own terminal. */
function terminalHandle(v: unknown, id: Identity): string {
  const terminal = str(v, 'terminal (handle from orca terminal list)');
  if (!/^[A-Za-z0-9][\w:.-]*$/.test(terminal)) throw new Error(`terminal ${terminal} is not an Orca terminal handle`);
  if (terminal === id.handle) throw new Error('that is Jarvis\'s own terminal');
  return terminal;
}

/** Turns a proposed action into the exact argv the gate will run. Throws on bad input, before anything is stored. */
export function buildCommand(action: string, args: any, id: Identity, item: (externalId: string) => Item | undefined = () => undefined, self: string[] = [], signature = ''): string[] {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('args must be a JSON object');
  switch (action) {
    case 'today-draft': // a read-only worker in the repo's main checkout, started by today.ts. Its spec says read-only.
      if (isNativeArgs(action, args)) return ['native', 'start', absPath(args.repo, 'repo (absolute path)'), str(args.spec, 'spec') + NATIVE_FOOTER + CARD_RULE];
      orcaIds(id);
      return ['orca', 'orchestration', 'worker-start', '--run', id.run, '--from', id.handle,
        '--worktree', `path:${absPath(args.repo, 'repo (absolute path)')}`, '--agent', 'claude', '--model', 'claude-opus-5-5',
        '--task-title', str(args.taskTitle, 'taskTitle'), '--spec', str(args.spec, 'spec') + ASK_FOOTER + CARD_RULE, '--json'];
    case 'today-start': // the owner's tap, or his Go on the item. today.ts writes the spec: a task's never covers an outward action, and a story's carries ISSUE_RULE.
    case 'worker-start': {
      const repo = absPath(args.repo, 'repo (absolute path)');
      const wt = args.worktree ?? 'new-top-level';
      if (isNativeArgs(action, args)) {
        // A Claude background session in the repo (or in a worktree Claude makes), recorded only: execute hands it to native.start.
        if (args.permissionMode !== undefined && args.permissionMode !== 'auto' && args.permissionMode !== 'default') throw new Error('permissionMode must be auto or default');
        // A Today rerun after Not right names the folder of its first run (`path:<dir>`): the worker runs there, in no new worktree.
        const rerun = action === 'today-start' && typeof wt === 'string' && wt.startsWith('path:') ? absPath(wt.slice(5), 'worktree path') : undefined;
        if (!rerun && !['new-top-level', 'new-child', 'main'].includes(wt)) throw new Error('a native worker takes worktree main, new-top-level or new-child');
        // A story's spec from today.ts carries the Orca wording of the issue rule; a native worker has no Orca brief.
        const spec = str(args.spec, 'spec').replace(ISSUE_RULE, NATIVE_ISSUE_RULE);
        return ['native', 'start', rerun ?? repo, spec + (action === 'worker-start' ? NATIVE_ISSUE_RULE : '') + NATIVE_FOOTER + CARD_RULE];
      }
      orcaIds(id);
      const fresh = wt === 'new-top-level' || wt === 'new-child';
      // Orca takes --repo, --base-branch and --name only when it creates the worktree.
      const place = fresh ? ['--worktree', wt, '--repo', `path:${repo}`] : ['--worktree', wt === 'main' ? `path:${repo}` : wt];
      const cmd = ['orca', 'orchestration', 'worker-start', '--run', id.run, '--from', id.handle,
        '--spec', str(args.spec, 'spec') + (action === 'worker-start' ? ISSUE_RULE : '') + ASK_FOOTER + CARD_RULE, ...place, '--agent', args.agent ?? 'claude',
        '--model', args.model ?? 'claude-opus-5-5'];
      if (args.keepOpen) cmd.push('--keep-open');
      if (args.taskTitle) cmd.push('--task-title', String(args.taskTitle));
      if (fresh && args.baseBranch) cmd.push('--base-branch', String(args.baseBranch));
      if (fresh && args.name) cmd.push('--name', String(args.name));
      return [...cmd, '--json'];
    }
    case 'question': { // automatic tier: read-only Opus worker in the repo's main checkout
      const repo = absPath(args.repo, 'repo (absolute path)');
      const question = str(args.question, 'question');
      if (isNativeArgs(action, args)) return ['native', 'start', repo, questionSpec(question, 'answer in one final message whose first line is exactly `DONE: answered` and whose next lines are the answer, starting') + NATIVE_FOOTER + CARD_RULE];
      orcaIds(id);
      return ['orca', 'orchestration', 'worker-start', '--run', id.run, '--from', id.handle,
        '--worktree', `path:${repo}`, '--agent', 'claude', '--model', 'claude-opus-5-5',
        '--task-title', `Question: ${question.slice(0, 60)}`,
        '--spec', questionSpec(question, 'report worker_done') + ASK_FOOTER + CARD_RULE,
        '--json'];
    }
    case 'side-chat': {
      // A native side chat may start with no first message (the new-session picker); Orca's still needs one.
      if (isNativeArgs(action, args)) return ['native', 'start', absPath(args.repo, 'repo (absolute path)'), nativeSideChatSpec(typeof args.text === 'string' ? args.text : '') + NATIVE_FOOTER + CARD_RULE];
      const text = str(args.text, 'text');
      orcaIds(id);
      return ['orca', 'orchestration', 'worker-start', '--run', id.run, '--from', id.handle,
        '--worktree', `path:${absPath(args.repo, 'repo (absolute path)')}`, '--agent', 'claude', '--model', 'claude-opus-5-5',
        '--task-title', `${SIDE_CHAT_PREFIX}${text.replace(/\s+/g, ' ').slice(0, 60)}`, '--spec', sideChatSpec(text), '--json'];
    }
    case 'side-chat-close':
    case 'worker-stop':
    case 'worker-abandon':
      if (action !== 'side-chat-close' && isNativeArgs(action, args)) return ['native', action === 'worker-stop' ? 'stop' : 'abandon', str(args.dispatch, 'dispatch')];
      return ['orca', 'orchestration', action === 'side-chat-close' ? 'worker-stop' : action, '--dispatch', str(args.dispatch, 'dispatch'), '--json'];
    case WORKER_PERMISSION: // created by native.ts from a worker's hook, never proposed; the button goes to native.decide in main.ts.
      throw new Error('worker-permission cards come from a worker\'s own permission prompt; they cannot be proposed');
    case 'session-resume': // recorded only: resume.ts runs it, with its own checks for a second writer.
      return ['resume', str(args.session, 'session')];
    case 'prompt-key': { // A tap on a terminal menu's option. One digit, no Enter: the digit picks the option by itself.
      const key = str(args.key, 'key');
      if (!/^\d$/.test(key)) throw new Error('key must be one digit');
      return ['orca', 'terminal', 'send', '--terminal', terminalHandle(args.terminal, id), '--text', key, '--json'];
    }
    case 'session-type': // the owner's own message from the box in the app, so it does not wait for Approve.
    case 'terminal-send': {
      // A native session (`n:<id>`) has no Orca terminal: its words go in through its stdin pipe (native.reply). Orca's
      // terminal send stays only for a terminal the owner opened himself in Orca.
      if (action === 'terminal-send' && isNativeArgs(action, args)) {
        const worker = str(args.terminal, 'terminal');
        if (!/^n:[\w-]+$/.test(worker)) throw new Error(`terminal ${worker} is not a native worker row`);
        return ['native', 'type', worker, str(args.text, 'text')];
      }
      const terminal = terminalHandle(args.terminal, id);
      return ['orca', 'terminal', 'send', '--terminal', terminal, '--text', str(args.text, 'text'), '--enter', ...(action === 'session-type' ? ['--wait-submit', '5'] : []), '--json'];
    }
    case 'worker-send': {
      // A message from the owner's steer box to a worker in another Run. Jarvis's own workers are steered without a card.
      const dispatch = str(args.dispatch, 'dispatch');
      if (!/^[\w-]+$/.test(dispatch)) throw new Error(`dispatch ${dispatch} is not an Orca dispatch id`);
      orcaIds(id);
      return ['orca', 'orchestration', 'send', '--from', id.handle, '--to', `dispatch:${dispatch}`, '--subject', `From ${OWNER}`, '--body', str(args.text, 'text'), '--json'];
    }
    case 'gmail-send': {
      // A reply all to an email jarvisd stored, in its thread. The recipients and subject come from the stored email,
      // never from the brain: the sender, plus everyone else who was on it, without the owner. Nobody new.
      const ext = str(args.item, 'item (the gmail:<id> of a stored email)');
      const email = item(ext);
      if (!email || email.source !== 'gmail') throw new Error(`no stored email ${ext}`);
      if (email.status === 'answered') throw new Error(`email ${ext} was already answered`);
      const meta = JSON.parse(email.meta ?? '{}') as EmailMeta;
      const r = replyAll(meta, [...self, ...OWNER_EMAILS]);
      // The card the owner approved must name exactly who it goes to now.
      if (args.to !== r.to.join(', ')) throw new Error(`to must be the sender of ${ext} (${r.to.join(', ')})`);
      if ((args.cc ?? '') !== r.cc.join(', ')) throw new Error(`cc must be everyone else on ${ext} (${r.cc.join(', ') || 'nobody'}). Propose the reply again.`);
      return ['gws', 'gmail', 'users', 'messages', 'send', '--params', JSON.stringify({ userId: 'me' }),
        '--json', JSON.stringify({ raw: replyRaw(meta, str(args.text, 'text'), r, signature), threadId: meta.threadId })];
    }
    case 'today-issue': // Accept on a Today story. `item` is only for the record, so a second Accept finds this one.
    case 'gh-issue-create':
      return ['gh', 'issue', 'create', '--repo', str(args.repo, 'repo (owner/name)'), '--title', str(args.title, 'title'), '--body', str(args.body, 'body')];
    case 'gh-pr-close':
    case 'fbm-client-pause':
      return namedCommand(action, args);
    case PROD_MCP_CALL: // recorded only: execute hands the stored tool and arguments to prodmcp.ts.
      return [PROD_MCP_CALL, checkProdCall(args).tool];
    default:
      throw new Error(`unknown action ${action}. Allowed: worker-start, question, worker-stop, worker-abandon, gh-issue-create, gh-pr-close, fbm-client-pause, prod-mcp-call, terminal-send, worker-send, gmail-send`);
  }
}

/**
 * Runs jobs one after another. Worker starts go through one: on 2026-11-06 five approved in the same second each booted
 * Claude Code at once, and Orca typed three of the tasks before Claude Code took input. Those three sat at an empty prompt.
 */
export function oneAtATime() {
  let last: Promise<unknown> = Promise.resolve();
  return <T>(job: () => Promise<T>): Promise<T> => {
    const next = last.then(job, job);
    last = next.catch(() => {});
    return next;
  };
}

/** The dispatch id and Orca's start state from a worker-start result, as summarize keeps it. */
function startReceipt(result: string): { dispatchId?: string; state?: string } {
  try { return JSON.parse(result); } catch { return {}; }
}

/** True when the worker has a transcript with at least one message: Claude Code took the task and its turn started. */
const hasTranscript = (out: string) => {
  try { const r = JSON.parse(out).result; return r?.source === 'transcript' && (r.transcript?.messages?.length ?? 0) > 0; } catch { return false; }
};

/** What makes two worker starts the same request: the title as the sidebar shows it, and the repo. */
const startKey = (args: any) => `${args.repo.replace(/\/+$/, '')}\n${shownTitle(String(args.taskTitle)).trim().replace(/\s+/g, ' ').toLowerCase()}`;

/** The error for a worker-start whose title and repo are already taken by an open one. */
function duplicateStart(args: any, open: Approval): string {
  const same = `A worker-start titled "${args.taskTitle}" in ${args.repo}`;
  const other = 'If this is a different task, use a title that names it.';
  if (open.status === 'pending') return `${same} is already pending as approval #${open.id}. If its spec is wrong, run jarvis-act reject ${open.id} first, then propose the fix. ${other}`;
  return `${same} is already running from approval #${open.id}${open.result ? ` (${open.result})` : ''}. If it is wrong, get it stopped with worker-stop first. ${other}`;
}

function run(argv: string[], cwd?: string): Promise<{ ok: boolean | 'unknown'; out: string }> {
  return new Promise(resolve => {
    execFile(argv[0], argv.slice(1), { env: cleanEnv, cwd, timeout: 180_000, maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
      const out = (stdout || stderr || String(err ?? '')).trim();
      if (argv[0] === 'orca') {
        try { return resolve({ ok: JSON.parse(stdout).ok === true, out }); }
        // No JSON means we don't know whether Orca applied it. Never retry blindly.
        catch { return resolve({ ok: 'unknown', out }); }
      }
      if (argv[0] === 'gws') {
        // Sent means Gmail returned the new message's id. An error object means it refused. No JSON means we don't know.
        try { const j = JSON.parse(stdout.slice(stdout.indexOf('{'))); return resolve({ ok: !j.error && typeof j.id === 'string', out }); }
        catch { return resolve({ ok: 'unknown', out }); }
      }
      resolve({ ok: !err, out });
    });
  });
}

/** What answers a menu: an option's number, or a one-word yes or no. */
const MENU_ANSWER = /^\s*(\d{1,2}|y|n|yes|no)\s*$/i;
const accepted = (out: string) => { try { return JSON.parse(out).result?.send?.accepted === true; } catch { return false; } };

/** Orca's request id when a one-shot send was refused because the agent shows a permission or trust menu. Nothing was written. */
function menuRefusal(out: string): string | undefined {
  try {
    const { ok, error } = JSON.parse(out);
    if (ok === false && error?.code === 'agent_prompt_blocked') return /--retry-request (\S+)/.exec(error.message)?.[1] ?? 'not given';
  } catch {}
  return undefined;
}

/**
 * Answers a menu the way Orca asks: the text alone, then a bare Enter. Both are direct input, so they carry no retry.
 * Orca refuses --retry-request on either one (invalid_argument), so the request id only goes in the record.
 */
async function answerMenu(terminal: string, text: string, request: string): Promise<{ status: string; result: string }> {
  const ref = `Orca refused the one-shot send as request ${request}.`;
  // Without --enter Orca writes the text verbatim and control bytes pass through, which the card would not show.
  if (/[\x00-\x1f\x7f-\x9f]/.test(text)) return { status: 'failed', result: `Not sent: the agent shows a permission or trust prompt, and this text has control characters that would reach the terminal raw. ${ref}` };
  const step = async (flags: string[]) => {
    const r = await run(['orca', 'terminal', 'send', '--terminal', terminal, ...flags, '--json']);
    if (r.ok !== true) return { status: r.ok === 'unknown' ? 'unknown' : 'failed', why: summarize(r.out) };
    // ok only says Orca answered. accepted says the input went in.
    return JSON.parse(r.out).result?.send?.accepted === true ? { status: 'done', why: '' } : { status: 'failed', why: `Orca did not accept the input: ${r.out.slice(0, 200)}` };
  };
  const typed = await step(['--text', text]);
  if (typed.status !== 'done') return { status: typed.status, result: `Answering the prompt, the text step ${typed.status === 'unknown' ? 'lost its answer' : 'failed'}, so no Enter went out: ${typed.why} ${ref}` };
  const entered = await step(['--enter']);
  if (entered.status !== 'done') return { status: entered.status, result: `The text was typed, but Enter ${entered.status === 'unknown' ? 'lost its answer' : 'failed'}: ${entered.why} ${ref}` };
  return { status: 'done', result: `Answered the prompt: typed the text, then Enter. ${ref}` };
}

/** How long the gate looks for a transcript after Orca could not see a worker take its task: startChecks reads, startCheckMs apart. */
export type StartCheck = { startCheckMs?: number; startChecks?: number; readBackMs?: number };

/** Lowercase, without colour codes or whitespace, so a wrapped or indented line still matches. */
const squash = (s: string) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\s+/g, '').toLowerCase();

/**
 * Whether a terminal's last lines show the text that was sent: its first line, up to 40 characters.
 * Claude Code folds a long paste into "[Pasted text #1 ...]", which also counts.
 */
export function showsText(tail: string[], text: string): boolean {
  const shown = squash(tail.join(''));
  const want = squash(text.split('\n').find(l => l.trim()) ?? '').slice(0, 40);
  return want === '' || shown.includes(want) || shown.includes('[pastedtext#');
}

/** The start of a failed worker-start's result when Claude Code never got the task. main.ts tells the brain on it. */
export const NO_TASK = 'The task never reached the agent';

export function makeGate(store: Store, id: Identity, onChange: (a: Approval) => void, log: Log = () => {}, prod: ProdMcp = makeProdMcp(), gmail: Gws = realGws, check: StartCheck = {}, native?: Pick<Native, 'start' | 'stop' | 'abandon'> & Partial<Pick<Native, 'reply'>>) {
  const item = (ext: string) => store.item(ext);
  /** Before a gmail-send is built: the email's To and Cc (read from Gmail for an older email) and the owner's addresses. */
  const emailReady = async (action: string, args: any) => {
    if (action !== 'gmail-send' || typeof args?.item !== 'string' || store.item(args.item)?.source !== 'gmail') return [];
    await withRecipients(store, gmail, args.item, log);
    return selfAddresses(store);
  };
  /** the owner's Gmail signature, read at send time so an edit in Gmail counts at once. No signature, no send. */
  const signatureFor = async (ext: string) => {
    let sig: string;
    try { sig = await fetchSignature(gmail); }
    catch (e) { throw new Error(`Not sent: I could not read your Gmail signature, and every reply ends with it. ${(e as Error).message}`); }
    log('gmail signature read', { item: ext, chars: sig.length });
    if (!sig) log('gmail has no signature for the default send-as address, sending without one', { item: ext });
    return sig;
  };
  const startCheckMs = check.startCheckMs ?? 60_000, startChecks = check.startChecks ?? 3, readBackMs = check.readBackMs ?? 3_000;

  /**
   * A terminal-send Orca accepted is done only when the terminal shows the text a moment later. On 2026-11-07 and
   * 2026-11-08 two sends came back ok with an empty result, and nothing was typed.
   */
  async function readBack(terminal: string, text: string): Promise<{ status: string; result: string }> {
    await new Promise(r => setTimeout(r, readBackMs));
    const r = await run(['orca', 'terminal', 'read', '--terminal', terminal, '--limit', '200', '--json']);
    let tail: unknown;
    try { tail = JSON.parse(r.out).result?.terminal?.tail; } catch {}
    if (r.ok !== true || !Array.isArray(tail)) return { status: 'unknown', result: `Orca took the text, but Jarvis could not read the terminal back to check it: ${summarize(r.out)}` };
    if (!showsText(tail, text)) return { status: 'failed', result: `Orca said it typed the text, but ${Math.round(readBackMs / 1000)} seconds later the terminal does not show it. Nothing seems to have gone in.` };
    return { status: 'done', result: 'Typed it, and the terminal shows it.' };
  }
  const starts = oneAtATime();
  const checks = new Set<Promise<void>>();

  /**
   * Orca typed the task but did not see the agent's turn start. A transcript with a message means Claude Code took it;
   * none after the last read means it sits at an empty prompt, which the owner must hear about instead of a working worker.
   */
  async function confirmStart(a: Approval, receipt: string, dispatch: string) {
    const ids = { run: id.run, approval: a.id, action: a.action, dispatch };
    for (let n = 1; n <= startChecks; n++) {
      await new Promise(r => setTimeout(r, startCheckMs));
      const read = await run(['orca', 'orchestration', 'worker-read', '--dispatch', dispatch, '--limit', '5', '--json']);
      if (read.ok === true && hasTranscript(read.out)) {
        store.finishApproval(a.id, 'done', receipt);
        log('gate worker start: transcript seen, the agent has its task', { ...ids, read: n });
        onChange(store.approval(a.id)!);
        return;
      }
    }
    const minutes = Math.round(startCheckMs * startChecks / 60_000);
    const result = `${NO_TASK}: Orca typed it into dispatch ${dispatch}, but after ${minutes} minutes there is no turn and no transcript, so the worker waits at an empty prompt. Stop it with worker-stop on ${dispatch} and start it again.`;
    store.finishApproval(a.id, 'failed', result);
    log('gate worker start: task never reached the agent', { ...ids, reads: startChecks });
    onChange(store.approval(a.id)!);
  }

  /** A background Claude worker: start, stop or abandon through native.ts. The result names the worker, never a dispatch id. */
  async function runNative(a: Approval, args: any, argv: string[]): Promise<{ status: string; result: string }> {
    if (!native) return { status: 'failed', result: 'Native workers are not wired in this daemon.' };
    const ids = { run: id.run, approval: a.id, action: a.action };
    try {
      if (argv[1] === 'start') {
        // A question or a side chat runs in the repo's main checkout, like its Orca twin; a worker-start gets its own worktree unless told `main`.
        const title = args.taskTitle ?? (a.action === 'question' ? `question ${String(args.question).slice(0, 40)}` : a.action === 'side-chat' ? `${SIDE_CHAT_PREFIX}${String(args.text || `new in ${basename(argv[2])}`).slice(0, 40)}` : undefined);
        // A side chat stays in the main checkout unless the owner turned Worktree on in the picker.
        // A Today rerun runs in its first run's folder (argv[2]), which is already its own.
        const own = a.action === 'worker-start' || (a.action === 'today-start' && !String(args.worktree ?? '').startsWith('path:')) || (a.action === 'side-chat' && args.worktree === true);
        const w = await starts(() => native.start({
          name: nativeName(title, a.id), cwd: argv[2], brief: argv[3], model: args.model, permissionMode: args.permissionMode,
          approvalId: a.id, worktree: own && (args.worktree ?? 'new-top-level') !== 'main', interactive: args.background !== true, // interactive by default since 2026-11-07; `background: true` is the opt-out, `interactive` is accepted and ignored
        }));
        log('gate started a native worker', { ...ids, worker: w.id, session: w.session_id, name: w.name });
        return { status: 'done', result: JSON.stringify({ worker: `${ROW_PREFIX}${w.id}`, sessionId: w.session_id, name: w.name, state: w.state }) };
      }
      if (argv[1] === 'type') {
        // The owner's Approve on a terminal-send: the exact words, typed into the session's terminal through its pipe.
        if (!native.reply) return { status: 'failed', result: 'Typing into native sessions is not wired in this daemon.' };
        const r = await native.reply(argv[2].slice(ROW_PREFIX.length), argv[3], 'owner');
        log(r.ok ? 'gate typed into a native session' : 'gate could not type into a native session', { ...ids, worker: argv[2], ...(r.ok ? {} : { error: r.error }) });
        return r.ok ? { status: 'done', result: JSON.stringify({ worker: argv[2], sent: true }) } : { status: 'failed', result: `Not sent: ${r.error}` };
      }
      await (argv[1] === 'stop' ? native.stop(argv[2]) : native.abandon(argv[2]));
      log(`gate ${argv[1] === 'stop' ? 'stopped' : 'abandoned'} a native worker`, { ...ids, worker: argv[2] });
      return { status: 'done', result: JSON.stringify({ worker: argv[2], state: argv[1] === 'stop' ? 'stopped' : 'abandoned' }) };
    } catch (e) {
      log('gate native action failed', { ...ids, error: (e as Error).message });
      return { status: 'failed', result: (e as Error).message };
    }
  }

  async function execute(a: Approval): Promise<Approval> {
    const args = JSON.parse(a.args);
    let argv: string[], self: string[] = [];
    try {
      self = await emailReady(a.action, args);
      argv = buildCommand(a.action, args, id, item, self, a.action === 'gmail-send' ? await signatureFor(args.item) : '');
    }
    catch (e) {
      // Something changed since the proposal (the email was answered meanwhile). Nothing ran.
      store.finishApproval(a.id, 'failed', (e as Error).message);
      log('gate refused at run time', { run: id.run, approval: a.id, action: a.action, error: (e as Error).message });
      const done = store.approval(a.id)!;
      onChange(done);
      return done;
    }
    const ids = { run: id.run, approval: a.id, action: a.action };
    log('gate run', { ...ids, decidedBy: a.decided_by });
    if (a.action === PROD_MCP_CALL) {
      const { status, result } = await prod.run(args);
      store.finishApproval(a.id, status, result);
      log(`gate ${status}`, { ...ids, who: `The owner, ${a.decided_by}`, tool: args.tool, arguments: args.arguments, result });
      const done = store.approval(a.id)!;
      onChange(done);
      return done;
    }
    if (argv[0] === 'native') {
      const { status, result } = await runNative(a, args, argv);
      store.finishApproval(a.id, status, result);
      log(`gate ${status}`, { ...ids, native: true, result });
      const done = store.approval(a.id)!;
      onChange(done);
      return done;
    }
    const startedAt = Date.now();
    const r = !STARTS_WORKER.has(a.action) ? await run(argv, namedCwd(a.action)) : await starts(async () => {
      if (a.action === 'worker-start' || a.action === 'today-start') argv = buildCommand(a.action, await withoutUnusedConnectors(args, a.id, log), id, item, self);
      return run(argv, namedCwd(a.action));
    });
    let status = r.ok === true ? 'done' : r.ok === 'unknown' ? 'unknown' : 'failed';
    let result = summarize(r.out);
    if (NAMED_ACTIONS.has(a.action)) ({ status, result } = await verifyNamed(a.action, args, r, startedAt, run));
    if (status === 'done' && STARTS_WORKER.has(a.action) && !/"dispatchId"/.test(result)) {
      status = 'unknown';
      result = `Orca said ok but returned no dispatch id: ${result}`;
    }
    // ok with a dispatch id only says Orca typed the task. Its state says whether the agent took it ('ready').
    const receipt = status === 'done' && STARTS_WORKER.has(a.action) ? startReceipt(result) : {};
    const unseen = receipt.dispatchId && receipt.state && receipt.state !== 'ready' ? receipt.dispatchId : undefined;
    const confirmed = result;
    if (unseen) {
      status = 'unknown';
      result = JSON.stringify({ ...receipt, check: `Orca did not see the agent take the task, so Jarvis looks for its transcript for ${Math.round(startCheckMs * startChecks / 60_000)} minutes` });
    }
    const request = a.action === 'terminal-send' || a.action === 'session-type' ? menuRefusal(r.out) : undefined;
    if (request && a.action === 'session-type' && !MENU_ANSWER.test(args.text)) {
      // Enter on a menu picks whatever is highlighted, which could be "allow". A sentence is not an answer to it.
      status = 'failed';
      result = `prompt_open: It is showing a permission or trust prompt, so nothing was typed. Send the option's number to answer it.`;
    } else if (request) {
      log('gate answering a prompt with separate text and Enter', { ...ids, request });
      ({ status, result } = await answerMenu(args.terminal, args.text, request));
    }
    if ((a.action === 'session-type' || a.action === 'prompt-key' || a.action === 'terminal-send') && status === 'done' && !request && !accepted(r.out)) {
      status = 'failed';
      result = `Orca did not accept the input: ${r.out.slice(0, 200)}`;
    }
    if (a.action === 'terminal-send' && status === 'done' && !request) ({ status, result } = await readBack(args.terminal, args.text));
    store.finishApproval(a.id, status, result);
    if (a.action === 'gmail-send' && status !== 'failed') store.markItem(args.item, 'answered', args.text);
    log(`gate ${status}`, { ...ids, result, ...(a.action === 'gmail-send' ? { item: args.item } : {}) });
    const done = store.approval(a.id)!;
    onChange(done);
    if (unseen) {
      const c = confirmStart(done, confirmed, unseen).catch(e => log('gate worker start: check failed', { ...ids, error: String(e) }));
      checks.add(c);
      c.finally(() => checks.delete(c));
    }
    return done;
  }

  return {
    /** After a restart: picks the start checks back up for worker starts still unknown from the last hour. */
    resumeChecks(): number {
      const open = store.db.prepare(`SELECT * FROM approvals WHERE status = 'unknown' AND result LIKE '%"check":%'
        AND COALESCE(decided_at, created_at) > datetime('now', '-1 hour')`).all() as Approval[];
      let n = 0;
      for (const a of open) {
        if (!STARTS_WORKER.has(a.action)) continue;
        const { check: _, ...receipt } = startReceipt(a.result ?? '') as any;
        if (typeof receipt.dispatchId !== 'string') continue;
        const c = confirmStart(a, JSON.stringify(receipt), receipt.dispatchId).catch(e => log('gate worker start: check failed', { run: id.run, approval: a.id, error: String(e) }));
        checks.add(c);
        c.finally(() => checks.delete(c));
        n++;
      }
      return n;
    },
    /** Resolves when every running start check has finished. For tests. */
    async checking(): Promise<void> { await Promise.all([...checks]); },
    /** `card` is the proposer's If you approve and It rests on lines, shown under the question. Both are optional. */
    async propose(action: string, args: any, say: string, card?: ApprovalCard): Promise<Approval> {
      if (PRESSED.has(action)) throw new Error(`${action} runs only from ${OWNER}'s button in the work list`);
      if (action === 'gmail-send' && args && typeof args === 'object') {
        // The card shows who it goes to (reply all), filled in from the stored email, never from the brain.
        const sent = store.gmailSendFor(String(args.item));
        if (sent) throw new Error(`a reply to ${args.item} is already ${sent.status} (approval #${sent.id}). Not sending twice.`);
        const self = await emailReady(action, args);
        const meta = JSON.parse(store.item(String(args.item))?.meta ?? '{}') as Partial<EmailMeta>;
        const r = store.item(String(args.item)) ? replyAll(meta, self) : { to: [], cc: [] };
        args = { item: args.item, to: r.to.join(', '), cc: r.cc.join(', '), subject: meta.subject, text: typeof args.text === 'string' ? stripSignoff(args.text) : args.text };
      }
      buildCommand(action, args, id, item, action === 'gmail-send' ? selfAddresses(store) : []); // validate now
      if (NAMED_ACTIONS.has(action)) args = namedCardArgs(action, args); // what the card shows is what execute builds
      if (action === PROD_MCP_CALL) {
        args = await prod.cardArgs(args);
        say = `Run ${args.tool} on production?`; // The heading comes from the call, not from the brain's words about it.
      }
      if (action === 'worker-start' && args.taskTitle) {
        const key = startKey(args);
        const open = store.openWorkerStarts().find(a => { const o = JSON.parse(a.args); return o.taskTitle && startKey(o) === key; });
        if (open) {
          log('gate refused a duplicate worker-start', { run: id.run, approval: open.id, action, status: open.status });
          throw new Error(duplicateStart(args, open));
        }
      }
      const same = store.sameApproval(action, JSON.stringify(args));
      if (same) { log('gate repeat proposal, returning the existing one', { run: id.run, approval: same.id, action, status: same.status }); return same; }
      const a = store.addApproval({ action, args: JSON.stringify(args), say: str(say, 'say'), card: cardJson(card) });
      log('gate proposed', { run: id.run, approval: a.id, action });
      onChange(a);
      if (AUTOMATIC.has(action)) {
        store.decide(a.id, 'approved', 'automatic');
        return execute(store.approval(a.id)!);
      }
      return a;
    },
    /** Spoken or typed yes, relayed by the brain. Runs only if the owner said something after the proposal. */
    async confirm(approvalId: number): Promise<Approval> {
      const a = store.approval(approvalId);
      if (!a) throw new Error(`no approval ${approvalId}`);
      if (a.status !== 'pending') throw new Error(`approval ${approvalId} is already ${a.status}`);
      if (BUTTON_ONLY.has(a.action)) throw new Error(`${a.action} runs only when ${OWNER} taps Approve in the app. Tell him to tap it.`);
      const msg = store.ownerTurnAfter(a.after_turn);
      if (!msg) throw new Error(`${OWNER_CAP} has not said anything since this was proposed. Ask him first.`);
      if (!store.decide(a.id, 'approved', 'voice', msg.text)) throw new Error(`approval ${approvalId} was already decided`);
      return execute(store.approval(a.id)!);
    },
    /** A work-list button (Side chat, Close). Recorded like any approval, decided by the press itself. */
    async pressed(action: string, args: any, say: string): Promise<Approval> {
      if (!PRESSED.has(action)) throw new Error(`${action} is not a work-list button`);
      buildCommand(action, args, id, item);
      const a = store.addApproval({ action, args: JSON.stringify(args), say });
      store.decide(a.id, 'approved', 'button', action.startsWith('session-') ? args.text : undefined);
      log('gate pressed', { run: id.run, approval: a.id, action });
      if (action === 'session-resume') return a; // The resumer runs it; `recorded` finishes the row with what it did.
      return execute(store.approval(a.id)!);
    },
    /** The outcome of a press the gate does not run itself. */
    recorded(approvalId: number, status: 'done' | 'failed', result: string) {
      store.finishApproval(approvalId, status, result);
      log(`gate ${status}`, { run: id.run, approval: approvalId, result });
    },
    /** Approve or Reject button in the app. */
    async button(approvalId: number, approve: boolean): Promise<Approval> {
      if (!store.decide(approvalId, approve ? 'approved' : 'rejected', 'button')) throw new Error('already decided');
      const a = store.approval(approvalId)!;
      if (!approve) { log('gate rejected', { run: id.run, approval: a.id, action: a.action, decidedBy: 'button' }); onChange(a); return a; }
      // Every open page swaps the buttons for "Working..." now; the command can take a minute or more.
      onChange(a);
      return execute(a);
    },
    /** A reply replaced by a newer one or closed by the owner. Not a decision, so it stays out of the audit log and the chat. */
    superseded(approvalId: number) {
      if (!store.decide(approvalId, 'rejected', 'automatic')) return;
      log('gate superseded', { run: id.run, approval: approvalId });
      onChange(store.approval(approvalId)!);
    },
    reject(approvalId: number): Approval {
      const msg = store.ownerTurnAfter(store.approval(approvalId)?.after_turn ?? 0);
      if (!store.decide(approvalId, 'rejected', 'voice', msg?.text)) throw new Error('not pending');
      const a = store.approval(approvalId)!;
      log('gate rejected', { run: id.run, approval: a.id, action: a.action, decidedBy: 'voice' });
      onChange(a);
      return a;
    },
  };
}

/** Keeps what the brain and the owner need from a command result: ids, state, errors. */
function summarize(out: string): string {
  try {
    const j = JSON.parse(out);
    if (j.ok === undefined) return j.error ? `error ${j.error.code}: ${j.error.message}` : JSON.stringify({ gmailId: j.id, threadId: j.threadId }); // gws
    if (!j.ok) return `error ${j.error?.code}: ${j.error?.message}`;
    const r = j.result ?? {};
    const keep = { dispatchId: r.dispatchId, taskId: r.taskId, state: r.state, worktree: r.effects?.find?.((e: any) => e.kind === 'worktree')?.path };
    return JSON.stringify(Object.fromEntries(Object.entries(keep).filter(([, v]) => v !== undefined)));
  } catch {
    return out.slice(0, 500);
  }
}

export type Gate = ReturnType<typeof makeGate>;
