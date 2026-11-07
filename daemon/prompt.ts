import type { OrcaResult } from './orca.ts';

// Orca's stop notices (`msg_stop_` escalations) are a template wrapped around the worker's raw terminal output. This reads
// them, and reads a terminal's current screen the same way, so a card can say what the worker wants, offer the real
// options, and tell whether the worker is still at that prompt.

export type PromptOption = {
  /** The key that picks this option in the terminal. */
  key: string; label: string; detail?: string;
};
export type TerminalPrompt = {
  /** One sentence on what it asks, taken from the prompt's own words. */
  summary: string;
  /** The command or tool it wants to run, trimmed. */
  command?: string;
  /** The command as far as the output shows it, untrimmed, with its real line breaks. */
  full?: string;
  /** The start of `full` scrolled out of the output Orca sent. */
  clipped?: boolean;
  /** `command` names a tool, not a shell command. */
  tool?: boolean;
  /** Everything the prompt said about why it stopped, not only its first sentence. */
  said?: string;
  /** The menu asks permission for an action ("Do you want to proceed?"), so Yes and No mean run it or do not. */
  permission?: boolean;
  options: PromptOption[];
  /** What tells this prompt from another with the same options: its reason and the end of its command, without spaces. */
  marks: string[];
};
export type StopNotice = {
  kind: 'prompt' | 'stopped' | 'other';
  terminal?: string; task?: string;
  /** The terminal output with Orca's template taken off and the noise cleaned. */
  output: string;
  prompt?: TerminalPrompt;
};
type Orca = (args: string[]) => Promise<OrcaResult>;
/** What the worker's own log adds to a prompt: the whole command, its one-line description, and what the worker last said. */
export type PromptContext = { command?: string; description?: string; said?: string };

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-Z\\-_]/g;
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;
const BOX = /[─-╿]/;
const RULE = /^[\s─-╿]*[─-╿]{3,}[\s─-╿]*$/;
const OPTION = /^(❯\s*)?(\d)\.\s+(\S.*)$/;
const HINT = /^(esc to|enter to|tab to|ctrl[+-]|↑|←|→)/i;
const GENERIC_QUESTION = /^do you want to proceed\??$/i;
const NOISE = /^⚠|^tip:|ctrl\+|settings\.json to update hooks|^session$/i;
const PERMISSION_QUESTION = /^do you want to /i;
const COMMAND_MAX = 160;
/** A long command can scroll off a terminal's screen, so only its end has to be there. */
const MARK_MAX = 200;
/** A label this long may have wrapped, and a button should stay readable. */
const LABEL_WRAPS_AT = 70, LABEL_MAX = 90;

/** Terminal lines as text: no colour codes or control bytes. `boxed` lines were drawn inside a frame. */
type Line = { text: string; boxed: boolean; rule: boolean; indent: number; width: number };
function lines(output: string | string[]): Line[] {
  const raw = Array.isArray(output) ? output : output.split(/\r\n?|\n/);
  return raw.map(l => {
    const s = l.replace(ANSI, '').replace(CONTROL, '');
    const body = s.replace(/^[\s─-╿]+/, '').replace(/[\s─-╿]+$/, '');
    return { text: body, boxed: BOX.test(s) && !RULE.test(s), rule: RULE.test(s), indent: s.length - s.trimStart().length, width: s.trim().length };
  });
}

/** The words of a terminal's output, without colour codes, frames or rule lines. */
export const cleanOutput = (output: string): string =>
  lines(output).filter(l => !l.rule).map(l => l.text).join('\n').replace(/\n{3,}/g, '\n\n').trim();

