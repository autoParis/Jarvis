import test from 'node:test';
import assert from 'node:assert/strict';
import { makeMic, HOLD_MS } from '../web/mic.js';

// web/mic.js listens on a button and records with MediaRecorder. These stand-ins hold only what it touches.
function setup() {
  const on: Record<string, (e: any) => void> = {}, docOn: Record<string, (e: any) => void> = {};
  const cls = new Set<string>(), attrs: Record<string, string> = {};
  const button = { classList: { add: (c: string) => cls.add(c), remove: (c: string) => cls.delete(c), contains: (c: string) => cls.has(c) }, setAttribute: (k: string, v: string) => { attrs[k] = v; }, addEventListener: (ev: string, f: any) => { on[ev] = f; } };
  const clips: Blob[] = [], hints: string[] = [];
  let t = 0;
  class Recorder {
    state = 'inactive'; keep = false; mimeType = 'audio/mp4'; ondataavailable: any; onstop: any;
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; this.ondataavailable({ data: new Blob([new Uint8Array(3000)]) }); this.onstop(); }
  }
  const mic = makeMic({
    button, label: 'Dictate', getStream: async () => ({}), onHint: (h: string) => hints.push(h), onError() {},
    onClip: async (b: Blob) => { clips.push(b); }, doc: { addEventListener: (ev: string, f: any) => { docOn[ev] = f; } }, Recorder, now: () => t,
  });
  const ev = { preventDefault() {}, pointerId: 1 };
  return { mic, on, docOn, cls, clips, hints, ev, at: (ms: number) => { t = ms; } };
}
const tick = () => new Promise(r => setTimeout(r, 0));

test('a tap starts a dictation and the next tap sends the clip', async () => {
  const s = setup();
  await s.on.pointerdown(s.ev); s.at(100); s.on.pointerup(s.ev);
  assert.ok(s.mic.active());
  assert.ok(s.cls.has('rec'));
  await s.on.pointerdown(s.ev);
  await tick();
  assert.equal(s.clips.length, 1);
  assert.ok(!s.mic.active());
});

test('a hold sends the clip on release', async () => {
  const s = setup();
  await s.on.pointerdown(s.ev); s.at(HOLD_MS + 50); s.on.pointerup(s.ev);
  await tick();
  assert.equal(s.clips.length, 1);
});

test('Escape or leaving the pane drops the clip', async () => {
  const s = setup();
  await s.on.pointerdown(s.ev); s.at(100); s.on.pointerup(s.ev);
  s.docOn.keydown({ key: 'Escape' });
  await tick();
  assert.equal(s.clips.length, 0);
  await s.on.pointerdown(s.ev); s.at(200); s.on.pointerup(s.ev);
  s.mic.stop(false);
  await tick();
  assert.equal(s.clips.length, 0);
  assert.equal(s.hints.at(-1), '', 'the hint goes');
});
