import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, findPr, makeWorkPoller, passedStopNotices, duplicateStopNotices, IDLE_MS, STOP_SETTLE_MS, type Work, type WorkRow, type WorkerInfo } from './work.ts';

test('tasks sort into stories, babysitters, side chats and other', () => {
  assert.deepEqual(classify('pick-and-ship #4460'), { group: 'story', label: '#4460' });
  assert.deepEqual(classify('Fix onboarding', 'Run the pick-and-ship skill on issue #4412.'), { group: 'story', label: '#4412' });
  assert.deepEqual(classify('babysit PR #4533'), { group: 'babysit', label: 'PR #4533' });
  assert.deepEqual(classify('Drive it', 'Babysit https://github.com/o/r/pull/77 to READY'), { group: 'babysit', label: 'PR #77' });
  assert.deepEqual(classify('Side chat: why is #4460 slow?'), { group: 'side' });
  assert.deepEqual(classify('Question: why is the build slow'), { group: 'other' });
  assert.deepEqual(classify('issue-4531-screens'), { group: 'story', label: '#4531' });
  assert.deepEqual(classify('MANAGER', 'You have 1 orchestration message.'), { group: 'other' });
});

test('a finished worker\'s PR is a link when it wrote one, otherwise a number', () => {
  assert.deepEqual(findPr('Shipped, see https://github.com/o/r/pull/12 for it'), { pr: 'PR #12', url: 'https://github.com/o/r/pull/12' });
  assert.deepEqual(findPr('#4460 READY: PR #4533'), { pr: 'PR #4533' });
  assert.deepEqual(findPr('nothing here'), {});
});

const worker = (dispatchId: string, runId: string, outcome: string, extra: object = {}) => ({
  dispatchId, taskId: `task_${dispatchId}`, runId, agentTerminalHandle: `structworker_${dispatchId}`,
  resource: { worktreeId: `repo::/w/${dispatchId}` }, projection: { outcome, liveness: { verdict: 'live' } }, ...extra,
});

function fakeOrca() {
  const state = {
    workers: [] as object[],
    tasks: {} as Record<string, object[]>,
    parked: new Set<string>(),
    transcript: {} as Record<string, { timestamp: number }[]>,
    worktrees: [] as object[],
    terminals: [] as object[],
    calls: [] as string[],
    /** Orca answers with the concise row even with --full. */
    concise: false,
  };
  const orca = async (args: string[]) => {
    state.calls.push(args.join(' '));
    const flag = (f: string) => args[args.indexOf(f) + 1];
    if (args[1] === 'run-list') return { ok: true, result: { runs: [...new Set(state.workers.map((w: any) => w.runId)), 'run_legacy_local'].map(id => ({ id, legacy: id === 'run_legacy_local' ? 1 : 0 })) } };
    // Orca 1.4.246 prints a concise row without `projection` unless asked for --full.
    if (args[1] === 'worker-list') {
      const full = args.includes('--full') && !state.concise;
      return { ok: true, result: { workers: state.workers.filter((w: any) => w.runId === flag('--run')).map((w: any) => full ? w : { dispatchId: w.dispatchId, outcome: w.projection?.outcome }) } };
    }
    if (args[0] === 'worktree') return { ok: true, result: { worktrees: state.worktrees } };
    if (args[0] === 'terminal') return { ok: true, result: { terminals: state.terminals } };
    if (args[1] === 'task-list') return { ok: true, result: { tasks: state.tasks[flag('--run')] ?? [] } };
    if (args[1] === 'worker-show') return { ok: true, result: { observation: state.parked.has(flag('--dispatch')) ? { agentWait: { evidence: 'hook' } } : { status: 'live' } } };
    if (args[1] === 'worker-read') {
      const all = state.transcript[flag('--dispatch')] ?? [];
      const from = args.includes('--cursor') ? Number(flag('--cursor')) : 0;
      return { ok: true, result: { transcript: { messages: all.slice(from), nextCursor: String(all.length), limited: false } } };
    }
    return { ok: false, error: { code: 'unexpected', message: args.join(' ') } };
  };
  return { state, orca };
}

