import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, renameSync, readdirSync, statSync, createReadStream } from 'node:fs';
import type http from 'node:http';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { REPORT_MARKER } from './reports.ts';
import { judge, type ListenConfig } from './listen.ts';
import { pictureLines } from './uploads.ts';
import { replyIdOf } from './quote.ts';
import { voiceMessage, withPictures } from '../web/dictate.js';
import type { Log } from './log.ts';
import type { RouteResult } from './route.ts';

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

// `[image: /abs/path.png]` and `[report: /abs/path.md]` markers show a picture or a card in the chat and are never read aloud.
export const IMAGE_MARKER = /\[image:\s*[^\]\n]+\]/g;
export const unmarked = (text: string) => text.replace(IMAGE_MARKER, ' ').replace(REPORT_MARKER, ' ');
export const spokenSentences = (text: string) => sentences(unmarked(text));

/**
 * Jarvis's voice out. Speech goes out one sentence at a time, in order across replies, so the first sentence plays while
 * the rest render. It keeps what Jarvis said lately, for hands-free listening: the wake word's follow-up window and the
 * echo guard.
 */
export function makeSpeaker(o: { tts: (s: string) => Promise<string>; broadcast: (ev: object) => void; log: Log; windowMs: number }) {
  let speech = Promise.resolve();
  let lastSpokeAt = 0, lastAddressedAt = 0;
  let spoken: { at: number; text: string }[] = [];
  function noteSpoken(s: string) {
    lastSpokeAt = Date.now();
    spoken = [...spoken.filter(x => lastSpokeAt - x.at <= o.windowMs), { at: lastSpokeAt, text: s }];
  }
  return {
    noteSpoken,
    speak(text: string, turnId: number) {
      const list = spokenSentences(text);
      list.forEach((s, i) => {
        speech = speech.then(async () => {
          try {
            await o.tts(s);
            o.broadcast({ type: 'audio', turnId, i, total: list.length });
            noteSpoken(s);
          }
          catch (e) { o.log(`tts: ${e}`); }
        });
      });
    },
    /** What the listen judge needs at `now`. */
    heard(now: number) {
      return { lastSpokeAt, lastAddressedAt, recentSpoken: spoken.filter(x => now - x.at <= o.windowMs).map(x => x.text) };
    },
    /** A kept hands-free clip: the owner spoke to Jarvis at `now`. */
    addressed(now: number) { lastAddressedAt = now; },
  };
}
export type Speaker = ReturnType<typeof makeSpeaker>;

/** An audio file, with byte ranges: a resume seeks into the clip, and Safari refuses media without them. */
export function sendClip(req: http.IncomingMessage, res: http.ServerResponse, file: string) {
  const size = statSync(file).size, range = byteRange(req.headers.range, size);
  const head = { 'content-type': 'audio/mp4', 'accept-ranges': 'bytes' };
  if (range === 'bad') { res.writeHead(416, { 'content-range': `bytes */${size}` }); return res.end(); }
  if (!range) { res.writeHead(200, { ...head, 'content-length': size }); return createReadStream(file).pipe(res); }
  res.writeHead(206, { ...head, 'content-range': `bytes ${range.start}-${range.end}/${size}`, 'content-length': range.end - range.start + 1 });
  return createReadStream(file, range).pipe(res);
}

/** The same empty 404 main.ts sends. */
function notFound(res: http.ServerResponse) {
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end('');
}

export type VoiceFileCtx = {
  voice: { dir: string; tts: (s: string) => Promise<string> };
  speaker: Pick<Speaker, 'noteSpoken'>;
  /** A stored Jarvis message's text, by turn id. */
  jarvisText: (turnId: number) => string | undefined;
  /** data/bakeoff: voice samples for picking the TTS model by ear. */
  bakeoffDir: string;
};

/**
 * The voice routes that stream a file: rendered clips, one sentence of a stored message, and the TTS bake-off page.
 * Returns true when it answered the request.
 */
