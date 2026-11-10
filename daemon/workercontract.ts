// The worker contract: every rule Jarvis writes into a worker's brief, and the parsers that read the worker's replies
// back. The labels are defined once here, so the brief and its parser cannot drift apart. workercontract.test.ts writes
// an ask and a report in the shape each brief describes and checks that they read back.
import { OWNER, OWNER_CAP, PRODUCT_LABEL } from './config.ts';

/** The labeled fields of an ask. The parser also takes FAILED and PROPOSES (with PROPOSAL and PROPOSE) on escalations. */
export const ASK_FIELDS = ['STORY', 'WHERE', 'QUESTION', 'CONTEXT', 'IMAGE', 'OPTIONS'] as const;
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
OPTIONS: recommended first, at most 3, each "<choice> because <reason under 10 words>"
Then end your turn. The answer arrives as a message from jarvis-brain or jarvis-brain-relay (${OWNER}'s words, carried by jarvisd) and starts a new turn.
An ask must have OPTIONS. Jarvis sends an ask with no options back to you, and ${OWNER} does not see it.

A notice is not a question. A notice tells ${OWNER} a status and asks nothing, for example "the switch starts now, jarvisd restarts in 1 minute". Send a notice only if ${OWNER} must know it now. Start it with \`NOTICE: <one sentence>\` and do not use the ask fields. Jarvis shows it as a status line, with nothing to answer, and no answer comes back. Do not wait for one.

When the work is finished, your last message of the final turn must start with a line \`DONE: <one sentence>\` (or \`FAILED: <one sentence>\`), followed by the report: what changed, the branch and commit, the PR link if any, what was not proven. That exact text reaches ${OWNER} word for word.
If you end a turn before the work is finished, because you wait for a background task or an answer, start your last message with \`WAITING: <what you wait for>\`.

If a permission prompt appears, wait; ${OWNER} answers it from his app. If the permission layer refuses a command, do not retry or route around it; say so in your report.

Before each batch of tool calls, write one plain sentence saying what you are about to do.`;

/** Appended to every worker spec Jarvis dispatches, so asks arrive short enough to speak. */
export const ASK_FOOTER = `

## Asking the coordinator
Your coordinator is Jarvis, who reads your questions aloud to ${OWNER}. Ask only what needs a human decision. Phrase every \`orca orchestration ask\` exactly as:
STORY: <number and topic, at most 8 words>
WHERE: <what you are doing, one or two short sentences>
QUESTION: <one sentence>
CONTEXT: <optional, at most 3 sentences>
IMAGE: <optional, one absolute path to a .png .jpg .jpeg .webp or .gif>
OPTIONS: recommended first, at most 3, each "<choice> because <reason under 10 words>"
Pass the short choices in one --options flag, separated by commas: --options "Merged,Not yet". Do not repeat the flag, because Orca keeps only the last one. Orca splits on every comma, so write each choice without one. For anything visual, put a screenshot path in IMAGE (under the repo's docs/screens or data/uploads, ~/Desktop, ~/Downloads or ~/orca/workspaces) or a link in CONTEXT. ${OWNER_CAP} sees the picture on the ask card in the app.

If Claude Code's permission layer refuses a command, do not retry it or route around it: a retry hits the same refusal. Escalate, say the permission layer refused it, and quote the whole command. Jarvis itself can run two on ${OWNER}'s Approve tap, and his card offers them when your words give every value: \`gh pr close <number> --repo <owner/name> --comment "<why>"\` and, from the FBM repo, \`node functions/scripts/reusable/pause-client.js --client <id> --hours <hours>\`. It can also run one production ${PRODUCT_LABEL} MCP call on his tap: quote the exact tool name and the whole arguments JSON.

Before each batch of tool calls, write one plain sentence saying what you are about to do. ${OWNER_CAP} reads your conversation as a chat.`;

/**
 * Orca's own brief tells every worker "Don't post to Slack, GitHub, or other channels during the run", and Orca is not
 * modified. That line kept the story 3202 worker from filing the three bugs it proved, though pick-and-ship-v3 tells it to.
 * Story workers get this exception in their task; read-only workers, side chats and Today tasks do not.
 */
export const ISSUE_RULE = `

## Filing issues
The Orca brief above says not to post to GitHub. One exception: if this repo has a \`create-issue\` skill (\`.claude/skills/create-issue\`), you may file a GitHub issue for a real finding outside your task's scope, but only by invoking that skill and following it: its duplicate and already-shipped search, the tier, the P and type labels, the template sections and the \`**Tier:**\` line. Never a hand-rolled \`gh issue create\`. Skip its confirmation step, with these limits. Priority P2 or P3 only, never P0 or P1; say in the body why it might deserve more. When the search finds a live issue, comment on it instead of filing. List every issue you filed or commented on, by number, in your worker_done body. Without that skill, file nothing and put the findings in your report.`;

/** The issue rule for a worker that got no Orca brief. */
export const NATIVE_ISSUE_RULE = ISSUE_RULE.replace('The Orca brief above says not to post to GitHub. One exception: if', 'One exception to not posting on GitHub: if');

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
5. CONTEXT goes behind a More toggle. Put long detail, numbers, paths and links there, not in QUESTION or WHERE.

Your final report has this shape:
- The first line: \`DONE: <the result in one sentence>\` or \`FAILED: <one sentence>\`. If your task gives an exact first line, use that line.
- Then at most 6 short bullets: what changed, the branch and commit, the PR link, what is not proven.
- Then long detail, if any, under \`## Details\` or other \`##\` headings. The app folds each heading.

Use active voice and simple tenses. Write one idea per sentence. Do not use semicolons.`;

// Task texts for the workers Jarvis starts on its own.
/** A read-only question worker's task. `done` is how it reports: Orca's worker_done, or the native DONE line. */
export const questionSpec = (question: string, done: string) => `Read-only research for ${OWNER}. Do not edit, create or delete files, do not commit, do not open or change PRs or issues, do not run anything that changes state.\n\nQuestion: ${question}\n\nUse the repo's own CLAUDE.md and skills. Then ${done} with a summary of at most 4 short sentences that can be read aloud, and put any detail (file paths, links) after a blank line in the same summary.`;
/** A native side chat: the same session as the Orca one, but it ends with a DONE line instead of worker_done, and asks nothing. */
export const nativeSideChatSpec = (text: string) => `Side chat with ${OWNER}. He started it from the Jarvis app to talk with you directly, apart from his main Jarvis conversation. This is a normal working session: read, edit, run and commit what he asks for.

He reads and answers you in this conversation from the Jarvis app, so talk to him here, in plain replies; every message of his arrives as a message from another session. Do not ask jarvis-brain anything. When ${OWNER} says he is done, end with a line starting DONE: and a one-sentence summary; until then, never write DONE or FAILED.

${text.trim() ? `His first message:

${text}` : 'He has not written yet. Reply with one short line saying you are ready and where you are working (the folder, and the branch if it is a worktree), then wait for his first message.'}`;

/** A side chat is a normal working session that the owner talks to in the app or in Orca, outside the Jarvis conversation. */
export const sideChatSpec = (text: string) => `Side chat with ${OWNER}. He started it from the Jarvis app to talk with you directly, apart from his main Jarvis conversation. This is a normal working session: read, edit, run and commit what he asks for.

He reads and answers you in this conversation, from the Jarvis app or from Orca, so talk to him here. Do not use \`orca orchestration ask\`, and do not send worker_done on your own. When ${OWNER} says he is done, send worker_done with a one-sentence summary.

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

// Reading a worker's replies.
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

/** Which worker gets the brief: a native Claude Code session, or an Orca worker. */
export type WorkerKind = 'native' | 'orca';

/**
 * The rules appended to a worker's task. `issues` adds the create-issue exception, for story workers only. The native
 * brief names jarvis-brain and SendMessage. The Orca brief names `orca orchestration ask` and worker_done.
 */
export function workerBrief(kind: WorkerKind, o: { issues?: boolean } = {}): string {
  return kind === 'native' ? (o.issues ? NATIVE_ISSUE_RULE : '') + NATIVE_FOOTER + CARD_RULE
    : (o.issues ? ISSUE_RULE : '') + ASK_FOOTER + CARD_RULE;
}
