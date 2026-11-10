import type { Store, Item } from './store.ts';
import type { Log } from './log.ts';
import type { AskCard } from './asks.ts';
import { OWNER } from './config.ts';
import type { RouteResult, Body } from './route.ts';

// Jarvis's own questions to the owner as ask cards: `jarvis-act ask` stores one, the app shows it beside the worker asks,
// and a tap or a typed answer goes back to the brain as an `[ask card answer]` line. Nothing goes to a worker.
// The item has source 'brain', kind 'question' and no dispatch, so push.ts, the check and the brief read it with the worker asks.

export const BRAIN_SOURCE = 'brain';
const MAX_OPTIONS = 6;
const MAX_QUESTION = 600;
const MAX_LABEL = 200;

export const isBrainAsk = (i: Item | undefined): i is Item => i?.source === BRAIN_SOURCE;

const optionsOf = (i: Item): string[] => { try { const v = JSON.parse(i.options ?? '[]'); return Array.isArray(v) ? v.map(String) : []; } catch { return []; } };
const isoTime = (t: string) => `${t.replace(' ', 'T')}Z`;

export type NewBrainAsk = { question?: unknown; options?: unknown; recommended?: unknown; about?: unknown };
type Result = { status: number; body: { error?: string; id?: string; ask?: AskCard }; item?: Item };

/**
 * Validates and stores one brain ask. The recommended option moves to the front, so the card marks it Recommended.
 * Refused with 400, and nothing stored, when the question is empty or there are fewer than two distinct options.
 */
export function addBrainAsk(store: Store, input: NewBrainAsk, now: () => number = Date.now): Result {
  const question = typeof input.question === 'string' ? input.question.trim() : '';
  if (!question) return { status: 400, body: { error: '--question is required.' } };
  if (question.length > MAX_QUESTION) return { status: 400, body: { error: `The question is over ${MAX_QUESTION} characters. Put the detail in the chat and keep the question to one sentence.` } };
  const raw = Array.isArray(input.options) ? input.options : [];
  const options = [...new Set(raw.filter((o): o is string => typeof o === 'string').map(o => o.trim()).filter(Boolean))];
  if (options.length < 2) return { status: 400, body: { error: 'Give at least two --option values. An ask with one answer is a notice, not a question.' } };
  if (options.length > MAX_OPTIONS) return { status: 400, body: { error: `At most ${MAX_OPTIONS} options.` } };
  if (options.some(o => o.length > MAX_LABEL)) return { status: 400, body: { error: `Each option is at most ${MAX_LABEL} characters.` } };
  const rec = input.recommended === undefined || input.recommended === null || input.recommended === '' ? 0 : Number(input.recommended);
  if (!Number.isInteger(rec) || rec < 0 || rec >= options.length) return { status: 400, body: { error: `--recommended must be an option index from 0 to ${options.length - 1}.` } };
  const ordered = [options[rec], ...options.filter((_, n) => n !== rec)];
  const about = typeof input.about === 'string' ? input.about.trim().slice(0, 120) : '';
  // A millisecond id the brain can type back; a second ask in the same millisecond takes the next number.
  let t = now(), item: Item | undefined;
  for (let n = 0; n < 5 && !item; n++, t++) {
    item = store.insertItem({ source: BRAIN_SOURCE, external_id: `brain:${t}`, kind: 'question', subject: about, body: question, options: JSON.stringify(ordered), status: 'spoken' });
  }
  if (!item) return { status: 500, body: { error: 'Could not store the ask.' } };
  return { status: 200, body: { id: item.external_id, ask: brainCard(item) }, item };
}

/** The card for a brain ask: the topic as title, the question large, the options as buttons with the first recommended. */
export function brainCard(i: Item): AskCard {
  return {
    id: i.external_id, kind: 'question', dispatch: null,
    title: i.subject?.trim() || 'Jarvis is asking',
    body: i.body ?? '', question: i.body ?? '',
    options: optionsOf(i).map(label => ({ value: label, label })),
    // Empty parts: the page draws The question and Options under headings, with no "What the worker is doing".
    parts: {},
    at: isoTime(i.created_at), ...(i.updated_at ? { settledAt: isoTime(i.updated_at) } : {}),
    status: i.status === 'answered' || i.status === 'done' ? 'answered' : i.status === 'replying' ? 'sending' : 'open',
    answer: i.answer,
  };
}

