import { openSync, readSync, closeSync, statSync } from 'node:fs';
import { tailOf } from './resume.ts';

// The conversation pane in the app. GET /api/work/<id>/read?cursor= returns the messages after the cursor, read from
// the session's own transcript file, and the page polls about every 3 s while the pane is open.
// Text longer than CLIP comes back with `clipped: true`, and the page marks it.

// `kind` tells the page how to draw a line. reply: a message another session (Jarvis or the owner) sent the worker.
// event: something jarvisd did to the session (resumed it after its terminal died), shown as a gap line with its text.
export type Line = {
  id: string; role: 'user' | 'agent' | 'tool' | 'terminal'; at?: number; text: string; clipped?: boolean;
  kind?: 'reply' | 'event'; by?: 'jarvis';
};
/** `more`: there is more after `cursor`, so ask again at once. `reset`: the cursor no longer applies, start over without one. */
export type Read = { lines: Line[]; cursor?: string; more?: boolean; reset?: boolean; error?: string };

export const CLIP = 40_000;
/** Lines kept from what came before the pane opened. */
export const FIRST_LINES = 400;
const FILE_CHUNK = 2 * 1024 * 1024;

function clip(id: string, role: Line['role'], text: string, at?: number, max = CLIP): Line {
  const line: Line = { id, role, at, text: text.length > max ? text.slice(0, max) : text };
  if (text.length > max) line.clipped = true;
  return line;
}
/** A tool call as a pane line: its name and its command, path or first argument on one short line. */
function toolLine(id: string, name: string, input: any, at?: number): Line {
  const given = typeof input === 'string' ? input : input?.command ?? input?.cmd;
  const arg = Array.isArray(given) ? given.join(' ') : given ?? input?.file_path ?? input?.path ?? input?.pattern ?? input?.description ?? (input ? JSON.stringify(input) : '');
  return clip(id, 'tool', `${name}${arg ? `: ${String(arg).replace(/\s+/g, ' ')}` : ''}`, at, 200);
}

/** A user turn as a pane line. */
const userLine = (id: string, text: string, at?: number): Line => clip(id, 'user', text, at);

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
 * A send whose tool result says it failed (`success: false`, or an error result) is left out: it never reached `to`.
 * Worker 5361 (2026-11-11 14:47Z): "No agent named 'jarvis-brain' is reachable" while jarvisd restarted.
 * A send with no result found stays in.
 */
export function lastTurnMessages(file: string, to: string): string[] {
  let sent: { id: unknown; text: string }[] = [];
  const failed = new Set<unknown>();
  for (const raw of tailOf(file).split('\n')) {
    if (!raw) continue;
    let e: any;
    try { e = JSON.parse(raw); } catch { continue; }
    if (e.isSidechain) continue;
    const c = e.message?.content;
    if (e.type === 'user') {
      const results = Array.isArray(c) && c.length > 0 && c.every((b: any) => b?.type === 'tool_result');
      if (!results && (!e.isMeta || e.turnOrigin === 'peer')) sent = [];
      if (results) for (const b of c) if (b.is_error === true || (c.length === 1 && e.toolUseResult?.success === false)) failed.add(b.tool_use_id);
      continue;
    }
    if (e.type !== 'assistant' || !Array.isArray(c)) continue;
    for (const b of c) if (b?.type === 'tool_use' && b.name === 'SendMessage' && b.input?.to === to && typeof b.input.message === 'string') sent.push({ id: b.id, text: b.input.message });
  }
  return sent.filter(s => s.id === undefined || !failed.has(s.id)).map(s => s.text);
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

/**
 * The worker's message with pane id `id` (`f:<byte offset>`), for read aloud (/api/speech/worker in voice.ts). Only a
 * worker message is returned: an id that points at the owner's words, a tool call or the middle of a line gives undefined.
 */
export function chatLineAt(file: string, id: string): string | undefined {
  const m = /^f:(\d+)$/.exec(id);
  if (!m) return undefined;
  const from = Number(m[1]), size = statSync(file).size;
  if (from >= size) return undefined;
  const len = Math.min(FILE_CHUNK, size - from), buf = Buffer.alloc(len);
  const fd = openSync(file, 'r');
  try { readSync(fd, buf, 0, len, from); } finally { closeSync(fd); }
  const text = buf.toString('utf8'), end = text.indexOf('\n');
  if (end < 0) return undefined;
  return chatLines(text.slice(0, end + 1), from).find(l => l.id === id && l.role === 'agent')?.text;
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
