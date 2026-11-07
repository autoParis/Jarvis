// Replays audio files through the browser's utterance detector (web/listen.js) and prints, for each cut,
// how long after the end of speech the clip would have been sent. The daemon side (VAD + STT) is timed
// separately in data/jarvisd.log ("listen N ms"); this covers the part before the upload.
//
//   node bin/listen-replay.ts [--lead 2] [--tail 3] [--room -65] [--set endSilenceMs=600] file.m4a ...
//
// Each file is decoded to 48 kHz mono, padded with --lead seconds before and --tail seconds after, mixed
// with synthetic room noise at --room dBFS over the whole run (what the mic hears between sentences),
// then fed in 20 ms frames. --mic-start adds 100 ms of digital silence first, as a mic does when it opens.
import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';
// @ts-ignore plain browser module, no types
import { DEFAULTS, makeSegmenter, levelDb } from '../web/listen.js';

const RATE = 48000;

export function decode(file: string): Float32Array {
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-ac', '1', '-ar', String(RATE), '-f', 'f32le', '-'], { maxBuffer: 1 << 30 });
  return new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
}

/** White noise at `db` dBFS RMS, seeded so runs repeat. */
export function noise(seconds: number, db: number, seed = 1): Float32Array {
  const out = new Float32Array(Math.round(seconds * RATE)), amp = 10 ** (db / 20) * Math.sqrt(3);
  for (let i = 0; i < out.length; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; out[i] = (seed / 0x7fffffff * 2 - 1) * amp; }
  return out;
}

/** Adds `b` onto `a` in place, sample by sample. */
export function mix(a: Float32Array, b: Float32Array): Float32Array {
  for (let i = 0; i < a.length && i < b.length; i++) a[i] += b[i];
  return a;
}

export function concat(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  parts.reduce((o, p) => (out.set(p, o), o + p.length), 0);
  return out;
}

export type Cut = { startMs: number; endMs: number };

/** Runs the segmenter over the samples the way web/index.html feeds it: 20 ms frames, one level each. */
export function segment(samples: Float32Array, cfg: Record<string, number> = {}): Cut[] {
  const c = { ...DEFAULTS, ...cfg }, size = Math.round(RATE * c.frameMs / 1000), seg = makeSegmenter(c);
  const cuts: Cut[] = [];
  let start = -1;
  for (let i = 0; i + size <= samples.length; i += size) {
    const ev = seg.push(levelDb(samples.subarray(i, i + size)));
    const ms = (i + size) / RATE * 1000;
    if (ev === 'start') start = ms;
    if (ev === 'end') { cuts.push({ startMs: start, endMs: ms }); start = -1; }
  }
  if (start >= 0) cuts.push({ startMs: start, endMs: Infinity });
  return cuts;
}

/** Last 20 ms frame of the clip itself that is within 30 dB of its loudest frame: the end of speech. */
export function speechEndMs(clip: Float32Array): number {
  const size = RATE / 50, levels: number[] = [];
  for (let i = 0; i + size <= clip.length; i += size) levels.push(levelDb(clip.subarray(i, i + size)));
  const peak = Math.max(...levels);
  let last = levels.length - 1;
  while (last > 0 && levels[last] < peak - 30) last--;
  return (last + 1) * 20;
}

if (import.meta.main) {
  const args = process.argv.slice(2), files: string[] = [], cfg: Record<string, number> = {};
  let lead = 2, tail = 3, room = -65, micStart = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--lead') lead = Number(args[++i]);
    else if (args[i] === '--tail') tail = Number(args[++i]);
    else if (args[i] === '--room') room = Number(args[++i]);
    else if (args[i] === '--mic-start') micStart = true;
    else if (args[i] === '--set') { const [k, v] = args[++i].split('='); cfg[k] = Number(v); }
    else files.push(args[i]);
  }
  for (const f of files) {
    const clip = decode(f), leadMs = (lead + (micStart ? 0.1 : 0)) * 1000;
    const body = concat(new Float32Array(lead * RATE), clip, new Float32Array(tail * RATE));
    const all = concat(new Float32Array(micStart ? RATE / 10 : 0), mix(body, noise(body.length / RATE, room)));
    const end = leadMs + speechEndMs(clip), cuts = segment(all, cfg);
    const last = cuts.at(-1);
    const delay = last ? (last.endMs === Infinity ? 'never sent' : `${Math.round(last.endMs - end)} ms`) : 'no speech found';
    console.log(`${basename(f).padEnd(22)} speech ends ${(end / 1000).toFixed(2)} s  cuts ${cuts.length}  end of speech to send: ${delay}` +
      (cuts.length > 1 ? `  (cuts at ${cuts.map(x => (x.endMs / 1000).toFixed(2)).join(', ')} s)` : ''));
  }
}
