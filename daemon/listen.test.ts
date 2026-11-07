import test from 'node:test';
import assert from 'node:assert/strict';
import { listenConfig, normalize, hasWakeWord, echoShare, judge, type Heard } from './listen.ts';
// @ts-ignore plain browser module, no types
import { makeSegmenter, levelDb, encodeWav, DEFAULTS } from '../web/listen.js';

// Feed a sequence of [dB, frames] runs and collect what the segmenter says, with the frame index.
function run(seg: ReturnType<typeof makeSegmenter>, runs: [number, number][], playing = false) {
  const out: [string, number][] = [];
  let i = 0;
  for (const [db, n] of runs) for (let k = 0; k < n; k++, i++) {
    const e = seg.push(db, { playing });
    if (e) out.push([e, i]);
  }
  return out;
}
const frames = (ms: number) => ms / DEFAULTS.frameMs;

test('speech above the noise floor for 200 ms starts an utterance; endSilenceMs of quiet ends it', () => {
  const seg = makeSegmenter();
  const out = run(seg, [[-70, 50], [-40, frames(1000)], [-70, frames(DEFAULTS.endSilenceMs)]]);
  assert.deepEqual(out.map(e => e[0]), ['start', 'end']);
  assert.equal(out[0][1], 50 + frames(200) - 1);
  assert.equal(out[1][1], 50 + frames(1000) + frames(DEFAULTS.endSilenceMs) - 1);
});

test('the end-of-speech delay is 1.5 s, longer than the owner\'s pauses', () => {
  assert.equal(DEFAULTS.endSilenceMs, 1500);
});

test('a short noise (a cough, a door) never starts an utterance, and the owner\'s 920 ms mid-sentence pause does not end one', () => {
  const seg = makeSegmenter();
  assert.deepEqual(run(seg, [[-70, 50], [-40, frames(100)], [-70, 50]]), []);
  const out = run(seg, [[-40, frames(500)], [-70, frames(940)], [-40, frames(500)], [-70, frames(DEFAULTS.endSilenceMs + 100)]]);
  assert.deepEqual(out.map(e => e[0]), ['start', 'end']);
});

test('the floor follows the room: steady fan noise does not count as speech, talking over it does', () => {
  const seg = makeSegmenter();
  assert.deepEqual(run(seg, [[-50, 2000]]), []); // a loud but steady room
  assert.ok(seg.floor > -51 && seg.floor <= -50);
  assert.deepEqual(run(seg, [[-30, frames(400)]]).map(e => e[0]), ['start']);
});

test('nothing quieter than minDb counts, even in a silent room', () => {
  const seg = makeSegmenter();
  assert.deepEqual(run(seg, [[-100, 50], [-65, 100]]), []);
});

test('while Jarvis plays, a barge-in needs to be louder and longer than normal speech', () => {
  const quiet = makeSegmenter();
  assert.deepEqual(run(quiet, [[-70, 50], [-50, 100]], true), []); // 20 dB over the floor: Jarvis leaking back
  const loud = makeSegmenter();
  const out = run(loud, [[-70, 50], [-40, 100]], true);
  assert.deepEqual(out[0], ['start', 50 + frames(300) - 1]);
});

test('digital silence when the mic opens does not become the floor, so the utterance still ends', () => {
  // Before: one -120 dB frame set the floor there and nothing was ever quiet again; every clip ran to the 30 s cap.
  const seg = makeSegmenter();
  const out = run(seg, [[-120, 5], [-70, 50], [-40, frames(1000)], [-120, 3], [-70, frames(DEFAULTS.endSilenceMs)]]);
  assert.deepEqual(out.map(e => e[0]), ['start', 'end']);
  assert.ok(seg.floor > -71);
});

test('anything under minDb counts as quiet even when the floor sits far below it', () => {
  const seg = makeSegmenter();
  const out = run(seg, [[-95, 50], [-40, frames(1000)], [-62, frames(DEFAULTS.endSilenceMs)]]);
  assert.deepEqual(out.map(e => e[0]), ['start', 'end']);
});

