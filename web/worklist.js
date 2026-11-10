// The one work list: conversations (work rows) and things the owner asked for (requests) merged into the work groups,
// matched through a request's `row`. A module so the page and daemon/worklist.test.ts import the same code.
//
// The rules, so nothing vanishes silently:
// - An open request (waiting, working, failed) with a listed row is that row, with the request's title, status and age.
// - An open request with no row of its own (never listed, already gone, hidden, or a second request on one row) is its
//   own row in the group its title implies, with its status and Hide.
// - A request in review or done is in Waiting for merge or Completed. Its row leaves the group only while the row is
//   idle or exited. A row that is working or waiting stays in its group as well, since the owner kept talking to it.
// - A row with no request is a plain row.
// - A row finished (done, failed or stopped) over an hour ago goes under its group's closed Done fold. It stays in view
//   while its request is open (working, waiting, failed), or while it has no finish time. The fold only hides; it deletes nothing.
import { esc, ago, mark, requestMark, requestGroups, requestListHtml, openIdOf, closedNote, reportLinkHtml, STATE } from './requestlist.js';
import { formatStamp } from './workfold.js';
import { actionsWith } from './contract.js';

export const GROUPS = [['story', 'Stories'], ['babysit', 'Babysitting'], ['side', 'Side chats'], ['terminal', 'Terminals'], ['other', 'Other']];
// A project terminal's mark: a small screen with a prompt (daemon/termrows.ts).
export const TERM_MARK = '<svg class="g-term" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="11" rx="2"/><path d="M4.5 6.5 6.5 8l-2 1.5M8 10h3"/></svg>';
const WORK_STATE = { waiting: 'Waiting on you', idle: 'Idle', working: 'Working', exited: 'Exited' };
const RANK = { waiting: 0, failed: 1, working: 2, idle: 3, exited: 4 };
export const DONE_FOLD_MS = 60 * 60_000;
/** How the detail pane names the owner. jarvisd sends it (`owner` in GET /api/work); the page calls setOwner once at load. */
let who = { called: 'the owner', cap: 'The owner' };
export function setOwner(o) { if (typeof o?.called === 'string' && typeof o?.cap === 'string' && o.called) who = { called: o.called, cap: o.cap }; }

/** True when the item goes under the Done fold: its row finished over an hour ago and no open request holds it in view. */
export function folded(item, now) {
  const end = Date.parse(item.row?.endedAt ?? '');
  if (!item.row || Number.isNaN(end) || now - end <= DONE_FOLD_MS) return false;
  return !item.req || !['waiting', 'working', 'failed'].includes(item.req.status);
}

/** The group a request with no row belongs in, read from its title as classify in daemon/work.ts reads it. */
export function groupOf(title) {
  if (/babysit|watch(ing)?\s+(the\s+)?pr\b|pr watcher/i.test(title)) return 'babysit';
  return /^\s*#\d+/.test(title) ? 'story' : 'other';
}

/** `hidden` is a Set of row ids. Returns the items per group (in view, and `old` under the Done fold), the two folders' requests and the hidden count. */
export function mergeWork(rows, requests, hidden, showHidden = false, now = Date.now()) {
  const { open, review, done } = requestGroups(requests);
  const listed = new Map(rows.map(r => [r.id, r]));
  const shown = r => showHidden || !hidden.has(r.id);
  const claimed = new Map(), orphans = [];
  for (const req of open) {
    const row = req.row && listed.get(req.row);
    if (row && shown(row) && !claimed.has(row.id)) claimed.set(row.id, req);
    else orphans.push(req);
  }
  const inFolder = new Set([...review, ...done].map(r => r.row).filter(Boolean));
  const active = r => r.state === 'working' || r.state === 'waiting';
  const items = [
    ...rows.filter(r => shown(r) && (claimed.has(r.id) || !inFolder.has(r.id) || active(r))).map(row => {
      const req = claimed.get(row.id);
      return { group: row.group, row, req, rank: RANK[req?.status === 'failed' ? 'failed' : row.state] ?? RANK.working };
    }),
    ...orphans.map(req => ({ group: groupOf(req.title), req, rank: RANK[req.status] ?? RANK.working })),
  ];
  const groups = GROUPS.map(([key, name]) => {
    const all = items.filter(i => i.group === key).sort((a, b) => a.rank - b.rank);
    const list = all.filter(i => !folded(i, now)), old = all.filter(i => folded(i, now));
    return { key, name, items: list, old, waiting: list.filter(i => i.rank === RANK.waiting && !(i.row && hidden.has(i.row.id))).length };
  });
  return { groups, review, done, hiddenCount: rows.filter(r => hidden.has(r.id)).length };
}

