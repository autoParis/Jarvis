// Hands-free listening, the browser half. A cheap energy detector cuts the mic into utterances and
// notices the owner talking over Jarvis; the daemon then confirms each clip with Silero VAD and applies
// the wake word (daemon/listen.ts). Pure functions only, so daemon/listen.test.ts can run them in Node.

/** Defaults; the daemon overrides any of them from its environment (GET /api/listen/config). */
export const DEFAULTS = {
  frameMs: 20,          // the mic is measured in 20 ms frames
  startMarginDb: 15,    // speech starts this far above the room's noise floor...
  endMarginDb: 8,       // ...and ends once it falls back under this margin
  minDb: -60,           // never count anything quieter than this as speech, and always count it as quiet
  noSignalDb: -100,     // digital silence (a mic starting up, a muted track): says nothing about the room
  minSpeechMs: 200,     // loud for this long before it counts (a cough or a door is shorter)
  endSilenceMs: 1500,   // quiet for this long ends the utterance: the end-of-speech delay before upload.
                        // 1000 ms sent messages while the owner was still thinking; his mid-sentence pause measured
                        // 920 ms (data/samples/always-on/Pause.m4a). Tune here or with env JARVIS_LISTEN_END_SILENCE_MS
  maxUtteranceMs: 600000, // a safety cap, not a pause: 30 s cut the owner's messages mid-sentence. The 10 min WAV is
                          // 19.2 MB, under the daemon's 20 MB upload limit, and transcribes in about 2 s.
  steadyMs: 3000,       // a level this steady for this long is a room that got louder (a fan), not speech...
  steadyRangeDb: 6,     // ...where steady means staying within this range. Talking swings far wider between words.
  preRollMs: 300,       // audio kept from before the start, so the first syllable is not cut
  bargeInMarginDb: 22,  // while Jarvis is speaking, a louder and longer start is needed,
  bargeInMs: 300,       // so its own voice leaking past echo cancellation does not stop it
  floorRise: 0.002,     // how fast the noise floor follows a louder room (per frame)
};

/** RMS level of a block of samples, in dBFS. */
export function levelDb(samples) {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return samples.length ? 10 * Math.log10(sum / samples.length + 1e-12) : -120;
}

/**
 * Feed one frame level at a time. Returns 'start' when speech begins (while Jarvis is playing, that
 * is a barge-in), 'end' when the utterance is over, otherwise null.
 */
export function makeSegmenter(cfg = DEFAULTS) {
  const c = { ...DEFAULTS, ...cfg };
  let floor = null, speaking = false, loud = 0, quiet = 0, length = 0, low = 0, steady = 0, steadyLow = 0, steadyHigh = 0;
  return {
    get speaking() { return speaking; },
    get floor() { return floor; },
    push(db, { playing = false } = {}) {
      // A floor taken from digital silence would sit near -120 dB: no real room falls that low, so an
      // utterance would never end before maxUtteranceMs (the 15 s delay the owner measured).
      if (floor === null) { if (db < c.noSignalDb) return null; floor = db; }
      if (!speaking) {
        const margin = playing ? c.bargeInMarginDb : c.startMarginDb;
        const need = playing ? c.bargeInMs : c.minSpeechMs;
        if (db >= c.minDb && db >= floor + margin) loud += c.frameMs;
        else { loud = 0; if (db >= c.noSignalDb) floor = db < floor ? db : floor + (db - floor) * c.floorRise; }
        if (loud < need) return null;
        speaking = true; quiet = 0; length = loud; loud = 0; low = db; steady = 0; steadyLow = steadyHigh = db;
        return 'start';
      }
      length += c.frameMs;
      if (db >= c.noSignalDb) {
        if (db < low) low = db;
        steadyLow = Math.min(steadyLow, db); steadyHigh = Math.max(steadyHigh, db);
        if (steadyHigh - steadyLow > c.steadyRangeDb) { steady = 0; steadyLow = steadyHigh = db; }
        else steady += c.frameMs;
      }
      quiet = db < Math.max(floor + c.endMarginDb, c.minDb) ? quiet + c.frameMs : 0;
      if (quiet >= c.endSilenceMs) { speaking = false; return 'end'; }
      // The room itself got louder and nothing would ever count as quiet again: the floor moves up to it.
      if (steady >= c.steadyMs) { speaking = false; floor = Math.max(floor, steadyLow); return 'end'; }
      // Cut off at the cap: a room that is loud but not steady (music), so the floor moves up to the quietest it heard.
      if (length >= c.maxUtteranceMs) { speaking = false; floor = Math.max(floor, low); return 'end'; }
      return null;
    },
    reset() { speaking = false; loud = 0; quiet = 0; length = 0; },
  };
}

/** Float32 mono samples at `rate` in, a 16 kHz 16-bit mono WAV out (what the STT wants anyway). */
export function encodeWav(samples, rate, outRate = 16000) {
  const step = rate / outRate, n = Math.floor(samples.length / step);
  const buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, outRate, true); v.setUint32(28, outRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    // average the input samples that fall in this output sample (a crude low-pass before decimating)
    const a = Math.floor(i * step), b = Math.max(a + 1, Math.floor((i + 1) * step));
    let s = 0;
    for (let j = a; j < b; j++) s += samples[j];
    const x = Math.max(-1, Math.min(1, s / (b - a)));
    v.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true);
  }
  return buf;
}
