import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { openStore } from './store.ts';
import { makeMigration, migrationRoute, migrationBrief, readDealerFile, statusOf, fold, meetingOf, createTables, contactOf } from './migration.ts';
import { migrationButton, migrationSub, listHtml, rowHtml, contactHtml, rowTap, ROW_TAPS, REMOVE_WAIT_MS, dealerOptions, addFormHtml, when, editedAgo, byLine, since, meetingWords, easternIso, easternFields, readBack, groups, order, byDealership, pickerHtml, nextMeeting, addReady, meetingToast, toastKey, untilWords } from '../web/migration.js';

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const SEED = fileURLToPath(new URL('../docs/migration/dealerships.json', import.meta.url));
const SAMPLE = [{ name: 'Dealer One', key: 'dealerone' }, { name: 'Bravo Garage', key: 'bravogarage' }, { name: 'Charlie Centre', key: 'charliecentre' }];

function setup(seed: { name: string; key?: string | null }[] | undefined = SAMPLE, store = openStore(':memory:')) {
  let changes = 0;
  const logs: string[] = [];
  const m = makeMigration({ db: store.db, log: msg => { logs.push(msg); }, getState: store.getState, setState: store.setState, onChange: () => { changes++; }, seed: seed && (() => seed) });
  return { m, store, logs, changes: () => changes };
}
const jarvis = (f: object) => ({ source: 'email', from: 'chat', ...f });
const addId = (t: ReturnType<typeof setup>, f: object, by: 'owner' | 'jarvis' = 'jarvis') => t.m.add(by === 'jarvis' ? jarvis(f) : f, by).body.person.id as number;

// ---- the seed and the import ----
test('the seed file ships with no dealerships, and an empty seed starts an empty list that an import fills', () => {
  assert.deepEqual(readDealerFile(SEED), []);
  const t = setup([]);
  assert.equal(t.m.state().dealers.length, 0);
  assert.deepEqual(t.logs, [], 'an empty seed is not an error');
  assert.equal(t.store.getState('migrationSeeded'), undefined, 'a later seed can still run');
  const r = t.m.importDealers([{ name: 'Garage Élan', key: 'garageelan' }]);
  assert.deepEqual(r, { added: 1, renamed: 0, offSheet: 0, total: 1 });
  assert.ok(t.m.state().dealers.some(d => d.name === 'Garage Élan' && d.onSheet), 'accents kept');
});

test('the seed runs once: a second start with a different seed changes nothing', () => {
  const store = openStore(':memory:');
  setup(SAMPLE, store);
  const again = setup([{ name: 'Other place', key: 'other' }], store);
  assert.deepEqual(again.m.state().dealers.map(d => d.name).sort(), SAMPLE.map(d => d.name).sort());
});

test('a re-import adds, renames by key, flags what left the sheet, and never touches people', () => {
  const t = setup();
  const id = addId(t, { name: 'Max Tanner', dealership: 'Dealer One', note: 'n' });
  const before = t.store.db.prepare('SELECT * FROM migration_people WHERE id = ?').get(id);
  const r = t.m.importDealers([{ name: 'Dealer One Ltd', key: 'dealerone' }, { name: 'Dealer Three', key: 'dealerthree' }]);
  assert.deepEqual(r, { added: 1, renamed: 1, offSheet: 2, total: 2 });
  assert.deepEqual(t.store.db.prepare('SELECT * FROM migration_people WHERE id = ?').get(id), before, 'the people row is byte for byte the same');
  assert.equal(t.m.view(id)!.dealership, 'Dealer One Ltd', 'the row follows the rename through its dealership');
  const bravo = t.m.state().dealers.find(d => d.name === 'Bravo Garage')!;
  assert.equal(bravo.onSheet, false, 'gone from the sheet, kept and flagged');
});

test('a dealership the owner added by hand joins the sheet when the sheet adds the same name', () => {
  const t = setup();
  const d = t.m.addDealer({ name: 'Garage Nouveau' }).body.dealer;
  assert.equal(d.onSheet, false);
  t.m.importDealers([...SAMPLE, { name: 'Garage Nouveau', key: 'garagenouveau' }]);
  const now = t.m.state().dealers.find(x => x.id === d.id)!;
  assert.deepEqual([now.onSheet, now.key], [true, 'garagenouveau']);
});

test('the import refuses a bad file and leaves the list as it was', () => {
  const t = setup();
  const was = t.m.state().dealers;
  assert.match(String(t.m.importDealers([])), /non-empty/);
  assert.match(String(t.m.importDealers([{ name: 'A', key: 'a' }, { name: 'A', key: 'b' }])), /same dealership name twice/);
  assert.match(String(t.m.importDealers([{ name: 'A', key: 'k' }, { name: 'B', key: 'k' }])), /same dealership key twice/);
  assert.match(String(t.m.importDealers([{ name: '' }])), /needs a name/);
  t.m.addDealer({ name: 'Dealer Three' });
  assert.match(String(t.m.importDealers([{ name: 'Dealer Three', key: 'dealerone' }])), /two rows here/);
  assert.deepEqual(t.m.state().dealers.filter(d => d.name !== 'Dealer Three'), was);
});

// ---- people ----
test('Jarvis adds a person with a dealership from the list, matched without case or accents, and must say where from', () => {
  const t = setup();
  const r = t.m.add(jarvis({ name: 'Leo  Bergeron', dealership: 'charlie centre', source: 'text', note: 'Texted.', from: 'a text from Leo' }), 'jarvis');
  assert.equal(r.status, 200);
  const p = r.body.person;
  assert.deepEqual([p.name, p.dealership, p.source, p.status, p.addedBy, p.addedFrom, p.note], ['Leo Bergeron', 'Charlie Centre', 'text', 'todo', 'jarvis', 'a text from Leo', 'Texted.']);
  assert.match(p.uid, /^[0-9a-f-]{36}$/);
  assert.equal(p.history.length, 1);
  assert.match(t.m.add({ name: 'X', dealership: 'Dealer One', source: 'email' }, 'jarvis').body.error, /--from is required/);
});

test('an unknown dealership is refused with close names, and the brain cannot add one', () => {
  const t = setup();
  const r = t.m.add(jarvis({ name: 'X', dealership: 'Dealer Onn Inc' }), 'jarvis');
  assert.equal(r.status, 400);
  assert.match(r.body.error, /not on the dealership list\. Close: Dealer One\..*Only the owner adds a dealership/);
  assert.equal(migrationRoute(t.m, 'POST', '/api/internal/migration/dealer', { name: 'New' }), undefined);
  assert.equal(t.m.state().dealers.length, 3);
});

test('the same person at the same dealership returns the row, so a retry adds nothing', () => {
  const t = setup();
  const a = t.m.add(jarvis({ name: 'Max Tanner', dealership: 'Dealer One' }), 'jarvis');
  const b = t.m.add(jarvis({ name: 'max tanner', dealership: 'Dealer One' }), 'jarvis');
  assert.equal(b.body.existing, true);
  assert.equal(b.body.person.id, a.body.person.id);
  assert.equal(t.m.state().people.length, 1);
});

test('input is checked: name, source and status', () => {
  const t = setup();
  assert.match(t.m.add(jarvis({ dealership: 'Dealer One' }), 'jarvis').body.error, /name is required/);
  assert.match(t.m.add(jarvis({ name: 'A', dealership: 'Dealer One', source: 'fax' }), 'jarvis').body.error, /source must be email or text/);
  assert.match(t.m.add(jarvis({ name: 'A', dealership: 'Dealer One', status: 'done' }), 'jarvis').body.error, /status must be one of/);
  assert.equal(t.m.add(jarvis({ name: 'A', dealership: 'Dealer One', status: 'Meeting set' }), 'jarvis').body.person.status, 'meeting');
  assert.deepEqual(['todo', 'To contact', 'CONTACTED', 'meeting set', 'migrated', 'nope'].map(statusOf), ['todo', 'todo', 'contacted', 'meeting', 'migrated', undefined]);
  assert.equal(fold('Élan-Centre'), 'elancentre');
});

test('every status change keeps its time and who made it, and the same status twice records nothing', () => {
  const t = setup();
  const id = addId(t, { name: 'A', dealership: 'Dealer One' });
  t.m.status(id, { status: 'contacted' }, 'jarvis');
  t.m.status(id, { status: 'contacted' }, 'owner');
  t.m.status(id, { status: 'migrated' }, 'owner');
  const p = t.m.view(id)!;
  assert.deepEqual(p.history.map(h => [h.status, h.by]), [['todo', 'jarvis'], ['contacted', 'jarvis'], ['migrated', 'owner']]);
  assert.ok(p.history.every(h => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(h.at)));
  assert.equal(p.statusAt, p.history.at(-1)!.at);
  assert.equal(t.m.status(999, { status: 'todo' }, 'jarvis').status, 404);
});

