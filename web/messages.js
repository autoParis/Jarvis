// The Messages button and the card behind it, as text and HTML. Every piece of text is escaped. A module so the page and
// daemon/messages.test.ts import the same code. The list comes from daemon/messages.ts, urgent first. `copyOnly` is a
// message the owner sends himself: `from` is who it is for, and the buttons copy and close it.
import { esc, ago } from './requestlist.js';

/** The button: always "Messages". `urgent` paints it red while an urgent one is open, otherwise it is the calm teal tint. Null when nothing waits. */
export function messageButton(list) {
  if (!list.length) return null;
  return { label: 'Messages', urgent: list.some(m => m.urgent), count: list.length, aria: `Messages, ${list.length} open` };
}
/** The words on the popup's fixed elements for this card. */
export function messageControls(m, copied) {
  return m.copyOnly
    ? { draft: 'Draft', send: copied ? 'Copied' : 'Copy', handled: 'Done' }
    : { draft: 'Draft reply', send: 'Send reply', handled: "I'll handle it" };
}
export const otherMessagesLabel = n => n === 1 ? '1 other message' : `${n} other messages`;
/** Who Send reply goes to. Replies go to everyone on the thread, so the owner sees the list before he taps. */
export function recipientsHtml(m) {
  if (m.copyOnly || m.replyTo === undefined) return '';
  if (!m.replyTo) return '<div class="msg-to">Reply all: Jarvis reads who is on the thread from Gmail before sending</div>';
  return `<div class="msg-to">To ${esc(m.replyTo.to.join(', '))}${m.replyTo.cc.length ? `<br>Cc ${esc(m.replyTo.cc.join(', '))}` : ''}</div>`;
}
/** The part of the card that only shows. The draft box and the buttons are fixed elements, so typing survives a redraw. */
export function messageHeadHtml(m, now, error) {
  return `<div class="ask-tag"><div class="ask-title">${esc(m.label)}${m.urgent ? ' <span class="urgent">Urgent</span>' : ''}</div><span class="ago">${ago(m.at, now)}</span></div>`
    + `<div class="msg-from">${m.copyOnly ? 'To ' : ''}${esc(m.from)}${m.address && m.address !== m.from ? ` <small>${esc(m.address)}</small>` : ''}</div>`
    + recipientsHtml(m)
    + `<h2 class="say">${esc(m.subject || '(no subject)')}</h2>`
    + (m.summary ? `<div class="c-detail">${esc(m.summary)}</div>` : '')
    + (error ? `<div class="outcome"><span class="pill failed">${m.copyOnly ? 'failed' : 'not sent'}</span>${esc(error)}</div>` : '');
}
