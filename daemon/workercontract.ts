// The worker contract: every rule Jarvis writes into a worker's brief, and the parsers that read the worker's replies
// back. The labels are defined once here, so the brief and its parser cannot drift apart. workercontract.test.ts writes
// an ask and a report in the shape each brief describes and checks that they read back.
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OWNER, OWNER_CAP, PRODUCT_LABEL } from './config.ts';
import { reportsDir } from './reports.ts';

/** The folder of the reports the app opens. A worker that names a report for a decision writes it here. */
export const REPORTS_DIR = reportsDir(join(dirname(fileURLToPath(import.meta.url)), '..'));

/** The labeled fields of an ask. The parser also takes FAILED and PROPOSES (with PROPOSAL and PROPOSE) on escalations. */
export const ASK_FIELDS = ['STORY', 'WHERE', 'QUESTION', 'CONTEXT', 'REPORT', 'IMAGE', 'OPTIONS'] as const;
/** The first-line labels of a worker's message that ask nothing: a final report, a pause, a status notice. */
export const REPORT_LABELS = ['DONE', 'FAILED', 'WAITING', 'NOTICE'] as const;
export type ReportLabel = typeof REPORT_LABELS[number];

// The fields of an ask.
const LABELS = [...ASK_FIELDS, 'FAILED', 'PROPOSES', 'PROPOSAL', 'PROPOSE'] as const;
const LABEL_LINE = new RegExp(`^\\s*(${LABELS.join('|')})\\s*:\\s*(.*)$`, 'i');

// The OPTIONS label in capitals inside a QUESTION line. Lower-case "options:" in prose stays question text.
const INLINE_OPTIONS_LABEL = /\s+OPTIONS\s*:\s*/;

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
    if (m) {
      key = m[1].toUpperCase(); if (key === 'PROPOSAL' || key === 'PROPOSE') key = 'PROPOSES'; out[key] = m[2];
      // A one-line ask: "QUESTION: Did it work? OPTIONS: yes because ...; no because ...". The options start a field of their own.
      const inline = key === 'QUESTION' ? INLINE_OPTIONS_LABEL.exec(m[2]) : null;
      if (inline) { out.QUESTION = m[2].slice(0, inline.index); key = 'OPTIONS'; out.OPTIONS = m[2].slice(inline.index + inline[0].length); }
    }
    else out[key] = key in out ? out[key] + '\n' + line : line;
  }
  for (const k of Object.keys(out)) { out[k] = out[k].trim(); if (!out[k]) delete out[k]; }
  return out;
}

/**
 * A worker with an unfinished task, no open ask and no permission card that wrote nothing to its transcript for this long
 * is stuck (native.ts). It is longer than the longest ScheduleWakeup (3600 s), so a babysitter on an hourly loop is not
 * called stuck. Worker 579 (2026-11-11) sat 8 hours on a WAITING line for a helper session that never ran.
 */
export const STALL_MS = 75 * 60_000;

/** The brief's rule against a wait that never ends. Worker 579 waited all night on a throwaway session stuck at the folder trust question. */
export const WAIT_RULE = `

## Waits that end
Never wait without a time limit on something you started yourself: a helper Claude session, a server, a terminal or a background command.
- Give every wait loop its own limit, for example \`timeout 300\` in front of the loop, or a count of tries. The Bash timeout does not stop a command that runs in the background.
- A helper Claude session started in a new folder stops at the folder trust question and does nothing. Start it in your own worktree, or answer that question.
- When the limit passes, read the helper's output. Fix it, or prove the step another way, and continue with the rest of the task. If you cannot, report FAILED with the reason.
- A \`WAITING:\` line must name a thing that ends by itself and starts your next turn: a background task with a limit, a scheduled wake-up, or an answer from jarvis-brain.
Jarvis tells the brain about a worker with an unfinished task that writes nothing for ${STALL_MS / 60_000} minutes.`;