test('a note replaces the last one and records when, and its id never changes', () => {
  const t = setup();
  const id = addId(t, { name: 'A', dealership: 'Dealer One' });
  assert.equal(t.m.view(id)!.noteAt, null);
  t.m.note(id, { note: '  Booked Thursday. ' }, 'owner');
  assert.equal(t.m.view(id)!.note, 'Booked Thursday.');
  assert.ok(t.m.view(id)!.noteAt);
  assert.equal(t.m.note(id, {}, 'jarvis').status, 400);
  assert.throws(() => t.store.db.prepare(`UPDATE migration_people SET uid = 'x' WHERE id = ?`).run(id), /does not change/);
});

test('only the owner removes a row, and it is kept with its removal time for the later sheet sync', () => {
  const t = setup();
  const id = addId(t, { name: 'A', dealership: 'Dealer One' });
  for (const url of [`/api/internal/migration/${id}/remove`, `/api/internal/migration/${id}/delete`]) assert.equal(migrationRoute(t.m, 'POST', url, {}), undefined, url);
  assert.equal(migrationRoute(t.m, 'POST', '/api/migration/act', { id, action: 'remove' })!.status, 200);
  assert.equal(t.m.state().people.length, 0);
  assert.ok((t.store.db.prepare('SELECT removed_at FROM migration_people WHERE id = ?').get(id) as any).removed_at);
  assert.equal(t.m.status(id, { status: 'todo' }, 'jarvis').status, 404, 'a removed row is gone for the brain too');
});

test('The owner adds from the page by dealership id, and Other adds a dealership flagged as not on the sheet', () => {
  const t = setup();
  const d = migrationRoute(t.m, 'POST', '/api/migration/dealer', { name: 'Garage Nouveau' })!.body.dealer;
  const r = migrationRoute(t.m, 'POST', '/api/migration/add', { name: 'Paul', dealerId: d.id, source: 'text' })!;
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.person.dealership, r.body.person.onSheet, r.body.person.addedBy, r.body.person.addedFrom], ['Garage Nouveau', false, 'owner', null]);
  assert.equal(migrationRoute(t.m, 'POST', '/api/migration/dealer', { name: 'dealer one' })!.body.existing, true, 'no second Dealer One');
  assert.equal(migrationRoute(t.m, 'POST', '/api/migration/act', { id: 1, action: 'nope' })!.status, 400);
});

test('the session brief has one [migration] line per open To contact row, and nothing when there is none', () => {
  const t = setup();
  assert.equal(migrationBrief(t.m.state().people), '');
  const a = addId(t, { name: 'Max', dealership: 'Dealer One', note: 'Asks when "listings" move' });
  const b = addId(t, { name: 'Julie', dealership: 'Bravo Garage', source: 'text' });
  t.m.status(b, { status: 'contacted' }, 'jarvis');
  const lines = migrationBrief(t.m.state().people).split('\n');
  assert.match(lines[0], /^Migration list, 1 to contact/);
  assert.equal(lines.length, 2);
  assert.match(lines[1], new RegExp(`^- \\[migration\\] id=${a} "Max" dealership="Dealer One" source=email since=\\S+Z note="Asks when \\\\"listings\\\\" move"$`));
  assert.match(read('./main.ts'), /migrationBrief\(migration\.state\(\)\.people\)/, 'the brief includes it');
});

// ---- the CLI ----
test('the real CLI relays to the real routes, imports from a file, and has no remove command', async () => {
  const t = setup();
  const server = http.createServer(async (req, res) => {
    let s = ''; for await (const c of req) s += c;
    const r = migrationRoute(t.m, req.method!, req.url!, s ? JSON.parse(s) : {});
    res.writeHead(r?.status ?? 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify(r?.body ?? { error: 'not found' }));
  }).listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const bin = fileURLToPath(new URL('../bin/jarvis-migration', import.meta.url));
  const cli = (...args: string[]) => new Promise<{ code: number; out: string; err: string }>(resolve => execFile(bin, args, { env: { ...process.env, JARVIS_URL: url } }, (e, out, err) => resolve({ code: e ? (e.code as number) : 0, out, err })));
  try {
    const added = await cli('add', '--name', 'Max Tanner', '--dealership', 'Dealer One', '--source', 'email', '--from', 'an email from Max', '--note', 'Asks when');
    assert.equal(added.code, 0, added.err);
    const id = JSON.parse(added.out).id;
    assert.equal(JSON.parse((await cli('add', '--name', 'Max Tanner', '--dealership', 'Dealer One', '--source', 'email', '--from', 'chat')).out).existing, true);
    assert.equal((await cli('add', '--name', 'X', '--dealership', 'Nowhere', '--source', 'email', '--from', 'chat')).code, 1);
    assert.equal((await cli('set-status', String(id), '--status', 'contacted')).code, 0);
    assert.equal(JSON.parse((await cli('note', String(id), '--text', 'Called.')).out).note, 'Called.');
    const list = JSON.parse((await cli('list')).out);
    assert.deepEqual([list[0].id, list[0].status, list[0].history.map((h: any) => h.status)], [id, 'contacted', ['todo', 'contacted']]);
    assert.ok(list[0].uid && list[0].statusAt);
    assert.ok(JSON.parse((await cli('dealers')).out).includes('Dealer One'));
    const file = join(mkdtempSync(join(tmpdir(), 'jarvis-migration-')), 'd.json');
    writeFileSync(file, JSON.stringify({ dealerships: [...SAMPLE, { name: 'Dealer Three', key: 'dealerthree' }] }));
    assert.deepEqual(JSON.parse((await cli('import-dealers', '--file', file)).out), { added: 1, renamed: 0, offSheet: 0, total: 4 });
    assert.equal(t.m.state().people.length, 1);
    assert.equal((await cli('import-dealers', '--file', '/nope.json')).code, 2);
    for (const c of ['remove', 'delete', 'add-dealer']) assert.equal((await cli(c, String(id))).code, 2, c);
    assert.equal((await cli('set-status', 'abc', '--status', 'todo')).code, 2);
  } finally { server.close(); }
});

test('the CLI fails plainly when jarvisd is down', async () => {
  const bin = fileURLToPath(new URL('../bin/jarvis-migration', import.meta.url));
  const r = await new Promise<{ code: number; err: string }>(resolve => execFile(bin, ['list'], { env: { ...process.env, JARVIS_URL: 'http://127.0.0.1:9' } }, (e, _o, err) => resolve({ code: e ? (e.code as number) : 0, err })));
  assert.equal(r.code, 1);
  assert.match(r.err, /jarvisd unreachable/);
});

// ---- the page ----
const NOW = Date.parse('2026-11-06T17:00:00Z');
const person = (f: object) => ({ id: 1, uid: 'u', name: 'Max', dealership: 'Dealer One', dealerId: 1, dealerKey: 'k', onSheet: true, source: 'email', sourceWords: 'Email', status: 'todo', statusWords: 'To contact', note: '', addedBy: 'owner', addedFrom: null, createdAt: '2026-11-06T14:12:00Z', updatedAt: '', statusAt: '2026-11-06T14:12:00Z', noteAt: null, history: [], ...f });

test('the button counts only people To contact', () => {
  const list = ['todo', 'todo', 'contacted', 'meeting', 'migrated'].map((status, id) => person({ id, status }));
  assert.deepEqual(migrationButton(list, NOW), { count: 2, aria: 'Leads, 2 to contact' });
  assert.equal(migrationButton([person({ status: 'migrated' })]).count, 0);
  assert.equal(migrationSub(list), '5 people, 2 to contact');
});

test('each status is a heading that folds with its count, Migrated starts folded, and the open row shows the note editor and Remove', () => {
  const list = [person({ id: 1, name: 'Open one' }), person({ id: 2, name: 'Moved one', status: 'migrated', statusWords: 'Migrated' })];
  const closed = listHtml(list, {}, NOW);
  assert.match(closed, /<button type="button" class="m-head" data-sec="todo" aria-expanded="true"><svg[^]*?<\/svg><i aria-hidden="true"><\/i><b>To contact<\/b><span>1<\/span><\/button>/);
  assert.match(closed, /data-sec="migrated" aria-expanded="false">[^]*?<b>Migrated<\/b><span>1<\/span>/);
  assert.doesNotMatch(closed, /Moved one/);
  assert.match(listHtml(list, { shut: {} }, NOW), /Moved one/);
  assert.doesNotMatch(listHtml(list, { shut: { todo: true } }, NOW), /Open one/, 'a folded status hides its people');
  assert.doesNotMatch(closed, /m-count/, 'the four counter cards are gone');
  const open = listHtml(list, { open: 1 }, NOW);
  assert.match(open, /data-note/);
  assert.match(open, /data-save/);
  assert.match(open, /data-remove>Remove</);
  const asking = listHtml(list, { open: 1, confirmRemove: NOW }, NOW);
  assert.match(asking, /Remove Open from the list\?<\/span><button type="button" class="act danger" data-remove-yes>Remove<\/button><button type="button" class="act" data-remove-keep>Keep<\/button>/, 'Keep sits where Remove was');
  assert.doesNotMatch(asking, /data-remove>/);
  assert.match(listHtml([], {}, NOW), /Nobody yet/);
});

