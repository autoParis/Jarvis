// The "Worked for 8m 8s" row: everything Jarvis did between the owner's message and the reply, folded into one line.
// Notes split the steps; the thoughts, tool calls and updates between two notes are one group with a one-line summary.
// A module so the page and daemon/workfold.test.ts import the same code.
import { esc } from './requestlist.js';

const svg = paths => `<svg class="fold-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const ICONS = {
  terminal: svg('<path d="m5 7 5 5-5 5M12 18h7"/>'),
  wrench: svg('<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94z"/>'),
  globe: svg('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>'),
  brain: svg('<path d="M12 5a3 3 0 1 0-6 .13 4 4 0 0 0-2.5 5.77 4 4 0 0 0 .55 6.6A4 4 0 1 0 12 18zM12 5a3 3 0 1 1 6 .13 4 4 0 0 1 2.5 5.77 4 4 0 0 1-.55 6.6A4 4 0 1 1 12 18zM12 5v13"/>'),
};
const CHEV = '<svg class="chev" viewBox="0 0 12 12" aria-hidden="true"><path d="M4.5 2.5 8 6l-3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const LINE_MAX = 300;

const COMMAND_TOOLS = new Set(['Bash', 'shell', 'exec_command', 'local_shell']); // Claude Code's and Codex's
const kindOf = s => s.kind !== 'tool' ? s.kind : COMMAND_TOOLS.has(s.name) ? 'command' : s.name === 'WebSearch' ? 'search' : 'tool';
const ICON_OF = { thought: 'brain', update: 'wrench', command: 'terminal', search: 'globe', tool: 'wrench' };

/** 8s, 8m 8s, 1h 2m. Never 0s: a turn with steps took some time. */
export function formatDuration(ms) {
  const total = Math.max(1, Math.round((ms || 0) / 1000));
  const h = Math.floor(total / 3600), m = Math.floor(total / 60) % 60, s = total % 60;
  return h ? `${h}h ${m}m` : m ? `${m}m ${s}s` : `${s}s`;
}

// the owner's clock is Eastern (America/Toronto). Fixed here so a phone abroad or a UTC machine shows the same time.
const EASTERN = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', month: '2-digit', day: '2-digit', hour: 'numeric', minute: '2-digit', hourCycle: 'h23' });

/** 11-02 3:18 p.m., always in Eastern time. Takes anything Date reads; the daemon's times are UTC. */
export function formatStamp(at) {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return '';
  const p = Object.fromEntries(EASTERN.formatToParts(d).map(x => [x.type, x.value]));
  const h = Number(p.hour);
  return `${p.month}-${p.day} ${h % 12 || 12}:${p.minute} ${h < 12 ? 'a.m.' : 'p.m.'}`;
}

const PHRASE = {
  tool: n => `used ${n} tool${n === 1 ? '' : 's'}`,
  search: n => `searched the web ${n} time${n === 1 ? '' : 's'}`,
  command: n => `ran ${n} command${n === 1 ? '' : 's'}`,
  update: n => `received ${n} update${n === 1 ? '' : 's'}`,
};

/** "Used 3 tools, searched the web 1 time, and ran 1 command", in the order each kind first happened. Thoughts are not counted. */
export function summarize(steps) {
  const counts = new Map();
  for (const s of steps) if (kindOf(s) !== 'thought') counts.set(kindOf(s), (counts.get(kindOf(s)) ?? 0) + 1);
  const parts = [...counts].map(([kind, n]) => PHRASE[kind](n));
  if (!parts.length) return 'Thought';
  const text = parts.length < 3 ? parts.join(' and ') : `${parts.slice(0, -1).join(', ')}, and ${parts.at(-1)}`;
  return text[0].toUpperCase() + text.slice(1);
}

function groupIcon(steps) {
  const kinds = new Set(steps.map(kindOf));
  if (kinds.has('tool')) return 'wrench';
  if (kinds.has('command')) return 'terminal';
  if (kinds.has('search')) return 'globe';
  return kinds.has('update') ? 'wrench' : 'brain';
}

/** Steps in order as notes and groups. */
export function groupSteps(steps) {
  const out = [];
  let group = null;
  for (const s of steps) {
    if (s.kind === 'note') { out.push({ type: 'note', text: s.text }); group = null; continue; }
    if (!group) { group = { type: 'group', steps: [] }; out.push(group); }
    group.steps.push(s);
  }
  for (const g of out) if (g.type === 'group') { g.summary = summarize(g.steps); g.icon = groupIcon(g.steps); }
  return out;
}

/** The one line a call shows: a command as typed, any other tool as `Name: arguments`. */
export function callLine(s) {
  const raw = s.kind !== 'tool' ? s.text : kindOf(s) === 'command' ? s.input : s.input ? `${s.name}: ${s.input}` : s.name;
  return raw.replace(/\s+/g, ' ').trim().slice(0, LINE_MAX);
}

const block = (label, text, cls = '') => `<div class="fold-label${cls}">${label}</div><pre>${esc(text)}</pre>`;
const shortened = s => s.clipped ? '<div class="fold-clipped">Shortened to fit</div>' : '';
function detailHtml(s) {
  if (s.kind !== 'tool') return `<pre>${esc(s.text)}</pre>${shortened(s)}`;
  const output = s.output === undefined ? '<div class="fold-label">No output recorded</div>' : block(s.failed ? 'Error' : 'Output', s.output, s.failed ? ' failed' : '');
  return block('Input', s.input) + output + shortened(s);
}
const callHtml = s => `<div class="fold-call"><button type="button" class="fold-toggle fold-line" aria-expanded="false">${ICONS[ICON_OF[kindOf(s)]]}<span class="t">${esc(callLine(s))}</span>${CHEV}</button><div class="fold-detail" hidden>${detailHtml(s)}</div></div>`;

/** The steps inside an open row. `md` renders a note's markdown; it escapes the text itself. */
export function stepsHtml(steps, md) {
  return groupSteps(steps).map(g => {
    if (g.type === 'note') return `<div class="fold-note md">${md(g.text)}</div>`;
    // Thoughts with nothing else around them read straight off the group, with no row in between.
    const inner = g.steps.every(s => s.kind === 'thought') ? `<div class="fold-detail">${g.steps.map(detailHtml).join('')}</div>` : g.steps.map(callHtml).join('');
    return `<div class="fold-group"><button type="button" class="fold-toggle fold-sum" aria-expanded="false">${ICONS[g.icon]}<span class="t">${esc(g.summary)}</span></button><div class="fold-calls" hidden>${inner}</div></div>`;
  }).join('');
}

/** The collapsed row. Its steps load when it first opens. */
export function foldHtml({ id, ms, at }) {
  return `<button type="button" class="fold-toggle fold-head" data-fold="${esc(id)}" aria-expanded="false"><span>Worked for ${esc(formatDuration(ms))}</span>${CHEV}<span class="ago">${esc(formatStamp(at))}</span></button><div class="fold-body" hidden></div>`;
}

// ---- messages from other agents: the same row, with the text already on the page ----

/** One event turn as separate messages. A daemon batch has one `- [kind] ...` line per item; other lines stay with the one above. */
export function eventMessages(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    if (line.startsWith('- [') || !out.length) out.push(line);
    else out[out.length - 1] += `\n${line}`;
  }
  return out;
}

/** The subject of an event line, or '' when it has none. The daemon writes it as a JSON string. */
export function eventSubject(text) {
  const m = /(?:^|\s)subject=("(?:[^"\\\n]|\\.)*")/.exec(text);
  if (!m) return '';
  try { return JSON.parse(m[1]).trim(); } catch { return ''; }
}

/** "Message received: subject" and the time; the full text opens below. `render` escapes the text itself. */
export function messageFoldHtml({ text, at }, render) {
  const subject = eventSubject(text);
  const title = subject ? `Message received: ${subject}` : 'Message received';
  return `<button type="button" class="fold-toggle fold-head" aria-expanded="false"><span class="fold-title">${esc(title)}</span>${CHEV}<span class="ago">${esc(formatStamp(at))}</span></button><div class="fold-body" hidden><div class="msg event">${render(text)}</div></div>`;
}

const ANSWER_WORDS = 6;
/** The first few words, on one line. */
export function fewWords(text, n = ANSWER_WORDS) {
  const words = String(text).trim().split(/\s+/);
  return words.length > n ? `${words.slice(0, n).join(' ')}…` : words.join(' ');
}

/**
 * "You answered, Story 4612: Show them as Not set up" on one line, the full text below it. `by: 'jarvis'` is the brain
 * steering a worker on its own. `render` escapes the text itself. A failed outcome stays red while folded.
 */
export function answerFoldHtml({ tag, answer, at, by, failed }, render) {
  const title = `${by === 'jarvis' ? 'Jarvis steered' : 'You answered'}, ${tag}: ${fewWords(answer)}`;
  return `<div class="fold fold-answer${failed ? ' failed' : ''}"><button type="button" class="fold-toggle fold-head" aria-expanded="false"><span class="fold-title">${esc(title)}</span>${CHEV}<span class="ago">${esc(formatStamp(at))}</span></button><div class="fold-body" hidden><div class="msg event">${render(answer)}</div></div></div>`;
}

// ---- the worker pane: tool rows folded between messages ----

/** "Ran 5 commands and used 2 tools", from pane lines like "Bash: npm test". */
export function toolRunSummary(texts) {
  return summarize(texts.map(t => ({ kind: 'tool', name: /^[^:]*/.exec(t)[0] })));
}

/** An empty fold for a run of tool rows. The page adds each row to .fold-calls and sets .t with toolRunSummary. */
export function toolRunHtml() {
  return `<button type="button" class="fold-toggle fold-sum" aria-expanded="false">${ICONS.wrench}<span class="t"></span>${CHEV}</button><div class="fold-calls" hidden></div>`;
}

/** The small label over an answer. */
export function paneTag(l) {
  if (l.kind === 'reply') return l.by === 'jarvis' ? 'Jarvis answered' : 'You answered';
  return '';
}

const footIcon = paths => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
export const COPY_ICON = footIcon('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1"/>');
export const COPIED_ICON = footIcon('<path d="m5 12 5 5 9-10"/>');

const BARS = '<span class="bars" aria-hidden="true"><i></i><i></i><i></i><i></i></span>';
const SPEAKER = footIcon('<path d="M4 9.5v5h3.5l4.5 4v-13l-4.5 4Z"/><path d="M15.5 9.2a4 4 0 0 1 0 5.6"/><path d="M18.2 6.5a8 8 0 0 1 0 11"/>');
/** What the speaker button shows and says in each state of web/speech.js. */
export const SPEAK = {
  idle: { html: SPEAKER, title: 'Read aloud' },
  loading: { html: BARS, title: 'Stop' },
  playing: { html: `${BARS}<svg class="stop-glyph" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2"/></svg>`, title: 'Stop' },
  paused: { html: SPEAKER, title: 'Continue' },
  failed: { html: SPEAKER, title: 'Could not play this message. Tap to try again' },
};