test('the work list groups live workers, marks the ones waiting on the owner, and announces only new completions', async () => {
  const { state, orca } = fakeOrca();
  let clock = Date.parse('2026-10-30T12:00:00Z');
  const changes: Work[] = [];
  const asks = new Map<string, string>();
  const poller = makeWorkPoller({
    orca, log: () => {}, jarvisRun: 'run_j', openAsks: () => asks, onChange: w => changes.push(w),
    now: () => clock, repoOf: async dir => dir === '/w/d_old2' ? 'https://github.com/o/r' : undefined,
  });
  state.workers = [
    worker('d_story', 'run_xa', 'in_progress'),
    worker('d_baby', 'run_xa', 'in_progress'),
    worker('d_side', 'run_j', 'in_progress'),
    worker('d_old', 'run_xa', 'succeeded'),
  ];
  state.tasks.run_xa = [
    { id: 'task_d_story', task_title: 'pick-and-ship #4460' },
    { id: 'task_d_baby', task_title: 'babysit PR #4533' },
    { id: 'task_d_old', task_title: '#1 old', result: JSON.stringify({ subject: 'old' }) },
  ];
  state.tasks.run_j = [{ id: 'task_d_side', task_title: 'Side chat: why is staging slow?' }];
  asks.set('d_story', 'Skip the Muse step?');
  state.parked.add('d_baby');

  const first = await poller.poll();
  assert.deepEqual(first.rows.map(r => [r.dispatch, r.group, r.label, r.state]), [
    ['d_story', 'story', '#4460', 'waiting'],
    ['d_baby', 'babysit', 'PR #4533', 'waiting'],
    ['d_side', 'side', undefined, 'working'],
  ]);
  assert.equal(first.rows[0].note, 'Skip the Muse step?');
  assert.equal(first.rows[2].title, 'why is staging slow?');
  assert.equal(first.rows[2].sideChat, true);
  assert.equal(first.rows[0].sideChat, false);
  assert.equal(first.rows[0].worktree, 'd_story');
  assert.deepEqual(first.done, [], 'a worker that finished before the first poll is not announced');
  assert.equal(changes.length, 1);

  // Nothing changed: no new event.
  await poller.poll();
  assert.equal(changes.length, 1);

  // The story finishes and names its PR by number; the checkout's remote turns it into a link.
  state.workers = [worker('d_side', 'run_j', 'in_progress'), worker('d_old2', 'run_xa', 'succeeded'), worker('d_old', 'run_xa', 'succeeded')];
  state.tasks.run_xa.push({ id: 'task_d_old2', task_title: 'pick-and-ship #9', result: JSON.stringify({ subject: '#9 READY: PR #12', body: 'done' }) });
  const second = await poller.poll();
  assert.deepEqual(second.rows.map(r => r.dispatch), ['d_side']);
  assert.deepEqual(second.done.map(d => [d.subject, d.pr, d.url]), [['#9 READY: PR #12', 'PR #12', 'https://github.com/o/r/pull/12']]);
  await poller.poll();
  assert.equal(poller.current().done.length, 1, 'announced once');

  // A side chat with no message for an hour offers to close.
  clock += IDLE_MS + 60_000;
  const third = await poller.poll();
  assert.equal(third.rows[0].state, 'idle');
  assert.equal(third.rows[0].note, 'Idle 1 h');
  state.transcript.d_side = [{ timestamp: clock - 1000 }];
  assert.equal((await poller.poll()).rows[0].state, 'working', 'a new message resets the idle clock');
});

test('workers are read with --full, and a list without projections is an Orca failure, not an empty one', async () => {
  const { state, orca } = fakeOrca();
  state.workers = [{ dispatchId: 'ctx_1', taskId: 't1', runId: 'run_j', projection: { outcome: 'in_progress', liveness: { verdict: 'live' } } }];
  state.tasks.run_j = [{ id: 't1', task_title: 'Build it' }];
  const polled: [string[], boolean][] = [];
  const work = makeWorkPoller({ orca, log: () => {}, jarvisRun: 'run_j', openAsks: () => new Map(), onChange: () => {}, onPolled: (_w, ws, complete) => polled.push([ws.map(x => `${x.dispatch} ${x.outcome}`), complete]) });
  assert.deepEqual((await work.poll()).rows.map(r => r.title), ['Build it']);
  assert.deepEqual(polled, [[['ctx_1 in_progress'], true]]);
  state.concise = true;
  const w = await work.poll();
  assert.equal(w.error, 'Orca: worker-list failed');
  assert.deepEqual(w.rows.map(r => r.title), ['Build it']); // the last list stays
  assert.equal(polled.length, 1); // requests are not told the worker vanished
});

