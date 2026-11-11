import test from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from './store.ts';
import { pollGmail, knownSenders, noiseReason, bodyText, parseTriage, replyRaw, replyAll, addressList, stripSignoff, fetchSignature, signatureText, type GmailMessage, type EmailMeta } from './gmail.ts';
import { makeGate, buildCommand, BUTTON_ONLY } from './gate.ts';

const PEOPLE = `- Sam: teammate@example.test\n- Dealer A: @dealer-a.test\n`;
const b64 = (s: string) => Buffer.from(s).toString('base64url');

function msg(id: string, from: string, extra: { headers?: Record<string, string>; labels?: string[]; body?: string; parts?: any[] } = {}): GmailMessage {
  const headers = Object.entries({ From: from, Subject: 'Photos manquantes', 'Message-ID': `<${id}@mail>`, ...extra.headers }).map(([name, value]) => ({ name, value }));
  return { id, threadId: `t_${id}`, labelIds: extra.labels ?? ['INBOX'], payload: { mimeType: 'multipart/alternative', headers,
    parts: extra.parts ?? [{ mimeType: 'text/plain', body: { data: b64(extra.body ?? 'Bonjour the owner, les photos ne montent plus depuis hier. Pouvez-vous regarder?') } }] } };
}

/** A fake mailbox: history since the stored id lists `added`, and messages.get returns from `box`. */
function fakeGmail(box: Record<string, GmailMessage>, added: string[], historyId = '200') {
  const calls: string[] = [];
  const gws = async (args: string[]) => {
    const what = args.slice(1, 4).join(' ');
    calls.push(what);
    const p = JSON.parse(args[args.indexOf('--params') + 1]);
    if (what === 'users getProfile --params') return { historyId: '100', emailAddress: 'Owner.Name@example.test' };
    if (what === 'users history list') return { historyId, history: added.map(id => ({ messagesAdded: [{ message: { id } }] })) };
    if (what === 'users messages get') return box[p.id] ?? { error: { code: 404, message: 'not found' } };
    throw new Error(`unexpected ${what}`);
  };
  return { gws, calls };
}

const TRIAGE = JSON.stringify({ lang: 'fr', urgent: false, needsReply: true, summary: 'Dealer A dit que les photos ne montent plus.', reply: 'Bonjour, je regarde ça aujourd\'hui.\n\nOwner' });

function deps(store: ReturnType<typeof openStore>, gws: any, llmCalls: string[], answer = TRIAGE) {
  const handed: string[] = [], lines: string[] = [];
  return {
    handed, lines,
    d: { store, gws, people: () => PEOPLE, log: (m: string, f?: object) => lines.push(`${m} ${JSON.stringify(f ?? {})}`),
      llm: async (_s: string, p: string) => { llmCalls.push(p); return answer; },
      onItem: (i: any) => handed.push(i.external_id) },
  };
}

test('the first poll records the mailbox position and reads nothing; a quiet poll makes no LLM call', async () => {
  const s = openStore(':memory:');
  const { gws, calls } = fakeGmail({}, []);
  const llm: string[] = [];
  const { d } = deps(s, gws, llm);
  assert.deepEqual(await pollGmail(d), { added: 0, stored: 0 });
  assert.equal(s.getState('gmail_history_id'), '100');
  assert.equal(s.getState('gmail_self'), 'owner.name@example.test');
  assert.deepEqual(await pollGmail(d), { added: 0, stored: 0 });
  assert.equal(s.getState('gmail_history_id'), '200');
  assert.deepEqual(calls, ['users getProfile --params', 'users history list']);
  assert.equal(llm.length, 0);
});

