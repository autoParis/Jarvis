// The project terminal's access check (termgate.ts), with a real P-256 passkey made here, so every signature check runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { makeTermGate, parseAuthData } from './termgate.ts';

const ORIGIN = 'https://jarvis-host.example-tailnet.ts.net:7717';
const RP = new URL(ORIGIN).hostname;
const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest();
const b64u = (b: Buffer) => b.toString('base64url');

function memory() {
  const m = new Map<string, string>();
  return { getState: (k: string) => m.get(k), setState: (k: string, v: string) => { m.set(k, v); } };
}
function setup() {
  let t = 1_000_000;
  const logs: [string, unknown][] = [];
  const store = memory();
  const gate = makeTermGate({ store, log: (m: string, f?: unknown) => { logs.push([m, f]); }, origin: ORIGIN, now: () => t });
  return { gate, store, logs, advance: (ms: number) => { t += ms; } };
}

/** WebAuthn authenticator data: rp id hash, flags, counter, and the credential id when `credId` is given. */
function authData(o: { rp?: string; up?: boolean; uv?: boolean; count?: number; credId?: Buffer } = {}): Buffer {
  const flags = (o.up ?? true ? 0x01 : 0) | (o.uv ?? true ? 0x04 : 0) | (o.credId ? 0x40 : 0);
  const head = Buffer.concat([sha256(o.rp ?? RP), Buffer.from([flags]), Buffer.alloc(4)]);
  head.writeUInt32BE(o.count ?? 0, 33);
  if (!o.credId) return head;
  const len = Buffer.alloc(2); len.writeUInt16BE(o.credId.length);
  return Buffer.concat([head, Buffer.alloc(16), len, o.credId]);
}
const clientData = (type: string, challenge: string, origin = ORIGIN) => Buffer.from(JSON.stringify({ type, challenge, origin }));

/** A passkey of our own: its id, public key, and a signer for assertions. */
function passkey(curve = 'prime256v1') {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: curve });
  const id = randomBytes(16);
  return { id, spki: publicKey.export({ format: 'der', type: 'spki' }) as Buffer, privateKey: privateKey as KeyObject };
}

/** Pairs a key: a code from the phone, the options, then the registration. Returns the gate and the key. */
function paired() {
  const s = setup();
  const key = passkey();
  const { code } = s.gate.pairCode();
  const opts = s.gate.registerOptions(code, 'ui-1') as { challenge: string };
  const r = s.gate.register({ code, id: b64u(key.id), clientDataJSON: b64u(clientData('webauthn.create', opts.challenge)),
    authenticatorData: b64u(authData({ credId: key.id })), publicKey: b64u(key.spki) }, 'ui-1');
  assert.deepEqual(r, { ok: true });
  return { ...s, key };
}

function assertion(s: ReturnType<typeof paired>, o: { ui?: string; name?: string | null; count?: number; origin?: string; uv?: boolean; signer?: KeyObject } = {}) {
  const opts = s.gate.unlockOptions(o.name ?? null, o.ui ?? 'ui-1') as { challenge: string };
  const raw = clientData('webauthn.get', opts.challenge, o.origin);
  const auth = authData({ count: o.count ?? 0, uv: o.uv });
  const signature = sign('sha256', Buffer.concat([auth, sha256(raw)]), o.signer ?? s.key.privateKey);
  return { id: b64u(s.key.id), clientDataJSON: b64u(raw), authenticatorData: b64u(auth), signature: b64u(signature) };
}

test('authenticator data: flags, counter, and the credential id when it is attested', () => {
  const id = Buffer.from('cred');
  assert.deepEqual({ ...parseAuthData(authData({ count: 7, credId: id }))!, rpIdHash: undefined }, { rpIdHash: undefined, up: true, uv: true, count: 7, credId: id });
  const plain = parseAuthData(authData({ uv: false }))!;
  assert.equal(plain.uv, false);
  assert.equal(plain.credId, undefined);
  assert.equal(parseAuthData(Buffer.alloc(36)), undefined, 'too short');
  assert.equal(parseAuthData(Buffer.concat([authData(), Buffer.alloc(0)]).fill(0x40, 32, 33)), undefined, 'claims a credential it does not carry');
});

