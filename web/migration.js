// The Leads button and popup, Migration in the code and docs (temporary; every piece is listed in docs/migration/README.md). The rows come from
// daemon/migration.ts; this draws them. Every piece of text is escaped. A module so the page and daemon/migration.test.ts
// import the same code.
import { esc } from './requestlist.js';

export const STATUS = { todo: 'To contact', contacted: 'Contacted', meeting: 'Meeting set', migrated: 'Migrated' };
const ZONE = 'America/Toronto';
const ICON = {
  mail: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="5.5" width="17" height="13" rx="2"/><path d="M4 7l8 6 8-6"/></svg>',
  text: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true"><path d="M5 5h14a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 19 17h-8l-4.5 3.5V17H5a1.5 1.5 0 0 1-1.5-1.5v-9A1.5 1.5 0 0 1 5 5z"/></svg>',
  down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>',
  right: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>',
  cal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="5.5" width="16" height="14" rx="2"/><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4"/></svg>',
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M12 8v4.5l3 2"/></svg>',
  pencil: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15.5 5.5l3 3L8 19H5v-3z"/><path d="M13.5 7.5l3 3"/></svg>',
  phone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6.5 3.5h3l1.5 4-2 1.5a11 11 0 0 0 6 6l1.5-2 4 1.5v3a2 2 0 0 1-2 2A16 16 0 0 1 4.5 5.5a2 2 0 0 1 2-2z"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17"/></svg>',
};

/** The meeting the button names: the soonest one still ahead, within a week. */
export function nextMeeting(people, now = Date.now()) {
  const ahead = people.filter(p => p.status === 'meeting' && p.meetingAt && Date.parse(p.meetingAt) >= now && Date.parse(p.meetingAt) - now <= 7 * 86_400_000);
  return ahead.sort((a, b) => Date.parse(a.meetingAt) - Date.parse(b.meetingAt))[0];
}
/** The count is people still To contact, nothing else. The label names the next meeting within a week, for screen readers. */
export function migrationButton(people, now = Date.now()) {
  const count = people.filter(p => p.status === 'todo').length;
  const m = nextMeeting(people, now);
  const base = count ? `Leads, ${count} to contact` : 'Leads, nobody to contact';
  return { count, aria: m ? `${base}, meeting with ${m.name} ${meetingWords(m.meetingAt, now).short}` : base };
}
export const migrationSub = people => `${people.length} ${people.length === 1 ? 'person' : 'people'}, ${migrationButton(people).count} to contact`;

const day = (t) => new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(t);
/** "today 9:12 a.m.", "yesterday", or "Nov 3", in the owner's time zone. */
export function when(iso, now = Date.now()) {
  const t = new Date(iso);
  if (day(t) === day(now)) return `today ${new Intl.DateTimeFormat('en-US', { timeZone: ZONE, hour: 'numeric', minute: '2-digit' }).format(t).replace('AM', 'a.m.').replace('PM', 'p.m.')}`;
  if (day(t) === day(now - 86_400_000)) return 'yesterday';
  return new Intl.DateTimeFormat('en-US', { timeZone: ZONE, month: 'short', day: 'numeric' }).format(t);
}
/** "Edited 2 days ago" under a note. */
export function editedAgo(iso, now = Date.now()) {
  if (!iso) return '';
  const m = Math.max(0, (now - Date.parse(iso)) / 60_000);
  const n = m < 1 ? 'just now' : m < 60 ? `${Math.round(m)} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} ${Math.round(m / 1440) === 1 ? 'day' : 'days'} ago`;
  return `Edited ${n}`;
}
export const byLine = (p, now) => p.addedBy === 'jarvis' ? `Added by Jarvis from ${p.addedFrom || 'chat'}, ${when(p.createdAt, now)}` : '';