test('a row shows who added it, flags a dealership not on the sheet, and escapes every text', () => {
  const p = person({ name: 'A <b>', dealership: 'Shop & Co', onSheet: false, note: 'Note <i>', addedBy: 'jarvis', addedFrom: 'an email' });
  const html = rowHtml(p, {}, NOW);
  assert.match(html, /A &lt;b&gt;/);
  assert.match(html, /<span class="m-sub" data-toggle>Shop &amp; Co <small class="m-off">not on sheet<\/small> · Note &lt;i&gt;<\/span>/);
  assert.match(html, /Added by Jarvis from an email, today 9:12 a\.m\./);
  assert.equal(byLine(person({}), NOW), '', 'The owner\'s own rows carry no line, as in the mockup');
  assert.match(rowHtml(person({}), { open: 1 }, NOW), /Added by you, today 9:12 a\.m\./);
  assert.match(rowHtml(person({ status: 'meeting' }), {}, NOW), /<option value="meeting" selected>Meeting set/);
});

test('times read in Eastern: today with the time, yesterday, then the date', () => {
  assert.equal(when('2026-11-06T14:12:00Z', NOW), 'today 9:12 a.m.');
  assert.equal(when('2026-11-05T20:00:00Z', NOW), 'yesterday');
  assert.equal(when('2026-11-03T12:00:00Z', NOW), 'Nov 3');
  assert.equal(editedAgo('2026-11-04T17:00:00Z', NOW), 'Edited 2 days ago');
  assert.equal(editedAgo(null, NOW), '');
});

test('the dealership dropdown lists the names as written, flags the owner\'s own, and ends with Other', () => {
  const html = dealerOptions([{ id: 1, name: 'Dealer Fourteen', onSheet: true }, { id: 2, name: 'Garage', onSheet: false }], 2);
  assert.match(html, /<option value="1">Dealer Fourteen<\/option>/);
  assert.match(html, /<option value="2" selected>Garage \(not on sheet\)<\/option>/);
  assert.match(html, /<option value="other">Other\.\.\.<\/option>$/);
  const form = addFormHtml([], { name: '', dealer: 'other', other: '', source: 'text', status: 'todo', note: '', error: '' });
  assert.match(form, /data-f="other"/, 'Other opens a name box');
  assert.match(form, /data-src="text" aria-pressed="true"/);
});

