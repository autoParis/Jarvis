import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, generateKeyPairSync, sign, randomBytes, type KeyObject } from 'node:crypto';
import { makeTerminals, keyCommands, diffScreen, parseList, sessionName, parseDisplay, TMUX, type Frame } from './terminal.ts';
import { makeTermGate, parseAuthData } from './termgate.ts';
import { termRoute, type TermCtx } from './termroutes.ts';
import { makeUiSessions, UI_HEADER } from './access.ts';
import { terminalRows } from './termrows.ts';

const HAVE_TMUX = existsSync(TMUX);
const SOCKET = `jvtest-${process.pid}`;
const ENV = { PATH: '/usr/bin:/bin', HOME: process.env.HOME, TERM: 'xterm-256color', SHELL: '/bin/sh', LANG: 'en_US.UTF-8' };
const until = async (ok: () => boolean, what: () => string = () => '') => { for (let i = 0; i < 250 && !ok(); i++) await new Promise(r => setTimeout(r, 20)); assert.ok(ok(), `timed out: ${what()}`); };
const killServer = () => { try { execFileSync(TMUX, ['-L', SOCKET, 'kill-server'], { stdio: 'ignore' }); } catch { /* none */ } };
const plain = (l: string) => l.replace(/\x1b\[[0-9;:]*m/g, '');

test('keys become tmux commands: special keys by name, ASCII as hex, the rest literal', () => {
  assert.deepEqual(keyCommands('ev-1', [{ key: 'Up' }, { key: 'rm -rf' }, { text: 'ls\r' }, { text: '\x03' }]),
    ['send-keys -t ev-1 Up', 'send-keys -t ev-1 -H 6c 73 0d', 'send-keys -t ev-1 -H 03']);
  assert.deepEqual(keyCommands('ev-1', [{ text: "a'é;b" }]), ['send-keys -t ev-1 -H 61 27', "send-keys -t ev-1 -l 'é'", 'send-keys -t ev-1 -H 3b 62']);
  assert.equal(sessionName('acmeapp', ['ev-1', 'ev-3']), 'ev-2');
  assert.equal(sessionName('Some Thing', []), 'someth-1');
  assert.deepEqual(parseDisplay('7 5 40 6 1\n'), { cols: 40, rows: 6, cursor: [7, 5] });
  assert.deepEqual(parseDisplay('7 5 40 6 0'), { cols: 40, rows: 6, cursor: null });
  const a = { cols: 2, rows: 2, cursor: null, lines: ['a', 'b'] };
  assert.deepEqual(diffScreen(a, { ...a, lines: ['a', 'c'] }), { cols: 2, rows: 2, cursor: null, d: [[1, 'c']] });
  assert.deepEqual(diffScreen(a, { ...a, cols: 3 }), { cols: 3, rows: 2, cursor: null, lines: ['a', 'b'] });
  // Only sessions Jarvis tagged are listed: The owner's own tmux sessions stay his.
  const out = 'ev-1\t1\tacmeapp\tterminal\t1794015382\t/r/ev\t0\nmine\t\t\t\t1794015382\t/tmp\t1\njv-2\t1\tjarvis\tcodex\t1794015382\t/r/jv\t1';
  assert.deepEqual(parseList(out).map(t => [t.name, t.kind]), [['ev-1', 'terminal'], ['jv-2', 'codex']]);
  const rows = terminalRows([{ name: 'ev-1', project: 'acmeapp', kind: 'terminal', cwd: '/r/ev', branch: 'staging', createdAt: '', attached: 0 }]);
  assert.equal(rows[0].id, 't:ev-1'); assert.equal(rows[0].title, 'Terminal in AcmeApp'); assert.equal(rows[0].group, 'terminal');
});

test('a real tmux session: typed keys run, vim draws full screen, resize, End kills it', { skip: !HAVE_TMUX && 'tmux is not installed' }, async t => {
  killServer();
  t.after(killServer);
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'jv-term-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const logged: string[] = [];
  const terms = makeTerminals({ log: m => { logged.push(m); }, env: ENV, socket: SOCKET });
  const info = await terms.open({ project: 'acmeapp', cwd: dir, kind: 'terminal', cols: 60, rows: 12 });
  assert.equal(info.name, 'ev-1'); assert.equal(info.cwd, dir);
  let screen: string[] = [], size = [0, 0], ended = '';
  const view = (f: Frame) => {
    if ('ended' in f) { ended = f.ended; return; }
    size = [f.cols, f.rows];
    if (f.lines) screen = [...f.lines]; else for (const [i, l] of f.d!) screen[i] = l;
  };
  const leave = terms.attach('ev-1', view, { cols: 70, rows: 14 });
  await until(() => size[0] === 70 && size[1] === 14, () => String(size));
  await terms.input('ev-1', [{ text: 'echo hi-$((40+2)); pwd\r' }]);
  await until(() => screen.some(l => plain(l).trim() === 'hi-42'), () => screen.join('\n'));
  await until(() => screen.map(l => plain(l).trim()).join('').includes(dir), () => `not in the project folder: ${screen.join('\n')}`);
  // A full-screen program draws: vi fills the rows with its ~ lines and leaves them on :q!.
  await terms.input('ev-1', [{ text: 'vi' }, { key: 'Enter' }]);
  await until(() => screen.filter(l => plain(l).startsWith('~')).length >= 5, () => screen.join('\n'));
  await terms.input('ev-1', [{ key: 'Escape' }, { text: ':q!' }, { key: 'Enter' }]);
  await until(() => screen.filter(l => plain(l).startsWith('~')).length === 0, () => screen.join('\n'));
  // A paste of two lines arrives whole.
  await terms.paste('ev-1', 'echo one\necho two-$((1+1))\n');
  await until(() => screen.some(l => plain(l).trim() === 'two-2'), () => screen.join('\n'));
  // Back: the page leaves, the session stays.
  leave();
  assert.deepEqual((await terms.list()).map(x => x.name), ['ev-1']);
  const again = terms.attach('ev-1', view);
  await until(() => screen.some(l => plain(l).includes('two-2')));
  assert.ok(await terms.kill('ev-1'));
  await until(() => ended !== '');
  assert.match(ended, /you tapped End/);
  again();
  assert.deepEqual(await terms.list(), []);
  assert.ok(!logged.some(m => m.includes('hi-')), 'keys are never logged');
});

test('a Codex session types codex into a shell in its folder', { skip: !HAVE_TMUX && 'tmux is not installed' }, async t => {
  killServer();
  t.after(killServer);
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'jv-codex-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // PATH without codex: the shell says so and stays, which is what the owner sees when Codex exits.
  const terms = makeTerminals({ log: () => {}, env: ENV, socket: SOCKET });
  const info = await terms.open({ project: 'jarvis', cwd: dir, kind: 'codex' });
  assert.equal(info.kind, 'codex');
  let screen: string[] = [];
  const leave = terms.attach(info.name, f => { if ('lines' in f && f.lines) screen = [...f.lines]; else if ('d' in f) for (const [i, l] of f.d!) screen[i] = l; });
  await until(() => screen.some(l => /codex/.test(plain(l))), () => screen.join('\n'));
  leave();
  assert.equal(terminalRows(await terms.list())[0].title, 'Codex in Jarvis');
});

// ---- The gate. A software key stands in for the Mac's passkey: these tests prove jarvisd's checks, not Touch ID. ----
const ORIGIN = 'https://jarvis-host.example.ts.net:7717';
const RP = 'jarvis-host.example.ts.net';
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest();
const b64u = (b: Buffer) => b.toString('base64url');
function authData(flags: number, count: number, credId?: Buffer) {
  const head = Buffer.concat([sha(RP), Buffer.from([flags]), Buffer.alloc(4)]);
  head.writeUInt32BE(count, 33);
  if (!credId) return head;
  const len = Buffer.alloc(2); len.writeUInt16BE(credId.length);
  return Buffer.concat([head, Buffer.alloc(16), len, credId]);
}
type Authn = { id: Buffer; priv: KeyObject; spki: Buffer };
const newKey = (): Authn => { const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }); return { id: randomBytes(16), priv: privateKey, spki: publicKey.export({ format: 'der', type: 'spki' }) }; };
const created = (k: Authn, challenge: string, code: string, flags = 0x45, origin = ORIGIN) => ({
  code, id: b64u(k.id), publicKey: b64u(k.spki), authenticatorData: b64u(authData(flags, 0, k.id)),
  clientDataJSON: b64u(Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge, origin }))),
});
function asserted(k: Authn, challenge: string, flags = 0x05, count = 0, origin = ORIGIN) {
  const cd = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin }));
  const ad = authData(flags, count);
  return { id: b64u(k.id), clientDataJSON: b64u(cd), authenticatorData: b64u(ad), signature: b64u(sign('sha256', Buffer.concat([ad, sha(cd)]), k.priv)) };
}

