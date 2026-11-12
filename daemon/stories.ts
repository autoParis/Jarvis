import { OWNER_CAP, STORY_ZONE, STORY_START_HOUR, STORY_END_HOUR, STORY_MAX } from './config.ts';
import type { Store, QueuedStory, Approval } from './store.ts';
import { isQuietHours } from './push.ts';
import { IDLE_STOPPED } from './native.ts';
import { storySkill } from './today.ts';
import type { Log } from './log.ts';

// The story queue, decided 2026-11-11: the brain lists product issues in order with jarvis-stories, and from 8 AM to
// 4 PM Eastern jarvisd starts the next one itself, with no Approve card, while fewer than 3 story workers run.
// Nothing starts outside the hours; a worker already running at the end hour keeps going.

export type StoryHours = { zone: string; start: number; end: number };
export const STORY_HOURS: StoryHours = { zone: STORY_ZONE, start: STORY_START_HOUR, end: STORY_END_HOUR };
/** How often the fill rule looks. A start also follows a worker's DONE or FAILED report at once (main.ts). */
export const FILL_MS = 60_000;

/** From `start` o'clock to just before `end` o'clock on the zone's clock. The zone follows DST. */
export const inStoryHours = (t: number, h: StoryHours = STORY_HOURS) => h.start < h.end && isQuietHours(t, h);

/** A story worker's title is `#<n> <topic>` (vault/CLAUDE.md), so the number leads it. */
export const storyNumberOf = (title: unknown): number | undefined => {
  const m = /^#(\d+)\b/.exec(String(title ?? '').trim());
  return m ? Number(m[1]) : undefined;
};

const STORY_ACTIONS = new Set(['worker-start', 'today-start']);
/**
 * Story workers that still hold a slot: no DONE or FAILED report yet, and not stopped or abandoned. A worker that waits on
 * an ask counts, and so does one the idle reaper stopped while its ask was open, because a reply resumes it.
 */
export function runningStories(store: Pick<Store, 'nativeWorkers' | 'approval'>): { number: number; worker: string }[] {
  const out: { number: number; worker: string }[] = [];
  for (const w of store.nativeWorkers()) {
    if (w.outcome || w.approval_id === null) continue;
    const live = ['starting', 'working', 'blocked'].includes(w.state) || (w.state === 'stopped' && w.waiting_for === IDLE_STOPPED);
    if (!live) continue;
    const a = store.approval(w.approval_id);
    if (!a || !STORY_ACTIONS.has(a.action)) continue;
    let title: unknown;
    try { title = JSON.parse(a.args).taskTitle; } catch {}
    const number = storyNumberOf(title);
    if (number !== undefined) out.push({ number, worker: w.name });
  }
  return out;
}

/** The task of a story started from the queue. The gate adds the issue rule and the report format of every worker-start. */
export const queueStartSpec = (n: number, skill: string) => `Run the ${skill} skill on issue #${n} (do not pick a different issue). ${OWNER_CAP} put this story on the Jarvis story queue, and Jarvis started it from there. Done when the PR is marked ready with its evidence, or you are blocked.`;
export const queueTitle = (q: Pick<QueuedStory, 'number' | 'topic'>) => `#${q.number} ${q.topic.slice(0, 70)}`;

export type StoriesOptions = {
  store: Store;
  /** The gate's start for a queued story: the worker-start path, decided by the queue instead of a card. */
  gate: { queued(args: any, say: string): Promise<Approval> };
  /** The product repo's absolute path, from its project card. Undefined means the queue starts nothing. */
  repo: () => string | undefined;
  log: Log;
  paused: () => boolean;
  /** One line for the chat, and the notice for the brain. */
  told: (line: string, brain: string) => void;
  onChange: () => void;
  now?: () => number; hours?: StoryHours; max?: number; skillFor?: (repo: string) => string;
};

