import { execFile } from 'node:child_process';
import { cleanEnv } from './orca.ts';
import { eastern } from './reminders.ts';
import { sqlTime } from './push.ts';
import type { Store, SupportReply } from './store.ts';
import type { SendResult } from './replyworker.ts';
import type { Log } from './log.ts';
import { TICKET_PREFIX } from './config.ts';

// the owner's rule: a support reply about a code fix goes out only once the fix is in production. He approves the words once,
// the brain adds them with `jarvis-act reply-add`, and each tick of the ten-minute check decides in code here.

/** The only repo whose production signal has been read and checked. */
export const LIVE_REPO = 'example-org/acmeapp_nextjs';
const MANUAL_LABEL = 'manual-steps-needed';

export type Gh = (path: string) => Promise<any>;
export const gh: Gh = path => new Promise((resolve, reject) => {
  execFile('gh', ['api', path], { env: cleanEnv, timeout: 60_000, maxBuffer: 100 * 1024 * 1024 }, (err, stdout, stderr) => {
    if (err) return reject(new Error(`gh api ${path.split('?')[0]}: ${String(stderr || err).trim().slice(0, 200)}`));
    try { resolve(JSON.parse(stdout)); } catch { reject(new Error(`gh api ${path.split('?')[0]} returned no JSON`)); }
  });
});

export type Live =
  | { state: 'live'; sha: string; releasePr: number; manualSteps: boolean }
  /** Readable, and not there yet. */
  | { state: 'waiting'; why: string }
  /** It will never go live this way. */
  | { state: 'hold'; why: string };

/** Vercel's status on the deployment. The DB migrate job also writes `success` on it, about 3 minutes before the app is up. */
const vercelDone = (s: any) => {
  if (s?.state !== 'success' || typeof s.environment_url !== 'string') return false;
  try { return new URL(s.environment_url).hostname.endsWith('.vercel.app'); } catch { return false; }
};

/**
 * Is this PR in production? Throws when the state cannot be read, so unknown never counts as live.
 *
 * Checked against real data on 2026-11-05. Only a deployment with ref `main` counts: the `production` records with ref
 * `staging` are manual runs of the DB migrate workflow, which change the schema and deploy no app, and they contain
 * commits that are not released. Releases are true merge commits, so ancestry holds for a staging PR once its release is
 * deployed: compare says `ahead` for one and `behind` for one not released.
 */
export async function checkLive(api: Gh, repo: string, pr: number): Promise<Live> {
  const r = `repos/${repo}`;
  const p = await api(`${r}/pulls/${pr}`);
  if (p?.number !== pr) throw new Error(`GitHub returned no PR #${pr}`);
  if (p.merged !== true) return p.state === 'closed' ? { state: 'hold', why: `PR #${pr} was closed without merging` } : { state: 'waiting', why: `PR #${pr} is not merged` };
  if (!/^[0-9a-f]{40}$/.test(p.merge_commit_sha ?? '')) throw new Error(`PR #${pr} has no merge commit`);

  const deployments = await api(`${r}/deployments?environment=production&ref=main&per_page=1`);
  const d = Array.isArray(deployments) ? deployments[0] : undefined;
  if (d?.ref !== 'main' || d.environment !== 'production' || !/^[0-9a-f]{40}$/.test(d.sha ?? '')) throw new Error('no production deployment of main to read');
  const statuses = await api(`${r}/deployments/${d.id}/statuses?per_page=100`);
  if (!Array.isArray(statuses)) throw new Error(`deployment ${d.id} has no readable statuses`);
  // GitHub lists the newest first.
  if (statuses[0]?.state !== 'success') return { state: 'waiting', why: `the latest production deployment is ${statuses[0]?.state ?? 'not started'}` };
  if (!statuses.some(vercelDone)) return { state: 'waiting', why: 'the latest production deployment has no finished Vercel status' };

  const compare = await api(`${r}/compare/${p.merge_commit_sha}...${d.sha}?per_page=1`);
  if (compare?.status === 'behind' || compare?.status === 'diverged') return { state: 'waiting', why: `PR #${pr} is not in the production commit yet` };
  if (compare?.status !== 'ahead' && compare?.status !== 'identical') throw new Error(`compare said ${compare?.status ?? 'nothing'}`);

  // A hotfix merged straight into main is its own release. A staging PR is named in the release PR's title and table.
  if (p.base?.ref === 'main') return { state: 'live', sha: d.sha, releasePr: pr, manualSteps: hasManualLabel(p) };
  const pulls = await api(`${r}/pulls?state=closed&base=main&sort=updated&direction=desc&per_page=100`);
  if (!Array.isArray(pulls)) throw new Error('the release PRs could not be read');
  const named = new RegExp(`#${pr}\\b`);
  const releases = pulls.filter(x => x.merged_at && x.head?.ref === 'staging' && named.test(`${x.title}\n${x.body ?? ''}`));
  if (!releases.length) throw new Error(`no merged release PR names #${pr}, so its labels cannot be read`);
  return { state: 'live', sha: d.sha, releasePr: releases[0].number, manualSteps: releases.some(hasManualLabel) };
}
const hasManualLabel = (p: any) => (p.labels ?? []).some((l: any) => l?.name === MANUAL_LABEL);

