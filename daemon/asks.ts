import { OWNER } from './config.ts';
import type { Store, Item, Approval } from './store.ts';
import type { Log } from './log.ts';
import { approvalTag, approvalOutcomeText } from '../web/worklist.js';
import { namedActionIn, namedLabel, refusedByPermissionLayer, type Named } from './namedactions.ts';
import { brainCard, answerBrainAsk, isBrainAsk } from './brainasks.ts';
import { fields } from './workercontract.ts';
export { fields } from './workercontract.ts';

// A worker's question or escalation as a card in the chat: title, markdown body, and the options as buttons.
// The card is built in code from the stored item. The brain still speaks the ask; nothing here is spoken.

export type AskOption = {
  /** What a tap sends to the worker, the same words the owner would say. */
  value: string;
  /** The button's text. */
  label: string;
  /** The worker's reason or the option's longer wording, shown smaller under the label. */
  detail?: string;
  /** A tap puts the cursor in the answer box and sends nothing. */
  compose?: boolean;
};

export type AskCard = {
  id: string; kind: 'question' | 'escalation'; dispatch: string | null;
  title: string;
  /** Markdown; the page renders it with web/markdown.js, which escapes every piece of text. */
  body: string;
  /** The part of `body` the left column sets large: the QUESTION field, or a short free-form ask as a whole. */
  question?: string;
  /** When the ask arrived, and when it was answered or closed. */
  at: string; settledAt?: string;
  /** Escalations only: what the worker itself wrote under FAILED and PROPOSES. A blocked worker has not failed. */
  failed?: string; proposes?: string;
  /** Escalations only: a permission layer refused the worker, so a retry cannot work. */
  refused?: string;
  /** Recommended first, unless `suggested`. */
  options: AskOption[];
  /** The worker named no options, so these are Jarvis's defaults, and none of them is a recommendation. */
  suggested?: boolean;
  status: 'open' | 'sending' | 'answered';
  answer: string | null;
  /** Set when the brain closed this ask by steering the worker on its own, so the words are not the owner's. */
  answeredBy?: 'jarvis';
  /**
   * Set for an ask with a QUESTION field. The page then draws fixed headings: What the worker is doing (`doing`), The
   * question, Options, and the rest (`more`) behind a More toggle. `image` is the picture's markdown, drawn at the top.
   * Without it the page draws `body` as one block, as before.
   */
  parts?: { doing?: string; more?: string; image?: string };
};