async function server(t: any) {
  killServer();
  t.after(killServer);
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'jv-gate-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = new Map<string, string>(), refused: any[] = [];
  const log = (m: string, f?: any) => { if (m === 'terminal refused') refused.push(f); };
  const ui = makeUiSessions();
  const terms = makeTerminals({ log, env: ENV, socket: SOCKET });
  const gate = makeTermGate({ store: { getState: k => state.get(k), setState: (k, v) => { state.set(k, v); } }, log, origin: ORIGIN });
  // The phone checks of access.ts, faked: only a request marked as the phone's passes. A worker's request is the Mac's.
  const ctx: TermCtx = { terms, gate, log, uiOk: h => ui.ok(h), repos: () => [{ name: 'acmeapp', path: dir }], onChange: () => {},
    phoneRefusal: async req => req.headers['x-test-phone'] === 'yes' ? undefined : 'device 100.64.0.40 is not the phone' };
  const srv = http.createServer((req, res) => termRoute(ctx, req, res, (req.url ?? '').split('?')[0]).catch(e => { res.writeHead(500); res.end(String(e)); }));
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const post = async (path: string, body: unknown, h: Record<string, string> = {}) => {
    const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...h }, body: JSON.stringify(body) });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  };
  return { ui, gate, terms, state, refused, post, base, dir };
}

