// Hands-free listening, the daemon half. The app cuts the mic into utterances (web/listen.js) and posts
// each one to /api/voice?mode=listen. Here a clip is checked by Silero VAD (voice.ts), transcribed, then
// kept or dropped: the wake word, the follow-up window and the echo guard below. Push-to-talk clips skip
// all of this. Every threshold comes from the environment so the owner's samples can tune it without code.

export type ListenConfig = {
  /** Words that address Jarvis, normalized. Empty means no wake word: every clip with speech is kept. */
  wakeWords: string[];
  /** After Jarvis speaks or the owner addresses it, this long without needing the wake word again. */
  windowMs: number;
  /** Silero speech probability threshold and the shortest speech span it accepts. */
  vadThreshold: number;
  vadMinSpeechMs: number;
  /** A barge-in clip whose words are mostly Jarvis's own recent words is its voice leaking back. Above 1 turns it off. */
  echoRatio: number;
  /** Log transcripts of dropped clips (other people's conversations), for tuning only. */
  debug: boolean;
  /** Overrides for the browser's detector (web/listen.js DEFAULTS), from JARVIS_LISTEN_<NAME> in SCREAMING_SNAKE. */
  client: Record<string, number>;
};

const CLIENT_KEYS = ['startMarginDb', 'endMarginDb', 'minDb', 'minSpeechMs', 'endSilenceMs', 'maxUtteranceMs', 'steadyMs', 'steadyRangeDb', 'preRollMs', 'bargeInMarginDb', 'bargeInMs', 'floorRise', 'noSignalDb'];
const snake = (k: string) => k.replace(/[A-Z]/g, c => '_' + c).toUpperCase();

export function listenConfig(env: Record<string, string | undefined> = process.env): ListenConfig {
  const num = (name: string, dflt: number) => {
    const n = Number(env[name]);
    return env[name] !== undefined && env[name] !== '' && Number.isFinite(n) ? n : dflt;
  };
  const client: Record<string, number> = {};
  for (const k of CLIENT_KEYS) {
    const v = num(`JARVIS_LISTEN_${snake(k)}`, NaN);
    if (!Number.isNaN(v)) client[k] = v;
  }
  return {
    wakeWords: (env.JARVIS_WAKE_WORD ?? '').split(',').map(normalize).filter(Boolean),
    windowMs: num('JARVIS_WAKE_WINDOW_MS', 30_000),
    vadThreshold: num('JARVIS_VAD_THRESHOLD', 0.5),
    vadMinSpeechMs: num('JARVIS_VAD_MIN_SPEECH_MS', 250),
    echoRatio: num('JARVIS_ECHO_RATIO', 0.9),
    debug: env.JARVIS_LISTEN_DEBUG === '1',
    client,
  };
}

/** Lowercase, no accents, letters and digits separated by single spaces. */
export function normalize(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** True when one of the wake words (each may be several words) appears as whole words in the transcript. */
export function hasWakeWord(text: string, wakeWords: string[]): boolean {
  const t = ` ${normalize(text)} `;
  return wakeWords.some(w => t.includes(` ${w} `));
}

/** Share of the transcript's words found in what Jarvis just said. Only clips of 3 words or more count. */
export function echoShare(text: string, spoken: string[]): number {
  const words = normalize(text).split(' ').filter(Boolean);
  if (words.length < 3) return 0;
  const said = new Set(normalize(spoken.join(' ')).split(' '));
  return words.filter(w => said.has(w)).length / words.length;
}

export type Heard = {
  text: string;
  /** The clip started while Jarvis was playing (the app stopped playback for it). */
  bargeIn: boolean;
  now: number;
  /** When Jarvis last sent audio, and when the owner last addressed it in a kept clip. */
  lastSpokeAt: number;
  lastAddressedAt: number;
  /** Sentences Jarvis spoke in the last window. */
  recentSpoken: string[];
};

export type Verdict = { keep: true; why: 'wake word' | 'window' | 'no wake word set' } | { keep: false; why: 'empty' | 'echo' | 'no wake word' };

export function judge(h: Heard, cfg: Pick<ListenConfig, 'wakeWords' | 'windowMs' | 'echoRatio'>): Verdict {
  if (!normalize(h.text)) return { keep: false, why: 'empty' };
  if (h.bargeIn && echoShare(h.text, h.recentSpoken) >= cfg.echoRatio) return { keep: false, why: 'echo' };
  if (!cfg.wakeWords.length) return { keep: true, why: 'no wake word set' };
  if (hasWakeWord(h.text, cfg.wakeWords)) return { keep: true, why: 'wake word' };
  if (h.now - Math.max(h.lastSpokeAt, h.lastAddressedAt) <= cfg.windowMs) return { keep: true, why: 'window' };
  return { keep: false, why: 'no wake word' };
}
