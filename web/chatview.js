// One chat on the page: the message list, its message rows, and the message box under it with attach, paste, the pen,
// the mic and read aloud. The brain chat (#chat) and a worker's pane (#pane) are the same chat: each calls chatHtml for
// its markup and makeChat for its behaviour. Only three things differ, and the caller passes them in:
//   - the feed: what goes into the list. The brain chat gets pushed numbered turns, the pane polls the worker's
//     transcript by byte offset. Each feed builds its rows with chatLine and adds them with list.append.
//   - the send target: `send` for a typed message, `onClip` for a dictation.
//   - the extras: hands-free (the brain chat only), the reply strip, the pane's cards and hints (`above`, `below`).
// Tested by daemon/chatview.test.ts.
import { messageRow, copyMessage, tapLine } from './messagerow.js';
import { makeComposer } from './composer.js';
import { makeMic } from './mic.js';
import { enterSends } from './enterkey.js';
import { quoteHtml } from './workfold.js';
import { splitPictures, shotRowHtml } from './draw.js';

export const DICTATE = 'Dictate: hold to talk, or tap to start and tap again to send';
const ATTACH_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 11.5 12 19.5a5 5 0 0 1-7-7l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7L9.7 17.2a1.7 1.7 0 0 1-2.4-2.4L15 7"/></svg>';
const MIC_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>';
const WAVE_SVG = '<svg class="wave" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2"/></svg>';
const SEND_SVG = '<svg class="send" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6"/></svg>';
// Hands-free's three controls. They show only in voice mode (app.css #bar[data-mode="voice"]).
const HANDS_FREE = '<button id="keys" type="button" class="ib" aria-label="Type instead" title="Type instead"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 10h.01M11 10h.01M15 10h.01M7 14h10"/></svg></button>'
  + '<button id="voice-state" type="button" aria-live="polite"><span class="vdot" aria-hidden="true"></span><span id="voice-label">Listening</span></button>'
  + '<button id="hands-end" type="button">End</button>';

const idAttr = (ids, part) => ids[part] ? ` id="${ids[part]}"` : '';

/**
 * The markup of one chat: the scrolling list, then the dock with the working line, `above`, the picture tray, the pill
 * (attach, text, mic, send) and `below`. `ids` names the parts the page reaches by id. With `handsFree` the send button
 * is also the hands-free button (the wave shows while the box is empty) and the pill has hands-free's controls. Without
 * it the button only sends, so its arrow always shows.
 */
export function chatHtml({ ids = {}, label, placeholder = '', handsFree = false, above = '', below = '' }) {
  const go = handsFree
    ? `<button${idAttr(ids, 'go')} type="button" class="chat-go" aria-label="Start hands-free" title="Hands-free">${WAVE_SVG}${SEND_SVG}</button>`
    : `<button${idAttr(ids, 'go')} type="submit" class="chat-go send" aria-label="Send" title="Send">${SEND_SVG}</button>`;
  return `<div class="chat-log"${idAttr(ids, 'log')}><div class="chat-items"${idAttr(ids, 'items')}></div></div>`
    + `<form${idAttr(ids, 'form')} class="dock chat-dock"><div class="dock-in">`
    + `<div${idAttr(ids, 'working')} class="working-line" hidden><span class="dots" aria-hidden="true"><i></i><i></i><i></i></span>Working…</div>`
    + above
    + `<div${idAttr(ids, 'tray')} class="tray chat-tray"></div>`
    + `<div class="composer"${idAttr(ids, 'composer')}><div class="field chat-bar"${idAttr(ids, 'bar')} data-mode="type">`
    + `<button${idAttr(ids, 'add')} type="button" class="ib chat-add" aria-label="Attach a picture" title="Attach a picture">${ATTACH_SVG}</button>`
    + `<input${idAttr(ids, 'file')} class="chat-file" type="file" multiple accept="image/png,image/jpeg,image/webp,image/gif" hidden>`
    + `<textarea${idAttr(ids, 'box')} class="chat-box" rows="1" placeholder="${placeholder}" aria-label="${label}"></textarea>`
    + `<button${idAttr(ids, 'mic')} type="button" class="ib chat-mic" aria-label="${DICTATE}" title="Dictate">${MIC_SVG}</button>`
    + go + (handsFree ? HANDS_FREE : '')
    + `</div></div>`
    + below
    + `</div></form>`;
}

/** The parts of a chat drawn by chatHtml inside `host`, found by class, so they work with or without ids. */
export function chatParts(host) {
  const q = sel => host.querySelector(sel);
  return { form: q('.chat-dock'), log: q('.chat-log'), items: q('.chat-items'), working: q('.working-line'), composer: q('.composer'), tray: q('.chat-tray'), bar: q('.chat-bar'), add: q('.chat-add'), file: q('.chat-file'), box: q('.chat-box'), mic: q('.chat-mic'), go: q('.chat-go') };
}

/**
 * One message in either chat, as the same row: the owner's bubble on the right, the other side's markdown on the left.
 * `role` is 'owner' or 'agent' (Jarvis, or the worker). `bodyHtml` is the agent's drawn markdown. For the owner, pass
 * `text` (with any `[image: path]` lines) and `quote`, and the row draws his pictures and words as the chat does.
 * `pending` marks an owner message the feed has not confirmed yet. The rest goes to messageRow (web/messagerow.js).
 */
