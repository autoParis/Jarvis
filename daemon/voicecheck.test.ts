// The render check in tts(), run against a fake fluidaudio CLI. Its own file: the CLI path is read when voice.ts loads.
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
const { makeVoice } = await import('./voice.ts');

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

test('a sentence under three words is not checked, because the STT model only guesses at it', async () => {
  const { voice, logs, renders } = voiceIn('See.', 9);
  await voice.tts('Got it.');
  assert.equal(renders(), 1);
  assert.deepEqual(logs, []);
});

test('after three bad renders the best one is kept and the miss is logged', async () => {
  const { voice, logs, renders } = voiceIn('The card is in the app.', 9);
  const name = await voice.tts('The card is in the app.');
  assert.equal(renders(), 3);
  assert.ok(existsSync(join(voice.dir, name)));
  assert.equal(logs.at(-1), 'tts: kept the best of the bad renders');
  assert.deepEqual(readdirSync(voice.dir), [name]);
});