/** A group holding something waiting opens itself. A hand close lasts until nothing in it waits, and only that long. */
export function groupOpen(group, shut, closedWaiting) {
  if (!group.waiting) closedWaiting.delete(group.key);
  return group.waiting ? !closedWaiting.has(group.key) : !shut.has(group.key);
}

function itemHtml(i, ctx) {
  const { row, req } = i, title = req?.title ?? row.title;
  const failed = req?.status === 'failed';
  const status = row?.tmux ? `Running in tmux session ${row.tmux.name}` : failed ? STATE.failed : req && !row ? STATE[req.status] ?? req.status : WORK_STATE[row.state] ?? row.state;
  const shape = row?.tmux ? TERM_MARK : failed ? mark('failed') : !row ? requestMark(req.status) : mark(row.state === 'exited' ? 'stopped' : row.state);
  const idleNote = row?.state === 'idle' && row.note;
  // The age column holds a real time or a short idle note. A row with neither shows nothing there.
  const age = req ? ago(req.at, ctx.now) : idleNote && idleNote.length <= 14 ? idleNote : '';
  const note = !req && idleNote && idleNote.length > 14 ? idleNote : !row && !req.row ? closedNote(req) : '';
  const isHidden = row && ctx.hidden.has(row.id);
  const openId = row?.id ?? openIdOf(req);
  // On an idle side chat the × closes the chat. On every other row it only hides the row.
  const closes = row?.sideChat && row.state === 'idle' && !isHidden;
  const hide = closes
    ? `<button type="button" class="hide" data-close="${esc(row.dispatch)}" aria-label="Close ${esc(title)}" title="Close this side chat. Its worker stops.">×</button>`
    : `<button type="button" class="hide"${row ? ` data-hide-row="${esc(row.id)}"` : ''}${req ? ` data-hide="${req.id}"` : ''}${isHidden ? ' data-unhide' : ''} aria-label="${isHidden ? 'Show' : 'Hide'} ${esc(title)} in this list" title="${isHidden ? 'Show in the list again' : 'Hide from this list. Nothing in Orca stops.'}">${isHidden ? '↺' : '×'}</button>`;
  const state = failed ? 'failed' : row?.state ?? req.status;
  return `<div class="wrow s-${esc(state)}${openId && ctx.reading === openId ? ' reading' : ''}${isHidden ? ' hidden-row' : ''}"${openId ? ` data-id="${esc(openId)}" role="button" tabindex="0"` : ''} title="${esc(status)}${row?.note && row.state !== 'idle' ? `: ${esc(row.note)}` : ''}">`
    + `${shape}<span class="t">${esc(title)}</span><span class="wend">${req ? reportLinkHtml(req) : ''}<span class="ago">${esc(age)}<span class="sr"> ${esc(status)}</span></span></span>${hide}`
    + (note ? `<div class="note">${esc(note)}</div>` : '') + '</div>';
}