/** The line the brain gets when the owner answers a brain ask on its card. */
export function answerLine(i: Item, answer: string, how: 'tapped' | 'typed'): string {
  return `[ask card answer] ${i.body} -> ${answer} (message_id=${i.external_id}, ${how} in the app${i.subject ? `, about ${JSON.stringify(i.subject)}` : ''})`;
}

/**
 * The owner tapped an option or typed an answer on a brain ask. The card closes and the brain gets the question and the
 * answer as one line. `note` sends that line to the brain.
 */
export function answerBrainAsk(o: { id: string; value: string; store: Store; log: Log; note: (text: string) => void }): { status: number; error?: string } {
  const i = o.store.item(o.id);
  if (!isBrainAsk(i)) return { status: 404, error: 'That ask is not known here.' };
  const value = o.value.trim();
  if (!value) return { status: 400, error: 'No answer to send.' };
  if (i.status !== 'new' && i.status !== 'spoken') return { status: 409, error: 'That question is already answered.' };
  o.store.markItem(o.id, 'answered', value);
  const how = optionsOf(i).includes(value) ? 'tapped' : 'typed';
  o.log('ask card: The owner answered a brain ask', { item: o.id, how });
  o.note(answerLine(i, value, how));
  return { status: 200 };
}

/** `jarvis-act ask-done`: the owner answered a brain ask in the chat, so its card closes with his words. */
export function brainAskDone(store: Store, input: { id?: unknown; answer?: unknown }): Result {
  const id = typeof input.id === 'string' ? input.id : '';
  const i = store.item(id);
  if (!isBrainAsk(i)) return { status: 404, body: { error: `${id || 'That id'} is not one of your asks. Use the message_id from the brief.` } };
  if (i.status !== 'new' && i.status !== 'spoken') return { status: 409, body: { error: `${id} is already ${i.status}.`, ask: brainCard(i) } };
  const answer = typeof input.answer === 'string' && input.answer.trim() ? input.answer.trim() : undefined;
  if (!answer) return { status: 400, body: { error: '--answer is required: the owner\'s answer in a few words.' } };
  store.markItem(id, 'answered', answer);
  const done = store.item(id)!;
  return { status: 200, body: { id, ask: brainCard(done) }, item: done };
}

/** The brief's line for an open brain ask. */
export function briefLine(i: Item): string {
  return `- [brain ask] message_id=${i.external_id}${i.subject ? ` about=${JSON.stringify(i.subject)}` : ''} question=${JSON.stringify(i.body)} options=${i.options} (your own ask, on a card in the app; when ${OWNER} answers in the chat, run jarvis-act ask-done ${i.external_id} --answer "<his answer>")`;
}

/** The check's line for a brain ask that waited `minutes`. */
export function checkLine(i: Item, minutes: number): string {
  return `Your own ask unanswered for ${minutes} min: message_id=${i.external_id}${i.subject ? ` about=${JSON.stringify(i.subject)}` : ''} question=${JSON.stringify(i.body)}`;
}

/** jarvis-act ask stores Jarvis's own question as an ask card. jarvis-act ask-done closes one the owner answered in the chat. `changed` gets the card's id. */
export async function brainAskRoute(o: { store: Store; log: Log; changed: (id: string) => void }, method: string, url: string, body: Body): Promise<RouteResult | undefined> {
  if (method !== 'POST' || (url !== '/api/internal/ask' && url !== '/api/internal/ask-done')) return undefined;
  const done = url === '/api/internal/ask-done';
  const r = done ? brainAskDone(o.store, await body()) : addBrainAsk(o.store, await body());
  if (r.item) { o.log(done ? 'brain ask answered in the chat' : 'brain ask added', { item: r.item.external_id }); o.changed(r.item.external_id); }
  return { status: r.status, body: r.body };
}