test('a Run whose list failed makes the poll incomplete, and every page of a long list is read', async () => {
  const lists: Record<string, any> = {
    run_xa: [{ ok: true, result: { workers: [{ dispatchId: 'ctx_1', taskId: 't', runId: 'run_xa', projection: { outcome: 'succeeded' } }], nextCursor: 'c2' } },
      { ok: true, result: { workers: [{ dispatchId: 'ctx_2', taskId: 't', runId: 'run_xa', projection: { outcome: 'succeeded' } }] } }],
    run_xb: [{ ok: false, error: { code: 'boom', message: '' } }],
  };
  const orca = async (args: string[]) => {
    if (args[1] === 'run-list') return { ok: true, result: { runs: [{ id: 'run_xa' }, { id: 'run_xb' }] } };
    if (args[1] === 'worker-list') return lists[args[args.indexOf('--run') + 1]].shift();
    if (args[1] === 'task-list') return { ok: true, result: { tasks: [] } };
    if (args[0] === 'worktree') return { ok: true, result: { worktrees: [] } };
    return { ok: true, result: { terminals: [] } };
  };
  let seen: { ids: string[]; complete: boolean } | undefined;
  const work = makeWorkPoller({ orca, log: () => {}, jarvisRun: 'run_xa', openAsks: () => new Map(), onChange: () => {}, onPolled: (_w, ws, complete) => { seen = { ids: ws.map(x => x.dispatch), complete }; } });
  await work.poll();
  assert.deepEqual(seen, { ids: ['ctx_1', 'ctx_2'], complete: false });
});

test('a side-chat title from another Run is not closable here', async () => {
  const { state, orca } = fakeOrca();
  state.workers = [worker('d_x', 'run_other', 'in_progress')];
  state.tasks.run_other = [{ id: 'task_d_x', task_title: 'Side chat: someone else' }];
  const poller = makeWorkPoller({ orca, log: () => {}, jarvisRun: 'run_j', openAsks: () => new Map(), onChange: () => {} });
  assert.equal((await poller.poll()).rows[0].sideChat, false);
});

test('when Orca does not answer, the last list stays with an error', async () => {
  const { state, orca } = fakeOrca();
  state.workers = [worker('d_1', 'run_xa', 'in_progress')];
  let down = false;
  const poller = makeWorkPoller({
    orca: async a => down && a[1] === 'run-list' ? { ok: false, error: { code: 'runtime_unavailable', message: '' } } : orca(a),
    log: () => {}, jarvisRun: 'run_j', openAsks: () => new Map(), onChange: () => {},
  });
  await poller.poll();
  down = true;
  const w = await poller.poll();
  assert.equal(w.rows.length, 1);
  assert.equal(w.error, 'Orca: runtime_unavailable');
});