test('pairing needs the code shown on the phone, and five wrong codes void it', () => {
  const { gate, logs } = setup();
  assert.match((gate.registerOptions('12345678', 'ui') as any).error, /No pairing code is open/);
  const { code } = gate.pairCode();
  assert.match(code, /^\d{8}$/);
  assert.ok(!logs.some(([, f]) => JSON.stringify(f ?? '').includes(code)), 'the code is never logged');
  const wrong = code === '00000000' ? '11111111' : '00000000';
  for (let n = 1; n < 5; n++) assert.equal((gate.registerOptions(wrong, 'ui') as any).error, 'That code is wrong.');
  assert.match((gate.registerOptions(wrong, 'ui') as any).error, /Too many wrong codes/);
  assert.match((gate.registerOptions(code, 'ui') as any).error, /No pairing code is open/, 'the right code no longer works either');
});

test('a pairing code expires after five minutes', () => {
  const { gate, advance } = setup();
  const { code } = gate.pairCode();
  advance(5 * 60_000 + 1);
  assert.match((gate.registerOptions(code, 'ui') as any).error, /No pairing code is open/);
});

test('a paired passkey is stored once the registration checks pass, and the code is used up', () => {
  const s = paired();
  assert.equal(s.gate.paired(), true);
  const keys = JSON.parse(s.store.getState('termKeys')!);
  assert.equal(keys.length, 1);
  assert.equal(keys[0].id, b64u(s.key.id));
  assert.match((s.gate.registerOptions('00000000', 'ui-1') as any).error, /No pairing code is open/);
});

test('registration refuses a wrong origin, another page, a reused challenge, no user check, a wrong rp id and a non P-256 key', () => {
  const cases: [string, (c: { code: string; challenge: string; key: ReturnType<typeof passkey> }) => any, RegExp][] = [
    ['origin', c => ({ clientDataJSON: b64u(clientData('webauthn.create', c.challenge, 'https://evil.test')) }), /is not the app/],
    ['ceremony', c => ({ clientDataJSON: b64u(clientData('webauthn.get', c.challenge)) }), /wrong ceremony/],
    ['user check', c => ({ authenticatorData: b64u(authData({ credId: c.key.id, uv: false })) }), /did not verify the user/],
    ['rp id', c => ({ authenticatorData: b64u(authData({ credId: c.key.id, rp: 'evil.test' })) }), /wrong rp id/],
    ['credential id', c => ({ authenticatorData: b64u(authData({ credId: Buffer.from('other') })) }), /credential id mismatch/],
    ['curve', () => ({ publicKey: b64u(passkey('secp384r1').spki) }), /only P-256 keys/],
    ['code', () => ({ code: '1' }), /no longer valid/],
  ];
  for (const [name, change, why] of cases) {
    const { gate } = setup();
    const key = passkey();
    const { code } = gate.pairCode();
    const { challenge } = gate.registerOptions(code, 'ui-1') as { challenge: string };
    const body = { code, id: b64u(key.id), clientDataJSON: b64u(clientData('webauthn.create', challenge)), authenticatorData: b64u(authData({ credId: key.id })), publicKey: b64u(key.spki), ...change({ code, challenge, key }) };
    assert.match((gate.register(body, 'ui-1') as any).error ?? '', why, name);
    assert.equal(gate.paired(), false, `${name}: nothing paired`);
  }
  // The challenge was issued to page ui-1; page ui-2 cannot use it.
  const { gate } = setup();
  const key = passkey();
  const { code } = gate.pairCode();
  const { challenge } = gate.registerOptions(code, 'ui-1') as { challenge: string };
  const body = { code, id: b64u(key.id), clientDataJSON: b64u(clientData('webauthn.create', challenge)), authenticatorData: b64u(authData({ credId: key.id })), publicKey: b64u(key.spki) };
  assert.match((gate.register(body, 'ui-2') as any).error, /another page/);
  assert.match((gate.register(body, 'ui-1') as any).error, /unknown or expired/, 'a challenge is single use, pass or fail');
});

