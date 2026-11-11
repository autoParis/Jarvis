import type { Native, NativeWorker } from './native.ts';
import { ROW_PREFIX } from './native.ts';
import type { Store, Item } from './store.ts';
import type { Log } from './log.ts';
import type { PeerMessage } from './brain.ts';
import { askCard } from './asks.ts';
import { fields, readReport, NO_OPTIONS_REFUSAL, noticeLine } from './workercontract.ts';
export { NO_OPTIONS_REFUSAL, noticeLine } from './workercontract.ts';
import { findSession } from './resume.ts';

// The http side of native workers (Jarvis 2.0, stage B), kept out of main.ts so it can be tested: the three hooks a
// background session posts, the brain's reply command, and the routing of a cross-session message the brain answered.
// main.ts owns the server, the broadcast and the brain; it hands those in through `o`.

export type RouteResult = { status: number; body?: unknown };
type Json = Record<string, any>;

export type NativeRouteOptions = {
  native: Native; store: Store; log: Log;
  /** An ask card changed (a native question was opened or answered); main.ts broadcasts it. */
  askChanged: (externalId: string) => void;
  /** Test seam: a session's transcript and folder by its id (resume.ts findSession). */
  findSession?: (id: string) => { file: string; cwd: string } | undefined;
};

/** The external id of a worker's question item: one per message, from the worker id and the time it arrived. */
export const askId = (worker: string, at: number) => `ask:${worker}:${at}`;

/**
 * `POST /api/hooks/*` from a worker's settings file, and `POST /api/internal/native/*` from bin/jarvis-native.
 * Returns undefined for any other url. Hook replies are always 200 with a JSON object: a non-2xx or a non-object
 * would be a hook error on the worker's side, and a PermissionRequest with no decision is a denial there.
 */
export async function nativeRoute(o: NativeRouteOptions, method: string, url: string, body: Json): Promise<RouteResult | undefined> {
  if (method !== 'POST') return undefined;
  if (url === '/api/hooks/permission') return { status: 200, body: await o.native.permissionRequest(body) };
  // A turn that ended with no report line is sent back once: the reply carries Claude Code's `decision: block`.
  if (url === '/api/hooks/stop') return { status: 200, body: o.native.stopHook(body) };
  if (url === '/api/hooks/pre') return { status: 200, body: o.native.preToolUse(body) };
  if (url === '/api/internal/native/reply') {
    const worker = typeof body.worker === 'string' ? body.worker : '';
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!worker || !text) return { status: 400, body: { error: 'worker and text are required' } };
    const w = findWorker(o.native, worker);
    if (!w) return { status: 404, body: { error: `no native worker ${worker}. jarvis-native list shows them.` } };
    const r = await o.native.reply(w.id, text, 'jarvis');
    if (!r.ok) return { status: 502, body: { error: r.error } };
    for (const id of answerOpenAsks(o.store, w.id, text, 'jarvis')) { o.log('native ask answered by the brain', { worker: w.id, item: id }); o.askChanged(id); }
    // The card of a message jarvisd could not match: the brain found its sender and answered it.
    const unknown = typeof body.item === 'string' ? o.store.item(body.item) : undefined;
    if (unknown?.subject === UNKNOWN_SUBJECT && !unknown.dispatch_id && unknown.status !== 'answered') {
      o.store.markItem(unknown.external_id, 'answered', text, 'jarvis');
      o.log('unknown-sender message answered by the brain', { worker: w.id, item: unknown.external_id });
      o.askChanged(unknown.external_id);
    }
    return { status: 200, body: { ok: true, worker: `${ROW_PREFIX}${w.id}`, name: w.name } };
  }
  if (url === '/api/internal/native/list') return { status: 200, body: o.native.list() };
  // Continue on phone for a session the work list does not show (`jarvis-native phone --session <id>`). It never stops another
  // process: when one holds the session, the error names it, and only the owner's button in the pane can stop it.
  if (url === '/api/internal/native/phone') {
    const key = typeof body.session === 'string' ? body.session.trim() : '';
    if (!key) return { status: 400, body: { error: 'session is required (a session id, or a native worker)' } };
    const w = findWorker(o.native, key);
    const found = w?.session_id ? { file: o.native.transcriptFile(w.id), cwd: w.cwd, sessionId: w.session_id } : (() => { const f = (o.findSession ?? findSession)(key); return f && { ...f, sessionId: key }; })();
    if (!found) return { status: 404, body: { error: `no Claude session ${key} on this Mac` } };
    // No title: native.phone names it after the session's own name in its transcript.
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    const r = await o.native.phone({ sessionId: found.sessionId, cwd: found.cwd, title, transcript: found.file });
    if (!r.ok) return { status: 409, body: { error: r.error, holders: r.holders ?? [] } };
    return { status: 200, body: { ok: true, worker: `${ROW_PREFIX}${r.worker.id}`, remoteControl: r.worker.remote, already: !!r.already } };
  }
  return undefined;
}

