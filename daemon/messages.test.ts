import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// A stand-in `gws` on PATH, set before gate.ts copies the environment.
// It answers the signature read (users.settings.sendAs) itself, so `out` stays the send's answer.
const SETTINGS = `if [ "$3" = settings ]; then echo '{"sendAs":[{"sendAsEmail":"owner@example.test","isDefault":true,"signature":"<b>the owner</b>"}]}'; exit 0; fi\n`;
const dir = mkdtempSync(join(tmpdir(), 'jarvis-msg-'));
const calls = join(dir, 'calls'), out = join(dir, 'out');
writeFileSync(join(dir, 'gws'), `#!/bin/bash\n${SETTINGS}echo "$1 $2 $3 $4 $5" >> "${calls}"\ncat "${out}"\n`);
chmodSync(join(dir, 'gws'), 0o755);
process.env.PATH = `${dir}:${process.env.PATH}`;
const sends = () => existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').filter(l => l.includes('messages send')).length : 0;

const { openStore } = await import('./store.ts');
const { makeGate } = await import('./gate.ts');
const { makeMessages, messageCard, messageOrder, emailPush, outboxLine } = await import('./messages.ts');
const { makeCheck } = await import('./check.ts');
const { messageButton, messageHeadHtml, messageControls, otherMessagesLabel } = await import('../web/messages.js');
const { swipeAction } = await import('../web/swipe.js');
const { auditEntries } = await import('./asks.ts');
const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

const mailMeta = (id: string, urgent = false) => ({ gmailId: id, threadId: `t_${id}`, from: `${id}@x.test`, fromName: `Sender ${id}`, replyTo: `${id}@x.test`, subject: `Subject ${id}`, messageId: `<${id}@mail>`, references: '', lang: 'fr', urgent, needsReply: true, reply: `Draft ${id}`, to: ['owner@example.test'], cc: [] });
function setup(mails: [string, boolean?][] = [['a']]) {
  const s = openStore(':memory:');
  s.setState('gmail_self', 'owner@example.test');
  for (const [id, urgent] of mails) s.insertItem({ source: 'gmail', external_id: `gmail:${id}`, kind: 'email', subject: `Subject ${id}`, body: `Summary ${id}`, meta: JSON.stringify(mailMeta(id, urgent)), status: 'spoken' });
  let changes = 0;
  const seen: any[] = [];
  const gate = makeGate(s, a => { seen.push(a); });
  const m = makeMessages({ store: s, gate, log: () => {}, onChange: () => { changes++; } });
  return { s, gate, m, seen, changes: () => changes };
}
const sent = () => writeFileSync(out, JSON.stringify({ id: 'sent_1', threadId: 't_a', labelIds: ['SENT'] }));