// The labels of support_ticket_get, in the key owner's language (messages/{fr,en}/help.json in AcmeApp).
const OPEN_STATUS = new Set(['reçu', 'en cours', 'received', 'in progress']);
const CLOSED_STATUS = new Set(['résolu', 'fermé', 'resolved', 'closed']);
/** How support_ticket_get marks a message that did not come from the customer. */
const notCustomer = (from: unknown) => from === 'système' || (typeof from === 'string' && from.endsWith(' (support Exampleco)'));

/** Whether the ticket still wants this reply. Throws when it cannot be read as expected. `approvedAt` is UTC, from this database. */
export function ticketHold(t: any, reference: string, approvedAt: string): string | undefined {
  if (t?.reference !== reference) throw new Error(`the ticket read returned ${t?.reference ?? 'no reference'}`);
  if (!Array.isArray(t.fil)) throw new Error('the ticket has no readable thread');
  const status = String(t.statut ?? '').toLowerCase();
  if (CLOSED_STATUS.has(status) || t.resolu_le) return `the ticket is already ${t.statut || 'resolved'}`;
  if (!OPEN_STATUS.has(status)) throw new Error(`the ticket has a status I do not know: ${t.statut}`);
  const approved = Date.parse(`${approvedAt.replace(' ', 'T')}Z`);
  for (const m of t.fil) {
    if (notCustomer(m?.de)) continue;
    const at = Date.parse(m?.le);
    if (Number.isNaN(at)) throw new Error('a message in the ticket has no readable time');
    if (at > approved) return `the customer wrote again after you approved these words (${eastern(sqlTime(at))} Eastern)`;
  }
  return undefined;
}

const label = (r: Pick<SupportReply, 'reference' | 'dealership'>) => `${r.reference} for ${r.dealership}`;

/** The brief's lines, so nothing is forgotten after a reset. Empty when nothing is open. */
export function repliesBrief(rows: SupportReply[]): string {
  if (!rows.length) return '';
  const line = (r: SupportReply) => {
    const why = r.status === 'held' || r.status === 'failed' || r.status === 'unknown' ? r.outcome : r.problem ? `cannot read: ${r.problem}` : r.note;
    return `- [reply ${r.id}] ${r.status} ${label(r)}, PR #${r.pr}, approved ${eastern(r.created_at)} Eastern${why ? `: ${why}` : ''}`;
  };
  return `Support replies waiting on production. jarvisd sends each on its own once its fix is live, so never send one yourself:\n${rows.map(line).join('\n')}`;
}