test('option H: four icon buttons in the bar, Leads among them, New session in the phone menu, and a 560 px popup with the sheet footer', () => {
  const page = read('../web/index.html'), css = read('../web/app.css');
  const bar = page.slice(page.indexOf('<div id="needbar">'), page.indexOf('<div class="tools">'));
  const ids = [...bar.matchAll(/id="([a-z]+-btn)"/g)].map(m => m[1]);
  assert.deepEqual(ids, ['req-btn', 'msg-btn', 'today-btn', 'mig-btn'], 'Requests, Messages, Today, Leads');
  for (const b of bar.matchAll(/<button [^>]*>/g)) {
    const id = b[0].match(/id="([a-z]+-btn)"/)![1];
    if (id === 'req-btn' || id === 'msg-btn') assert.match(b[0], /\bhidden\b/, `${id} starts hidden: nothing is open before the first data`);
    else assert.doesNotMatch(b[0], /\bhidden\b/, `${id} stays at zero`);
  }
  for (const label of ['Requests', 'Messages', 'Today', 'Leads']) assert.match(bar, new RegExp(`<svg [^>]*aria-hidden="true">.*?</svg><span class="nl">${label}</span><em hidden></em>`));
  assert.doesNotMatch(page, /mig-ib|mig-strip|mig-next/, 'the old icon, strip and chip are gone');
  assert.match(page, /<div id="menu" hidden><button id="menu-new" type="button">New session<\/button>/);
  assert.match(page, /\$\('menu-new'\)\.onclick = \(\) => \{ showMenu\(false\); npBtn\.onclick\(\); \};/);
  assert.match(page, /The migration sheet stays the record/);
  assert.match(css, /#pop-migration \{ width: 560px; \}/);
  assert.match(css, /#menu #menu-new \{ display: none; \}/);
  assert.match(css, /body\.pane-open \.need-btn \.nl \{ display: none; \}/, 'labels go on the Mac while a pane is open');
  const phone = css.slice(css.indexOf('@media (max-width: 779.98px)'));
  assert.match(phone, /\.need-btn \{ width: 44px; height: 44px; padding: 0; \}/, '44 px to tap');
  assert.match(phone, /\.need-btn \.nl \{ display: none; \}/);
  assert.match(phone, /#newchat \{ display: none; \}[\s\S]*#menu #menu-new \{ display: flex; \}/);
  assert.match(read('./webfiles.ts'), /'\/migration\.js': 'migration\.js'/);
  assert.match(read('./main.ts'), /'\/api\/migration\/add', '\/api\/migration\/act', '\/api\/migration\/dealer', '\/api\/migration\/toast-close'/, 'the page routes need the open-page secret');
});

test('Requests and Messages hide at zero, and a popup closes when its button goes', () => {
  const page = read('../web/index.html'), css = read('../web/app.css');
  const paint = page.slice(page.indexOf('function paintNeedbar()'), page.indexOf('function setPop('));
  assert.match(paint, /\$\('req-btn'\)\.hidden = !n;/, 'Requests shows only with an open request');
  assert.match(paint, /msg\.hidden = !b;/, 'Messages shows only with an open message');
  assert.match(paint, /if \(POPS\[popOpen\]\?\.btn\.hidden\) setPop\(null\);/, 'an open popup closes with its button');
  assert.doesNotMatch(paint, /today-btn'\)\.hidden|mig-btn'\)\.hidden/, 'Today and Leads stay');
  // The button's own display would beat the hidden attribute without this rule.
  assert.match(css, /\.need-btn\[hidden\] \{ display: none; \}/);
});

test('the brain\'s file says when to add a person, the short confirmation, and lists the CLI', () => {
  const v = read('../vault/CLAUDE.md');
  for (const s of ['## Migration list', 'jarvis-migration add', 'three words or fewer', '[migration]', 'no command to remove']) assert.ok(v.includes(s), s);
  assert.match(v.split('## Access')[1], /jarvis-migration/, 'in the tool list');
});

// ---- meeting times ----
const T = '2026-11-07T10:00-05:00';
test('a meeting time must name its zone, and is stored in UTC', () => {
  assert.equal(meetingOf('2026-11-07T10:00-05:00'), '2026-11-07 15:00:00');
  assert.equal(meetingOf('2026-06-02T10:00-04:00'), '2026-06-02 14:00:00');
  assert.equal(meetingOf('2026-11-07T15:00:00Z'), '2026-11-07 15:00:00');
  for (const bad of ['2026-11-07T10:00', '2026-11-07', 'tomorrow 10', '', null, 42, '2026-13-40T10:00Z', '1999-01-01T10:00Z']) assert.equal(meetingOf(bad), undefined, String(bad));
});

test('The owner cannot set Meeting set without a time: the status waits for it', () => {
  const t = setup();
  const id = addId(t, { name: 'Karim', dealership: 'Dealer One' });
  t.m.status(id, { status: 'contacted' }, 'owner');
  const refused = migrationRoute(t.m, 'POST', '/api/migration/act', { id, action: 'status', status: 'meeting' })!;
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /Pick the meeting day and time first/);
  assert.equal(t.m.view(id)!.status, 'contacted', 'nothing changed');
  assert.equal(migrationRoute(t.m, 'POST', '/api/migration/act', { id, action: 'status', status: 'meeting', meetingAt: '2026-11-09T09:30' })!.status, 400, 'a time without its zone');
  const ok = migrationRoute(t.m, 'POST', '/api/migration/act', { id, action: 'status', status: 'meeting', meetingAt: '2026-11-09T09:30-05:00' })!;
  assert.equal(ok.status, 200);
  const p = t.m.view(id)!;
  assert.deepEqual([p.status, p.meetingAt], ['meeting', '2026-11-09T14:30:00Z']);
  assert.deepEqual(p.history.at(-1), { status: 'meeting', at: p.statusAt, by: 'owner', meetingAt: '2026-11-09T14:30:00Z' });
  assert.match(t.m.status(id, { status: 'contacted', meetingAt: T }, 'owner').body.error, /Meeting set only/);
});

test('the brain may set Meeting set without a time, and gives one with --at when it has it', () => {
  const t = setup();
  const a = addId(t, { name: 'A', dealership: 'Dealer One', status: 'meeting' });
  assert.equal(t.m.view(a)!.meetingAt, null, 'shows Pick a time on the page');
  const b = addId(t, { name: 'B', dealership: 'Dealer One' });
  assert.equal(migrationRoute(t.m, 'POST', `/api/internal/migration/${b}/status`, { status: 'meeting', meetingAt: T })!.body.person.meetingAt, '2026-11-07T15:00:00Z');
  assert.match(t.m.add(jarvis({ name: 'C', dealership: 'Dealer One', status: 'meeting', meetingAt: 'friday' }), 'jarvis').body.error, /ISO time with its zone/);
});

test('moving a meeting keeps its status time, and leaving Meeting set clears the time from the row but not the log', () => {
  const t = setup();
  const id = addId(t, { name: 'A', dealership: 'Dealer One' });
  t.m.status(id, { status: 'meeting', meetingAt: T }, 'owner');
  t.store.db.prepare(`UPDATE migration_people SET status_at = '2026-11-01 12:00:00' WHERE id = ?`).run(id);
  const moved = migrationRoute(t.m, 'POST', '/api/migration/act', { id, action: 'meeting', meetingAt: '2026-11-10T14:00-05:00' })!.body.person;
  assert.deepEqual([moved.meetingAt, moved.statusAt, moved.history.length], ['2026-11-10T19:00:00Z', '2026-11-01T12:00:00Z', 2]);
  assert.equal(t.m.status(id, { status: 'meeting', meetingAt: '2026-11-11T14:00-05:00' }, 'owner').body.person.meetingAt, '2026-11-11T19:00:00Z', 'Meeting set again with a time moves it');
  assert.equal(t.m.view(id)!.history.length, 2, 'and records no second Meeting set');
  assert.equal(t.m.meeting(id, { meetingAt: 'soon' }, 'owner').status, 400);
  t.m.status(id, { status: 'migrated' }, 'owner');
  const p = t.m.view(id)!;
  assert.equal(p.meetingAt, null);
  assert.equal(p.history[1].meetingAt, '2026-11-07T15:00:00Z', 'the log keeps the time it was set with');
  assert.match(t.m.meeting(id, { meetingAt: T }, 'owner').body.error, /is Migrated, not Meeting set/);
});

test('The owner adds a person at Meeting set only with a time', () => {
  const t = setup();
  const d = t.m.state().dealers[0].id;
  assert.match(migrationRoute(t.m, 'POST', '/api/migration/add', { name: 'P', dealerId: d, source: 'email', status: 'meeting' })!.body.error, /Pick the meeting day/);
  assert.equal(t.m.state().people.length, 0);
  const p = migrationRoute(t.m, 'POST', '/api/migration/add', { name: 'P', dealerId: d, source: 'email', status: 'meeting', meetingAt: T })!.body.person;
  assert.deepEqual([p.status, p.meetingAt, p.history[0].meetingAt], ['meeting', '2026-11-07T15:00:00Z', '2026-11-07T15:00:00Z']);
  assert.match(migrationRoute(t.m, 'POST', '/api/migration/add', { name: 'Q', dealerId: d, source: 'email', status: 'todo', meetingAt: T })!.body.error, /Meeting set only/);
});

test('the x hides the Added by Jarvis line on that row for good and keeps who added it', () => {
  const store = openStore(':memory:');
  const t = setup(SAMPLE, store);
  const id = addId(t, { name: 'Leo', dealership: 'Dealer One', from: 'a text from Leo' });
  const other = addId(t, { name: 'Ann', dealership: 'Dealer One' });
  assert.equal(migrationRoute(t.m, 'POST', `/api/internal/migration/${id}/hide-by`, {}), undefined, 'the brain has no route for it');
  const r = migrationRoute(t.m, 'POST', '/api/migration/act', { id, action: 'hide-by' })!;
  assert.equal(r.status, 200);
  const again = setup(SAMPLE, store).m;
  const p = again.view(id)!;
  assert.deepEqual([p.byHidden, p.addedBy, p.addedFrom], [true, 'jarvis', 'a text from Leo'], 'still hidden after a restart, data kept');
  assert.equal(again.view(other)!.byHidden, false, 'only that row');
  assert.doesNotMatch(rowHtml(p, {}, NOW), /m-by/);
  assert.match(rowHtml(again.view(other)!, {}, NOW), /<div class="m-by"><span>Added by Jarvis from chat, [^<]+<\/span><button type="button" class="m-by-x" data-hide-by aria-label="Hide this line"/);
  assert.equal(migrationRoute(again, 'POST', '/api/migration/act', { id: 999, action: 'hide-by' })!.status, 404);
});

test('a database from before meeting times gains the new columns, empty', () => {
  const store = openStore(':memory:');
  store.db.exec(`CREATE TABLE migration_people (id INTEGER PRIMARY KEY, uid TEXT NOT NULL UNIQUE, name TEXT NOT NULL, dealer_id INTEGER NOT NULL, source TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'todo', note TEXT NOT NULL DEFAULT '', added_by TEXT NOT NULL, added_from TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')), status_at TEXT NOT NULL DEFAULT (datetime('now')), note_at TEXT, removed_at TEXT);
    CREATE TABLE migration_status_log (id INTEGER PRIMARY KEY, person_id INTEGER NOT NULL, status TEXT NOT NULL, by TEXT NOT NULL, at TEXT NOT NULL DEFAULT (datetime('now')));`);
  const t = setup(SAMPLE, store);
  const id = addId(t, { name: 'A', dealership: 'Dealer One' });
  assert.deepEqual([t.m.view(id)!.meetingAt, t.m.view(id)!.byHidden], [null, false]);
  createTables(store.db);
  assert.equal(t.m.status(id, { status: 'meeting', meetingAt: T }, 'owner').status, 200, 'and a second run changes nothing');
});

test('the brief lists Meeting set rows with their time, soonest first', () => {
  const t = setup();
  const a = addId(t, { name: 'Late', dealership: 'Dealer One', status: 'meeting', meetingAt: '2026-11-12T10:00-05:00' });
  const b = addId(t, { name: 'Soon', dealership: 'Dealer One', status: 'meeting', meetingAt: T });
  const lines = migrationBrief(t.m.state().people).split('\n');
  assert.equal(lines[0], 'Migration list, 0 to contact, 2 with a meeting set (jarvis-migration list shows everyone):');
  assert.deepEqual(lines.slice(1), [`- [migration meeting] id=${b} "Soon" dealership="Dealer One" at=2026-11-07T15:00:00Z`, `- [migration meeting] id=${a} "Late" dealership="Dealer One" at=2026-11-12T15:00:00Z`]);
});

test('the CLI sets and moves a meeting time', async () => {
  const t = setup();
  const server = http.createServer(async (req, res) => {
    let s = ''; for await (const c of req) s += c;
    const r = migrationRoute(t.m, req.method!, req.url!, s ? JSON.parse(s) : {});
    res.writeHead(r?.status ?? 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify(r?.body ?? { error: 'not found' }));
  }).listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const bin = fileURLToPath(new URL('../bin/jarvis-migration', import.meta.url));
  const cli = (...args: string[]) => new Promise<{ code: number; out: string; err: string }>(resolve => execFile(bin, args, { env: { ...process.env, JARVIS_URL: url } }, (e, out, err) => resolve({ code: e ? (e.code as number) : 0, out, err })));
  try {
    const added = JSON.parse((await cli('add', '--name', 'Max', '--dealership', 'Dealer One', '--source', 'email', '--from', 'chat', '--status', 'meeting', '--at', T)).out);
    assert.equal(added.meetingAt, '2026-11-07T15:00:00Z');
    assert.equal(JSON.parse((await cli('meeting', String(added.id), '--at', '2026-11-09T09:30-05:00')).out).meetingAt, '2026-11-09T14:30:00Z');
    const other = JSON.parse((await cli('add', '--name', 'Julie', '--dealership', 'Dealer One', '--source', 'text', '--from', 'chat')).out).id;
    assert.equal(JSON.parse((await cli('set-status', String(other), '--status', 'meeting', '--at', T)).out).meetingAt, '2026-11-07T15:00:00Z');
    assert.equal((await cli('meeting', String(other))).code, 2, '--at is required');
    const bad = await cli('meeting', String(other), '--at', 'friday');
    assert.equal(bad.code, 1);
    assert.match(bad.err, /ISO time with its zone/);
  } finally { server.close(); }
});

// ---- the page: times, order, picker ----
test('the time since the last status change is a short number', () => {
  const at = (min: number) => new Date(NOW - min * 60_000).toISOString();
  assert.deepEqual([0.5, 12, 59, 60, 300, 1439, 1440, 4320, 13000].map(m => since(at(m), NOW)), ['now', '12m', '59m', '1h', '5h', '23h', '1d', '3d', '9d']);
  const html = rowHtml(person({ statusAt: at(4320), status: 'contacted', statusWords: 'Contacted' }), {}, NOW);
  assert.match(html, /<span class="m-age" title="Contacted since Nov 3" aria-label="Contacted since Nov 3">3d<\/span>/);
});

test('meeting times read in Eastern, on the hour or with minutes, and say when they have passed', () => {
  // NOW is Friday Nov 6 2026, noon Eastern (EST, UTC-5).
  assert.deepEqual(meetingWords('2026-11-07T15:00:00Z', NOW), { past: false, short: 'tomorrow 10 a.m.', row: 'Tomorrow 10 a.m.' });
  assert.equal(meetingWords('2026-11-06T19:30:00Z', NOW).row, 'Today 2:30 p.m.');
  assert.equal(meetingWords('2026-11-10T19:00:00Z', NOW).row, 'Tue Nov 10, 2 p.m.');
  assert.deepEqual(meetingWords('2026-11-05T19:00:00Z', NOW), { past: true, short: 'yesterday 2 p.m.', row: 'Was yesterday 2 p.m.' });
  assert.equal(meetingWords('2026-11-07T04:30:00Z', NOW).row, 'Today 11:30 p.m.', 'late evening Eastern is still today, though UTC is the next day');
});

test('the day and time fields turn into an ISO time with the right Eastern offset, and back', () => {
  assert.equal(easternIso('2026-11-09', '09:30'), '2026-11-09T09:30-05:00');
  assert.equal(easternIso('2026-06-02', '10:00'), '2026-06-02T10:00-04:00', 'summer time');
  assert.equal(easternIso('2026-03-08', '12:00'), '2026-03-08T12:00-04:00', 'the day clocks go forward');
  assert.equal(easternIso('2026-11-01', '00:30'), '2026-11-01T00:30-04:00', 'before the fall change');
  assert.equal(easternIso('', '09:30'), '');
  assert.equal(easternIso('2026-11-09', ''), '');
  assert.equal(meetingOf(easternIso('2026-11-09', '09:30')), '2026-11-09 14:30:00', 'the daemon reads what the page sends');
  assert.deepEqual(easternFields('2026-11-09T14:30:00Z'), { date: '2026-11-09', time: '09:30' });
  assert.deepEqual(easternFields('2026-06-02T14:00:00Z'), { date: '2026-06-02', time: '10:00' });
  assert.equal(readBack('2026-11-09', NOW), '<b>Monday</b>, in 3 days');
  assert.equal(readBack('2026-11-07', NOW), '<b>Saturday</b>, tomorrow');
  assert.equal(readBack('2026-11-06', NOW), '<b>Friday</b>, today');
  assert.equal(readBack('2026-11-02', NOW), '<b>Monday</b>, 4 days ago');
  assert.equal(readBack('', NOW), '');
});

test('the order: To contact, then meetings soonest first (no time, then past, then ahead), then Contacted, longest silence first', () => {
  const at = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
  const list = [
    person({ id: 1, name: 'Contacted new', status: 'contacted', statusAt: at(2) }),
    person({ id: 2, name: 'Meeting Tue', status: 'meeting', meetingAt: '2026-11-10T19:00:00Z' }),
    person({ id: 3, name: 'Todo new', status: 'todo', statusAt: at(1) }),
    person({ id: 4, name: 'Meeting past', status: 'meeting', meetingAt: '2026-11-05T19:00:00Z' }),
    person({ id: 5, name: 'Todo old', status: 'todo', statusAt: at(200) }),
    person({ id: 6, name: 'Meeting tomorrow', status: 'meeting', meetingAt: '2026-11-07T15:00:00Z' }),
    person({ id: 7, name: 'Contacted old', status: 'contacted', statusAt: at(150) }),
    person({ id: 8, name: 'Meeting no time', status: 'meeting', meetingAt: null }),
    person({ id: 9, name: 'Moved', status: 'migrated', statusAt: at(5) }),
  ];
  assert.deepEqual(order(list).map(p => p.id), [5, 3, 8, 4, 6, 2, 7, 1, 9]);
  assert.deepEqual(groups(list).map(g => g.title), ['To contact', 'Meeting set', 'Contacted', 'Migrated']);
  const html = listHtml(list, {}, NOW);
  assert.ok(html.indexOf('<b>To contact</b>') < html.indexOf('<b>Meeting set</b>'));
  assert.ok(html.indexOf('<b>Meeting set</b>') < html.indexOf('<b>Contacted</b>'));
  assert.ok(html.indexOf('Meeting tomorrow') < html.indexOf('Meeting Tue'));
  assert.doesNotMatch(listHtml([person({ status: 'todo' })], {}, NOW), /Meeting set<\/b>/, 'an empty status has no heading');
});

test('a meeting row shows its time as a button that moves it, a past one in red, and Pick a time without one', () => {
  const tomorrow = rowHtml(person({ status: 'meeting', statusWords: 'Meeting set', meetingAt: '2026-11-07T15:00:00Z' }), {}, NOW);
  assert.match(tomorrow, /<button type="button" class="m-when" data-pick-open aria-label="Meeting Tomorrow 10 a\.m\.\. Change the time"><svg[^]*?<\/svg>Tomorrow 10 a\.m\.<\/button>/);
  assert.doesNotMatch(tomorrow, /m-age/, 'a meeting row shows the meeting, not the time since');
  assert.match(rowHtml(person({ status: 'meeting', meetingAt: '2026-11-05T19:00:00Z' }), {}, NOW), /class="m-when past"[^>]*>.*Was yesterday 2 p\.m\./);
  assert.match(rowHtml(person({ status: 'meeting', meetingAt: null }), {}, NOW), /class="m-when chip"[^>]*>.*Pick a time</);
});

test('picking Meeting set opens the picker under the row while the status waits, outlined', () => {
  const p = person({ id: 4, name: 'Karim Haddad', status: 'contacted', statusWords: 'Contacted' });
  const html = rowHtml(p, { pick: { id: 4, mode: 'status', date: '', time: '', error: '' } }, NOW);
  assert.match(html, /class="m-item open"/);
  assert.match(html, /<div class="m-status pending" data-s="contacted">/);
  assert.match(html, /<option value="contacted" selected>/, 'the dropdown still says Contacted');
  assert.match(html, /<div class="m-popover"><div class="pk" data-picker><div class="pk-head">Meeting with Karim <span>Eastern<\/span>/);
  assert.match(html, /<input type="date" class="in" data-pick="date" value="" aria-label="Meeting day"><input type="time" class="in" data-pick="time" value="" step="300" aria-label="Meeting time, Eastern"><button type="button" class="act primary" data-pick-set disabled>Set<\/button>/);
  assert.match(html, /Stays Contacted until you set the time\. Cancel changes nothing\./);
  assert.match(html, /data-pick-cancel>Cancel</);
  const filled = pickerHtml({ date: '2026-11-09', time: '09:30' }, { set: true }, NOW);
  assert.match(filled, /data-pick-set>Set</, 'Set turns on once both are picked');
  assert.match(filled, /<b>Monday<\/b>, in 3 days/);
  const moving = rowHtml(person({ id: 4, status: 'meeting', meetingAt: '2026-11-09T14:30:00Z' }), { pick: { id: 4, mode: 'move', date: '2026-11-09', time: '09:30', error: 'Not set: x' } }, NOW);
  assert.doesNotMatch(moving, /pending|Stays/);
  assert.match(moving, /role="alert">Not set: x</);
});

test('the add form shows the picker for Meeting set only, and Add stays off until a day and time are picked', () => {
  const f = { name: 'Pierre', dealer: '1', other: '', source: 'email', status: 'meeting', date: '', time: '', note: '', error: '' };
  const html = addFormHtml([], f, NOW);
  assert.match(html, /<div class="pa-line two"><input type="date"/);
  assert.doesNotMatch(html, /data-pick-set/, 'Add does the saving');
  assert.match(html, /<button type="submit" class="act primary" disabled>Add/);
  assert.equal(addReady({ ...f, date: '2026-11-09' }), false);
  assert.equal(addReady({ ...f, date: '2026-11-09', time: '09:30' }), true);
  assert.match(addFormHtml([], { ...f, date: '2026-11-09', time: '09:30' }, NOW), /<button type="submit" class="act primary">Add/);
  assert.doesNotMatch(addFormHtml([], { ...f, status: 'todo' }, NOW), /data-pick/);
});

test('the button names the next meeting ahead within a week', () => {
  const list = [
    person({ id: 1, status: 'todo' }),
    person({ id: 2, name: 'Sophie Roy', status: 'meeting', meetingAt: '2026-11-05T19:00:00Z' }),
    person({ id: 3, name: 'Annie Côté', status: 'meeting', meetingAt: '2026-11-10T19:00:00Z' }),
    person({ id: 4, name: 'Max Tanner', dealership: 'Dealer Nine', status: 'meeting', meetingAt: '2026-11-07T15:00:00Z' }),
  ];
  assert.equal(nextMeeting(list, NOW)!.id, 4, 'the past one is not next');
  assert.deepEqual(migrationButton(list, NOW), { count: 1, aria: 'Leads, 1 to contact, meeting with Max Tanner tomorrow 10 a.m.' });
  assert.equal(migrationButton([person({ status: 'meeting', meetingAt: '2026-11-20T15:00:00Z' })], NOW).aria, 'Leads, nobody to contact', 'two weeks out is not named');
});

test('the meeting toast: its markup, its x, and the styles at 40 px on the Mac and 32 px on the phone', () => {
  const page = read('../web/index.html'), css = read('../web/app.css');
  const toast = page.slice(page.indexOf('<div class="mtoast-row">'), page.indexOf('<section id="pop-requests"'));
  assert.match(toast, /<div class="mtoast" id="mtoast" role="status" hidden>/);
  assert.match(toast, /<button type="button" class="mt-x" id="mtoast-x" aria-label="Close the meeting reminder"/);
  assert.equal((toast.match(/<button/g) ?? []).length, 1, 'the x is the only control');
  assert.doesNotMatch(toast, /<a |Open lead/, 'no Open lead link');
  assert.match(page, /meetingToast\(migration\.current\(\), \[\.\.\.migration\.toastClosed\(\), toastClosing\]/);
  // Hiding the toast can paint the next meeting of the day into it, so the x reads its meeting before the repaint.
  assert.match(page, /const \{ id, at \} = \$\('mtoast'\)\.dataset;\n  toastClosing = `\$\{id\}\|\$\{at\}`;\n  paintToast\(\);\n  try \{ await migration\.closeToast\(Number\(id\), at\); \}/);
  assert.match(page, /setInterval\(paintMigration, 60_000\)/);
  assert.match(css, /\.mtoast \{ position: absolute; top: 8px; right: 16px; [^}]*height: 40px;/);
  assert.match(css, /\.mt-x \{ position: relative; width: 32px; height: 32px;[^}]*\}\n\.mt-x::after \{ content: ""; position: absolute; inset: -6px; \}/, '32 + 2 x 6 = 44 px to tap');
  const phone = css.slice(css.indexOf('@media (max-width: 779.98px)'));
  assert.match(phone, /\.mtoast \{ top: 6px; right: 12px; [^}]*height: 32px;/);
  assert.match(phone, /\.mt-x \{ width: 28px; height: 28px; \}\n  \.mt-x::after \{ inset: -8px; \}/, '28 + 2 x 8 = 44 px to tap');
  assert.match(phone, /\.mt-shop \{ display: none; \}/, 'the phone names the first name only');
  for (const c of ['.m-line {', '.m-age {', '.m-when.past {', '.m-by-x {', '.pa-line {', '.m-popover {', '.m-head {', '.m-shop-head {']) assert.ok(css.includes(c), c);
});

// NOW is 2026-11-06 12:00 p.m. Eastern (17:00 UTC, standard time).
const meet = (f: object) => person({ status: 'meeting', statusWords: 'Meeting set', dealership: 'Dealer Eight', ...f });

test('the toast shows only on the Eastern day of the meeting, until an hour after it starts', () => {
  const t = meetingToast([meet({ id: 7, name: 'Max Tanner', meetingAt: '2026-11-06T17:50:00Z' })], [], NOW)!;
  assert.deepEqual(t, { key: '7|2026-11-06T17:50:00Z', id: 7, meetingAt: '2026-11-06T17:50:00Z', who: 'Max, Dealer Eight', first: 'Max', at: '12:50 p.m., in 50 min', aria: 'Meeting with Max Tanner, Dealer Eight, 12:50 p.m., in 50 min' });
  assert.equal(meetingToast([meet({ meetingAt: '2026-11-07T14:30:00Z' })], [], NOW), null, 'tomorrow: not the day before');
  assert.equal(meetingToast([meet({ meetingAt: '2026-11-09T14:30:00Z' })], [], NOW), null, 'next week: no');
  assert.equal(meetingToast([meet({ meetingAt: '2026-11-07T04:30:00Z' })], [], NOW)!.at, '11:30 p.m., in 11 h 30 min', 'tomorrow in UTC, still today in Eastern');
  assert.equal(meetingToast([meet({ meetingAt: '2026-11-07T05:30:00Z' })], [], NOW), null, '00:30 Eastern tomorrow');
  assert.equal(meetingToast([meet({ meetingAt: '2026-11-06T16:30:00Z' })], [], NOW)!.at, '11:30 a.m., started 30 min ago', 'a meeting under way stays');
  assert.equal(meetingToast([meet({ meetingAt: '2026-11-06T15:59:00Z' })], [], NOW), null, 'gone an hour after it starts');
  assert.equal(meetingToast([meet({ meetingAt: '2026-11-06T05:30:00Z' })], [], NOW), null, 'this morning, long past');
  assert.equal(meetingToast([meet({ status: 'contacted', meetingAt: '2026-11-06T18:00:00Z' })], [], NOW), null, 'only Meeting set rows');
  assert.equal(meetingToast([meet({ meetingAt: null })], [], NOW), null, 'Meeting set with no time yet');
  const two = [meet({ id: 1, name: 'Late', meetingAt: '2026-11-06T21:00:00Z' }), meet({ id: 2, name: 'Soon', meetingAt: '2026-11-06T18:00:00Z' })];
  assert.equal(meetingToast(two, [], NOW)!.first, 'Soon', 'the soonest wins');
});

test('the toast close hides that meeting only: a moved or another meeting shows again', () => {
  const max = meet({ id: 7, name: 'Max', meetingAt: '2026-11-06T18:00:00Z' });
  assert.equal(toastKey(max), '7|2026-11-06T18:00:00Z');
  assert.equal(meetingToast([max], [toastKey(max)], NOW), null, 'closed');
  assert.ok(meetingToast([{ ...max, meetingAt: '2026-11-06T19:00:00Z' }], [toastKey(max)], NOW), 'moved to 2 p.m.: shows again');
  const anna = meet({ id: 8, name: 'Anna', meetingAt: '2026-11-06T20:00:00Z' });
  assert.equal(meetingToast([max, anna], [toastKey(max)], NOW)!.first, 'Anna', 'the next meeting of the day takes its place');
  assert.ok(meetingToast([meet({ id: 9, meetingAt: '2026-11-06T18:00:00Z' })], [toastKey(max)], NOW), 'same time, other person');
});

test('the time to a meeting reads in minutes, then hours', () => {
  const at = (m: number) => untilWords(NOW + m * 60_000, NOW);
  assert.deepEqual([at(0), at(1), at(50), at(60), at(80), at(125), at(-10)], ['now', 'in 1 min', 'in 50 min', 'in 1 h', 'in 1 h 20 min', 'in 2 h 5 min', 'started 10 min ago']);
});

test('the daemon keeps the closed toasts with the migration data, so every page and a restart agree', () => {
  const store = openStore(':memory:');
  const t = setup(SAMPLE, store);
  const id = addId(t, { name: 'Max Tanner', dealership: 'Dealer One', status: 'meeting', meetingAt: '2026-11-06T13:50-05:00' });
  const view = t.m.state().people.find(p => p.id === id)!;
  assert.deepEqual(t.m.state().toastClosed, []);
  assert.ok(meetingToast(t.m.state().people, t.m.state().toastClosed, NOW), 'shows before the close');
  const before = t.changes();
  const r = migrationRoute(t.m, 'POST', '/api/migration/toast-close', { id, meetingAt: view.meetingAt })!;
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.migration.toastClosed, [toastKey(view)], 'the key the page builds');
  assert.equal(t.changes(), before + 1, 'the broadcast tells the other pages');
  assert.ok(t.logs.includes('migration meeting toast closed'));
  assert.equal(meetingToast(t.m.state().people, t.m.state().toastClosed, NOW), null);
  assert.equal(migrationRoute(t.m, 'POST', '/api/migration/toast-close', { id, meetingAt: view.meetingAt })!.body.migration.toastClosed.length, 1, 'a second close adds nothing');
  // A restart reads the same store.
  assert.deepEqual(setup(SAMPLE, store).m.state().toastClosed, [toastKey(view)]);
  // Moving the meeting brings the toast back.
  assert.equal(t.m.meeting(id, { meetingAt: '2026-11-06T15:00-05:00' }, 'owner').status, 200);
  assert.equal(meetingToast(t.m.state().people, t.m.state().toastClosed, NOW)!.at, '3 p.m., in 3 h');
});