test('a room that got louder ends one capped utterance, then the floor moves up to it', () => {
  const seg = makeSegmenter({ maxUtteranceMs: 2000 });
  const out = run(seg, [[-80, 50], [-55, frames(4000)]]); // a fan comes on
  assert.deepEqual(out.map(e => e[0]), ['start', 'end']);
  assert.ok(seg.floor >= -55.5);
});

// Talking: loud stretches with short dips back to the room between words, for `ms` milliseconds.
function talk(ms: number, dip = -70): [number, number][] {
  return Array.from({ length: Math.ceil(ms / 300) * 2 }, (_, i) => [i % 2 ? dip : -40, i % 2 ? 3 : 12]);
}

test('five minutes of talking stays one message, and it goes when the owner stops', () => {
  // Before: every 30 s of talking was cut and sent, mid-sentence (data/jarvisd.log, 2026-11-03 13:12).
  const seg = makeSegmenter();
  const out = run(seg, [[-70, 10], ...talk(300_000)]);
  assert.deepEqual(out.map(e => e[0]), ['start']);
  assert.deepEqual(run(seg, [[-70, frames(DEFAULTS.endSilenceMs)]]).map(e => e[0]), ['end']);
});

test('the longest clip still fits the daemon\'s 20 MB upload limit', () => {
  assert.ok(44 + DEFAULTS.maxUtteranceMs / 1000 * 32000 <= 20e6);
});

test('a steady louder room ends the clip after steadyMs without waiting for the cap, and the floor moves up', () => {
  const seg = makeSegmenter();
  const out = run(seg, [[-80, 50], ...talk(5000, -80), [-50, frames(DEFAULTS.steadyMs + 100)]]); // a fan comes on as the owner stops
  assert.deepEqual(out.map(e => e[0]), ['start', 'end']);
  assert.ok(seg.floor >= -50.5);
});

test('talking over a fan is not mistaken for a steady room', () => {
  const seg = makeSegmenter();
  const out = run(seg, [[-80, 50], [-50, 10], ...talk(60_000, -50)]);
  assert.deepEqual(out.map(e => e[0]), ['start']);
});

test('an utterance is cut at maxUtteranceMs', () => {
  const seg = makeSegmenter({ maxUtteranceMs: 2000 });
  // Talking: loud stretches with short dips back to the room between words.
  const talk: [number, number][] = Array.from({ length: 20 }, (_, i) => [i % 2 ? -70 : -40, i % 2 ? 3 : 12]);
  const out = run(seg, [[-70, 10], ...talk]);
  assert.deepEqual(out.slice(0, 2), [['start', 10 + frames(200) - 1], ['end', 10 + frames(2000) - 1]]);
  assert.equal(out[2][0], 'start'); // still talking: the next utterance picks up right away
});

test('levelDb and encodeWav: a 48 kHz block becomes a valid 16 kHz 16-bit mono WAV', () => {
  assert.ok(Math.abs(levelDb(new Float32Array(960).fill(0.1)) - -20) < 0.01);
  assert.ok(levelDb(new Float32Array(960)) < -100);
  const wav = Buffer.from(encodeWav(new Float32Array(48000).fill(0.5), 48000));
  assert.equal(wav.toString('latin1', 0, 4), 'RIFF');
  assert.equal(wav.toString('latin1', 8, 12), 'WAVE');
  assert.equal(wav.readUInt32LE(24), 16000);
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(40), 32000);
  assert.equal(wav.length, 44 + 32000);
  assert.equal(wav.readInt16LE(44 + 1000), Math.floor(0.5 * 0x7fff));
});

