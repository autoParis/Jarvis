import { OWNER_CAP, OWNER, cleanEnv } from './config.ts';
import { execFile } from 'node:child_process';
import { basename } from 'node:path';
import type { Store, Approval, Item } from './store.ts';
import { replyRaw, replyAll, selfAddresses, OWNER_EMAILS, withRecipients, fetchSignature, stripSignoff, gws as realGws, type EmailMeta, type Gws } from './gmail.ts';
import type { Log } from './log.ts';
import type { RouteResult, Body } from './route.ts';
import { SIDE_CHAT_PREFIX } from './work.ts';
import { shownTitle } from './requests.ts';
import { NAMED_ACTIONS, namedCardArgs, namedCommand, namedCwd, verifyNamed } from './namedactions.ts';
import { PROD_MCP_CALL, checkProdCall, makeProdMcp, type ProdMcp } from './prodmcp.ts';
import { ROW_PREFIX, type Native } from './native.ts';
import { ACTIONS, actionsWith } from '../web/contract.js';
import { workerBrief, questionSpec, nativeSideChatSpec } from './workercontract.ts';
export { ISSUE_RULE, CARD_RULE, nativeSideChatSpec } from './workercontract.ts';

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


const AUTOMATIC = actionsWith('automatic');
/**
 * Since 2026-11-08 (the owner's call) a worker-start on Jarvis's own repo starts at once when his own message in the
 * brain's current turn asked for it: the card is a notice with Stop, not Approve. Every other repo keeps the card.
 */
export const OWNER_ASKED = 'owner-asked';
/** How long Stop on a started notice works, counted from the end of the start. */
export const UNDO_MS = 60_000;
/** The decided_by of the worker-stop that Stop on a started notice creates. */
export const UNDO = 'undo';
/** Jarvis's own repo, and whether the brain's current turn answers a message of the owner (Brain.answeringOwner). */
export type OwnRepo = { repo: string; fromOwner: () => boolean };
/** Buttons in the work list. Pressing one is the owner's decision, so they run at once, and the brain cannot propose them. */
export const PRESSED = actionsWith('pressed');
/** A background worker's permission prompt, as a card. Only native.ts creates one; main.ts answers it through native.decide. */
export const WORKER_PERMISSION = 'worker-permission';
/** Typing into a worker's session, sending an email and the named actions run only on the Approve button, never on a relayed yes. */
export const BUTTON_ONLY = actionsWith('buttonOnly');
/** The `--name` of a native worker: the title's slug and the approval id, so it is unique and readable in `claude agents`. */
export const nativeName = (title: unknown, approval: number) => `${String(title ?? 'worker').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'worker'}-${approval}`;

const str = (v: unknown, name: string): string => {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`${name} is required`);
  return v;
};
const absPath = (v: unknown, name: string): string => {
  if (!str(v, name).startsWith('/')) throw new Error(`${name} must be an absolute path, got ${JSON.stringify(v)}`);
  return v as string;
};

