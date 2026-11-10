import test from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, createDecipheriv, createPublicKey, hkdfSync, randomBytes, verify } from 'node:crypto';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from './store.ts';
import { loadVapid, pushAll, pushOpenAsks, askMessage, urgent, isQuietHours, quietHoursEnd, makeNotifier, ASK_DELAY_MS, REMINDER_MS, type PushMessage } from './push.ts';

/** A browser's side of a subscription: its key pair and auth secret, so the test can decrypt what was sent. */
function fakeBrowser(endpoint: string) {
  const ecdh = createECDH('prime256v1');
  const pub = ecdh.generateKeys();
  const auth = randomBytes(16);
  const sub = { endpoint, keys: { p256dh: pub.toString('base64url'), auth: auth.toString('base64url') } };
  function decrypt(body: Buffer): any {
    const salt = body.subarray(0, 16), idlen = body[20], asPub = body.subarray(21, 21 + idlen), ct = body.subarray(21 + idlen);
    const ikm = Buffer.from(hkdfSync('sha256', ecdh.computeSecret(asPub), auth, Buffer.concat([Buffer.from('WebPush: info\0'), pub, asPub]), 32));
    const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
    const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
    const d = createDecipheriv('aes-128-gcm', cek, nonce);
    d.setAuthTag(ct.subarray(ct.length - 16));
    const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
    assert.equal(plain[plain.length - 1], 2); // last-record delimiter
    return JSON.parse(plain.subarray(0, -1).toString());
  }
  return { sub, decrypt };
}

/** Stands in for FCM / Mozilla: records each request and answers with the status set per endpoint. */
function fakePushService(status: Record<string, number> = {}) {
  const calls: { url: string; headers: Record<string, string>; body: Buffer }[] = [];
  const fetchImpl = async (url: string, init: { headers: Record<string, string>; body: Buffer }) => {
    calls.push({ url, ...init });
    return { status: status[url] ?? 201, text: async () => '' };
  };
  return { calls, fetchImpl };
}

const vapid = () => loadVapid(join(mkdtempSync(join(tmpdir(), 'jarvis-')), 'vapid.json'), {});
const quiet = () => {};

test('subscriptions are stored once per browser, refreshed on resubscribe, and removed', () => {
  const s = openStore(':memory:');
  const a = fakeBrowser('https://fcm.googleapis.com/fcm/send/a');
  s.addPushSub(a.sub, 'Android');
  s.addPushSub({ ...a.sub, keys: { ...a.sub.keys, auth: 'bmV3' } }, 'Android');
  assert.equal(s.pushSubs().length, 1);
  assert.equal(s.pushSubs()[0].keys.auth, 'bmV3');
  assert.equal(s.removePushSub(a.sub.endpoint), true);
  assert.deepEqual(s.pushSubs(), []);
});

test('VAPID keys are generated once into a private file and reused', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'jarvis-')), 'vapid.json');
  const k1 = loadVapid(file, {});
  assert.equal(Buffer.from(k1.publicKey, 'base64url').length, 65);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(loadVapid(file, {}).publicKey, k1.publicKey);
  const fromEnv = loadVapid('/nonexistent', { JARVIS_VAPID_PUBLIC: k1.publicKey, JARVIS_VAPID_PRIVATE: k1.privateJwk.d });
  assert.equal(fromEnv.privateJwk.x, k1.privateJwk.x);
});

