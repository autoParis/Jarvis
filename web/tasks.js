// The Scheduled tasks screen (design option A, round 3): one flat list, a run strip per task, and an open row with the
// last error and the edit fields. The data comes from GET /api/tasks (daemon/tasks.ts). Times show in Eastern time.
const TZ = 'America/Toronto';
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const day = t => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(t);

/** "9:00 AM", with the day in front when it is not today: "Nov 6, 4:00 PM", or "today at 9:00 AM" with `today`. */
export function when(iso, now = Date.now(), { today = false, hourOnly = false } = {}) {
  const t = new Date(iso);
  const time = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', ...(hourOnly && t.getUTCMinutes() === 0 ? {} : { minute: '2-digit' }) }).format(t);
  if (day(t) === day(new Date(now))) return today ? `today at ${time}` : time;
  const date = new Intl.DateTimeFormat('en-US', { timeZone: TZ, month: 'short', day: 'numeric' }).format(t);
  return `${date}, ${time}`;
}

const STATE_WORD = { ok: 'ran fine', warn: 'some runs failed', fail: 'failed', none: 'no run seen' };
/** The text of one mark, for its tooltip and screen readers. */
export function markLabel(m, strip, now = Date.now()) {
  if (!m.at) return 'No run seen yet';
  const at = strip === 'hourly' ? `${when(m.at, now, { hourOnly: true })} hour` : when(m.at, now);
  const runs = strip === 'hourly' && m.runs > 1 ? `, ${m.runs} runs` : '';
  return `${at}: ${STATE_WORD[m.state]}${runs}${m.note ? `. ${m.note}` : ''}`;
}

export function stripHtml(t, now = Date.now()) {
  const bad = t.marks.filter(m => m.state === 'fail' || m.state === 'warn').length, seen = t.marks.filter(m => m.state !== 'none').length;
  const label = !seen ? 'Recent runs: none seen yet' : `Recent runs: ${seen - bad} fine, ${bad} with a failure`;
  return `<div class="tk-strip" role="img" aria-label="${esc(label)}">${t.marks.map(m => `<i class="tk-m ${m.state}" title="${esc(markLabel(m, t.strip, now))}"></i>`).join('')}</div>`;
}

const STATUS_CLASS = { OK: 'ok', Warning: 'warn', Failing: 'fail', Off: 'off' };
const needsFix = t => t.status === 'Failing' || t.status === 'Warning';

/** The chat message behind "Ask Jarvis to fix": the task, its source and its last error. The brain decides on a fix worker. */
export function fixMessage(t, now = Date.now()) {
  const err = t.lastError;
  const last = err ? ` Last error${err.at ? `, ${when(err.at, now, { today: true })}` : ''}: ${err.text}${err.since ? ` Every run since ${when(err.since, now)} failed.` : ''}` : ' No error text was recorded.';
  const tail = t.logTail ? ` Its error log (${t.logTail.file}) ends with: ${t.logTail.text.split('\n').at(-1)}` : '';
  return `Scheduled task "${t.name}" shows ${t.status}. Source: ${t.sourceLabel}. Schedule: ${t.schedule}.${last}${tail} Please find the cause and start a worker to fix it if one is needed. Ask me before you change the job or its schedule.`;
}