/**
 * The row under a message from the owner or Jarvis: the time, a copy button, a reply button when the message has a turn
 * id and, on a Jarvis message with words to read, a speaker button. CSS shows it on hover, or on a tap on a touch screen.
 */
export function messageFootHtml(at, speak, turn) {
  const speaker = speak ? `<button type="button" class="msg-speak" data-turn="${speak.id}" data-clips="${speak.clips}" data-state="idle" aria-label="${SPEAK.idle.title}" title="${SPEAK.idle.title}">${SPEAK.idle.html}</button>` : '';
  const reply = Number.isInteger(turn) && turn > 0 ? `<button type="button" class="msg-reply" aria-label="Reply to this message" title="Reply">${REPLY_ICON}</button>` : '';
  return `<div class="msg-foot"><span class="ago">${esc(formatStamp(at))}</span><button type="button" class="msg-copy" aria-label="Copy message" title="Copy">${COPY_ICON}</button>${reply}${speaker}</div>`;
}

export const REPLY_ICON = footIcon('<path d="M9.5 15 4 9.5 9.5 4"/><path d="M4 9.5h10a6 6 0 0 1 0 12h-2"/>');
const SNIPPET_MAX = 120;
/** The first line of a quoted message, as the strip and the quote show it: markdown marks and picture markers left out. */
export function quoteSnippet(text) {
  const line = String(text ?? '')
    .replace(/\[(image|report):[^\]]*\]/g, m => m.startsWith('[image') ? 'Picture' : 'Document')
    .split('\n').map(l => l.replace(/^\s*(#{1,6}\s+|[-*+]\s+|>\s*|\d+\.\s+)/, '').replace(/[*_`]+/g, '').trim()).find(Boolean) ?? '';
  return line.length > SNIPPET_MAX ? `${line.slice(0, SNIPPET_MAX - 1).trimEnd()}…` : line;
}
export const quoteWho = role => role === 'owner' ? 'You' : 'Jarvis';
/** The quote on top of a message the owner sent as a reply. A tap scrolls to the quoted message (data-quote is its turn). */
export function quoteHtml(q) {
  if (!q?.id) return '';
  return `<button type="button" class="quote" data-quote="${Number(q.id)}" aria-label="Go to the quoted message"><b>${esc(quoteWho(q.role))}</b><span>${esc(quoteSnippet(q.text))}</span></button>`;
}