// "Options: (a) one; (b) two" or "Options: 1) one 2) two" at the end of a free-form ask.
const INLINE_OPTIONS = /(?:^|\n|\s)options?\s*:\s*([\s\S]*)$/i;
const MARKER = /(?:^|\s)\(?([a-z]|\d{1,2})[).]\s+/gi;
const IMAGE_MARKER = /\[image:\s*([^\]\n]+?)\s*\]/g;
// A screenshot path written as plain text, e.g. "CONTEXT: mock at /Users/owner/Desktop/a.png".
const BARE_IMAGE = /(?:^|[\s(`])(\/[^\s()`\]]+\.(?:png|jpe?g|webp|gif))(?=$|[\s).,;:`])/im;
const IMAGE_PATH = /^\/[^\n]*\.(png|jpe?g|webp|gif)$/i;
const GENERIC_SUBJECT = /^(question|escalation|ask|blocked)$/i;
/** A paragraph over this length is split into parts, sentences staying whole. */
const PART_MAX = 220;
const SENTENCE_END = /(?<=[.!?])(?<!\b(?:e\.g|i\.e|etc|vs)\.)\s+(?=[\p{Lu}"'`(\[])/u;
const NOT_PROSE = /^\s*(?:[-*+>#|]|\d+[.)]\s|\[image:)/m;


/** The OPTIONS field ends at its first blank line; anything after it is ask text, not more options. */
function splitOptions(text: string): { options: string; after: string } {
  const m = /\n\s*\n/.exec(text);
  return m ? { options: text.slice(0, m.index).trim(), after: text.slice(m.index).trim() } : { options: text, after: '' };
}

/**
 * "(a) one; (b) two. Then more." -> items [{key: 'a', text: 'one'}, {key: 'b', text: 'two'}] and tail "Then more.".
 * The last item ends at its first sentence outside parentheses. Fewer than two markers is not a list.
 */
export function markedList(text: string): { items: { key: string; text: string }[]; tail: string } {
  const hits = [...text.matchAll(MARKER)];
  if (hits.length < 2) return { items: [], tail: text };
  const items = hits.map((h, i) => ({ key: h[1].toLowerCase(), text: text.slice(h.index! + h[0].length, hits[i + 1]?.index ?? text.length) }));
  const last = items.at(-1)!;
  let tail = '';
  for (let n = 0, depth = 0; n < last.text.length; n++) {
    const c = last.text[n];
    if (c === '(') depth++;
    else if (c === ')') depth = Math.max(0, depth - 1);
    else if (c === '.' && depth === 0 && /^\.\s+[A-Z]/.test(last.text.slice(n))) { tail = last.text.slice(n + 1).trim(); last.text = last.text.slice(0, n); break; }
  }
  for (const it of items) it.text = it.text.trim().replace(/[;,]\s*(or|and)?$/i, '').replace(/\.$/, '').trim();
  return { items, tail };
}

/** One OPTIONS entry: "skip it because matches the extension flow". */
function because(s: string): { choice: string; reason?: string } {
  const m = /^(.*?)\s+because\s+(.+)$/i.exec(s.trim());
  return m ? { choice: m[1].trim(), reason: m[2].trim() } : { choice: s.trim() };
}

/**
 * The options of the OPTIONS field: a marked list, one per line, or separated by semicolons or pipes. Within a line, a part
 * with no "because" after one that has a reason is more of that reason ("because no code left; a person replies"), not a choice.
 */
function optionsField(text: string): { choice: string; reason?: string }[] {
  const marked = markedList(text).items;
  if (marked.length) return marked.map(m => because(m.text));
  const out: { choice: string; reason?: string }[] = [];
  for (const line of text.split('\n')) {
    let last: { choice: string; reason?: string } | undefined;
    for (const part of line.split(/[;|]/).map(s => s.replace(/^\s*[-*]\s*/, '').trim()).filter(Boolean)) {
      const option = because(part);
      if (last?.reason && !option.reason) last.reason += `; ${part}`;
      else out.push(last = option);
    }
  }
  return out;
}

function payloadOptions(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    if (Array.isArray(v)) return v.map(String).map(s => s.trim()).filter(Boolean);
    if (typeof v === 'string') return v.split(',').map(s => s.trim()).filter(Boolean);
  } catch { /* not JSON */ }
  return [];
}

/** A database time ('YYYY-MM-DD HH:MM:SS', UTC) as the page reads it. */
const isoTime = (t: string) => `${t.replace(' ', 'T')}Z`;

/** Without the daemon's folder check: any absolute path to a png, jpg, jpeg, webp or gif. */
const looksLikeImage = (path: string) => IMAGE_PATH.test(path);

/** Long prose paragraphs as short ones. Lists, tables, headings and fenced code keep their lines. */
export function shortParts(text: string): string {
  let fenced = false;
  return text.split(/\n\s*\n/).flatMap(block => {
    const inside = fenced;
    if ((block.match(/```/g) ?? []).length % 2) fenced = !fenced;
    if (inside || block.includes('```') || block.length <= PART_MAX || NOT_PROSE.test(block)) return [block];
    const parts: string[] = [];
    for (const sentence of block.split(SENTENCE_END)) {
      const last = parts.length - 1;
      if (last >= 0 && parts[last].length + sentence.length < PART_MAX) parts[last] += ` ${sentence}`;
      else parts.push(sentence);
    }
    return parts;
  }).join('\n\n');
}

/** The Stop answer on an escalation card. requests.ts reads it as the owner stopping the worker. */
export const STOP_ANSWER = 'Stop work on this task and report where it stands with worker_done.';
/** For an escalation that names no options. Each goes to the worker as a message, so Stop asks it to stop; it does not end the process. */
const DEFAULT_OPTIONS: AskOption[] = [
  { value: 'Retry the step that stopped you, then carry on.', label: 'Retry', detail: 'Asks it to try that step again' },
  { value: STOP_ANSWER, label: 'Stop', detail: 'Asks it to stop and report where it stands' },
  { value: '', label: 'Tell it what to do', detail: 'Type your instruction in the box below', compose: true },
];

/** The value of the option that opens an Approve card. answerAsk works out the action again from the stored item, never from the page. */
export const NAMED_ACTION = 'named-action';
const REFUSED_LINE = 'A retry cannot clear this. A permission layer refused the worker, and it would refuse the same step again.';
const RETRY_OPTION = /^\W*(?:retry|try again|re-?run)\b/i;

/** What a card's text says a permission layer refused, and the named action that can do it instead, if the text gives one whole. */
function refusal(text: string): { named?: Named } | undefined {
  if (!refusedByPermissionLayer(text)) return undefined;
  const named = namedActionIn(text);
  return named ? { named } : {};
}

/** The text of an escalation that a permission layer may have refused. */
function refusalText(i: Item): string | undefined {
  return i.kind === 'escalation' ? `${i.subject ?? ''}\n${i.body ?? ''}` : undefined;
}

/** Takes Retry off a refused card, says why, and puts the named action first when there is one. */
function withRefusal(card: AskCard, text: string | undefined): AskCard {
  const r = text === undefined ? undefined : refusal(text);
  if (!r) return card;
  const kept = card.options.filter(o => !RETRY_OPTION.test(o.label));
  const options = kept.length ? kept : DEFAULT_OPTIONS.filter(o => !RETRY_OPTION.test(o.label));
  return {
    ...card, refused: REFUSED_LINE, ...(kept.length ? {} : { suggested: true }),
    options: [...(r.named ? [{ value: NAMED_ACTION, label: namedLabel(r.named), detail: 'Opens an Approve card with the exact command. Nothing runs until you tap Approve.' }] : []), ...options],
  };
}

const answeredBy = (i: Item) => i.answered_by === 'jarvis' ? { answeredBy: 'jarvis' as const } : {};

/**
 * Builds the card for a question or escalation; undefined for anything else.
 * `story` is the worker's title from the work list, used when the ask names no story.
 * `shown` says whether the page may show a picture at that path (the daemon passes its /image folder check).
 */
export function askCard(i: Item, story?: string, shown: (path: string) => boolean = looksLikeImage): AskCard | undefined {
  if (i.kind !== 'question' && i.kind !== 'escalation') return undefined;
  if (isBrainAsk(i)) return brainCard(i);
  const body = (i.body ?? '').trim();
  const f = fields(body);
  const escalation = i.kind === 'escalation';
  const structured = Boolean(f.QUESTION || f.STORY || f.WHERE || (escalation && (f.FAILED || f.PROPOSES)));
  const subject = (i.subject ?? '').trim();
  const blocked = /^blocked\s*:\s*/i.test(subject);
  // An escalation's subject is its headline, in the worker's own words without "Blocked:".
  const said = subject.replace(/^blocked\s*:\s*/i, '');
  const headline = escalation && !GENERIC_SUBJECT.test(said) ? said.charAt(0).toUpperCase() + said.slice(1) : '';

  // Options: the short choices from `--options`, matched to the wording in the body when there is one, unless the body names more.
  const short = payloadOptions(i.options);
  let rest = body;
  let worded: { key?: string; choice: string; reason?: string }[] = [];
  const opts = splitOptions(f.OPTIONS ?? '');
  if (opts.options) worded = optionsField(opts.options);
  else {
    const m = INLINE_OPTIONS.exec(body);
    const list = m ? markedList(m[1]) : { items: [], tail: '' };
    if (list.items.length) {
      worded = list.items.map(l => ({ key: l.key, choice: l.text }));
      rest = [body.slice(0, m!.index).trim(), list.tail].filter(Boolean).join('\n\n');
    }
  }
  let options: AskOption[];
  // A body naming more choices than the short list wins, so none is lost.
  if (short.length >= worded.length) {
    options = short.map((value, n) => {
      // "GO b" or "b" points at "(b) ..." in the body; otherwise match by position.
      const key = /(?:^|\s)([a-z]|\d{1,2})$/i.exec(value)?.[1]?.toLowerCase();
      const w = worded.find(x => x.key && x.key === key) ?? (worded.every(x => !x.key) ? worded[n] : undefined);
      if (!w) return { value, label: value };
      if (w.choice.toLowerCase() === value.toLowerCase()) return { value, label: value, ...(w.reason ? { detail: w.reason } : {}) };
      return { value, label: value, detail: w.reason ? `${w.choice}, because ${w.reason}` : w.choice };
    });
  } else {
    options = worded.map(w => w.key
      ? { value: `${w.key}) ${w.choice}`, label: w.choice }
      : { value: w.choice, label: w.choice, ...(w.reason ? { detail: w.reason } : {}) });
  }
  options = options.slice(0, 6);

  const title = escalation
    ? f.STORY || story || (f.QUESTION ? headline : '') || 'Worker escalation'
    : f.STORY || (subject && !GENERIC_SUBJECT.test(subject) && !blocked ? subject : '') || story || 'Worker question';
  const card: AskCard = {
    id: i.external_id, kind: i.kind, dispatch: i.dispatch_id, title, body: '', options,
    at: isoTime(i.created_at), ...(i.updated_at ? { settledAt: isoTime(i.updated_at) } : {}),
    status: i.status === 'answered' || i.status === 'done' ? 'answered' : i.status === 'replying' ? 'sending' : 'open',
    answer: i.answer, ...answeredBy(i),
  };
  // A design choice can come with a picture: the IMAGE field, else the first `[image: /abs/path]` marker, else the
  // first plain screenshot path anywhere in the ask. It goes to the top as the same tappable thumbnail as in Jarvis's
  // replies. A path outside the allowed folders shows as text, never as a broken thumbnail.
  const [imageLine = '', ...afterImage] = (f.IMAGE ?? '').split('\n');
  const named = imageLine.replace(/^\[image:\s*(.*?)\s*\]$/i, '$1').replace(/^`(.*)`$/, '$1').trim();
  let text = structured ? [f.PREAMBLE, f.WHERE, f.QUESTION, f.CONTEXT, afterImage.join('\n').trim(), opts.after].filter(Boolean).join('\n\n') : rest;
  if (!structured && named) text = text.replace(/^\s*IMAGE\s*:.*$/im, '');
  const source = structured ? body : text;
  const path = named || [...source.matchAll(IMAGE_MARKER)][0]?.[1] || BARE_IMAGE.exec(source)?.[1];
  const image = path && shown(path) ? `[image: ${path}]` : named ? `Image (not in an allowed folder): \`${named}\`` : undefined;
  text = text.replace(IMAGE_MARKER, (_, p: string) => shown(p) ? '' : `\`${p}\``);
  const tidy = text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const lead = escalation && !f.QUESTION && headline !== tidy ? headline : '';
  card.body = [image, lead, escalation ? shortParts(tidy) : tidy].filter(Boolean).join('\n\n');
  const question = f.QUESTION || (escalation && !f.QUESTION && headline) || (!structured && text.trim().length <= 180 && !/\n/.test(text.trim()) ? text.trim() : '');
  if (question) card.question = question;
  if (f.QUESTION) {
    const clean = (s?: string) => (s ?? '').replace(IMAGE_MARKER, (_, p: string) => shown(p) ? '' : `\`${p}\``).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    const doing = clean(f.WHERE), more = clean([f.PREAMBLE, f.CONTEXT, afterImage.join('\n').trim(), opts.after].filter(Boolean).join('\n\n'));
    card.parts = { ...(doing ? { doing } : {}), ...(more ? { more: escalation ? shortParts(more) : more } : {}), ...(image ? { image } : {}) };
  }
  if (escalation) {
    if (f.FAILED) card.failed = f.FAILED;
    if (f.PROPOSES) card.proposes = f.PROPOSES;
    if (!options.length) { card.options = DEFAULT_OPTIONS; card.suggested = true; }
  }
  return withRefusal(card, refusalText(i));
}

/** One line of the audit log: a question the owner answered or an approval he decided. */
export type AuditEntry = { key: string; kind: 'ask' | 'approval'; tag: string; at: string; question: string; answer: string; failed?: boolean; by?: 'jarvis' };

const json = (s: string): any => { try { return JSON.parse(s); } catch { return {}; } };

function approvalOutcome(a: Approval): Pick<AuditEntry, 'answer' | 'failed'> {
  return { answer: approvalOutcomeText(a) || 'Approved, still running', ...(a.status === 'failed' || a.status === 'unknown' ? { failed: true } : {}) };
}

/**
 * Answered asks and decided approvals, newest first. An ask Jarvis closed without an answer is not listed, and neither is
 * an approval nobody decided (`automatic`) or a work-list button press (`pressed`, the gate's PRESSED).
 */
export function auditEntries(store: Store, cardOf: (i: Item) => AskCard | undefined, pressed: Set<string>, limit = 200): AuditEntry[] {
  const asks = store.answeredAsks(limit).flatMap((i): AuditEntry[] => {
    const c = cardOf(i);
    if (!c) return [];
    const answer = c.options.find(o => o.value === i.answer)?.label ?? i.answer ?? '';
    return [{ key: `ask:${c.id}`, kind: 'ask', tag: c.title, at: c.settledAt ?? c.at, question: c.question ?? c.title, answer, ...(c.answeredBy ? { by: c.answeredBy } : {}) }];
  });
  const approvals = store.decidedApprovals(limit).filter(a => !pressed.has(a.action)).map((a): AuditEntry => ({
    key: `approval:${a.id}`, kind: 'approval', tag: approvalTag(a.action, json(a.args)), at: isoTime(a.decided_at ?? a.created_at), question: a.say, ...approvalOutcome(a),
  }));
  return [...asks, ...approvals].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, limit);
}

export type AnswerResult = { status: number; error?: string };

type AnswerArgs = {
  id: string; value: string; store: Store; log: Log; note: (text: string) => void;
  /** Carries an answer into a background Claude worker (native.ts). */
  native?: { reply: (id: string, text: string, by: 'owner' | 'jarvis') => Promise<{ ok: true } | { ok: false; error: string }> };
};

/**
 * the owner tapped an option on an ask card. A native worker's question gets the words through native.reply, claimed first
 * so it can never go out twice. Jarvis's own question goes to the brain.
 */
export async function answerAsk(o: AnswerArgs): Promise<AnswerResult> {
  const { id, value, store, log } = o;
  const item = store.item(id);
  if (!item || (item.kind !== 'question' && item.kind !== 'escalation')) return { status: 404, error: 'That ask is not known here.' };
  if (!value.trim()) return { status: 400, error: 'No answer to send.' };
  // Jarvis's own question (brainasks.ts): the answer goes to the brain, not to a worker.
  if (isBrainAsk(item)) return answerBrainAsk({ id, value, store, log, note: o.note });
  const ids = { item: id, dispatch: item.dispatch_id };
  if (item.source !== 'native') return { status: 409, error: 'This ask came from a worker Jarvis no longer runs, so nothing can answer it here.' };
  if (!o.native || !item.dispatch_id) return { status: 500, error: 'Nothing was sent: this path cannot reach native workers.' };
  const claim = store.claimReply(id);
  if (claim !== 'claimed') return { status: 409, error: `That question is already ${claim}. Not answering it twice.` };
  const r = await o.native.reply(item.dispatch_id, value, 'owner');
  if (!r.ok) { store.releaseReply(id); log('ask card: native reply failed, ask reopened', { ...ids, error: r.error }); return { status: 502, error: `Not sent: ${r.error}` }; }
  store.markItem(id, 'answered', value);
  log('ask card: The owner answered a native worker', ids);
  o.note(`[ask card] ${OWNER} tapped ${JSON.stringify(value)} on ask message_id=${id} in the app. It already went to the worker; do not reply to it again. Reply SILENT.`);
  return { status: 200 };
}
