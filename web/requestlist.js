// The Waiting for merge and Completed folders of the work list, as HTML (the rows come from daemon/requests.ts). Every
// piece of text is escaped. A module so the page and daemon/requests.test.ts import the same code.
const RANK = { waiting: 0, working: 1, failed: 2 };
export const STATE = { waiting: 'Waiting on you', working: 'Working', review: 'In review', done: 'Done', failed: 'Failed' };
export const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
/** "4 min", "2 h", "3 d". */
export const ago = (iso, now) => { const m = Math.max(0, (now - Date.parse(iso)) / 60_000); return m < 1 ? 'now' : m < 60 ? `${Math.round(m)} min` : m < 2880 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d`; };
/** The status mark, one distinct shape per status. */
export const mark = status => `<span class="g g-${status}" aria-hidden="true"></span>`;
const MARKS = { waiting: 'waiting', working: 'working', review: 'finished', done: 'finished', failed: 'failed' };
export const requestMark = status => mark(MARKS[status] || 'idle');

/** What a row opens: its listed conversation, else what Jarvis recorded about the request. */
export const openIdOf = r => r.row ?? `req:${r.id}`;
/** The line on a row with no listed conversation. A request still open may just be between polls. */
export const closedNote = r => r.status === 'working' || r.status === 'waiting' ? 'Conversation not listed right now. Showing what Jarvis recorded.' : 'Conversation closed. Showing what Jarvis recorded.';

/** Newest change first within each group. Open rows sort by status first; failed ones stay there until the owner hides them. */
export function requestGroups(requests) {
  const sorted = [...requests].sort((a, b) => (RANK[a.status] ?? 0) - (RANK[b.status] ?? 0) || Date.parse(b.at) - Date.parse(a.at));
  return {
    open: sorted.filter(r => r.status !== 'review' && r.status !== 'done'),
    review: sorted.filter(r => r.status === 'review'),
    done: sorted.filter(r => r.status === 'done'),
  };
}

/** A row with no PR link and a stored report links to the report page. A row with a PR link keeps that link instead. */
export const reportHref = r => !r.url && r.report ? `#report/${Number(r.id)}` : '';
export const reportLinkHtml = r => reportHref(r) ? `<a href="${reportHref(r)}" class="num" title="Read the worker's report">Report</a>` : '';

const numHtml = (text, url) => url ? `<a href="${esc(url)}" class="num" target="_blank" rel="noopener">${esc(text)}</a>` : `<span class="num">${esc(text)}</span>`;

/** The title's story number as "#4612", else the PR number. Links to the PR when its URL is known. A Report link takes the same place. */
function numberHtml(r) {
  if (reportHref(r)) return reportLinkHtml(r);
  const text = /#\d+/.exec(r.title)?.[0] ?? r.pr;
  return text ? numHtml(text, r.url) : '';
}

/** Hiding also hides the conversation row, or that row would come back in its work group. */
function rowHtml(r, now) {
  const hide = `<button type="button" class="hide" data-hide="${r.id}"${r.row ? ` data-hide-row="${esc(r.row)}"` : ''} aria-label="Hide ${esc(r.title)}" title="Hide from this list">×</button>`;
  return `<div class="rrow ${esc(r.status)}" data-row="${esc(openIdOf(r))}" role="button" tabindex="0" title="${esc(r.title)}">`
    + (numberHtml(r) || requestMark(r.status))
    + `<div class="t">${esc(reportHref(r) ? r.title : r.title.replace(/^\s*#\d+\s*/, '') || r.title)}</div><span class="state">${STATE[r.status] || esc(r.status)}</span><span class="ago">${ago(r.at, now)}</span>${hide}`
    + (r.row ? '' : `<div class="gone">${esc(closedNote(r))}</div>`) + '</div>';
}

const CHEV = '<svg class="chev" viewBox="0 0 12 12" aria-hidden="true"><path d="M4.5 2.5 8 6l-3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/** One row for a PR several requests share, with their conversations under it. `same` is newest first. The rows under it drop the PR number, which the row above already shows. */
function prRowHtml(pr, same, isOpen, now) {
  const id = `req-${pr.replace(/\W+/g, '-')}`, label = `${same.length} sessions`;
  return `<div class="rrow review prrow" data-pr="${esc(pr)}" role="button" tabindex="0" aria-expanded="${isOpen}" aria-controls="${id}" title="${esc(`${pr}, ${label}`)}">${CHEV}`
    + `${numHtml(pr, same.find(r => r.url)?.url)}<div class="t">${label}</div><span class="state">${STATE.review}</span><span class="ago">${ago(same[0].at, now)}</span></div>`
    + `<div id="${id}" class="prrows"${isOpen ? '' : ' hidden'}>${same.map(r => rowHtml({ ...r, pr: undefined }, now)).join('')}</div>`;
}

/** Waiting for merge: two or more requests on one PR become one row, where the newest of them sorts. `openPrs` says which are expanded. */
function reviewRowsHtml(rows, openPrs, now) {
  const byPr = new Map();
  for (const r of rows) if (r.pr) byPr.set(r.pr, [...(byPr.get(r.pr) ?? []), r]);
  return rows.map(r => {
    const same = byPr.get(r.pr);
    if (!same || same.length < 2) return rowHtml(r, now);
    return same[0] === r ? prRowHtml(r.pr, same, !!openPrs?.has(r.pr), now) : '';
  }).join('');
}

// The count sits on the button, so it shows while the folder is closed. An empty folder is not drawn.
function folderHtml(key, name, rows, isOpen, body) {
  if (!rows.length) return '';
  return `<button type="button" class="folder" data-folder="${key}" aria-expanded="${isOpen}" aria-controls="req-${key}">${CHEV}${name}<span class="n">${rows.length}</span></button>`
    + `<div id="req-${key}"${isOpen ? '' : ' hidden'}>${body}</div>`;
}

/** `folders` says what is open: { review, done, prs }, where prs is a Set of the expanded PRs. */
export function requestListHtml(requests, folders, now) {
  if (!requests.length) return '<div class="none">Nothing asked yet. Each worker Jarvis starts for you shows here.</div>';
  const { open, review, done } = requestGroups(requests);
  return open.map(r => rowHtml(r, now)).join('')
    + folderHtml('review', 'Waiting for merge', review, !!folders.review, reviewRowsHtml(review, folders.prs, now))
    + folderHtml('done', 'Completed', done, !!folders.done, done.map(r => rowHtml(r, now)).join(''));
}