export function makeReplies(o: {
  store: Store; log: Log; api: Gh;
  worker: { read: (r: SupportReply) => Promise<any>; send: (r: SupportReply) => Promise<SendResult> };
  /** Sends text to the brain. Only a sentence owed to the owner reaches it, so a quiet tick costs no tokens. */
  wake: (text: string) => void;
  paused: () => boolean;
  now?: () => number;
}) {
  const { store, log } = o;
  const now = o.now ?? Date.now;
  let running = false;

  const hold = (r: SupportReply, kind: string, why: string) => {
    store.setSupportReply(r.id, { status: 'held', hold_kind: kind, outcome: why, problem: null, tell: `${label(r)} is on hold and nothing was sent, because ${why}.` });
    log('support reply held', { reply: r.id, reference: r.reference, kind, why });
  };
  /** The state could not be read. Nothing is sent, the next tick tries again, and the owner hears each different reason once. */
  const cannotRead = (r: SupportReply, why: string) => {
    log('support reply: could not read the state', { reply: r.id, reference: r.reference, why });
    if (r.problem !== why) store.setSupportReply(r.id, { problem: why, note: null, tell: `${label(r)} is held and nothing was sent, because I could not read the state: ${why}. I check again every ten minutes.` });
  };
  const record = (r: SupportReply, s: SendResult) => {
    const at = sqlTime(now());
    if (s.status === 'sent') {
      const outcome = `sent, message ${s.messageId}${s.sentAt ? ` at ${s.sentAt}` : ''}${s.ticketStatus ? `, ticket ${s.ticketStatus}` : ''}`;
      store.setSupportReply(r.id, { status: 'sent', outcome, problem: null, finished_at: at, tell: `${label(r)}: the approved reply went out, because PR #${r.pr} is in production.` });
    } else if (s.status === 'failed') {
      store.setSupportReply(r.id, { status: 'failed', outcome: s.why, finished_at: at, tell: `${label(r)}: the reply did not go out, because ${s.why}. PR #${r.pr} is in production.` });
    } else {
      store.setSupportReply(r.id, { status: 'unknown', outcome: s.why, finished_at: at, tell: `${label(r)}: I do not know whether the reply went out, because ${s.why}. I will not send it again, so please check the ticket.` });
    }
    log(`support reply ${s.status}`, { reply: r.id, reference: r.reference, pr: r.pr, ...(s.status === 'sent' ? { message: s.messageId } : { why: s.why }) });
  };

  async function checkOne(r: SupportReply) {
    let live: Live;
    try { live = await checkLive(o.api, r.repo, r.pr); }
    catch (e) { return cannotRead(r, (e as Error).message); }
    if (live.state === 'waiting') return store.setSupportReply(r.id, { note: live.why, problem: null });
    if (live.state === 'hold') return hold(r, 'pr', live.why);
    store.setSupportReply(r.id, { release_pr: live.releasePr, live_sha: live.sha });
    if (live.manualSteps && !r.manual_ok) return hold(r, 'manual', `release PR #${live.releasePr} has the ${MANUAL_LABEL} label`);
    let why: string | undefined;
    try { why = ticketHold(await o.worker.read(r), r.reference, r.created_at); }
    catch (e) { return cannotRead(r, (e as Error).message); }
    if (why) return hold(r, 'ticket', why);
    // The row is `sending` on disk before the worker starts, so no crash or second tick can send it again.
    if (!store.claimSupportSend(r.id)) return;
    log('support reply sending', { reply: r.id, reference: r.reference, pr: r.pr, release: live.releasePr, sha: live.sha });
    let result: SendResult;
    try { result = await o.worker.send(store.supportReply(r.id)!); }
    catch (e) { result = { status: 'unknown', why: `the send worker failed: ${e}` }; }
    record(r, result);
  }

  function flush() {
    if (o.paused()) return;
    const owed = store.owedSupportTells();
    if (!owed.length) return;
    o.wake(owed.map(r => `[check] Support reply, tell the owner in one sentence: ${r.tell}`).join('\n'));
    for (const r of owed) store.setSupportReply(r.id, { tell: null });
  }

  return {
    /** At start. A row still `sending` lost its worker to a restart: it may have gone out, so it is unknown and never resent. */
    recover() {
      for (const r of store.openSupportReplies().filter(x => x.status === 'sending')) record(r, { status: 'unknown', why: 'jarvisd restarted during the send' });
      flush();
    },
    /** One step of the ten-minute check. Any failure on one row leaves it unsent and moves on. */
    async tick() {
      if (running || o.paused()) return;
      running = true;
      try {
        for (const r of store.openSupportReplies().filter(x => x.status === 'waiting')) {
          try { await checkOne(r); }
          catch (e) { log('support reply: check failed', { reply: r.id, error: String(e) }); }
        }
        flush();
      } finally { running = false; }
    },
  };
}

