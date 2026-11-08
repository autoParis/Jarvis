import { OWNER_CAP, OWNER } from './config.ts';
import type { OrcaResult } from './orca.ts';
import type { Store, Item, Approval } from './store.ts';
import type { Log } from './log.ts';
import type { Gate } from './gate.ts';
import { approvalTag, approvalOutcomeText } from '../web/worklist.js';
import { isStopNotice } from './work.ts';
import { namedActionIn, namedLabel, namedQuestion, refusedByPermissionLayer, type Named } from './namedactions.ts';
import { readStopNotice, readScreen, stillAt, storedContext, type StopNotice, type PromptOption, type PromptContext } from './prompt.ts';
import { explainCredentialCommand } from './promptexplain.ts';

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
  /** The options are a menu in the worker's terminal: a tap types the key, and only the menu can answer it. */
  prompt?: boolean;
  /** What that prompt wants to run, as much of it as Jarvis has. */
  command?: string;
  /** The heading over `command`, which says whether that is all of it. */
  commandLabel?: string;
  /**
   * Set for an ask with a QUESTION field. The page then draws fixed headings: What the worker is doing (`doing`), The
   * question, Options, and the rest (`more`) behind a More toggle. `image` is the picture's markdown, drawn at the top.
   * Without it the page draws `body` as one block, as before.
   */
  parts?: { doing?: string; more?: string; image?: string };
};

const LABELS = ['STORY', 'WHERE', 'QUESTION', 'CONTEXT', 'IMAGE', 'OPTIONS', 'FAILED', 'PROPOSES', 'PROPOSAL', 'PROPOSE'] as const;
const LABEL_LINE = new RegExp(`^\\s*(${LABELS.join('|')})\\s*:\\s*(.*)$`, 'i');
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

/**
 * The labeled fields of an ask written in the jarvis-ask shape (spec 6.6). A line without a label continues the field
 * above, blank lines included, so markdown paragraphs, lists and headings in a field survive. Text before the first
 * label is kept under PREAMBLE.
 */
export function fields(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  let key = 'PREAMBLE';
  for (const line of body.replace(/\r\n?/g, '\n').split('\n')) {
    const m = LABEL_LINE.exec(line);
    if (m) { key = m[1].toUpperCase(); if (key === 'PROPOSAL' || key === 'PROPOSE') key = 'PROPOSES'; out[key] = m[2]; }
    else out[key] = key in out ? out[key] + '\n' + line : line;
  }
  for (const k of Object.keys(out)) { out[k] = out[k].trim(); if (!out[k]) delete out[k]; }
  return out;
}

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

/** The text of an escalation that a permission layer may have refused. A menu still open is not a refusal: its Yes can work. */
function refusalText(i: Item): string | undefined {
  if (i.kind !== 'escalation') return undefined;
  if (!isStopNotice(i)) return `${i.subject ?? ''}\n${i.body ?? ''}`;
  const n = readStopNotice(i.body);
  return n.kind === 'prompt' ? undefined : n.output;
}

/** The named action a tap on this escalation would propose. */
function namedActionOf(i: Item): Named | undefined {
  const text = refusalText(i);
  return text === undefined ? undefined : refusal(text)?.named;
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

/** What a tap does at a permission prompt, for the answers Claude Code's menus use. A menu's own wording stays otherwise. */
function permissionDetail(label: string, cut: boolean, detail?: string): string | undefined {
  if (/^yes$/i.test(label)) return cut ? 'Lets the whole command run once, including the part cut off. It asks again next time.' : 'Lets this run once. It asks again next time.';
  if (/^yes.*auto mode/i.test(label)) return 'Lets this run, then auto mode answers these prompts in your place.';
  if (/^yes.*(don.t ask again|always allow|allow all)/i.test(label)) return 'Lets this run, and stops asking about anything like it.';
  if (/^no$/i.test(label)) return 'Blocks this and nothing runs. The worker must find another way.';
  return detail;
}

/** The small line above the question: what the worker was doing, and its own reason when its log gives one. */
function doingLine(context: PromptContext | undefined): string {
  const did = 'Stopped at a safety prompt while working on this story.';
  const why = context?.description ? ` It describes this step as "${context.description}".` : ' It gave no reason for this step.';
  const last = context?.said ? ` It last said: "${context.said}"` : '';
  return (did + why + last).replace(/\[image:[^\]]*\]/g, '');
}

