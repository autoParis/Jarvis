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
/** An `sms:` link that opens the phone's Messages app on that number with the words filled in. Null when `phone` is not a
 * phone number. The `?&body=` form works on both iPhone and Android. */
export function smsHref(phone, text) {
  const n = String(phone ?? '').replace(/[\s().-]/g, '');
  if (!/^\+?\d{7,15}$/.test(n)) return null;
  return `sms:${n}?&body=${encodeURIComponent(text ?? '')}`;
}
/** Under the name of a message the owner sends himself: the phone number or address, a Copy that copies only it, and for a
 * text message to a phone number a Text link. The page sets that link's words from the draft box when it is tapped. */
export function contactHtml(m, copied) {
  if (!m.copyOnly || !m.address) return '';
  const sms = m.channel === 'text' ? smsHref(m.address, m.draft) : null;
  return `<div class="msg-contact"><span class="msg-addr">${esc(m.address)}</span>`
    + `<button type="button" class="msg-contact-copy">${copied ? 'Copied' : 'Copy'}</button>`
    + (sms ? `<a class="msg-sms" href="${esc(sms)}">Text</a>` : '')
    + '</div>';
}
/** The part of the card that only shows. The draft box and the buttons are fixed elements, so typing survives a redraw. */
export function messageHeadHtml(m, now, error, contactCopied = false) {
  return `<div class="ask-tag"><div class="ask-title">${esc(m.label)}${m.urgent ? ' <span class="urgent">Urgent</span>' : ''}</div><span class="ago">${ago(m.at, now)}</span></div>`
    + `<div class="msg-from">${m.copyOnly ? 'To ' : ''}${esc(m.from)}${!m.copyOnly && m.address && m.address !== m.from ? ` <small>${esc(m.address)}</small>` : ''}</div>`
    + contactHtml(m, contactCopied)
    + recipientsHtml(m)
    + `<h2 class="say">${esc(m.subject || '(no subject)')}</h2>`
    + (m.summary ? `<div class="c-detail">${esc(m.summary)}</div>` : '')
    + (error ? `<div class="outcome"><span class="pill failed">${m.copyOnly ? 'failed' : 'not sent'}</span>${esc(error)}</div>` : '');
}
