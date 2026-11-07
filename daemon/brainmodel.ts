// Which model and effort the brain runs on. Only the brain: workers pick their own model.
// The setting lives in the store's `state` table under `brainModel`, so it survives a jarvisd restart.

export const MODELS = [
  { id: 'claude-opus-5-5', label: 'Opus 5.5', note: 'For complex work and everyday tasks' },
  { id: 'claude-fable-5-1', label: 'Fable 5.1', note: 'For your toughest challenges' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', note: 'Most efficient for simpler tasks' },
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5', note: 'Fastest for quick answers' },
] as const;
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

export type Effort = typeof EFFORTS[number];
export type BrainModel = { model: string; effort: Effort };

/** Opus 5.5 at medium, the effort the owner's user settings gave the brain before this setting existed. */
export const DEFAULT_BRAIN_MODEL: BrainModel = { model: 'claude-opus-5-5', effort: 'medium' };
export const STATE_KEY = 'brainModel';

/** A valid setting, or the reason it is not one. */
export function parseBrainModel(v: unknown): BrainModel | { error: string } {
  const o = (v ?? {}) as Record<string, unknown>;
  if (!MODELS.some(m => m.id === o.model)) return { error: `model must be one of ${MODELS.map(m => m.id).join(', ')}` };
  if (!EFFORTS.includes(o.effort as Effort)) return { error: `effort must be one of ${EFFORTS.join(', ')}` };
  return { model: o.model as string, effort: o.effort as Effort };
}

/** The saved setting. A missing or unreadable value gives the default. */
export function readBrainModel(get: (key: string) => string | undefined): BrainModel {
  try {
    const r = parseBrainModel(JSON.parse(get(STATE_KEY) ?? 'null'));
    return 'error' in r ? { ...DEFAULT_BRAIN_MODEL } : r;
  } catch { return { ...DEFAULT_BRAIN_MODEL }; }
}

export function saveBrainModel(set: (key: string, value: string) => void, m: BrainModel) {
  set(STATE_KEY, JSON.stringify({ model: m.model, effort: m.effort }));
}

type Switchable = { busy: boolean; setting: BrainModel; switchModel(m: BrainModel): Promise<string | undefined> };

/**
 * POST /api/brain/model. Validates, refuses while a turn runs (409), saves the setting, then restarts the brain on it.
 * A refused switch puts the saved setting back, so what is stored never runs ahead of what the brain will use.
 * With the kill switch on, the brain stays off and the setting applies at its next start.
 */
export async function changeBrainModel(o: { body: unknown; brain: Switchable; setState: (key: string, value: string) => void; killed: boolean }):
  Promise<{ status: number; error?: string }> {
  const m = parseBrainModel(o.body);
  if ('error' in m) return { status: 400, error: m.error };
  if (o.brain.busy) return { status: 409, error: 'Jarvis is in the middle of a turn. Try again when it ends.' };
  const before = { ...o.brain.setting };
  saveBrainModel(o.setState, m);
  if (o.killed) { o.brain.setting = m; return { status: 200 }; }
  const refused = await o.brain.switchModel(m);
  if (refused) { saveBrainModel(o.setState, before); return { status: 409, error: refused }; }
  return { status: 200 };
}