test('the daemon refuses a close for a time that is not the current one, or a person with no meeting', () => {
  const t = setup();
  const id = addId(t, { name: 'Max', dealership: 'Dealer One', status: 'meeting', meetingAt: '2026-11-06T13:50-05:00' });
  const other = addId(t, { name: 'Anna', dealership: 'Dealer One' });
  const stale = t.m.closeToast({ id, meetingAt: '2026-11-06T12:00:00Z' });
  assert.equal(stale.status, 409);
  assert.match(stale.body.error, /moved/);
  assert.equal(t.m.closeToast({ id, meetingAt: 'tomorrow' }).status, 409);
  assert.equal(t.m.closeToast({ id: other, meetingAt: '2026-11-06T18:50:00Z' }).status, 404, 'To contact has no meeting');
  assert.equal(t.m.closeToast({ id: 999, meetingAt: '2026-11-06T18:50:00Z' }).status, 404);
  assert.deepEqual(t.m.state().toastClosed, [], 'nothing stored');
  assert.equal(t.m.closeToast({ id, meetingAt: '2026-11-06T13:50-05:00' }).status, 200, 'the same instant in another zone is the same meeting');
});

test('the daemon keeps the newest 50 closed toasts and reads a broken value as none', () => {
  const store = openStore(':memory:');
  const t = setup(SAMPLE, store);
  const id = addId(t, { name: 'Max', dealership: 'Dealer One', status: 'meeting', meetingAt: '2026-11-06T13:50-05:00' });
  store.setState('migrationToastClosed', JSON.stringify(Array.from({ length: 50 }, (_, i) => `old|${i}`)));
  t.m.closeToast({ id, meetingAt: '2026-11-06T18:50:00Z' });
  const kept = t.m.state().toastClosed;
  assert.equal(kept.length, 50);
  assert.equal(kept[0], 'old|1', 'the oldest goes');
  assert.equal(kept.at(-1), `${id}|2026-11-06T18:50:00Z`);
  store.setState('migrationToastClosed', '{not json');
  assert.deepEqual(t.m.state().toastClosed, []);
});

