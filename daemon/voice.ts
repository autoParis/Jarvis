import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

// ponytail: the CLI is spawned per clip (0.2 s with the CoreML cache warm). Keep a resident
// voice process only if latency measurements say the spawn matters.
const CLI = process.env.JARVIS_FLUIDAUDIO ?? join(process.env.HOME ?? '', 'src/FluidAudio/.build/release/fluidaudiocli');

/** TTS engine per language. Picked by ear in the bake-off; change here or with env vars. */
const TTS: Record<'fr' | 'en', string> = {
  fr: process.env.JARVIS_TTS_FR ?? 'supertonic3:M1',
  en: process.env.JARVIS_TTS_EN ?? 'kokoro-ane:af_heart',
};

function sh(cmd: string, args: string[], timeout = 60_000): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(cmd, args, { timeout, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) =>
      err ? reject(new Error(`${cmd} failed: ${stderr || err.message}`.slice(0, 500))) : resolve(stdout)));
}

/** Runs `work` once per key at a time: a second caller for the same key gets the same promise. A failure is not kept. */
export function onceAtATime<T>(running: Map<string, Promise<T>>, key: string, work: () => Promise<T>): Promise<T> {
  let p = running.get(key);
  if (!p) {
    p = work().finally(() => running.delete(key));
    running.set(key, p);
  }
  return p;
}

/** Reads a `Range: bytes=a-b` header against a file size. Null means send the whole file, 'bad' means answer 416. */
export function byteRange(header: string | undefined, size: number): { start: number; end: number } | null | 'bad' {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header ?? '');
  if (!m || (!m[1] && !m[2])) return null;
  const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
  const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  return start > end ? 'bad' : { start, end };
}

/**
 * A bad render: its transcript matches its words less than MIN_MATCH, and the STT model is unsure of what it heard.
 * Measured on 10,778 clips in data/audio: the garbage renders score under 0.3 with a confidence under 0.62, and a
 * clean clip the STT model writes in its own way ("PR 4777" as "PR 4,777.", "sparis@autoroot" as "Sparus at
 * Otteroute") keeps a confidence of 0.8 or more.
 */
export const MIN_MATCH = 0.6;
const MAX_UNSURE = 0.75;
export const badRender = (match: number, confidence: number) => match < MIN_MATCH && confidence < MAX_UNSURE;
/** Renders tried for one sentence before the best one is kept anyway. A bad render is rare and random, a retry is clean. */
const RENDERS = 3;
/** Sentences shorter than this many words are not checked. */
const CHECK_WORDS = 3;

type Log = (msg: string, data?: Record<string, unknown>) => void;