/** A worker by short id, `n:<id>`, session id or `--name`. */
export function findWorker(native: Pick<Native, 'get' | 'list'>, key: string): NativeWorker | undefined {
  return native.get(key) ?? native.list().find(w => w.name === key);
}

/** Marks this worker's open questions answered with the words that went to it. Returns their ids. */
export function answerOpenAsks(store: Store, worker: string, text: string, by: 'owner' | 'jarvis'): string[] {
  const open = store.openItems().filter(i => i.source === 'native' && i.dispatch_id === `${ROW_PREFIX}${worker}`);
  for (const i of open) store.markItem(i.external_id, 'answered', text, by === 'jarvis' ? 'jarvis' : undefined);
  return open.map(i => i.external_id);
}

/** What a worker's SendMessage is: an ask with options, a status notice, or an ask with no options (sent back). */
export type WorkerMessageKind = 'ask' | 'notice' | 'no-options';


const LINK = /\bhttps?:\/\/\S+/g;

/**
 * Sorts a worker's message. A message with options is an ask. A message that asks nothing (a `NOTICE:`, `DONE:` or
 * `FAILED:` first line, or no QUESTION field and no question mark outside a link) is a notice. Anything else is a
 * question with no options. The owner could not answer it with a tap, so it goes back to the worker.
 */
export function workerMessageKind(text: string): WorkerMessageKind {
  const body = text.trim();
  const label = readReport(body).label;
  if (label === 'NOTICE' || label === 'DONE' || label === 'FAILED') return 'notice';
  const probe = { id: 0, source: 'native', external_id: 'probe', kind: 'question', dispatch_id: null, subject: '', body, options: null,
    status: 'new', answer: null, created_at: '', pushes: 0, pushed_at: null, meta: null } as Item;
  if (askCard(probe)?.options.length) return 'ask';
  const asks = Boolean(fields(body).QUESTION) || body.replace(LINK, '').includes('?');
  return asks ? 'no-options' : 'notice';
}


/** The external id of a message jarvisd could not match to a worker. */
export const unknownId = (at: number) => `unknown:${at}`;
export const UNKNOWN_SUBJECT = 'Message from an unknown sender';

/**
 * The worker that sent a cross-session message. First by its `--name`. When the name is missing or names no worker, by
 * the text: a worker's session id, its worktree path, or the story number on the STORY line (worker names start with it,
 * "4390-sup-1025-page-address-problem-483"). A text match counts only when it picks exactly one worker. Unfinished
 * workers are tried first, then the rest that are not abandoned.
 */