/** Time since the last status change, as a short number: "now", "12m", "5h", "3d". */
export function since(iso, now = Date.now()) {
  const m = Math.max(0, (now - Date.parse(iso)) / 60_000);
  return m < 1 ? 'now' : m < 60 ? `${Math.floor(m)}m` : m < 1440 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`;
}

// ---- meeting times, always in Eastern ----
const parts = (t, o) => Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: ZONE, ...o }).formatToParts(t).map(x => [x.type, x.value]));
const pad = n => String(n).padStart(2, '0');
/** Whole days from one "YYYY-MM-DD" to another. */
const daysApart = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000);
/** "10 a.m." on the hour, "9:30 a.m." otherwise. */
export function clockWords(t) {
  const p = parts(t, { hour: 'numeric', minute: '2-digit', hour12: true });
  return `${p.hour}${p.minute === '00' ? '' : `:${p.minute}`} ${p.dayPeriod === 'AM' ? 'a.m.' : 'p.m.'}`;
}
/**
 * A meeting time for the row and the button. `row` is "Tomorrow 10 a.m.", "Tue Nov 10, 2 p.m." or, once it has passed,
 * "Was yesterday 2 p.m.". `short` is the button's lowercase "tomorrow 10 a.m.".
 */
export function meetingWords(iso, now = Date.now()) {
  const t = Date.parse(iso), d = daysApart(day(now), day(t)), time = clockWords(t);
  const named = d === 0 ? 'today' : d === 1 ? 'tomorrow' : d === -1 ? 'yesterday' : null;
  const date = new Intl.DateTimeFormat('en-US', { timeZone: ZONE, weekday: 'short', month: 'short', day: 'numeric' }).format(t).replace(',', '');
  const short = named ? `${named} ${time}` : `${date}, ${time}`;
  const past = t < now;
  return { past, short, row: past ? `Was ${short}` : short[0].toUpperCase() + short.slice(1) };
}
// ---- the meeting toast under the bar (option H of the top area) ----
const TOAST_AFTER_MS = 60 * 60_000;
/** The key a closed toast is stored under: the person and the meeting time, so a moved or new meeting shows again. */
export const toastKey = p => `${p.id}|${p.meetingAt}`;
/** How far off a meeting is: "in 50 min", "in 2 h", "in 1 h 20 min", "now", "started 10 min ago". */
export function untilWords(t, now = Date.now()) {
  const m = Math.round((t - now) / 60_000);
  if (m < 0) return `started ${-m} min ago`;
  if (m === 0) return 'now';
  if (m < 60) return `in ${m} min`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `in ${h} h ${r} min` : `in ${h} h`;
}
/**
 * The one-line toast at the right under the bar. It shows only on the Eastern day of a Meeting set row, from midnight
 * until one hour after the start, and never for a meeting in `closed` (the daemon's `toastClosed`). The soonest wins.
 * `who` is the desktop's "Max, Dealer Eight", `first` the phone's "Max". Null when nothing shows.
 */
export function meetingToast(people, closed = [], now = Date.now()) {
  const today = day(now), shut = new Set(closed);
  const m = people
    .filter(p => p.status === 'meeting' && p.meetingAt && !shut.has(toastKey(p)))
    .filter(p => { const t = Date.parse(p.meetingAt); return day(t) === today && t > now - TOAST_AFTER_MS; })
    .sort((a, b) => Date.parse(a.meetingAt) - Date.parse(b.meetingAt))[0];
  if (!m) return null;
  const t = Date.parse(m.meetingAt), first = m.name.split(' ')[0], at = `${clockWords(t)}, ${untilWords(t, now)}`;
  return { key: toastKey(m), id: m.id, meetingAt: m.meetingAt, who: `${first}, ${m.dealership}`, first, at, aria: `Meeting with ${m.name}, ${m.dealership}, ${at}` };
}
/** The Eastern day and time of a stored meeting, as the date and time fields hold them: "2026-11-09", "09:30". */
export function easternFields(iso) {
  const p = parts(Date.parse(iso), { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}
/** Minutes Eastern is ahead of UTC at an instant: -300 in winter, -240 in summer. */
function offsetAt(t) {
  const p = parts(t, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  return Math.round((Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(t / 1000) * 1000) / 60_000);
}
/** The day and time fields, read as Eastern, as an ISO time with its offset: "2026-11-09T09:30-05:00". Empty when either is blank or bad. */
export function easternIso(date, time) {
  const a = /^(\d{4})-(\d\d)-(\d\d)$/.exec(date ?? ''), b = /^(\d\d):(\d\d)/.exec(time ?? '');
  if (!a || !b) return '';
  const wall = Date.UTC(+a[1], +a[2] - 1, +a[3], +b[1], +b[2]);
  let off = offsetAt(wall);
  off = offsetAt(wall - off * 60_000);
  const sign = off < 0 ? '-' : '+', abs = Math.abs(off);
  return `${a[0]}T${b[1]}:${b[2]}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}
/** The grey line under the fields: the picked day in words, "Monday, in 3 days". */
export function readBack(date, now = Date.now()) {
  if (!/^\d{4}-\d\d-\d\d$/.test(date ?? '')) return '';
  const name = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long' }).format(Date.parse(`${date}T12:00:00Z`));
  const d = daysApart(day(now), date);
  const rel = d === 0 ? 'today' : d === 1 ? 'tomorrow' : d === -1 ? 'yesterday' : d > 0 ? `in ${d} days` : `${-d} days ago`;
  return `<b>${name}</b>, ${rel}`;
}