test('sessions no Run dispatched are listed beside the workers; a worker\'s own chat is not listed twice', async () => {
  const { state, orca } = fakeOrca();
  const clock = Date.parse('2026-10-30T12:00:00Z');
  state.workers = [
    worker('d_w', 'run_xa', 'in_progress', { resource: { worktreeId: 'r::/w/mine', endpointIncarnation: 'structured:abc' } }),
    worker('d_done', 'run_xa', 'succeeded', { resource: { worktreeId: 'r::/w/issue-4498', endpointIncarnation: 'structured:claude_44' } }),
  ];
  state.tasks.run_xa = [{ id: 'task_d_w', task_title: 'babysit #4521' }];
  const agent = (paneKey: string, state: string, hoursAgo: number, extra = {}) => ({ paneKey, state, agentType: 'claude', updatedAt: clock - hoursAgo * 3_600_000, lastAssistantMessage: 'Both #4531 dispatches are now marked abandoned.', ...extra });
  state.worktrees = [
    { path: '/w/mine', displayName: 'mine', agents: [agent('structured-agent-session-abc:leaf', 'working', 0)] },
    { path: '/w/tern', displayName: 'MANAGER', agents: [agent('structured-agent-session-claude_88f0:leaf', 'done', 2)] },
    { path: '/w/issue-4498', displayName: 'issue-4498', linkedPR: { number: 4532 }, agents: [agent('structured-agent-session-claude_44:leaf', 'blocked', 30)] },
    { path: '/w/abmoto', displayName: 'Migration abmoto', agents: [agent('bfa8:ab46', 'working', 1)] },
    { path: '/w/old', displayName: 'old', agents: [agent('structured-agent-session-old:leaf', 'done', 72)] },
    { path: '/w/gone', displayName: 'gone', isArchived: true, agents: [agent('structured-agent-session-gone:leaf', 'working', 0)] },
  ];
  state.terminals = [{ handle: 'term_db', recordedPaneKey: 'bfa8:ab46', agentIdentity: 'claude' }];
  const poller = makeWorkPoller({ orca, log: () => {}, jarvisRun: 'run_j', openAsks: () => new Map(), onChange: () => {}, now: () => clock });
  const w = await poller.poll();
  assert.deepEqual(w.rows.map(r => [r.id, r.kind, r.group, r.label, r.pr, r.state, r.steer]), [
    ['d_w', 'worker', 'babysit', 'PR #4521', undefined, 'working', 'card'],
    ['s:claude_88f0', 'session', 'other', undefined, undefined, 'idle', 'resume'],
    ['s:claude_44', 'session', 'story', '#4498', 'PR #4532', 'waiting', 'resume'],
    ['s:bfa8:ab46', 'session', 'other', undefined, undefined, 'working', 'type'],
  ]);
  assert.equal(w.rows[1].note, 'Done 2 h ago');
  assert.equal(Date.parse(w.rows[1].endedAt!), clock - 2 * 3_600_000, 'a Done session carries its finish time for the Done fold');
  assert.equal(w.rows[0].endedAt, undefined, 'a working row has no finish time');
  assert.equal(w.rows[3].terminal, 'term_db');
  assert.deepEqual(poller.source('s:claude_88f0'), { kind: 'chat', key: 'claude_88f0', cwd: '/w/tern', query: 'Both 4531 dispatches are now marked abandoned' });
  const typed = poller.source('s:bfa8:ab46') as any;
  assert.deepEqual([typed.kind, typed.handle, typed.chat.key, typed.chat.cwd, typeof typed.chat.probe], ['terminal', 'term_db', 'bfa8:ab46', '/w/abmoto', 'string']);
  assert.deepEqual(poller.source('d_w'), { kind: 'worker', dispatch: 'd_w', chat: { key: 'abc', cwd: '/w/mine', query: 'Both 4531 dispatches are now marked abandoned' } });
  assert.ok(!state.calls.some(c => c.includes('run_legacy_local')), 'the legacy Run is not listed');
});

test('a session that is not busy gets no row once its PR is merged or closed or its workspace is completed', async () => {
  const { state, orca } = fakeOrca();
  const clock = Date.parse('2026-11-04T12:00:00Z');
  const tree = (name: string, agentState: string, extra: object, agentExtra: object = {}) => ({
    path: `/w/${name}`, displayName: name, ...extra,
    agents: [{ paneKey: `structured-agent-session-${name}:leaf`, state: agentState, agentType: 'claude', updatedAt: clock - 3_600_000, ...agentExtra }],
  });
  state.worktrees = [
    // Finished work, idle: story 4615's goatfish showed "Done 40 h ago" with PR 4651 merged.
    tree('merged', 'done', { linkedPR: { number: 4651, state: 'merged' }, workspaceStatus: 'in-progress' }),
    tree('closed', 'done', { linkedPR: { number: 2, state: 'closed' }, workspaceStatus: 'in-progress' }),
    tree('completed', 'done', { linkedPR: null, workspaceStatus: 'completed' }),
    tree('completed-open', 'done', { linkedPR: { number: 3, state: 'open' }, workspaceStatus: 'completed' }),
    // Finished work, still busy: nothing running disappears.
    tree('merged-working', 'working', { linkedPR: { number: 4, state: 'merged' }, workspaceStatus: 'completed' }),
    tree('merged-monitoring', 'working', { linkedPR: { number: 5, state: 'merged' } }, { workingMode: 'monitoring' }),
    tree('closed-blocked', 'blocked', { linkedPR: { number: 6, state: 'closed' }, workspaceStatus: 'completed' }),
    tree('completed-waiting', 'waiting', { workspaceStatus: 'completed' }),
    // Unfinished work, idle: the row stays.
    tree('open', 'done', { linkedPR: { number: 7, state: 'open' }, workspaceStatus: 'in-progress' }),
    tree('draft', 'done', { linkedPR: { number: 8, state: 'draft' }, workspaceStatus: 'in-progress' }),
    tree('no-pr', 'done', { workspaceStatus: 'in-progress' }),
  ];
  const poller = makeWorkPoller({ orca, log: () => {}, jarvisRun: 'run_j', openAsks: () => new Map(), onChange: () => {}, now: () => clock });
  const w = await poller.poll();
  assert.deepEqual(w.rows.map(r => [r.title, r.state]), [
    ['merged-working', 'working'],
    ['merged-monitoring', 'idle'],
    ['closed-blocked', 'waiting'],
    ['completed-waiting', 'waiting'],
    ['open', 'idle'],
    ['draft', 'idle'],
    ['no-pr', 'idle'],
  ]);
  assert.equal(poller.source('s:merged'), undefined, 'a dropped row has no transcript source');
  assert.deepEqual(poller.source('s:open'), { kind: 'chat', key: 'open', cwd: '/w/open', query: '' });
});