export function matchSender(native: Pick<Native, 'get' | 'list'>, peer: PeerMessage | undefined): { worker: NativeWorker; by: string } | undefined {
  if (!peer) return undefined;
  const named = peer.from ? findWorker(native, peer.from) : undefined;
  if (named) return { worker: named, by: 'name' };
  const text = peer.text ?? '';
  if (!text.trim()) return undefined;
  const all = native.list().filter(w => w.state !== 'abandoned');
  const unfinished = all.filter(w => !w.outcome && !['done', 'failed', 'stopped'].includes(w.state));
  const story = /#?(\d{3,6})\b/.exec(fields(text).STORY ?? '')?.[1];
  const tests: [string, (w: NativeWorker) => boolean][] = [
    ['session', w => !!w.session_id && text.includes(w.session_id)],
    ['worktree', w => w.cwd.length > 8 && text.includes(w.cwd)],
    ['story', w => !!story && new RegExp(`(^|-)${story}-`).test(w.name)],
  ];
  for (const [by, hit] of tests) for (const pool of [unfinished, all]) {
    const found = pool.filter(hit);
    if (found.length === 1) return { worker: found[0], by };
    if (found.length > 1) break;
  }
  return undefined;
}

/**
 * The brain answered a turn that a cross-session message started. It is never dropped. matchSender finds the worker.
 * When none matches, the message becomes an open question with no worker (`unknown`, a card that says so), and
 * brainevents.ts tells the brain. For a worker:
 * - An ask with options becomes a question item (an ask card in the app, `[native question]` in the brief), and the
 *   brain's words are spoken.
 * - A notice becomes a done `event` item (a status line in the worker's pane). It gets no card and nothing is spoken.
 * - A question with no options makes no item. main.ts sends `refusal` back to the worker.
 */
export function routeWorkerTurn(o: { native: Pick<Native, 'get' | 'list'>; store: Store; log: Log; now?: () => number },
  peerIn: PeerMessage | undefined, text: string): { worker?: NativeWorker; item?: Item; notice?: string; refusal?: string; unknown?: Item; speak: boolean } {
  const match = matchSender(o.native, peerIn);
  if (!match) {
    const at = (o.now ?? Date.now)();
    // No peer text at all: the brain's own answer is the only copy of what it read.
    const said = peerIn?.text?.trim() ? peerIn.text : `(jarvisd did not get the message text. The brain answered:)\n\n${text}`;
    const unknown = o.store.insertItem({ source: 'native', external_id: unknownId(at), kind: 'question', dispatch_id: null,
      subject: UNKNOWN_SUBJECT, body: said, status: 'spoken', meta: JSON.stringify({ from: peerIn?.from ?? null }) });
    o.log('native message from an unknown sender kept on a card', { from: peerIn?.from ?? null, chars: peerIn?.text.length ?? 0, item: unknown?.external_id });
    return { unknown, speak: false };
  }
  const w = match.worker;
  const peer = peerIn!;
  if (match.by !== 'name') o.log('native message matched to a worker without its name', { worker: w.id, by: match.by, from: peer.from ?? null });
  const at = (o.now ?? Date.now)();
  const kind = workerMessageKind(peer.text);
  if (kind === 'notice') {
    const notice = noticeLine(peer.text);
    o.store.insertItem({ source: 'native', external_id: `notice:${w.id}:${at}`, kind: 'event', dispatch_id: `${ROW_PREFIX}${w.id}`, body: notice, status: 'done' });
    o.log('native notice from a worker', { worker: w.id, chars: peer.text.length });
    return { worker: w, notice, speak: false };
  }
  if (kind === 'no-options') {
    o.log('native ask without options sent back to the worker', { worker: w.id, chars: peer.text.length });
    return { worker: w, refusal: NO_OPTIONS_REFUSAL, speak: false };
  }
  const item = o.store.insertItem({
    source: 'native', external_id: askId(w.id, at), kind: 'question', dispatch_id: `${ROW_PREFIX}${w.id}`,
    subject: `Question from ${w.name}`, body: peer.text, status: 'spoken',
  });
  o.log('native question from a worker', { worker: w.id, item: item?.external_id, chars: peer.text.length });
  return { worker: w, item, speak: text.trim() !== '' && text.trim() !== 'SILENT' };
}