test('a push is high priority, signed with VAPID, and decrypts to the message on the phone', async () => {
  const s = openStore(':memory:');
  const v = vapid();
  const phone = fakeBrowser('https://fcm.googleapis.com/fcm/send/phone');
  s.addPushSub(phone.sub);
  const svc = fakePushService();
  const msg: PushMessage = { title: 'Jarvis', body: 'Skip the step?', url: '/?item=msg_1', tag: 'item-msg_1' };
  assert.equal(await pushAll(s, v, msg, quiet, svc.fetchImpl as any), 1);

  const { url, headers, body } = svc.calls[0];
  assert.equal(url, phone.sub.endpoint);
  assert.equal(headers.Urgency, 'high');
  assert.equal(headers['Content-Encoding'], 'aes128gcm');
  assert.deepEqual(phone.decrypt(body), msg);

  const [, t, k] = /^vapid t=([^,]+), k=(.+)$/.exec(headers.Authorization)!;
  assert.equal(k, v.publicKey);
  const [h, c, sig] = t.split('.');
  assert.equal(JSON.parse(Buffer.from(c, 'base64url').toString()).aud, 'https://fcm.googleapis.com');
  const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: v.privateJwk.x, y: v.privateJwk.y }, format: 'jwk' });
  assert.ok(verify('sha256', Buffer.from(`${h}.${c}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')));
});

test('a subscription the push service says is gone is deleted; other failures keep it', async () => {
  const s = openStore(':memory:');
  const gone = fakeBrowser('https://push.example/gone'), flaky = fakeBrowser('https://push.example/flaky');
  s.addPushSub(gone.sub); s.addPushSub(flaky.sub);
  const svc = fakePushService({ [gone.sub.endpoint]: 410, [flaky.sub.endpoint]: 500 });
  assert.equal(await pushAll(s, vapid(), { title: 't', body: 'b', url: '/', tag: 'x' }, quiet, svc.fetchImpl as any), 0);
  assert.deepEqual(s.pushSubs().map(x => x.endpoint), [flaky.sub.endpoint]);
});

test('an unanswered ask is pushed after the delay, reminded once after 10 minutes, then left alone', async () => {
  const s = openStore(':memory:');
  s.insertItem({ source: 'native', external_id: 'msg_1', kind: 'question', body: 'STORY: 4412\nQUESTION: Skip the step?\nOPTIONS: ...' });
  s.insertItem({ source: 'native', external_id: 'msg_2', kind: 'worker_done', body: 'done' });
  const sent: PushMessage[] = [];
  const send = async (m: PushMessage) => { sent.push(m); return 1; };
  const created = Date.parse(s.openItems()[0].created_at.replace(' ', 'T') + 'Z');

  await pushOpenAsks(s, send, created + ASK_DELAY_MS - 1000);
  assert.equal(sent.length, 0);
  await pushOpenAsks(s, send, created + ASK_DELAY_MS + 1000);
  assert.deepEqual(sent.map(m => [m.url, m.body]), [['/?item=msg_1', 'Skip the step?']]);

  const pushedAt = Date.parse(s.openItems()[0].pushed_at!.replace(' ', 'T') + 'Z');
  await pushOpenAsks(s, send, pushedAt + 60_000);
  assert.equal(sent.length, 1);
  await pushOpenAsks(s, send, pushedAt + REMINDER_MS + 1000);
  assert.equal(sent.length, 2);
  await pushOpenAsks(s, send, pushedAt + 5 * REMINDER_MS);
  assert.equal(sent.length, 2);
});

test('no push once the owner answered, spoke after the ask, or when no phone was reached', async () => {
  const s = openStore(':memory:');
  s.db.prepare(`INSERT INTO items (source, external_id, kind, body, created_at) VALUES ('native', 'a', 'question', 'q', datetime('now', '-1 hour'))`).run();
  s.db.prepare(`INSERT INTO items (source, external_id, kind, body, created_at) VALUES ('native', 'b', 'escalation', 'e', datetime('now', '-1 hour'))`).run();
  s.db.prepare(`INSERT INTO items (source, external_id, kind, body, created_at) VALUES ('native', 'c', 'question', 'q', datetime('now', '-1 second'))`).run();
  s.markItem('a', 'answered', 'yes');
  s.db.prepare(`INSERT INTO turns (role, text, created_at) VALUES ('owner', 'two', datetime('now', '-30 minutes'))`).run();
  const sent: PushMessage[] = [];
  await pushOpenAsks(s, async m => { sent.push(m); return 1; });
  assert.deepEqual(sent, []); // a answered, b followed by the owner talking, c too recent

  const s2 = openStore(':memory:');
  s2.db.prepare(`INSERT INTO items (source, external_id, kind, body, created_at) VALUES ('native', 'd', 'escalation', 'Tests fail', datetime('now', '-1 hour'))`).run();
  await pushOpenAsks(s2, async () => 0);
  assert.equal(s2.openItems()[0].pushes, 0); // nobody reached: retried on the next sweep
  assert.equal(askMessage(s2.openItems()[0]).title, 'Jarvis: a worker is stuck');
});

test('[urgent] marks a reply for a push and is stripped from what is shown and spoken', () => {
  assert.deepEqual(urgent('[urgent] Prod is down.'), { urgent: true, text: 'Prod is down.' });
  assert.deepEqual(urgent('Sent.'), { urgent: false, text: 'Sent.' });
});

test('an ask Jarvis is already replying to is not pushed', async () => {
  const s = openStore(':memory:');
  s.db.prepare(`INSERT INTO items (source, external_id, kind, body, created_at) VALUES ('native', 'r', 'question', 'q', datetime('now', '-1 hour'))`).run();
  s.claimReply('r');
  const sent: PushMessage[] = [];
  await pushOpenAsks(s, async m => { sent.push(m); return 1; });
  assert.deepEqual(sent, []);
});

// Quiet hours: 6 PM to 7 AM in Toronto. October is EDT (UTC-4); DST ends 2026-11-01 and starts again 2027-03-14 (EST, UTC-5).
const at = (iso: string) => Date.parse(iso);

test('quiet hours start at 6:00 PM and end at 7:00 AM Toronto time, not UTC', () => {
  assert.equal(isQuietHours(at('2026-10-15T21:59:00Z')), false); // 5:59 PM EDT
  assert.equal(isQuietHours(at('2026-10-15T22:00:00Z')), true);  // 6:00 PM EDT
  assert.equal(isQuietHours(at('2026-10-16T03:00:00Z')), true);  // 11:00 PM EDT
  assert.equal(isQuietHours(at('2026-10-16T10:59:00Z')), true);  // 6:59 AM EDT
  assert.equal(isQuietHours(at('2026-10-16T11:00:00Z')), false); // 7:00 AM EDT
  assert.equal(quietHoursEnd(at('2026-10-15T22:00:00Z')), at('2026-10-16T11:00:00Z'));
  assert.equal(quietHoursEnd(at('2026-10-16T04:30:00Z')), at('2026-10-16T11:00:00Z')); // after midnight: this morning
});

test('quiet hours follow the clock across the fall DST change', () => {
  // Held at 6 PM EDT on Oct 31, released at 7 AM EST on Nov 1: 13 hours later, not 12.
  assert.equal(quietHoursEnd(at('2026-10-31T22:00:00Z')), at('2026-11-01T12:00:00Z'));
  assert.equal(isQuietHours(at('2026-11-01T11:00:00Z')), true);  // 6:00 AM EST, which UTC-4 would call 7:00
  assert.equal(isQuietHours(at('2026-11-01T11:59:00Z')), true);  // 6:59 AM EST
  assert.equal(isQuietHours(at('2026-11-01T12:00:00Z')), false); // 7:00 AM EST
  assert.equal(isQuietHours(at('2026-11-01T22:59:00Z')), false); // 5:59 PM EST
  assert.equal(isQuietHours(at('2026-11-01T23:00:00Z')), true);  // 6:00 PM EST
});

test('quiet hours follow the clock across the spring DST change', () => {
  // Held at 6 PM EST on Mar 13, released at 7 AM EDT on Mar 14: 12 hours later, not 13.
  assert.equal(quietHoursEnd(at('2027-03-13T23:00:00Z')), at('2027-03-14T11:00:00Z'));
  assert.equal(isQuietHours(at('2027-03-14T10:59:00Z')), true);  // 6:59 AM EDT
  assert.equal(isQuietHours(at('2027-03-14T11:00:00Z')), false); // 7:00 AM EDT, which UTC-5 would call 6:00
  assert.equal(isQuietHours(at('2027-03-14T21:59:00Z')), false); // 5:59 PM EDT
  assert.equal(isQuietHours(at('2027-03-14T22:00:00Z')), true);  // 6:00 PM EDT
});

function notifierAt(s: ReturnType<typeof openStore>, iso: string) {
  const sent: PushMessage[] = [];
  const clock = { now: at(iso) };
  const n = makeNotifier(s, async m => { sent.push(m); return 1; }, quiet, () => clock.now);
  return { ...n, sent, clock };
}
const msg = (tag: string): PushMessage => ({ title: 'Jarvis', body: 'b', url: '/', tag });

test('a push that is not urgent waits from 6:00 PM to 7:00 AM; one at 5:59 PM goes at once', async () => {
  const s = openStore(':memory:');
  const n = notifierAt(s, '2026-10-15T21:59:00Z'); // 5:59 PM
  assert.equal(await n.notify(msg('before')), 1);
  n.clock.now = at('2026-10-15T22:00:00Z'); // 6:00 PM
  assert.equal(await n.notify(msg('held')), 0);
  assert.equal(await n.notify(msg('held')), 0); // the 30 s sweep asks again; still one copy
  n.clock.now = at('2026-10-16T10:59:00Z'); // 6:59 AM
  await n.flush();
  assert.deepEqual(n.sent.map(m => m.tag), ['before']);
  n.clock.now = at('2026-10-16T11:00:00Z'); // 7:00 AM
  await n.flush();
  await n.flush();
  assert.deepEqual(n.sent.map(m => m.tag), ['before', 'held']);
});

test('urgent pushes go at once in quiet hours', async () => {
  const s = openStore(':memory:');
  const n = notifierAt(s, '2026-10-16T07:00:00Z'); // 3 AM
  assert.equal(await n.notify(msg('urgent-1'), { urgent: true }), 1);
  assert.deepEqual(n.sent.map(m => m.tag), ['urgent-1']);
});

test('held pushes survive a restart and are never sent twice', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'jarvis-')), 'jarvis.db');
  const a = notifierAt(openStore(file), '2026-10-16T02:00:00Z'); // 10 PM
  await a.notify(msg('one'));
  await a.notify(msg('two'));

  const s2 = openStore(file); // restart overnight
  s2.claimHeldPush(s2.duePushes('2026-10-16 11:00:00')[1].id); // 'two' was going out when jarvisd died
  const b = notifierAt(s2, '2026-10-16T11:00:00Z');
  await b.flush();
  assert.deepEqual(b.sent.map(m => m.tag), ['one']);

  const c = notifierAt(openStore(file), '2026-10-16T11:01:00Z'); // and again after 7 AM
  await c.flush();
  assert.deepEqual(c.sent, []);
});

test('a held push that reached no device waits for the next sweep', async () => {
  const s = openStore(':memory:');
  let reach = 0;
  const sent: string[] = [];
  const clock = { now: at('2026-10-16T02:00:00Z') };
  const n = makeNotifier(s, async m => { sent.push(m.tag); return reach; }, quiet, () => clock.now);
  await n.notify(msg('x'));
  clock.now = at('2026-10-16T11:00:00Z');
  await n.flush();
  reach = 1;
  await n.flush();
  await n.flush();
  assert.deepEqual(sent, ['x', 'x']);
});

test('an ask held overnight goes out once at 7 AM and counts as its first push', async () => {
  const s = openStore(':memory:');
  s.db.prepare(`INSERT INTO items (source, external_id, kind, body, created_at) VALUES ('native', 'q1', 'question', 'QUESTION: Ship it?', datetime('now', '-1 hour'))`).run();
  s.db.prepare(`INSERT INTO items (source, external_id, kind, body, created_at) VALUES ('native', 'q2', 'question', 'QUESTION: Rename?', datetime('now', '-1 hour'))`).run();
  const n = notifierAt(s, '2026-10-16T02:00:00Z'); // 10 PM
  await pushOpenAsks(s, n.notify);
  await pushOpenAsks(s, n.notify);
  assert.deepEqual(n.sent, []);
  assert.equal(s.item('q1')!.pushes, 0);

  s.markItem('q2', 'answered', 'no'); // the owner answered q2 in the app overnight
  n.clock.now = at('2026-10-16T11:00:00Z');
  await n.flush();
  await pushOpenAsks(s, n.notify);
  assert.deepEqual(n.sent.map(m => m.url), ['/?item=q1']);
  assert.equal(s.item('q1')!.pushes, 1);
});

test('a held ask is dropped when the owner spoke after it was held', async () => {
  const s = openStore(':memory:');
  s.db.prepare(`INSERT INTO items (source, external_id, kind, body, created_at) VALUES ('native', 'q', 'question', 'q', datetime('now', '-1 hour'))`).run();
  const n = notifierAt(s, '2026-10-16T02:00:00Z');
  await n.notify(askMessage(s.item('q')!), { item: 'q' });
  s.db.prepare(`INSERT INTO turns (role, text, created_at) VALUES ('owner', 'here', datetime('now', '+1 second'))`).run();
  n.clock.now = at('2026-10-16T11:00:00Z');
  await n.flush();
  assert.deepEqual(n.sent, []);
  assert.deepEqual(s.duePushes('2026-10-16 11:00:00'), []);
});