// The rules every worker gets.
/** What gate.ts appends to every background worker's brief. */
export const NATIVE_FOOTER = `

## You are a Jarvis worker
You are a Claude Code session started by Jarvis, ${OWNER}'s assistant. Your coordinator is the Claude Code session named \`jarvis-brain\`; reach it with SendMessage (ListAgents shows it). AskUserQuestion is blocked.

Ask only what needs a human decision, with SendMessage to jarvis-brain, in this shape:
STORY: <number and topic, at most 8 words>
WHERE: <what you are doing, one or two short sentences>
QUESTION: <one sentence>
CONTEXT: <optional, at most 3 sentences>
REPORT: <optional, the absolute path of the .md report in ${REPORTS_DIR} that the decision rests on>
OPTIONS: recommended first, at most 3, each "<choice> because <reason under 10 words>"
Then end your turn. The answer arrives as a message from jarvis-brain or jarvis-brain-relay (${OWNER}'s words, carried by jarvisd) and starts a new turn.
An ask must have OPTIONS. Jarvis sends an ask with no options back to you, and ${OWNER} does not see it.
If you wrote a report that ${OWNER} must read before he decides, give its path on the REPORT line, not only in CONTEXT. The card then shows a button that opens the report.
On a story, a decision you find after coding starts is an ask: send it and end your turn.

A notice is not a question. A notice tells ${OWNER} a status and asks nothing, for example "the switch starts now, jarvisd restarts in 1 minute". Send a notice only if ${OWNER} must know it now. Start it with \`NOTICE: <one sentence>\` and do not use the ask fields. Jarvis shows it as a status line, with nothing to answer, and no answer comes back. Do not wait for one.

When the work is finished, your last message of the final turn must start with a line \`DONE: <one sentence>\` (or \`FAILED: <one sentence>\`), followed by the report: what changed, the branch and commit, the PR link if any, what was not proven. That exact text reaches ${OWNER} word for word.
If you end a turn before the work is finished, because you wait for a background task or an answer, start your last message with \`WAITING: <what you wait for>\`.

If a permission prompt appears, wait; ${OWNER} answers it from his app. If the permission layer refuses a command, do not retry or route around it; say so in your report.

Before each batch of tool calls, write one plain sentence saying what you are about to do.`;

/**
 * Story workers may file issues for real findings outside their task, through the repo's create-issue skill only. That
 * kept the story 3202 worker from dropping the three bugs it proved. Read-only workers, side chats and Today tasks do not get it.
 */
export const ISSUE_RULE = `

## Filing issues
One exception to not posting on GitHub: if this repo has a \`create-issue\` skill (\`.claude/skills/create-issue\`), you may file a GitHub issue for a real finding outside your task's scope, but only by invoking that skill and following it: its duplicate and already-shipped search, the tier, the P and type labels, the template sections and the \`**Tier:**\` line. Never a hand-rolled \`gh issue create\`. Skip its confirmation step, with these limits. Priority P2 or P3 only, never P0 or P1; say in the body why it might deserve more. When the search finds a live issue, comment on it instead of filing. List every issue you filed or commented on, by number, in your worker_done body. Without that skill, file nothing and put the findings in your report.`;

/**
 * Appended to every worker spec, after the footer. The owner reads asks, escalations and reports on his phone, and a card
 * with one dense paragraph does not get read (his call, 2026-11-06). The app draws these fields under fixed headings.
 */
