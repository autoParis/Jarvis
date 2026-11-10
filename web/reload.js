// The page reloads itself when jarvisd serves new web code. Before 2026-11-10 an open page (a desktop tab, or the
// installed phone app) kept running the old JS after a restart, until the owner reloaded it by hand. He then tested a
// fix on a stale page and saw it broken.
//
// jarvisd sends a 'version' event on each connect of /api/events and answers GET /api/version (daemon/webfiles.ts).
// The first version a page sees is the one it loaded with. A different version later means new code: the page reloads.
// It never reloads while the owner is busy: typing in a box, recording voice, a dialog or popup open, an unsent text in
// any box, or a key or tap in the last few seconds. Then it shows a small Reload button and tries again every few
// seconds, so it reloads once he is idle. location.reload() keeps the address, so the open report (#report/<id>,
// #reports/...) comes back. Tested by daemon/reload.test.ts.

/** No key or tap for this long counts as idle. */
export const QUIET_MS = 5_000;
/** While the owner is busy, the reloader looks again this often. */
export const RETRY_MS = 3_000;

/**
 * The boxes the owner typed in, so a half-written answer or draft keeps the page from reloading. A box counts while its
 * text is what he left in it: the page clearing it after a send, or filling it with new text, makes it count no more.
 */
export function makeTyped() {
  const left = new Map();
  return {
    /** An `input` event from the owner in this box. */
    input(el) { left.set(el, el.value); },
    /** true when a box still holds text the owner typed and did not send. */
    dirty() {
      for (const [el, text] of left) {
        if (el.isConnected === false || el.value !== text || !String(text).trim()) left.delete(el);
        else return true;
      }
      return false;
    },
  };
}

const EDITABLE = 'input, textarea, select, [contenteditable]';

/**
 * Why the page must not reload now, or '' when it may. `active` is document.activeElement, `typed` a makeTyped(),
 * `recording` true while the mic records or a clip uploads, `overlay` true while a dialog or popup is open, and
 * `quietFor` the milliseconds since the last key or tap.
 */
export function busyReason({ active, typed, recording, overlay, quietFor }) {
  if (recording) return 'recording';
  // The desktop chat box keeps the focus all day. Empty and quiet, it does not count as typing.
  const text = active?.isContentEditable ? active.textContent : active?.value;
  if (active?.matches?.(EDITABLE) && !active.disabled && !active.readOnly && String(text ?? '').trim()) return 'typing';
  if (overlay) return 'dialog';
  if (typed?.dirty()) return 'draft';
  if (quietFor < QUIET_MS) return 'active';
  return '';
}

/**
 * reload(): reloads the page. busy(): busyReason() for the page now. button(show): shows or hides the Reload button.
 * timers: { setInterval, clearInterval }, the window's in the page and fakes in the tests.
 */
export function makeReloader({ reload, busy, button, timers = globalThis }) {
  let loaded = null, stale = false, timer = null;
  /** Reloads now if the code is stale and the owner is idle. Returns what happened, for the tests. */
  function attempt() {
    if (!stale) return 'current';
    const why = busy();
    if (!why) {
      if (timer) timers.clearInterval(timer);
      timer = null;
      reload();
      return 'reloaded';
    }
    button(true);
    timer ??= timers.setInterval(attempt, RETRY_MS);
    return why;
  }
  return {
    /** A version from jarvisd: the 'version' event, or GET /api/version on resume. */
    seen(version) {
      if (!version) return 'current';
      loaded ??= version;
      if (version !== loaded) stale = true;
      return attempt();
    },
    attempt,
    get stale() { return stale; },
  };
}
