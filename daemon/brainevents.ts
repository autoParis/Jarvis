import type { Store, Item } from './store.ts';
import type { Log } from './log.ts';
import type { PeerMessage } from './brain.ts';
import type { AskCard } from './asks.ts';
import type { Native } from './native.ts';
import type { PushMessage } from './push.ts';
import type { makeChatLinks } from './chatlink.ts';
import { urgent } from './push.ts';
import { unmarked } from './voice.ts';
import { routeWorkerTurn } from './nativeroutes.ts';

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
};

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
