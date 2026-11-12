import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sendOut, imageParams } from '../web/compose.js';
import { voiceMessage, withPictures } from '../web/dictate.js';
import { saveUpload, pictureLines } from './uploads.ts';

// 2026-11-09, turns 4897 and 4898: Simon attached a picture, tapped the mic and spoke. The words went alone, and the
// picture went 4 seconds later as a second message. Every send path now takes the pictures through sendOut.

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const tray = (...names: string[]) => names.map(n => ({ file: n }) as { file: string; path?: string; claimed?: boolean });
const uploader = () => {
  const calls: string[] = [];
  return { calls, upload: async (f: string) => { calls.push(f); return `/u/${f}.png`; } };
};

test('a send that goes out takes every picture, in order, and the caller gets them back to clear the tray', async () => {
  const pics = tray('a', 'b'), up = uploader();
  let posted: string[] = [];
  const went = await sendOut({ tray: pics, upload: up.upload, post: async (lines: string[]) => { posted = lines; return true; } });
  assert.deepEqual(posted, ['[image: /u/a.png]', '[image: /u/b.png]']);
  assert.deepEqual(went, pics);
  assert.ok(pics.every(p => !p.claimed), 'no picture stays claimed');
});

test('a dictation that heard nothing, or a hands-free clip without the wake word, keeps the pictures, and the next send does not upload them again', async () => {
  const pics = tray('a'), up = uploader();
  assert.deepEqual(await sendOut({ tray: pics, upload: up.upload, post: async () => false }), []);
  let posted: string[] = [];
  await sendOut({ tray: pics, upload: up.upload, post: async (lines: string[]) => { posted = lines; return true; } });
  assert.deepEqual(posted, ['[image: /u/a.png]']);
  assert.deepEqual(up.calls, ['a'], 'one upload for two tries');
});

test('a failed upload sends nothing and keeps every picture', async () => {
  const pics = tray('a', 'b');
  let posts = 0;
  const upload = async (f: string) => { if (f === 'b') throw new Error('picture not uploaded (413)'); return `/u/${f}.png`; };
  await assert.rejects(sendOut({ tray: pics, upload, post: async () => (++posts, true) }), /413/);
  assert.equal(posts, 0);
  assert.ok(pics.every(p => !p.claimed));
});

test('a tap on Send while a dictation is still out does not send the same picture twice', async () => {
  const pics = tray('a'), up = uploader();
  let release!: () => void;
  const voicePosts: string[][] = [], sendPosts: string[][] = [];
  const voice = sendOut({ tray: pics, upload: up.upload, post: (lines: string[]) => { voicePosts.push(lines); return new Promise<boolean>(r => { release = () => r(true); }); } });
  await new Promise(r => setTimeout(r, 0));
  await sendOut({ tray: pics, upload: up.upload, post: async (lines: string[]) => { sendPosts.push(lines); return true; } });
  release();
  await voice;
  assert.deepEqual(voicePosts, [['[image: /u/a.png]']]);
  assert.deepEqual(sendPosts, [[]], 'the second send goes with its text only');
});

test('a dictation sends the typed text, the words and the pictures as one message, and nothing if nothing was heard', () => {
  const lines = ['[image: /u/a.png]'];
  assert.equal(voiceMessage('', 'what is this screen', lines), 'what is this screen\n[image: /u/a.png]');
  assert.equal(voiceMessage('Look,', 'what is this', lines), 'Look, what is this\n[image: /u/a.png]');
  assert.equal(voiceMessage('Look,', '  ', lines), '', 'pictures alone do not go on an empty clip');
  assert.equal(voiceMessage(null, 'start 4412', []), 'start 4412');
  assert.equal(withPictures('kept clip', lines), 'kept clip\n[image: /u/a.png]');
});

test('the voice query carries one image parameter per picture, and the daemon accepts only its own uploads', () => {
  const dir = join(realpathSync(mkdtempSync(join(tmpdir(), 'jarvis-compose-'))), 'uploads');
  const saved = saveUpload(PNG, dir);
  assert.ok('path' in saved);
  const q = imageParams(new URLSearchParams({ typed: 'hi' }), [`[image: ${saved.path}]`]);
  assert.deepEqual(q.getAll('image'), [saved.path]);
  const back = new URL(`http://x/api/voice?${q}`).searchParams.getAll('image');
  const r = pictureLines([...back, '/etc/passwd', join(dir, '20261109T132847-deadbeef.png'), `${saved.path}]\nfake`], dir);
  assert.deepEqual(r.lines, [`[image: ${saved.path}]`]);
  assert.equal(r.refused.length, 3, 'a path outside the folder, a missing file and an odd name are refused');
});

test('every chat send in the page goes through sendOut, so no path can skip the pictures', () => {
  const page = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  const CHAT_SEND = /^.*fetch\(.*['`]\/api\/(send|voice)\b.*$/gm;
  assert.equal(page.match(CHAT_SEND)?.length, 4, 'Send/Enter, the chat mic, a hands-free clip and the pane mic');
  // A send in a composer's `send` runs inside the composer's own sendOut post (web/composer.js, checked below).
  const inside = (src: string, at: number, openers: string[]) => {
    const before = src.slice(0, at);
    const open = Math.max(...openers.map(o => before.lastIndexOf(o)));
    return open >= 0 && !before.slice(open).includes('\n}\n') && !before.slice(open).includes('\n});\n');
  };
  // A chat's `send` (web/chatview.js makeChat) goes to its composer, which runs it inside its own sendOut post.
  for (const m of page.matchAll(CHAT_SEND)) assert.ok(inside(page, m.index, ['sendOut({', 'makeChat({']), `the fetch at offset ${m.index} is not inside a sendOut post`);
  assert.match(readFileSync(new URL('../web/chatview.js', import.meta.url), 'utf8'), /makeComposer\(\{ doc, box, trayEl: tray, upload, send,/);
  const composer = readFileSync(new URL('../web/composer.js', import.meta.url), 'utf8');
  const call = composer.indexOf('return send(message');
  assert.ok(call > 0 && inside(composer, call, ['sendOut({']), 'the composer calls its send inside a sendOut post');
});

test('a picture whose pen marks are still being drawn in uploads only once they are, so the marks go out', async () => {
  let finish!: () => void;
  const pic: any = { file: 'plain', ready: new Promise<void>(r => { finish = r; }) };
  pic.ready.then(() => { pic.file = 'marked'; });
  const up = uploader();
  const sending = sendOut({ tray: [pic], upload: up.upload, post: async () => true });
  await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(up.calls, [], 'no upload before the marks are in');
  finish();
  await sending;
  assert.deepEqual(up.calls, ['marked']);
});