export const CARD_RULE = `

## How ${OWNER} reads your text
${OWNER_CAP} reads your asks, escalations and final report as cards on his phone. Each card must read in seconds. Follow the asd-ste100 skill (\`~/.claude/skills/asd-ste100/SKILL.md\`): STE-flavored mode for sentences, Strict mode for option choices.

An ask or an escalation uses the fields above. The card shows them under headings, in this order:
1. STORY is the title line: the story number and the topic.
2. WHERE is "What the worker is doing": one or two short sentences.
3. QUESTION is "The question": one sentence, at most 25 words.
4. OPTIONS: recommended first. Each choice is at most 5 words. Its reason says what that choice changes, in under 10 words.
5. CONTEXT goes behind a More toggle. Put long detail, numbers and links there, not in QUESTION or WHERE.

${OWNER_CAP} reads each ask cold, with no help from the brain. Write it for a person who did not see your code:
- Start with the problem as the dealer or the seller sees it, in plain words, in WHERE and QUESTION.
- Use no code words in QUESTION, CONTEXT or OPTIONS: no identifiers, file paths, file names, line numbers, column names, scope strings, enum values, backticks or internal labels such as "bucket C".
- If you need a term, explain it in a few words. Write "the listing page that the widget reads", not "census card".
- Each option says what it changes for the dealer, the seller or the PR, and the fact it rests on.
- PR and issue links, PR and issue numbers, stock numbers and the word VIN are allowed.
Jarvis sends an ask with code words back to you, with the words it found, and ${OWNER} does not see it.

A bad ask (story 5600): "The widget files it as a bucket C failure, so it opens a P1 issue." with the option "Move to A, file queue fix because seller fixes it". ${OWNER_CAP} cannot tell what bucket C or A is, or what changes for the seller.
A good ask for the same story: "Facebook refused a listing because the same car is already live on the account. The widget reports this as a bug and opens an urgent issue. Should the widget tell the seller instead?" with the options "Tell the seller because no false urgent issue, seller removes the old ad" and "Close, no code because the refusal already protects the account".

Your final report has this shape:
- The first line: \`DONE: <the result in one sentence>\` or \`FAILED: <one sentence>\`. If your task gives an exact first line, use that line.
- Then at most 6 short bullets: what changed, the branch and commit, the PR link, what is not proven.
- Then long detail, if any, under \`## Details\` or other \`##\` headings. The app folds each heading.

Use active voice and simple tenses. Write one idea per sentence. Do not use semicolons.`;

// Task texts for the workers Jarvis starts on its own.
/** A read-only question worker's task. `done` is how it reports. */
export const questionSpec = (question: string, done: string) => `Read-only research for ${OWNER}. Do not edit, create or delete files, do not commit, do not open or change PRs or issues, do not run anything that changes state.\n\nQuestion: ${question}\n\nUse the repo's own CLAUDE.md and skills. Then ${done} with a summary of at most 4 short sentences that can be read aloud, and put any detail (file paths, links) after a blank line in the same summary.`;
/** A side chat: a normal working session the owner talks to in the app. It ends with a DONE line, and asks nothing. */
export const nativeSideChatSpec = (text: string) => `Side chat with ${OWNER}. He started it from the Jarvis app to talk with you directly, apart from his main Jarvis conversation. This is a normal working session: read, edit, run and commit what he asks for.

He reads and answers you in this conversation from the Jarvis app, so talk to him here, in plain replies; every message of his arrives as a message from another session. Do not ask jarvis-brain anything. When ${OWNER} says he is done, end with a line starting DONE: and a one-sentence summary; until then, never write DONE or FAILED.

${text.trim() ? `His first message:

${text}` : 'He has not written yet. Reply with one short line saying you are ready and where you are working (the folder, and the branch if it is a worktree), then wait for his first message.'}`;

// What a worker gets back from Jarvis.
/**
 * The Stop hook's `decision: block` reason for a turn that ended with no DONE, FAILED or WAITING line, no ask to the brain
 * and no background task or scheduled wake-up: Claude Code sends the worker straight back with these words (proven live
 * on 2.1.316, 2026-11-09: the next message came about one second later). Given once per turn; the next stop is final.
 */
export const REPORT_NUDGE = `Jarvis got no report from this turn. Your last message does not start with a DONE: or FAILED: line, so ${OWNER} sees nothing. Do one of these now. Do not do the work again.
- The task is finished: write your final message again. Its first line is \`DONE: <one sentence>\` (or \`FAILED: <one sentence>\`), then the report.
- You wait for a background task or for an answer: write one line that starts with \`WAITING:\` and says what you wait for. Then end your turn.
- You need a decision from ${OWNER}: ask jarvis-brain with SendMessage in the ask format. Then end your turn.`;

/** Sent back to a worker whose ask has no options. Nothing reached the owner. */
export const NO_OPTIONS_REFUSAL = `Jarvis did not show this message to ${OWNER}. It reads as a question, but it has no options.
If you need a decision, send it again with an OPTIONS line: recommended first, at most 3, each "<choice> because <reason under 10 words>".
If it is only a status update, start it with \`NOTICE:\` and ask nothing. It then shows as a status line, with nothing to answer.`;

