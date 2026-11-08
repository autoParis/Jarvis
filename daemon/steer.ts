import { OWNER } from './config.ts';
import type { OrcaResult } from './orca.ts';
import type { Store, Approval } from './store.ts';
import type { Gate } from './gate.ts';
import type { Log } from './log.ts';
import type { WorkRow } from './work.ts';
import type { ResumeStart } from './resume.ts';

// The message box under the conversation pane, and its Stop button. Every message goes out at once with no card, because
// the owner typed it himself in the open app, and each is recorded in `approvals`. There is one writer per session:
// - Jarvis's own workers: the same as `jarvis-orca reply` (an open question) or `jarvis-orca steer`. The reply claims the ask
//   in `items` first, as jarvis-orca does, so it cannot race a spoken reply.
// - A live terminal agent (side chats, other Runs' workers, sessions): typed into that agent, as if at its Orca tab.
// - No process to type into: the daemon resumes the session (resume.ts).
// Only another Run's chat-tab worker still goes through the gate and waits for Approve.

export type SteerResult = { status: number; body: { done?: 'replied' | 'sent' | 'typed' | 'resumed'; approval?: Approval; error?: string; warning?: string } };
type Orca = (args: string[]) => Promise<OrcaResult>;

export const STEER_LIMIT = 8000;

export async function steer(o: {
  row: WorkRow; text: string; run: string; handle: string;
  store: Store; gate: Gate; orca: Orca; log: Log;
  /** Tells the brain what the owner did, so it does not answer the same ask; the brain replies SILENT. */
  note: (text: string) => void;
  /** Finds this row's transcript and resumes it, for a row with no process to type into. */
  resume?: (text: string) => Promise<ResumeStart>;
}): Promise<SteerResult> {
  const { row, text, store, log } = o;
  if (!text.trim()) return { status: 400, body: { error: 'Write a message first.' } };
  if (text.length > STEER_LIMIT) return { status: 413, body: { error: `Longer than ${STEER_LIMIT} characters.` } };
  const ids = { run: o.run, dispatch: row.dispatch, row: row.id };

  if (row.steer === 'auto' && row.kind === 'worker' && row.run === o.run && row.dispatch) {
    const asks = store.openItems().filter(i => i.dispatch_id === row.dispatch);
    const question = asks.find(i => i.kind === 'question');
    if (question) {
      const claim = store.claimReply(question.external_id);
      if (claim !== 'claimed' && claim !== 'untracked') return { status: 409, body: { error: `That question is already ${claim}. Not answering it twice.` } };
      const r = await o.orca(['orchestration', 'reply', '--run', o.run, '--from', o.handle, '--id', question.external_id, '--body', text]).catch(() => undefined);
      if (r?.ok) {
        store.markItem(question.external_id, 'answered', text);
        log('steer: The owner answered an ask from the work list', { ...ids, item: question.external_id });
        o.note(`[work list] ${OWNER} answered ask message_id=${question.external_id} (dispatch ${row.dispatch}, ${JSON.stringify(row.title)}) himself from the work list: ${JSON.stringify(text)}. It is answered; do not reply to it again. Reply SILENT.`);
        return { status: 200, body: { done: 'replied' } };
      }
      if (r && !r.ok) {
        store.releaseReply(question.external_id);
        log('steer: Orca refused the reply, ask reopened', { ...ids, item: question.external_id, error: r.error?.code });
        return { status: 502, body: { error: `Orca refused the answer: ${r.error?.message ?? r.error?.code}` } };
      }
      log('steer: no answer from Orca, ask stays replying', { ...ids, item: question.external_id });
      return { status: 502, body: { error: 'Orca gave no answer, so the reply may or may not have gone out. Check before sending it again.' } };
    }
    const r = await o.orca(['orchestration', 'send', '--run', o.run, '--from', o.handle, '--to', `dispatch:${row.dispatch}`, '--subject', `From ${OWNER}`, '--body', text]).catch(() => undefined);
    if (!r?.ok) {
      log('steer: send failed', { ...ids, error: r?.error?.code ?? 'no answer' });
      return { status: 502, body: { error: r ? `Orca refused it: ${r.error?.message ?? r.error?.code}` : 'Orca gave no answer, so the message may or may not have gone out.' } };
    }
    // An escalation is not a question Orca can reply to; The owner's message is the answer.
    for (const e of asks) store.markItem(e.external_id, 'answered', text);
    log('steer: The owner messaged a worker from the work list', ids);
    o.note(`[work list] ${OWNER} sent dispatch ${row.dispatch} (${JSON.stringify(row.title)}) a message himself from the work list: ${JSON.stringify(text)}.${asks.length ? ` That answers ${asks.map(e => e.external_id).join(', ')}.` : ''} Reply SILENT.`);
    return { status: 200, body: { done: 'sent' } };
  }

  const short = row.title.slice(0, 60);
  try {
    if (row.steer === 'type' && row.terminal) return await typeInto(o, row, text, ids);
    if (row.steer === 'resume') {
      // Mid-turn in Orca's process, including a turn parked on a prompt or watching a command: a second writer would lose a turn.
      if (row.state === 'working' || row.note === 'Monitoring') return { status: 409, body: { error: 'It is working in Orca right now. Send this when it finishes, so two writers do not lose a turn.' } };
      if (row.state === 'waiting') return { status: 409, body: { error: 'It is parked on a permission prompt in its Orca chat tab, and Orca has no way to answer that from outside. Answer it there.' } };
      const r = await o.resume?.(text);
      if (!r) return { status: 409, body: { error: "Jarvis can't find this session's transcript yet, so it can't resume it." } };
      if (!r.started) { log('steer: resume refused', { ...ids, error: r.error }); return { status: 409, body: { error: r.error } }; }
      return { status: 200, body: { done: 'resumed', warning: r.warning } };
    }
    if (row.steer === 'card' && row.kind === 'worker' && row.dispatch)
      return { status: 200, body: { approval: await o.gate.propose('worker-send', { dispatch: row.dispatch, text }, `Send this to "${short}" in another Run?`) } };
  } catch (e) {
    return { status: 409, body: { error: (e as Error).message } };
  }
  return { status: 409, body: { error: 'That worker has exited.' } };
}

