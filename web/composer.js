// One message box with its picture tray. The brain chat and a worker's pane each make one, with their own send:
// the chat posts to /api/send, the pane to /api/work/steer. Tested by daemon/composer.test.ts.
//
// The pane's one box serves every worker, so the tray is kept per key (the worker's row id), as the typed drafts are
// (makeDrafts in web/backnav.js). switchTo(key) shows that worker's pictures. The chat uses one key.
import { sendOut } from './compose.js';
import { boxAfterSend, settleBox, withPictures } from './dictate.js';

export const IMAGE_OK = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'], IMAGE_MAX = 10 * 1024 * 1024;

const THUMB = '<button type="button" class="thumb-open" aria-label="Open the picture to see it big or draw on it" title="Open, or draw on it"><img alt=""></button><button type="button" class="thumb-remove" aria-label="Remove picture"><svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M2 2l6 6M8 2l-6 6"/></svg></button>';

/** Why a file cannot go in the tray, or '' if it can. */
export function refusal(f) {
  const name = f.name || 'the pasted picture';
  if (!IMAGE_OK.includes(f.type)) return `Can't attach ${name}: only png, jpg, webp and gif.`;
  if (f.size > IMAGE_MAX) return `Can't attach ${name}: larger than 10 MB.`;
  return '';
}

/**
 * `box` is the textarea and `trayEl` the element that holds the thumbnails. `upload(file)` returns a saved path.
 * `send(message, { key, clear })` posts one message and returns true if it went. It calls `clear()` to take the sent
 * text out of the box, before or after its post. `notify(text)` shows a refusal. `openViewer(url, item)` opens a picture
 * with the pen. `pasteText(e, box)` is web/paste.js: it returns true when the clipboard held text.
 */
export function makeComposer({ doc = document, box, trayEl, upload, send, notify, openViewer, pasteText = () => false, onChange = () => {}, urls = URL }) {
  const trays = new Map();
  let key = '', sending = false, composing = false;
  const tray = (k = key) => { if (!trays.has(k)) trays.set(k, []); return trays.get(k); };

  function attach(f) {
    const why = refusal(f);
    if (why) return notify(why);
    const el = doc.createElement('div');
    el.className = 'thumb';
    el.innerHTML = THUMB;
    // `base` is the picture as attached and `strokes` the pen marks on it. `file` is what the send uploads:
    // the base, or the base with the marks drawn in once the viewer closes.
    const item = { file: f, base: f, baseUrl: urls.createObjectURL(f), strokes: [], el, ready: Promise.resolve() };
    el.querySelector('img').src = item.baseUrl;
    el.querySelector('.thumb-open').onclick = () => openViewer(item.baseUrl, item);
    el.querySelector('.thumb-remove').onclick = () => unattach(item);
    tray().push(item);
    trayEl.append(el);
    onChange();
  }
  function unattach(item) {
    urls.revokeObjectURL(item.baseUrl);
    if (item.markedUrl) urls.revokeObjectURL(item.markedUrl);
    item.el.remove();
    for (const [k, list] of trays) trays.set(k, list.filter(a => a !== item));
    onChange();
  }
  /** Shows the tray of another key. Its pictures wait in their own list while another key shows. */
  function switchTo(k) {
    for (const item of tray()) item.el.remove();
    key = k;
    for (const item of tray()) trayEl.append(item.el);
    onChange();
  }

  // A picture pasted into the box takes the same path as the picker. Text on the clipboard wins,
  // so a copy that carries both (a spreadsheet range, a rich-text snippet) still pastes as text.
  box.addEventListener('paste', e => {
    if (pasteText(e, box)) return;
    const cb = e.clipboardData;
    if (!cb) return;
    // items rather than files: some phone browsers expose a pasted photo only as a file item
    const files = [...cb.items].filter(i => i.kind === 'file' && i.type.startsWith('image/')).map(i => i.getAsFile()).filter(Boolean);
    if (!files.length) return;
    e.preventDefault();
    files.forEach(attach);
  });
  box.addEventListener('compositionstart', () => { composing = true; });
  box.addEventListener('compositionend', () => { composing = false; });

  // The pictures upload before anything goes out, so a failed upload keeps the text and every picture in the box.
  // `settle` is for a tap on Send: the phone's dictation can commit its words a moment after the tap, so the send
  // waits for the box to go quiet (settleBox in web/dictate.js). The box is read again after the uploads, and only
  // the text that went out leaves it, so a picture send never wipes dictated words. A switch to another key during
  // the wait sends nothing: the box then holds the other worker's draft.
  async function sendNow(settle = false) {
    if ((!box.value.trim() && !tray().length) || sending) return;
    sending = true;
    const k = key;
    try {
      if (settle) await settleBox(box, { composing: () => composing });
      if (k !== key) return;
      const went = await sendOut({ tray: tray(k), upload, post: async lines => {
        if (k !== key) return false;
        const sent = box.value, message = withPictures(sent, lines);
        if (!message) return false;
        return send(message, { key: k, clear: () => { box.value = boxAfterSend(box.value, sent); } });
      } });
      went.forEach(unattach);
    } finally { sending = false; onChange(); }
  }

  return { attach, unattach, switchTo, send: sendNow, items: () => tray(), key: () => key, busy: () => sending, composing: () => composing };
}