/** Turns a proposed action into the exact argv the gate will run. Throws on bad input, before anything is stored. */
export function buildCommand(action: string, args: any, item: (externalId: string) => Item | undefined = () => undefined, self: string[] = [], signature = ''): string[] {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('args must be a JSON object');
  switch (action) {
    case 'today-draft': // a read-only worker in the repo's main checkout, started by today.ts. Its spec says read-only.
      return ['native', 'start', absPath(args.repo, 'repo (absolute path)'), str(args.spec, 'spec') + workerBrief()];
    case 'today-start': // the owner's tap, or his Go on the item. today.ts writes the spec: a task's never covers an outward action, and a story's carries ISSUE_RULE.
    case 'worker-start': {
      // A Claude background session in the repo (or in a worktree Claude makes), recorded only: execute hands it to native.start.
      const repo = absPath(args.repo, 'repo (absolute path)');
      const wt = args.worktree ?? 'new-top-level';
      if (args.permissionMode !== undefined && args.permissionMode !== 'auto' && args.permissionMode !== 'default') throw new Error('permissionMode must be auto or default');
      // A Today rerun after Not right names the folder of its first run (`path:<dir>`): the worker runs there, in no new worktree.
      const rerun = action === 'today-start' && typeof wt === 'string' && wt.startsWith('path:') ? absPath(wt.slice(5), 'worktree path') : undefined;
      if (!rerun && !['new-top-level', 'new-child', 'main'].includes(wt)) throw new Error('a native worker takes worktree main, new-top-level or new-child');
      return ['native', 'start', rerun ?? repo, str(args.spec, 'spec') + workerBrief({ issues: action === 'worker-start' })];
    }
    case 'question': { // automatic tier: a read-only worker in the repo's main checkout
      const repo = absPath(args.repo, 'repo (absolute path)');
      return ['native', 'start', repo, questionSpec(str(args.question, 'question'), 'answer in one final message whose first line is exactly `DONE: answered` and whose next lines are the answer, starting') + workerBrief()];
    }
    case 'side-chat': // may start with no first message (the new-session picker)
      return ['native', 'start', absPath(args.repo, 'repo (absolute path)'), nativeSideChatSpec(typeof args.text === 'string' ? args.text : '') + workerBrief()];
    case 'worker-stop':
    case 'worker-abandon':
      return ['native', action === 'worker-stop' ? 'stop' : 'abandon', str(args.dispatch, 'dispatch')];
    case WORKER_PERMISSION: // created by native.ts from a worker's hook, never proposed; the button goes to native.decide in main.ts.
      throw new Error('worker-permission cards come from a worker\'s own permission prompt; they cannot be proposed');
    case 'session-type': // recorded only: the message box under a native worker's pane types it itself (main.ts) and records it here.
      throw new Error('session-type is recorded by the message box; it does not run through the gate');
    case 'session-phone': // recorded only: native.phone runs it (Continue on phone), with its check for a second writer.
      return ['native', 'phone', str(args.session, 'session')];
    case 'terminal-send': { // the exact words, typed into a native worker's session through its input pipe (native.reply)
      const worker = str(args.terminal, 'terminal');
      if (!/^n:[\w-]+$/.test(worker)) throw new Error(`terminal ${worker} is not a native worker row`);
      return ['native', 'type', worker, str(args.text, 'text')];
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
      throw new Error(`unknown action ${action}. Allowed: ${Object.keys(ACTIONS).filter(a => !PRESSED.has(a) && a !== WORKER_PERMISSION).join(', ')}`);
  }
}

/** Runs jobs one after another. Worker starts go through one: on 2026-11-06 five approved in the same second each booted
 * Claude Code at once. */
export function oneAtATime() {
  let last: Promise<unknown> = Promise.resolve();
  return <T>(job: () => Promise<T>): Promise<T> => {
    const next = last.then(job, job);
    last = next.catch(() => {});
    return next;
  };
}

/** What makes two worker starts the same request: the title as the sidebar shows it, and the repo. */
const startKey = (args: any) => `${args.repo.replace(/\/+$/, '')}\n${shownTitle(String(args.taskTitle)).trim().replace(/\s+/g, ' ').toLowerCase()}`;

/** The error for a worker-start whose title and repo are already taken by an open one. */
function duplicateStart(args: any, open: Approval): string {
  const same = `A worker-start titled "${args.taskTitle}" in ${args.repo}`;
  const other = 'If this is a different task, use a title that names it.';
  if (open.status === 'pending') return `${same} is already pending as approval #${open.id}. If its spec is wrong, change it in place with jarvis-act revise ${open.id}. ${other}`;
  return `${same} is already running from approval #${open.id}${open.result ? ` (${open.result})` : ''}. If it is wrong, get it stopped with worker-stop first. ${other}`;
}

function run(argv: string[], cwd?: string): Promise<{ ok: boolean | 'unknown'; out: string }> {
  return new Promise(resolve => {
    execFile(argv[0], argv.slice(1), { env: cleanEnv, cwd, timeout: 180_000, maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
      const out = (stdout || stderr || String(err ?? '')).trim();
      if (argv[0] === 'gws') {
        // Sent means Gmail returned the new message's id. An error object means it refused. No JSON means we don't know.
        try { const j = JSON.parse(stdout.slice(stdout.indexOf('{'))); return resolve({ ok: !j.error && typeof j.id === 'string', out }); }
        catch { return resolve({ ok: 'unknown', out }); }
      }
      resolve({ ok: !err, out });
    });
  });
}

export function makeGate(store: Store, onChange: (a: Approval) => void, log: Log = () => {}, prod: ProdMcp = makeProdMcp(), gmail: Gws = realGws, native?: Pick<Native, 'start' | 'stop' | 'abandon'> & Partial<Pick<Native, 'reply'>>, own?: OwnRepo) {
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
  const starts = oneAtATime();
  /** Starts the owner pressed Stop on before they finished. The stop runs when the start ends. */
  const undoQueued = new Set<number>();
  const ownRoot = own?.repo.replace(/\/+$/, '');
  const inOwnRepo = (repo: unknown) => !!ownRoot && typeof repo === 'string' && (repo.replace(/\/+$/, '') === ownRoot || repo.startsWith(`${ownRoot}/`));

  /** The args and question a card stores, exactly as execute will build them. Throws on bad input, before anything is stored. */
  async function prepare(action: string, args: any, say: string): Promise<{ args: any; say: string }> {
    if (action === 'gmail-send' && args && typeof args === 'object') {
      // The card shows who it goes to (reply all), filled in from the stored email, never from the brain.
      const sent = store.gmailSendFor(String(args.item));
      if (sent) throw new Error(`a reply to ${args.item} is already ${sent.status} (approval #${sent.id}). Not sending twice.`);
      const self = await emailReady(action, args);
      const meta = JSON.parse(store.item(String(args.item))?.meta ?? '{}') as Partial<EmailMeta>;
      const r = store.item(String(args.item)) ? replyAll(meta, self) : { to: [], cc: [] };
      args = { item: args.item, to: r.to.join(', '), cc: r.cc.join(', '), subject: meta.subject, text: typeof args.text === 'string' ? stripSignoff(args.text) : args.text };
    }
    buildCommand(action, args, item, action === 'gmail-send' ? selfAddresses(store) : []); // validate now
    if (NAMED_ACTIONS.has(action)) args = namedCardArgs(action, args); // what the card shows is what execute builds
    if (action === PROD_MCP_CALL) {
      args = await prod.cardArgs(args);
      say = `Run ${args.tool} on production?`; // The heading comes from the call, not from the brain's words about it.
    }
    return { args, say: str(say, 'say') };
  }

  /** Refuses a worker-start whose title and repo an open one already has. `self` is the card being revised. */
  function refuseDuplicateStart(action: string, args: any, self?: number) {
    if (action !== 'worker-start' || !args.taskTitle) return;
    const key = startKey(args);
    const open = store.openWorkerStarts().find(a => { if (a.id === self) return false; const o = JSON.parse(a.args); return o.taskTitle && startKey(o) === key; });
    if (open) {
      log('gate refused a duplicate worker-start', { approval: open.id, action, status: open.status });
      throw new Error(duplicateStart(args, open));
    }
  }

  /**
   * Why a worker-start the brain marked ownerAsked still gets a card, or '' when it starts at once. Each check is one the
   * gate can prove itself: the repo, and that the brain is answering a message of the owner right now.
   */
  function whyCard(action: string, args: any): string {
    if (action !== 'worker-start') return `${action} is not a worker-start`;
    if (!own) return 'this daemon has no own repo set';
    if (!inOwnRepo(args.repo)) return `${args.repo} is not the Jarvis repo`;
    if (!own.fromOwner()) return 'the brain is not answering a message of the owner';
    return '';
  }

  /** Stop on a started notice: a worker-stop on the worker the start made, recorded like a button press. */
  async function stopStarted(a: Approval): Promise<Approval> {
    let r: any = {};
    try { r = JSON.parse(a.result ?? '{}'); } catch {}
    const dispatch = typeof r.worker === 'string' ? r.worker : typeof r.dispatchId === 'string' ? r.dispatchId : undefined;
    if (!dispatch) throw new Error(`approval #${a.id} names no worker to stop: ${a.result ?? 'no result'}`);
    const args = { dispatch };
    const same = store.sameApproval('worker-stop', JSON.stringify(args));
    if (same) return same;
    const title = JSON.parse(a.args).taskTitle ?? 'the worker';
    const stop = store.addApproval({ action: 'worker-stop', args: JSON.stringify(args), say: `Stop ${title}` });
    store.decide(stop.id, 'approved', UNDO);
    log('gate undo: stopping a worker started at once', { approval: a.id, stop: stop.id, dispatch });
    return execute(store.approval(stop.id)!);
  }

  /** A background Claude worker: start, stop or abandon through native.ts. The result names the worker, never a dispatch id. */
  async function runNative(a: Approval, args: any, argv: string[]): Promise<{ status: string; result: string }> {
    if (!native) return { status: 'failed', result: 'Native workers are not wired in this daemon.' };
    const ids = { approval: a.id, action: a.action };
    try {
      if (argv[1] === 'start') {
        // A question or a side chat runs in the repo's main checkout; a worker-start gets its own worktree unless told `main`.
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
      argv = buildCommand(a.action, args, item, self, a.action === 'gmail-send' ? await signatureFor(args.item) : '');
    }
    catch (e) {
      // Something changed since the proposal (the email was answered meanwhile). Nothing ran.
      store.finishApproval(a.id, 'failed', (e as Error).message);
      log('gate refused at run time', { approval: a.id, action: a.action, error: (e as Error).message });
      const done = store.approval(a.id)!;
      onChange(done);
      return done;
    }
    const ids = { approval: a.id, action: a.action };
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
    const r = await run(argv, namedCwd(a.action));
    let status = r.ok === true ? 'done' : r.ok === 'unknown' ? 'unknown' : 'failed';
    let result = summarize(r.out);
    if (NAMED_ACTIONS.has(a.action)) ({ status, result } = await verifyNamed(a.action, args, r, startedAt, run));
    store.finishApproval(a.id, status, result);
    if (a.action === 'gmail-send' && status !== 'failed') store.markItem(args.item, 'answered', args.text);
    log(`gate ${status}`, { ...ids, result, ...(a.action === 'gmail-send' ? { item: args.item } : {}) });
    const done = store.approval(a.id)!;
    onChange(done);
    return done;
  }

  return {
    /**
     * `card` is the proposer's If you approve and It rests on lines, shown under the question. Both are optional.
     * `ownerAsked` is the brain saying the owner's own message in this turn asks for the work. On the Jarvis repo the
     * worker then starts at once, and the app shows a notice with Stop for UNDO_MS. Anywhere else the card stays.
     */
    async propose(action: string, args: any, say: string, card?: ApprovalCard, opts: { ownerAsked?: boolean } = {}): Promise<Approval> {
      if (PRESSED.has(action)) throw new Error(`${action} runs only from ${OWNER}'s button in the work list`);
      ({ args, say } = await prepare(action, args, say));
      refuseDuplicateStart(action, args);
      const same = store.sameApproval(action, JSON.stringify(args));
      if (same) { log('gate repeat proposal, returning the existing one', { approval: same.id, action, status: same.status }); return same; }
      const why = opts.ownerAsked === true ? whyCard(action, args) : undefined;
      const a = store.addApproval({ action, args: JSON.stringify(args), say, card: cardJson(card) });
      log('gate proposed', { approval: a.id, action });
      if (why === '') {
        const asked = store.turn(store.lastOwnerTurn());
        store.decide(a.id, 'approved', OWNER_ASKED, asked?.text);
        log('gate started at once: the owner asked for it', { approval: a.id, action, turn: asked?.id });
        onChange(store.approval(a.id)!); // the notice shows Starting with Stop now; the start can take a minute
        const done = await execute(store.approval(a.id)!);
        if (undoQueued.delete(a.id) && (done.status === 'done' || done.status === 'unknown')) await stopStarted(done);
        return store.approval(a.id)!;
      }
      if (why) log('gate kept the card', { approval: a.id, action, why });
      onChange(a);
      if (AUTOMATIC.has(action)) {
        store.decide(a.id, 'approved', 'automatic');
        return execute(store.approval(a.id)!);
      }
      return a;
    },
    /**
     * The owner answered an open card with a change ("yes, but make it 400"). The brain sends the whole new args. The
     * card keeps its id and its place and shows the new content. A yes in the same answer can then confirm it.
     */
    async revise(approvalId: number, args: any, say?: string, card?: ApprovalCard): Promise<Approval> {
      const a = store.approval(approvalId);
      if (!a) throw new Error(`no approval ${approvalId}`);
      if (a.status !== 'pending') throw new Error(`approval ${approvalId} is already ${a.status}; propose a new one instead`);
      if (a.action === WORKER_PERMISSION) throw new Error('a worker\'s permission prompt cannot be changed');
      const next = await prepare(a.action, args, say || a.say);
      refuseDuplicateStart(a.action, next.args, a.id);
      if (!store.reviseApproval(a.id, { args: JSON.stringify(next.args), say: next.say, card: cardJson(card) })) throw new Error(`approval ${approvalId} was decided meanwhile`);
      const before = JSON.parse(a.args);
      const changed = Object.keys({ ...before, ...next.args }).filter(k => JSON.stringify(before[k]) !== JSON.stringify(next.args[k]));
      log('gate revised', { approval: a.id, action: a.action, changed, sayChanged: next.say !== a.say });
      const out = store.approval(a.id)!;
      onChange(out);
      return out;
    },
    /**
     * Stop on a started notice. It works for UNDO_MS after the start ended, and at any time while the start still runs
     * (the stop then runs when the start ends). Returns the worker-stop approval, or the start itself when queued.
     */
    async undo(approvalId: number): Promise<Approval> {
      const a = store.approval(approvalId);
      if (!a || a.decided_by !== OWNER_ASKED) throw new Error(`approval ${approvalId} is not a worker Jarvis started at once`);
      if (a.status === 'approved') {
        undoQueued.add(a.id);
        log('gate undo queued: the start is still running', { approval: a.id });
        return a;
      }
      if (a.status !== 'done' && a.status !== 'unknown') throw new Error(`the start ${a.status}, so there is no worker to stop`);
      const at = Date.parse(`${String(a.finished_at ?? a.decided_at).replace(' ', 'T')}Z`);
      if (!(Date.now() - at <= UNDO_MS)) throw new Error(`Stop works for ${UNDO_MS / 1000} seconds after the start. Stop it from the work list.`);
      return stopStarted(a);
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
    /** A work-list button (Side chat, Continue on phone). Recorded like any approval, decided by the press itself. */
    async pressed(action: string, args: any, say: string): Promise<Approval> {
      if (!PRESSED.has(action)) throw new Error(`${action} is not a work-list button`);
      buildCommand(action, args, item);
      const a = store.addApproval({ action, args: JSON.stringify(args), say });
      store.decide(a.id, 'approved', 'button', action.startsWith('session-') ? args.text : undefined);
      log('gate pressed', { approval: a.id, action });
      if (action === 'session-phone') return a; // native.phone runs it; `recorded` finishes the row with what it did.
      return execute(store.approval(a.id)!);
    },
    /** The outcome of a press the gate does not run itself. */
    recorded(approvalId: number, status: 'done' | 'failed', result: string) {
      store.finishApproval(approvalId, status, result);
      log(`gate ${status}`, { approval: approvalId, result });
    },
    /** Approve or Reject button in the app. */
    async button(approvalId: number, approve: boolean): Promise<Approval> {
      if (!store.decide(approvalId, approve ? 'approved' : 'rejected', 'button')) throw new Error('already decided');
      const a = store.approval(approvalId)!;
      if (!approve) { log('gate rejected', { approval: a.id, action: a.action, decidedBy: 'button' }); onChange(a); return a; }
      // Every open page swaps the buttons for "Working..." now; the command can take a minute or more.
      onChange(a);
      return execute(a);
    },
    /** A reply replaced by a newer one or closed by the owner. Not a decision, so it stays out of the audit log and the chat. */
    superseded(approvalId: number) {
      if (!store.decide(approvalId, 'rejected', 'automatic')) return;
      log('gate superseded', { approval: approvalId });
      onChange(store.approval(approvalId)!);
    },
    reject(approvalId: number): Approval {
      const msg = store.ownerTurnAfter(store.approval(approvalId)?.after_turn ?? 0);
      if (!store.decide(approvalId, 'rejected', 'voice', msg?.text)) throw new Error('not pending');
      const a = store.approval(approvalId)!;
      log('gate rejected', { approval: a.id, action: a.action, decidedBy: 'voice' });
      onChange(a);
      return a;
    },
  };
}

/** Keeps what the brain and the owner need from a command result: Gmail's ids, or the error. */
function summarize(out: string): string {
  try {
    const j = JSON.parse(out);
    return j.error ? `error ${j.error.code}: ${j.error.message}` : JSON.stringify({ gmailId: j.id, threadId: j.threadId }); // gws
  } catch {
    return out.slice(0, 500);
  }
}

export type Gate = ReturnType<typeof makeGate>;

export type GateCtx = {
  gate: Pick<Gate, 'button' | 'undo' | 'propose' | 'revise' | 'confirm' | 'reject'>;
  store: Pick<Store, 'approval' | 'pendingApprovals'>;
  native: Pick<Native, 'decide'>;
  killed: () => boolean;
  /** Holds a line for the brain's next turn. */
  hold: (text: string) => void;
  /** Wakes the brain with the text. */
  wake: (text: string) => void;
  /** A button's outcome for the brain: a failure wakes it, anything else waits for its next turn (main.ts gateNotice). */
  notice: (a: Approval, text: string) => void;
  /** A new proposal, for the reply that asks for it (chatlink.ts). */
  proposed: (a: Approval) => void;
};

/**
 * The approval routes: the owner's Approve, Reject, Allow and Deny buttons, Stop on a started notice, and the
 * jarvis-act calls (propose, revise, confirm, reject, list) the brain makes through bin/jarvis-act.
 */
export async function gateRoute(o: GateCtx, method: string, url: string, body: Body): Promise<RouteResult | undefined> {
  if (method === 'POST' && url === '/api/approval') {
    const { id, approve } = await body();
    // A native worker's permission prompt: the tap answers the held hook, and the worker goes on or is refused.
    if (o.store.approval(Number(id))?.action === WORKER_PERMISSION) {
      const r = o.native.decide(Number(id), approve === true);
      const a = o.store.approval(Number(id))!;
      if (!r.ok) return { status: 409, body: { error: r.error, approval: a } };
      if (!o.killed()) o.hold(`[gate] ${OWNER} ${approve ? 'allowed' : 'denied'} permission #${a.id} with the button; the worker ${approve ? 'goes on' : 'was refused and goes on without it'}. Reply SILENT.`);
      return { status: 200, body: a };
    }
    let a: Approval;
    try { a = await o.gate.button(Number(id), approve === true); }
    catch (e) { return { status: 409, body: { error: (e as Error).message, approval: o.store.approval(Number(id)) } }; }
    // The kill switch holds here too: this was the one send that woke the brain while data/KILL was on (found 2026-11-07 by a test daemon).
    if (!o.killed()) o.notice(a, `[gate] ${OWNER} ${approve ? 'approved' : 'rejected'} #${a.id} with the button. ${a.result ? `Result: ${a.result}` : ''} Tell him the outcome in one short sentence if it failed or needs follow-up, otherwise SILENT.`);
    return { status: 200, body: a };
  }
  // Stop on a started notice: the owner takes back a worker Jarvis started at once, within UNDO_MS.
  if (method === 'POST' && url === '/api/approval/undo') {
    const { id } = await body();
    let a: Approval;
    try { a = await o.gate.undo(Number(id)); }
    catch (e) { return { status: 409, body: { error: (e as Error).message, approval: o.store.approval(Number(id)) } }; }
    const queued = a.id === Number(id);
    if (!o.killed()) o.wake(`[gate] ${OWNER} pressed Stop on #${id}, the worker you started at once, within ${UNDO_MS / 1000} seconds. ${queued ? 'It stops as soon as its start ends.' : `Stop #${a.id}: ${a.status}${a.result ? `, ${a.result}` : ''}.`} He does not want it as it was. Ask him in one short sentence what to change, unless he already said.`);
    return { status: 200, body: a };
  }
  // ---- Called by bin/jarvis-act on behalf of the brain. An unknown op is not answered here, so it ends as a 404. ----
  if (url.startsWith('/api/internal/gate/')) {
    const op = url.slice('/api/internal/gate/'.length);
    const b = method === 'POST' ? await body() : {};
    try {
      if (op === 'propose') { const a = await o.gate.propose(b.action, b.args, b.say, b.card, { ownerAsked: b.ownerAsked === true }); o.proposed(a); return { status: 200, body: a }; }
      if (op === 'revise') return { status: 200, body: await o.gate.revise(Number(b.id), b.args, b.say, b.card) };
      if (op === 'confirm') return { status: 200, body: await o.gate.confirm(Number(b.id)) };
      if (op === 'reject') return { status: 200, body: o.gate.reject(Number(b.id)) };
      if (op === 'list') return { status: 200, body: o.store.pendingApprovals() };
    } catch (e) {
      return { status: 409, body: { error: (e as Error).message } };
    }
  }
  return undefined;
}
