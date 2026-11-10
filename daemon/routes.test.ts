// The concept routes main.ts tries in turn, each tested through its route() with a fake request, as nativeroutes.test.ts does.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from './store.ts';
import { lazyBody } from './route.ts';
import { pushRoute } from './push.ts';
import { requestsRoute } from './requests.ts';
import { reportsRoute } from './reports.ts';
import { brainModelRoute } from './brainmodel.ts';
import { messagesRoute } from './messages.ts';
import { brainAskRoute } from './brainasks.ts';
import { askRoute, askCard } from './asks.ts';

const body = (v: unknown) => async () => v;
const none = () => { throw new Error('the route read a body it does not need'); };

test('lazyBody reads the request once, and only when a route asks', async () => {
  let reads = 0;
  const b = lazyBody(async () => { reads++; return { a: 1 }; });
  assert.equal(reads, 0);
  assert.deepEqual(await b(), { a: 1 });
  await b();
  assert.equal(reads, 1);
});

test('push: the key, a subscribe that checks its shape, an unsubscribe, and a test push past quiet hours', async () => {
  const store = openStore(':memory:');
  const pushed: unknown[] = [];
  const o = { store, publicKey: 'PUB', log: () => {}, notify: async (m: unknown, opts: unknown) => { pushed.push([m, opts]); return 1; } };
  assert.deepEqual(await pushRoute(o, 'GET', '/api/push/key', none), { status: 200, body: { publicKey: 'PUB' } });
  assert.equal((await pushRoute(o, 'POST', '/api/push/subscribe', body({ endpoint: 'http://plain.test/x', keys: { p256dh: 'p', auth: 'a' } })))?.status, 400, 'only https endpoints');
  const sub = { endpoint: 'https://push.test/x', keys: { p256dh: 'p', auth: 'a' } };
  assert.equal((await pushRoute(o, 'POST', '/api/push/subscribe', body(sub), 'agent'))?.status, 204);
  assert.equal(store.pushSubs().length, 1);
  assert.equal((await pushRoute(o, 'POST', '/api/push/unsubscribe', body({ endpoint: sub.endpoint })))?.status, 204);
  assert.equal(store.pushSubs().length, 0);
  assert.deepEqual(await pushRoute(o, 'POST', '/api/push/test', none), { status: 200, body: { reached: 1 } });
  assert.deepEqual((pushed[0] as any)[1], { urgent: true });
  assert.equal(await pushRoute(o, 'GET', '/api/requests', none), undefined, 'another concept\'s URL is not answered');
});

test('requests: the list, hide, and a report that is not stored', async () => {
  const store = openStore(':memory:');
  const hidden: number[] = [];
  const requests = { list: () => [{ id: 3 }] as any, hide: (id: number) => { hidden.push(id); return id === 3; } };
  assert.deepEqual(await requestsRoute({ requests, store }, 'GET', '/api/requests', none), { status: 200, body: [{ id: 3 }] });
  assert.equal((await requestsRoute({ requests, store }, 'POST', '/api/requests/hide', body({ id: '3' })))?.status, 204);
  assert.equal((await requestsRoute({ requests, store }, 'POST', '/api/requests/hide', body({ id: 4 })))?.status, 404);
  assert.deepEqual(hidden, [3, 4]);
  assert.equal((await requestsRoute({ requests, store }, 'GET', '/api/requests/9/report', none))?.status, 404);
  assert.equal(await requestsRoute({ requests, store }, 'GET', '/api/requests/x/report', none), undefined);
});

test('reports: the list and one file, and nothing outside data/reports', () => {
  const dir = mkdtempSync(join(tmpdir(), 'reports-'));
  writeFileSync(join(dir, 'a.md'), '# Audit\n\nBody.');
  const list = reportsRoute(dir, 'GET', '/api/reports', new URLSearchParams());
  assert.equal(list?.status, 200);
  assert.equal((list?.body as any[]).length, 1);
  assert.equal(reportsRoute(dir, 'GET', '/api/reports/file', new URLSearchParams({ path: join(dir, 'a.md') }))?.status, 200);
  assert.equal(reportsRoute(dir, 'GET', '/api/reports/file', new URLSearchParams({ path: '/etc/hosts' }))?.status, 404);
  assert.equal(reportsRoute(dir, 'POST', '/api/reports', new URLSearchParams()), undefined);
});

test('brain model: GET reads it, a bad POST changes nothing, a busy brain refuses', async () => {
  let changed = 0;
  const brain = { busy: false, setting: { model: 'claude-opus-5-5', effort: 'medium' } as any, switchModel: async () => undefined };
  const o = { brain, setState: () => {}, killed: () => false, info: () => ({ model: brain.setting.model }), changed: () => { changed++; } };
  assert.deepEqual(await brainModelRoute(o, 'GET', '/api/brain/model', none), { status: 200, body: { model: 'claude-opus-5-5' } });
  assert.equal((await brainModelRoute(o, 'POST', '/api/brain/model', body({ model: 'gpt-x' })))?.status, 400);
  brain.busy = true;
  assert.equal((await brainModelRoute(o, 'POST', '/api/brain/model', body({ model: 'claude-opus-5-5', effort: 'high' })))?.status, 409);
  assert.equal(changed, 0);
  assert.equal(await brainModelRoute(o, 'GET', '/api/push/key', none), undefined);
});