export function chatLine({ doc, role, text, bodyHtml, quote, esc, render, at, speak, turn, between, pending, copy = text }) {
  const owner = role === 'owner';
  if (owner) {
    const p = splitPictures(text);
    bodyHtml = quoteHtml(quote) + shotRowHtml(p.paths, esc) + (p.text ? `<div class="msg-text">${render(p.text)}</div>` : '');
  }
  return messageRow({
    doc, lineClass: `line line-${owner ? 'owner' : 'jarvis'}`, bodyClass: owner ? `msg owner${pending ? ' pending' : ''}` : 'msg jarvis md',
    bodyHtml, text: copy, at, speak: owner ? null : speak, turn, between,
  });
}

/**
 * The list: new rows rise into place, and it stays pinned to the newest row while pictures and cards lay out, unless
 * the owner scrolled up. Its own scrolls are ignored, so a layout change in the same frame cannot unpin it. A click
 * goes to `onClick(e)` first, which returns true when it handled it. Then copy, then read aloud (`onSpeak(key, clips)`),
 * and on a touch screen a tap shows the row under the message.
 */
export function makeList({ log, items, onClick = () => false, onSpeak = () => {}, noHover = { matches: false }, Observer = globalThis.ResizeObserver }) {
  let pinned = true, autoTop = -1;
  const nearBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 120;
  function toBottom() { pinned = true; log.scrollTop = log.scrollHeight; autoTop = log.scrollTop; }
  log.addEventListener('scroll', () => { if (log.scrollTop !== autoTop) pinned = nearBottom(); });
  if (Observer) new Observer(() => { if (pinned) toBottom(); }).observe(items);
  items.addEventListener('click', e => {
    if (onClick(e)) return;
    const copy = e.target.closest('.msg-copy');
    if (copy) return copyMessage(copy);
    const speaker = e.target.closest('.msg-speak');
    if (speaker) return onSpeak(speaker.dataset.turn, Number(speaker.dataset.clips));
    tapLine(e, items, noHover.matches);
  });
  return {
    /** Adds a row. `force` scrolls to it even when the owner scrolled up (his own message). */
    append(el, { force = false, rise = true } = {}) {
      if (rise) el.classList.add('rise');
      const atBottom = nearBottom();
      items.appendChild(el);
      if (atBottom || force) toBottom();
    },
    toBottom,
    /** What opens grows downward from where the owner reads, so the view must not jump to the newest row. */
    unpin() { pinned = false; },
    /** Shows the top of the list, for a record that reads from its start. */
    toTop() { pinned = false; log.scrollTop = 0; autoTop = 0; },
    pinned: () => pinned,
  };
}

/**
 * The box and the mic of one chat, on the parts from chatParts. `send(message, { key, clear })` is the send target
 * (web/composer.js). `onClip(blob)` sends a dictation. `canSend()` is false while there is nowhere to send. `onError`
 * shows a failure, `onHint` what the mic does now, `onChange` runs after the box or the tray changes. Enter sends at
 * once; the Send button waits for the phone's dictation to settle. With `handsFree` the page wires the send button
 * itself, because there it is also the hands-free button.
 */
export function makeChat({ parts, doc = document, win = window, handsFree = false, upload, send, canSend = () => true, notify, onError, openViewer, pasteText,
  getStream, onStart, onHint = () => {}, onClip, onChange = () => {}, maxHeight = () => win.innerHeight * 0.3 }) {
  const { form, box, tray, add, file, mic, go, bar } = parts;
  const paint = () => bar.classList.toggle('has-text', !!box.value);
  const changed = () => { paint(); onChange(); };
  const composer = makeComposer({ doc, box, trayEl: tray, upload, send, notify, openViewer, pasteText, onChange: changed });
  /** The box grows with what is typed, up to a third of the screen, since the pill's buttons leave it narrow on a phone. */
  const fit = () => { box.style.height = 'auto'; if (box.value) box.style.height = Math.min(box.scrollHeight, maxHeight()) + 'px'; };
  box.addEventListener('input', () => { fit(); changed(); });
  add.onclick = () => file.click();
  file.onchange = () => { const files = [...file.files]; file.value = ''; files.forEach(composer.attach); };
  let sending = false;
  async function sendNow(settle = false) {
    if (!canSend() || (!box.value.trim() && !composer.items().length)) return box.focus();
    if (sending) return;
    sending = true;
    if (!handsFree) go.disabled = true;
    try { await composer.send(settle); }
    catch (err) { onError('Not sent: ' + err.message); }
    finally { sending = false; go.disabled = false; fit(); changed(); }
  }
  form.addEventListener('submit', e => { e.preventDefault(); sendNow(true); });
  box.addEventListener('keydown', e => { if (enterSends(e)) { e.preventDefault(); sendNow(false); } });
  const micCtl = makeMic({ button: mic, label: DICTATE, doc, getStream, onStart, onHint, onError, onClip });
  paint();
  return { composer, mic: micCtl, send: sendNow, fit, changed, box };
}
