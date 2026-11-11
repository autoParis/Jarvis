import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A fake fluidaudio CLI: `tts` copies a short silent wav and counts the render, `transcribe` hears the words of
// $FAKE_HEARD, except for the first $FAKE_BAD renders, which it hears as garbage. Set before voice.ts loads.
const tmp = mkdtempSync(join(tmpdir(), 'voice-test-'));
const cli = join(tmp, 'fakecli');
execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono', '-t', '0.2', join(tmp, 'silence.wav')]);
writeFileSync(cli, `#!/bin/sh
cmd=$1; shift
n=$(cat "${tmp}/renders" 2>/dev/null || echo 0)
if [ "$cmd" = tts ]; then
  while [ $# -gt 0 ]; do [ "$1" = -o ] && out=$2; shift; done
  echo $((n + 1)) > "${tmp}/renders"; cp "${tmp}/silence.wav" "$out"
else
  while [ $# -gt 0 ]; do [ "$1" = --output-json ] && out=$2; shift; done
  if [ "$n" -le "\${FAKE_BAD:-0}" ]; then t="As a year arrived."; c=0.4; else t="$FAKE_HEARD"; c=0.9; fi
  printf '{"text": "%s", "confidence": %s}' "$t" "$c" > "$out"
fi
`);
chmodSync(cli, 0o755);
process.env.JARVIS_FLUIDAUDIO = cli;
const { sentences, speakable, speechMatch, numberWords, badRender, makeVoice, MIN_MATCH } = await import('./voice.ts');

test('a period inside an email does not end the sentence, and the email is said in words', () => {
  assert.deepEqual(sentences('His email is atremblay@dbmoto.ca. He works at DB Moto.'),
    ['His email is atremblay at dbmoto dot ca.', 'He works at DB Moto.']);
});

test('a dotted version stays one clip and is said with "dot"', () => {
  assert.deepEqual(sentences('It is version 2026.1027.144.21, so the fix is in. Done.'),
    ['It is version 2026 dot 1027 dot 144 dot 21, so the fix is in.', 'Done.']);
});

test('file names, host names and decimals stay inside their sentence', () => {
  assert.deepEqual(sentences('Edit voice.ts on jarvis.local now! It costs 3.5 dollars? Yes.'),
    ['Edit voice dot ts on jarvis dot local now!', 'It costs 3.5 dollars?', 'Yes.']);
});

test('a sentence ends at the end of a line with no space after it, and on . ! ? with a space', () => {
  assert.deepEqual(sentences('One. Two! Three?\nFour'), ['One.', 'Two!', 'Three?', 'Four']);
  assert.deepEqual(sentences('Wait... what?'), ['Wait...', 'what?']);
});

test('a quoted token keeps its sentence whole', () => {
  assert.deepEqual(sentences('Very short clips like "ca." or "144." come out as noise.'),
    ['Very short clips like "ca." or "144." come out as noise.']);
});

test('a URL is still "the link" and its dots never split the sentence', () => {
  assert.deepEqual(sentences('See https://x.y/a.b.c for it. Then go.'), ['See the link for it.', 'Then go.']);
});

test('speakable leaves plain words and single decimals alone', () => {
  assert.equal(speakable('Price is 3.5 and 10.25 today'), 'Price is 3.5 and 10.25 today');
  assert.equal(speakable('Write to a.b@c.d.com'), 'Write to a dot b at c dot d dot com');
});

test('speechMatch tells a clean render from the bad ones found in data/audio', () => {
  assert.equal(speechMatch('The card is in the app.', 'The card is in the app.'), 1);
  assert.ok(speechMatch('The customer is Claude-Alexandre Tremblay, a salesperson at DB Moto Châteauguay.',
    'The customer is Claude Alexander Tremblay, a salesperson at DB Modo Shekhtagway.') >= MIN_MATCH);
  for (const [text, heard] of [
    ['The card is in the app.', 'As a year arrived.'],
    ['Do I start a worker for both fixes?', 'Eh, look at the ring.'],
    ['The first fix is easy and sure.', 'Does that look over?'],
  ]) assert.ok(speechMatch(text, heard) < MIN_MATCH, heard);
});

test('a number the STT model spells out still matches its digits', () => {
  assert.equal(numberWords(4686), 'four thousand six hundred eighty six');
  assert.equal(numberWords(22000), 'twenty two thousand');
  assert.equal(speechMatch('Story 5341.', 'Story five thousand three hundred and forty one.'), 1);
  assert.equal(speechMatch('about 9,000 of my 22,000', 'about nine thousand of my twenty-two thousand'), 1);
  assert.equal(speechMatch('PR 4777 is ready.', 'PR 4,777 is ready.'), 1);
});

test('a bad render needs a low match and an unsure STT; an odd but sure transcript is kept', () => {
  assert.equal(badRender(speechMatch('The card is in the app.', 'As a year arrived.'), 0.64), true);
  assert.equal(badRender(speechMatch('Understood.', ''), 0.1), true, 'a silent render');
  assert.equal(badRender(speechMatch('EvalAuto #4507, Muse.', 'Avalatu hash four five zero seven Museum.'), 0.83), false);
  assert.equal(badRender(0.95, 0.3), false);
});

function voiceIn(heard: string, bad: number) {
  const root = mkdtempSync(join(tmp, 'root-'));
  writeFileSync(join(tmp, 'renders'), '0');
  process.env.FAKE_HEARD = heard;
  process.env.FAKE_BAD = String(bad);
  const logs: string[] = [];
  return { voice: makeVoice(root, msg => logs.push(msg)), logs, renders: () => Number(readFileSync(join(tmp, 'renders'), 'utf8')) };
}

test('a render that matches its words is cached after one try', async () => {
  const { voice, logs, renders } = voiceIn('The card is in the app.', 0);
  const name = await voice.tts('The card is in the app.');
  assert.ok(existsSync(join(voice.dir, name)));
  assert.equal(renders(), 1);
  assert.deepEqual(logs, []);
  assert.deepEqual(readdirSync(voice.dir), [name], 'no raw render is left behind');
});

test('a render that does not match is done again before it is cached', async () => {
  const { voice, logs, renders } = voiceIn('The card is in the app.', 1);
  await voice.tts('The card is in the app.');
  assert.equal(renders(), 2);
  assert.deepEqual(logs, ['tts: render does not match its words']);
});

test('after three bad renders the best one is kept and the miss is logged', async () => {
  const { voice, logs, renders } = voiceIn('The card is in the app.', 9);
  const name = await voice.tts('The card is in the app.');
  assert.equal(renders(), 3);
  assert.ok(existsSync(join(voice.dir, name)));
  assert.equal(logs.at(-1), 'tts: kept the best of the bad renders');
  assert.deepEqual(readdirSync(voice.dir), [name]);
});