const STOP_OUTPUT_MAX = 600;
const STOPPED_LINE = 'It ended its turn without reporting.';

const answeredBy = (i: Item) => i.answered_by === 'jarvis' ? { answeredBy: 'jarvis' as const } : {};

/** Orca's stop notice as a card: the task, what the worker wants, and the menu's real options. None of Orca's template. */
function stopCard(i: Item, story: string | undefined, n: StopNotice): AskCard {
  const base = {
    id: i.external_id, kind: 'escalation' as const, dispatch: i.dispatch_id, title: n.task || story || 'Worker',
    at: isoTime(i.created_at), ...(i.updated_at ? { settledAt: isoTime(i.updated_at) } : {}),
    status: i.status === 'answered' || i.status === 'done' ? 'answered' as const : i.status === 'replying' ? 'sending' as const : 'open' as const,
    answer: i.answer, ...answeredBy(i),
  };
  if (n.kind === 'prompt') {
    if (!n.prompt) {
      const question = 'It is waiting at a prompt, and Jarvis could not read the options. Answer it in Orca, or send it a message here.';
      return { ...base, body: question, question, options: [], ...(n.output ? { command: n.output.slice(-STOP_OUTPUT_MAX), commandLabel: 'Last output' } : {}) };
    }
    const p = n.prompt, context = storedContext(i.meta);
    const command = context?.command ?? p.full;
    const cut = !context?.command && !!p.clipped;
    const credential = !p.tool && !!command && /credential/i.test(p.said ?? p.summary);
    const known = credential ? explainCredentialCommand(command, cut) : undefined;
    // The prompt's own words, whole, when no code explains them. Its first sentence is already in the question.
    const rawRest = !known && p.said && !p.summary.includes(p.said) ? p.said : '';
    const question = known?.question ?? p.summary;
    const facts = known ? known.facts.map(f => `- ${f}`).join('\n') : rawRest;
    return {
      ...base, body: [doingLine(context), question, facts].filter(Boolean).join('\n\n'), question, prompt: true,
      options: p.options.map(({ key, label, detail }) => {
        const d = p.permission ? permissionDetail(label, cut, detail) : detail;
        return { value: key, label, ...(d ? { detail: d } : {}) };
      }),
      ...(command ? { command: cut ? `… ${command}` : command, commandLabel: p.tool ? 'Tool' : cut ? 'End of the command (the start is cut off)' : 'The whole command' } : {}),
    };
  }
  const body = n.output.length > STOP_OUTPUT_MAX ? `${n.output.slice(0, STOP_OUTPUT_MAX).trimEnd()}…` : n.output;
  const parts = shortParts(body);
  const defaults = { options: DEFAULT_OPTIONS, suggested: true };
  return withRefusal(n.kind === 'stopped'
    ? { ...base, ...defaults, body: [STOPPED_LINE, parts].filter(Boolean).join('\n\n'), question: STOPPED_LINE }
    : { ...base, ...defaults, body: parts }, n.output);
}

/**
 * Builds the card for a question or escalation; undefined for anything else.
 * `story` is the worker's title from the work list, used when the ask names no story.
 * `shown` says whether the page may show a picture at that path (the daemon passes its /image folder check).
 */