test('mail from a known sender becomes a gmail item with a summary and a French draft; noise and strangers never reach the model', async () => {
  const s = openStore(':memory:');
  s.setState('gmail_history_id', '100');
  const box = {
    a: msg('a', 'Jean Doe <jdoe@dealer-a.test>', { headers: { To: '"Name, Owner" <owner@example.test>, Max <max@dealer-a.test>', Cc: 'teammate@example.test' } }),
    news: msg('news', 'Dealer A <info@dealer-a.test>', { headers: { 'List-Unsubscribe': '<mailto:x>' } }),
    invite: msg('invite', 'jdoe@dealer-a.test', { headers: { Subject: 'Invitation: Démo @ jeu. 31 oct.' } }),
    ics: msg('ics', 'jdoe@dealer-a.test', { headers: { Subject: 'Rencontre' }, parts: [{ mimeType: 'text/calendar', body: { data: b64('BEGIN:VCALENDAR') } }] }),
    gh: msg('gh', 'Alex <notifications@github.com>'),
    robot: msg('robot', 'alerts@dealer-a.test'),
    auto: msg('auto', 'jdoe@dealer-a.test', { headers: { 'Auto-Submitted': 'auto-replied' } }),
    stranger: msg('stranger', 'someone@example.test'),
  };
  const { gws } = fakeGmail(box, Object.keys(box));
  const llm: string[] = [];
  const { d, handed, lines } = deps(s, gws, llm);
  assert.deepEqual(await pollGmail(d), { added: 8, stored: 1 });
  assert.equal(llm.length, 1);
  assert.match(llm[0], /From: Jean Doe <jdoe@dealer-a.test>/);
  const item = s.item('gmail:a')!;
  assert.equal(item.source, 'gmail');
  assert.equal(item.kind, 'email');
  assert.equal(item.status, 'spoken');
  assert.equal(item.body, 'Dealer A dit que les photos ne montent plus.');
  const meta = JSON.parse(item.meta!) as EmailMeta;
  assert.equal(meta.lang, 'fr');
  assert.equal(meta.replyTo, 'jdoe@dealer-a.test');
  assert.deepEqual(meta.to, ['owner@example.test', 'max@dealer-a.test']);
  assert.deepEqual(meta.cc, ['teammate@example.test']);
  assert.equal(meta.threadId, 't_a');
  assert.equal(meta.reply, "Bonjour, je regarde ça aujourd'hui."); // the signature carries his name
  assert.deepEqual(handed, ['gmail:a']);
  assert.equal(s.openEmails().length, 1);
  assert.match(lines.join('\n'), /gmail item .*"item":"gmail:a","gmail":"a","thread":"t_a"/);
  assert.match(lines.join('\n'), /gmail dropped .*"gmail":"news","reason":"mailing list"/);
  assert.match(lines.join('\n'), /gmail skipped, unknown sender .*"domain":"example.test"/);
});

test('a replayed poll stores nothing twice and asks the model nothing twice', async () => {
  const s = openStore(':memory:');
  s.setState('gmail_history_id', '100');
  const { gws } = fakeGmail({ a: msg('a', 'teammate@example.test') }, ['a']);
  const llm: string[] = [];
  const { d, handed } = deps(s, gws, llm);
  await pollGmail(d);
  s.setState('gmail_history_id', '100'); // as if jarvisd died before saving the new history id
  await pollGmail(d);
  assert.equal(llm.length, 1);
  assert.deepEqual(handed, ['gmail:a']);
  assert.equal((s.db.prepare(`SELECT COUNT(*) AS n FROM items WHERE source = 'gmail'`).get() as any).n, 1);
});

test('an item stored but never handed over (crash in between) is handed over on the replay', async () => {
  const s = openStore(':memory:');
  s.setState('gmail_history_id', '100');
  s.insertItem({ source: 'gmail', external_id: 'gmail:a', kind: 'email', meta: '{}' });
  const { gws } = fakeGmail({ a: msg('a', 'teammate@example.test') }, ['a']);
  const llm: string[] = [];
  const { d, handed } = deps(s, gws, llm);
  await pollGmail(d);
  assert.deepEqual(handed, ['gmail:a']);
  assert.equal(llm.length, 0);
  assert.equal(s.item('gmail:a')!.status, 'spoken');
});

test('a failed Gmail call keeps the history id, so the next poll covers the same mail', async () => {
  const s = openStore(':memory:');
  s.setState('gmail_history_id', '100');
  const { gws } = fakeGmail({}, ['a']);
  const failing = async (args: string[]) => { if (args[3] === 'get') throw new Error('network down'); return gws(args); };
  const { d } = deps(s, failing, []);
  await assert.rejects(pollGmail(d), /network down/);
  assert.equal(s.getState('gmail_history_id'), '100');
});