test('a row Orca called gone stays off the list while Orca still lists it, and is forgotten once Orca drops it', async () => {
  const { state, orca } = fakeOrca();
  state.workers = [worker('d_dead', 'run_j', 'in_progress'), worker('d_live', 'run_j', 'in_progress')];
  state.tasks.run_j = [{ id: 'task_d_dead', task_title: 'Side chat: test' }, { id: 'task_d_live', task_title: 'Side chat: other' }];
  const saved: string[][] = [];
  const poller = makeWorkPoller({ orca, log: () => {}, jarvisRun: 'run_j', openAsks: () => new Map(), onChange: () => {}, onGone: ids => saved.push(ids) });
  await poller.poll();
  assert.deepEqual(poller.drop('d_dead').rows.map(r => r.id), ['d_live']);
  assert.deepEqual((await poller.poll()).rows.map(r => r.id), ['d_live'], 'Orca still lists it as in progress');
  assert.deepEqual(saved.at(-1), ['d_dead']);
  state.workers = [worker('d_live', 'run_j', 'in_progress')];
  await poller.poll();
  assert.deepEqual(saved.at(-1), [], 'forgotten once Orca stops listing it');

  const restarted = makeWorkPoller({ orca, log: () => {}, jarvisRun: 'run_j', openAsks: () => new Map(), onChange: () => {}, gone: ['d_live'] });
  assert.deepEqual((await restarted.poll()).rows, [], 'the saved ids hold after a restart');
});