export async function voiceFileRoute(o: VoiceFileCtx, req: http.IncomingMessage, res: http.ServerResponse, url: string): Promise<boolean> {
  if (req.method !== 'GET') return false;
  if (/^\/audio\/[\w-]+\.m4a$/.test(url)) {
    const file = join(o.voice.dir, url.slice('/audio/'.length));
    if (!existsSync(file)) { notFound(res); return true; }
    sendClip(req, res, file);
    return true;
  }
  // One sentence of a message from Jarvis, rendered on first request. The speaker button under the message plays these.
  const clip = /^\/api\/speech\/(\d+)\/(\d+)$/.exec(url);
  if (clip) {
    const s = spokenSentences(o.jarvisText(Number(clip[1])) ?? '')[Number(clip[2])];
    if (!s) { notFound(res); return true; }
    const name = await o.voice.tts(s);
    o.speaker.noteSpoken(s); // the echo guard must know these words too, or the open mic takes a replay for the owner
    sendClip(req, res, join(o.voice.dir, name));
    return true;
  }
  if (url === '/bakeoff') {
    const files = existsSync(o.bakeoffDir) ? readdirSync(o.bakeoffDir).filter(f => f.endsWith('.m4a')).sort() : [];
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><meta name="viewport" content="width=device-width"><body style="font:16px system-ui;padding:12px">
        <h3>TTS bake-off</h3>${files.map(f => `<p>${f}<br><audio controls preload="none" src="/bakeoff/${f}"></audio></p>`).join('')}`);
    return true;
  }
  if (/^\/bakeoff\/[\w.-]+\.m4a$/.test(url)) {
    const file = join(o.bakeoffDir, url.slice('/bakeoff/'.length));
    if (!existsSync(file)) { notFound(res); return true; }
    res.writeHead(200, { 'content-type': 'audio/mp4' });
    createReadStream(file).pipe(res);
    return true;
  }
  return false;
}

type Stt = (audio: Buffer, vad?: { threshold: number; minSpeechMs: number }) => Promise<{ text: string; confidence: number; speech: boolean; vadError?: string }>;

export type VoiceCtx = {
  voice: { stt: Stt };
  listen: ListenConfig;
  speaker: Pick<Speaker, 'heard' | 'addressed'>;
  log: Log;
  /** The owner's message, as if typed. `replyTo` is the turn he answers. */
  fromOwner: (text: string, replyTo?: number) => void;
  /** The owner's message to a native worker, by row id, as the pane's box sends it (steerWorker in workroutes.ts). */
  toWorker: (id: string, text: string) => Promise<RouteResult>;
  /** The folder /api/upload saves pictures in. Only pictures from it go with the words. */
  uploads: string;
  today: { list: () => unknown; add: (b: { words: string; go: boolean }) => RouteResult };
};

/**
 * The voice routes that answer JSON: the hands-free detector settings, a clip from the chat microphone or hands-free
 * listening, and the Today popup's microphone. `raw` reads the request body as bytes, up to a limit.
 */
export async function voiceRoute(o: VoiceCtx, method: string, url: string, raw: (limit: number) => Promise<Buffer>, query: URLSearchParams): Promise<RouteResult | undefined> {
  // Hands-free: the browser's detector settings (env overrides of web/listen.js DEFAULTS).
  if (method === 'GET' && url === '/api/listen/config') return { status: 200, body: { client: o.listen.client, wakeWord: o.listen.wakeWords.length > 0 } };
  if (method === 'POST' && url === '/api/voice') {
    const audio = await raw(20e6);
    const q = query, listen = o.listen, log = o.log;
    const hands = q.get('mode') === 'listen', bargeIn = q.get('barge') === '1';
    // The pictures attached in the chat box go with the words (web/compose.js). Only files /api/upload saved pass.
    const pics = pictureLines(q.getAll('image'), o.uploads);
    if (pics.refused.length) log('voice: picture refused, not an upload', { paths: pics.refused });
    const t0 = Date.now();
    const r = await o.voice.stt(audio, hands ? { threshold: listen.vadThreshold, minSpeechMs: listen.vadMinSpeechMs } : undefined);
    if (r.vadError) log(`listen: vad failed, transcribing anyway: ${r.vadError}`);
    if (!hands) {
      const target = q.get('target');
      log(`stt ${Date.now() - t0} ms conf=${r.confidence.toFixed(2)}${pics.lines.length ? ` pictures=${pics.lines.length}` : ''}${target ? ` to ${target}` : ''}: ${r.text}`);
      // Text the owner typed before he tapped the mic goes in front of the words, and the pictures after them, as one
      // message (web/dictate.js).
      const message = voiceMessage(q.get('typed'), r.text, pics.lines);
      // `target` is a worker's row id: the mic in its pane. The message goes to that worker, not to the brain.
      if (target) {
        if (!message) return { status: 200, body: { text: r.text, confidence: r.confidence, sent: false } };
        const s = await o.toWorker(target, message);
        if (s.status !== 200) return { status: s.status, body: { ...(s.body as object), text: r.text } };
        return { status: 200, body: { text: r.text, confidence: r.confidence, sent: true, message } };
      }
      if (message) o.fromOwner(message, replyIdOf(q.get('replyTo')));
      return { status: 200, body: { text: r.text, confidence: r.confidence, sent: !!message } };
    }
    if (!r.speech) { log(`listen: no speech (${Date.now() - t0} ms, ${audio.length} bytes)`); return { status: 200, body: { text: '', kept: false, why: 'no speech' } }; }
    const now = Date.now();
    const v = judge({ text: r.text, bargeIn, now, ...o.speaker.heard(now) }, listen);
    // A dropped clip is often someone else talking; its words stay out of the log unless JARVIS_LISTEN_DEBUG=1.
    log(`listen ${Date.now() - t0} ms conf=${r.confidence.toFixed(2)} ${v.keep ? 'kept' : 'dropped'} (${v.why})${bargeIn ? ' barge-in' : ''}: ${v.keep || listen.debug ? r.text : `${r.text.split(/\s+/).filter(Boolean).length} words`}`);
    if (!v.keep) return { status: 200, body: { text: '', kept: false, why: v.why } };
    o.speaker.addressed(now);
    o.fromOwner(withPictures(r.text, pics.lines));
    return { status: 200, body: { text: r.text, confidence: r.confidence, kept: true, why: v.why } };
  }
  // The microphone in the Today popup: the words become one item, and nothing goes to the chat.
  if (method === 'POST' && url === '/api/today/voice') {
    const audio = await raw(20e6);
    const r = await o.voice.stt(audio);
    o.log(`today voice conf=${r.confidence.toFixed(2)}: ${r.text}`);
    if (!r.text) return { status: 200, body: { words: '', today: o.today.list() } };
    const added = o.today.add({ words: r.text, go: query.get('go') === '1' });
    return { status: added.status, body: { words: r.text, ...added.body } };
  }
  return undefined;
}