/** The Done fold at the bottom of a group: closed by default, its count on the button. `isOpen` draws its rows. */
function doneFoldHtml(g, isOpen, ctx) {
  if (!g.old.length) return '';
  return `<button type="button" class="dfold" data-done-fold="${g.key}" aria-expanded="${isOpen}">${CHEV}Done (${g.old.length})</button>`
    + (isOpen ? g.old.map(i => itemHtml(i, ctx)).join('') : '');
}

const CHEV = '<svg class="chev" viewBox="0 0 12 12" aria-hidden="true"><path d="M4.5 2.5 8 6l-3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/** `ctx`: { hidden, shut, closedWaiting, folders, reading, now, doneOpen }. `doneOpen` is a Set of the groups whose Done fold is open. */
export function workListHtml(merged, ctx) {
  const groups = merged.groups.filter(g => g.items.length || g.old?.length).map(g => {
    const open = groupOpen(g, ctx.shut, ctx.closedWaiting);
    return `<div class="sec"><button type="button" class="group" data-group="${g.key}" data-waiting="${g.waiting}" aria-expanded="${open}"><svg class="chev" viewBox="0 0 12 12" aria-hidden="true"><path d="M4.5 2.5 8 6l-3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg><span class="name">${g.name}</span>${g.waiting ? `<span class="w">${g.waiting} waiting</span>` : ''}<span class="n">${g.items.length + (g.old?.length ?? 0)}</span></button>`
      + (open ? g.items.map(i => itemHtml(i, ctx)).join('') + doneFoldHtml(g, !!ctx.doneOpen?.has(g.key), ctx) : '') + '</div>';
  }).join('');
  const folders = merged.review.length || merged.done.length ? requestListHtml([...merged.review, ...merged.done], ctx.folders, ctx.now) : '';
  if (!groups && !folders) return '<div class="clear"><div class="clear-t">No work running</div><p>Ask Jarvis to start a story or a task.</p></div>';
  return groups + folders;
}

/** "2 finished today · 2 waiting for merge", or nothing. */
export function doneLine(requests, now) {
  const today = new Date(now).toDateString();
  const finished = requests.filter(r => r.status === 'done' && new Date(r.at).toDateString() === today).length;
  const merge = requests.filter(r => r.status === 'review').length;
  return [finished && `${finished} finished today`, merge && `${merge} waiting for merge`].filter(Boolean).join(' · ');
}

/** The record of a request with no listed conversation. Read-only: nothing in it is a control. Times are Eastern. */
export function requestDetailHtml(d) {
  const facts = [
    ['Status', `${STATE[d.status] ?? d.status}, ${formatStamp(d.at)}`],
    ['Started', formatStamp(d.startedAt)],
    ...(d.worktree ? [['Worktree', d.worktree]] : []),
  ].map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('');
  const pr = d.pr || d.url ? `<div><dt>PR</dt><dd>${d.url ? `<a href="${esc(d.url)}" target="_blank" rel="noopener">${esc(d.pr ?? d.url)}</a>` : esc(d.pr)}</dd></div>` : '';
  const entry = h => `<li class="rd-h${h.failed ? ' bad' : ''}"><div class="rd-at">${esc(formatStamp(h.at))}</div><div class="rd-t">${esc(h.title)}</div>`
    + (h.text ? `<div class="rd-x">${esc(h.text)}</div>` : '')
    + (h.answer ? `<div class="rd-a"><span>${h.answeredBy === 'jarvis' ? 'Jarvis' : esc(who.cap)}${h.answeredAt ? `, ${esc(formatStamp(h.answeredAt))}` : ''}</span>${esc(h.answer)}</div>` : '') + '</li>';
  return `<div class="rdetail"><p class="rd-note">${esc(closedNote(d))}</p><dl class="rd-facts">${facts}${pr}</dl>`
    + (d.words ? `<h3>What ${esc(who.called)} asked</h3><div class="rd-x">${esc(d.words)}</div>` : '')
    + `<h3>History</h3>${d.history.length ? `<ol class="rd-list">${d.history.map(entry).join('')}</ol>` : '<p class="rd-none">Nothing recorded for this worker.</p>'}`
    + `<h3>Conversation</h3>${d.transcript ? '' : '<p class="rd-none">Its transcript was not found.</p>'}</div>`;
}

