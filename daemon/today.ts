// The Today list: The owner drops a thought, Jarvis works it up, and it waits on the row until he taps.
// Hard limits, enforced here and not only in the prompt:
// - Nothing outward without a tap. Go only starts a local worker. The issue is filed only by Accept, which the brain cannot call.
// - The brain's routes can write a work-up or a result. They cannot release, drop, accept or run anything.
// - A pass decides in code first, so a pass with nothing to do makes no model call.
import { OWNER_CAP, OWNER } from './config.ts';
import { cpus, loadavg } from 'node:os';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Store, TodayRow, Approval } from './store.ts';
import { ISSUE_RULE, type Gate } from './gate.ts';
import { requestReport } from './requests.ts';
import { QUIET_HOURS, sqlTime } from './push.ts';
import type { Log } from './log.ts';

/** At most this many items have something running. Story drafts count. */
export const CAP = 3;
/** The timer that catches anything an event missed. */
export const BACKSTOP_MS = 30 * 60_000;
/** A brain that does not write a work-up is told again each backstop, this many times in all, then the row shows the failure. */
export const MAX_TRIES = 3;
/** A row marked working with no worker after this long lost its start (a crash in between). */
export const STUCK_MS = 5 * 60_000;
const MORNING_HOUR = 8;

export const STATUS_WORDS: Record<string, string> = { new: 'New', waiting: 'Waiting on you', queued: 'Queued', working: 'Working', ready: 'Ready to check', released: 'Released' };
const RANK: Record<string, number> = { waiting: 0, ready: 1, working: 2, queued: 3, new: 4, released: 5 };
const KINDS = ['story', 'task', 'talk'];

export type Question = { q: string; options: string[]; recommended: number; answer?: string };
export type Story = { github: string; title: string; body: string };
export type TodayView = {
  id: number; words: string; title: string; kind: string | null; go: boolean; status: string; statusWords: string; at: string;
  reading: string; questions: Question[]; assumptions: string[]; reason: string; result: string; notProven: string; note: string; line: string;
  /** `url` opens a page; `open` is the request whose conversation a tap opens. */
  link?: { label: string; url?: string; open?: number };
  buttons: string[];
};
export type PassPlan = { skip?: 'paused' | 'overloaded' | 'nothing'; wake: number[]; start: number[]; gaveUp: number[]; load: number; cores: number };
export type RouteResult = { status: number; body: any };

const parse = <T>(s: string | null | undefined, fallback: T): T => { try { return s ? JSON.parse(s) : fallback; } catch { return fallback; } };
const time = (sql: string) => Date.parse(`${sql.replace(' ', 'T')}Z`);
const iso = (sql: string) => `${sql.replace(' ', 'T')}Z`;
export const needsOwner = (status: string) => status === 'waiting' || status === 'ready';

/** What the owner can press on this row. The page draws these and the route refuses anything else. */
export function buttons(i: Pick<TodayRow, 'status' | 'kind' | 'story' | 'issue_state'>): string[] {
  if (i.status === 'new' || i.status === 'queued') return ['drop'];
  if (i.status === 'ready') return ['release', 'not-right'];
  if (i.status !== 'waiting') return [];
  if (i.kind === 'talk') return ['discuss', 'drop'];
  if (i.kind === 'task') return ['do', 'not-right', 'drop'];
  if (i.kind === 'story' && i.story) return [...(i.issue_state === 'unknown' ? [] : ['accept']), 'not-right', 'drop'];
  return ['retry', 'drop'];
}

export function todayView(i: TodayRow, store?: Pick<Store, 'requestOf'>): TodayView {
  const request = i.status === 'working' && i.dispatch ? store?.requestOf(i.dispatch) : undefined;
  const link = request?.pr_url ? { label: request.pr ?? 'PR', url: request.pr_url } : request ? { label: i.phase === 'draft' ? 'Draft' : 'Worker', open: request.id }
    : i.status !== 'working' && i.link ? { label: i.link_label ?? 'Link', url: i.link } : undefined;
  return {
    id: i.id, words: i.words, title: i.title || i.words.replace(/\s+/g, ' ').slice(0, 80), kind: i.kind, go: !!i.go, status: i.status, statusWords: STATUS_WORDS[i.status] ?? i.status,
    at: iso(i.status_at), reading: i.reading ?? '', questions: parse(i.questions, []), assumptions: parse(i.assumptions, []), reason: i.reason ?? '',
    result: i.result ?? '', notProven: i.not_proven ?? '', note: i.note ?? '', line: i.line ?? '', ...(link ? { link } : {}), buttons: buttons(i),
  };
}