const time = p => Date.parse(p.meetingAt ?? '') || 0;
/**
 * The groups the list shows, one per status in the order of option A of the Leads mockup: To contact, Meeting set,
 * Contacted, Migrated. To contact and Contacted show the longest silence first. Meetings go soonest first, a past one
 * first since it needs a status, and one with no time before them all. Migrated goes newest first.
 */
export function groups(people) {
  const silence = (a, b) => Date.parse(a.statusAt) - Date.parse(b.statusAt) || a.id - b.id;
  const of = s => people.filter(p => p.status === s);
  return [
    { key: 'todo', title: STATUS.todo, people: of('todo').sort(silence) },
    { key: 'meeting', title: STATUS.meeting, people: of('meeting').sort((a, b) => time(a) - time(b) || a.id - b.id) },
    { key: 'contacted', title: STATUS.contacted, people: of('contacted').sort(silence) },
    { key: 'migrated', title: STATUS.migrated, people: of('migrated').sort((a, b) => silence(b, a)) },
  ];
}
export const order = people => groups(people).flatMap(g => g.people);

/**
 * One status's people as runs: two or more people of one dealership sit together under that dealership, at the place
 * of the first of them; a dealership with one person stays a lone row. `{ shop, people }` or `{ person }`.
 */
export function byDealership(people) {
  const n = new Map();
  for (const p of people) n.set(p.dealerKey, (n.get(p.dealerKey) ?? 0) + 1);
  const seen = new Set(), out = [];
  for (const p of people) {
    if (n.get(p.dealerKey) < 2) { out.push({ person: p }); continue; }
    if (seen.has(p.dealerKey)) continue;
    seen.add(p.dealerKey);
    out.push({ shop: p, people: people.filter(x => x.dealerKey === p.dealerKey) });
  }
  return out;
}

/** The source as an icon only, an envelope or a message bubble, named for screen readers and on hover. */
const sourceHtml = p => `<span class="m-src" role="img" aria-label="${esc(p.sourceWords)}" title="${esc(p.sourceWords)}">${p.source === 'email' ? ICON.mail : ICON.text}</span>`;
const statusSelect = (p, pending) => `<div class="m-status${pending ? ' pending' : ''}" data-s="${p.status}"><select aria-label="Status of ${esc(p.name)}" data-status>${Object.entries(STATUS).map(([k, v]) => `<option value="${k}"${k === p.status ? ' selected' : ''}>${v}</option>`).join('')}</select>${ICON.down}</div>`;

/**
 * The day field, the time field and Set on one line, with the
 * picked day read back in words under them. On the phone each field opens the phone's own picker. `o.set` adds Set and
 * Cancel; the add form has neither, its Add button does the saving.
 */
export function pickerHtml(pk, o = {}, now = Date.now()) {
  const ok = !!easternIso(pk.date, pk.time);
  return `<div class="pk" data-picker><div class="pk-head">${esc(o.head ?? 'Meeting time')} <span>Eastern</span></div>`
    + `<div class="pa-line${o.set ? '' : ' two'}"><input type="date" class="in" data-pick="date" value="${esc(pk.date ?? '')}" aria-label="Meeting day">`
    + `<input type="time" class="in" data-pick="time" value="${esc(pk.time ?? '')}" step="300" aria-label="Meeting time, Eastern">`
    + (o.set ? `<button type="button" class="act primary" data-pick-set${ok ? '' : ' disabled'}>Set</button>` : '') + `</div>`
    + `<div class="pk-foot"><div class="pk-read" data-pick-read>${readBack(pk.date, now) || 'Pick a day and a time.'}</div>${o.set ? '<button type="button" class="pk-cancel" data-pick-cancel>Cancel</button>' : ''}</div>`
    + (o.note ? `<div class="pk-note">${esc(o.note)}</div>` : '')
    + (pk.error ? `<p class="m-err" role="alert">${esc(pk.error)}</p>` : '')
    + `</div>`;
}

/** The start of the second line: the meeting time for Meeting set (tap it to move the meeting), else the time since the last status change. */
function sideHtml(p, now) {
  let t;
  if (p.status === 'meeting') {
    const w = p.meetingAt && meetingWords(p.meetingAt, now);
    t = `<button type="button" class="m-when${w ? (w.past ? ' past' : '') : ' chip'}" data-pick-open aria-label="${w ? `Meeting ${esc(w.row)}. Change the time` : 'Pick the meeting time'}">${w?.past ? ICON.clock : ICON.cal}${esc(w ? w.row : 'Pick a time')}</button>`;
  } else t = `<span class="m-age" title="${esc(p.statusWords)} since ${esc(when(p.statusAt, now))}" aria-label="${esc(p.statusWords)} since ${esc(when(p.statusAt, now))}">${since(p.statusAt, now)}</span>`;
  return `${t}${sourceHtml(p)}`;
}