/** The tag over an approval, from its action and arguments only. */
export function approvalTag(action, args) {
  const story = /#(\d+)/.exec(String(args?.taskTitle ?? ''))?.[1];
  if (action === 'gmail-send') return args?.to ? `Email to ${args.to}${args.cc ? `, cc ${args.cc}` : ''}` : 'Send an email';
  if (action === 'worker-start') return story ? `Story ${story}` : 'Start a worker';
  if (action === 'terminal-send') return 'Send into a session';
  if (action === 'worker-send') return 'Message a worker';
  if (action === 'worker-stop') return 'Stop a worker';
  if (action === 'gh-pr-close') return `Close PR ${args?.number ?? ''}`.trim();
  if (action === 'fbm-client-pause') return `Pause ${args?.client ?? 'a client'}`;
  if (action === 'prod-mcp-call') return `Production: ${args?.tool ?? 'a call'}`;
  if (action === 'worker-permission') return `Permission: ${args?.name ?? 'a worker'}`;
  const words = String(action).replace(/-/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** These read back what they did, so their result is worth showing. Other results are ids and raw output. */
const READS_BACK = actionsWith('readsBack');

/** The button labels of a pending card. A worker's permission prompt is allowed or denied, not approved. */
export function approvalButtons(action) {
  return action === 'worker-permission' ? ['Allow', 'Deny'] : ['Approve', 'Reject'];
}

/** The line an approval leaves once decided; empty while it is still pending or running. */
export function approvalOutcomeText(a) {
  const readBack = READS_BACK.has(a.action) && a.result;
  if (a.action === 'worker-permission') {
    // native.ts decides with 'rejected' or 'approved', then finishes 'done' with the result 'allowed' or 'denied'.
    if (a.status === 'rejected' || (a.status === 'done' && a.result === 'denied')) return 'Denied';
    if (a.status === 'done') return 'Allowed';
    if (a.status === 'failed') return `Not answered: ${a.result ?? 'no reason given'}`;
    return '';
  }
  if (a.status === 'rejected') return 'Rejected';
  if (a.status === 'done') return readBack ? `Approved. ${a.result}` : 'Approved';
  if (a.status === 'failed') return `Approved, then failed: ${a.result ?? 'no reason given'}`;
  if (a.status === 'unknown') return readBack ? `Approved, outcome unknown: ${a.result}` : 'Approved, outcome unknown';
  return '';
}

/** A worker's permission prompt: the tool and its one-line summary (the command, the file). Shown in monospace. */
export const toolLine = args => args?.tool ? `${args.tool}: ${args.summary ?? ''}`.trim() : '';

/** The proposer's two card lines, { approves, restsOn }, from the approval's `card` column. Empty for older rows. */
export function approvalCard(a) {
  try { const c = JSON.parse(a?.card ?? 'null'); return c && typeof c === 'object' ? c : {}; } catch { return {}; }
}

/**
 * The approval's question and what it rests on. A card with the proposer's lines reads: the action in one line, If you
 * approve, It rests on, and the stored detail behind More. A command that will run (a named action, a production call,
 * a worker's permission prompt) stays in view, because it is the thing the owner approves. A card without the lines is drawn
 * as before: the question, then the detail.
 */
export function approvalBodyHtml(a, args) {
  const detail = approvalDetail(args), card = approvalCard(a), cmd = !!args.tool || !!args.runs;
  const detailHtml = detail ? `<div class="c-detail${args.tool ? ' cmd' : ''}">${esc(detail)}</div>` : '';
  const say = `<h2 class="say">${esc(a.say)}</h2>`;
  if (!card.approves && !card.restsOn) return say + detailHtml;
  const part = (head, text) => text ? `<h3 class="card-h">${head}</h3><p class="card-p">${esc(text)}</p>` : '';
  return say + part('If you approve', card.approves) + part('It rests on', card.restsOn)
    + (cmd ? detailHtml : detail ? `<details class="card-more"><summary>More</summary>${detailHtml}</details>` : '');
}

/** Approve and Reject, Approve on the right, where the thumb of a right hand rests. */
export function approvalPairHtml(id, action) {
  const [yes, no] = approvalButtons(action);
  return `<div class="pair" data-approval="${Number(id)}"><button type="button" class="no">${esc(no)}</button><button type="button" class="yes">${esc(yes)}</button></div>`;
}

/**
 * Approve and Reject under the Jarvis message that asked for a proposal (approvals.chat_turn, set by daemon/chatlink.ts).
 * Only pending proposals not yet tapped get buttons, so a decision anywhere (here, the Requests card, a spoken yes) removes them.
 * With more than one proposal on the message, each pair names its proposal.
 */
export function chatDecisionHtml(approvals, turn, tapped = new Set()) {
  const open = [...approvals].filter(a => a.chat_turn === turn && a.status === 'pending' && !tapped.has(a.id));
  return open.map(a => {
    const [yes, no] = approvalButtons(a.action);
    return `<div class="chat-pair" data-approval="${Number(a.id)}">${open.length > 1 ? `<span class="chat-say">${esc(a.say)}</span>` : ''}`
      // Approve is on the right, where the thumb reaches on a phone.
      + `<button type="button" class="chat-no">${esc(no)}</button><button type="button" class="chat-yes">${esc(yes)}</button></div>`;
  }).join('');
}

/** What the approval will do, in its own stored words. A named action stores the exact command, which says it all. */
export function approvalDetail(args) {
  if (args.runs) return args.runs;
  return [toolLine(args), args.repo, args.dispatch, args.terminal, args.to && 'To: ' + args.to, args.subject && 'Subject: ' + args.subject, args.title, args.text, args.spec && args.spec.slice(0, 300)].filter(Boolean).join('\n');
}

/** How long Stop on a started notice works after the start ended. The same number as UNDO_MS in daemon/gate.ts. */
export const UNDO_MS = 60_000;
const dbMs = t => Date.parse(`${String(t).replace(' ', 'T')}Z`);

/**
 * When Stop on a worker Jarvis started at once stops working, in ms since 1970. Infinity while the start still runs:
 * a press then stops the worker as soon as the start ends. 0 when there is nothing to stop.
 */
export function undoDeadline(a) {
  if (a?.decided_by !== 'owner-asked') return 0;
  if (a.status === 'approved') return Infinity;
  if (a.status !== 'done' && a.status !== 'unknown') return 0;
  return dbMs(a.finished_at ?? a.decided_at) + UNDO_MS;
}

/**
 * The chat line for a worker Jarvis started at once because the owner asked for it: Starting or Started, the title,
 * and Stop while it works. `stopped` is what Stop led to ('Stopping', 'Stopped', or an error), once pressed.
 */
export function startedNoticeHtml(a, args, now, stopped) {
  const title = args?.taskTitle || a.say;
  const state = a.status === 'approved' ? 'Starting' : a.status === 'failed' ? 'Did not start' : 'Started';
  const failed = a.status === 'failed' ? `<div class="started-why">${esc(a.result ?? 'no reason given')}</div>` : '';
  const stop = !stopped && now < undoDeadline(a) ? `<button type="button" class="undo" data-undo="${Number(a.id)}">Stop</button>` : '';
  return `<span class="pill${a.status === 'failed' ? ' failed' : ''}">${esc(state)}</span><span class="started-t">${esc(title)}</span>`
    + (stopped ? `<span class="started-stop">${esc(stopped)}</span>` : stop) + failed;
}
