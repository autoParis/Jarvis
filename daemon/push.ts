import { createECDH, createCipheriv, createPrivateKey, generateKeyPairSync, hkdfSync, randomBytes, sign } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Store, Item } from './store.ts';

// Web push without a library: VAPID (RFC 8292) signs who is sending, aes128gcm (RFC 8291) encrypts the payload.

export type Vapid = { publicKey: string; privateJwk: JsonWebKey; subject: string };
export type PushSub = { endpoint: string; keys: { p256dh: string; auth: string } };
export type PushMessage = { title: string; body: string; url: string; tag: string };
type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: Buffer }) => Promise<{ status: number; text(): Promise<string> }>;

const b64u = (b: Buffer) => b.toString('base64url');

/**
 * Keys come from JARVIS_VAPID_PUBLIC / JARVIS_VAPID_PRIVATE (base64url raw P-256 point and scalar), else from
 * `file` (data/vapid.json, gitignored), else they are generated once into `file`. Changing them drops every phone's subscription.
 */
export function loadVapid(file: string, env = process.env): Vapid {
  const subject = env.JARVIS_VAPID_SUBJECT || 'mailto:owner@example.test';
  if (env.JARVIS_VAPID_PUBLIC && env.JARVIS_VAPID_PRIVATE) {
    const pub = Buffer.from(env.JARVIS_VAPID_PUBLIC, 'base64url');
    return { publicKey: env.JARVIS_VAPID_PUBLIC, subject, privateJwk: {
      kty: 'EC', crv: 'P-256', x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)), d: env.JARVIS_VAPID_PRIVATE } };
  }
  if (existsSync(file)) return { subject, ...JSON.parse(readFileSync(file, 'utf8')) };
  const jwk = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ format: 'jwk' });
  const keys = { publicKey: b64u(Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, 'base64url'), Buffer.from(jwk.y!, 'base64url')])), privateJwk: jwk };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(keys), { mode: 0o600 });
  return { subject, ...keys };
}