test('the list holds open emails, urgent first, with sender, subject, summary, draft and a Gmail link', () => {
  const { m } = setup([['a'], ['b', true]]);
  const list = m.list();
  assert.deepEqual(list.map(x => x.id), ['gmail:b', 'gmail:a']);
  assert.equal(list[0].urgent, true);
  assert.equal(list[0].from, 'Sender b');
  assert.equal(list[0].subject, 'Subject b');
  assert.equal(list[0].summary, 'Summary b');
  assert.equal(list[0].draft, 'Draft b');
  assert.equal(list[0].openLabel, 'Open in Gmail');
  assert.match(list[0].openUrl, /^https:\/\/mail\.google\.com\/mail\/\?authuser=[^#]+#all\/t_b$/);
});

test('an email stays open past the 3 days of the brain\'s brief', () => {
  const { m } = setup();
  const old = openStore(':memory:');
  old.insertItem({ source: 'gmail', external_id: 'gmail:o', kind: 'email', subject: 'Old', body: '', meta: JSON.stringify(mailMeta('o')), status: 'spoken' });
  assert.equal(old.openEmails(3).length, 1);
  assert.equal(old.openEmails(0).length, 0, 'a window of 0 days leaves it out, so the window is applied');
  assert.equal(old.openEmails(null).length, 1);
  assert.equal(m.list().length, 1);
});

test('Send reply sends the edited words once, in one Approve, and the email and its button go', async () => {
  const { s, m, seen } = setup();
  sent();
  const before = sends();
  const r = await m.send('gmail:a', '  Changed words.\nOwner ');
  assert.equal(r.status, 200);
  assert.equal(r.body.approval!.status, 'done');
  assert.equal(r.body.approval!.decided_by, 'button');
  assert.equal(JSON.parse(r.body.approval!.args).text, 'Changed words.');
  assert.equal(JSON.parse(r.body.approval!.args).to, 'a@x.test');
  assert.equal(sends(), before + 1);
  assert.equal(s.item('gmail:a')!.status, 'answered');
  assert.deepEqual(r.body.messages, []);
  assert.ok(seen.every(a => a.action === 'gmail-send'));
  assert.equal(s.pendingApprovals().length, 0, 'nothing is left waiting in Requests');
  const again = await m.send('gmail:a', 'Again');
  assert.equal(again.status, 409);
  assert.equal(sends(), before + 1);
});

test('a refused send keeps the email open and can be sent again', async () => {
  const { s, m } = setup();
  writeFileSync(out, JSON.stringify({ error: { code: 403, message: 'no' } }));
  const r = await m.send('gmail:a', 'Words');
  assert.equal(r.status, 502);
  assert.match(r.body.error!, /no/);
  assert.equal(r.body.messages.length, 1);
  assert.equal(s.item('gmail:a')!.status, 'spoken');
  sent();
  assert.equal((await m.send('gmail:a', 'Words')).status, 200);
  assert.equal(s.item('gmail:a')!.status, 'answered');
});

test('an unknown outcome closes the email and never allows a second send', async () => {
  const { s, m } = setup();
  writeFileSync(out, 'not json');
  const before = sends();
  const r = await m.send('gmail:a', 'Words');
  assert.equal(r.status, 200);
  assert.equal(r.body.approval!.status, 'unknown');
  assert.equal(s.item('gmail:a')!.status, 'answered');
  assert.equal((await m.send('gmail:a', 'Words')).status, 409);
  assert.equal(sends(), before + 1);
});

test('two presses at once send one reply', async () => {
  const { m } = setup();
  sent();
  const before = sends();
  const [x, y] = await Promise.all([m.send('gmail:a', 'Words'), m.send('gmail:a', 'Words')]);
  assert.deepEqual([x.status, y.status].sort(), [200, 409]);
  assert.equal(sends(), before + 1);
});

test('empty words, an unknown id and another source are refused without sending', async () => {
  const { s, m } = setup();
  const before = sends();
  assert.equal((await m.send('gmail:a', '   ')).status, 400);
  assert.equal((await m.send('gmail:zzz', 'hi')).status, 404);
  s.insertItem({ source: 'native', external_id: 'm_1', kind: 'question', subject: 'q', status: 'spoken' });
  assert.equal((await m.send('m_1', 'hi')).status, 404);
  assert.equal(m.handled('m_1').status, 404);
  assert.equal(sends(), before);
});

test("I'll handle it closes the email like jarvis-act email-done, and nothing is sent", () => {
  const { s, m, changes } = setup();
  const before = sends();
  const r = m.handled('gmail:a');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.messages, []);
  assert.equal(s.item('gmail:a')!.status, 'answered');
  assert.equal(s.item('gmail:a')!.answer, 'left to the owner');
  assert.equal(s.openEmails().length, 0);
  assert.equal(changes(), 1);
  assert.equal(sends(), before);
  assert.equal(m.handled('gmail:a').status, 409);
});

test('a reply the brain proposed becomes the draft, and Send reply takes the place of that card', async () => {
  const { s, gate, m } = setup();
  const p = await gate.propose('gmail-send', { item: 'gmail:a', text: 'What the owner dictated' }, 'Send it?');
  assert.equal(m.list()[0].draft, 'What the owner dictated');
  sent();
  const r = await m.send('gmail:a', 'What the owner dictated, then edited');
  assert.equal(r.status, 200);
  assert.equal(s.approval(p.id)!.status, 'rejected');
  assert.equal(s.approval(p.id)!.decided_by, 'automatic');
  assert.equal(s.pendingApprovals().length, 0);
  const audit = auditEntries(s, () => undefined, new Set(), 10);
  assert.equal(audit.length, 1, 'the superseded card is not in the audit log');
});

test('Send reply with the proposed words approves that same proposal', async () => {
  const { s, gate, m } = setup();
  const p = await gate.propose('gmail-send', { item: 'gmail:a', text: 'Same words' }, 'Send it?');
  sent();
  const r = await m.send('gmail:a', 'Same words');
  assert.equal(r.body.approval!.id, p.id);
  assert.equal(s.approval(p.id)!.status, 'done');
});

test("I'll handle it retires a proposal, and a proposal keeps a filed email listed", async () => {
  const { s, gate, m } = setup();
  s.insertItem({ source: 'gmail', external_id: 'gmail:f', kind: 'email', subject: 'Filed', body: '', meta: JSON.stringify(mailMeta('f')), status: 'done' });
  assert.equal(m.list().length, 1);
  const p = await gate.propose('gmail-send', { item: 'gmail:f', text: 'Reply anyway' }, 'Send it?');
  assert.deepEqual(m.list().map(x => x.id), ['gmail:a', 'gmail:f']);
  assert.equal(m.handled('gmail:f').status, 200);
  assert.equal(s.approval(p.id)!.status, 'rejected');
  assert.deepEqual(m.list().map(x => x.id), ['gmail:a']);
});

test('the urgent push opens that email', () => {
  const { s } = setup([['a', true]]);
  const p = emailPush(s.item('gmail:a')!, mailMeta('a', true));
  assert.equal(p.url, '/?item=gmail%3Aa');
  assert.equal(p.tag, 'item-gmail:a');
  assert.equal(p.title, 'Jarvis: urgent email from Sender a');
  assert.equal(new URL(p.url, 'http://x').searchParams.get('item'), 'gmail:a');
});

test('the page sends a push for an email to its popup, and keeps emails out of the requests', () => {
  const page = read('../web/index.html');
  assert.match(page, /a\.status === 'pending' && a\.action !== 'gmail-send'/);
  assert.match(page, /selectMessage\(id\); setPop\('messages'\)/);
  assert.doesNotMatch(page, /id="tabs"|id="left"|setTab/);
  assert.match(read('./main.ts'), /notify\(emailPush\(i, meta\)/);
  const main = read('./main.ts');
  assert.match(read('./webfiles.ts'), /'\/messages\.js': 'messages\.js'/);
  assert.match(read('./webfiles.ts'), /'\/swipe\.js': 'swipe\.js'/);
  assert.match(main, /'\/api\/message\/send', '\/api\/message\/handled'[,\]]/);
});

test('the button: none when empty, always Messages, urgent true with any urgent one', () => {
  assert.equal(messageButton([]), null);
  assert.deepEqual(messageButton([{ urgent: false }, { urgent: false }]), { label: 'Messages', urgent: false, count: 2, aria: 'Messages, 2 open' });
  assert.deepEqual(messageButton([{ urgent: false }, { urgent: true }]), { label: 'Messages', urgent: true, count: 2, aria: 'Messages, 2 open' });
  assert.equal(otherMessagesLabel(1), '1 other message');
  assert.equal(otherMessagesLabel(3), '3 other messages');
});

test('the card escapes what an email says', () => {
  const card = messageCard({ id: 1, source: 'gmail', external_id: 'gmail:a', kind: 'email', dispatch_id: null, subject: '<b>Hi</b>', body: '<img src=x>', options: null, status: 'spoken', answer: null, created_at: '2026-11-03 10:00:00', pushes: 0, pushed_at: null, meta: JSON.stringify({ ...mailMeta('a'), fromName: '<i>Sam</i>' }) } as any);
  const html = messageHeadHtml(card, Date.parse(card.at), 'bad <thing>');
  assert.doesNotMatch(html, /<b>Hi|<img|<i>Sam|<thing>/);
  assert.match(html, /&lt;b&gt;Hi/);
  assert.match(html, /not sent/);
});

test('the email card shows who Send reply goes to: the sender, everyone else in Cc, never the owner', () => {
  const row = (meta: object) => ({ id: 1, source: 'gmail', external_id: 'gmail:a', kind: 'email', dispatch_id: null, subject: 'S', body: '', options: null, status: 'spoken', answer: null, created_at: '2026-11-03 10:00:00', pushes: 0, pushed_at: null, meta: JSON.stringify(meta) }) as any;
  const card = messageCard(row({ ...mailMeta('a'), to: ['owner@example.test', 'leo@x.test'], cc: ['<b>@x.test'] }));
  assert.deepEqual(card.replyTo, { to: ['a@x.test'], cc: ['leo@x.test', '<b>@x.test'] });
  const html = messageHeadHtml(card, Date.parse(card.at));
  assert.match(html, /To a@x\.test<br>Cc leo@x\.test, &lt;b&gt;@x\.test/);
  assert.doesNotMatch(html, /owner@/);
  const old = messageCard(row({ ...mailMeta('a'), to: undefined, cc: undefined }));
  assert.equal(old.replyTo, null);
  assert.match(messageHeadHtml(old, Date.parse(old.at)), /Reply all: Jarvis reads who is on the thread from Gmail/);
});

test('messageOrder: urgent first, then oldest first', () => {
  const c = (id: string, urgent: boolean, at: string) => ({ id, urgent, at }) as any;
  assert.deepEqual(messageOrder([c('new', false, '2026-11-03T10:00:00Z'), c('old', false, '2026-11-03T09:00:00Z'), c('u', true, '2026-11-03T11:00:00Z')]).map(x => x.id), ['u', 'old', 'new']);
});

test('swipe: right opens, left closes, the screen edge stays with Safari, and a scroll is not a swipe', () => {
  const s = (startX: number, endX: number, startY = 300, endY = 300) => ({ startX, endX, startY, endY });
  assert.equal(swipeAction(s(100, 200), false), 'open');
  assert.equal(swipeAction(s(250, 100), true), 'close');
  assert.equal(swipeAction(s(100, 200), true), null);
  assert.equal(swipeAction(s(250, 100), false), null);
  assert.equal(swipeAction(s(10, 200), false), null, 'from the left edge it is the back gesture');
  assert.equal(swipeAction(s(29, 200), false), null);
  assert.equal(swipeAction(s(30, 200), false), 'open');
  assert.equal(swipeAction(s(100, 150), false), null, 'too short');
  assert.equal(swipeAction(s(100, 200, 300, 400), false), null, 'too much up or down');
});

// ---- Messages the owner sends himself: the `outbox` source ----
const TEAMMATE = { to: 'Sam', channel: 'slack', reason: 'FBM secrets grant', text: 'Hi Sam,\nplease grant it. Thanks.' };
const addCard = (m: ReturnType<typeof setup>['m'], b: object = TEAMMATE) => m.add(b).body as any;

test('a card shows who it is for, the channel, the reason and the draft, and counts on the button like an email', () => {
  const { m, changes } = setup();
  const card = addCard(m);
  assert.equal(changes(), 1, 'open pages hear about it');
  assert.match(card.id, /^outbox:/);
  assert.equal(card.from, 'Sam');
  assert.equal(card.label, 'To send on Slack');
  assert.equal(card.subject, 'FBM secrets grant');
  assert.equal(card.draft, TEAMMATE.text);
  assert.equal(card.copyOnly, true);
  assert.equal(card.urgent, false);
  assert.equal(card.openUrl, '');
  assert.equal(m.list().length, 2);
  assert.deepEqual(messageButton(m.list()), { label: 'Messages', urgent: false, count: 2, aria: 'Messages, 2 open' });
  assert.equal(addCard(m, { ...TEAMMATE, channel: 'email', text: 'Other words' }).label, 'To send on email');
  assert.equal(m.list().find(x => x.source === 'gmail')!.copyOnly, false, 'an email keeps Send reply');
});

test('the card text and buttons, escaped', () => {
  const { m } = setup([]);
  const card = addCard(m, { to: '<i>Sam</i>', channel: 'slack', reason: '<b>why</b>', text: 'x' });
  const html = messageHeadHtml(card, Date.parse(card.at), 'bad <thing>');
  assert.doesNotMatch(html, /<i>Sam|<b>why|<thing>/);
  assert.match(html, /To &lt;i&gt;Sam/);
  assert.match(html, /To send on Slack/);
  assert.match(html, /&lt;b&gt;why/);
  assert.match(html, /pill failed">failed/);
  assert.deepEqual(messageControls(card, false), { draft: 'Draft', send: 'Copy', handled: 'Done' });
  assert.equal(messageControls(card, true).send, 'Copied');
  assert.deepEqual(messageControls({ copyOnly: false }, false), { draft: 'Draft reply', send: 'Send reply', handled: "I'll handle it" });
});

test('a card sends nothing: no gate action, and neither Send reply nor gmail-send can reach it', async () => {
  const { s, gate, m } = setup([]);
  const before = sends();
  const { id } = addCard(m);
  assert.equal((await m.send(id, 'hi')).status, 404);
  await assert.rejects(gate.propose('gmail-send', { item: id, text: 'hi' }, 'Send it?'));
  assert.equal(m.handled(id).status, 200);
  assert.equal(sends(), before);
  assert.equal(s.pendingApprovals().length, 0);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM approvals').get()!.n, 0, 'nothing in approvals');
});

test('a card stays until Done, and a second Done is refused', () => {
  const { s, m, changes } = setup([]);
  const { id } = addCard(m);
  const r = m.handled(id);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.messages, []);
  assert.equal(s.item(id)!.status, 'answered');
  assert.equal(s.item(id)!.answer, 'The owner tapped Done');
  assert.equal(s.openOutbox().length, 0);
  assert.equal(changes(), 2);
  assert.equal(m.handled(id).status, 409);
});

test('a card survives a daemon restart', () => {
  const path = join(dir, 'restart.db');
  const first = openStore(path);
  const m1 = makeMessages({ store: first, gate: makeGate(first, () => {}), log: () => {}, onChange: () => {} });
  const { id } = m1.add(TEAMMATE).body as any;
  first.db.close();
  const again = openStore(path);
  const m2 = makeMessages({ store: again, gate: makeGate(again, () => {}), log: () => {}, onChange: () => {} });
  assert.deepEqual(m2.list().map(x => [x.id, x.from, x.draft]), [[id, 'Sam', TEAMMATE.text]]);
  again.db.close();
});

test('a retry with the same words returns the open card; after Done the same words make a new one', () => {
  const { s, m, changes } = setup([]);
  const first = addCard(m);
  const again = addCard(m, { ...TEAMMATE, reason: 'Reworded reason' });
  assert.equal(again.id, first.id);
  assert.equal(again.existing, true);
  assert.equal(changes(), 1);
  assert.equal(s.openOutbox().length, 1);
  m.handled(first.id);
  assert.notEqual(addCard(m).id, first.id);
});

test('message-add refuses a missing field and an unknown channel', () => {
  const { m } = setup([]);
  for (const [bad, why] of [[{ to: ' ' }, /--to/], [{ channel: 'sms' }, /slack or email/], [{ channel: 'constructor' }, /slack or email/], [{ reason: '' }, /--reason/], [{ text: ' \n' }, /--text/]] as const) {
    const r = m.add({ ...TEAMMATE, ...bad });
    assert.equal(r.status, 400);
    assert.match((r.body as any).error, why);
  }
  assert.deepEqual(m.list(), []);
});

test('the brief line names the card, and the brain gets it from main.ts', () => {
  const { s, m } = setup([]);
  const { id } = addCard(m);
  assert.equal(outboxLine(s.item(id)!), `- [to send] item=${id} to="Sam" channel=slack reason="FBM secrets grant" text=${JSON.stringify(TEAMMATE.text)}`);
  const main = read('./main.ts');
  assert.match(main, /store\.openOutbox\(\)/);
  assert.match(main, /outbox\.map\(outboxLine\)/);
  assert.match(read('./messages.ts'), /url === '\/api\/internal\/messages'/);
  assert.doesNotMatch(main.match(/const AS_OWNER = .*/)![0], /internal/);
});

test('the ten-minute check, the open asks and the Gmail brief do not see a card', async () => {
  const { s, m } = setup([]);
  const { id } = addCard(m);
  s.db.prepare(`UPDATE items SET created_at = datetime('now', '-3 days') WHERE external_id = ?`).run(id);
  assert.deepEqual(s.openItems(), []);
  assert.deepEqual(s.openEmails(null), []);
  const wakes: string[] = [];
  const check = makeCheck({
    store: s, log: () => {}, now: () => Date.parse('2026-11-03T15:00:00Z'), paused: () => false,
    poll: async () => ({ at: '', rows: [], done: [] }) as any,
    requests: { synced: async () => {}, closing: () => false },
    delivery: async () => ({ master: 'a', unmerged: [] }), running: 'a', brainBusy: () => false, wake: t => wakes.push(t),
  });
  await check.tick();
  assert.equal(s.getState('checkAt'), '2026-11-03T15:00:00.000Z', 'the tick ran');
  assert.deepEqual(JSON.parse(s.getState('checkSeen')!), []);
  assert.deepEqual(wakes, []);
  assert.equal(m.list().length, 1);
});

test('jarvis-act message-add goes through the route and prints the card, and bad input exits non-zero', async () => {
  const { s, m } = setup([]);
  const server = http.createServer(async (req, res) => {
    let b = ''; for await (const c of req) b += c;
    assert.equal(req.url, '/api/internal/messages');
    const r = m.add(JSON.parse(b));
    res.writeHead(r.status).end(JSON.stringify(r.body));
  });
  await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok));
  const port = (server.address() as AddressInfo).port;
  const act = (...args: string[]) => new Promise<{ code: number; out: string }>(ok =>
    execFile(process.execPath, [fileURLToPath(new URL('../bin/jarvis-act', import.meta.url)), 'message-add', ...args], { env: { ...process.env, JARVIS_URL: `http://127.0.0.1:${port}` } }, (e, out) => ok({ code: e ? Number(e.code) : 0, out })));
  try {
    const good = await act('--to', 'Sam', '--channel', 'slack', '--reason', 'FBM secrets grant', '--text', 'Hi Sam, on October 30? (issue 4531) Thanks.');
    assert.equal(good.code, 0);
    assert.equal(JSON.parse(good.out).from, 'Sam');
    assert.equal(JSON.parse(s.openOutbox()[0].meta!).text, 'Hi Sam, on October 30? (issue 4531) Thanks.');
    const bad = await act('--to', 'Sam', '--channel', 'sms', '--reason', 'x', '--text', 'y');
    assert.equal(bad.code, 1);
    assert.match(bad.out, /slack or email/);
    assert.equal(s.openOutbox().length, 1);
  } finally { server.close(); }
});

test('the page copies a card, hides its empty link, and the brain is told how to add one', () => {
  const page = read('../web/index.html');
  assert.match(page, /copyOnly\) return copyDraft\(msgCurrent, text\)/);
  assert.match(page, /navigator\.clipboard\.writeText\(text\)/);
  assert.match(page, /\$\('msg-open'\)\.hidden = !m\.openUrl/);
  assert.match(read('../vault/CLAUDE.md'), /jarvis-act message-add --to <name> --channel <slack\|email> --reason/);
});