test('mail that needs nothing is logged silently; a bad model answer still reaches the owner without a draft', async () => {
  const s = openStore(':memory:');
  s.setState('gmail_history_id', '100');
  const { gws } = fakeGmail({ a: msg('a', 'teammate@example.test') }, ['a']);
  const quiet = deps(s, gws, [], JSON.stringify({ lang: 'fr', urgent: false, needsReply: false, summary: 'Sam dit merci.', reply: '' }));
  await pollGmail(quiet.d);
  assert.equal(s.item('gmail:a')!.status, 'done');
  assert.deepEqual(quiet.handed, []);

  const s2 = openStore(':memory:');
  s2.setState('gmail_history_id', '100');
  const broken = deps(s2, gws, [], 'Sure! Here is a summary of the email.');
  await pollGmail(broken.d);
  const meta = JSON.parse(s2.item('gmail:a')!.meta!) as EmailMeta;
  assert.equal(meta.triage, 'failed');
  assert.equal(meta.reply, '');
  assert.deepEqual(broken.handed, ['gmail:a']);
});

test('expired Gmail history starts again from the current position', async () => {
  const s = openStore(':memory:');
  s.setState('gmail_history_id', '5');
  const gws = async (args: string[]) => args[2] === 'history' ? { error: { code: 404, message: 'Requested entity was not found.' } } : { historyId: '900' };
  const { d, lines } = deps(s, gws, []);
  await pollGmail(d);
  assert.equal(s.getState('gmail_history_id'), '900');
  assert.match(lines.join('\n'), /history expired/);
});

test('known senders come from addresses and @domains in people.md', () => {
  const k = knownSenders('- Sam: teammate@example.test\n- Dealer A: @dealer-a.test, `@dealer-group-a.test`\n');
  assert.deepEqual([...k.emails], ['teammate@example.test']);
  assert.deepEqual([...k.domains].sort(), ['dealer-a.test', 'dealer-group-a.test']);
});

test('noise rules', () => {
  assert.equal(noiseReason(msg('x', 'a@b.test')), undefined);
  assert.equal(noiseReason(msg('x', 'a@b.test', { labels: ['INBOX', 'CATEGORY_PROMOTIONS'] })), 'label CATEGORY_PROMOTIONS');
  assert.equal(noiseReason(msg('x', 'a@b.test', { headers: { Precedence: 'bulk' } })), 'bulk');
  assert.equal(noiseReason(msg('x', 'No-Reply <no-reply@b.test>')), 'robot sender');
  assert.equal(noiseReason(msg('x', 'a@b.test', { headers: { 'Auto-Submitted': 'no' } })), undefined);
});

test('body text drops the quoted thread and falls back to stripped HTML', () => {
  const plain = msg('x', 'a@b.test', { body: 'Oui, ça marche.\n\nLe mer. 29 oct. 2026, the owner a écrit :\n> Est-ce que ça marche?' });
  assert.equal(bodyText(plain), 'Oui, ça marche.');
  const html = msg('x', 'a@b.test', { parts: [{ mimeType: 'text/html', body: { data: b64('<div>Bonjour<br>Merci &amp; bonne journée</div><style>p{}</style>') } }] });
  assert.equal(bodyText(html), 'Bonjour\nMerci & bonne journée');
});

test('the model answer is checked before anything is stored', () => {
  assert.throws(() => parseTriage('no json'), /no JSON/);
  assert.throws(() => parseTriage('{"needsReply":true,"summary":"x","reply":""}'), /without a reply/);
  assert.equal(parseTriage('```json\n{"lang":"de","summary":"x","needsReply":false}\n```').lang, 'fr');
});

