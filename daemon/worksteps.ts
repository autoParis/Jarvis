// What the brain did during one turn, collected from its stream-json events: thoughts, notes between tools, tool
// calls with their output, and updates that arrived mid-turn. The chat folds these into one "Worked for" row
// (web/workfold.js). Stored whole in a `jarvis-work` turn and fetched only when the owner opens the row.

export type Step =
  | { kind: 'thought' | 'note' | 'update'; text: string; clipped?: boolean }
  | { kind: 'tool'; id?: string; name: string; input: string; output?: string; failed?: boolean; clipped?: boolean };

const INPUT_MAX = 8_000;
const TEXT_MAX = 16_000;

const textOf = (c: unknown): string => typeof c === 'string' ? c
  : Array.isArray(c) ? c.map((b: any) => b.type === 'text' ? b.text : `[${b.type}]`).join('\n') : '';
const isCommand = (name: string) => name === 'Bash';
const inputOf = (name: string, input: any): string =>
  isCommand(name) && typeof input?.command === 'string' ? input.command : input === undefined ? '' : JSON.stringify(input);

/** Adds what one stream event carries to `steps`. A subagent's own events are its parent's business, so they are skipped. */
export function addSteps(steps: Step[], e: any): void {
  if (e.parent_tool_use_id || e.isReplay) return;
  if (e.type === 'system' && e.subtype === 'task_notification') {
    const text = String(e.summary ?? e.message ?? '').trim();
    if (text) steps.push({ kind: 'update', text });
    return;
  }
  if (e.type === 'assistant') {
    for (const b of e.message?.content ?? []) {
      // A signature-only thinking block has no text to show.
      if (b.type === 'thinking' && b.thinking?.trim()) steps.push({ kind: 'thought', text: b.thinking.trim() });
      else if (b.type === 'text' && b.text?.trim()) steps.push({ kind: 'note', text: b.text.trim() });
      else if (b.type === 'tool_use') steps.push({ kind: 'tool', id: b.id, name: b.name, input: inputOf(b.name, b.input) });
    }
    return;
  }
  if (e.type !== 'user') return;
  const content = e.message?.content;
  if (typeof content === 'string') { if (content.trim()) steps.push({ kind: 'update', text: content.trim() }); return; }
  for (const b of content ?? []) {
    if (b.type === 'text' && b.text?.trim()) steps.push({ kind: 'update', text: b.text.trim() });
    if (b.type !== 'tool_result') continue;
    const call = steps.find(s => s.kind === 'tool' && s.id === b.tool_use_id);
    if (call?.kind === 'tool') { call.output = textOf(b.content); if (b.is_error) call.failed = true; }
  }
}

/** The steps as stored: the final reply stays out, because it shows outside the fold, and long text is shortened and marked. */
export function finishSteps(steps: Step[], reply: string): Step[] {
  const last = steps.findLastIndex(s => s.kind === 'note');
  const kept = last >= 0 && (steps[last] as { text: string }).text === reply.trim() ? steps.toSpliced(last, 1) : steps;
  return kept.map(s => {
    if (s.kind !== 'tool') return s.text.length > TEXT_MAX ? { ...s, text: s.text.slice(0, TEXT_MAX), clipped: true } : s;
    const { id, ...call } = s;
    const long = call.input.length > INPUT_MAX || (call.output?.length ?? 0) > TEXT_MAX;
    return long ? { ...call, input: call.input.slice(0, INPUT_MAX), output: call.output?.slice(0, TEXT_MAX), clipped: true } : call;
  });
}