function vapidAuth(endpoint: string, v: Vapid): string {
  const header = b64u(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(Buffer.from(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: v.subject })));
  const key = createPrivateKey({ key: v.privateJwk, format: 'jwk' });
  const sig = sign('sha256', Buffer.from(`${header}.${claims}`), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${header}.${claims}.${b64u(sig)}, k=${v.publicKey}`;
}

/** One aes128gcm record: salt, record size, the sender's one-time public key, then the ciphertext. */
export function encrypt(payload: Buffer, sub: PushSub): Buffer {
  const uaPub = Buffer.from(sub.keys.p256dh, 'base64url');
  const ecdh = createECDH('prime256v1');
  const asPub = ecdh.generateKeys();
  const salt = randomBytes(16);
  const ikm = Buffer.from(hkdfSync('sha256', ecdh.computeSecret(uaPub), Buffer.from(sub.keys.auth, 'base64url'),
    Buffer.concat([Buffer.from('WebPush: info\0'), uaPub, asPub]), 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([payload, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPub.length]), asPub, body]);
}

/**
 * Sends one high-priority message to every subscribed device. A 404 or 410 means the browser dropped the
 * subscription, so it is deleted. Returns how many devices accepted it; 0 means nobody was reached.
 */
export async function pushAll(store: Store, v: Vapid, msg: PushMessage, log: (m: string) => void, fetchImpl: Fetch = fetch as any): Promise<number> {
  let sent = 0;
  for (const sub of store.pushSubs()) {
    try {
      const res = await fetchImpl(sub.endpoint, {
        method: 'POST',
        headers: { TTL: '3600', Urgency: 'high', Topic: msg.tag.replace(/[^\w-]/g, '').slice(0, 32),
          'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', Authorization: vapidAuth(sub.endpoint, v) },
        body: encrypt(Buffer.from(JSON.stringify(msg)), sub),
      });
      if (res.status === 404 || res.status === 410) { store.removePushSub(sub.endpoint); log(`push: dropped expired subscription ${new URL(sub.endpoint).host}`); }
      else if (res.status >= 200 && res.status < 300) sent++;
      else log(`push: ${res.status} from ${new URL(sub.endpoint).host}: ${(await res.text()).slice(0, 200)}`);
    } catch (e) { log(`push: ${new URL(sub.endpoint).host} unreachable: ${e}`); }
  }
  log(`push "${msg.title}" tag=${msg.tag} reached ${sent} device(s)`);
  return sent;
}

/** the owner's quiet hours, local time in `zone` (DST follows the zone): from `start` o'clock to `end` o'clock the next morning. */
export const QUIET_HOURS = { zone: 'America/Toronto', start: 18, end: 7 };

/** The wall clock in `zone` at instant `t`, as the fields Date.UTC takes. */
function wallClock(t: number, zone: string) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
  const p = Object.fromEntries(f.formatToParts(new Date(t)).map(x => [x.type, Number(x.value)]));
  return { y: p.year, mo: p.month - 1, d: p.day, h: p.hour, mi: p.minute, s: p.second };
}

export function isQuietHours(t: number, q = QUIET_HOURS): boolean {
  const { h } = wallClock(t, q.zone);
  return q.start > q.end ? h >= q.start || h < q.end : h >= q.start && h < q.end;
}

/** The next instant after `t` when the clock in the zone reads `end` o'clock. */
export function quietHoursEnd(t: number, q = QUIET_HOURS): number {
  const w = wallClock(t, q.zone);
  const day = w.h >= q.end ? w.d + 1 : w.d;
  // Read the wall clock as if it were UTC, then shift by the zone's offset at that instant (checked twice for a DST change).
  let guess = Date.UTC(w.y, w.mo, day, q.end);
  for (let i = 0; i < 2; i++) {
    const c = wallClock(guess, q.zone);
    guess += Date.UTC(w.y, w.mo, day, q.end) - Date.UTC(c.y, c.mo, c.d, c.h, c.mi, c.s);
  }
  return guess;
}

/** UTC 'YYYY-MM-DD HH:MM:SS', the format SQLite's datetime('now') writes. */
export const sqlTime = (t: number) => new Date(t).toISOString().slice(0, 19).replace('T', ' ');

/**
 * Every phone push goes through here. In quiet hours a push that is not urgent is stored in `held_pushes` and goes
 * out at the end of quiet hours from `flush`, which the 30 s sweep calls. `item` ties a held push to its `items` row:
 * flush marks it pushed once a device took it, and drops the push if the item was answered or closed meanwhile.
 * Returns how many devices were reached now (0 when held), so the caller marks an item pushed only when it went out.
 */
export function makeNotifier(store: Store, send: (m: PushMessage) => Promise<number>, log: (m: string) => void, clock = Date.now) {
  async function notify(msg: PushMessage, opts: { urgent?: boolean; item?: string } = {}): Promise<number> {
    const now = clock();
    if (!opts.urgent && isQuietHours(now)) {
      if (store.holdPush(msg, opts.item ?? null, sqlTime(quietHoursEnd(now)))) log(`push held for quiet hours: "${msg.title}" tag=${msg.tag}`);
      return 0;
    }
    store.dropHeldPushes(msg.tag); // it goes out now; a copy held overnight must not follow it
    return send(msg);
  }

  async function flush() {
    for (const h of store.duePushes(sqlTime(clock()))) {
      const i = h.item ? store.item(h.item) : undefined;
      const ask = i && (i.kind === 'question' || i.kind === 'escalation');
      if (i && (!['new', 'spoken'].includes(i.status) || (ask && store.ownerSpokeSince(h.held_at)))) {
        store.dropHeldPushes(h.tag);
        log(`push dropped after quiet hours, ${h.item} no longer waits: tag=${h.tag}`);
        continue;
      }
      if (!store.claimHeldPush(h.id)) continue;
      let reached = 0;
      try { reached = await send(JSON.parse(h.message)); } catch (e) { log(`push: ${e}`); }
      if (reached === 0) { store.releaseHeldPush(h.id); continue; }
      if (h.item) store.markPushed(h.item);
    }
  }

  return { notify, flush };
}

/** The first push waits this long for the owner to answer in the app; one reminder follows, then Jarvis waits. */
export const ASK_DELAY_MS = Number(process.env.JARVIS_PUSH_DELAY_MS ?? 90_000);
export const REMINDER_MS = 10 * 60_000;

/**
 * Pushes open asks and escalations the owner has not answered. Restart-safe: the push count and time live on the item.
 * Anything the owner says after the ask (or after its last push) counts as being there, since he may answer
 * through a reply the store never sees.
 */
export async function pushOpenAsks(store: Store, send: (m: PushMessage, opts: { item: string }) => Promise<number>, now = Date.now()) {
  for (const i of store.openItems()) {
    if (i.status === 'replying') continue; // Jarvis is answering it; the brief shows it if that stalls
    const since = i.pushed_at ?? i.created_at;
    const wait = i.pushes === 0 ? ASK_DELAY_MS : i.pushes === 1 ? REMINDER_MS : Infinity;
    if (now - Date.parse(since.replace(' ', 'T') + 'Z') < wait || store.ownerSpokeSince(since)) continue;
    const reached = await send(askMessage(i), { item: i.external_id });
    if (reached > 0) store.markPushed(i.external_id);
  }
}

export function askMessage(i: Item): PushMessage {
  const title = i.source === 'brain' ? 'Jarvis is asking' : i.kind === 'escalation' ? 'Jarvis: a worker is stuck' : 'Jarvis: a worker is asking';
  const q = /QUESTION:\s*(.+)/.exec(i.body ?? '')?.[1];
  return { title, body: (q ?? i.subject ?? i.body ?? '').slice(0, 180), url: `/?item=${encodeURIComponent(i.external_id)}`, tag: `item-${i.external_id}` };
}

/** Jarvis marks a reply urgent by starting it with `[urgent]`; the marker is never shown or spoken. */
export function urgent(text: string): { urgent: boolean; text: string } {
  const m = /^\s*\[urgent\]\s*/i.exec(text);
  return m ? { urgent: true, text: text.slice(m[0].length) } : { urgent: false, text };
}