/**
 * One person on two lines: the name, then the meeting time or the time since, the source icon and the dealership and
 * note, cut to the width. `inShop` leaves the dealership out, its subheader names it.
 */
export function rowHtml(p, s = {}, now = Date.now(), inShop = false) {
  const open = s.open === p.id, editing = open && s.edit?.id === p.id ? s.edit : null, pick = s.pick?.id === p.id ? s.pick : null;
  const shop = `${esc(p.dealership)}${p.onSheet ? '' : ' <small class="m-off">not on sheet</small>'}`;
  const sub = [inShop ? '' : shop, p.note && !open ? esc(p.note) : ''].filter(Boolean).join(' · ');
  const by = p.byHidden ? '' : byLine(p, now);
  const meta = p.addedBy === 'owner' ? `Added by you, ${when(p.createdAt, now)}` : `Added ${when(p.createdAt, now)}`;
  const first = p.name.split(' ')[0];
  return `<li class="m-item${open || pick ? ' open' : ''}" data-id="${p.id}"><div class="m-row">`
    + `<button type="button" class="m-who" data-toggle aria-expanded="${open}"><span class="m-name">${esc(p.name)}</span></button>`
    + `<div class="m-line">${sideHtml(p, now)}${sub ? `<span class="m-sub" data-toggle>${sub}</span>` : ''}</div>` + statusSelect(p, pick?.mode === 'status')
    + (by ? `<div class="m-by"><span>${esc(by)}</span><button type="button" class="m-by-x" data-hide-by aria-label="Hide this line" title="Hide this line">${ICON.x}</button></div>` : '') + `</div>`
    + (pick ? `<div class="m-popover">${pickerHtml(pick, { head: `Meeting with ${first}`, set: true, note: pick.mode === 'status' ? `Stays ${p.statusWords} until you set the time. Cancel changes nothing.` : '' }, now)}</div>` : '')
    + (editing ? `<div class="m-note">${editHtml(p, editing, s.dealers ?? [])}</div>` : '')
    + (open && !editing ? `<div class="m-note"><div class="m-open-head">${contactHtml(p.contact)}<button type="button" class="m-edit-btn" data-edit aria-label="Edit ${esc(p.name)}">${ICON.pencil}Edit</button></div><label for="m-note-${p.id}">Notes</label><textarea id="m-note-${p.id}" class="in" rows="3" data-note>${esc(s.noteText ?? p.note)}</textarea>`
      + `<div class="acts"><button type="button" class="act primary" data-save>Save</button><button type="button" class="act" data-cancel>Cancel</button><small>${esc(editedAgo(p.noteAt, now))}</small></div>`
      + (s.error ? `<p class="m-err" role="alert">${esc(s.error)}</p>` : '')
      + (s.confirmRemove
        ? `<div class="m-confirm" role="group" aria-label="Remove ${esc(first)}?"><span>Remove ${esc(first)} from the list?</span><button type="button" class="act danger" data-remove-yes>Remove</button><button type="button" class="act" data-remove-keep>Keep</button></div>`
        : `<div class="m-meta"><span>${esc(meta)} · ${esc(p.statusWords)} since ${esc(when(p.statusAt, now))}</span><button type="button" class="m-remove" data-remove>Remove</button></div>`) + `</div>` : '')
    + `</li>`;
}

/** A Remove tap needs this long between asking and confirming, so a double tap or a tap that lands as the list moves removes nothing. */
export const REMOVE_WAIT_MS = 600;
/** The row's buttons, in the order the click handler checks them. */
export const ROW_TAPS = ['data-toggle', 'data-cancel', 'data-edit', 'data-edit-cancel', 'data-edit-save', 'data-esrc', 'data-pick-open', 'data-pick-cancel', 'data-pick-set', 'data-hide-by', 'data-save', 'data-remove', 'data-remove-keep', 'data-remove-yes'];
/**
 * What a tap on a row's button does to the open-row state `s`, and what the handler runs next. Only 'remove' deletes, and only
 * from the confirm, on the open row, outside edit mode, at least REMOVE_WAIT_MS after Remove asked. Edit and Cancel in edit
 * mode clear a pending confirm, so a Remove tapped earlier never carries over.
 */