/** Waiting on you, Ready to check, Working, Queued, New, then Released, newest release first. Within a status the oldest comes first. */
export function todayOrder(list: TodayRow[]): TodayRow[] {
  return [...list].sort((a, b) => (RANK[a.status] ?? 9) - (RANK[b.status] ?? 9) || (a.status === 'released' ? b.id - a.id : a.id - b.id));
}

/**
 * The pass, decided in code. No model call and no command happens here. A plan with `skip` does nothing at all.
 * Overload means the 1-minute load average is above the number of CPU cores (The owner's call, 2026-11-04).
 */
export function decidePass(s: { items: TodayRow[]; load: number; cores: number; paused: boolean; now: number }): PassPlan {
  const base = { wake: [] as number[], start: [] as number[], gaveUp: [] as number[], load: s.load, cores: s.cores };
  if (s.paused) return { ...base, skip: 'paused' };
  if (s.load > s.cores) return { ...base, skip: 'overloaded' };
  const working = s.items.filter(i => i.status === 'working');
  let free = CAP - working.length, drafting = working.some(i => i.phase === 'draft');
  for (const i of s.items.filter(x => x.status === 'queued').sort((a, b) => a.id - b.id)) {
    if (free <= 0) break;
    if (i.phase === 'draft' && drafting) continue; // one story draft at a time; the next starts when the last finishes
    base.start.push(i.id);
    free--;
    if (i.phase === 'draft') drafting = true;
  }
  for (const i of s.items) {
    if (i.status !== 'new' || !i.owed) continue;
    const due = !i.told_at || s.now - time(i.told_at) >= BACKSTOP_MS;
    if (!due) continue;
    (i.tries >= MAX_TRIES ? base.gaveUp : base.wake).push(i.id);
  }
  return base.start.length || base.wake.length || base.gaveUp.length ? base : { ...base, skip: 'nothing' };
}