test('messages: Send reply tells the brain the approval, I\'ll handle it tells it the close, and bad input is refused', async () => {
  const told: string[] = [];
  const messages = {
    send: async (id: string, text: string) => ({ status: 200, body: { approval: { id: 7, action: 'gmail-send', text } as any } }),
    handled: (id: string) => ({ status: id === 'gmail:1' ? 200 : 404, body: {} }),
    add: (b: any) => ({ status: 200, body: { id: `outbox:${b.to}` } }),
  } as any;
  const o = { messages, approved: (a: any) => told.push(`approved ${a.id}`), handled: (id: string) => told.push(`handled ${id}`) };
  assert.equal((await messagesRoute(o, 'POST', '/api/message/send', body({ id: 'gmail:1' })))?.status, 400);
  assert.equal((await messagesRoute(o, 'POST', '/api/message/send', body({ id: 'gmail:1', text: 'Merci' })))?.status, 200);
  assert.equal((await messagesRoute(o, 'POST', '/api/message/handled', body({ id: 'gmail:1' })))?.status, 200);
  assert.equal((await messagesRoute(o, 'POST', '/api/message/handled', body({ id: 'gmail:2' })))?.status, 404);
  assert.deepEqual(told, ['approved 7', 'handled gmail:1']);
  assert.deepEqual(await messagesRoute(o, 'POST', '/api/internal/messages', body({ to: 'Sam' })), { status: 200, body: { id: 'outbox:Sam' } });
  assert.equal(await messagesRoute(o, 'GET', '/api/message/send', none), undefined);
});

test('brain asks: an ask is stored and its card changes, ask-done closes it, a one-option ask is refused', async () => {
  const store = openStore(':memory:');
  const changed: string[] = [];
  const o = { store, log: () => {}, changed: (id: string) => { changed.push(id); } };
  const added = await brainAskRoute(o, 'POST', '/api/internal/ask', body({ question: 'Merge now?', options: ['Yes', 'No'] }));
  assert.equal(added?.status, 200);
  const id = (added?.body as any).id;
  assert.match(id, /^brain:/);
  assert.equal((await brainAskRoute(o, 'POST', '/api/internal/ask', body({ question: 'Merge?', options: ['Yes'] })))?.status, 400);
  assert.equal((await brainAskRoute(o, 'POST', '/api/internal/ask-done', body({ id, answer: 'Yes' })))?.status, 200);
  assert.deepEqual(changed, [id, id]);
  assert.equal(store.item(id)?.status, 'answered');
});

test('asks: a tap answers a native worker once, the audit log lists it, and the brain can mark an email answered', async () => {
  const store = openStore(':memory:');
  const seen: any = { changed: [], notes: [], replied: [], published: 0, synced: 0, emails: [] };
  const o = {
    store, log: () => {}, cardOf: (i: any) => i && askCard(i), pressed: new Set<string>(),
    native: { reply: async (id: string, text: string) => { seen.replied.push([id, text]); return { ok: true } as const; } },
    note: (n: string) => seen.notes.push(n), askChanged: (id: string) => seen.changed.push(id),
    publish: () => { seen.published++; }, sync: () => { seen.synced++; }, emailDone: (id: string) => seen.emails.push(id),
  };
  store.insertItem({ source: 'native', external_id: 'msg_1', kind: 'question', dispatch_id: 'n:w1', subject: 'Merge?', status: 'spoken' });
  assert.deepEqual(await askRoute(o, 'POST', '/api/ask/answer', body({ id: 'msg_1' })), { status: 400, body: { error: 'id and value are required' } });
  const r = await askRoute(o, 'POST', '/api/ask/answer', body({ id: 'msg_1', value: ' Yes ' }));
  assert.equal(r?.status, 200);
  assert.equal((r?.body as any).error, undefined);
  assert.equal((r?.body as any).ask.id, 'msg_1');
  assert.deepEqual(seen.replied, [['n:w1', 'Yes']]);
  assert.equal(seen.notes.length, 1);
  assert.deepEqual([seen.published, seen.synced], [1, 1]);
  assert.equal((await askRoute(o, 'POST', '/api/ask/answer', body({ id: 'msg_1', value: 'Yes' })))?.status, 409, 'never twice');
  assert.deepEqual([seen.published, seen.synced], [1, 1], 'a refused tap moves nothing on');
  assert.equal((await askRoute(o, 'POST', '/api/ask/answer', body({ id: 'nope', value: 'Yes' })))?.status, 404);
  const audit = await askRoute(o, 'GET', '/api/audit', none);
  assert.deepEqual((audit?.body as any[]).map(e => e.key), ['ask:msg_1']);
  store.insertItem({ source: 'gmail', external_id: 'gmail:1', kind: 'email', status: 'new' });
  assert.equal((await askRoute(o, 'POST', '/api/internal/answered', body({})))?.status, 400);
  assert.deepEqual(await askRoute(o, 'POST', '/api/internal/answered', body({ id: 'gmail:1', answer: 'sent' })), { status: 204 });
  assert.equal(store.item('gmail:1')?.status, 'answered');
  assert.deepEqual(seen.emails, ['gmail:1']);
  assert.deepEqual(seen.changed, ['msg_1', 'msg_1', 'nope', 'gmail:1']);
  assert.equal(await askRoute(o, 'GET', '/api/ask/answer', none), undefined);
});