test('requests shaped like a worker\'s are refused for opening, typing into and reading a terminal', { skip: !HAVE_TMUX && 'tmux is not installed' }, async t => {
  const s = await server(t);
  await s.terms.open({ project: 'acmeapp', cwd: s.dir, kind: 'terminal' }); // a terminal the owner already has open: ev-1
  const routes: [string, unknown][] = [['/api/term/open', { repo: s.dir }], ['/api/term/input', { name: 'ev-1', keys: [{ text: 'id\r' }] }],
    ['/api/term/paste', { name: 'ev-1', text: 'id\n' }], ['/api/term/resize', { name: 'ev-1', cols: 80, rows: 20 }], ['/api/term/end', { name: 'ev-1' }]];
  const stream = (h: Record<string, string>) => fetch(`${s.base}/api/term/stream?name=ev-1`, { headers: h }).then(r => { const st = r.status; r.body?.cancel(); return st; });

  // 1. A plain curl from the Mac: local, no app secret.
  for (const [path, body] of routes) assert.equal((await s.post(path, body)).status, 401, path);
  assert.equal(await stream({}), 401);

  // 2. A worker that opened /api/events itself has a live UI secret, and copies anything on disk or in env as a token.
  const secret = s.ui.open();
  const asWorker = { [UI_HEADER]: secret };
  for (const fake of [undefined, 'x', b64u(randomBytes(32)), JSON.stringify([...s.state])]) {
    const h = fake ? { ...asWorker, 'x-jarvis-term': fake } : asWorker;
    for (const [path, body] of routes) assert.equal((await s.post(path, body, h)).status, 403, `${path} with ${fake}`);
    assert.equal(await stream(h), 403);
  }
  // 3. It asks for the phone's token from the Mac: the phone checks refuse it. Same for the pairing code.
  assert.equal((await s.post('/api/term/unlock', { via: 'phone', name: 'ev-1' }, asWorker)).status, 403);
  assert.equal((await s.post('/api/term/pair-code', {}, asWorker)).status, 403);
  // 4. It pairs a software key of its own: no code, a guessed code, five guesses void a real code.
  const workerKey = newKey();
  assert.equal((await s.post('/api/term/pair/options', { code: '' }, asWorker)).status, 403);
  assert.equal((await s.post('/api/term/pair', created(workerKey, 'x', '00000000'), asWorker)).status, 403);
  const real = (await s.post('/api/term/pair-code', {}, { ...asWorker, 'x-test-phone': 'yes' })).json.code; // the owner taps Pair the Mac on the phone
  for (let i = 0; i < 5; i++) assert.equal((await s.post('/api/term/pair/options', { code: String((Number(real) + 1 + i) % 1e8).padStart(8, '0') }, asWorker)).status, 403);
  assert.equal((await s.post('/api/term/pair/options', { code: real }, asWorker)).status, 403, 'the real code is void after five wrong ones');
  // 5. It signs a Touch ID assertion with a key that was never paired.
  assert.equal((await s.post('/api/term/unlock/options', { name: 'ev-1' }, asWorker)).json.paired, false);
  assert.ok(!s.gate.paired());
  for (const [path, body] of routes) assert.equal((await s.post(path, body, asWorker)).status, 403);
  assert.ok(s.refused.length > 20 && s.refused.every(r => r.why), 'each refusal is logged with its reason');
  // The terminal itself was never touched.
  assert.deepEqual((await s.terms.list()).map(x => x.name), ['ev-1']);
});