test('two or more people of one dealership in a status sit under one subheader; a lone one keeps the name on its row', () => {
  const at = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
  const list = [
    person({ id: 1, name: 'Ella', status: 'meeting', dealership: 'Dealer A', dealerKey: 'dealera', meetingAt: '2026-11-09T14:30:00Z' }),
    person({ id: 2, name: 'Kurt', status: 'meeting', dealership: 'Dealer A', dealerKey: 'dealera', meetingAt: '2026-11-09T15:30:00Z' }),
    person({ id: 3, name: 'Jules', status: 'todo', dealership: 'Dealer A', dealerKey: 'dealera', statusAt: at(5) }),
    person({ id: 4, name: 'Jody', status: 'contacted', dealership: 'Dealer B', dealerKey: 'ss', statusAt: at(9) }),
    person({ id: 5, name: 'Pete', status: 'contacted', dealership: 'Dealer C', dealerKey: 'pm', statusAt: at(8) }),
    person({ id: 6, name: 'Phil', status: 'contacted', dealership: 'Dealer B', dealerKey: 'ss', statusAt: at(7) }),
  ];
  assert.deepEqual(byDealership(groups(list)[2].people).map(r => r.person ? r.person.name : `${r.shop.dealership}: ${r.people.map(p => p.name).join(', ')}`),
    ['Dealer B: Jody, Phil', 'Pete'], 'the run sits where its first person was');
  const html = listHtml(list, {}, NOW);
  assert.match(html, /<li class="m-shop"><div class="m-shop-head"><b>Dealer A<\/b><span>2 people<\/span><\/div><ul class="m-list"><li class="m-item" data-id="1">/);
  const meeting = html.slice(html.indexOf('data-sec="meeting"'), html.indexOf('data-sec="contacted"'));
  assert.doesNotMatch(meeting, /class="m-sub"/, 'under the subheader a row does not repeat the dealership');
  const todo = html.slice(0, html.indexOf('data-sec="meeting"'));
  assert.doesNotMatch(todo, /m-shop/, 'Jules is alone at Dealer A within To contact');
  assert.match(todo, /<span class="m-sub" data-toggle>Dealer A<\/span>/);
  for (const id of [1, 2, 3, 4, 5, 6]) assert.match(html, new RegExp(`data-id="${id}"[^]*?data-status`), `person ${id} keeps the status dropdown`);
});