// Shapes from Orca 2026-10-30: `worker-list`, `worktree ps` and `terminal list` as they came back for these workspaces.
test('the work list shows each running agent once, and drops chats whose work is over', async () => {
  const { state, orca } = fakeOrca();
  const clock = 1793389575706;
  const h = (n: number) => clock - n * 3_600_000;
  const engine = '/Users/owner/orca/workspaces/acmeapp_nextjs/issue-4531-engine';
  const sandworm = '/Users/owner/orca/workspaces/jarvis/sandworm';
  const staging = '/Users/owner/Repos/acmeapp_nextjs';
  const wt = (path: string) => `00000000-0000-4000-9000-000000000001::${path}`;
  state.workers = [
    // A terminal worker: its incarnation is `<worktreeId>@@<pty>:<incarnation>`, not `structured:<id>`.
    worker('ctx_000000000001', 'run_xample01', 'in_progress', {
      agentTerminalHandle: 'term_00000000-0000-4000-a000-000000000002',
      resource: { worktreeId: wt(engine), endpointIncarnation: `${wt(engine)}@@a13f2d72:00000000-0000-4000-9000-000000000002` },
    }),
    // The staging pricing question: in progress, liveness unverifiable, its chat done 4 h ago.
    worker('ctx_000000000002', 'run_xample02', 'in_progress', {
      agentTerminalHandle: 'structworker_00000000-0000-4000-a000-000000000003',
      resource: { worktreeId: wt(staging), endpointIncarnation: 'structured:00000000-0000-4000-9000-000000000003' },
      projection: { outcome: 'in_progress', liveness: { verdict: 'unverifiable', reason: 'missing_status' } },
    }),
    // A finished Jarvis worker, retained by Orca after the release; its last status is its worker_done.
    worker('ctx_000000000003', 'run_xample02', 'succeeded', {
      agentTerminalHandle: 'term_00000000-0000-4000-a000-000000000004',
      resource: { worktreeId: wt(sandworm), endpointIncarnation: `${wt(sandworm)}@@84658afd:6d7efdc5`, releaseCompletedAt: null },
      projection: { outcome: 'succeeded', liveness: { verdict: 'unverifiable', reason: 'stale_status', observedAt: h(1.5) } },
    }),
    // Released by Orca; The owner wrote in its chat an hour after.
    worker('ctx_000000000004', 'run_xample02', 'succeeded', {
      agentTerminalHandle: 'term_quahog', resource: { worktreeId: wt('/w/quahog'), releaseCompletedAt: '2026-10-30 17:00:00' },
    }),
  ];
  state.tasks.run_xample01 = [{ id: 'task_ctx_000000000001', task_title: 'pick-and-ship #4531-engine (continue, FBM contract)' }];
  state.tasks.run_xample02 = [{ id: 'task_ctx_000000000002', task_title: 'Question: staging pricing' }];
  const agent = (paneKey: string, st: string, updatedAt: number, extra = {}) => ({ paneKey, state: st, agentType: 'claude', updatedAt, ...extra });
  state.worktrees = [
    { path: engine, displayName: 'issue-4531-engine', status: 'working', agents: [
      agent('structured-agent-session-00000000-0000-4000-9000-000000000004:3b6eecd1', 'done', h(16)),
      agent('00000000-0000-4000-9000-000000000005:00000000-0000-4000-9000-000000000006', 'working', h(0.1)),
    ] },
    { path: '/Users/owner/orca/workspaces/acmeapp_nextjs/tern', displayName: 'MANAGER', status: 'working', agents: [
      agent('structured-agent-session-claude_88f043b2_2659_4076_9b4a_c30daa721c59:494e1921', 'working', h(0.2), {
        workingMode: 'monitoring', children: [{ kind: 'command', description: 'Wait for messages that need the coordinator (20 min)', state: 'working' }],
      }),
    ] },
    { path: sandworm, displayName: 'Auto archive completed requests', status: 'active', agents: [
      agent('00000000-0000-4000-9000-000000000007:00000000-0000-4000-9000-000000000008', 'done', h(1.5)),
    ] },
    { path: '/w/quahog', displayName: 'Goals design doc', agents: [agent('2d1c1a78:6189dba2', 'done', Date.parse('2026-10-30T18:00:00Z'))] },
    { path: '/Users/owner/Repos', displayName: 'Jarvis', status: 'active', agents: [
      agent('structured-agent-session-claude_b4b69521_135d_405a_b880_d2f55c4c27e2:a42c8928', 'working', h(0)),
    ] },
    { path: staging, displayName: 'staging', status: 'inactive', agents: [
      agent('structured-agent-session-00000000-0000-4000-9000-000000000003:00000000-0000-4000-9000-000000000009', 'done', h(4.9)),
    ] },
  ];
  // `terminal list` has no recordedPaneKey on these; the pane key is `<tabId>:<leafId>`.
  state.terminals = [
    { handle: 'term_00000000-0000-4000-a000-000000000002', tabId: '00000000-0000-4000-9000-000000000005', leafId: '00000000-0000-4000-9000-000000000006' },
    { handle: 'term_00000000-0000-4000-a000-000000000004', tabId: '00000000-0000-4000-9000-000000000007', leafId: '00000000-0000-4000-9000-000000000008' },
    { handle: 'term_quahog', tabId: '2d1c1a78', leafId: '6189dba2' },
  ];
  const poller = makeWorkPoller({ orca, log: () => {}, jarvisRun: 'run_xample02', openAsks: () => new Map(), onChange: () => {}, now: () => clock });
  const w = await poller.poll();
  assert.deepEqual(w.rows.map(r => [r.id, r.title, r.group, r.state, r.note]), [
    // (1) the terminal worker is one row: its pane is not listed again as `issue-4531-engine (claude)` Working.
    // (4) the engine workspace's 16 h old Done chat is hidden while the worker runs there.
    ['ctx_000000000001', 'pick-and-ship #4531-engine (continue, FBM contract)', 'story', 'working', undefined],
    // (6) unverifiable and quiet for hours: idle with a note, and still listed (nothing releases it).
    ['ctx_000000000002', 'Question: staging pricing', 'other', 'idle', 'No activity for 4 h, Orca cannot see it'],
    // (5) a manager waiting on `check --wait` is idle, not working.
    ['s:claude_88f043b2_2659_4076_9b4a_c30daa721c59', 'MANAGER', 'other', 'idle', 'Monitoring'],
    // (2) sandworm's finished worker is gone; quahog stays because the owner talked there after the release.
    ['s:2d1c1a78:6189dba2', 'Goals design doc', 'other', 'idle', 'Done 2 h ago'],
    // (3) Jarvis's own chat in ~/Repos never shows.
  ]);
  assert.equal(w.rows.filter(r => r.group === 'story').length, 1, 'Stories counts the engine once');
  assert.ok(!state.calls.some(c => c.includes('worker-release')), 'nothing is released');
});

