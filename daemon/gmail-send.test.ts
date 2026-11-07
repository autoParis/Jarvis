import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// A stand-in `gws` on PATH, set before gate.ts copies the environment.
// It answers the signature read (users.settings.sendAs) itself, so `out` stays the send's answer.
const SETTINGS = `if [ "$3" = settings ]; then echo '{"sendAs":[{"sendAsEmail":"owner@example.test","isDefault":true,"signature":"<b>the owner</b>"}]}'; exit 0; fi\n`;
const dir = mkdtempSync(join(tmpdir(), 'jarvis-gws-'));
const calls = join(dir, 'calls'), out = join(dir, 'out');
writeFileSync(join(dir, 'gws'), `#!/bin/bash\n${SETTINGS}echo "$1 $2 $3 $4 $5" >> "${calls}"\ncat "${out}"\n`);
chmodSync(join(dir, 'gws'), 0o755);
process.env.PATH = `${dir}:${process.env.PATH}`;
const sends = () => existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').filter(l => l.includes('messages send')).length : 0;

const { openStore } = await import('./store.ts');
const { makeGate } = await import('./gate.ts');
const id = { run: 'run_x', handle: 'term_x' };

function storeWithEmail() {
  const s = openStore(':memory:');
  s.setState('gmail_self', 'owner@example.test');
  const meta = { gmailId: 'a', threadId: 't_a', from: 'teammate@example.test', replyTo: 'teammate@example.test', subject: 'Déploiement', messageId: '<a@mail>', references: '',
    to: ['owner@example.test', 'colleague@example.test'], cc: ['Teammate@example.test', 'jdoe@dealer-a.test'], reply: 'Ok' };
  s.insertItem({ source: 'gmail', external_id: 'gmail:a', kind: 'email', subject: 'Déploiement', meta: JSON.stringify(meta), status: 'spoken' });
  return s;
}

test('the Approve button sends once, records the Gmail id, marks the email answered, and refuses a second send', async () => {
  const s = storeWithEmail();
  const lines: string[] = [];
  const gate = makeGate(s, id, () => {}, (m, f) => lines.push(`${m} ${JSON.stringify(f)}`));
  writeFileSync(out, JSON.stringify({ id: 'sent_1', threadId: 't_a', labelIds: ['SENT'] }));
  const p = await gate.propose('gmail-send', { item: 'gmail:a', text: 'Ok, go.\nOwner' }, 'Send the reply to Sam?');
  const a = await gate.button(p.id, true);
  assert.equal(a.status, 'done');
  assert.deepEqual(JSON.parse(a.result!), { gmailId: 'sent_1', threadId: 't_a' });
  assert.equal(s.item('gmail:a')!.status, 'answered');
  assert.equal(s.item('gmail:a')!.answer, 'Ok, go.');
  assert.equal(sends(), 1);
  assert.deepEqual([JSON.parse(p.args).to, JSON.parse(p.args).cc], ['teammate@example.test', 'colleague@example.test, jdoe@dealer-a.test']);
  assert.match(lines.join('\n'), /gate done .*"approval":1,"action":"gmail-send".*"item":"gmail:a"/);
  await assert.rejects(gate.propose('gmail-send', { item: 'gmail:a', text: 'Ok, go now.\nOwner' }, 'Send again?'), /already done/);
  assert.equal(sends(), 1);
});

test('a send with no answer from gws is unknown, never retried, and blocks another send', async () => {
  const s = storeWithEmail();
  const gate = makeGate(s, id, () => {});
  writeFileSync(out, '');
  const p = await gate.propose('gmail-send', { item: 'gmail:a', text: 'Ok.\nOwner' }, 'Send?');
  const a = await gate.button(p.id, true);
  assert.equal(a.status, 'unknown');
  await assert.rejects(gate.propose('gmail-send', { item: 'gmail:a', text: 'Ok!\nOwner' }, 'Send?'), /already unknown/);
});

test('Gmail refusing the send is a failure and the email stays open', async () => {
  const s = storeWithEmail();
  const gate = makeGate(s, id, () => {});
  writeFileSync(out, JSON.stringify({ error: { code: 400, message: 'Invalid To header' } }));
  const p = await gate.propose('gmail-send', { item: 'gmail:a', text: 'Ok.\nOwner' }, 'Send?');
  const a = await gate.button(p.id, true);
  assert.equal(a.status, 'failed');
  assert.match(a.result!, /error 400: Invalid To header/);
  assert.equal(s.item('gmail:a')!.status, 'spoken');
});