test('the source is an icon with a label, never the words, so a row is two lines: the name, then time, icon and dealership', () => {
  const mail = rowHtml(person({}), {}, NOW), text = rowHtml(person({ source: 'text', sourceWords: 'Text message' }), {}, NOW);
  assert.match(mail, /<span class="m-src" role="img" aria-label="Email" title="Email"><svg[^>]*aria-hidden="true"><rect/);
  assert.match(text, /<span class="m-src" role="img" aria-label="Text message" title="Text message"><svg[^>]*aria-hidden="true"><path d="M5 5h14/);
  assert.doesNotMatch(mail.replace(/<[^>]+>/g, '|'), /\|Email\|/, 'the word Email is not shown');
  assert.match(mail, /<button type="button" class="m-who" data-toggle aria-expanded="false"><span class="m-name">Max<\/span><\/button><div class="m-line"><span class="m-age"[^>]*>2h<\/span><span class="m-src"[^]*?<\/span><span class="m-sub" data-toggle>Dealer One<\/span><\/div>/);
});

// ---- edit mode: name, dealership, source and contact ----
test('the owner edits a person from the page: name, dealership by id, source and contact; status, note, history and uid stay', () => {
  const t = setup();
  const id = addId(t, { name: 'Samuel', dealership: 'Dealer One', note: 'Called' });
  t.m.status(id, { status: 'contacted' }, 'jarvis');
  const before = t.m.view(id)!;
  const bravo = t.m.state().dealers.find(d => d.name === 'Bravo Garage')!;
  const n = t.changes();
  const r = migrationRoute(t.m, 'POST', '/api/migration/act', { id, action: 'edit', name: '  Samuel   Thibault ', dealerId: bravo.id, source: 'text', contact: '581-232-9500' })!;
  assert.equal(r.status, 200, r.body.error);
  const p = r.body.person;
  assert.deepEqual([p.name, p.dealership, p.source, p.sourceWords, p.contact], ['Samuel Thibault', 'Bravo Garage', 'text', 'Text message', '581-232-9500']);
  assert.deepEqual([p.uid, p.status, p.note, p.statusAt, p.history], [before.uid, before.status, before.note, before.statusAt, before.history]);
  assert.equal(t.changes(), n + 1, 'the page and the phone redraw');
  assert.ok(t.logs.includes('migration person edited'));
  const again = migrationRoute(t.m, 'POST', '/api/migration/act', { id, action: 'edit', name: 'Samuel Thibault', dealerId: bravo.id, source: 'text', contact: '581-232-9500' })!;
  assert.equal(again.status, 200);
  assert.equal(t.changes(), n + 1, 'the same values change nothing and broadcast nothing');
  assert.equal(migrationRoute(t.m, 'POST', '/api/migration/act', { id, action: 'edit', contact: '' })!.body.person.contact, null, 'an empty contact clears it');
  assert.equal(migrationRoute(t.m, 'POST', '/api/migration/act', { id, action: 'edit', dealerId: 9999 })!.status, 400, 'a dealership id not on the list');
});

test('the brain edits through its route with a dealership from the list, and bad input changes nothing', () => {
  const t = setup();
  const id = addId(t, { name: 'Max', dealership: 'Dealer One' });
  const other = addId(t, { name: 'Lea', dealership: 'Bravo Garage' });
  const edit = (b: object) => migrationRoute(t.m, 'POST', `/api/internal/migration/${id}/edit`, b)!;
  const ok = edit({ dealership: 'charlie centre', contact: 'max@dealer.ca' });
  assert.equal(ok.status, 200, ok.body.error);
  assert.deepEqual([ok.body.person.dealership, ok.body.person.contact, ok.body.person.name], ['Charlie Centre', 'max@dealer.ca', 'Max'], 'a field left out stays');
  const was = t.m.view(id);
  const bad = edit({ dealership: 'Dealer Onn Inc' });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /not on the dealership list\. Close: Dealer One\./);
  assert.match(edit({ contact: 'call me' }).body.error, /phone number .* or an email/);
  assert.match(edit({ contact: '123' }).body.error, /phone number/, 'too few digits');
  assert.match(edit({ source: 'fax' }).body.error, /email or text/);
  assert.match(edit({ name: '  ' }).body.error, /name cannot be empty/);
  assert.match(edit({}).body.error, /nothing to change/);
  assert.match(edit({ dealerId: 1 }).body.error, /nothing to change/, 'the brain cannot pick by id');
  const dup = edit({ name: 'lea', dealership: 'Bravo Garage' });
  assert.equal(dup.status, 409, 'an edit never makes a duplicate');
  assert.match(dup.body.error, new RegExp(`Lea is already on the list at Bravo Garage \\(id ${other}\\)`));
  assert.deepEqual(t.m.view(id), was, 'every refusal left the row as it was');
  assert.equal(migrationRoute(t.m, 'POST', '/api/internal/migration/999/edit', { name: 'X' })!.status, 404);
});

test('a contact is a phone number or an email, kept as typed, and add takes one too', () => {
  for (const c of ['581-232-9500', '+1 (581) 232-9500', '581.232.9500 ext 12', 'Max@Dealer.ca']) assert.equal(contactOf(c), c, c);
  assert.equal(contactOf('  581  232 9500 '), '581 232 9500');
  for (const c of ['call me', '12-34', 'a@b', 'x'.repeat(121) + '@a.ca']) assert.equal(contactOf(c), undefined, c);
  const t = setup();
  assert.equal(t.m.add(jarvis({ name: 'Max', dealership: 'Dealer One', contact: '581-232-9500' }), 'jarvis').body.person.contact, '581-232-9500');
  assert.equal(t.m.add(jarvis({ name: 'Lea', dealership: 'Dealer One' }), 'jarvis').body.person.contact, null, 'optional');
  assert.equal(t.m.add(jarvis({ name: 'Zed', dealership: 'Dealer One', contact: 'nope' }), 'jarvis').status, 400);
});