/** The menu's options around its cursor, or undefined when this is not a menu a key can answer. */
function menu(all: Line[]): { first: number; options: PromptOption[] } | undefined {
  let cursor = all.length - 1;
  while (cursor >= 0 && !/^❯/.test(OPTION.exec(all[cursor].text)?.[0] ?? '')) cursor--;
  if (cursor < 0) return undefined;
  // Up to option 1: the cursor may have been moved down.
  let first = cursor;
  while (OPTION.exec(all[first].text)?.[2] !== '1') {
    first--;
    if (first < 0 || cursor - first > 20 || all[first].rule) return undefined;
  }
  const options: PromptOption[] = [];
  for (let n = first; n < all.length; n++) {
    const l = all[n];
    const m = OPTION.exec(l.text);
    if (m && Number(m[2]) === options.length + 1) { options.push({ key: m[2], label: m[3].trim() }); continue; }
    if (!l.text) continue;
    if (l.rule || l.boxed || HINT.test(l.text) || l.indent === 0) break;
    if (m) return undefined; // numbered out of order, so not one menu
    const last = options[options.length - 1];
    if (!last.detail && last.label.length >= LABEL_WRAPS_AT) last.label += l.text; // the terminal wrapped it, often mid-word
    else last.detail = last.detail ? `${last.detail} ${l.text}` : l.text;
  }
  if (options.length < 2 || options.some(o => /^\[[ x✓✔]?\]/i.test(o.label))) return undefined;
  for (const o of options) {
    // "Yes, and switch to auto mode · auto mode handles these prompts for you"
    const dot = o.label.indexOf(' · ');
    if (dot > 0) { o.detail = o.detail ?? o.label.slice(dot + 3); o.label = o.label.slice(0, dot); }
    if (o.label.length > LABEL_MAX) o.label = `${o.label.slice(0, LABEL_MAX - 1).trimEnd()}…`;
  }
  return { first, options };
}

/** Long commands keep their end, which is what runs last and is usually what the prompt is about. */
function trimCommand(c: string, clipped: boolean): string {
  const s = c.replace(/\s+/g, ' ').trim();
  if (s.length <= COMMAND_MAX) return clipped ? `… ${s}` : s;
  return clipped ? `… ${s.slice(-COMMAND_MAX)}` : `${s.slice(0, 40)} … ${s.slice(-(COMMAND_MAX - 40))}`;
}

/**
 * A framed command's lines with the terminal's wrapping undone. A line break is a wrap only when the next word could not
 * have fit on the row, so two real commands on two short lines stay two commands.
 */
function unwrap(rows: string[], width: number): string {
  let out = rows[0] ?? '';
  for (let n = 1; n < rows.length; n++) {
    const before = rows[n - 1], row = rows[n], word = row.split(/\s/)[0];
    out += before.length >= width ? row : before.length + 1 + word.length > width ? ` ${row}` : `\n${row}`;
  }
  return out;
}

const firstSentence = (s: string) => /^.*?[.!?](?=\s|$)/.exec(s)?.[0] ?? s;
export const compact = (s: string) => s.replace(/[\s─-╿]+/g, '');

/** The open menu in terminal output, read from its bottom up, or undefined when no menu with a cursor is showing. */
export function readPrompt(output: string | string[]): TerminalPrompt | undefined {
  const all = lines(output);
  const found = menu(all);
  if (!found) return undefined;
  const { first, options } = found;

  // The question sits right above the options, wrapped onto two lines at most.
  let q = first - 1;
  while (q >= 0 && !all[q].text && !all[q].rule) q--;
  let question = '';
  let above = first;
  if (q >= 0 && /\?$/.test(all[q].text)) {
    question = all[q].text;
    above = q;
    if (q > 0 && /^[a-z]/.test(question) && all[q - 1].text && !all[q - 1].rule) { question = `${all[q - 1].text} ${question}`; above = q - 1; }
  }
  const context = all.slice(0, above);
  const texts = context.map(l => l.text);

  let command: string | undefined, whole = '', reason = '', full: string | undefined, said = '';
  const bash = texts.lastIndexOf('Bash command');
  const about = context.findLastIndex(l => /^About the .+ Tool:$/.test(l.text));
  const rule = context.findLastIndex(l => l.rule);
  const hook = context.findLastIndex(l => /requires confirmation for this command:?$/.test(l.text));
  const auto = context.findLastIndex(l => /needs your confirmation/.test(l.text));
  // The command sits in a frame of boxed lines that ends in a dashed rule, right above the question or above a hook's text.
  let top = rule;
  while (top > 0 && context[top - 1].boxed) top--;
  const framed = rule > 0 && top < rule;
  const framedLast = framed && context.slice(rule + 1).every(l => !l.text);
  const words = (hook >= 0 || !framedLast ? context : context.slice(0, top)).filter(l => l.text && !l.rule && !NOISE.test(l.text) && l.text !== 'Bash command');
  const lastWords = words.at(-1)?.text ?? '';

  if (hook >= 0) {
    said = context.slice(hook + 1).map(l => l.text).filter(t => t && !NOISE.test(t)).join(' ');
    reason = firstSentence(said);
  } else if (auto >= 0) {
    said = context.slice(about >= 0 ? about : auto).filter(l => l.text && !l.rule && !NOISE.test(l.text)).map(l => l.text).join(' ');
    reason = context[auto].text;
    const blocked = texts.findLast(t => /^Latest blocked action:/.test(t))?.replace(/^Latest blocked action:\s*\[?(.*?)\]?$/, '$1');
    if (blocked) reason += ` Blocked as: ${blocked}.`;
  } else if (GENERIC_QUESTION.test(question)) reason = lastWords;

  if (framed) {
    // Only the output's tail reaches us, so without its header the command's start may be cut.
    whole = context.slice(top, rule).map(l => l.text).join(' ');
    command = trimCommand(whole, bash < 0);
    // The rule spans the frame; the text sits inside its " │ " margin.
    full = unwrap(context.slice(top, rule).map(l => l.text), context[rule].width - 3);
  } else if (bash >= 0) {
    // After the header: the command, then a line that says in words what it does.
    const body = context.slice(bash + 1).filter(l => l.text && !l.rule && !NOISE.test(l.text)).map(l => l.text);
    if (body.length > 1 && reason === lastWords) body.pop();
    whole = body.join(' ');
    if (body.length) { command = trimCommand(whole, false); full = body.join('\n'); }
  } else if (about >= 0) { whole = command = /^About the (.+) Tool:$/.exec(context[about].text)![1]; full = whole; }

  if (reason && !/[.!?]$/.test(reason)) reason += '.';
  const marks = [compact(firstSentence(reason)).replace(/\.$/, ''), compact(whole).slice(-MARK_MAX)].filter(Boolean);
  return {
    summary: [reason, question].filter(Boolean).join(' ') || 'It is waiting for your answer at a prompt.',
    ...(command ? { command } : {}), ...(full ? { full } : {}),
    ...(framed && bash < 0 ? { clipped: true } : {}), ...(!framed && bash < 0 && about >= 0 ? { tool: true } : {}),
    ...(said ? { said } : {}), ...(PERMISSION_QUESTION.test(question) ? { permission: true } : {}),
    options, marks: marks.length ? marks : [compact(question)],
  };
}

