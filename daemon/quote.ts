// A reply to one message in the chat. The page sends the quoted turn's id with the owner's text, the turns table keeps it
// in reply_to, and the brain gets one line in front of his words that names the message he answers.
import { formatStamp } from '../web/workfold.js';

// The brain must see the whole ask it gets an answer to. A long message often holds a report first and the ask last,
// so past the cap the line keeps the start and the end.
export const QUOTE_CHARS = 4000;
const QUOTE_HEAD = 1500;
const MARKER_LINE = /^\s*\[(image|report): [^\]]*\]\s*$/gm;
const URL = /https?:\/\/\S+/g;
export type TurnRow = { id: number; role: string; text: string; created_at: string };
export type Quote = { id: number; role: 'owner' | 'jarvis'; text: string; at: string };

/** The quote the page shows, or undefined when the turn is not a message from the owner or Jarvis. */
export function quoteOf(t: TurnRow | undefined): Quote | undefined {
  if (!t || (t.role !== 'owner' && t.role !== 'jarvis')) return undefined;
  return { id: t.id, role: t.role, text: t.text.slice(0, 600), at: `${t.created_at.replace(' ', 'T')}Z` };
}

/** `[replying to jarvis, 11-07 3:18 p.m. Eastern: "<the message>"]`, the line in front of the owner's message to the brain.
 * Pass the full turn text: image and report marker lines and URLs are dropped, and a message past QUOTE_CHARS keeps its
 * first QUOTE_HEAD characters and its end, joined by an ellipsis. */
export function quoteLine(q: Quote): string {
  const flat = q.text.replace(MARKER_LINE, ' ').replace(URL, ' ').replace(/\s+/g, ' ').replace(/"/g, "'").trim();
  const words = flat.length > QUOTE_CHARS
    ? `${flat.slice(0, QUOTE_HEAD).trimEnd()} … ${flat.slice(flat.length - (QUOTE_CHARS - QUOTE_HEAD)).trimStart()}`
    : flat;
  return `[replying to ${q.role === 'owner' ? 'his own message' : 'jarvis'}, ${formatStamp(q.at)} Eastern: "${words}"]`;
}

/** The reply id the page sent, as a positive integer, or undefined. Anything else is ignored, so a bad id never loses the message. */
export function replyIdOf(v: unknown): number | undefined {
  const n = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v;
  return Number.isInteger(n) && (n as number) > 0 ? n as number : undefined;
}