test('The owner on the Mac: pair once with the phone code, then Touch ID opens, streams and types; the token dies with its stream', { skip: !HAVE_TMUX && 'tmux is not installed' }, async t => {
  const s = await server(t);
  const page = { [UI_HEADER]: s.ui.open() };
  const mac = newKey();
  const code = (await s.post('/api/term/pair-code', {}, { ...page, 'x-test-phone': 'yes' })).json.code;
  assert.match(code, /^\d{8}$/);
  const opts = (await s.post('/api/term/pair/options', { code }, page)).json;
  assert.equal(opts.rpId, RP);
  // A passkey that did not verify the user (no UV flag) is not paired, and the code survives for the real try.
  assert.equal((await s.post('/api/term/pair', created(mac, opts.challenge, code, 0x41), page)).status, 403);
  const opts2 = (await s.post('/api/term/pair/options', { code }, page)).json;
  assert.equal((await s.post('/api/term/pair', created(mac, opts2.challenge, code), page)).status, 200);
  assert.ok(s.gate.paired());
  assert.equal((await s.post('/api/term/pair/options', { code }, page)).status, 403, 'the code is used up');

  const unlock = async (name: string | null, flags = 0x05, origin = ORIGIN, h = page) => {
    const o = (await s.post('/api/term/unlock/options', { name }, h)).json;
    return s.post('/api/term/unlock', { name, ...asserted(mac, o.challenge, flags, 0, origin) }, h);
  };
  // Wrong origin (a page that is not the app) and no user verification are refused even with the paired key.
  assert.equal((await unlock(null, 0x05, 'https://evil.example')).status, 403);
  assert.equal((await unlock(null, 0x01)).status, 403);
  // A replayed assertion: its challenge was used up.
  const o = (await s.post('/api/term/unlock/options', { name: null }, page)).json;
  const once = asserted(mac, o.challenge);
  assert.equal((await s.post('/api/term/unlock', { name: null, ...once }, page)).status, 200);
  assert.equal((await s.post('/api/term/unlock', { name: null, ...once }, page)).status, 403);
  // Another page (another UI secret) cannot use this page's assertion or token.
  const other = { [UI_HEADER]: s.ui.open() };
  const tok = (await unlock(null)).json.token as string;
  assert.equal((await s.post('/api/term/open', { repo: s.dir }, { ...other, 'x-jarvis-term': tok })).status, 403);

  const opened = await s.post('/api/term/open', { repo: s.dir, cols: 60, rows: 12 }, { ...page, 'x-jarvis-term': tok });
  assert.equal(opened.status, 200);
  const name = opened.json.terminal.name;
  const h = { ...page, 'x-jarvis-term': tok };
  // The token now covers this terminal only.
  assert.equal((await s.post('/api/term/input', { name: 'ev-9', keys: [] }, h)).status, 403);
  const ac = new AbortController();
  const r = await fetch(`${s.base}/api/term/stream?name=${name}&cols=60&rows=12`, { headers: h, signal: ac.signal });
  assert.equal(r.status, 200);
  let text = '';
  const reader = r.body!.getReader();
  const reading = (async () => { try { for (;;) { const c = await reader.read(); if (c.done) break; text += Buffer.from(c.value).toString(); } } catch { /* aborted */ } })();
  assert.equal((await s.post('/api/term/input', { name, keys: [{ text: 'echo mac-$((6*7))\r' }] }, h)).status, 204);
  await until(() => text.includes('mac-42'), () => text.slice(-500));
  ac.abort();
  await reading;
  await new Promise(r2 => setTimeout(r2, 100));
  // The stream closed: the token is gone, so the same headers no longer type.
  assert.equal((await s.post('/api/term/input', { name, keys: [{ text: 'id\r' }] }, h)).status, 403);
  // A fresh Touch ID for this terminal, then End.
  const tok2 = (await unlock(name)).json.token;
  assert.equal((await s.post('/api/term/end', { name }, { ...page, 'x-jarvis-term': tok2 })).status, 200);
  assert.deepEqual(await s.terms.list(), []);
});

test('The owner on the phone: the phone checks give the token, and a closed page takes its tokens with it', { skip: !HAVE_TMUX && 'tmux is not installed' }, async t => {
  const s = await server(t);
  const secret = s.ui.open();
  const phone = { [UI_HEADER]: secret, 'x-test-phone': 'yes' };
  const tok = (await s.post('/api/term/unlock', { via: 'phone', name: null }, phone)).json.token;
  const opened = await s.post('/api/term/open', { repo: s.dir }, { ...phone, 'x-jarvis-term': tok });
  assert.equal(opened.status, 200);
  s.gate.dropPage(secret);
  assert.equal((await s.post('/api/term/resize', { name: opened.json.terminal.name, cols: 40, rows: 20 }, { ...phone, 'x-jarvis-term': tok })).status, 403);
});

test('authenticator data parsing', () => {
  const id = randomBytes(20);
  const a = parseAuthData(authData(0x45, 7, id))!;
  assert.ok(a.up && a.uv); assert.equal(a.count, 7); assert.ok(a.credId!.equals(id));
  assert.equal(parseAuthData(Buffer.alloc(10)), undefined);
});