test('config: wake words are normalized, unset numbers keep their defaults, client overrides come from JARVIS_LISTEN_*', () => {
  const c = listenConfig({ JARVIS_WAKE_WORD: 'Jarvis, Hé Jarvis ,', JARVIS_WAKE_WINDOW_MS: '5000', JARVIS_VAD_THRESHOLD: '', JARVIS_LISTEN_END_SILENCE_MS: '1200', JARVIS_LISTEN_BARGE_IN_MARGIN_DB: 'loud' });
  assert.deepEqual(c.wakeWords, ['jarvis', 'he jarvis']);
  assert.equal(c.windowMs, 5000);
  assert.equal(c.vadThreshold, 0.5);
  assert.deepEqual(c.client, { endSilenceMs: 1200 });
  assert.deepEqual(listenConfig({}).wakeWords, []);
});

test('the wake word matches whole words, any case, accents and punctuation ignored', () => {
  assert.equal(normalize('  Hé, JARVIS!  Démarre 4412. '), 'he jarvis demarre 4412');
  assert.ok(hasWakeWord('Jarvis, start 4412', ['jarvis']));
  assert.ok(hasWakeWord('ok... JARVIS?', ['jarvis']));
  assert.ok(!hasWakeWord('Jarvisland is a theme park', ['jarvis']));
  assert.ok(hasWakeWord('hey jarvis go', ['hey jarvis']));
  assert.ok(!hasWakeWord('hey there jarvis', ['hey jarvis']));
});

const base: Heard = { text: '', bargeIn: false, now: 100_000, lastSpokeAt: 0, lastAddressedAt: 0, recentSpoken: [] };
const cfg = { wakeWords: ['jarvis'], windowMs: 30_000, echoRatio: 0.9 };

test('with a wake word set: kept when it is said, or within the window after Jarvis spoke or the owner addressed it', () => {
  assert.deepEqual(judge({ ...base, text: 'Jarvis, start 4412' }, cfg), { keep: true, why: 'wake word' });
  assert.deepEqual(judge({ ...base, text: 'did you see the game last night' }, cfg), { keep: false, why: 'no wake word' });
  assert.deepEqual(judge({ ...base, text: 'yes go ahead', lastSpokeAt: 80_000 }, cfg), { keep: true, why: 'window' });
  assert.deepEqual(judge({ ...base, text: 'and 4415 too', lastAddressedAt: 75_000 }, cfg), { keep: true, why: 'window' });
  assert.deepEqual(judge({ ...base, text: 'and 4415 too', lastAddressedAt: 60_000 }, cfg), { keep: false, why: 'no wake word' });
  assert.deepEqual(judge({ ...base, text: ' ... ' }, cfg), { keep: false, why: 'empty' });
});

test('without a wake word every clip with words is kept', () => {
  assert.deepEqual(judge({ ...base, text: 'did you see the game' }, { ...cfg, wakeWords: [] }), { keep: true, why: 'no wake word set' });
});

test('echo guard: a barge-in that repeats what Jarvis just said is dropped; a real answer that reuses its words is kept', () => {
  const recentSpoken = ['Story 4412 is waiting on you.', 'Should I start 4412 and 4415?'];
  const echo = { ...base, bargeIn: true, recentSpoken, lastSpokeAt: 99_000 };
  assert.deepEqual(judge({ ...echo, text: 'should I start 4412 and 4415' }, cfg), { keep: false, why: 'echo' });
  assert.deepEqual(judge({ ...echo, text: 'yes, start 4412 and 4415' }, cfg), { keep: true, why: 'window' });
  assert.deepEqual(judge({ ...echo, text: 'stop' }, cfg), { keep: true, why: 'window' }); // under 3 words never counts as echo
  assert.deepEqual(judge({ ...echo, bargeIn: false, text: 'should I start 4412 and 4415' }, cfg), { keep: true, why: 'window' });
  assert.deepEqual(judge({ ...echo, text: 'should I start 4412 and 4415' }, { ...cfg, echoRatio: 2 }), { keep: true, why: 'window' });
  assert.equal(echoShare('should I start it', recentSpoken), 0.75);
});