test('reply all: the sender in To, everyone else in Cc, the owner and duplicates dropped, nobody added', () => {
  assert.deepEqual(addressList('"Doe, Jane" <JANE@x.test>, bob@y.test,, Team <team@z.test>'), ['jane@x.test', 'bob@y.test', 'team@z.test']);
  const self = ['owner@example.test', 'owner2@example.test'];
  const meta = { gmailId: 'm', replyTo: 'morgan@dealer.test', to: ['owner@example.test', 'Leo@dealer.test', 'morgan@dealer.test'], cc: ['OWNER2@example.test', 'leo@dealer.test', 'teammate@example.test'] };
  assert.deepEqual(replyAll(meta, self), { to: ['morgan@dealer.test'], cc: ['leo@dealer.test', 'teammate@example.test'] });
  // Reply-To differs from From: the reply goes to Reply-To, and the From address is not added.
  assert.deepEqual(replyAll({ ...meta, replyTo: 'support@dealer.test' }, self), { to: ['support@dealer.test'], cc: ['leo@dealer.test', 'morgan@dealer.test', 'teammate@example.test'] });
  // the owner wrote it: reply all goes back to his To.
  assert.deepEqual(replyAll({ ...meta, replyTo: 'owner@example.test' }, self), { to: ['leo@dealer.test', 'morgan@dealer.test'], cc: ['teammate@example.test'] });
  assert.throws(() => replyAll({ gmailId: 'old', replyTo: 'morgan@dealer.test' }, self), /To and Cc of gmail:old are not recorded/);
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

test('a last line that is only the owner\'s name is dropped; anything else stays', () => {
  // OWNER_NAME is 'Owner Name' when JARVIS_OWNER_NAME is not set (config.ts).
  assert.equal(stripSignoff('Bonjour,\n\nOk.\n\nMerci,\nOwner'), 'Bonjour,\n\nOk.\n\nMerci,');
  assert.equal(stripSignoff('Ok.\n- Owner Name.\n\n'), 'Ok.');
  assert.equal(stripSignoff('Ok.\nowner name'), 'Ok.');
  assert.equal(stripSignoff('Ok.\nowner,'), 'Ok.');
  assert.equal(stripSignoff('Owner'), 'Owner'); // the whole text, not a sign-off
  assert.equal(stripSignoff('Ok.\nOwner will call you'), 'Ok.\nOwner will call you');
  assert.equal(stripSignoff('Merci Owner pour tout.\nSam'), 'Merci Owner pour tout.\nSam');
});

test('the signature is the default send-as address\'s, and a Gmail error is thrown, never an empty signature', async () => {
  const calls: string[][] = [];
  const g = async (a: string[]) => { calls.push(a); return { sendAs: [{ sendAsEmail: 'alias@example.test', signature: '<i>alias</i>' }, { sendAsEmail: 'owner@example.test', isDefault: true, isPrimary: true, signature: ' <b>the owner</b> ' }] }; };
  assert.equal(await fetchSignature(g as any), '<b>the owner</b>');
  assert.deepEqual(calls[0].slice(0, 5), ['gmail', 'users', 'settings', 'sendAs', 'list']);
  assert.equal(await fetchSignature((async () => ({ sendAs: [{ sendAsEmail: 'owner@example.test', isDefault: true }] })) as any), '');
  await assert.rejects(fetchSignature((async () => ({ error: { code: 403, message: 'insufficient scope' } })) as any), /send-as settings.*insufficient scope/);
  assert.equal(signatureText('<div dir="ltr"><b>the owner</b><div>Web Developer<br style=\"color:red\"><a href="mailto:x">owner@example.test</a><img src="x"></div><div>  <a>https://example.org</a></div></div>'),
    'the owner\nWeb Developer\nowner@example.test\nhttps://example.org');
});

test('with a signature the reply is HTML and plain text, the text escaped and above the signature', () => {
  const meta = { replyTo: 'a@x.test', subject: 'Prix', messageId: '', references: '' } as EmailMeta;
  const raw = Buffer.from(replyRaw(meta, 'Prix < 5 000 $ & "taxes"\nOwner', { to: ['a@x.test'], cc: [] }, '<b>the owner</b>'), 'base64url').toString();
  const { plain, html } = parts(raw);
  assert.equal(plain, 'Prix < 5 000 $ & "taxes"\r\n\r\n-- \r\nthe owner');
  assert.equal(html, '<div dir="ltr">Prix &lt; 5 000 $ &amp; &quot;taxes&quot;<br clear="all"><div><br></div><div dir="ltr" class="gmail_signature" data-smartmail="gmail_signature"><b>the owner</b></div></div>');
  assert.match(raw, /\r\n--jarvis_[^\r\n]*--\r\n$/);
});

test('the reply goes to the sender and Cc, in the thread, with a UTF-8 subject and no header injection', () => {
  const meta = { replyTo: 'jdoe@dealer-a.test', subject: 'Photos à jour', messageId: '<m1@mail>', references: '<m0@mail>' } as EmailMeta;
  const to = { to: ['jdoe@dealer-a.test'], cc: ['max@dealer-a.test', 'teammate@example.test'] };
  const raw = Buffer.from(replyRaw(meta, 'Je regarde ça.\nOwner', to), 'base64url').toString();
  assert.match(raw, /^To: jdoe@dealer-a.test\r\nCc: max@dealer-a.test, teammate@example.test\r\n/);
  assert.doesNotMatch(Buffer.from(replyRaw(meta, 'x', { to: to.to, cc: [] }), 'base64url').toString(), /\r\nCc:/);
  assert.match(raw, /Subject: =\?UTF-8\?B\?/);
  assert.match(raw, /In-Reply-To: <m1@mail>\r\nReferences: <m0@mail> <m1@mail>\r\n/);
  assert.deepEqual(parts(raw), { plain: 'Je regarde ça.', html: '<div dir="ltr">Je regarde ça.</div>' });
  const evil = Buffer.from(replyRaw({ ...meta, subject: 'Hi\r\nBcc: x@evil.test' }, 'x', to), 'base64url').toString();
  assert.doesNotMatch(evil, /\r\nBcc:/);
});

// ---- Sending through the gate ----

const noGmail = async () => { throw new Error('no Gmail call expected'); };
function storeWithEmail() {
  const s = openStore(':memory:');
  s.setState('gmail_self', 'owner@example.test');
  const meta: Partial<EmailMeta> = { gmailId: 'a', threadId: 't_a', from: 'jdoe@dealer-a.test', replyTo: 'jdoe@dealer-a.test', subject: 'Photos', messageId: '<a@mail>', references: '', reply: 'Bonjour',
    to: ['owner@example.test'], cc: ['max@dealer-a.test'] };
  s.insertItem({ source: 'gmail', external_id: 'gmail:a', kind: 'email', subject: 'Photos', meta: JSON.stringify(meta), status: 'spoken' });
  return s;
}

test('gmail-send is button only: a relayed yes never sends', async () => {
  assert.ok(BUTTON_ONLY.has('gmail-send'));
  const s = storeWithEmail();
  const gate = makeGate(s, () => {}, undefined, undefined, noGmail);
  const a = await gate.propose('gmail-send', { item: 'gmail:a', text: 'Bonjour, je regarde.\nOwner' }, 'Send the reply to Jean?');
  assert.equal(a.status, 'pending');
  assert.deepEqual(JSON.parse(a.args), { item: 'gmail:a', to: 'jdoe@dealer-a.test', cc: 'max@dealer-a.test', subject: 'Photos', text: 'Bonjour, je regarde.' });
  s.addTurn({ role: 'owner', text: 'yes send it' });
  await assert.rejects(gate.confirm(a.id), /only when the owner taps Approve/);
  assert.equal(s.approval(a.id)!.status, 'pending');
});

test('gmail-send only answers a stored email, to its sender, in its thread', async () => {
  const s = storeWithEmail();
  const lookup = (e: string) => s.item(e);
  assert.throws(() => buildCommand('gmail-send', { item: 'gmail:zzz', to: 'x@y.z', text: 'hi' }, lookup), /no stored email/);
  assert.throws(() => buildCommand('gmail-send', { item: 'gmail:a', to: 'boss@elsewhere.test', cc: 'max@dealer-a.test', text: 'hi' }, lookup), /must be the sender/);
  assert.throws(() => buildCommand('gmail-send', { item: 'gmail:a', to: 'jdoe@dealer-a.test', cc: 'max@dealer-a.test, boss@elsewhere.test', text: 'hi' }, lookup), /cc must be everyone else/);
  assert.throws(() => buildCommand('gmail-send', { item: 'gmail:a', to: 'jdoe@dealer-a.test', text: 'hi' }, lookup), /cc must be everyone else/);
  assert.throws(() => buildCommand('gmail-send', { item: 'gmail:a', to: 'jdoe@dealer-a.test', cc: 'max@dealer-a.test' }, lookup), /text is required/);
  const argv = buildCommand('gmail-send', { item: 'gmail:a', to: 'jdoe@dealer-a.test', cc: 'max@dealer-a.test', text: 'hi' }, lookup);
  assert.deepEqual(argv.slice(0, 5), ['gws', 'gmail', 'users', 'messages', 'send']);
  assert.equal(JSON.parse(argv[argv.indexOf('--json') + 1]).threadId, 't_a');
  // Even a proposal that names another recipient is rewritten to the sender before it is stored.
  const gate = makeGate(s, () => {}, undefined, undefined, noGmail);
  const a = await gate.propose('gmail-send', { item: 'gmail:a', to: 'boss@elsewhere.test', cc: 'boss@elsewhere.test', text: 'hi' }, 'Send?');
  assert.equal(JSON.parse(a.args).to, 'jdoe@dealer-a.test');
  assert.equal(JSON.parse(a.args).cc, 'max@dealer-a.test');
});

function storeWithOldEmail() {
  const s = openStore(':memory:');
  const meta = { gmailId: 'old1', threadId: 't_old', from: 'morgan@dealer.test', replyTo: 'morgan@dealer.test', subject: 'Prix', messageId: '<o@mail>', references: '', reply: 'Bonjour' };
  s.insertItem({ source: 'gmail', external_id: 'gmail:old1', kind: 'email', subject: 'Prix', meta: JSON.stringify(meta), status: 'spoken' });
  return s;
}

test('an email stored before reply all reads its To and Cc from Gmail once, and drops the profile address too', async () => {
  const s = storeWithOldEmail();
  const calls: string[] = [];
  const g = async (args: string[]) => {
    const p = JSON.parse(args[args.indexOf('--params') + 1]);
    calls.push(`${args[2]} ${p.format ?? ''}`.trim());
    if (args[2] === 'getProfile') return { emailAddress: 'owner2@example.test' };
    return { id: 'old1', payload: { headers: [{ name: 'From', value: 'Morgan <morgan@dealer.test>' }, { name: 'To', value: 'owner2@example.test, Leo <leo@dealer.test>' }, { name: 'Cc', value: 'owner@example.test, morgan@dealer.test' }] } };
  };
  const gate = makeGate(s, () => {}, undefined, undefined, g as any);
  const a = await gate.propose('gmail-send', { item: 'gmail:old1', text: 'Bonjour.\nOwner' }, 'Send?');
  assert.deepEqual([JSON.parse(a.args).to, JSON.parse(a.args).cc], ['morgan@dealer.test', 'leo@dealer.test']);
  assert.deepEqual(calls, ['getProfile', 'messages metadata']);
  const meta = JSON.parse(s.item('gmail:old1')!.meta!);
  assert.deepEqual([meta.to, meta.cc], [['owner2@example.test', 'leo@dealer.test'], ['owner@example.test', 'morgan@dealer.test']]);
  // Saved: building it again asks Gmail nothing.
  buildCommand('gmail-send', JSON.parse(a.args), e => s.item(e), ['owner2@example.test']);
  assert.equal(calls.length, 2);
});

test('when Gmail cannot give an older email\'s recipients, the send is refused, never sent to the sender alone', async () => {
  const s = storeWithOldEmail();
  s.setState('gmail_self', 'owner@example.test');
  const gate = makeGate(s, () => {}, undefined, undefined, (async () => ({ error: { code: 500, message: 'backend' } })) as any);
  await assert.rejects(gate.propose('gmail-send', { item: 'gmail:old1', text: 'hi' }, 'Send?'), /Not sent: I could not read who is on gmail:old1 from Gmail.*"code":500/);
  assert.equal(s.pendingApprovals().length, 0);
  assert.throws(() => buildCommand('gmail-send', { item: 'gmail:old1', to: 'morgan@dealer.test', text: 'hi' }, e => s.item(e)), /not recorded/);
});