export function makeVoice(root: string, log: Log = () => {}) {
  const dir = join(root, 'data', 'audio');
  const model = join(root, 'voice', 'models', 'parakeet-tdt-0.6b-v3');
  mkdirSync(dir, { recursive: true });
  const rendering = new Map<string, Promise<string>>();

  /**
   * What the STT model hears in a rendered clip, or null when the STT fails (then the render is not judged). The
   * clip gets one second of silence at the end first: without it the model hears nothing in a short clip that ends
   * on its last word ("Understood." came back empty, padded it came back right).
   */
  async function hear(raw: string): Promise<{ text: string; confidence: number } | null> {
    const wav = `${raw}.check.wav`, json = `${raw}.json`;
    try {
      await sh('ffmpeg', ['-loglevel', 'error', '-y', '-i', raw, '-af', 'apad=pad_dur=1', '-ar', '16000', '-ac', '1', wav]);
      await sh(CLI, ['transcribe', wav, '--local-model-dir', model, '--output-json', json], 60_000);
      const r = JSON.parse(readFileSync(json, 'utf8'));
      return { text: String(r.text ?? '').trim(), confidence: Number(r.confidence ?? 0) };
    } catch (e) {
      log(`tts: check skipped, stt failed: ${e}`);
      return null;
    } finally { rmSync(json, { force: true }); rmSync(wav, { force: true }); }
  }

  return {
    dir,
    /**
     * Browser recording (webm/ogg/mp4/wav) in, transcript out. With `vad`, Silero checks the clip first and a
     * clip without speech comes back as `speech: false` with no STT run. If the VAD itself fails, the clip is
     * transcribed anyway (`vadError`), so a broken model never makes Jarvis deaf.
     */
    async stt(audio: Buffer, vad?: { threshold: number; minSpeechMs: number }): Promise<{ text: string; confidence: number; speech: boolean; vadError?: string }> {
      const id = randomUUID();
      const src = join(dir, `${id}.in`), wav = join(dir, `${id}.wav`), json = join(dir, `${id}.json`), voiced = join(dir, `${id}.vad.wav`);
      writeFileSync(src, audio);
      try {
        await sh('ffmpeg', ['-loglevel', 'error', '-y', '-i', src, '-ar', '16000', '-ac', '1', wav]);
        let vadError: string | undefined;
        if (vad) {
          // vad-analyze logs through os_log, not stdout; it writes the speech segments only when it found some.
          try {
            await sh(CLI, ['vad-analyze', wav, '--threshold', String(vad.threshold), '--min-speech-ms', String(vad.minSpeechMs), '--export-wav', voiced], 30_000);
            if (!existsSync(voiced)) return { text: '', confidence: 0, speech: false };
          } catch (e) { vadError = String(e); }
        }
        await sh(CLI, ['transcribe', wav, '--local-model-dir', model, '--output-json', json], 120_000);
        const r = JSON.parse(readFileSync(json, 'utf8'));
        return { text: String(r.text ?? '').trim(), confidence: Number(r.confidence ?? 0), speech: true, vadError };
      } finally {
        for (const f of [src, wav, json, voiced]) rmSync(f, { force: true });
      }
    },
    /**
     * One sentence in, the file name of an m4a clip in `dir` out. The name comes from the voice and the words, so a
     * replay reuses the clip and a replay asked for while the reply is still rendering waits for the same render.
     * The voice sometimes renders garbage of the right length ("The card is in the app." heard back as "As a year
     * arrived."), and the cache would keep it forever. So each render is transcribed before it is cached, and a
     * render that does not match its words is done again, up to RENDERS times. The best one is kept.
     */
    tts(text: string): Promise<string> {
      const lang = detectLang(text);
      const out = `${createHash('sha256').update(`${TTS[lang]}\n${text}`).digest('hex').slice(0, 32)}.m4a`;
      return onceAtATime(rendering, out, async () => {
        if (existsSync(join(dir, out))) return out;
        const [engine, voice] = TTS[lang].split(':');
        const id = randomUUID();
        const ext = engine === 'say' ? 'aiff' : 'wav';
        const raws: string[] = [], part = join(dir, `${id}.m4a`);
        try {
          let best = { raw: '', score: -1 };
          for (let n = 1; n <= RENDERS; n++) {
            const raw = join(dir, `${id}.${n}.${ext}`);
            raws.push(raw);
            if (engine === 'say') await sh('say', ['-v', voice, '-o', raw, text]);
            else await sh(CLI, ['tts', text, '--backend', engine, ...(voice ? ['--voice', voice] : []), '--lang', lang, '-o', raw], 120_000);
            // Under 3 words the STT model guesses ("C." heard as "See.", "Queued." as "Cute."), so it cannot judge.
            if ((text.match(/[\p{L}\p{N}]+/gu) ?? []).length < CHECK_WORDS) { best = { raw, score: 1 }; break; }
            const heard = await hear(raw);
            const score = heard ? speechMatch(text, heard.text) : 1;
            if (score > best.score) best = { raw, score };
            if (!heard || !badRender(score, heard.confidence)) { best = { raw, score: 1 }; break; }
            log('tts: render does not match its words', { out, try: n, score: +score.toFixed(2), confidence: heard?.confidence, text, heard: heard?.text });
          }
          if (best.score < MIN_MATCH) log('tts: kept the best of the bad renders', { out, score: +best.score.toFixed(2), text });
          await sh('ffmpeg', ['-loglevel', 'error', '-y', '-i', best.raw, '-c:a', 'aac', '-b:a', '64k', part]);
          renameSync(part, join(dir, out)); // a killed render never leaves a half clip under the real name
        } finally {
          for (const f of [...raws, part]) rmSync(f, { force: true });
        }
        return out;
      });
    },
  };
}

