import { openSync, readSync, closeSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { OrcaResult } from './orca.ts';
import type { Source, ChatRef } from './work.ts';
import { tailOf } from './resume.ts';

// The conversation pane in the app. GET /api/work/<id>/read?cursor= returns the messages after
// the cursor, and the page polls about every 3 s while the pane is open. The session's own file is the
// source when it can be found, since Orca clips long text in `worker-read` and a terminal read is a screen.
// Text longer than CLIP, and text Orca already clipped, comes back with `clipped: true`, and the page marks it.

// `kind` tells the page how to draw a line. ask, done and blocked: the worker's words to its coordinator, taken out of a
// tool call. preamble: Orca's brief. wake: Orca's "You have 1 orchestration message". reply: the answer that wake stood for.
// event: something jarvisd did to the session (resumed it after its terminal died), shown as a gap line with its text.
export type Line = {
  id: string; role: 'user' | 'agent' | 'tool' | 'terminal'; at?: number; text: string; clipped?: boolean;
  kind?: 'ask' | 'done' | 'blocked' | 'preamble' | 'wake' | 'reply' | 'event'; failed?: boolean; by?: 'jarvis';
};
/** `more`: there is more after `cursor`, so ask again at once. `reset`: the cursor no longer applies, start over without one. */
export type Read = { lines: Line[]; cursor?: string; more?: boolean; reset?: boolean; error?: string };
type Orca = (args: string[]) => Promise<OrcaResult>;

export const CLIP = 40_000;
/** Lines kept from what came before the pane opened. */
export const FIRST_LINES = 400;
const PAGES = 10;
const FILE_CHUNK = 2 * 1024 * 1024;

function clip(id: string, role: Line['role'], text: string, at?: number, max = CLIP): Line {
  // Orca marks text it shortened with a trailing "… (truncated)".
  const orcaClipped = /…\s*\(truncated\)\s*$/.test(text);
  if (orcaClipped) text = text.replace(/…\s*\(truncated\)\s*$/, '').trimEnd();
  const line: Line = { id, role, at, text: text.length > max ? text.slice(0, max) : text };
  if (orcaClipped || text.length > max) line.clipped = true;
  return line;
}
/** Words of one simple shell command, up to the first control operator. `undefined` for a word the shell would have to compute. */
function shellWords(s: string): string[] | undefined {
  const words: string[] = [];
  let i = 0;
  while (i < s.length) {
    while (s[i] === ' ' || s[i] === '\t' || (s[i] === '\\' && s[i + 1] === '\n' && ++i)) i++;
    if (i >= s.length || ';&|)\n#'.includes(s[i])) break;
    let w = '';
    while (i < s.length && !' \t;&|)\n'.includes(s[i])) {
      const c = s[i++];
      if (c === "'") { const end = s.indexOf("'", i); if (end < 0) return undefined; w += s.slice(i, end); i = end + 1; }
      else if (c === '"') {
        while (i < s.length && s[i] !== '"') {
          if (s[i] === '\\' && '"\\$`\n'.includes(s[i + 1])) { if (s[i + 1] !== '\n') w += s[i + 1]; i += 2; continue; }
          if (s[i] === '`' || (s[i] === '$' && s[i + 1] === '(')) return undefined;
          w += s[i++];
        }
        i++;
      } else if (c === '\\') w += s[i++] ?? '';
      else if (c === '`' || (c === '$' && s[i] === '(')) return undefined;
      else w += c;
    }
    words.push(w);
  }
  return words;
}

const ORCA_CALL = /(?:^|[\s;&|(])(?:[\w./-]*\/)?(?:jarvis-orca|orca(?:-dev|-ide)?|\$\{ORCA_CLI_COMMAND:-orca\})\s+(?:orchestration\s+)?(ask|send)(?=\s)/g;
// --body "$(cat <<'EOF' ... EOF )": the heredoc's text, rewritten as one quoted word.
const HEREDOC = /"\$\(cat <<-?\s*['"]?(\w+)['"]?\n([\s\S]*?)\n\s*\1\s*\)"/g;

/** The message in a shell command that asks the coordinator or reports to it. Anything else, a --help or a command that only quotes one, is undefined. */
export function orcaMessage(command: string): Pick<Line, 'kind' | 'text' | 'failed'> | undefined {
  const plain = command.replace(HEREDOC, (_, _tag, body: string) => `'${body.replace(/'/g, `'\\''`)}'`);
  for (const call of plain.matchAll(ORCA_CALL)) {
    const words = shellWords(plain.slice(call.index + call[0].length));
    if (!words) continue;
    const flags = new Map<string, string>();
    for (let i = 0; i < words.length; i++) {
      const m = /^--([\w-]+)(?:=([\s\S]*))?$/.exec(words[i]);
      if (!m) continue;
      if (m[2] !== undefined) flags.set(m[1], m[2]);
      else if (words[i + 1] !== undefined && !words[i + 1].startsWith('--')) flags.set(m[1], words[++i]);
    }
    // A double-quoted \n reaches Orca as two characters, but the worker meant a new line.
    const flag = (name: string) => flags.get(name)?.replace(/\\n/g, '\n').trim();
    if (call[1] === 'ask') {
      const question = flag('question');
      if (!question) continue;
      const options = /^OPTIONS:/m.test(question) ? '' : flag('options');
      return { kind: 'ask', text: options ? `${question}\n\nOptions: ${options.split(',').map(o => o.trim()).join(', ')}` : question };
    }
    const type = flags.get('type');
    if (type !== 'worker_done' && type !== 'escalation') continue;
    const [subject, body] = [flag('subject'), flag('body')];
    if (!subject && !body) continue;
    const text = [subject && `**${subject}**`, body].filter(Boolean).join('\n\n');
    return type === 'escalation' ? { kind: 'blocked', text } : { kind: 'done', text, ...(flags.get('outcome') === 'failed' ? { failed: true } : {}) };
  }
  return undefined;
}

/** A tool call as a pane line: its name and its command, path or first argument on one short line, or the message it carries, whole. */
function toolLine(id: string, name: string, input: any, at?: number): Line {
  const given = typeof input === 'string' ? input : input?.command ?? input?.cmd;
  // Codex can pass the command as an argument list, the script last.
  const command = Array.isArray(given) ? given.at(-1) : given;
  const message = typeof command === 'string' ? orcaMessage(command) : undefined;
  if (message) return { ...message, ...clip(id, 'agent', message.text, at) };
  const arg = Array.isArray(given) ? given.join(' ') : given ?? input?.file_path ?? input?.path ?? input?.pattern ?? input?.description ?? (input ? JSON.stringify(input) : '');
  return clip(id, 'tool', `${name}${arg ? `: ${String(arg).replace(/\s+/g, ' ')}` : ''}`, at, 200);
}

/** A user turn as a pane line. Orca's brief and wake-ups are marked; their text stays, because findWorkerSession reads it. */
function userLine(id: string, text: string, at?: number): Line {
  const line = clip(id, 'user', text, at);
  if (/You are working inside Orca\b/.test(text.slice(0, 1000))) line.kind = 'preamble';
  else if (text.length < 400 && /^You have \d+ (?:new )?orchestration messages?\b/.test(text)) line.kind = 'wake';
  return line;
}

export type Answer = { id: string; text: string; at: number; by?: 'jarvis' };
/** What one conversation's wake-ups have shown so far. Kept per dispatch, so every open pane shows the same reply on the same line. */
export type ReplyMemo = { used: Set<string>; shown: Map<string, Answer[]> };
// The ask's row is marked answered just after Orca takes the reply, so a wake can come slightly before it.
const WAKE_SKEW = 30_000;

/**
 * Puts the answer in place of the wake-up it stands for: every answer since the last one shown, up to the wake's time.
 * A wake from a message Jarvis has no answer for, such as a steer, stays a wake. When nothing was shown yet,
 * a read that starts partway may have missed earlier wakes, so only the newest answer counts.
 */
export function showReplies(lines: Line[], answers: Answer[], memo: ReplyMemo): void {
  for (const l of lines) {
    if (l.kind !== 'wake' || l.at === undefined) continue;
    let mine = memo.shown.get(l.id);
    if (!mine) {
      const fresh = answers.filter(a => !memo.used.has(a.id) && a.at <= l.at! + WAKE_SKEW);
      mine = memo.used.size ? fresh : fresh.slice(-1);
      if (!mine.length) continue;
      for (const a of fresh) memo.used.add(a.id);
      memo.shown.set(l.id, mine);
    }
    l.kind = 'reply';
    l.text = mine.map(a => a.text).join('\n\n');
    if (mine.at(-1)!.by) l.by = mine.at(-1)!.by;
  }
}

/** Orca's transcript messages as pane lines: text and tool calls, no tool output or reasoning. */
export function workerLines(messages: any[]): Line[] {
  const out: Line[] = [];
  for (const m of messages) {
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    const text = (m.blocks ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n').trim();
    if (text) out.push(m.role === 'user' ? userLine(m.id, text, m.timestamp) : clip(m.id, 'agent', text, m.timestamp));
    for (const [i, b] of (m.blocks ?? []).entries()) if (b.type === 'tool-call') out.push(toolLine(`${m.id}#${i}`, b.name, b.input, m.timestamp));
  }
  return out;
}

/** A supervised worker, through `orca orchestration worker-read`. The first read pages forward and keeps the end. */
async function readWorker(orca: Orca, dispatch: string, cursor?: string): Promise<Read> {
  let lines: Line[] = [];
  let more = false;
  for (let page = 0; page < PAGES; page++) {
    const args = ['orchestration', 'worker-read', '--dispatch', dispatch, '--limit', '100'];
    if (cursor) args.push('--cursor', cursor);
    const r = await orca(args).catch(e => ({ ok: false, error: { code: 'cli_failed', message: String(e) } }) as OrcaResult);
    if (!r.ok) return r.error?.code === 'source_changed' ? { lines: [], reset: true } : { lines, cursor, error: `Orca: ${r.error?.code ?? 'no answer'}` };
    const t = r.result.transcript;
    if (!t) {
      // No transcript: Orca fell back to labelled terminal output.
      const tail = r.result.terminal?.tail ?? r.result.tail ?? [];
      if (tail.length) lines.push(clip(`t:${cursor ?? 0}`, 'terminal', tail.join('\n')));
      return { lines, cursor: r.result.cursor ?? cursor };
    }
    lines.push(...workerLines(t.messages ?? []));
    const next = t.nextCursor ?? r.result.cursor ?? cursor;
    // Orca 1.4.244 keeps `limited` true at the end of a transcript, so only a page that moved the cursor means more.
    more = !!t.limited && !!t.messages?.length && next !== cursor;
    cursor = next;
    if (!more) break;
  }
  return { lines: lines.slice(-FIRST_LINES), cursor, more };
}

/** A terminal agent, through `orca terminal read`. */
async function readTerminal(orca: Orca, handle: string, cursor?: string): Promise<Read> {
  const args = ['terminal', 'read', '--terminal', handle, '--limit', '200'];
  if (cursor) args.push('--cursor', cursor);
  const r = await orca(args).catch(e => ({ ok: false, error: { code: 'cli_failed', message: String(e) } }) as OrcaResult);
  if (!r.ok) return { lines: [], cursor, error: `Orca: ${r.error?.code ?? 'no answer'}` };
  const t = r.result.terminal ?? {};
  const tail: string[] = t.tail ?? [];
  const lines = tail.length ? [{ ...clip(`t:${cursor ?? 'start'}`, 'terminal', tail.join('\n'), undefined, CLIP * 4), ...(t.truncated ? { clipped: true } : {}) }] : [];
  return { lines, cursor: t.nextCursor != null ? String(t.nextCursor) : cursor };
}

// ---- chat tabs: Orca has no read verb for a chat no Run dispatched, so the pane reads its transcript file ----

const TRANSCRIPT_DIRS = [join(homedir(), '.claude', 'projects') + '/', join(homedir(), '.codex', 'sessions') + '/'];

/** The transcript file of an Orca chat session, from `orca search` (each hit names its chat session and file). */
export async function findChatFile(orca: Orca, src: ChatRef, dirs = TRANSCRIPT_DIRS, tail: (file: string) => string = tailOf): Promise<string | undefined> {
  if (!src.query) return undefined;
  const r = await orca(['search', '--query', src.query, '--path', src.cwd, '--scope', 'conversation', '--sort', 'newest', '--limit', '50']).catch(() => undefined);
  if (!r?.ok) return undefined;
  const safe = (file?: string): file is string => !!file && file.endsWith('.jsonl') && !file.includes('..') && dirs.some(d => file.startsWith(d));
  const hits: any[] = r.result.hits ?? [];
  const hit = hits.find(h => h.structuredSession?.sessionId === src.key);
  if (hit) return safe(hit.source?.filePath) ? hit.source.filePath : undefined;
  if (!src.probe) return undefined;
  // A terminal agent's hit does not name its pane, and search matches single words, so its last message has to be in the file.
  const words = JSON.stringify(src.probe).slice(1, -1);
  for (const h of hits) {
    const file = h.source?.filePath;
    if (h.structuredSession || h.cwd !== src.cwd || !safe(file)) continue;
    try { if (tail(file).includes(words)) return file; } catch {}
  }
  return undefined;
}

/** The wrapper Claude Code puts around a message from another session in the transcript. Group 1 is the tag's attributes, 2 the text. */
const PEER_MESSAGE = /<cross-session-message\b([^>]*)>\n?([\s\S]*?)\n?<\/cross-session-message>/;
const textOf = (c: unknown): string => typeof c === 'string' ? c
  : Array.isArray(c) ? c.filter((b: any) => ['text', 'input_text', 'output_text'].includes(b.type)).map((b: any) => b.text).join('\n') : '';
// Harness-injected blocks that look like user turns but are not a person (same rule as bin/jarvis-session).
const injected = (t: string) => /^\s*(<|# AGENTS\.md|Caveat:|\[Request interrupted)/.test(t);

/** What jarvisd did to a native session, from its `items` rows of kind `event`: id, text and when. */
export type PaneEvent = { id: number; body: string; created_at: string };

/**
 * A native worker's pane read with jarvisd's own events (a resume after a death) as gap lines. The cursor grows a second
 * part, `f:<byte>|e:<last event id>`, so each event is sent once; `fileCursor` strips it for readChatFile. Events are
 * appended after the file's new lines, each with its time, and the page keeps the order it receives.
 */
export const fileCursor = (cursor?: string) => cursor?.split('|')[0] || undefined;
export function withEvents<R extends Read>(r: R, events: PaneEvent[], cursor?: string): R {
  const seen = Number(cursor?.split('|').find(p => p.startsWith('e:'))?.slice(2) ?? 0);
  const fresh = events.filter(e => e.id > seen);
  for (const e of fresh) r.lines.push({ id: `ev:${e.id}`, role: 'user', kind: 'event', text: e.body, at: Date.parse(`${e.created_at.replace(' ', 'T')}${e.created_at.endsWith('Z') ? '' : 'Z'}`) });
  const last = fresh.length ? fresh[fresh.length - 1].id : seen;
  if (r.cursor || last) r.cursor = `${r.cursor ?? fileCursor(cursor) ?? ''}|e:${last}`;
  return r;
}

/**
 * The last assistant text in a Claude Code transcript's tail, word for word: what a Stop hook would have carried as
 * `last_assistant_message`, for a report whose hook never reached jarvisd (native.ts recovers it from here).
 */
export function lastAssistantText(file: string): string | undefined {
  let last: string | undefined;
  for (const raw of tailOf(file).split('\n')) {
    if (!raw) continue;
    let e: any;
    try { e = JSON.parse(raw); } catch { continue; }
    if (e.type === 'assistant' && !e.isMeta) { const t = textOf(e.message?.content).trim(); if (t) last = t; }
  }
  return last;
}

/**
 * The texts the last turn sent with SendMessage to the session named `to`, in order. The turn starts at the last user line
 * that is a prompt, a typed message or a cross-session message (`turnOrigin: peer`); tool results and meta lines (system
 * reminders) do not start one. Only the file's tail is read, so a message sent long ago in a very long turn is missed.
 */
export function lastTurnMessages(file: string, to: string): string[] {
  let sent: string[] = [];
  for (const raw of tailOf(file).split('\n')) {
    if (!raw) continue;
    let e: any;
    try { e = JSON.parse(raw); } catch { continue; }
    if (e.isSidechain) continue;
    const c = e.message?.content;
    if (e.type === 'user') {
      const results = Array.isArray(c) && c.length > 0 && c.every((b: any) => b?.type === 'tool_result');
      if (!results && (!e.isMeta || e.turnOrigin === 'peer')) sent = [];
      continue;
    }
    if (e.type !== 'assistant' || !Array.isArray(c)) continue;
    for (const b of c) if (b?.type === 'tool_use' && b.name === 'SendMessage' && b.input?.to === to && typeof b.input.message === 'string') sent.push(b.input.message);
  }
  return sent;
}

/** Claude Code or Codex transcript lines as pane lines. `start` is the byte offset of the first line, which makes the ids. */
export function chatLines(jsonl: string, start: number): Line[] {
  const out: Line[] = [];
  let offset = start;
  for (const raw of jsonl.split('\n')) {
    const id = `f:${offset}`;
    offset += Buffer.byteLength(raw) + 1;
    if (!raw) continue;
    let e: any;
    try { e = JSON.parse(raw); } catch { continue; }
    const at = e.timestamp ? Date.parse(e.timestamp) : undefined;
    if (e.type === 'user' && e.isMeta && e.turnOrigin === 'peer') { // a cross-session message (a reply Jarvis or the owner sent a native worker)
      const peer = PEER_MESSAGE.exec(textOf(e.message?.content));
      if (peer) out.push({ id, role: 'user', at, text: peer[2].trim(), kind: 'reply', ...(peer[1].includes('jarvis-brain') ? {} : { by: undefined }) });
      continue;
    }
    // Text typed into an interactive session while a turn ran: Claude Code queues it and folds it into that turn as an
    // attachment (seen live 2026-11-07), so it is a message from the owner or Jarvis with no `user` line of its own.
    if (e.type === 'attachment' && e.attachment?.type === 'queued_command' && typeof e.attachment.prompt === 'string') {
      const t = e.attachment.prompt.trim();
      if (t) out.push(userLine(id, t, at));
      continue;
    }
    if ((e.type === 'user' || e.type === 'assistant') && !e.isMeta) { // Claude Code
      const t = textOf(e.message?.content).trim();
      if (t && !(e.type === 'user' && injected(t))) out.push(e.type === 'user' ? userLine(id, t, at) : clip(id, 'agent', t, at));
      if (Array.isArray(e.message?.content)) for (const [i, b] of e.message.content.entries()) if (b.type === 'tool_use') out.push(toolLine(`${id}#${i}`, b.name, b.input, at));
    } else if (e.type === 'response_item') { // Codex
      const p = e.payload ?? {};
      if (p.type === 'message' && (p.role === 'user' || p.role === 'assistant')) {
        const t = textOf(p.content).trim();
        if (t && !(p.role === 'user' && injected(t))) out.push(p.role === 'user' ? userLine(id, t, at) : clip(id, 'agent', t, at));
      } else if (p.type === 'function_call' || p.type === 'custom_tool_call') {
        out.push(toolLine(id, p.name, p.type === 'function_call' ? (() => { try { return JSON.parse(p.arguments); } catch { return p.arguments; } })() : p.input, at));
      }
    }
  }
  return out;
}

/** Reads complete lines after byte `cursor` (the last 2 MB on the first read). The cursor is the next unread byte. */
export function readChatFile(file: string, cursor?: string): Read {
  const size = statSync(file).size;
  let from = cursor ? Number(cursor.replace(/^f:/, '')) : Math.max(0, size - FILE_CHUNK);
  if (!Number.isFinite(from) || from > size) return { lines: [], reset: true };
  const len = Math.min(FILE_CHUNK, size - from);
  const buf = Buffer.alloc(len);
  const fd = openSync(file, 'r');
  try { readSync(fd, buf, 0, len, from); } finally { closeSync(fd); }
  let text = buf.toString('utf8');
  if (!cursor && from > 0) { const nl = text.indexOf('\n'); from += Buffer.byteLength(text.slice(0, nl + 1)); text = text.slice(nl + 1); }
  const end = text.lastIndexOf('\n');
  if (end < 0) return { lines: [], cursor: `f:${from}` };
  const whole = text.slice(0, end + 1);
  const lines = chatLines(whole, from);
  const next = from + Buffer.byteLength(whole);
  return { lines: cursor ? lines : lines.slice(-FIRST_LINES), cursor: `f:${next}`, more: next < size && len === FILE_CHUNK };
}

/** Reads a listed row from wherever it lives. `files` caches each chat session's transcript path. */
export async function readSource(orca: Orca, src: Source, cursor: string | undefined, files: Map<string, string>): Promise<Read> {
  const chat = src.kind === 'chat' ? src : src.chat;
  // A read that began on Orca's cursor stays there until the pane reopens.
  if (chat && (!cursor || cursor.startsWith('f:'))) {
    const file = await chatFile(orca, chat, files);
    if (file) {
      try { return readChatFile(file, cursor); }
      catch (e) { files.delete(chat.key); return { lines: [], error: `Transcript unreadable: ${(e as Error).message}` }; }
    }
  }
  if (src.kind === 'worker') return readWorker(orca, src.dispatch, cursor);
  if (src.kind === 'terminal') return readTerminal(orca, src.handle, cursor);
  return { lines: [], error: "Orca's search has not found this chat's transcript yet." };
}

export type WorkerSession = { session: string; file: string };
const HEAD_BYTES = 256 * 1024;
function headOf(file: string): string {
  const buf = Buffer.alloc(Math.min(HEAD_BYTES, statSync(file).size));
  const fd = openSync(file, 'r');
  try { readSync(fd, buf, 0, buf.length, 0); } finally { closeSync(fd); }
  return buf.toString('utf8');
}

/**
 * A worker's own session, found from its dispatch id. Orca only names the session of a chat-tab worker; a terminal worker
 * has just a pane. Every worker's first message is Orca's preamble, which holds `--dispatch-id <id>`, so that message
 * proves the file is the worker's. Other sessions can quote a dispatch id later on, or in a task spec without the flag.
 * With `known`, the session id is already recorded and only its file is wanted. For a chat-tab worker that id is Orca's
 * key, not the file's name, and the first message holds it as `orca_session_id:<key>`.
 */
export async function findWorkerSession(orca: Orca, dispatch: string, opts: { cwd?: string; known?: string; dirs?: string[] } = {}): Promise<WorkerSession | undefined> {
  const dirs = opts.dirs ?? TRANSCRIPT_DIRS;
  const hits = async (query: string): Promise<{ file: string; session: string; cwd?: string }[]> => {
    const r = await orca(['search', '--query', query, ...(opts.cwd ? ['--path', opts.cwd] : []), '--scope', 'conversation', '--sort', 'newest', '--limit', '50']).catch(() => undefined);
    return ((r?.ok && r.result.hits) || []).flatMap((h: any) => {
      const file: string | undefined = h.source?.filePath, session: string | undefined = h.sessionId ?? h.structuredSession?.sessionId;
      return session && file && file.endsWith('.jsonl') && !file.includes('..') && dirs.some(d => file.startsWith(d)) ? [{ file, session, cwd: h.cwd }] : [];
    });
  };
  const opensWith = (file: string, words: string) => {
    try { return !!chatLines(headOf(file), 0).find(l => l.role === 'user')?.text.includes(words); } catch { return false; }
  };
  const found = await hits(dispatch);
  if (opts.known) {
    const named = found.find(h => h.session === opts.known);
    if (named) return { session: named.session, file: named.file };
    const tab = (await hits(opts.known)).find(h => opensWith(h.file, `orca_session_id:${opts.known}`));
    return tab && { session: opts.known, file: tab.file };
  }
  const own = found.find(h => (!opts.cwd || h.cwd === opts.cwd) && opensWith(h.file, `--dispatch-id ${dispatch}`));
  return own && { session: own.session, file: own.file };
}

/** The transcript file of a session, cached once found. */
export async function chatFile(orca: Orca, chat: ChatRef, files: Map<string, string>): Promise<string | undefined> {
  let file = files.get(chat.key);
  if (!file) {
    file = await findChatFile(orca, chat);
    if (file) files.set(chat.key, file);
  }
  return file;
}
