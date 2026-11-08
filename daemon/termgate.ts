import { randomBytes, randomInt, createHash, createPublicKey, verify, timingSafeEqual } from 'node:crypto';
import type { Log } from './log.ts';
import { OWNER, OWNER_CAP } from './config.ts';

/** The passkey's user name: "owner" by default, else the owner's name in lower case. */
const USER_NAME = OWNER === 'the owner' ? 'owner' : OWNER.toLowerCase().replace(/\s+/g, '-');

// Who may open, type into and read a project terminal.
//
// The brain and every worker run on this Mac as the owner, with Bash, every file, and his Chrome through --chrome. So nothing
// they can read or copy may let them in: not 127.0.0.1, not the UI secret (any process can open /api/events), not a
// cookie or localStorage (a worker can open the app in Chrome), not a file or an env var. What they cannot do is touch
// the Touch ID sensor. On the Mac, each time a terminal opens, the page asks for a passkey (WebAuthn, user verification
// required) and jarvisd checks the signature against a key paired once. The private key never leaves the Mac's secure
// hardware, and macOS asks for a finger (or the login password) for each signature.
// A key is paired with a code that only the phone can read (its route needs the phone checks of access.ts), so a worker
// cannot pair a software key of its own. On the phone the existing phone checks stand in for Touch ID.
// Either way the result is a token for one terminal, held in that page's memory, valid while that page's stream of the
// terminal is open (and 60 s before it opens), and only together with the same page's UI secret.

export const TERM_HEADER = 'x-jarvis-term';
export const TERM_ORIGIN = process.env.JARVIS_TERM_ORIGIN || 'https://jarvis-host.example-tailnet.ts.net:7717';
const CODE_MS = 5 * 60_000, CHALLENGE_MS = 2 * 60_000, TOKEN_START_MS = 60_000, CODE_TRIES = 5;

export type PairedKey = { id: string; spki: string; count: number; at: string };
type State = { getState(k: string): string | undefined; setState(k: string, v: string): void };
type Challenge = { purpose: 'register' | 'unlock'; ui: string; name: string | null; exp: number };
type Token = { ui: string; name: string | null; via: 'touch-id' | 'phone'; born: number; streams: number };

const b64u = (b: Buffer) => b.toString('base64url');
const fromB64u = (s: unknown) => typeof s === 'string' && /^[\w-]*$/.test(s) ? Buffer.from(s, 'base64url') : undefined;
const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest();

/** The flags and counter of WebAuthn authenticator data, and the credential id when it carries one. */
export function parseAuthData(a: Buffer): { rpIdHash: Buffer; up: boolean; uv: boolean; count: number; credId?: Buffer } | undefined {
  if (a.length < 37) return undefined;
  const flags = a[32];
  const out = { rpIdHash: a.subarray(0, 32), up: !!(flags & 0x01), uv: !!(flags & 0x04), count: a.readUInt32BE(33) };
  if (!(flags & 0x40)) return out;
  if (a.length < 55) return undefined;
  const len = a.readUInt16BE(53);
  return { ...out, credId: a.subarray(55, 55 + len) };
}

