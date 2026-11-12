// One message on the page: its body and the row under it (web/workfold.js messageFootHtml). The brain chat and a
// worker's pane both draw through here. Each keeps its own data feed. Tested by daemon/messagerow.test.ts.
import { messageFootHtml, COPY_ICON, COPIED_ICON } from './workfold.js';

const copyText = new WeakMap(); // what the copy button under each message copies

/**
 * Builds a message line. `lineClass` and `bodyClass` are the two classes, `bodyHtml` the drawn message, and `text` what
 * the copy button copies. `between` is an element that sits between the body and the row (Approve and Reject on a
 * brain message). Pass no `at` for a row with no time.
 */
export function messageRow({ doc = document, lineClass, bodyClass, bodyHtml, text, at, speak, turn, between }) {
  const body = doc.createElement('div');
  body.className = bodyClass;
  body.innerHTML = bodyHtml;
  const line = doc.createElement('div');
  line.className = lineClass;
  line.append(body);
  if (between) line.append(between);
  line.insertAdjacentHTML('beforeend', messageFootHtml(at, speak, turn));
  copyText.set(line, text);
  return line;
}

export const rowText = line => copyText.get(line);

/** The copy button: writes the message to the clipboard, and shows a check for 1.5 s or says why it could not. */
export async function copyMessage(b, clipboard = navigator.clipboard) {
  let done = true;
  try { await clipboard.writeText(rowText(b.closest('.line'))); } catch { done = false; }
  b.innerHTML = done ? COPIED_ICON : COPY_ICON;
  b.title = done ? 'Copied' : 'Could not copy';
  b.setAttribute('aria-label', b.title);
  clearTimeout(b.resetTimer);
  b.resetTimer = setTimeout(() => { b.innerHTML = COPY_ICON; b.title = 'Copy'; b.setAttribute('aria-label', 'Copy message'); }, 1500);
}

/** A touch screen has no hover: a tap on a message shows its row, and a tap anywhere else in `root` hides it. */
export function tapLine(e, root, noHover) {
  if (!noHover || e.target.closest('a, button') || !root.ownerDocument.getSelection().isCollapsed) return;
  const line = e.target.closest('.line');
  const was = line?.classList.contains('shown');
  root.querySelectorAll('.line.shown').forEach(x => x.classList.remove('shown'));
  if (line && !was) line.classList.add('shown');
}