export function rowTap(tap, s, id, now = Date.now()) {
  switch (tap) {
    case 'data-edit': s.confirmRemove = 0; return 'edit';
    case 'data-edit-cancel': s.edit = null; s.confirmRemove = 0; return 'draw';
    case 'data-remove': if (s.edit || s.open !== id) return 'none'; s.confirmRemove = now; return 'draw';
    case 'data-remove-keep': s.confirmRemove = 0; return 'draw';
    case 'data-remove-yes': return s.confirmRemove && !s.edit && s.open === id && now - s.confirmRemove >= REMOVE_WAIT_MS ? 'remove' : 'none';
    default: return tap;
  }
}

/** The contact as a link: an email opens the mail app, a phone number the dialer. */
export function contactHtml(c) {
  if (!c) return '';
  const mail = c.includes('@');
  const href = mail ? `mailto:${c}` : `tel:${c.replace(/[^\d+]/g, '')}`;
  return `<a class="m-contact" href="${esc(href)}">${mail ? ICON.mail : ICON.phone}<span>${esc(c)}</span></a>`;
}

/** The open row in edit mode: name, dealership from the list, source and contact, then Save and Cancel. */
export function editHtml(p, e, dealers) {
  return `<div class="m-edit" data-edit-form><div class="m-edit-head">Edit ${esc(p.name)}</div>`
    + `<label>Name<input class="in" data-e="name" value="${esc(e.name)}" enterkeyhint="next" autocomplete="off"></label>`
    + `<label>Dealership<select class="in" data-e="dealer">${dealerOptions(dealers, e.dealer, false)}</select></label>`
    + `<label>Source<div class="seg" role="group" aria-label="Source">${[['email', 'Email'], ['text', 'Text message']].map(([k, v]) => `<button type="button" data-esrc="${k}" aria-pressed="${e.source === k}"${e.source === k ? ' class="on"' : ''}>${v}</button>`).join('')}</div></label>`
    + `<label><span>Contact <span class="opt">optional</span></span><input class="in" data-e="contact" value="${esc(e.contact)}" placeholder="Phone number or email" inputmode="email" autocomplete="off"></label>`
    + (e.error ? `<p class="m-err" role="alert">${esc(e.error)}</p>` : '')
    + `<div class="acts"><button type="button" class="act primary" data-edit-save>Save</button><button type="button" class="act" data-edit-cancel>Cancel</button></div></div>`;
}

/** A dealership's subheader with its people under it, inside a status. */
const shopHtml = (r, s, now) => `<li class="m-shop"><div class="m-shop-head"><b>${esc(r.shop.dealership)}${r.shop.onSheet ? '' : ' <small class="m-off">not on sheet</small>'}</b><span>${r.people.length} people</span></div>`
  + `<ul class="m-list">${r.people.map(p => rowHtml(p, s, now, true)).join('')}</ul></li>`;

/**
 * Each status with people is a heading that folds, its count on the right, then its people (`byDealership`).
 * `s.shut` holds the folded statuses; Migrated starts folded.
 */
export function listHtml(people, s = {}, now = Date.now()) {
  const shut = s.shut ?? { migrated: true };
  const active = groups(people).filter(g => g.people.length);
  if (!active.length) return '<p class="m-empty">Nobody yet. Add a person above, or ask Jarvis in the chat.</p>';
  return active.map(g => {
    const open = !shut[g.key];
    return `<section class="m-sec" data-s="${g.key}"><button type="button" class="m-head" data-sec="${g.key}" aria-expanded="${open}">${open ? ICON.down : ICON.right}<i aria-hidden="true"></i><b>${g.title}</b><span>${g.people.length}</span></button>`
      + (open ? `<ul class="m-list">${byDealership(g.people).map(r => r.person ? rowHtml(r.person, s, now) : shopHtml(r, s, now)).join('')}</ul>` : '') + `</section>`;
  }).join('');
}

/** The dealership dropdown: the sheet's names exactly as written, the owner's own flagged, then Other (the add form only). */
export function dealerOptions(dealers, picked, other = true) {
  return `<option value=""${picked ? '' : ' selected'} disabled>Pick a dealership</option>`
    + dealers.map(d => `<option value="${d.id}"${String(picked) === String(d.id) ? ' selected' : ''}>${esc(d.name)}${d.onSheet ? '' : ' (not on sheet)'}</option>`).join('')
    + (other ? `<option value="other"${picked === 'other' ? ' selected' : ''}>Other...</option>` : '');
}