test('a worker with unverifiable liveness that is still working in its chat stays working', async () => {
  const { state, orca } = fakeOrca();
  const clock = Date.parse('2026-10-30T12:00:00Z');
  state.workers = [worker('d_u', 'run_xa', 'in_progress', {
    resource: { worktreeId: 'r::/w/u', endpointIncarnation: 'structured:u1' }, projection: { outcome: 'in_progress', liveness: { verdict: 'unverifiable' } },
  })];
  state.worktrees = [{ path: '/w/u', displayName: 'u', agents: [{ paneKey: 'structured-agent-session-u1:leaf', state: 'working', updatedAt: clock - 3 * 3_600_000 }] }];
  const poller = makeWorkPoller({ orca, log: () => {}, jarvisRun: 'run_j', openAsks: () => new Map(), onChange: () => {}, now: () => clock });
  assert.deepEqual((await poller.poll()).rows.map(r => [r.id, r.state]), [['d_u', 'working']]);
});

const STOP = 'Worker stopped without reporting';
/** A chat-tab worker whose agent Orca lists in `worktree ps`, with a stop notice open on it. */
function stoppedWorker(agent: object | undefined, liveness = 'live', activity?: string) {
  const { state, orca } = fakeOrca();
  state.workers = [worker('d_1', 'run_xa', 'in_progress', {
    resource: { worktreeId: 'repo::/w/d_1', endpointIncarnation: 'structured:key1' },
    projection: { outcome: 'in_progress', liveness: { verdict: liveness }, stage: { activity } },
  })];
  state.tasks.run_xa = [{ id: 'task_d_1', task_title: 'pick-and-ship #4486' }];
  state.worktrees = agent ? [{ path: '/w/d_1', agents: [{ paneKey: 'structured-agent-session-key1:leaf', updatedAt: Date.now(), ...agent }] }] : [];
  const stops = new Map([['d_1', STOP]]);
  const seen: { workers: WorkerInfo[] }[] = [];
  const poller = makeWorkPoller({ orca, log: () => {}, jarvisRun: 'run_j', openAsks: () => new Map(), stopNotices: () => stops, onChange: () => {}, onPolled: (_w, workers) => seen.push({ workers }) });
  return { state, poller, seen };
}

test('a stop notice waits on the owner only while the worker is really not running', async () => {
  // #4486: its turn ended, a background code review keeps it running.
  const monitoring = stoppedWorker({ state: 'working', workingMode: 'monitoring' });
  assert.equal((await monitoring.poller.poll()).rows[0].state, 'working');
  assert.equal(monitoring.seen[0].workers[0].running, true);
  // Orca's own status says the same when `worktree ps` has no row for the agent.
  assert.equal((await stoppedWorker(undefined, 'live', 'working').poller.poll()).rows[0].state, 'working');

  const stopped = stoppedWorker({ state: 'done' });
  const row = (await stopped.poller.poll()).rows[0];
  assert.deepEqual([row.state, row.note], ['waiting', STOP]);
  assert.equal(stopped.seen[0].workers[0].running, false);
  // It resumes: the same notice no longer counts.
  (stopped.state.worktrees[0] as any).agents[0].state = 'working';
  assert.equal((await stopped.poller.poll()).rows[0].state, 'working');

  // A stale "working" from a worker Orca cannot see proves nothing, so the notice still counts.
  assert.equal((await stoppedWorker({ state: 'working' }, 'unverifiable').poller.poll()).rows[0].state, 'waiting');
});