/** Takes Orca's template off a stop notice's body. */
export function readStopNotice(body: string | null): StopNotice {
  const text = (body ?? '').replace(/\r\n?/g, '\n');
  const head = /^Worker (\S+) (is stopped at a prompt|ended its turn without sending worker_done)[^\n]*?task "(.*)" \(task_\w+\)\.[ \t]*$/m.exec(text);
  const last = /^Last output:[ \t]*\n/m.exec(text);
  if (!head || !last) {
    const rest = text.split('\n').filter(l => !/^The Dispatch is still open\.|^Full output: orchestration worker-read|^Last output:/.test(l)).join('\n');
    return { kind: 'other', output: cleanOutput(rest) };
  }
  const raw = text.slice(last.index + last[0].length).replace(/\n?Full output: orchestration worker-read[^\n]*\s*$/, '');
  const notice: StopNotice = { kind: head[2].startsWith('is stopped') ? 'prompt' : 'stopped', terminal: head[1], task: head[3], output: raw };
  if (notice.kind === 'prompt') {
    const prompt = readPrompt(raw);
    if (prompt) notice.prompt = prompt;
  }
  notice.output = cleanOutput(raw);
  return notice;
}

/** What makes two notices the same prompt. A notice with no menu in it has an empty key. */
export const promptKey = (body: string | null): string => readStopNotice(body).prompt?.marks.join('\n') ?? '';

/** True when these lines show this same prompt, menu open: its words remain in the scrollback after it is answered. */
export function stillAt(prompt: TerminalPrompt, screen: string | string[]): boolean {
  const now = readPrompt(screen);
  if (!now || now.options.length !== prompt.options.length) return false;
  // A narrower terminal can cut a long label, so compare as far as the shorter one goes.
  const same = (a: string, b: string) => { const x = compact(a).replace(/…$/, ''), y = compact(b).replace(/…$/, ''); return x.startsWith(y) || y.startsWith(x); };
  if (!now.options.every((o, n) => same(o.label, prompt.options[n].label))) return false;
  const shown = compact(lines(screen).map(l => l.text).join(''));
  return prompt.marks.every(m => shown.includes(m));
}

