// The Today button and popup. The rows and what each one can press come from daemon/today.ts; this draws them. Every piece
// of text is escaped. A module so the page and daemon/today.test.ts import the same code.
import { esc, ago } from './requestlist.js';

const MARK = { waiting: 'waiting', ready: 'waiting', working: 'working', queued: 'idle', new: 'idle', released: 'finished' };
const LABEL = { accept: 'Accept', do: 'Do it', discuss: 'Discuss now', drop: 'Drop', release: 'Release', 'not-right': 'Not right', retry: 'Try again' };
const PRIMARY = new Set(['accept', 'do', 'discuss', 'release', 'retry']);
const KIND_LABEL = { story: 'Story', task: 'Task', talk: 'Talk' };
const OPEN = new Set(['waiting', 'ready', 'working', 'queued', 'new']);

/** Items that need the owner: Waiting on you plus Ready to check. The button is always there, so a thought can always be dropped. */
export function todayButton(list) {
  const count = list.filter(i => i.status === 'waiting' || i.status === 'ready').length;
  return { label: 'Today', count, aria: count ? `Today, ${count} ${count === 1 ? 'item needs' : 'items need'} you` : 'Today, nothing needs you' };
}
/** Under the title: how many need him, or nothing at all when none do. */
export const todaySub = list => { const n = todayButton(list).count; return n ? `${n} need${n === 1 ? 's' : ''} you` : ''; };