export function addFormHtml(dealers, f, now = Date.now()) {
  return `<form class="m-form" id="mig-form" autocomplete="off">`
    + `<label>Name<input class="in" data-f="name" value="${esc(f.name)}" enterkeyhint="next"></label>`
    + `<label>Dealership<select class="in" data-f="dealer">${dealerOptions(dealers, f.dealer)}</select></label>`
    + (f.dealer === 'other' ? `<label class="full">New dealership, not on the sheet<input class="in" data-f="other" value="${esc(f.other)}" placeholder="Name as the dealership writes it"></label>` : '')
    + `<label>Source<div class="seg" role="group" aria-label="Source">${[['email', 'Email'], ['text', 'Text message']].map(([k, v]) => `<button type="button" data-src="${k}" aria-pressed="${f.source === k}"${f.source === k ? ' class="on"' : ''}>${v}</button>`).join('')}</div></label>`
    + `<label>Status<select class="in" data-f="status">${Object.entries(STATUS).map(([k, v]) => `<option value="${k}"${k === f.status ? ' selected' : ''}>${v}</option>`).join('')}</select></label>`
    + (f.status === 'meeting' ? `<div class="full">${pickerHtml({ date: f.date, time: f.time }, { head: 'Meeting time' }, now)}</div>` : '')
    + `<label class="full"><span>Contact <span class="opt">optional</span></span><input class="in" data-f="contact" value="${esc(f.contact ?? '')}" placeholder="Phone number or email" inputmode="email"></label>`
    + `<label class="full">Note<textarea class="in" rows="2" data-f="note">${esc(f.note)}</textarea></label>`
    + (f.error ? `<p class="m-err full" role="alert">${esc(f.error)}</p>` : '')
    + `<div class="acts"><button type="submit" class="act primary"${addReady(f) ? '' : ' disabled'}>Add</button><button type="button" class="act" data-add-cancel>Cancel</button></div></form>`;
}

/** Meeting set needs its day and time before Add. */
export const addReady = f => f.status !== 'meeting' || !!easternIso(f.date, f.time);
const BLANK = () => ({ name: '', dealer: '', other: '', source: 'email', status: 'todo', date: '', time: '', note: '', contact: '', error: '' });