/** Types the owner's message into a live terminal agent. The list is read again first: text sent after the agent exits would run in the shell. */
async function typeInto(o: Parameters<typeof steer>[0], row: WorkRow, text: string, ids: object): Promise<SteerResult> {
  const list = await o.orca(['terminal', 'list']).catch(() => undefined);
  const live = list?.ok && (list.result.terminals as { handle: string; agentIdentity?: string }[]).find(t => t.handle === row.terminal);
  if (!list?.ok) return { status: 502, body: { error: 'Not sent: Orca did not answer, so Jarvis could not check the agent is still running.' } };
  if (!live || !live.agentIdentity) {
    o.log('steer: no agent in the terminal, nothing typed', ids);
    return { status: 409, body: { error: 'Not sent: the agent in that terminal is no longer running.' } };
  }
  const a = await o.gate.pressed('session-type', { terminal: row.terminal, text }, `Message to "${row.title.slice(0, 60)}"`);
  if (a.status === 'done') {
    // the owner's message answers whatever that worker's open asks were about.
    for (const i of o.store.openItems().filter(x => row.dispatch && x.dispatch_id === row.dispatch && x.status !== 'replying')) o.store.markItem(i.external_id, 'answered', text);
    return { status: 200, body: { done: 'typed' } };
  }
  const why = a.result?.replace(/^prompt_open: /, '') ?? '';
  return { status: a.status === 'unknown' ? 502 : 409, body: { error: a.status === 'unknown' ? `Orca lost its answer, so the message may or may not have gone in. ${why}` : `Not sent. ${why}` } };
}

/** The pane's Stop button. A side chat the owner started closes at once (the Close button); any other worker needs Approve. */
export async function stop(row: WorkRow, gate: Gate): Promise<SteerResult> {
  if (row.kind !== 'worker' || !row.dispatch) return { status: 409, body: { error: 'Only a supervised worker can be stopped from here.' } };
  try {
    if (row.sideChat) {
      const a = await gate.pressed('side-chat-close', { dispatch: row.dispatch }, `Close side chat: ${row.title.slice(0, 80)}`);
      return { status: a.status === 'done' ? 200 : 502, body: { approval: a } };
    }
    return { status: 200, body: { approval: await gate.propose('worker-stop', { dispatch: row.dispatch }, `Stop "${row.title.slice(0, 60)}"?`) } };
  } catch (e) {
    return { status: 409, body: { error: (e as Error).message } };
  }
}