export function makeStories(o: StoriesOptions) {
  const now = o.now ?? Date.now, hours = o.hours ?? STORY_HOURS, max = o.max ?? STORY_MAX, skillFor = o.skillFor ?? storySkill;
  let filling = false;

  /** Starts queued stories, one at a time, until the slots are full, the queue is empty or the hours end. Returns how many started. */
  async function fill(): Promise<number> {
    if (filling || o.paused() || !inStoryHours(now(), hours)) return 0;
    const repo = o.repo();
    if (!repo) return 0;
    filling = true;
    let started = 0;
    try {
      while (inStoryHours(now(), hours)) {
        const running = runningStories(o.store);
        const next = o.store.storyQueue()[0];
        if (!next || running.length >= max) break;
        const title = queueTitle(next);
        if (running.some(r => r.number === next.number)) {
          o.store.unqueueStory(next.number);
          o.log('story queue: already running, removed', { issue: next.number });
          o.told(`#${next.number} is already running, so I took it off the queue`, `[story queue] #${next.number} was next on the queue, but a worker for it already runs, so jarvisd removed it. SILENT unless ${OWNER_CAP} asked about it.`);
          o.onChange();
          continue;
        }
        let a: Approval | undefined, error = '';
        try {
          a = await o.gate.queued({ repo, taskTitle: title, spec: queueStartSpec(next.number, skillFor(repo)) }, `Start ${title} from the queue`);
        } catch (e) { error = (e as Error).message; }
        // Removed whatever happened: a lost answer may mean a worker runs, and the gate refuses a second start with the same title anyway.
        o.store.unqueueStory(next.number);
        o.onChange();
        if (a?.status === 'done') {
          started++;
          o.log('story queue: started', { issue: next.number, approval: a.id, running: running.length + 1 });
          o.told(`Started ${title} from the queue`, `[story queue] Started ${title} from the queue (approval #${a.id}), with no card: ${OWNER_CAP}'s queue rule covers it. ${running.length + 1} of ${max} story slots are in use. ${o.store.storyQueue().length} stories wait on the queue. SILENT.`);
        } else {
          const why = error || a?.result || `the start ended ${a?.status ?? 'without an answer'}`;
          o.log('story queue: start failed', { issue: next.number, approval: a?.id, status: a?.status, error: why });
          o.told(`Could not start ${title} from the queue: ${why}`, `[story queue] The start of ${title} from the queue ${a?.status === 'unknown' ? 'lost its answer, so a worker may run' : 'failed'}: ${why}. jarvisd took it off the queue. Tell ${OWNER_CAP} in one sentence; add it back with jarvis-stories add if a retry makes sense.`);
          if (a?.status === 'unknown') break;
        }
      }
    } finally { filling = false; }
    return started;
  }

  const view = () => ({ stories: o.store.storyQueue(), running: runningStories(o.store), max, hours: { ...hours, open: inStoryHours(now(), hours) } });
  return { fill, view };
}

export type Stories = ReturnType<typeof makeStories>;

const posInt = (v: unknown) => typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v) : NaN;

/** `jarvis-stories` relays here: GET /api/internal/stories, POST .../add, .../remove, .../move. */
export function storyRoute(store: Store, stories: Pick<Stories, 'view' | 'fill'>, log: Log, method: string, url: string, body: any, changed: () => void): { status: number; body: unknown } | undefined {
  const path = url.split('?')[0];
  if (method === 'GET' && path === '/api/internal/stories') return { status: 200, body: stories.view() };
  if (method !== 'POST') return undefined;
  const op = path.slice('/api/internal/stories/'.length);
  if (!['add', 'remove', 'move'].includes(op)) return undefined;
  const refuse = (error: string) => ({ status: 400, body: { error } });
  const number = posInt(body?.number);
  if (!Number.isInteger(number) || number <= 0) return refuse('number must be the issue number, a whole number above 0');
  const at = body?.at === undefined || body?.at === null ? undefined : posInt(body.at);
  if (at !== undefined && (!Number.isInteger(at) || at <= 0)) return refuse('at must be a position, 1 for first');
  let done: boolean;
  if (op === 'add') {
    const topic = typeof body?.topic === 'string' ? body.topic.replace(/\s+/g, ' ').trim() : '';
    if (!topic) return refuse('topic is required: a few words that name the story, as in the worker title "#<n> <topic>"');
    if (topic.length > 100) return refuse('topic must be at most 100 characters');
    done = store.queueStory(number, topic, at);
    if (!done) return { status: 409, body: { error: `#${number} is already on the queue. Use move to change its place.`, ...stories.view() } };
  } else if (op === 'remove') {
    done = store.unqueueStory(number);
  } else {
    if (at === undefined) return refuse('move needs --to <position>, 1 for first');
    done = store.moveStory(number, at);
  }
  if (!done) return { status: 404, body: { error: `#${number} is not on the queue`, ...stories.view() } };
  log(`story queue: ${op}`, { issue: number, at });
  changed();
  if (op === 'add') stories.fill().catch(e => log('story queue: fill failed', { error: String(e) }));
  return { status: 200, body: stories.view() };
}
