import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSpeech } from '../web/speech.js';
import { byteRange, onceAtATime } from './voice.ts';

// An audio element with no sound: `src` starts at 0 s, and the test fires what a browser would fire.
function setup() {
  const audio: any = { src: '', currentTime: 0, plays: 0, paused: true, play() { this.plays++; this.paused = false; return audio.refuse ? Promise.reject(Object.assign(new Error('x'), { name: 'NotAllowedError' })) : Promise.resolve(); }, pause() { this.paused = true; } };
  const warmed: string[] = [];
  const speech = makeSpeech({ audio, clipUrl: (t: number, i: number) => `${t}/${i}`, warm: (u: string) => warmed.push(u) });
  const load = () => { audio.currentTime = 0; audio.onloadedmetadata(); audio.onplaying(); };
  return { audio, speech, load, warmed };
}

test('voice mode plays a new reply and shows it as playing, sentence after sentence, then goes idle', () => {
  const { audio, speech, load, warmed } = setup();
  speech.live(7, 2, 0);
  assert.equal(audio.src, '7/0');
  assert.equal(speech.state(7), 'loading');
  load();
  assert.equal(speech.state(7), 'playing');
  assert.deepEqual(warmed, ['7/1'], 'the next sentence is asked for early');
  speech.live(7, 2, 1); // the next clip's event changes nothing
  assert.equal(audio.src, '7/0');
  audio.onended();
  assert.equal(audio.src, '7/1');
  load();
  audio.onended();
  assert.equal(speech.state(7), 'idle');
  assert.equal(speech.active(), false);
});

test('stopping leaves voice mode on: the next reply plays, and a tap continues the stopped one at its place', () => {
  const { audio, speech, load } = setup();
  speech.live(7, 3, 0);
  load();
  audio.onended();
  load();
  audio.currentTime = 1.5;
  speech.toggle(7, 3);
  assert.equal(audio.paused, true);
  assert.equal(speech.state(7), 'paused');
  speech.live(7, 3, 2); // a later clip of the stopped reply does not restart it
  assert.equal(audio.paused, true);
  speech.live(8, 1, 0); // the next reply is spoken
  assert.equal(audio.src, '8/0');
  load();
  audio.onended();
  speech.toggle(7, 3);
  assert.equal(audio.src, '7/1', 'the sentence it stopped in');
  audio.onloadedmetadata();
  assert.equal(audio.currentTime, 1.5, 'the place it stopped at');
});

test('a tap plays an old message from the start, stops the one sounding, and a new reply cuts the replay', () => {
  const { audio, speech, load } = setup();
  speech.live(7, 1, 0);
  load();
  audio.currentTime = 2;
  speech.toggle(3, 2);
  assert.equal(audio.src, '3/0');
  assert.equal(speech.state(7), 'paused');
  load();
  speech.live(9, 1, 0);
  assert.equal(audio.src, '9/0', 'the newest message takes over');
  assert.equal(speech.state(3), 'idle', 'the replay had not moved in this test, so its button is back to idle');
});

test('a reply waits for one playing, and stopping the first starts it', () => {
  const { audio, speech, load } = setup();
  speech.live(7, 1, 0);
  load();
  speech.live(8, 1, 0);
  assert.equal(audio.src, '7/0');
  speech.toggle(7, 1);
  assert.equal(audio.src, '8/0');
});

test('turning sound off stops everything, and the owner talking over a reply drops its later clips', () => {
  const { audio, speech, load } = setup();
  speech.live(7, 2, 0);
  load();
  speech.live(8, 1, 0);
  speech.hush();
  assert.equal(audio.paused, true);
  assert.equal(speech.active(), false);
  speech.hold(10, 3);
  speech.live(10, 3, 1);
  assert.equal(speech.active(), false);
});

test('a clip that cannot play is skipped, and the button says so only when nothing played', () => {
  const { audio, speech, load } = setup();
  speech.toggle(5, 2);
  audio.onerror();
  assert.equal(audio.src, '5/1');
  audio.onerror();
  assert.equal(speech.state(5), 'failed');
  speech.toggle(6, 2);
  audio.onerror();
  load();
  audio.onended();
  assert.equal(speech.state(6), 'idle');
});

test('a browser that wants a gesture leaves the message ready for a tap', async () => {
  const { audio, speech } = setup();
  audio.refuse = true;
  speech.live(7, 1, 0);
  await new Promise(r => setImmediate(r));
  assert.equal(speech.state(7), 'idle');
  assert.equal(speech.active(), false);
  audio.refuse = false;
  speech.toggle(7, 1);
  assert.equal(speech.state(7), 'loading');
});

test('byte ranges: a start and end, an open end, a suffix, and the ones that fail', () => {
  assert.deepEqual(byteRange('bytes=0-1', 10), { start: 0, end: 1 });
  assert.deepEqual(byteRange('bytes=4-', 10), { start: 4, end: 9 });
  assert.deepEqual(byteRange('bytes=-3', 10), { start: 7, end: 9 });
  assert.deepEqual(byteRange('bytes=8-99', 10), { start: 8, end: 9 });
  assert.equal(byteRange('bytes=20-', 10), 'bad');
  assert.equal(byteRange(undefined, 10), null);
});

test('two requests for one clip share a render, and a failed render is tried again', async () => {
  const running = new Map<string, Promise<string>>();
  let renders = 0;
  const work = async () => { renders++; return 'x.m4a'; };
  const [a, b] = await Promise.all([onceAtATime(running, 'k', work), onceAtATime(running, 'k', work)]);
  assert.deepEqual([a, b, renders], ['x.m4a', 'x.m4a', 1]);
  await assert.rejects(onceAtATime(running, 'k', async () => { throw new Error('no'); }));
  assert.equal(await onceAtATime(running, 'k', work), 'x.m4a');
  assert.equal(renders, 2);
});