/** Sent back to a worker whose ask has code words (askCodeWords). Nothing reached the owner. */
export const codeWordsRefusal = (words: string[]) => `Jarvis did not show this ask to ${OWNER}. It has code words that he cannot read cold: ${words.slice(0, 8).join(', ')}.
Send it again in plain words: the problem as the dealer or the seller sees it, each term explained in a few words, and for each option what it changes for the dealer, the seller or the PR. Links and PR, issue and stock numbers are allowed.`;

// Finding code words in an ask.
const FILE_EXT = /\.(?:tsx?|jsx?|mjs|cjs|py|rb|go|rs|java|kt|swift|php|sql|sh|json|ya?ml|toml|css|scss|html|md|lock)(?::\d+(?::\d+)?)?$/i;
// Product names that look like file names or camelCase identifiers.
const NAME_OK = /^(?:(?:node|next|vue|nuxt|three|express)\.js|iPhone|iPad|iOS|macOS|iCloud|iMessage|eBay)$/i;
// The punctuation a word can carry in prose, stripped before the word is judged.
const EDGE = /^[\s"'«»“”‘’(\[{<.,;:!?*_-]+|[\s"'«»“”‘’()\[\]{}<>.,;:!?*_-]+$/g;
// A report in data/reports: the card opens it, so it is not a code word.
const REPORT_PATH = /^\/\S*\/data\/reports\/\S+\.md$/;
// A lone capital letter after a lower-case word: "bucket C", "move to A".
const LETTER_LABEL = /(?<![\p{L}\p{N}])(\p{Ll}+) ([A-Z])(?![\p{L}\p{N}'’-])/gu;

/**
 * The code words of a plain text, each once, in the order found. A code word is backticked text, a file name (.ts,
 * .tsx, .py and the like, with or without :line), a file path (it starts with / or ~/, or has two slashes), a scope with
 * a colon such as marketplace_settings:read, a snake_case or camelCase identifier, or a one-letter label after a
 * lower-case word ("bucket C"). Links, PR and issue numbers, stock numbers such as R1831, VIN, accented words,
 * "a"/"A"/"I" as words and a report path in data/reports are not.
 */
export function codeWords(text: string): string[] {
  const found: string[] = [];
  const add = (w: string) => { if (!found.includes(w)) found.push(w); };
  let rest = text.replace(/`([^`\n]+)`/g, (_, inner: string) => { add('`' + inner + '`'); return ' '; });
  rest = rest.replace(/\b(?:https?:\/\/|www\.)\S+/gi, ' ');
  for (const m of rest.matchAll(LETTER_LABEL)) {
    const after = rest.slice(m.index! + m[0].length);
    // "I" is a word, and "A" before a lower-case word is the article ("to A user" is rare, "a user" is not).
    if (m[2] === 'I' || (m[2] === 'A' && /^ \p{Ll}/u.test(after))) continue;
    add(`${m[1]} ${m[2]}`);
  }
  for (const raw of rest.split(/\s+/)) {
    const w = raw.replace(EDGE, '');
    if (!w || NAME_OK.test(w) || REPORT_PATH.test(w)) continue;
    const ascii = /^[\w./~:-]+$/.test(w);
    if (ascii && FILE_EXT.test(w) && /[\w-]\.\w/.test(w)) add(w);
    else if (ascii && w.includes('/') && (/^~?\//.test(w) || (w.match(/\//g) ?? []).length >= 2) && /[a-z]/i.test(w)) add(w);
    else if (/^[a-z][\w*-]*:[a-z][\w*-]*$/i.test(w)) add(w);
    else if (/\p{L}[\p{L}\p{N}]*_[\p{L}\p{N}]/u.test(w)) add(w);
    else if (/^[a-z]+[A-Z][A-Za-z0-9]*$/.test(w)) add(w);
  }
  return found;
}

/**
 * The code words in an ask's QUESTION, CONTEXT and OPTIONS, or in its whole text when it has no QUESTION field. The
 * owner reads asks cold on his phone, and workers wrote them for themselves: "bucket C", min_photos.new,
 * components/leads/MyLeadsToggle.tsx:20 (asks 840 to 847, 2026-11-13). nativeroutes.ts sends an ask with any back.
 */
export function askCodeWords(body: string): string[] {
  const f = fields(body);
  return codeWords(f.QUESTION === undefined ? body : [f.QUESTION, f.CONTEXT, f.OPTIONS].filter(Boolean).join('\n'));
}

// Reading a worker's replies.
/** An absolute path to a .md file in a data/reports folder, anywhere in a text. */
const REPORT_DOC = /(?:^|[\s(`<[:])(\/[^\s`'"()<>[\]]*\/data\/reports\/[^\s`'"()<>[\]]+?\.md)(?=$|[\s`'"()<>[\].,;:!?])/im;

/**
 * The report an ask names on its REPORT line: one absolute path to a .md file, bare, in backticks or in a
 * `[report: ...]` marker. Undefined when the ask has no REPORT line or the line is not such a path. Whether the file is
 * really in data/reports is the daemon's check (reports.ts reportFile).
 */
export function askReportPath(body: string): string | undefined {
  const line = (fields(body).REPORT ?? '').split('\n')[0].trim();
  const path = line.replace(/^\[report:\s*(.*?)\s*\]$/i, '$1').replace(/^`(.*)`$/, '$1').replace(/^<(.*)>$/, '$1').trim();
  return /^\/\S*\.md$/i.test(path) ? path : undefined;
}

/** The first data/reports .md path a worker's text names (a DONE report, an ask's CONTEXT), or undefined. */
export const reportPathIn = (text: string | null | undefined): string | undefined => REPORT_DOC.exec(text ?? '')?.[1];
/** A turn that ends on purpose before the work is done starts its last message with this: it waits for something. */
export const WAITING_LINE = /^\s*WAITING\s*:/i;

/** done or failed when a report opens with DONE or FAILED as a word. */
export const outcomeOf = (report: string): 'done' | 'failed' | null => {
  const m = report.match(/^\s*(DONE|FAILED)\b/i);
  return m ? (m[1].toUpperCase() === 'DONE' ? 'done' : 'failed') : null;
};

/** A notice's text on one line without its `NOTICE:` label, for the worker's pane and the chat. */
export const noticeLine = (text: string) => text.trim().replace(/^notice\s*:\s*/i, '').replace(/\s+/g, ' ').slice(0, 300);

const REPORT_LINE = new RegExp(`^\\s*(${REPORT_LABELS.join('|')})\\s*:\\s*(.*)`, 'i');

/**
 * A worker's message read as a report. `label` is its first line's DONE, FAILED, WAITING or NOTICE label (the colon is
 * needed), and `line` the rest of that line. `outcome` is done or failed when the message opens with DONE or FAILED as a
 * word, with or without the colon, as the work list has always read it.
 */
export function readReport(text: string): { label: ReportLabel | null; line: string; outcome: 'done' | 'failed' | null } {
  const m = REPORT_LINE.exec(text);
  return { label: m ? m[1].toUpperCase() as ReportLabel : null, line: m ? m[2].trim() : '', outcome: outcomeOf(text) };
}

/** The rules appended to a worker's task. `issues` adds the create-issue exception, for story workers only. */
export function workerBrief(o: { issues?: boolean } = {}): string {
  return (o.issues ? ISSUE_RULE : '') + NATIVE_FOOTER + WAIT_RULE + CARD_RULE;
}

/** The advisor a story worker runs with, as Claude Code's `advisorModel` setting. Every other worker Jarvis starts runs
 *  with the advisor off, so only stories pay for it. Simon asked for this on 2026-11-11. */
export const STORY_ADVISOR = 'fable';
/** Whether a worker start runs a story: a Today story or the brain's worker-start, with a spec that names a pick-and-ship
 *  skill (storyStartSpec writes `Run the pick-and-ship-v3 skill on issue #<n>`; the brain may write `Run pick-and-ship
 *  on issue #<n>`). A plain Today task is not a story. */
export const isStoryStart = (action: string, spec: string): boolean =>
  (action === 'today-start' || action === 'worker-start') && /\bpick-and-ship(?:-v\d+)?\b/.test(spec);