/** The terminal's current frame and whether it still runs, or undefined when Orca did not show one. */
export async function readScreen(orca: Orca, terminal: string): Promise<{ tail: string[]; exited: boolean } | undefined> {
  const r = await orca(['terminal', 'read', '--terminal', terminal, '--screen']).catch(() => undefined);
  const t = r?.ok ? r.result?.terminal : undefined;
  if (!t || !Array.isArray(t.tail) || t.source === 'screen-unavailable' || t.source === 'stream') return undefined;
  return { tail: t.tail, exited: t.status === 'exited' };
}

/**
 * Open prompt notices whose worker has left that prompt. Only a screen Orca showed counts: when it cannot show one
 * (a chat tab, no answer), the notice stays for the rules in work.ts. A tap going out is left to finish.
 */
export async function gonePromptNotices(open: { external_id: string; kind: string; status: string; body: string | null }[], orca: Orca): Promise<string[]> {
  const gone: string[] = [];
  for (const i of open) {
    if (i.kind !== 'escalation' || !i.external_id.startsWith('msg_stop_') || i.status === 'replying') continue;
    const n = readStopNotice(i.body);
    if (!n.prompt || !n.terminal) continue;
    const screen = await readScreen(orca, n.terminal);
    if (screen && (screen.exited || !stillAt(n.prompt, screen.tail))) gone.push(i.external_id);
  }
  return gone;
}

const SAID_MAX = 280;
const TRUNCATED = /…\s*\(truncated\)\s*$/;
const STORED_CONTEXT = 'promptContext';

/** The context stored on a stop notice, once looked up. */
export function storedContext(meta: string | null): PromptContext | undefined {
  try { return meta ? JSON.parse(meta)?.[STORED_CONTEXT] : undefined; } catch { return undefined; }
}

/**
 * The worker's own record of the command it is parked on, from `worker-read`, which spends no tokens. The prompt's command
 * has to be the end of a logged one, so a later call never lends its words to this prompt. {} means Orca answered and
 * nothing matched; undefined means no answer, so it can be tried again.
 */
export async function readPromptContext(orca: Orca, dispatch: string, prompt: TerminalPrompt): Promise<PromptContext | undefined> {
  if (!prompt.full || prompt.tool) return {};
  const r = await orca(['orchestration', 'worker-read', '--dispatch', dispatch, '--limit', '30']).catch(() => undefined);
  if (!r?.ok) return undefined;
  const messages: any[] = r.result?.transcript?.messages ?? [];
  const tail = compact(prompt.full).slice(-MARK_MAX);
  for (let m = messages.length - 1; m >= 0; m--) {
    for (const b of [...(messages[m].blocks ?? [])].reverse()) {
      const command = b.type === 'tool-call' ? b.input?.command : undefined;
      if (typeof command !== 'string' || !compact(command).endsWith(tail)) continue;
      const description = typeof b.input.description === 'string' ? b.input.description.trim() : '';
      let said = '';
      for (let o = m; o >= 0 && !said && messages[o].role !== 'user'; o--) {
        if (messages[o].role === 'assistant') said = (messages[o].blocks ?? []).filter((x: any) => x.type === 'text').map((x: any) => x.text).join(' ').trim();
      }
      said = said.replace(TRUNCATED, '').replace(/\s+/g, ' ');
      if (said.length > SAID_MAX) said = `${said.slice(0, SAID_MAX - 1).trimEnd()}…`;
      return { ...(TRUNCATED.test(command) ? {} : { command }), ...(description ? { description } : {}), ...(said ? { said } : {}) };
    }
  }
  return {};
}

/** Looks up the context of open prompt notices that have none yet, stores it, and returns the ones it changed. */
export async function fillPromptContexts(open: { external_id: string; kind: string; status: string; dispatch_id: string | null; body: string | null; meta: string | null }[], orca: Orca, save: (id: string, meta: string) => void): Promise<string[]> {
  const filled: string[] = [];
  for (const i of open) {
    if (i.kind !== 'escalation' || !i.external_id.startsWith('msg_stop_') || !i.dispatch_id || storedContext(i.meta)) continue;
    const { prompt } = readStopNotice(i.body);
    if (!prompt) continue;
    const context = await readPromptContext(orca, i.dispatch_id, prompt);
    if (!context) continue;
    let meta: Record<string, unknown> = {};
    try { meta = JSON.parse(i.meta ?? '{}') ?? {}; } catch { /* keep the context anyway */ }
    save(i.external_id, JSON.stringify({ ...meta, [STORED_CONTEXT]: context }));
    filled.push(i.external_id);
  }
  return filled;
}