export function makeTermGate({ store, log, origin = TERM_ORIGIN, now = Date.now }: { store: State; log: Log; origin?: string; now?: () => number }) {
  const rpId = new URL(origin).hostname;
  const challenges = new Map<string, Challenge>();
  const tokens = new Map<string, Token>();
  let code: { value: string; exp: number; tries: number } | undefined;

  const keys = (): PairedKey[] => { try { return JSON.parse(store.getState('termKeys') || '[]'); } catch { return []; } };
  const saveKeys = (k: PairedKey[]) => store.setState('termKeys', JSON.stringify(k));

  function sweep() {
    const t = now();
    for (const [k, c] of challenges) if (c.exp < t) challenges.delete(k);
    for (const [k, v] of tokens) if (!v.streams && t - v.born > TOKEN_START_MS) tokens.delete(k);
  }

  function challenge(purpose: Challenge['purpose'], ui: string, name: string | null): string {
    sweep();
    const c = b64u(randomBytes(32));
    challenges.set(c, { purpose, ui, name, exp: now() + CHALLENGE_MS });
    return c;
  }

  /** The browser's signed client data: right ceremony, a challenge this daemon issued for this page, and the app's origin. */
  function clientData(raw: Buffer, type: string, ui: string): { ch: Challenge } | { error: string } {
    let c: any;
    try { c = JSON.parse(raw.toString('utf8')); } catch { return { error: 'client data unreadable' }; }
    if (c.type !== type) return { error: 'wrong ceremony' };
    if (c.origin !== origin) return { error: `origin ${String(c.origin)} is not the app` };
    const ch = challenges.get(String(c.challenge));
    challenges.delete(String(c.challenge)); // single use, pass or fail
    if (!ch || ch.exp < now()) return { error: 'challenge unknown or expired' };
    if (ch.ui !== ui) return { error: 'challenge was issued to another page' };
    if (ch.purpose !== (type === 'webauthn.create' ? 'register' : 'unlock')) return { error: 'challenge was for something else' };
    return { ch };
  }

  function issue(ui: string, name: string | null, via: Token['via']): string {
    sweep();
    const t = b64u(randomBytes(32));
    tokens.set(t, { ui, name, via, born: now(), streams: 0 });
    log('terminal unlocked', { via, name });
    return t;
  }

  return {
    rpId, origin,
    paired: () => keys().length > 0,

    /** For the phone only (the caller ran the phone checks): a one-time code to pair the Mac. It is never logged. */
    pairCode(): { code: string; expiresAt: string } {
      code = { value: String(randomInt(0, 1e8)).padStart(8, '0'), exp: now() + CODE_MS, tries: 0 };
      log('terminal pairing code shown on the phone');
      return { code: code.value, expiresAt: new Date(code.exp).toISOString() };
    },

    /** Step 1 of pairing on the Mac: the code from the phone buys a registration challenge. Five wrong codes void it. */
    registerOptions(given: unknown, ui: string): { challenge: string; rpId: string; userId: string; userName: string; displayName: string; exclude: string[] } | { error: string } {
      if (!code || code.exp < now()) return { error: 'No pairing code is open. On your phone, open the menu and tap Pair the Mac.' };
      const a = Buffer.from(String(given ?? '').replace(/\D/g, '')), b = Buffer.from(code.value);
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        if (++code.tries >= CODE_TRIES) code = undefined;
        log('terminal pairing refused', { why: 'wrong code' });
        return { error: code ? 'That code is wrong.' : 'Too many wrong codes. Get a new one on the phone.' };
      }
      return { challenge: challenge('register', ui, null), rpId, userId: b64u(sha256(USER_NAME)), userName: USER_NAME, displayName: OWNER_CAP, exclude: keys().map(k => k.id) };
    },

    /** Step 2: the new passkey. Needs the code again (it is used up here), user verification, and the app's origin and rp id. */
    register(body: any, ui: string): { ok: true } | { error: string } {
      const fail = (error: string) => { log('terminal pairing refused', { why: error }); return { error }; };
      if (!code || code.exp < now() || String(body?.code ?? '').replace(/\D/g, '') !== code.value) return fail('the pairing code is no longer valid');
      const raw = fromB64u(body?.clientDataJSON), auth = fromB64u(body?.authenticatorData), spki = fromB64u(body?.publicKey), id = fromB64u(body?.id);
      if (!raw || !auth || !spki || !id?.length) return fail('missing fields');
      const c = clientData(raw, 'webauthn.create', ui);
      if ('error' in c) return fail(c.error);
      const a = parseAuthData(auth);
      if (!a || !a.rpIdHash.equals(sha256(rpId))) return fail('wrong rp id');
      if (!a.up || !a.uv) return fail('the passkey did not verify the user');
      if (a.credId && !a.credId.equals(id)) return fail('credential id mismatch');
      try {
        const k = createPublicKey({ key: spki, format: 'der', type: 'spki' });
        if (k.asymmetricKeyType !== 'ec' || k.asymmetricKeyDetails?.namedCurve !== 'prime256v1') return fail('only P-256 keys');
      } catch { return fail('public key unreadable'); }
      code = undefined;
      saveKeys([...keys().filter(k => k.id !== b64u(id)), { id: b64u(id), spki: b64u(spki), count: a.count, at: new Date(now()).toISOString() }]);
      log('terminal passkey paired', { key: b64u(id).slice(0, 12) });
      return { ok: true };
    },

    /** A Touch ID challenge for one terminal, or for a new one when `name` is null. */
    unlockOptions(name: string | null, ui: string): { challenge: string; rpId: string; allow: string[] } | { error: string } {
      const k = keys();
      if (!k.length) return { error: 'not paired' };
      return { challenge: challenge('unlock', ui, name), rpId, allow: k.map(x => x.id) };
    },

    /** A passkey assertion: a paired key, user verified, a signature over this challenge. */
    unlockTouchId(body: any, ui: string): { token: string } | { error: string } {
      const fail = (error: string) => { log('terminal refused', { via: 'touch-id', why: error }); return { error }; };
      const raw = fromB64u(body?.clientDataJSON), auth = fromB64u(body?.authenticatorData), sig = fromB64u(body?.signature);
      if (!raw || !auth || !sig) return fail('missing fields');
      const all = keys(), key = all.find(k => k.id === body?.id);
      if (!key) return fail('this passkey is not paired');
      const c = clientData(raw, 'webauthn.get', ui);
      if ('error' in c) return fail(c.error);
      const a = parseAuthData(auth);
      if (!a || !a.rpIdHash.equals(sha256(rpId))) return fail('wrong rp id');
      if (!a.up || !a.uv) return fail('the passkey did not verify the user');
      let good = false;
      try { good = verify('sha256', Buffer.concat([auth, sha256(raw)]), { key: Buffer.from(key.spki, 'base64url'), format: 'der', type: 'spki' }, sig); } catch { good = false; }
      if (!good) return fail('bad signature');
      // A counter that goes back means a copied key. Passkeys that sync keep it at 0, which is allowed.
      if (key.count > 0 && a.count <= key.count) return fail('signature counter went back');
      if (a.count) saveKeys(all.map(k => k.id === key.id ? { ...k, count: a.count } : k));
      return { token: issue(ui, c.ch.name, 'touch-id') };
    },

    /** The phone: the caller already ran shellRefusal on this request. */
    unlockPhone(name: string | null, ui: string): { token: string } {
      return { token: issue(ui, name, 'phone') };
    },

    /** Why this request may not act on terminal `name` (null: start a new one), or undefined when it may. */
    refusal(token: unknown, ui: string | undefined, uiLive: boolean, name: string | null): string | undefined {
      sweep();
      if (!uiLive || !ui) return 'no open app page';
      const t = typeof token === 'string' ? tokens.get(token) : undefined;
      if (!t) return 'no terminal token (Touch ID on the Mac, the phone checks on the phone)';
      if (t.ui !== ui) return 'the token belongs to another page';
      if (t.name !== name) return 'the token is for another terminal';
      return undefined;
    },

    /** A new terminal was started with a token for "new": the same token now covers it. */
    rebind(token: string, name: string) { const t = tokens.get(token); if (t) t.name = name; },
    /** The page's stream of the terminal opened; when the last one closes, the token is gone. */
    hold(token: string): () => void {
      const t = tokens.get(token);
      if (!t) return () => {};
      t.streams++;
      return () => { if (--t.streams <= 0) tokens.delete(token); };
    },
    /** A UI page closed: its tokens go with it. */
    dropPage(ui: string) { for (const [k, v] of tokens) if (v.ui === ui) tokens.delete(k); },
  };
}
export type TermGate = ReturnType<typeof makeTermGate>;
