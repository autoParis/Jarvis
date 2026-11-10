// What waits behind the Messages button: emails, and messages the owner must send himself (`outbox`). Slack later is one more
// entry in SOURCES. They never join the Requests list. Send reply in the popup is the owner's Approve for gmail-send, so the
// same gate records and runs it. An outbox card has no send action: The owner copies it, sends it himself and taps Done.
import { OWNER_CAP, OWNER } from './config.ts';
import { randomUUID } from 'node:crypto';
import type { Item, Store, Approval } from './store.ts';
import type { Gate } from './gate.ts';
import { replyAll, selfAddresses, stripSignoff, OWNER_EMAILS, type EmailMeta } from './gmail.ts';
import type { PushMessage } from './push.ts';
import { GMAIL_ACCOUNT as CONFIG_GMAIL_ACCOUNT } from './config.ts';
import type { RouteResult, Body } from './route.ts';

// The account `gws` reads, so the link opens the right mailbox when a browser holds several.
const GMAIL_ACCOUNT = CONFIG_GMAIL_ACCOUNT;

export type MessageCard = {
  id: string; source: string; label: string; urgent: boolean; from: string; address: string;
  subject: string; summary: string; draft: string; at: string; openLabel: string; openUrl: string;
  /** Nothing here sends it: the popup offers Copy and Done, and `from` is who it is for. */
  copyOnly: boolean;
  /** Who Send reply goes to: reply all, without the owner. Null when an older email's list is read from Gmail at send time. */
  replyTo?: { to: string[]; cc: string[] } | null;
};

/** Who an outbox card is for, how the owner sends it, and the words. The reason is the item's subject. */
export type OutboxMeta = { to: string; channel: string; text: string };
const CHANNELS: Record<string, string> = { slack: 'Slack', email: 'email' };

const SOURCES: Record<string, { label: string; openLabel: string; sendAction?: string; fields(i: Item, meta: any, self: string[]): Pick<MessageCard, 'urgent' | 'from' | 'address' | 'draft' | 'openUrl'> & { label?: string; replyTo?: MessageCard['replyTo'] } }> = {
  gmail: {
    label: 'Email', openLabel: 'Open in Gmail', sendAction: 'gmail-send',
    fields: (_i, m: Partial<EmailMeta>, self) => ({
      replyTo: Array.isArray(m.to) && Array.isArray(m.cc) ? replyAll(m, self) : null,
      urgent: m.urgent === true, from: m.fromName || m.from || 'Unknown sender', address: m.from ?? '', draft: stripSignoff(m.reply ?? ''),
      openUrl: `https://mail.google.com/mail/?authuser=${encodeURIComponent(GMAIL_ACCOUNT)}#all/${encodeURIComponent(m.threadId ?? m.gmailId ?? '')}`,
    }),
  },
  outbox: {
    label: 'To send', openLabel: '',
    fields: (_i, m: Partial<OutboxMeta>) => ({ label: `To send on ${CHANNELS[m.channel ?? ''] ?? m.channel}`, urgent: false, from: m.to ?? 'Unknown', address: '', draft: m.text ?? '', openUrl: '' }),
  },
};

const argsOf = (a: Approval) => { try { return JSON.parse(a.args); } catch { return {}; } };

/** One card. A reply the brain proposed replaces the triage draft, so the owner sees the words he asked for. */
export function messageCard(i: Item, proposed?: string, self: string[] = OWNER_EMAILS): MessageCard {
  const src = SOURCES[i.source];
  let meta = {};
  try { meta = JSON.parse(i.meta ?? '{}'); } catch {}
  const f = src.fields(i, meta, self);
  return { id: i.external_id, source: i.source, label: src.label, ...f, draft: proposed ?? f.draft, subject: i.subject ?? '', summary: i.body ?? '', at: `${i.created_at.replace(' ', 'T')}Z`, openLabel: src.openLabel, openUrl: f.openUrl, copyOnly: !src.sendAction };
}

/** One line of the brain's session brief. */
export function outboxLine(i: Item): string {
  const m = JSON.parse(i.meta ?? '{}') as OutboxMeta;
  return `- [to send] item=${i.external_id} to=${JSON.stringify(m.to)} channel=${m.channel} reason=${JSON.stringify(i.subject)} text=${JSON.stringify(m.text)}`;
}

/** Urgent first, then the one that has waited longest. */
export const messageOrder = (list: MessageCard[]) => [...list].sort((a, b) => Number(b.urgent) - Number(a.urgent) || Date.parse(a.at) - Date.parse(b.at));

/** The push for an urgent email. Tapping it opens that email. */
export function emailPush(i: Item, meta: Pick<EmailMeta, 'fromName' | 'from'>): PushMessage {
  return { title: `Jarvis: urgent email from ${meta.fromName || meta.from}`, body: (i.body ?? '').slice(0, 180), url: `/?item=${encodeURIComponent(i.external_id)}`, tag: `item-${i.external_id}` };
}

