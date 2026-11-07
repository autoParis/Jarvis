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

export function makeVoice(root: string) {
  const dir = join(root, 'data', 'audio');
  const model = join(root, 'voice', 'models', 'parakeet-tdt-0.6b-v3');
  mkdirSync(dir, { recursive: true });
  const rendering = new Map<string, Promise<string>>();

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
     */
    tts(text: string): Promise<string> {
      const lang = detectLang(text);
      const out = `${createHash('sha256').update(`${TTS[lang]}\n${text}`).digest('hex').slice(0, 32)}.m4a`;
      return onceAtATime(rendering, out, async () => {
        if (existsSync(join(dir, out))) return out;
        const [engine, voice] = TTS[lang].split(':');
        const id = randomUUID();
        const raw = join(dir, `${id}.${engine === 'say' ? 'aiff' : 'wav'}`), part = join(dir, `${id}.m4a`);
        try {
          if (engine === 'say') await sh('say', ['-v', voice, '-o', raw, text]);
          else await sh(CLI, ['tts', text, '--backend', engine, ...(voice ? ['--voice', voice] : []), '--lang', lang, '-o', raw], 120_000);
          await sh('ffmpeg', ['-loglevel', 'error', '-y', '-i', raw, '-c:a', 'aac', '-b:a', '64k', part]);
          renameSync(part, join(dir, out)); // a killed render never leaves a half clip under the real name
        } finally {
          rmSync(raw, { force: true });
          rmSync(part, { force: true });
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

/** Splits a reply into speakable sentences. Lines that are only a URL are shown, not spoken. */
export function sentences(text: string): string[] {
  return text
    .replace(/^\s*(```|~~~)[\s\S]*?(?:^\s*\1.*$|(?![\s\S]))/gm, '')
    .split(/\n+/)
    .map(unmark)
    .filter(line => !/^\s*https?:\/\/\S+\s*$/.test(line))
    .map(line => line.replace(/https?:\/\/\S+/g, 'the link'))
    .flatMap(line => line.match(/[^.!?]+[.!?]*\s*/g) ?? [])
    .map(s => s.trim())
    .filter(s => /[\p{L}\p{N}]/u.test(s));
}