/** "Not proven:" in a worker's report, with whatever follows up to the next blank line. */
export function parseReport(subject: string, body: string): { result: string; notProven: string } {
  const m = /^[\s*_#-]*not proven[\s*_]*:[\s*_]*(.*(?:\n(?!\s*\n).*)*)/im.exec(body);
  const rest = m ? body.replace(m[0], '') : body;
  const first = rest.split(/\n\s*\n/).map(p => p.trim()).find(Boolean) ?? '';
  return { result: (first || subject || 'The worker reported no result.').slice(0, 600), notProven: m?.[1].trim() || 'The worker did not say what it left unproven.' };
}

const NUMBER = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
const count = (n: number) => NUMBER[n] ?? String(n);
/** "four items ready to check, two waiting on you", or empty when nothing needs the owner. */
export function morningLine(items: Pick<TodayRow, 'status'>[]): string {
  const ready = items.filter(i => i.status === 'ready').length, waiting = items.filter(i => i.status === 'waiting').length;
  return [ready ? `${count(ready)} ${ready === 1 ? 'item' : 'items'} ready to check` : '', waiting ? `${count(waiting)} waiting on you` : ''].filter(Boolean).join(', ');
}
const talkItems = (items: TodayRow[]) => items.filter(i => i.kind === 'talk' && i.status === 'waiting').map(i => i.title || i.words);

/** The lines for the brain's session brief. Empty when the list is empty. */
export function todayBrief(items: TodayRow[]): string {
  const open = todayOrder(items).filter(i => i.status !== 'released');
  if (!open.length) return '';
  return [`Today list (${morningLine(open) || `nothing needs ${OWNER}`}). Only his tap closes a row:`,
    ...open.slice(0, 20).map(i => `- [today] item=${i.id} ${i.status}${i.kind ? ` ${i.kind}` : ''}${i.go ? ' go' : ''}${i.dispatch ? ` dispatch=${i.dispatch}` : ''} ${JSON.stringify((i.title || i.words).slice(0, 120))}`)].join('\n');
}

/** The read-only worker that drafts a story, with prove-it in light mode. */
export function draftSpec(i: TodayRow): string {
  return `Read-only draft for ${OWNER}'s Today list. Do not edit, create or delete files, do not commit, do not open or change PRs or issues, do not run anything that changes state.

${OWNER_CAP}'s exact words:
${i.words}
${i.brief ? `\nJarvis's reading:\n${i.brief}\n` : ''}${i.note ? `\nOwner said the last draft was not right:\n${i.note}\n` : ''}
Run the repo's prove-it skill in light mode on this idea, if the repo has one, then draft it as a story. Report worker_done with these parts in the body: a title; the story text, ready to file as a GitHub issue, written as if your recommended answers stand; each open question with its choices and your recommended answer; your assumptions; what you checked and what was not proven. Jarvis reads this and writes it onto ${OWNER}'s list. You file nothing.`;
}

/** The worker for a task. The limits repeat in the spec, because Go never covers an outward action. */
export function runSpec(i: TodayRow): string {
  return `${i.spec}

This comes from ${OWNER}'s Today list. His exact words:
${i.words}
${i.note ? `\nYour earlier result was:\n${i.result ?? '(none)'}\n\nOwner tapped Not right and said:\n${i.note}\n` : ''}
Hard limits: send nothing to anyone, file no issues, open or merge no PRs, push nothing to a remote, change no client data. Do local work and commit on your own branch. If the job needs an outward step, leave it out and say so in your report: ${OWNER_CAP} decides those.

Report worker_done. The first paragraph of its body is one or two sentences on what happened. Then one line starting exactly "Not proven:" that says what you did not check. Say "Not proven: nothing" only if that is true.`;
}

/** Which skill runs an accepted story. Only AcmeApp has pick-and-ship-v3 today; FBM has plain pick-and-ship. */
export const storySkill = (repo: string) => existsSync(join(repo, '.claude', 'skills', 'pick-and-ship-v3')) ? 'pick-and-ship-v3' : 'pick-and-ship';
export const storyStartSpec = (n: string, skill: string) => `Run the ${skill} skill on issue #${n} (do not pick a different issue). ${OWNER_CAP} accepted this story from his Today list. Done when the PR is marked ready with its evidence, or you are blocked.${ISSUE_RULE}`;

export const issueUrlIn = (text: string | null | undefined) => /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+/.exec(text ?? '')?.[0];
const dispatchIn = (a: Approval): string | undefined => parse<{ dispatchId?: string }>(a.result, {}).dispatchId;

function questionsFrom(v: unknown): Question[] | string {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) return 'questions must be a list';
  const out: Question[] = [];
  for (const raw of v) {
    const q = typeof raw?.q === 'string' ? raw.q.trim() : '';
    if (!q) return 'each question needs q, its text';
    const options = Array.isArray(raw.options) ? raw.options.filter((o: unknown) => typeof o === 'string' && o.trim()).map((o: string) => o.trim()) : [];
    const recommended = raw.recommended ?? 0;
    if (options.length && !(Number.isInteger(recommended) && recommended >= 0 && recommended < options.length)) return `recommended must point at one of the options of: ${q}`;
    out.push({ q, options, recommended: options.length ? recommended : 0 });
  }
  return out;
}
const text = (v: unknown) => typeof v === 'string' ? v.trim() : '';

export function makeToday(o: {
  store: Store; gate: Pick<Gate, 'pressed'>; log: Log;
  /** Sends text to the brain. The pass's only model call. */
  wake: (text: string) => void;
  /** Repos a worker may run in: the project cards. */
  repos: () => { path: string }[];
  paused: () => boolean;
  onChange: () => void;
  /** Discuss now: the item's words go in the chat as the owner's. */
  discuss?: (words: string) => void;
  /** A released item with a worker behind it, so the brain can close the loop. */
  released?: (i: TodayRow) => void;
  load?: () => number; cores?: () => number; now?: () => number; skillFor?: (repo: string) => string;
}) {
  const { store, gate, log } = o;
  const now = o.now ?? Date.now, load = o.load ?? (() => loadavg()[0]), cores = o.cores ?? (() => cpus().length), skillFor = o.skillFor ?? storySkill;
  const accepting = new Set<number>(), starting = new Set<number>();
  let running = false, again = false;

  const list = () => todayOrder(store.todayItems()).map(i => todayView(i, store));
  const reply = (status: number, extra: object = {}): RouteResult => ({ status, body: { ...extra, today: list() } });
  const refuse = (status: number, error: string) => reply(status, { error });
  const changed = () => o.onChange();

  function failItem(id: number, reason: string) {
    store.setToday(id, { status: 'waiting', reason, phase: null, line: null, owed: null });
    log('today item failed', { item: id, reason });
  }

  async function startItem(id: number) {
    const i = store.todayItem(id);
    if (!i || !store.claimToday(id, 'queued', 'working')) return;
    starting.add(id);
    const draft = i.phase === 'draft';
    const title = (i.title || i.words).replace(/\s+/g, ' ').slice(0, 70);
    try {
      const args = draft ? { item: id, repo: i.repo, spec: draftSpec(i), taskTitle: `Draft: ${title}` }
        : { item: id, repo: i.repo, spec: runSpec(i), taskTitle: title, ...(i.worktree ? { worktree: i.worktree, keepOpen: true } : {}) };
      const a = await gate.pressed(draft ? 'today-draft' : 'today-start', args, `Today item ${id}: ${title}`);
      const dispatch = dispatchIn(a);
      if (a.status === 'done' && dispatch) {
        store.setToday(id, { dispatch, reason: null, line: draft ? 'Drafting the story' : 'Running', note: draft ? i.note : null });
        log('today item started', { item: id, dispatch, approval: a.id, draft });
      } else {
        failItem(id, a.status === 'unknown' ? `Orca lost the answer, so a worker may be running. Check the work list before trying again. ${a.result ?? ''}`.trim() : `The worker did not start: ${a.result ?? 'no reason given'}`);
        again = true;
      }
    } catch (e) {
      failItem(id, `The worker did not start: ${(e as Error).message}`);
      again = true;
    } finally { starting.delete(id); }
  }

  const passLine = (i: TodayRow) => {
    const head = `- item=${i.id} go=${!!i.go}${i.kind ? ` kind=${i.kind}` : ''} words=${JSON.stringify(i.words)}`;
    if (i.owed === 'draft') return `${head}\n  The draft worker finished. Write its work-up from this report: ${JSON.stringify((i.draft_report ?? '').slice(0, 6000))}`;
    if (i.owed === 'not-right') return `${head}\n  ${OWNER} tapped Not right on your work-up: ${JSON.stringify(i.note)}. Earlier reading: ${JSON.stringify(i.reading ?? '')}`;
    if (i.owed === 'answers') return `${head}\n  ${OWNER}'s answers changed the work-up: ${JSON.stringify(parse<Question[]>(i.questions, []).map(q => ({ q: q.q, answer: q.answer ?? q.options[q.recommended] })))}. Redo it. If the approach changed and a worker drafted it, send it back with jarvis-today draft instead of patching.`;
    if (i.owed === 'do') return `${head}\n  ${OWNER} tapped Do it, and this task has no spec yet. Write one from his answers: ${JSON.stringify(parse<Question[]>(i.questions, []).map(q => ({ q: q.q, answer: q.answer ?? q.options[q.recommended] })))}`;
    return `${head}${i.tries ? ' (told before, no work-up yet)' : ''}`;
  };

  /** One pass. Everything before `o.wake` and the worker starts is plain code, so nothing to do costs nothing. */
  async function pass(trigger: string): Promise<void> {
    if (running) { again = true; return; }
    running = true;
    try {
      do {
        again = false;
        const items = store.todayItems();
        const plan = decidePass({ items, load: load(), cores: cores(), paused: o.paused(), now: now() });
        store.setState('todayPass', JSON.stringify({ at: new Date(now()).toISOString(), trigger, ...plan }));
        log('today pass', { trigger, ...plan });
        if (plan.skip) break;
        for (const id of plan.gaveUp) failItem(id, `Jarvis was told ${MAX_TRIES} times and wrote no work-up. Try again, or ask in the chat.`);
        if (plan.wake.length) {
          const rows = plan.wake.map(id => items.find(i => i.id === id)!);
          for (const i of rows) store.setToday(i.id, { told_at: sqlTime(now()), tries: i.tries + 1 });
          o.wake(`[today pass] New on the Today list. Work each one up with jarvis-today (vault/CLAUDE.md, "Today list"). Reply SILENT unless a go item stopped on a question.\n${rows.map(passLine).join('\n')}`);
        }
        await Promise.all(plan.start.map(startItem));
        changed();
      } while (again);
    } finally { running = false; }
  }
  const soon = (trigger: string) => { pass(trigger).catch(e => log(`today pass: ${e}`)); };

  /** After each work poll: a worker that ended frees its slot, and its report goes on the row. */
  function sync(workers: { dispatch: string; outcome?: string; path?: string }[], complete: boolean) {
    const byDispatch = new Map(workers.map(w => [w.dispatch, w]));
    let freed = false, touched = false;
    for (const i of store.todayItems()) {
      if (i.status !== 'working') continue;
      if (!i.dispatch) {
        if (!starting.has(i.id) && now() - time(i.status_at) >= STUCK_MS) { failItem(i.id, 'Jarvis restarted while starting this. A worker may be running, so check the work list before trying again.'); freed = true; }
        continue;
      }
      const w = byDispatch.get(i.dispatch), r = store.requestOf(i.dispatch);
      // A later Not right reruns the worker in the same folder. A draft runs in the main checkout, which is not its own.
      if (w?.path && i.phase !== 'draft' && i.worktree !== `path:${w.path}`) { store.setToday(i.id, { worktree: `path:${w.path}` }); }
      const report = r ? requestReport(store, r.id) : undefined;
      const settled = !!w?.outcome && w.outcome !== 'in_progress';
      // A request the owner hid stops updating, so its worker is read directly. A hidden row must not hold a slot forever.
      const off = !r || !!r.hidden_at || !!r.removed_at;
      const over = r && !off ? ['done', 'review', 'failed'].includes(r.status) : !!report || settled || (complete && !w);
      if (!over) {
        const line = r?.status === 'waiting' ? 'Its worker is asking you something, see Requests' : i.phase === 'draft' ? 'Drafting the story' : 'Running';
        if (line !== i.line) { store.setToday(i.id, { line }); touched = true; }
        continue;
      }
      freed = true;
      if (r?.status === 'failed' || report?.failed) failItem(i.id, `The worker failed: ${report?.subject || 'it stopped before reporting'}`);
      else if (!report) failItem(i.id, 'The worker ended without reporting a result.');
      else if (i.phase === 'draft') {
        store.setToday(i.id, { status: 'new', phase: null, line: null, owed: 'draft', draft_report: `${report.subject}\n${report.body}`, told_at: null, tries: 0, reason: null });
        log('today draft finished', { item: i.id, dispatch: i.dispatch });
      } else {
        const p = parseReport(report.subject, report.body);
        const link = r?.pr_url ? { link: r.pr_url, link_label: r.pr ?? 'PR' } : { link: `#report/${report.id}`, link_label: 'Report' };
        store.setToday(i.id, { status: 'ready', phase: null, line: null, result: p.result, not_proven: p.notProven, reason: null, ...link });
        log('today item ready', { item: i.id, dispatch: i.dispatch });
      }
    }
    if (freed || touched) changed();
    if (freed) soon('slot freed');
  }

  /** Accept: the one tap that files the issue and starts the story. Each step is recorded, so a retry or a crash never files twice. */
  async function accept(i: TodayRow): Promise<RouteResult> {
    const story = parse<Story | null>(i.story, null);
    if (!story || !i.repo) return refuse(409, 'This story has no draft to file yet.');
    if (accepting.has(i.id)) return refuse(409, 'That is already going through.');
    accepting.add(i.id);
    try {
      let url = i.issue_url ?? undefined;
      if (!url) {
        const prior = store.todayIssueApproval(i.id);
        url = issueUrlIn(prior?.result);
        if (prior && !url) {
          const reason = 'Filing the issue may have gone through, but no link came back. Check GitHub. Jarvis will not file it twice.';
          store.setToday(i.id, { issue_state: 'unknown', reason });
          changed();
          return refuse(409, reason);
        }
        if (!url) {
          const a = await gate.pressed('today-issue', { item: i.id, repo: story.github, title: story.title, body: story.body }, `File the issue: ${story.title.slice(0, 80)}`);
          url = issueUrlIn(a.result);
          if (!url) {
            const lost = a.status !== 'failed';
            const reason = lost ? 'Filing the issue may have gone through, but no link came back. Check GitHub. Jarvis will not file it twice.' : `The issue was not filed: ${a.result ?? 'no reason given'}`;
            store.setToday(i.id, { reason, ...(lost ? { issue_state: 'unknown' } : {}) });
            changed();
            return refuse(502, reason);
          }
        }
        store.setToday(i.id, { issue_url: url, issue_state: 'filed' });
        log('today issue filed', { item: i.id, url });
      }
      const n = url.split('/').pop()!;
      const a = await gate.pressed('today-start', { item: i.id, repo: i.repo, spec: storyStartSpec(n, skillFor(i.repo)), taskTitle: `#${n} ${story.title.slice(0, 70)}` }, `Start #${n}: ${story.title.slice(0, 80)}`);
      const dispatch = dispatchIn(a);
      if (a.status !== 'done' || !dispatch) {
        const lost = a.status !== 'failed';
        const reason = `Issue #${n} is filed. ${lost ? 'Orca lost the answer, so a worker may be running. Check the work list.' : `The worker did not start, and Accept will try only that again: ${a.result ?? 'no reason given'}`}`;
        store.setToday(i.id, { reason, ...(lost ? { issue_state: 'unknown' } : {}) });
        changed();
        return refuse(502, reason);
      }
      store.setToday(i.id, { status: 'moved', dispatch, reason: null, owed: null });
      log('today story accepted', { item: i.id, issue: n, dispatch });
      changed();
      return reply(200, { moved: { number: Number(n), url } });
    } catch (e) {
      store.setToday(i.id, { reason: (e as Error).message });
      changed();
      return refuse(502, (e as Error).message);
    } finally { accepting.delete(i.id); }
  }

  /** Back to the brain. It shows as New until Jarvis reaches it. */
  const owe = (id: number, owed: string, f: Parameters<Store['setToday']>[1] = {}) =>
    store.setToday(id, { status: 'new', owed, told_at: null, tries: 0, reason: null, ...f });

  const api = {
    list,
    pass,
    sync,
    /** the owner's words, from the popup or (through the brain) the chat. The same words still New return that row, so a retry adds nothing. */
    add(b: { words?: unknown; go?: unknown }): RouteResult {
      const words = text(b.words);
      if (!words) return refuse(400, 'Say or type something first.');
      if (words.length > 8000) return refuse(400, 'That is longer than a thought. Put it in the chat.');
      const same = store.todayItems().find(i => i.words === words && i.status === 'new');
      if (same) return reply(200, { item: todayView(same, store), existing: true });
      const row = store.addToday(words, b.go === true);
      log('today item added', { item: row.id, go: b.go === true });
      changed();
      soon('item added');
      return reply(200, { item: todayView(row, store) });
    },
    /** A tap from the app. Only what `buttons` offers on the row's current status goes through. */
    async act(b: { id?: unknown; action?: unknown; note?: unknown; kind?: unknown; answers?: unknown }): Promise<RouteResult> {
      const i = store.todayItem(Number(b.id));
      if (!i || i.status === 'dropped' || i.status === 'moved') return refuse(404, 'That item is not on the list any more.');
      const action = String(b.action ?? '');
      if (action === 'kind') return api.setKind(i, b.kind);
      if (action === 'answers') return api.saveAnswers(i, b.answers);
      if (!buttons(i).includes(action)) return refuse(409, `"${action}" is not open on this item now. It is ${STATUS_WORDS[i.status] ?? i.status}.`);
      if ((action === 'accept' || action === 'do') && Array.isArray(b.answers) && differs(i, b.answers)) return refuse(409, 'An answer changed, so the draft no longer matches. Send the answers first.');
      switch (action) {
        case 'accept': return accept(i);
        case 'do':
          store.setToday(i.id, { go: 1, reason: null });
          if (i.spec && i.repo) store.setToday(i.id, { status: 'queued', phase: null, owed: null });
          else owe(i.id, 'do');
          changed();
          soon('do it');
          return reply(200);
        case 'discuss':
          o.discuss?.(i.words);
          log('today item discussed', { item: i.id });
          return reply(200);
        case 'drop':
          store.setToday(i.id, { status: 'dropped', owed: null, phase: null });
          log('today item dropped', { item: i.id, was: i.status });
          changed();
          soon('slot freed');
          return reply(200);
        case 'release':
          store.setToday(i.id, { status: 'released', released_at: sqlTime(now()) });
          log('today item released', { item: i.id });
          o.released?.(store.todayItem(i.id)!);
          changed();
          return reply(200);
        case 'retry':
          owe(i.id, 'new', { phase: null, line: null });
          changed();
          soon('retry');
          return reply(200);
        case 'not-right': {
          const note = text(b.note);
          if (!note) return refuse(400, 'Say what is not right first.');
          // A finished run goes back to work with the note, in its own folder. Anything else goes back to Jarvis.
          if (i.status === 'ready' && i.spec && i.repo) store.setToday(i.id, { status: 'queued', phase: null, note, reason: null, owed: null });
          else owe(i.id, 'not-right', { note });
          log('today item not right', { item: i.id });
          changed();
          soon('not right');
          return reply(200);
        }
      }
      return refuse(400, `unknown action ${action}`);
    },
    /** the owner changed the kind. A kind whose path needs a work-up it does not have goes back to Jarvis. */
    setKind(i: TodayRow, kind: unknown): RouteResult {
      if (i.status !== 'new' && i.status !== 'waiting') return refuse(409, 'The kind can change only before work starts.');
      if (!KINDS.includes(String(kind))) return refuse(400, 'kind must be story, task or talk');
      store.setToday(i.id, { kind: String(kind) });
      if (kind === 'talk') store.setToday(i.id, { status: 'waiting', owed: null, reason: null });
      else if (i.status === 'waiting' && !(kind === 'story' ? i.story : i.spec)) { owe(i.id, 'kind'); soon('kind changed'); }
      changed();
      return reply(200);
    },
    /** An answer other than the recommended one changes the draft, so it goes back rather than being filed as written. */
    saveAnswers(i: TodayRow, answers: unknown): RouteResult {
      if (i.status !== 'waiting') return refuse(409, 'Answers go on an item that is waiting on you.');
      if (!Array.isArray(answers)) return refuse(400, 'answers must be a list');
      const qs = parse<Question[]>(i.questions, []).map((q, n) => ({ ...q, ...(text(answers[n]) ? { answer: text(answers[n]) } : {}) }));
      owe(i.id, 'answers', { questions: JSON.stringify(qs) });
      changed();
      soon('answers');
      return reply(200);
    },
    /** `jarvis-today workup`. The brain's work-up, with the rules on what it may do with a go item. */
    workup(id: number, b: any): RouteResult {
      const i = store.todayItem(id);
      if (!i) return refuse(404, `no today item ${id}`);
      if (i.status !== 'new' && i.status !== 'waiting') return refuse(409, `Item ${id} is ${i.status}. A work-up goes on a new or waiting item.`);
      const kind = String(b?.kind ?? '');
      if (!KINDS.includes(kind)) return refuse(400, 'kind must be story, task or talk');
      const reading = text(b.reading);
      if (!reading) return refuse(400, 'reading is required: two or three lines');
      const questions = questionsFrom(b.questions);
      if (typeof questions === 'string') return refuse(400, questions);
      const go = !!i.go;
      if (go && questions.length > 1) return refuse(400, 'A go item stops on one question. Ask the one that matters and assume the rest.');
      const repo = text(b.repo), spec = text(b.spec);
      if ((repo || spec || kind === 'story') && !o.repos().some(r => r.path === repo)) return refuse(400, `repo must be one of ${o.repos().map(r => r.path).join(', ')}`);
      let story: Story | undefined;
      if (kind === 'story') {
        story = { github: text(b.story?.github), title: text(b.story?.title), body: text(b.story?.body) };
        if (!/^[\w.-]+\/[\w.-]+$/.test(story.github) || !story.title || !story.body) return refuse(400, 'a story needs story.github (owner/name), story.title and story.body. A repo with no GitHub remote, like Jarvis, is a task.');
      }
      if (kind === 'task' && !spec && !questions.length) return refuse(400, 'a task needs repo and spec, or a question to ask first');
      if (kind === 'task' && spec && !repo) return refuse(400, 'a task with a spec needs repo');
      const assumptions = Array.isArray(b.assumptions) ? b.assumptions.map(text).filter(Boolean) : [];
      // Go starts only when Jarvis can write the spec without guessing. A story or a talk always stops for the owner.
      const queued = go && kind === 'task' && !!spec && !questions.length;
      store.setToday(id, {
        kind, title: text(b.title) || null, reading, questions: JSON.stringify(questions), assumptions: JSON.stringify(assumptions),
        repo: repo || null, spec: spec || null, story: story ? JSON.stringify(story) : null,
        status: queued ? 'queued' : 'waiting', phase: null, owed: null, told_at: null, tries: 0, reason: null, note: null, draft_report: null,
      });
      log('today work-up', { item: id, kind, queued });
      changed();
      if (queued) soon('work-up');
      return reply(200, { item: todayView(store.todayItem(id)!, store) });
    },
    /** `jarvis-today draft`. The item needs code read, so a read-only worker drafts it. One runs at a time. */
    draft(id: number, b: any): RouteResult {
      const i = store.todayItem(id);
      if (!i) return refuse(404, `no today item ${id}`);
      if (i.status !== 'new' && i.status !== 'waiting') return refuse(409, `Item ${id} is ${i.status}. A draft goes on a new or waiting item.`);
      const repo = text(b?.repo);
      if (!o.repos().some(r => r.path === repo)) return refuse(400, `repo must be one of ${o.repos().map(r => r.path).join(', ')}`);
      store.setToday(id, { kind: i.kind ?? 'story', status: 'queued', phase: 'draft', repo, brief: text(b.brief) || null, title: text(b.title) || i.title, owed: null, told_at: null, tries: 0, reason: null });
      log('today draft queued', { item: id });
      changed();
      soon('draft');
      return reply(200, { item: todayView(store.todayItem(id)!, store) });
    },
    /** `jarvis-today answer`. The owner answered in the chat, so the row shows it too. The brain then writes the new work-up. */
    answer(id: number, b: any): RouteResult {
      const i = store.todayItem(id);
      if (!i) return refuse(404, `no today item ${id}`);
      const qs = parse<Question[]>(i.questions, []), n = Number(b?.question), answer = text(b?.text);
      if (!qs[n]) return refuse(400, `item ${id} has no question ${b?.question}`);
      if (!answer) return refuse(400, '--text is required');
      qs[n].answer = answer;
      const same = answer === qs[n].options[qs[n].recommended];
      if (same) store.setToday(id, { questions: JSON.stringify(qs) });
      else owe(id, 'answers', { questions: JSON.stringify(qs) }); // the timer catches it if the brain never writes the new work-up
      log('today answer from the chat', { item: id, question: n });
      changed();
      return reply(200, { item: todayView(store.todayItem(id)!, store) });
    },
    /** `jarvis-today result`. Jarvis did it without a worker. It still waits for the owner's Release. */
    result(id: number, b: any): RouteResult {
      const i = store.todayItem(id);
      if (!i) return refuse(404, `no today item ${id}`);
      if (i.status !== 'new' && i.status !== 'waiting') return refuse(409, `Item ${id} is ${i.status}.`);
      const result = text(b?.result), notProven = text(b?.notProven), link = text(b?.link);
      if (!result || !notProven) return refuse(400, 'result and not-proven are both required');
      store.setToday(id, { status: 'ready', kind: i.kind ?? 'task', result, not_proven: notProven, link: link || null, link_label: link ? 'Link' : null, owed: null, reason: null, told_at: null, tries: 0 });
      log('today result from the brain', { item: id });
      changed();
      return reply(200, { item: todayView(store.todayItem(id)!, store) });
    },
    /** Once a day after 8 AM Eastern: one line and the talk items. Nothing to say means no model call. */
    morning() {
      if (o.paused()) return;
      const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: QUIET_HOURS.zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(now()).map(p => [p.type, p.value]));
      const day = `${parts.year}-${parts.month}-${parts.day}`;
      if (Number(parts.hour) < MORNING_HOUR || store.getState('todayMorning') === day) return;
      store.setState('todayMorning', day);
      const items = store.todayItems(), line = morningLine(items), talk = talkItems(items);
      if (!line && !talk.length) return;
      log('today morning line', { line });
      o.wake(`[today brief] Say this once, in one or two sentences: ${line || 'nothing to check'}.${talk.length ? ` To talk about: ${talk.map(t => JSON.stringify(t)).join(', ')}.` : ''}`);
    },
    /** The half-hour timer. */
    tick() { api.morning(); return pass('timer'); },
  };

  function differs(i: TodayRow, answers: unknown[]): boolean {
    return parse<Question[]>(i.questions, []).some((q, n) => { const a = text(answers[n]); return !!a && a !== (q.answer ?? q.options[q.recommended]); });
  }
  return api;
}
export type Today = ReturnType<typeof makeToday>;

