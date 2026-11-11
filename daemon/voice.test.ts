// The voice routes, tested through voiceRoute() and voiceFileRoute() with a fake request, as nativeroutes.test.ts does.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { listenConfig } from './listen.ts';
import { makeSpeaker, voiceRoute, voiceFileRoute, spokenSentences, type VoiceCtx } from './voice.ts';

const audio = Buffer.from('fake audio');
const raw = (limit: number) => { assert.equal(limit, 20e6); return Promise.resolve(audio); };
const noBody = () => { throw new Error('the route read a body it does not need'); };
const q = (s = '') => new URLSearchParams(s);

function setup(stt: { text: string; speech?: boolean }, env: Record<string, string> = {}) {
  const seen: any = { owner: [], added: [], logs: [], stt: [] };
  const speaker = makeSpeaker({ tts: async s => s, broadcast: () => {}, log: () => {}, windowMs: 30_000 });
  const o: VoiceCtx = {
    voice: { stt: async (a, vad) => { seen.stt.push([a, vad]); return { text: stt.text, confidence: 0.9, speech: stt.speech ?? true }; } },
    listen: listenConfig(env), speaker, log: m => seen.logs.push(m),
    fromOwner: (text, replyTo) => seen.owner.push([text, replyTo]),
    toWorker: async (id, text) => { (seen.worker ??= []).push([id, text]); return id === 'n:gone' ? { status: 404, body: { error: 'It is not in the work list any more.' } } : { status: 200, body: { done: 'sent' } }; },
    uploads: mkdtempSync(join(tmpdir(), 'jarvis-up-')),
    today: { list: () => ['row'], add: b => { seen.added.push(b); return { status: 200, body: { id: 4 } }; } },
  };
  return { o, seen, speaker };
}

test('voice: the detector settings say whether a wake word is set', async () => {
  assert.deepEqual((await voiceRoute(setup({ text: '' }).o, 'GET', '/api/listen/config', noBody, q()))?.body.wakeWord, false);
  assert.deepEqual((await voiceRoute(setup({ text: '' }, { JARVIS_WAKE_WORD: 'jarvis' }).o, 'GET', '/api/listen/config', noBody, q()))?.body.wakeWord, true);
});

test('voice: the chat microphone sends the typed text, the words and the reply target as one message', async () => {
  const { o, seen } = setup({ text: 'check the badge' });
  const r = await voiceRoute(o, 'POST', '/api/voice', raw, q('typed=Also&replyTo=12'));
  assert.deepEqual(r, { status: 200, body: { text: 'check the badge', confidence: 0.9, sent: true } });
  assert.equal(seen.owner.length, 1);
  assert.match(seen.owner[0][0], /Also[\s\S]*check the badge/);
  assert.equal(seen.owner[0][1], 12);
  assert.equal(seen.stt[0][1], undefined, 'push-to-talk skips the VAD');
  const empty = setup({ text: '' });
  assert.deepEqual((await voiceRoute(empty.o, 'POST', '/api/voice', raw, q()))?.body, { text: '', confidence: 0.9, sent: false });
  assert.deepEqual(empty.seen.owner, []);
});

test('voice: the pane microphone sends to its worker, not to the brain', async () => {
  const { o, seen } = setup({ text: 'run the tests' });
  const r = await voiceRoute(o, 'POST', '/api/voice', raw, q('target=n:w1&typed=Then'));
  assert.deepEqual(r, { status: 200, body: { text: 'run the tests', confidence: 0.9, sent: true, message: 'Then run the tests' } });
  assert.deepEqual(seen.worker, [['n:w1', 'Then run the tests']]);
  assert.deepEqual(seen.owner, [], 'the brain gets nothing');
  const gone = await voiceRoute(o, 'POST', '/api/voice', raw, q('target=n:gone'));
  assert.equal(gone?.status, 404);
  assert.equal(gone?.body.text, 'run the tests', 'the words come back, so the page can keep them');
  const empty = setup({ text: '' });
  assert.deepEqual((await voiceRoute(empty.o, 'POST', '/api/voice', raw, q('target=n:w1')))?.body, { text: '', confidence: 0.9, sent: false });
  assert.equal(empty.seen.worker, undefined);
});

test('voice: hands-free keeps a clip with the wake word, then the follow-up window, and drops the rest', async () => {
  const env = { JARVIS_WAKE_WORD: 'jarvis' };
  const silent = setup({ text: '', speech: false }, env);
  assert.deepEqual((await voiceRoute(silent.o, 'POST', '/api/voice', raw, q('mode=listen')))?.body, { text: '', kept: false, why: 'no speech' });
  assert.ok(silent.seen.stt[0][1], 'hands-free runs the VAD');
  const stray = setup({ text: 'pass the salt' }, env);
  assert.deepEqual((await voiceRoute(stray.o, 'POST', '/api/voice', raw, q('mode=listen')))?.body, { text: '', kept: false, why: 'no wake word' });
  assert.deepEqual(stray.seen.owner, []);
  const called = setup({ text: 'Jarvis, merge it' }, env);
  assert.deepEqual((await voiceRoute(called.o, 'POST', '/api/voice', raw, q('mode=listen')))?.body, { text: 'Jarvis, merge it', confidence: 0.9, kept: true, why: 'wake word' });
  assert.deepEqual(called.seen.owner, [['Jarvis, merge it', undefined]]);
  assert.ok(called.speaker.heard(Date.now()).lastAddressedAt > 0, 'the follow-up window opens');
});