/** The popup's behavior. `d.fetch` carries the page's secret, `d.paint` redraws the buttons. */
export function makeMigrationPop(d) {
  const { $ } = d;
  const listEl = $('mig-list'), addEl = $('mig-add');
  let state = { people: [], dealers: [] }, adding = false, form = BLANK();
  // pick: the open meeting picker, { id, mode: 'status' (the status waits for the time) | 'move', date, time, error }
  // edit: the open row in edit mode, { id, name, dealer (id as a string), source, contact, error }
  const s = { open: null, noteText: undefined, shut: { migrated: true }, error: '', confirmRemove: false, pick: null, edit: null, dealers: [] };

  function drawList() {
    const focused = document.activeElement?.matches?.('[data-note]');
    const at = focused ? document.activeElement.selectionStart : null;
    const picking = document.activeElement?.closest?.('#mig-list') && document.activeElement.dataset?.pick;
    const typing = document.activeElement?.closest?.('#mig-list') && document.activeElement.dataset?.e;
    const caret = typing && document.activeElement.selectionStart;
    s.dealers = state.dealers;
    listEl.innerHTML = listHtml(state.people, s);
    $('mig-sub').textContent = migrationSub(state.people);
    if (focused) { const n = listEl.querySelector('[data-note]'); n?.focus(); n?.setSelectionRange(at, at); }
    if (picking) listEl.querySelector(`[data-pick="${picking}"]`)?.focus({ preventScroll: true });
    if (typing) { const f = listEl.querySelector(`[data-e="${typing}"]`); f?.focus({ preventScroll: true }); if (caret != null) try { f?.setSelectionRange(caret, caret); } catch { /* a select has no caret */ } }
  }
  /** Typing in a picker changes only its read-back line and its Set or Add button, so the field keeps focus and its native picker. */
  function repaintPick(root, pk, button, ready) {
    const read = root.querySelector('[data-pick-read]');
    if (read) read.innerHTML = readBack(pk.date) || 'Pick a day and a time.';
    const b = root.querySelector(button);
    if (b) b.disabled = !ready;
  }
  // On a computer the date field opens the browser's calendar on any click, not only on its small icon.
  function openNative(e) {
    const f = e.target.closest?.('input[data-pick]');
    if (f && matchMedia('(pointer: fine)').matches) try { f.showPicker?.(); } catch { /* not allowed here, the field still types */ }
  }
  function drawAdd() {
    addEl.innerHTML = adding ? addFormHtml(state.dealers, form)
      : `<button type="button" class="m-addbtn" data-add-open><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>Add person</button>`;
  }
  function show(next) {
    state = next ?? state;
    if (s.open !== null && !state.people.some(p => p.id === s.open)) closeRow();
    drawList();
    // The form stays as typed. Only its dealership list follows a change, which redrawing the select does.
    if (adding) { const sel = addEl.querySelector('[data-f="dealer"]'); if (sel) sel.innerHTML = dealerOptions(state.dealers, form.dealer); } else drawAdd();
    d.paint();
  }
  function closeRow() { s.open = null; s.noteText = undefined; s.error = ''; s.confirmRemove = false; s.pick = null; s.edit = null; }
  function openEdit(id) {
    const p = state.people.find(x => x.id === id);
    if (!p) return;
    s.edit = { id, name: p.name, dealer: String(p.dealerId), source: p.source, contact: p.contact ?? '', error: '' };
    drawList();
    // On the phone a focused field opens the keyboard, and its closing moves the list under the finger. Focus on a computer only.
    if (matchMedia('(pointer: fine)').matches) listEl.querySelector('[data-e="name"]')?.focus({ preventScroll: true });
    listEl.querySelector('[data-edit-form]')?.scrollIntoView?.({ block: 'nearest' });
  }
  async function saveEdit() {
    const e = s.edit;
    if (!e.name.trim()) { e.error = 'Type a name first.'; return drawList(); }
    try {
      await post('/api/migration/act', { id: e.id, action: 'edit', name: e.name, dealerId: Number(e.dealer), source: e.source, contact: e.contact });
      s.edit = null;
    } catch (err) { e.error = `Not saved: ${err.message}`; }
    show();
  }
  function openPick(id, mode) {
    const p = state.people.find(x => x.id === id);
    if (!p) return;
    closeRow();
    s.pick = { id, mode, ...(mode === 'move' && p.meetingAt ? easternFields(p.meetingAt) : { date: '', time: '' }), error: '' };
    drawList();
    listEl.querySelector('[data-pick="date"]')?.focus({ preventScroll: true });
    listEl.querySelector('.m-popover')?.scrollIntoView?.({ block: 'nearest' });
  }
  async function setPick() {
    const pk = s.pick, meetingAt = easternIso(pk.date, pk.time);
    if (!meetingAt) { pk.error = 'Pick a day and a time.'; return drawList(); }
    try {
      await post('/api/migration/act', pk.mode === 'status' ? { id: pk.id, action: 'status', status: 'meeting', meetingAt } : { id: pk.id, action: 'meeting', meetingAt });
      s.pick = null;
    } catch (e) { pk.error = `Not set: ${e.message}`; }
    show();
  }
  async function post(path, body) {
    const r = await d.fetch(path, { method: 'POST', body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (j.migration) state = j.migration;
    if (!r.ok) throw new Error(j.error || `error ${r.status}`);
    return j;
  }
  async function act(id, action, extra = {}) {
    s.error = '';
    try {
      await post('/api/migration/act', { id, action, ...extra });
      if (action === 'note' || action === 'remove') closeRow();
    } catch (e) { s.error = e.message; if (s.open !== id) s.open = id; }
    show();
  }

  async function submitAdd() {
    form.error = '';
    if (!form.name.trim()) { form.error = 'Type a name first.'; return drawAdd(); }
    if (!form.dealer || (form.dealer === 'other' && !form.other.trim())) { form.error = 'Pick a dealership, or type the new one.'; return drawAdd(); }
    const meetingAt = form.status === 'meeting' ? easternIso(form.date, form.time) : undefined;
    if (meetingAt === '') { form.error = 'Pick the meeting day and time.'; return drawAdd(); }
    try {
      let dealerId = form.dealer;
      if (dealerId === 'other') dealerId = (await post('/api/migration/dealer', { name: form.other })).dealer.id;
      await post('/api/migration/add', { name: form.name, dealerId: Number(dealerId), source: form.source, status: form.status, meetingAt, note: form.note, contact: form.contact });
      adding = false; form = BLANK();
    } catch (e) { form.error = `Not added: ${e.message}`; }
    drawAdd(); show();
  }

  addEl.addEventListener('click', e => {
    if (e.target.closest('[data-add-open]')) { adding = true; drawAdd(); return addEl.querySelector('[data-f="name"]')?.focus(); }
    if (e.target.closest('[data-add-cancel]')) { adding = false; form = BLANK(); return drawAdd(); }
    const src = e.target.closest('[data-src]');
    if (src) { form.source = src.dataset.src; for (const b of addEl.querySelectorAll('[data-src]')) { const on = b.dataset.src === form.source; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); } }
  });
  addEl.addEventListener('input', e => {
    const k = e.target.dataset?.f, pk = e.target.dataset?.pick;
    if (k && k !== 'dealer' && k !== 'status') form[k] = e.target.value;
    if (pk) { form[pk] = e.target.value; repaintPick(addEl, form, 'button[type="submit"]', addReady(form)); }
  });
  addEl.addEventListener('change', e => {
    const k = e.target.dataset?.f, pk = e.target.dataset?.pick;
    if (pk) { form[pk] = e.target.value; return repaintPick(addEl, form, 'button[type="submit"]', addReady(form)); }
    if (!k) return;
    form[k] = e.target.value;
    if (k === 'dealer') { drawAdd(); if (form.dealer === 'other') addEl.querySelector('[data-f="other"]')?.focus(); }
    if (k === 'status') { drawAdd(); if (form.status === 'meeting') addEl.querySelector('[data-pick="date"]')?.focus(); }
  });
  addEl.addEventListener('click', openNative);
  addEl.addEventListener('submit', e => { e.preventDefault(); submitAdd(); });

  listEl.addEventListener('click', e => {
    const sec = e.target.closest('[data-sec]');
    if (sec) { s.shut[sec.dataset.sec] = !s.shut[sec.dataset.sec]; return drawList(); }
    const item = e.target.closest('.m-item'), id = item && Number(item.dataset.id);
    if (!item) return;
    if (e.target.closest('[data-toggle]')) {
      const same = s.open === id;
      closeRow();
      if (!same) s.open = id;
      drawList();
      return same ? undefined : listEl.querySelector('[data-note]')?.focus({ preventScroll: true });
    }
    const tap = ROW_TAPS.find(a => e.target.closest(`[${a}]`));
    if (!tap) return openNative(e);
    const next = rowTap(tap, s, id);
    if (next === 'draw') return drawList();
    if (next === 'edit') return openEdit(id);
    if (next === 'remove') return void act(id, 'remove');
    if (next === 'data-cancel') { closeRow(); return drawList(); }
    if (next === 'data-edit-save') return void saveEdit();
    if (next === 'data-esrc') { if (s.edit) { s.edit.source = e.target.closest('[data-esrc]').dataset.esrc; drawList(); } return; }
    if (next === 'data-pick-open') return openPick(id, 'move');
    if (next === 'data-pick-cancel') { s.pick = null; return drawList(); }
    if (next === 'data-pick-set') return void setPick();
    if (next === 'data-hide-by') return void act(id, 'hide-by');
    if (next === 'data-save') return void act(id, 'note', { note: listEl.querySelector('[data-note]')?.value ?? '' });
  });
  function typedPick(e) {
    const k = e.target.dataset?.pick;
    if (!k || !s.pick) return false;
    s.pick[k] = e.target.value; s.pick.error = '';
    repaintPick(e.target.closest('[data-picker]'), s.pick, '[data-pick-set]', !!easternIso(s.pick.date, s.pick.time));
    return true;
  }
  listEl.addEventListener('input', e => {
    if (e.target.matches('[data-note]')) s.noteText = e.target.value;
    else if (e.target.dataset?.e && s.edit) s.edit[e.target.dataset.e] = e.target.value;
    else typedPick(e);
  });
  listEl.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.matches?.('input[data-e]')) { e.preventDefault(); void saveEdit(); } });
  listEl.addEventListener('change', e => {
    if (typedPick(e)) return;
    if (e.target.dataset?.e && s.edit) { s.edit[e.target.dataset.e] = e.target.value; return; }
    const sel = e.target.closest('[data-status]');
    if (!sel) return;
    const id = Number(sel.closest('.m-item').dataset.id), p = state.people.find(x => x.id === id);
    // Meeting set waits for its time: the dropdown goes back to the old status until Set.
    if (sel.value === 'meeting' && p?.status !== 'meeting') return openPick(id, 'status');
    if (s.pick?.id === id) s.pick = null;
    act(id, 'status', { status: sel.value });
  });

  drawAdd();
  return {
    show,
    current: () => state.people,
    toastClosed: () => state.toastClosed ?? [],
    /** The × on the toast: the daemon stores it, and its broadcast hides the toast on every open page. */
    closeToast: (id, meetingAt) => post('/api/migration/toast-close', { id, meetingAt }).then(() => d.paint()),
    closed: () => { closeRow(); if (adding && !form.name && !form.note) adding = false; drawAdd(); drawList(); },
  };
}