export function askCard(i: Item, story?: string, shown: (path: string) => boolean = looksLikeImage): AskCard | undefined {
  if (i.kind !== 'question' && i.kind !== 'escalation') return undefined;
  if (isStopNotice(i)) return stopCard(i, story, readStopNotice(i.body));
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
  // Orca keeps only the last of repeated --options flags (msg_81728794bdde), so a body naming more choices wins and none is lost.
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

/**
 * `jarvis-orca steer` went out, which closes that worker's open escalations. The owner's spoken answer to an escalation takes
 * this path too, so the words count as his only while the brain's turn holds a message from him. Returns the closed ids.
 */
export function closeSteeredAsks(store: Store, dispatch: string, answer: string | undefined, fromOwner: boolean): string[] {
  const open = store.openItems().filter(x => x.kind === 'escalation' && x.dispatch_id === dispatch);
  for (const i of open) store.markItem(i.external_id, 'answered', answer, fromOwner ? undefined : 'jarvis');
  return open.map(i => i.external_id);
}

type Orca = (args: string[]) => Promise<OrcaResult>;
export type AnswerResult = { status: number; error?: string };

type AnswerArgs = {
  id: string; value: string; run: string; handle: string; store: Store; orca: Orca; log: Log; note: (text: string) => void;
  /** Runs the key press on a terminal menu, recorded in `approvals`, and proposes a named action. */
  gate?: Pick<Gate, 'pressed'> & Partial<Pick<Gate, 'propose'>>;
  /** The pause before looking at the screen again. */
  wait?: (ms: number) => Promise<unknown>;
  /** Carries an answer into a background Claude worker (native.ts). */
  native?: { reply: (id: string, text: string, by: 'owner' | 'jarvis') => Promise<{ ok: true } | { ok: false; error: string }> };
};
/** How long a terminal gets to take a key before the screen is read again. */
const KEY_SETTLE_MS = 1500;

/**
 * the owner tapped an option of a menu in a worker's terminal. A digit picks whatever menu is up, so the screen is read first
 * and nothing is typed unless it shows this same prompt. No Enter follows: the digit picks the option by itself, and an
 * Enter would land on whatever came next, possibly another prompt.
 */
async function answerPrompt(o: AnswerArgs, n: StopNotice, option: PromptOption): Promise<AnswerResult> {
  const { id, store, log } = o;
  const item = store.item(id)!;
  const ids = { item: id, dispatch: item.dispatch_id, terminal: n.terminal };
  if (!o.gate) return { status: 500, error: 'Nothing was typed: this path cannot reach the worker\'s terminal.' };
  const claim = store.claimReply(id);
  if (claim !== 'claimed') return { status: 409, error: `That prompt is already ${claim}. Not answering it twice.` };

  const before = await readScreen(o.orca, n.terminal!);
  if (!before) {
    store.releaseReply(id);
    log('prompt card: no screen from Orca, nothing typed', ids);
    return { status: 502, error: 'Nothing was typed: Orca could not show this worker\'s screen, so Jarvis could not check the prompt is still open. Answer it in Orca.' };
  }
  if (before.exited || !stillAt(n.prompt!, before.tail)) {
    store.markItem(id, 'done');
    log('prompt card: the worker left the prompt, nothing typed', ids);
    return { status: 409, error: 'Nothing was typed: the worker is no longer at that prompt.' };
  }
  const a = await o.gate.pressed('prompt-key', { terminal: n.terminal, key: option.key }, `Answer "${option.label}" at the prompt in "${n.task?.slice(0, 60) ?? n.terminal}"`).catch(e => ({ status: 'failed', result: (e as Error).message }));
  if (a.status === 'unknown') {
    log('prompt card: no answer from Orca, card stays sending', ids);
    return { status: 502, error: 'Orca gave no answer, so the key may or may not have gone in. Check the worker in Orca before answering again.' };
  }
  if (a.status !== 'done') {
    store.releaseReply(id);
    log('prompt card: key refused', { ...ids, error: a.result });
    return { status: 502, error: `Not answered: ${a.result ?? 'Orca refused the key.'}` };
  }
  await (o.wait ?? (ms => new Promise(r => setTimeout(r, ms))))(KEY_SETTLE_MS);
  const after = await readScreen(o.orca, n.terminal!);
  if (after && !after.exited && stillAt(n.prompt!, after.tail)) {
    store.releaseReply(id);
    log('prompt card: the prompt still shows after the key', ids);
    return { status: 502, error: 'The key went in, but the prompt is still showing. Check the worker in Orca.' };
  }
  store.markItem(id, 'answered', option.key);
  log('prompt card: The owner answered a terminal prompt', { ...ids, key: option.key, seenGone: !!after });
  o.note(`[ask card] ${OWNER} tapped ${JSON.stringify(option.label)} on prompt message_id=${id} in the app, and the key went into the worker's terminal. Do not answer it again. Reply SILENT.`);
  return { status: 200 };
}

/**
 * the owner tapped an option on an ask card. A question gets the same reply as `jarvis-orca reply --id <id> --body <value>`,
 * claimed first so it can never go out twice. An escalation is not something Orca can reply to, so the value goes to
 * the worker as a message, as the steer box does.
 */
export async function answerAsk(o: AnswerArgs): Promise<AnswerResult> {
  const { id, value, store, log } = o;
  const item = store.item(id);
  if (!item || (item.kind !== 'question' && item.kind !== 'escalation')) return { status: 404, error: 'That ask is not known here.' };
  if (!value.trim()) return { status: 400, error: 'No answer to send.' };
  const ids = { item: id, dispatch: item.dispatch_id };
  if (isStopNotice(item)) {
    const n = readStopNotice(item.body);
    const option = n.prompt?.options.find(x => x.key === value);
    if (n.terminal && option) return answerPrompt(o, n, option);
  }
  const told = `[ask card] ${OWNER} tapped ${JSON.stringify(value)} on ask message_id=${id} in the app. It already went to the worker; do not reply to it again. Reply SILENT.`;

  // A background Claude worker's question: jarvisd carries the words in itself (native.ts), no Orca reply.
  if (item.source === 'native') {
    if (!o.native || !item.dispatch_id) return { status: 500, error: 'Nothing was sent: this path cannot reach native workers.' };
    const claim = store.claimReply(id);
    if (claim !== 'claimed') return { status: 409, error: `That question is already ${claim}. Not answering it twice.` };
    const r = await o.native.reply(item.dispatch_id, value, 'owner');
    if (!r.ok) { store.releaseReply(id); log('ask card: native reply failed, ask reopened', { ...ids, error: r.error }); return { status: 502, error: `Not sent: ${r.error}` }; }
    store.markItem(id, 'answered', value);
    log('ask card: The owner answered a native worker', ids);
    o.note(told);
    return { status: 200 };
  }

  if (item.kind === 'escalation') {
    if (!item.dispatch_id) return { status: 409, error: 'This escalation names no worker to send the answer to.' };
    if (item.status !== 'new' && item.status !== 'spoken') return { status: 409, error: `That escalation is already ${item.status}.` };
    let message = value;
    if (value === NAMED_ACTION) {
      const named = namedActionOf(item);
      if (!named) return { status: 409, error: 'This card no longer names an action to run.' };
      if (!o.gate?.propose) return { status: 500, error: 'Nothing was proposed: this path cannot reach the gate.' };
      // A second tap after a failed send finds the same card: the gate returns a repeat proposal instead of adding one.
      const card = await o.gate.propose(named.action, named.args, namedQuestion(named)).catch(e => (e as Error));
      if (card instanceof Error) {
        log('ask card: named action refused', { ...ids, action: named.action, error: card.message });
        return { status: 400, error: `Nothing was proposed: ${card.message}` };
      }
      log('ask card: The owner asked for a named action', { ...ids, action: named.action, approval: card.id });
      message = `Do not retry the refused step. ${OWNER_CAP} has it on an Approve card (${namedLabel(named)}), and jarvisd runs it, not you. Leave that step out, finish whatever else you can, and report with worker_done, saying that step went to his card.`;
    }
    const r = await o.orca(['orchestration', 'send', '--run', o.run, '--from', o.handle, '--to', `dispatch:${item.dispatch_id}`, '--subject', `From ${OWNER}`, '--body', message]).catch(() => undefined);
    if (!r?.ok) {
      log('ask card: send failed', { ...ids, error: r?.error?.code ?? 'no answer' });
      return { status: 502, error: r ? `Orca refused it: ${r.error?.message ?? r.error?.code}` : 'Orca gave no answer, so the message may or may not have gone out.' };
    }
    store.markItem(id, 'answered', value);
    log('ask card: The owner answered an escalation', ids);
    o.note(told);
    return { status: 200 };
  }

  const claim = store.claimReply(id);
  if (claim !== 'claimed') return { status: 409, error: `That question is already ${claim}. Not answering it twice.` };
  const r = await o.orca(['orchestration', 'reply', '--run', o.run, '--from', o.handle, '--id', id, '--body', value]).catch(() => undefined);
  if (r?.ok) {
    store.markItem(id, 'answered', value);
    log('ask card: The owner answered a question', ids);
    o.note(told);
    return { status: 200 };
  }
  if (r && !r.ok) {
    store.releaseReply(id);
    log('ask card: Orca refused the reply, ask reopened', { ...ids, error: r.error?.code });
    return { status: 502, error: `Orca refused the answer: ${r.error?.message ?? r.error?.code}` };
  }
  log('ask card: no answer from Orca, ask stays replying', ids);
  return { status: 502, error: 'Orca gave no answer, so the reply may or may not have gone out. Check before sending it again.' };
}