test('the sent message is a reply all: the sender in To, everyone else in Cc, never the owner', async () => {
  const s = storeWithEmail();
  const gate = makeGate(s, id, () => {});
  writeFileSync(join(dir, 'gws'), `#!/bin/bash\n${SETTINGS}printf '%s\\n' "$@" > "${join(dir, 'argv')}"\ncat "${out}"\n`);
  writeFileSync(out, JSON.stringify({ id: 'sent_2', threadId: 't_a' }));
  const p = await gate.propose('gmail-send', { item: 'gmail:a', to: 'outsider@evil.test', cc: 'x@evil.test', text: 'Ok.\nOwner' }, 'Send?');
  assert.equal((await gate.button(p.id, true)).status, 'done');
  const argv = readFileSync(join(dir, 'argv'), 'utf8').split('\n');
  const raw = Buffer.from(JSON.parse(argv[argv.indexOf('--json') + 1]).raw, 'base64url').toString();
  assert.match(raw, /^To: teammate@example.test\r\nCc: colleague@example.test, jdoe@dealer-a.test\r\nSubject: /);
  assert.doesNotMatch(raw, /owner@|evil\.com/);
});

/** The decoded text/plain and text/html parts of a raw message. */
function parts(raw: string) {
  const out: Record<string, string> = {};
  for (const part of raw.split(/\r\n--jarvis_[^\r\n]*/).slice(1)) {
    const type = /Content-Type: text\/(plain|html)/.exec(part)?.[1];
    if (type) out[type] = Buffer.from(part.split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString();
  }
  return out;
}

test('the sent reply ends with the Gmail signature, as HTML, once, with no "The owner" line above it', async () => {
  const s = storeWithEmail();
  const gate = makeGate(s, id, () => {});
  writeFileSync(join(dir, 'gws'), `#!/bin/bash\n${SETTINGS}printf '%s\\n' "$@" > "${join(dir, 'argv')}"\ncat "${out}"\n`);
  writeFileSync(out, JSON.stringify({ id: 'sent_3', threadId: 't_a' }));
  const p = await gate.propose('gmail-send', { item: 'gmail:a', text: 'Ok, go.\n\nMerci,\nOwner\n' }, 'Send?');
  assert.equal(JSON.parse(p.args).text, 'Ok, go.\n\nMerci,');
  assert.equal((await gate.button(p.id, true)).status, 'done');
  const argv = readFileSync(join(dir, 'argv'), 'utf8').split('\n');
  const raw = Buffer.from(JSON.parse(argv[argv.indexOf('--json') + 1]).raw, 'base64url').toString();
  assert.match(raw, /Content-Type: multipart\/alternative; boundary="jarvis_/);
  const { plain, html } = parts(raw);
  assert.equal(plain, 'Ok, go.\r\n\r\nMerci,\r\n\r\n-- \r\nthe owner');
  assert.equal(html, '<div dir="ltr">Ok, go.<br><br>Merci,<br clear="all"><div><br></div><div dir="ltr" class="gmail_signature" data-smartmail="gmail_signature"><b>the owner</b></div></div>');
  assert.equal(html.match(/the owner/g)!.length, 1);
});

test('when Gmail does not return the signature, nothing is sent and the email stays open', async () => {
  const s = storeWithEmail();
  const lines: string[] = [];
  const gate = makeGate(s, id, () => {}, m => lines.push(m));
  writeFileSync(join(dir, 'gws'), `#!/bin/bash\necho "$1 $2 $3 $4 $5" >> "${calls}"\nif [ "$3" = settings ]; then echo '{"error":{"code":403,"message":"insufficient scope"}}'; exit 0; fi\ncat "${out}"\n`);
  writeFileSync(out, JSON.stringify({ id: 'sent_4', threadId: 't_a' }));
  const before = sends();
  const p = await gate.propose('gmail-send', { item: 'gmail:a', text: 'Ok.' }, 'Send?');
  const a = await gate.button(p.id, true);
  assert.equal(a.status, 'failed');
  assert.match(a.result!, /Not sent: I could not read your Gmail signature.*insufficient scope/);
  assert.equal(sends(), before);
  assert.equal(s.item('gmail:a')!.status, 'spoken');
  assert.match(lines.join('\n'), /gate refused at run time/);
});