test('voice: the Today microphone adds one item and says nothing in the chat', async () => {
  const { o, seen } = setup({ text: 'call the bank' });
  assert.deepEqual(await voiceRoute(o, 'POST', '/api/today/voice', raw, q('go=1')), { status: 200, body: { words: 'call the bank', id: 4 } });
  assert.deepEqual(seen.added, [{ words: 'call the bank', go: true }]);
  assert.deepEqual(seen.owner, []);
  const empty = setup({ text: '' });
  assert.deepEqual(await voiceRoute(empty.o, 'POST', '/api/today/voice', raw, q()), { status: 200, body: { words: '', today: ['row'] } });
  assert.equal(await voiceRoute(o, 'GET', '/api/voice', noBody, q()), undefined);
});

/** A response that collects what the route writes and pipes. */
function fakeRes() {
  const s: any = new PassThrough();
  const chunks: Buffer[] = [];
  s.on('data', (c: Buffer) => chunks.push(c));
  s.writeHead = (status: number, headers: object) => { s.status = status; s.headers = headers; return s; };
  s.done = () => new Promise<string>(resolve => s.on('end', () => resolve(Buffer.concat(chunks).toString())));
  return s;
}
const fakeReq = (headers: object = {}, method = 'GET') => ({ method, headers }) as any;

test('voice files: a clip with and without a range, one sentence of a stored message, the bake-off page, and 404s', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-audio-'));
  writeFileSync(join(dir, 'abc.m4a'), '0123456789');
  const bakeoffDir = join(dir, 'bakeoff'); mkdirSync(bakeoffDir); writeFileSync(join(bakeoffDir, 'b.m4a'), 'x');
  const noted: string[] = [], rendered: string[] = [];
  const o = { voice: { dir, tts: async (s: string) => { rendered.push(s); return 'abc.m4a'; } }, speaker: { noteSpoken: (s: string) => noted.push(s) },
    jarvisText: (id: number) => (id === 5 ? 'First one. Second one.' : undefined),
    workerText: (row: string, line: string) => (row === 'n:w1' && line === 'f:120' ? 'Tests pass. Pushed it.' : undefined), bakeoffDir };
  let res = fakeRes();
  assert.equal(await voiceFileRoute(o, fakeReq(), res, '/audio/abc.m4a'), true);
  assert.equal(await res.done(), '0123456789');
  assert.deepEqual([res.status, res.headers['content-length']], [200, 10]);
  res = fakeRes();
  await voiceFileRoute(o, fakeReq({ range: 'bytes=2-4' }), res, '/audio/abc.m4a');
  assert.equal(await res.done(), '234');
  assert.deepEqual([res.status, res.headers['content-range']], [206, 'bytes 2-4/10']);
  res = fakeRes();
  await voiceFileRoute(o, fakeReq(), res, '/audio/none.m4a');
  assert.equal(res.status, 404);
  res = fakeRes();
  await voiceFileRoute(o, fakeReq(), res, '/api/speech/5/1');
  assert.deepEqual([rendered, noted], [['Second one.'], ['Second one.']]);
  res = fakeRes();
  await voiceFileRoute(o, fakeReq(), res, '/api/speech/5/9');
  assert.equal(res.status, 404);
  // A worker's message in its pane: the row id and the line id, each URL-encoded, then the sentence.
  res = fakeRes();
  await voiceFileRoute(o, fakeReq(), res, `/api/speech/worker/${encodeURIComponent('n:w1')}/${encodeURIComponent('f:120')}/1`);
  assert.equal(res.status, 200);
  assert.deepEqual(rendered.at(-1), 'Pushed it.');
  for (const bad of [`/api/speech/worker/n%3Aw1/f%3A99/0`, '/api/speech/worker/%E0%A4%A/f%3A120/0', `/api/speech/worker/n%3Aw1/f%3A120/5`]) {
    res = fakeRes();
    await voiceFileRoute(o, fakeReq(), res, bad);
    assert.equal(res.status, 404, bad);
  }
  res = fakeRes();
  await voiceFileRoute(o, fakeReq(), res, '/bakeoff');
  assert.match(await res.done(), /<audio controls preload="none" src="\/bakeoff\/b\.m4a">/);
  res = fakeRes();
  await voiceFileRoute(o, fakeReq(), res, '/bakeoff/b.m4a');
  assert.equal(await res.done(), 'x');
  assert.equal(await voiceFileRoute(o, fakeReq({}, 'POST'), fakeRes(), '/audio/abc.m4a'), false);
  assert.equal(await voiceFileRoute(o, fakeReq(), fakeRes(), '/image'), false);
});

test('speaker: sentences go out in order, markers are never read, and the echo guard keeps what was said', async () => {
  const events: any[] = [];
  const said: string[] = [];
  const speaker = makeSpeaker({ tts: async s => { said.push(s); return s; }, broadcast: e => events.push(e), log: () => {}, windowMs: 30_000 });
  assert.deepEqual(spokenSentences('Done. [image: /tmp/a.png] See it.'), ['Done.', 'See it.']);
  speaker.speak('One. Two.', 3);
  await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(said, ['One.', 'Two.']);
  assert.deepEqual(events, [{ type: 'audio', turnId: 3, i: 0, total: 2 }, { type: 'audio', turnId: 3, i: 1, total: 2 }]);
  assert.deepEqual(speaker.heard(Date.now()).recentSpoken, ['One.', 'Two.']);
});