/** The internal routes jarvis-act calls. Adding, resuming and dropping need the owner's message in the running turn. */
export function replyRoute(store: Store, log: Log, method: string, url: string, b: any, ctx: { fromOwner: () => boolean }): { status: number; body: unknown } | undefined {
  const refused = (error: string, status = 400) => ({ status, body: { error } });
  const notOwner = 'This needs the owner\'s own message in this turn. Ask him first.';
  if (method === 'GET' && url === '/api/internal/replies') return { status: 200, body: store.openSupportReplies() };
  if (method === 'POST' && url === '/api/internal/replies') {
    const text = typeof b.text === 'string' ? b.text.trim() : '';
    const dealership = typeof b.dealership === 'string' ? b.dealership.trim() : '';
    const pr = /^[1-9]\d*$/.test(String(b.pr ?? '')) ? Number(b.pr) : 0;
    if (!pr) return refused('--pr is required: a reply with no PR has no fix to wait for');
    if (typeof b.ref !== 'string' || !new RegExp(`^${TICKET_PREFIX}-\\d+$`).test(b.ref)) return refused(`--ref must look like ${TICKET_PREFIX}-1045`);
    if (!dealership) return refused('--dealership is required');
    if (typeof b.dealershipId !== 'string' || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(b.dealershipId)) return refused('--dealership-id must be the dealership uuid: the production tools refuse a ticket without it');
    if (b.repo !== LIVE_REPO) return refused(`--repo must be ${LIVE_REPO}: it is the only repo whose production signal is known`);
    if (!text || text.length > 10_000) return refused('--text is required, at most 10000 characters');
    if (!ctx.fromOwner()) return refused(notOwner, 409);
    const open = store.openSupportReplies().find(r => r.reference === b.ref);
    if (open) {
      if (open.text === text && open.pr === pr) return { status: 200, body: open };
      return refused(`${b.ref} already has a reply on the list (id ${open.id}, ${open.status}). Run jarvis-act reply-drop ${open.id} first if the owner changed it.`, 409);
    }
    const r = store.addSupportReply({ reference: b.ref, dealership, dealership_id: b.dealershipId, text, repo: b.repo, pr });
    log('support reply added', { reply: r.id, reference: r.reference, pr });
    return { status: 200, body: r };
  }
  const act = method === 'POST' ? url.match(/^\/api\/internal\/replies\/(\d+)\/(resume|drop)$/) : null;
  if (!act) return undefined;
  const r = store.supportReply(Number(act[1]));
  if (!r) return refused(`no reply ${act[1]}`, 404);
  if (!ctx.fromOwner()) return refused(notOwner, 409);
  if (act[2] === 'drop') {
    if (r.status === 'sending' || r.status === 'sent' || r.status === 'dropped') return refused(`reply ${r.id} is ${r.status}`, 409);
    store.setSupportReply(r.id, { status: 'dropped', tell: null, finished_at: sqlTime(Date.now()) });
    log('support reply dropped', { reply: r.id, reference: r.reference });
    return { status: 200, body: store.supportReply(r.id) };
  }
  // Failed means nothing reached the tool. A hold for manual steps ends when the owner says they are done.
  // A ticket or PR hold changed what the owner approved, and unknown may have gone out: those need new words or a look at the ticket.
  if (r.status !== 'failed' && !(r.status === 'held' && r.hold_kind === 'manual')) return refused(`reply ${r.id} is ${r.status}${r.hold_kind ? ` (${r.hold_kind})` : ''} and cannot resume. Drop it, and add it again if the owner approves new words.`, 409);
  store.setSupportReply(r.id, { status: 'waiting', hold_kind: null, outcome: null, tell: null, ...(r.status === 'held' ? { manual_ok: 1 } : {}) });
  log('support reply resumed', { reply: r.id, reference: r.reference, from: r.status });
  return { status: 200, body: store.supportReply(r.id) };
}