const FR_WORDS = new Set(['le', 'la', 'les', 'de', 'des', 'du', 'un', 'une', 'et', 'est', 'pas', 'je', 'tu', 'il', 'on', 'que', 'qui', 'pour', 'avec', 'dans', 'sur', 'ce', 'ça', 'oui', 'non', 'mais', 'ou', 'au', 'aux', 'en', 'envoyé', 'veux', 'peux', 'faut', 'bonjour', 'merci', 'salut', 'parfait', 'go', 'vas-y', 'voilà']);
const EN_WORDS = new Set(['the', 'a', 'an', 'and', 'is', 'are', 'not', 'i', 'you', 'it', 'that', 'for', 'with', 'in', 'on', 'this', 'yes', 'no', 'but', 'or', 'to', 'of', 'sent', 'should', 'want', 'can']);

/** Per-sentence language for TTS. French wins ties when the sentence has French accents. */
export function detectLang(s: string): 'fr' | 'en' {
  const words = s.toLowerCase().match(/[a-zàâçéèêëîïôûùüÿœ']+/g) ?? [];
  let fr = 0, en = 0;
  for (const w of words) { if (FR_WORDS.has(w)) fr++; if (EN_WORDS.has(w)) en++; }
  if (fr === en) return /[àâçéèêëîïôûùüÿœ]/i.test(s) ? 'fr' : 'en';
  return fr > en ? 'fr' : 'en';
}

/** Drops the markdown the chat renders so it is not read out: code blocks, header and list marks, emphasis, link syntax. */
function unmark(line: string): string {
  return line
    .replace(/^\s*(?:#{1,6}|>|[-*+]|\d{1,9}[.)])\s+/, '')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '$1')
    .replace(/[*`]+|(?<!\w)__?|__?(?!\w)/g, '');
}

/**
 * Says the dotted tokens a voice cannot read: an email becomes "name at host dot ca", a file or host name
 * "voice dot ts", a version "2026 dot 1027 dot 144". A decimal like 3.5 stays, the voice reads it.
 */
export function speakable(line: string): string {
  return line
    .replace(/([\p{L}\p{N}._%+-]+)@([\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+)/gu, '$1 at $2')
    .replace(/[\p{L}\p{N}]+(?:\.[\p{L}\p{N}]+)+/gu, tok => /^\d+\.\d+$/.test(tok) ? tok : tok.split('.').join(' dot '));
}

/**
 * Splits a reply into speakable sentences. A sentence ends only at . ! or ? followed by a space or the end of the
 * line, so a period inside an email, a version or a file name never cuts a clip. Lines that are only a URL are
 * shown, not spoken.
 */
export function sentences(text: string): string[] {
  return text
    .replace(/^\s*(```|~~~)[\s\S]*?(?:^\s*\1.*$|(?![\s\S]))/gm, '')
    .split(/\n+/)
    .map(unmark)
    .filter(line => !/^\s*https?:\/\/\S+\s*$/.test(line))
    .map(line => speakable(line.replace(/https?:\/\/\S+/g, 'the link')))
    .flatMap(line => line.split(/(?<=[.!?])\s+/))
    .map(s => s.trim())
    .filter(s => /[\p{L}\p{N}]/u.test(s));
}

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
/** 4686 as "four thousand six hundred eighty six", the way the STT model writes a number it heard. */
export function numberWords(n: number): string {
  if (n < 20) return ONES[n];
  if (n < 100) return `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ''}`;
  for (const [size, name] of [[1e9, 'billion'], [1e6, 'million'], [1e3, 'thousand'], [100, 'hundred']] as const)
    if (n >= size) return `${numberWords(Math.floor(n / size))} ${name}${n % size ? ` ${numberWords(n % size)}` : ''}`;
  return String(n);
}

/**
 * Lowercase letters only, accents removed, numbers spelled out and "and" dropped: what a transcript of the words
 * should spell, whether the STT model wrote "4686" or "four thousand six hundred and eighty six".
 */
const letters = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
  .replace(/(\d),(?=\d{3})/g, '$1')
  .replace(/\d{1,12}/g, d => ` ${numberWords(Number(d))} `)
  .replace(/\band\b/g, '')
  .replace(/[^a-z]/g, '');

/**
 * How much of `text` the transcript `heard` contains, 0 to 1: one minus the edit distance between the two letter
 * strings, divided by the longer length. A clean render scores near 1, the "alien sounds" renders score under 0.3.
 */
export function speechMatch(text: string, heard: string): number {
  const a = letters(text), b = letters(heard);
  if (!a.length && !b.length) return 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return 1 - prev[b.length] / Math.max(a.length, b.length);
}