/**
 * The routes. `/api/today/*` act as the owner and sit behind the open-page secret in main.ts. `/api/internal/today*` is what the
 * brain's CLI calls: it can add, write a work-up, ask for a draft, record a chat answer or a result. It has no route to release, drop, accept or run.
 * Undefined when the URL is not one of these.
 */
export async function todayRoute(t: Today, method: string, url: string, b: any, ctx: { fromOwner: () => boolean }): Promise<RouteResult | undefined> {
  if (method === 'GET' && (url === '/api/today' || url === '/api/internal/today')) return { status: 200, body: { today: t.list() } };
  if (method !== 'POST') return undefined;
  if (url === '/api/today/add') return t.add(b);
  if (url === '/api/today/act') return t.act(b);
  if (url === '/api/internal/today') {
    // Go is the owner's yes to start a worker, so the brain can set it only in a turn that holds a message from him.
    if (b?.go === true && !ctx.fromOwner()) return { status: 409, body: { error: `Go needs ${OWNER} saying so in this turn. Add it without --go.` } };
    return t.add(b);
  }
  const m = /^\/api\/internal\/today\/(\d+)\/(workup|draft|answer|result)$/.exec(url);
  if (!m) return undefined;
  const id = Number(m[1]);
  return m[2] === 'workup' ? t.workup(id, b) : m[2] === 'draft' ? t.draft(id, b) : m[2] === 'answer' ? t.answer(id, b) : t.result(id, b);
}