const markOf = i => i.status === 'waiting' && i.reason ? 'failed' : MARK[i.status] ?? 'idle';
function linkHtml(l) {
  if (!l) return '';
  if (l.open !== undefined) return `<button type="button" class="t-link" data-open="${esc(l.open)}">${esc(l.label)}</button>`;
  // Only what the daemon wrote: a PR, or the app's own report page. A link in any other scheme stays out.
  if (!/^(https?:\/\/|#report\/)/.test(l.url ?? '')) return '';
  return `<a class="t-link" href="${esc(l.url)}"${l.url.startsWith('#') ? '' : ' target="_blank" rel="noopener"'}>${esc(l.label)}</a>`;
}
/** The answer showing on a question: The owner's pick in this page, his saved answer, or the recommended one. */
export const shownAnswer = (q, picked) => picked ?? q.answer ?? q.options[q.recommended];
/** True when a picked answer is not what the work-up was written for, so the page offers Send answers in place of Accept or Do it. */
export const answersChanged = (i, picks = {}) => i.questions.some((q, n) => picks[n] !== undefined && picks[n] !== (q.answer ?? q.options[q.recommended]));

function questionsHtml(i, picks) {
  if (!i.questions.length) return '';
  return `<div class="t-sec"><h4>${i.questions.length === 1 ? 'Question' : 'Questions'}</h4>${i.questions.map((q, n) => {
    const now = shownAnswer(q, picks[n]);
    return `<fieldset class="t-q"><legend>${esc(q.q)}</legend>${q.options.map((o, k) => `<label class="t-opt"><input type="radio" name="t${i.id}q${n}" data-q="${n}" value="${esc(o)}"${o === now ? ' checked' : ''}><span>${esc(o)}${k === q.recommended ? ' <small>Recommended</small>' : ''}</span></label>`).join('')}${!q.options.length ? '<p class="t-dim">Answer in the chat, or use Not right.</p>' : ''}${q.answer && !q.options.includes(q.answer) ? `<p class="t-dim">You said: ${esc(q.answer)}</p>` : ''}</fieldset>`;
  }).join('')}</div>`;
}

/** The row opened in place: The owner's words first and always, then what Jarvis has, then what he can press. */
export function detailHtml(i, s = {}) {
  const picks = s.picks ?? {};
  const changed = answersChanged(i, picks);
  const names = changed ? ['answers', 'drop'] : i.buttons;
  const buttons = names.map(b => `<button type="button" class="t-act${PRIMARY.has(b) || b === 'answers' ? ' primary' : ''}" data-act="${b}">${b === 'answers' ? 'Send answers' : esc(LABEL[b] ?? b)}</button>`).join('');
  const editable = i.status === 'new' || i.status === 'waiting';
  return `<div class="t-detail">`
    + `<blockquote class="t-words">${esc(i.words)}</blockquote>`
    + (i.reason ? `<p class="t-reason"><span class="pill failed">Failed</span>${esc(i.reason)}</p>` : '')
    + (i.status === 'new' ? `<p class="t-dim">${i.note ? 'Back with Jarvis, with your note.' : 'Jarvis has not reached this yet.'}</p>` : '')
    + (i.status === 'queued' ? `<p class="t-dim">Waiting for a slot. At most three run at once.</p>` : '')
    + (i.reading ? `<p class="t-reading">${esc(i.reading)}</p>` : '')
    + questionsHtml(i, picks)
    + (i.assumptions.length ? `<div class="t-sec"><h4>Assumptions</h4><ul>${i.assumptions.map(a => `<li>${esc(a)}</li>`).join('')}</ul></div>` : '')
    + (i.line ? `<p class="t-line">${esc(i.line)}</p>` : '')
    + (i.result ? `<div class="t-sec"><h4>Result</h4><p>${esc(i.result)}</p></div>` : '')
    + (i.notProven ? `<div class="t-sec"><h4>Not proven</h4><p>${esc(i.notProven)}</p></div>` : '')
    + (i.link ? `<div>${linkHtml(i.link)}</div>` : '')
    + (editable ? `<div class="t-kinds" role="group" aria-label="Kind">${Object.entries(KIND_LABEL).map(([k, l]) => `<button type="button" data-kind="${k}" aria-pressed="${i.kind === k}">${l}</button>`).join('')}</div>` : '')
    + (s.error ? `<p class="t-reason"><span class="pill failed">Not done</span>${esc(s.error)}</p>` : '')
    + (s.notRight ? `<form class="t-note" data-note-form><input type="text" data-note aria-label="What is not right" placeholder="What is not right?" value="${esc(s.noteText ?? '')}" enterkeyhint="send" autocomplete="off"><button type="submit" class="t-act primary">Send</button></form>` : '')
    + (buttons ? `<div class="t-acts">${buttons}</div>` : '')
    + `</div>`;
}

/** A waiting or ready row shows no status words: its mark already says it, so the title gets the room. Screen readers still hear them. */
export function rowHtml(i, s = {}, now = Date.now()) {
  const open = s.open === i.id;
  return `<li class="t-item${open ? ' open' : ''}" data-id="${i.id}">`
    + `<div class="t-row"><button type="button" class="t-head" data-toggle aria-expanded="${open}"><span class="g g-${markOf(i)}" aria-hidden="true"></span><span class="t-title">${esc(i.title)}</span><span class="t-status${i.status === 'waiting' || i.status === 'ready' ? ' sr' : ''}">${esc(i.statusWords)}</span></button>${open ? '' : linkHtml(i.link)}<span class="ago">${ago(i.at, now)}</span></div>`
    + (open ? detailHtml(i, s) : '')
    + `</li>`;
}

/** The whole list: open rows in the daemon's order, then Released folded at the bottom. */
export function todayListHtml(list, s = {}, now = Date.now()) {
  const open = list.filter(i => OPEN.has(i.status)), done = list.filter(i => i.status === 'released');
  const moved = s.moved ? `<p class="t-moved" role="status">Moved to Stories, <a href="${esc(s.moved.url)}" target="_blank" rel="noopener">#${esc(s.moved.number)}</a></p>` : '';
  const rows = open.length ? `<ul class="t-list">${open.map(i => rowHtml(i, s, now)).join('')}</ul>`
    : `<p class="t-empty">Nothing here. Drop a thought above and find it worked up later.</p>`;
  const history = done.length ? `<button type="button" class="pop-more" data-history aria-expanded="${!!s.history}">Released (${done.length})</button>${s.history ? `<ul class="t-list t-done">${done.map(i => rowHtml(i, s, now)).join('')}</ul>` : ''}` : '';
  return moved + rows + history;
}

/**
 * The popup's behavior. `d` holds what the page owns: `fetch` carries the page's secret, `paint` redraws the buttons, `openConversation`
 * opens a request's worker. Typing stays through a redraw, because the capture box sits outside the list and a note is kept here.
 */
export function makeTodayPop(d) {
  const { $ } = d;
  const box = $('today-text'), listEl = $('today-list'), goBtn = $('today-go'), micBtn = $('today-mic'), err = $('today-err');
  const s = { open: null, picks: {}, history: false, notRight: false, noteText: '', error: '', moved: null };
  let list = [], go = false, movedTimer, rec = null, stream = null;

  const setError = m => { err.textContent = m; err.hidden = !m; };
  const setGo = on => { go = on; goBtn.setAttribute('aria-pressed', String(on)); };
  function draw() {
    const noteFocused = document.activeElement?.matches?.('[data-note]');
    const at = noteFocused ? document.activeElement.selectionStart : null;
    listEl.innerHTML = todayListHtml(list, { ...s, picks: s.picks[s.open] ?? {} });
    $('today-sub').textContent = todaySub(list);
    if (noteFocused) { const n = listEl.querySelector('[data-note]'); n?.focus(); n?.setSelectionRange(at, at); }
  }
  function show(next) {
    list = next;
    if (s.open !== null && !list.some(i => i.id === s.open)) closeRow();
    draw();
    d.paint();
  }
  function closeRow() { s.open = null; s.notRight = false; s.noteText = ''; s.error = ''; }
  async function post(path, body) {
    const r = await d.fetch(path, { method: 'POST', body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (j.today) list = j.today;
    if (!r.ok) throw new Error(j.error || `error ${r.status}`);
    return j;
  }

  async function add(words) {
    const wasGo = go;
    setError('');
    box.value = ''; setGo(false); // cleared at once, so several go in quickly. A failure puts the words back.
    try { await post('/api/today/add', { words, go: wasGo }); show(list); }
    catch (e) { box.value = words; setGo(wasGo); setError(`Not added: ${e.message}`); }
  }
  async function act(id, action, extra = {}) {
    s.error = '';
    try {
      const answers = (list.find(i => i.id === id)?.questions ?? []).map((q, n) => shownAnswer(q, s.picks[id]?.[n]));
      const j = await post('/api/today/act', { id, action, answers, ...extra });
      delete s.picks[id];
      if (j.moved) {
        s.moved = j.moved;
        clearTimeout(movedTimer);
        movedTimer = setTimeout(() => { s.moved = null; draw(); }, 5000);
      }
      if (action !== 'kind' && action !== 'discuss') closeRow();
      s.notRight = false; s.noteText = '';
      show(list);
      if (action === 'discuss') d.closePop();
    } catch (e) { s.error = e.message; show(list); }
  }

  $('today-form').addEventListener('submit', e => { e.preventDefault(); const w = box.value.trim(); if (w) add(w); else box.focus(); });
  box.addEventListener('paste', e => globalThis.pasteText?.(e, box));
  goBtn.onclick = () => setGo(!go);
  listEl.addEventListener('click', e => {
    const item = e.target.closest('.t-item'), id = item && Number(item.dataset.id);
    if (e.target.closest('[data-history]')) { s.history = !s.history; return draw(); }
    const openLink = e.target.closest('[data-open]');
    if (openLink) return d.openConversation(Number(openLink.dataset.open));
    if (e.target.closest('a.t-link[href^="#report/"]')) return d.closePop();
    if (e.target.closest('[data-toggle]')) {
      const same = s.open === id;
      closeRow();
      if (!same) s.open = id;
      return draw();
    }
    const kind = e.target.closest('[data-kind]');
    if (kind) return void act(id, 'kind', { kind: kind.dataset.kind });
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const a = b.dataset.act;
    if (a === 'not-right') { s.notRight = !s.notRight; draw(); return listEl.querySelector('[data-note]')?.focus(); }
    if (a === 'answers') return void act(id, 'answers');
    return void act(id, a);
  });
  listEl.addEventListener('change', e => {
    const r = e.target.closest('input[type=radio][data-q]');
    if (!r) return;
    const id = Number(e.target.closest('.t-item').dataset.id);
    (s.picks[id] ??= {})[r.dataset.q] = r.value;
    draw();
  });
  listEl.addEventListener('input', e => { if (e.target.matches('[data-note]')) s.noteText = e.target.value; });
  listEl.addEventListener('submit', e => {
    if (!e.target.matches('[data-note-form]')) return;
    e.preventDefault();
    const note = s.noteText.trim();
    if (note) act(s.open, 'not-right', { note }); else listEl.querySelector('[data-note]')?.focus();
  });

  // The microphone: a tap starts, a tap stops, and the words become one item. It never goes to the chat.
  const setMic = state => { micBtn.dataset.state = state; micBtn.setAttribute('aria-label', state === 'rec' ? 'Stop and add' : state === 'busy' ? 'Adding' : 'Add by voice'); };
  async function micTap() {
    if (micBtn.dataset.state === 'busy') return;
    if (rec) return rec.stop();
    setError('');
    try { stream = stream || await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
    catch (e) { return setError(`Microphone unavailable: ${e.message}`); }
    const chunks = [], r = new MediaRecorder(stream);
    rec = r;
    d.holdMic(true); // hands-free must not send these words to the chat too
    r.ondataavailable = ev => ev.data.size && chunks.push(ev.data);
    r.onstop = async () => {
      rec = null;
      d.holdMic(false);
      for (const track of stream.getTracks()) track.stop(); // the phone stops showing the mic as in use
      stream = null;
      const blob = new Blob(chunks, { type: r.mimeType }), wasGo = go;
      if (blob.size < 2000) { setMic('idle'); return setError("Didn't catch that."); }
      setMic('busy');
      try {
        const res = await d.fetch(`/api/today/voice?go=${wasGo ? 1 : 0}`, { method: 'POST', body: blob });
        const j = await res.json().catch(() => ({}));
        if (j.today) list = j.today;
        if (!res.ok) throw new Error(j.error || `error ${res.status}`);
        if (!j.words) setError("Didn't catch that."); else setGo(false);
        show(list);
      } catch (e) { setError(`Not added: ${e.message}`); }
      setMic('idle');
    };
    r.start();
    setMic('rec');
  }
  micBtn.onclick = micTap;
  setMic('idle');

  return {
    show,
    current: () => list,
    focus: () => box.focus({ preventScroll: true }),
    /** Closing the popup stops a recording, and keeps what it heard. */
    closed: () => { if (rec) rec.stop(); closeRow(); draw(); },
  };
}
