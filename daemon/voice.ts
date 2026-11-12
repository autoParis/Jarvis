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
  /** A worker's message in its pane: its row id and the line id from the pane read (chatLineAt in transcript.ts). */
  workerText: (rowId: string, lineId: string) => string | undefined;
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
  // One sentence of a worker's message in its pane. A pane line has no turn number: it is the row id and the line's
  // byte offset in the transcript (`f:<offset>`, daemon/transcript.ts), each URL-encoded.
  const said = /^\/api\/speech\/worker\/([^/]+)\/([^/]+)\/(\d+)$/.exec(url);
  if (said) {
    let row = '', line = '';
    try { row = decodeURIComponent(said[1]); line = decodeURIComponent(said[2]); } catch { /* a bad escape is a 404 */ }
    const s = spokenSentences((row && line && o.workerText(row, line)) || '')[Number(said[3])];
    if (!s) { notFound(res); return true; }
    const name = await o.voice.tts(s);
    o.speaker.noteSpoken(s);
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