export function makeMessages(d: { store: Store; gate: Gate; log: (m: string, f?: object) => void; onChange: () => void }) {
  const { store, gate, log } = d;
  const busy = new Set<string>(); // a second press, from this page or another, cannot race the first
  const proposals = (id: string) => store.pendingApprovals().filter(a => a.action === 'gmail-send' && argsOf(a).item === id);

  function list(): MessageCard[] {
    const proposed = new Map<string, string>();
    for (const a of store.pendingApprovals()) if (a.action === 'gmail-send') { const { item, text } = argsOf(a); if (item) proposed.set(item, text); }
    // The button stays until the owner acts, so no age limit here. A proposal keeps its email listed even if triage filed it as done.
    const open = [...store.openEmails(null), ...store.openOutbox()];
    const seen = new Set(open.map(i => i.external_id));
    const more = [...proposed.keys()].filter(id => !seen.has(id)).map(id => store.item(id)).filter((i): i is Item => !!i && i.source === 'gmail' && i.status !== 'answered');
    const self = selfAddresses(store);
    return messageOrder([...open, ...more].map(i => messageCard(i, proposed.get(i.external_id), self)));
  }
  /** A reply proposed earlier no longer stands. Nobody decided it, so it stays out of the audit log and the chat. */
  function dropProposals(id: string, keep?: number) {
    for (const a of proposals(id)) if (a.id !== keep) gate.superseded(a.id);
  }
  const refused = (status: number, error: string) => ({ status, body: { error, messages: list() } });

  return {
    list,
    dropProposals,
    /** `jarvis-act message-add`. The same words to the same person while a card is open return that card, so a retry adds nothing. */
    add(b: { to?: unknown; channel?: unknown; reason?: unknown; text?: unknown }): { status: number; body: unknown } {
      const oneLine = (v: unknown) => typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
      const to = oneLine(b.to), reason = oneLine(b.reason), channel = String(b.channel ?? ''), text = typeof b.text === 'string' ? b.text.trim() : '';
      if (!to) return { status: 400, body: { error: '--to is required' } };
      if (!Object.hasOwn(CHANNELS, channel)) return { status: 400, body: { error: '--channel must be slack or email' } };
      if (!reason) return { status: 400, body: { error: '--reason is required' } };
      if (!text) return { status: 400, body: { error: '--text is required' } };
      const same = store.openOutbox().find(i => { const m = JSON.parse(i.meta ?? '{}') as OutboxMeta; return m.to === to && m.channel === channel && m.text === text; });
      if (same) return { status: 200, body: { ...messageCard(same), existing: true } };
      const meta: OutboxMeta = { to, channel, text };
      const item = store.insertItem({ source: 'outbox', external_id: `outbox:${randomUUID()}`, kind: 'outbox', subject: reason, meta: JSON.stringify(meta), status: 'spoken' })!;
      log('message card added', { item: item.external_id, channel });
      d.onChange();
      return { status: 200, body: messageCard(item) };
    },
    async send(id: string, text: string): Promise<{ status: number; body: { error?: string; approval?: Approval; messages: MessageCard[] } }> {
      const item = store.item(id), action = item && SOURCES[item.source]?.sendAction;
      if (!item || !action) return refused(404, 'That message is not known here.');
      if (!list().some(m => m.id === id)) return refused(409, 'That message is no longer open.');
      if (!text.trim()) return refused(400, 'Write a reply first.');
      if (busy.has(id)) return refused(409, 'That reply is already going out.');
      busy.add(id);
      try {
        const card = messageCard(item);
        const a = await gate.propose(action, { item: id, text: text.trim() }, `Send the reply to ${card.from}?`);
        dropProposals(id, a.id);
        const done = await gate.button(a.id, true);
        log('message reply pressed', { item: id, approval: done.id, status: done.status });
        return done.status === 'failed' ? { status: 502, body: { error: done.result ?? 'Not sent.', approval: done, messages: list() } } : { status: 200, body: { approval: done, messages: list() } };
      } catch (e) {
        return refused(409, (e as Error).message);
      } finally { busy.delete(id); }
    },
    /** I'll handle it: the same closing as `jarvis-act email-done`. On an outbox card this is Done. */
    handled(id: string): { status: number; body: { error?: string; messages: MessageCard[] } } {
      const item = store.item(id);
      if (!item || !SOURCES[item.source]) return refused(404, 'That message is not known here.');
      if (busy.has(id) || store.gmailSendFor(id)) return refused(409, 'A reply to it is already going out.');
      if (!list().some(m => m.id === id)) return refused(409, 'That message is no longer open.');
      dropProposals(id);
      store.markItem(id, 'answered', SOURCES[item.source].sendAction ? `left to ${OWNER}` : `${OWNER_CAP} tapped Done`);
      log('message left to the owner', { item: id });
      d.onChange();
      return { status: 200, body: { messages: list() } };
    },
  };
}

export type Messages = ReturnType<typeof makeMessages>;
/**
 * The Messages popup's routes. Send reply is the owner's Approve for this email, with the words now in the box: `approved`
 * tells the brain the outcome. I'll handle it, or Done on a message the owner sends himself, closes the card: `handled`
 * tells the brain. jarvis-act message-add adds a card.
 */
export async function messagesRoute(o: { messages: Pick<Messages, 'send' | 'handled' | 'add'>; approved: (a: Approval) => void; handled: (id: string) => void },
  method: string, url: string, body: Body): Promise<RouteResult | undefined> {
  if (method !== 'POST') return undefined;
  if (url === '/api/message/send') {
    const { id, text } = await body();
    if (typeof id !== 'string' || typeof text !== 'string') return { status: 400, body: { error: 'id and text are required' } };
    const r = await o.messages.send(id, text);
    if (r.body.approval) o.approved(r.body.approval);
    return r;
  }
  if (url === '/api/message/handled') {
    const { id } = await body();
    if (typeof id !== 'string') return { status: 400, body: { error: 'id is required' } };
    const r = o.messages.handled(id);
    if (r.status === 200) o.handled(id);
    return r;
  }
  if (url === '/api/internal/messages') return o.messages.add(await body());
  return undefined;
}