test('a side chat\'s stop notice never waits on the owner, while a real ask on a running worker still does', async () => {
  const { state, orca } = fakeOrca();
  state.workers = [worker('d_side', 'run_j', 'in_progress'), worker('d_ask', 'run_j', 'in_progress', { projection: { outcome: 'in_progress', liveness: { verdict: 'live' }, stage: { activity: 'working' } } })];
  state.tasks.run_j = [{ id: 'task_d_side', task_title: 'Side chat: five stories' }, { id: 'task_d_ask', task_title: 'Marketplace queue text' }];
  const poller = makeWorkPoller({
    orca, log: () => {}, jarvisRun: 'run_j', onChange: () => {},
    openAsks: () => new Map([['d_ask', 'Which text?']]), stopNotices: () => new Map([['d_side', STOP]]),
  });
  const rows = (await poller.poll()).rows;
  assert.deepEqual(rows.map(r => [r.dispatch, r.state]), [['d_side', 'working'], ['d_ask', 'waiting']]);
});

const stopItem = (id: string, dispatch: string | null, created = '2026-11-02 12:00:00') => ({ external_id: `msg_stop_${id}`, kind: 'escalation', dispatch_id: dispatch, created_at: created });
const liveRow = (id: string, sideChat = false): WorkRow => ({ id, kind: 'worker', dispatch: id, title: id, group: 'other', state: 'working', sideChat, steer: 'auto' });

test('a stop notice clears itself when the worker resumes, finishes or is released, and not before', () => {
  const at = Date.parse('2026-11-02T12:00:00Z');
  const passed = (i: ReturnType<typeof stopItem>, rows: WorkRow[], workers: WorkerInfo[], complete = true, now = at + STOP_SETTLE_MS) => passedStopNotices([i], rows, workers, complete, now).length === 1;
  const inProgress = (running: boolean): WorkerInfo[] => [{ dispatch: 'd', outcome: 'in_progress', running }];

  assert.equal(passed(stopItem('a', 'd'), [liveRow('d')], inProgress(true)), true, 'resumed');
  assert.equal(passed(stopItem('a', 'd'), [liveRow('d')], inProgress(true), true, at + 1000), false, 'Orca\'s status may lag the notice by a moment');
  assert.equal(passed(stopItem('a', 'd'), [liveRow('d')], inProgress(false)), false, 'really stopped: it stays');
  assert.equal(passed(stopItem('a', 'd'), [], [{ dispatch: 'd', outcome: 'succeeded' }]), true, 'finished');
  assert.equal(passed(stopItem('a', 'd'), [], [{ dispatch: 'd', outcome: 'failed' }]), true, 'stopped by someone');
  assert.equal(passed(stopItem('a', 'd'), [], []), true, 'released: Orca no longer lists it');
  assert.equal(passed(stopItem('a', 'd'), [], [], false), false, 'a Run\'s list failed, so a missing worker proves nothing');
  assert.equal(passed(stopItem('a', 'd'), [], inProgress(false)), true, 'its row was dropped because Orca called it gone');
  assert.equal(passed(stopItem('a', 'd'), [liveRow('d', true)], inProgress(false)), true, 'a side chat ends every turn this way');
  assert.equal(passed(stopItem('a', null), [], []), false, 'no worker named');
  assert.equal(passed({ ...stopItem('a', 'd'), external_id: 'msg_blocked' }, [], []), false, 'an escalation the worker wrote is not a stop notice');
});

test('repeated stop notices for one dispatch collapse into the first; other escalations and dispatches are left alone', () => {
  const six = ['a', 'b', 'c', 'd', 'e', 'f'].map(x => stopItem(x, 'ctx_000000000005'));
  const others = [stopItem('z', 'ctx_other'), { ...stopItem('y', 'ctx_000000000005'), external_id: 'msg_blocked' }, stopItem('n', null), stopItem('m', null)];
  assert.deepEqual(duplicateStopNotices([...six, ...others]), ['b', 'c', 'd', 'e', 'f'].map(x => `msg_stop_${x}`));
});