test('a database made before contacts gains the column, empty', () => {
  const store = openStore(':memory:');
  setup(SAMPLE, store);
  store.db.exec('ALTER TABLE migration_people DROP COLUMN contact');
  createTables(store.db);
  assert.ok((store.db.prepare('PRAGMA table_info(migration_people)').all() as { name: string }[]).some(c => c.name === 'contact'));
});

test('the real CLI edits a person and adds one with a contact, with the same dealership check as add', async () => {
  const t = setup();
  const server = http.createServer(async (req, res) => {
    let s = ''; for await (const c of req) s += c;
    const r = migrationRoute(t.m, req.method!, req.url!, s ? JSON.parse(s) : {});
    res.writeHead(r?.status ?? 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify(r?.body ?? { error: 'not found' }));
  }).listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const bin = fileURLToPath(new URL('../bin/jarvis-migration', import.meta.url));
  const cli = (...args: string[]) => new Promise<{ code: number; out: string; err: string }>(resolve => execFile(bin, args, { env: { ...process.env, JARVIS_URL: url } }, (e, out, err) => resolve({ code: e ? (e.code as number) : 0, out, err })));
  try {
    const added = await cli('add', '--name', 'Samuel', '--dealership', 'Dealer One', '--source', 'text', '--from', 'chat', '--contact', 'sam@dealer.ca');
    assert.equal(added.code, 0, added.err);
    const id = String(JSON.parse(added.out).id);
    assert.equal(JSON.parse(added.out).contact, 'sam@dealer.ca');
    const e = await cli('edit', id, '--name', 'Samuel Thibault', '--contact', '581-232-9500');
    assert.equal(e.code, 0, e.err);
    assert.deepEqual([JSON.parse(e.out).name, JSON.parse(e.out).contact, JSON.parse(e.out).dealership], ['Samuel Thibault', '581-232-9500', 'Dealer One']);
    const moved = await cli('edit', id, '--dealership', 'bravo garage', '--source', 'email');
    assert.deepEqual([JSON.parse(moved.out).dealership, JSON.parse(moved.out).source], ['Bravo Garage', 'email']);
    const nowhere = await cli('edit', id, '--dealership', 'Nowhere');
    assert.equal(nowhere.code, 1);
    assert.match(JSON.parse(nowhere.err).error, /not on the dealership list/);
    assert.equal(JSON.parse((await cli('edit', id, '--contact', '')).out).contact, null, 'an empty --contact clears it');
    const none = await cli('edit', id);
    assert.equal(none.code, 2);
    assert.match(none.err, /at least one of --name/);
    assert.equal((await cli('edit', 'abc', '--name', 'X')).code, 2);
    assert.equal(JSON.parse((await cli('list')).out)[0].name, 'Samuel Thibault');
  } finally { server.close(); }
});

test('an open row shows the contact as a link and a small pencil Edit; edit mode shows the fields, Save and Cancel', () => {
  const dealers = [{ id: 1, name: 'Dealer One', key: 'k', onSheet: true }, { id: 2, name: 'Kia <Matane>', key: 'kia', onSheet: true }];
  const closed = rowHtml(person({ contact: '581-232-9500' }), {}, NOW);
  assert.doesNotMatch(closed, /data-edit|m-contact/, 'a closed row stays as light as before');
  const open = rowHtml(person({ contact: '581-232-9500' }), { open: 1 }, NOW);
  assert.match(open, /<a class="m-contact" href="tel:5812329500"><svg[^]*?<\/svg><span>581-232-9500<\/span><\/a><button type="button" class="m-edit-btn" data-edit aria-label="Edit Max"><svg[^]*?<\/svg>Edit<\/button>/);
  assert.match(rowHtml(person({ contact: 'a@b.ca' }), { open: 1 }, NOW), /href="mailto:a@b\.ca"/);
  assert.doesNotMatch(rowHtml(person({}), { open: 1 }, NOW), /m-contact/, 'no contact, no line');
  assert.match(contactHtml('x"<y>@a.ca'), /x&quot;&lt;y&gt;@a\.ca/);
  const edit = { id: 1, name: 'Sam <b>', dealer: '2', source: 'text', contact: '581', error: 'Not saved: bad' };
  const html = rowHtml(person({}), { open: 1, edit, dealers }, NOW);
  assert.match(html, /data-e="name" value="Sam &lt;b&gt;"/);
  assert.match(html, /<option value="2" selected>Kia &lt;Matane&gt;<\/option>/);
  assert.doesNotMatch(html, /Other\.\.\./, 'edit picks from the list only');
  assert.match(html, /data-esrc="text" aria-pressed="true" class="on"/);
  assert.match(html, /data-e="contact" value="581"/);
  assert.match(html, /data-edit-save>Save<[^]*data-edit-cancel>Cancel</);
  assert.match(html, /role="alert">Not saved: bad</);
  assert.doesNotMatch(html, /data-note|data-remove/, 'edit mode replaces the note panel');
  assert.match(addFormHtml(dealers, { name: '', dealer: '', source: 'email', status: 'todo', note: '', contact: '' }, NOW), /data-f="contact"/);
});

test('Cancel in edit mode keeps the row: no tap there removes, and a Remove asked before edit mode does not carry over', () => {
  const s: any = { open: 1, edit: null, confirmRemove: false };
  // Simon's path: Remove tapped (or landed on) once, then Edit, then Cancel, then a tap on the same spot.
  assert.equal(rowTap('data-remove', s, 1, NOW), 'draw');
  assert.equal(rowTap('data-edit', s, 1, NOW + 1000), 'edit');
  assert.equal(s.confirmRemove, 0, 'Edit clears the pending confirm');
  s.edit = { id: 1, name: 'Max', dealer: '1', source: 'email', contact: '', error: '' };
  assert.equal(rowTap('data-remove', s, 1, NOW + 1100), 'none', 'no Remove in edit mode');
  assert.equal(rowTap('data-remove-yes', s, 1, NOW + 1200), 'none');
  assert.equal(rowTap('data-edit-cancel', s, 1, NOW + 1300), 'draw');
  assert.deepEqual([s.open, s.edit, s.confirmRemove], [1, null, 0], 'the row stays open, out of edit mode, nothing armed');
  assert.equal(rowTap('data-remove-yes', s, 1, NOW + 5000), 'none', 'a confirm tap with nothing asked removes nothing');
  const html = rowHtml(person({}), s, NOW);
  assert.match(html, /data-remove>Remove</);
  assert.doesNotMatch(html, /data-remove-yes/);
  // Every tap the edit form has, in any order, never says remove.
  const s2: any = { open: 1, edit: { id: 1 }, confirmRemove: false };
  for (const t of ['data-edit-save', 'data-esrc', 'data-edit-cancel', 'data-cancel']) assert.notEqual(rowTap(t, s2, 1, NOW), 'remove', t);
});

test('Remove asks first, and a double tap or a tap within the wait removes nothing', () => {
  const s: any = { open: 1, edit: null, confirmRemove: false };
  assert.equal(rowTap('data-remove', s, 1, NOW), 'draw');
  assert.equal(rowTap('data-remove-yes', s, 1, NOW + 100), 'none', 'too soon: a double tap');
  assert.equal(rowTap('data-remove-yes', s, 2, NOW + REMOVE_WAIT_MS), 'none', 'another row');
  assert.equal(rowTap('data-remove-yes', s, 1, NOW + REMOVE_WAIT_MS), 'remove');
  assert.equal(rowTap('data-remove-keep', s, 1, NOW), 'draw');
  assert.equal(s.confirmRemove, 0, 'Keep disarms');
  assert.equal(rowTap('data-remove', { open: 2, confirmRemove: false }, 1, NOW), 'none', 'Remove on a closed row');
  assert.ok(ROW_TAPS.indexOf('data-edit-cancel') >= 0 && ROW_TAPS.indexOf('data-remove-yes') >= 0, 'the handler checks both');
  assert.match(read('../web/migration.js'), /rowTap\(tap, s, id\)/, 'the click handler goes through rowTap');
  assert.doesNotMatch(read('../web/migration.js'), /act\(id, 'remove'\)[^]*act\(id, 'remove'\)/, 'one path to remove');
});

test('the brain\'s file lists the edit verb and --contact', () => {
  const v = read('../vault/CLAUDE.md').split('## Migration list')[1].split('\n## ')[0];
  assert.match(v, /jarvis-migration edit <id> \[--name/);
  assert.match(v, /--contact/);
  assert.match(read('../bin/jarvis-migration'), /cmd === 'edit'/);
});
