import type { Store, Item } from './store.ts';
import type { Log } from './log.ts';
import type { PeerMessage } from './brain.ts';
import type { AskCard } from './asks.ts';
import type { Native } from './native.ts';
import type { PushMessage } from './push.ts';
import type { makeChatLinks } from './chatlink.ts';
import { urgent } from './push.ts';
import { OWNER } from './config.ts';
import { unmarked } from './voice.ts';
import { routeWorkerTurn } from './nativeroutes.ts';
import { ROW_PREFIX } from './native.ts';

// What jarvisd does with the brain's events: a reply is stored, spoken and linked to its proposals, a turn a worker
// started becomes an ask card or a status line, and the brain's state goes to every open page. main.ts wires it once.

type Emitter = { on: (event: string, fn: (...args: any[]) => void) => unknown };

export type BrainEventCtx = {
  store: Store;
  log: Log;
  broadcast: (ev: object) => void;
  /** Stores a chat message, sends it to every open page and, for Jarvis, speaks it. Returns its turn id. */
  say: (role: string, text: string) => number;
  notify: (m: PushMessage, opts?: { urgent?: boolean }) => Promise<unknown>;
  chatLinks: ReturnType<typeof makeChatLinks>;
  native: Native;
  cardOf: (i: Item | undefined) => AskCard | undefined;
  /** Sends the work list to every open page. */
  publish: () => void;
  /** The brain's model and state, for the app's model menu. */
  info: () => unknown;
  /** Starts a brain turn with this text (main.ts checks the kill switch). */
  tell?: (text: string) => void;
};

/** What the brain hears about a message jarvisd could not match to a worker. Its answer to that turn was not spoken. */
export function unknownSenderNote(i: Item, peer: PeerMessage | undefined): string {
  return `[unknown sender] A cross-session message reached you, and jarvisd could not match it to a native worker`
    + ` (sender name: ${peer?.from ? JSON.stringify(peer.from) : 'none'}). It is on ask card message_id=${i.external_id}, and your answer to it was not spoken.`
    + ` Find the sender in jarvis-native list (story number, worktree, recent report). Then tell ${OWNER} what it asks,`
    + ` and send his answer with jarvis-native reply --worker <name> --item ${i.external_id} --text "<words>". The message:\n${i.body}`;
}

/**
 * What the brain hears about an ask a worker wrote in its turn text because its SendMessage did not reach the brain.
 * jarvisd already made the card, so the brain speaks it and opens no ask of its own.
 */
export function turnAskNote(w: { id: string; name: string }, i: Item): string {
  return `[native question] ${w.name}: Native worker ${w.name} (${ROW_PREFIX}${w.id}) could not reach you with SendMessage, so it wrote this ask in its turn text.`
    + ` jarvisd made its ask card, message_id=${i.external_id}. Do not open an ask of your own. Speak the question to ${OWNER} as you speak any worker ask.`
    + ` His tap on the card answers it. If he answers in the chat, send his words with jarvis-native reply --worker ${w.name} --text "<his words>". The ask:\n${i.body}`;
}

export function wireBrain(brain: Emitter, o: BrainEventCtx) {
  const { store, broadcast, say, chatLinks, native, log } = o;
  // The proposals of a turn get Approve and Reject on the reply that asks for them (chatlink.ts).
  const linkReply = (turnId: number | undefined) => { for (const a of chatLinks.replied(turnId)) broadcast({ type: 'approval', approval: a }); };
  brain.on('reply', (raw: string, usage: any, turns: number[]) => {
    store.addTurn({ role: 'jarvis-usage', text: usage.is_error ? 'error' : '', ...usage });
    if (!usage.is_error) store.settleTurns(turns);
    if (!raw || raw === 'SILENT') return linkReply(undefined);
    const { urgent: isUrgent, text } = urgent(raw);
    linkReply(say('jarvis', text));
    if (isUrgent) o.notify({ title: 'Jarvis', body: unmarked(text).trim().slice(0, 180), url: '/', tag: `urgent-${Date.now()}` }, { urgent: true });
  });
  // One stored row per turn, the same way as jarvis-usage. The chat gets only the duration; the steps load when the owner opens the row.
  brain.on('worked', (w: { steps: unknown[]; ms: number }) => {
    const id = store.addTurn({ role: 'jarvis-work', text: JSON.stringify(w) });
    broadcast({ type: 'fold', id, ms: w.ms, at: new Date().toISOString() });
  });
  // A turn a worker's SendMessage started. An ask with options becomes an ask card, and the brain's words are spoken as
  // its answer. A notice is a status line in the chat with nothing to answer. An ask with no options goes back to the worker.
  brain.on('worker', (raw: string, usage: any, peer: PeerMessage | undefined) => {
    store.addTurn({ role: 'jarvis-usage', text: usage.is_error ? 'error' : '', ...usage });
    const r = routeWorkerTurn({ native, store, log }, peer, raw);
    if (r.item) { const card = o.cardOf(r.item); broadcast({ type: 'event', text: `[native question] ${r.worker!.name}: ${peer!.text}`, at: new Date().toISOString(), asks: card ? [card] : [] }); o.publish(); }
    if (r.notice) {
      const line = `[worker event] ${r.worker!.name}: ${r.notice}`;
      store.addTurn({ role: 'event', text: line });
      broadcast({ type: 'event', text: line, at: new Date().toISOString() });
      o.publish();
    }
    if (r.unknown) {
      const card = o.cardOf(r.unknown);
      broadcast({ type: 'event', text: `[native question] unknown sender: ${r.unknown.body}`, at: new Date().toISOString(), asks: card ? [card] : [] });
      o.publish();
      o.tell?.(unknownSenderNote(r.unknown, peer));
    }
    if (r.refusal) {
      const w = r.worker!;
      native.reply(w.id, r.refusal, 'jarvis')
        .then(x => log('native ask without options: sent back', { worker: w.id, ok: x.ok, ...(x.ok ? {} : { error: x.error }) }))
        .catch(e => log('native ask without options: send back failed', { worker: w.id, error: String(e) }));
    }
    linkReply(r.speak ? say('jarvis', urgent(raw).text) : undefined);
  });
  brain.on('working', (on: boolean) => { if (on) chatLinks.turnStarted(); broadcast({ type: 'working', on }); });
  brain.on('notice', (s: string) => say('jarvis', s));
  brain.on('log', log);
  brain.on('model', () => broadcast({ type: 'brain', brain: o.info() }));
}