function openHtml(t, now) {
  const err = t.lastError;
  const errBox = err ? `<div class="tk-err"><p>Last error${err.at ? `, ${esc(when(err.at, now, { today: true }))}` : ''}.${err.since ? ` Every run since ${esc(when(err.since, now))} failed.` : ''}</p><pre>${esc(err.text)}</pre></div>` : '';
  const log = t.logTail ? `<div class="tk-log"><p>Error log, written ${esc(when(t.logTail.at, now, { today: true }))}: ${esc(t.logTail.file)}</p><pre>${esc(t.logTail.text)}</pre></div>` : '';
  const ro = t.editable ? '' : ' disabled';
  const cronHint = t.editable ? `<span class="tk-hint">or @every 30m</span>` : '';
  return `<div class="tk-open" id="tk-open-${esc(t.id)}">${errBox}${log}${needsFix(t) ? `<div class="tk-fix-row">${fixButton(t)}</div>` : ''}
    <form class="tk-form" data-id="${esc(t.id)}">
      <label class="tk-f tk-cron"><span>${t.cron ? 'Schedule (cron)' : 'Schedule'}${cronHint}</span><input name="cron" value="${esc(t.cron ?? t.schedule)}" autocapitalize="off" autocorrect="off" autocomplete="off" spellcheck="false"${ro}></label>
      <label class="tk-f tk-desc"><span>What it does</span><input name="description" value="${esc(t.description)}" maxlength="200" placeholder="${t.editable ? 'One line. Saved in the plist as JarvisDescription.' : 'No description stored'}"${ro}></label>
      ${t.editable ? '<button type="submit" class="tk-save">Save</button>' : ''}
    </form>
    ${t.editNote ? `<p class="tk-note">${esc(t.editNote)}</p>` : ''}<p class="tk-msg" role="status" hidden></p>
    <p class="tk-src">Source: ${esc(t.sourceLabel)}</p></div>`;
}
const fixButton = t => `<button type="button" class="tk-fix" data-id="${esc(t.id)}">Ask Jarvis to fix</button>`;

// Eye icons for the hide toggle: an outline eye-slash hides, an eye shows. Not an x, so it does not read as "delete the job".
const EYE_OFF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.7 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-2.2 3.2M6.6 6.6A17 17 0 0 0 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2M3 3l18 18"/></svg>';
const EYE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>';
export const hideButton = t => t.hidden
  ? `<button type="button" class="tk-hide on" data-hide-task="${esc(t.id)}" data-unhide aria-label="Show ${esc(t.name)} in the list again" title="Show in the list again">${EYE}</button>`
  : `<button type="button" class="tk-hide" data-hide-task="${esc(t.id)}" aria-label="Hide ${esc(t.name)} from this list" title="Hide from this list. The job still runs, and a failure still shows.">${EYE_OFF}</button>`;
/** A hidden task stays out of the list unless the owner asks to see hidden ones, or it needs a fix: a failure always shows. */
export const shownTask = (t, showHidden = false) => !t.hidden || showHidden || needsFix(t);

const CHEV = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>';
export function rowHtml(t, open, now = Date.now()) {
  const cls = STATUS_CLASS[t.status];
  return `<div class="tk-row${open ? ' open' : ''}${t.hidden ? ' is-hidden' : ''}" data-id="${esc(t.id)}">
    <button type="button" class="tk-head" aria-expanded="${open}" aria-controls="tk-open-${esc(t.id)}"><span class="tk-chev">${CHEV}</span>
      <span class="tk-name"><b>${esc(t.name)}${t.hidden ? ' <em class="tk-tag">Hidden</em>' : ''}</b><span>${esc(t.schedule)}</span></span></button>
    ${stripHtml(t, now)}
    <span class="tk-status ${cls}">${esc(t.status)}</span>
    <span class="tk-act">${needsFix(t) ? fixButton(t) : ''}</span>
    ${hideButton(t)}
    ${open ? openHtml(t, now) : ''}</div>`;
}

/** The words next to the title: "13 tasks, 2 hidden". */
export function countText(tasks, showHidden = false) {
  const shown = tasks.filter(t => shownTask(t, showHidden)).length, hidden = tasks.filter(t => t.hidden).length;
  return `${shown} task${shown === 1 ? '' : 's'}${hidden && !showHidden ? `, ${hidden} hidden` : ''}`;
}

export function listHtml(tasks, openId, now = Date.now(), showHidden = false) {
  if (!tasks.length) return '<p class="tk-empty">No scheduled tasks found.</p>';
  const shown = tasks.filter(t => shownTask(t, showHidden)), hidden = tasks.filter(t => t.hidden).length;
  const more = hidden ? `<button type="button" class="tk-showhidden" data-showhidden aria-pressed="${showHidden}">${showHidden ? 'Leave out' : 'Show'} ${hidden} hidden</button>` : '';
  const card = shown.length
    ? `<div class="tk-card"><div class="tk-cols" aria-hidden="true"><span>Task</span><span>Recent runs</span><span>Status</span></div>${shown.map(t => rowHtml(t, t.id === openId, now)).join('')}</div>`
    : '<p class="tk-empty">Every task is hidden.</p>';
  return card + more;
}