test('Touch ID: a signed assertion from the paired key gives a token for that page and that terminal only', () => {
  const s = paired();
  const r = s.gate.unlockTouchId(assertion(s, { name: 'jarvis-1' }), 'ui-1') as { token: string };
  assert.ok(r.token);
  assert.equal(s.gate.refusal(r.token, 'ui-1', true, 'jarvis-1'), undefined);
  assert.match(s.gate.refusal(r.token, 'ui-2', true, 'jarvis-1')!, /another page/);
  assert.match(s.gate.refusal(r.token, 'ui-1', true, 'jarvis-2')!, /another terminal/);
  assert.match(s.gate.refusal(r.token, 'ui-1', false, 'jarvis-1')!, /no open app page/);
  assert.match(s.gate.refusal('guess', 'ui-1', true, 'jarvis-1')!, /no terminal token/);
  assert.match(s.gate.refusal(undefined, undefined, true, 'jarvis-1')!, /no open app page/);
});

test('Touch ID refuses another key, a bad signature, no user check, a wrong origin and a counter that goes back', () => {
  const s = paired();
  const notPaired = { ...assertion(s), id: b64u(Buffer.from('other')) };
  assert.match((s.gate.unlockTouchId(notPaired, 'ui-1') as any).error, /not paired/);
  assert.match((s.gate.unlockTouchId(assertion(s, { signer: passkey().privateKey }), 'ui-1') as any).error, /bad signature/);
  assert.match((s.gate.unlockTouchId(assertion(s, { uv: false }), 'ui-1') as any).error, /did not verify the user/);
  assert.match((s.gate.unlockTouchId(assertion(s, { origin: 'https://evil.test' }), 'ui-1') as any).error, /is not the app/);
  assert.match((s.gate.unlockTouchId(assertion(s, { ui: 'ui-2' }), 'ui-1') as any).error, /another page/);
  // A key that counts: 5 is stored, then 5 again or less is a copied key.
  assert.ok('token' in s.gate.unlockTouchId(assertion(s, { count: 5 }), 'ui-1'));
  assert.equal(JSON.parse(s.store.getState('termKeys')!)[0].count, 5);
  assert.match((s.gate.unlockTouchId(assertion(s, { count: 5 }), 'ui-1') as any).error, /counter went back/);
  assert.ok('token' in s.gate.unlockTouchId(assertion(s, { count: 6 }), 'ui-1'));
});

test('an unlock challenge is single use and expires after two minutes; nothing unlocks before pairing', () => {
  const s = paired();
  const a = assertion(s);
  assert.ok('token' in s.gate.unlockTouchId(a, 'ui-1'));
  assert.match((s.gate.unlockTouchId(a, 'ui-1') as any).error, /unknown or expired/);
  const late = assertion(s);
  s.advance(2 * 60_000 + 1);
  assert.match((s.gate.unlockTouchId(late, 'ui-1') as any).error, /unknown or expired/);
  assert.match((setup().gate.unlockOptions(null, 'ui-1') as any).error, /not paired/);
});

test('a token lives 60 s before its stream opens, while a stream is open, and dies with its page', () => {
  const { gate, advance } = setup();
  const t1 = gate.unlockPhone('jarvis-1', 'ui-1').token;
  advance(60_001);
  assert.match(gate.refusal(t1, 'ui-1', true, 'jarvis-1')!, /no terminal token/, 'never opened, so it lapsed');
  const t2 = gate.unlockPhone('jarvis-1', 'ui-1').token;
  const release = gate.hold(t2);
  advance(10 * 60_000);
  assert.equal(gate.refusal(t2, 'ui-1', true, 'jarvis-1'), undefined, 'an open stream keeps it');
  release();
  assert.match(gate.refusal(t2, 'ui-1', true, 'jarvis-1')!, /no terminal token/, 'the last stream closed');
  const t3 = gate.unlockPhone(null, 'ui-1').token;
  gate.rebind(t3, 'jarvis-2');
  assert.equal(gate.refusal(t3, 'ui-1', true, 'jarvis-2'), undefined, 'a token for "new" covers the terminal it started');
  gate.dropPage('ui-1');
  assert.match(gate.refusal(t3, 'ui-1', true, 'jarvis-2')!, /no terminal token/);
});
