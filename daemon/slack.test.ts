import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openStore } from './store.ts';
import { decide, summary, messageOf, eventLine, makeSlack, slackRoute, readCounts, type Resolved, type Socket, type SlackStatus } from './slack.ts';

const off: () => SlackStatus = () => ({ state: 'off', detail: 'no tokens in .env', at: '' });
const route = (store: ReturnType<typeof openStore>, method: string, url: string, b: Record<string, unknown> = {}) =>
  slackRoute(store, () => {}, off, method, url, b)!;
const add = (store: ReturnType<typeof openStore>, action: string, kind: string, target: string, urgent = false) =>
  route(store, 'POST', '/api/internal/slack/rules', { action, kind, target, urgent });

function resolved(over: Partial<Resolved> & { text?: string; type?: string } = {}): Resolved {
  const type = over.type ?? 'channel';
  return {
    msg: { channel: 'C1', channelType: type, user: 'U2', text: over.text ?? 'hello', ts: '1.1' },
    im: type === 'im' || type === 'mpim', where: '#random', channelNames: ['c1', 'random'], who: 'Pat Smith', userNames: ['u2', 'pat', 'pat smith'],
    ...over,
  };
}

test('no rule drops the message, and a channel rule brings it', () => {
  const store = openStore(':memory:');
  assert.deepEqual(decide(store.slackRules(), resolved()), { notify: false, urgent: false });
  add(store, 'notify', 'channel', '#Random');
  const v = decide(store.slackRules(), resolved());
  assert.equal(v.notify, true);
  assert.equal(v.urgent, false);
});

test('a person rule beats a muted channel, and mute wins on the same level', () => {
  const store = openStore(':memory:');
  add(store, 'mute', 'channel', 'random');
  assert.equal(decide(store.slackRules(), resolved()).notify, false);
  add(store, 'notify', 'person', 'Pat');
  assert.equal(decide(store.slackRules(), resolved()).notify, true);
  assert.equal(decide(store.slackRules(), resolved({ userNames: ['u3', 'sam'] })).notify, false);
  add(store, 'mute', 'person', 'pat smith');
  assert.equal(decide(store.slackRules(), resolved()).notify, false);
});

test('dm * covers DMs and group DMs, never channels, and a DM rule beats it', () => {
  const store = openStore(':memory:');
  add(store, 'notify', 'dm', '*');
  assert.equal(decide(store.slackRules(), resolved({ type: 'im', where: 'DM' })).notify, true);
  assert.equal(decide(store.slackRules(), resolved({ type: 'mpim', where: 'group DM' })).notify, true);
  assert.equal(decide(store.slackRules(), resolved()).notify, false);
  add(store, 'mute', 'dm', 'pat');
  assert.equal(decide(store.slackRules(), resolved({ type: 'im' })).notify, false);
  assert.equal(decide(store.slackRules(), resolved({ type: 'im', userNames: ['u9', 'sam'] })).notify, true);
});

test('urgent comes from the rule flag or from the message words', () => {
  const store = openStore(':memory:');
  add(store, 'notify', 'channel', 'random');
  assert.equal(decide(store.slackRules(), resolved({ text: 'lunch?' })).urgent, false);
  assert.equal(decide(store.slackRules(), resolved({ text: 'Need this ASAP' })).urgent, true);
  assert.equal(decide(store.slackRules(), resolved({ text: "C'est une urgence" })).urgent, true);
  add(store, 'notify', 'person', 'pat', true);
  assert.equal(decide(store.slackRules(), resolved({ text: 'lunch?' })).urgent, true);
});

test('summary turns Slack markup into one plain line', () => {
  const names = new Map([['U2', 'Pat Smith']]);
  assert.equal(summary('Hi <@U2>, see <#C9|support> and <https://x.test|the doc>\n\n<!here> a &amp; b', names), 'Hi @Pat Smith, see #support and the doc @here a & b');
  assert.equal(summary(''), '(no text)');
  assert.equal(summary('x'.repeat(300)).length, 160);
});

test('the event line has who, where, urgent and the summary', () => {
  assert.equal(eventLine(resolved({ text: 'Can you\ncall?' }), { notify: true, urgent: true }), '- [slack] from="Pat Smith" where="#random" urgent=true summary="Can you call?"');
});

test('edits, deletes, bots and the owner\'s own messages never reach the rules', () => {
  const base = { type: 'message', channel: 'C1', channel_type: 'channel', user: 'U2', text: 'hi', ts: '1.1' };
  assert.ok(messageOf(base, 'U1'));
  assert.equal(messageOf({ ...base, user: 'U1' }, 'U1'), undefined);
  assert.equal(messageOf({ ...base, subtype: 'message_changed' }, 'U1'), undefined);
  assert.equal(messageOf({ ...base, subtype: 'message_deleted' }, 'U1'), undefined);
  assert.equal(messageOf({ ...base, bot_id: 'B1' }, 'U1'), undefined);
  assert.ok(messageOf({ ...base, subtype: 'thread_broadcast' }, 'U1'));
  assert.equal(messageOf({ ...base, thread_ts: '0.5' }, 'U1')!.thread, '0.5');
});

/** A Slack with a fake Web API and fake sockets. `sockets` gets each socket jarvisd opens. */
function fakeSlack(opts: { authError?: string } = {}) {
  const store = openStore(':memory:');
  const calls: string[] = [];
  const matches: { line: string; urgent: boolean; summary: string }[] = [];
  const timers: (() => void)[] = [];
  const sockets: (Socket & { sent: string[]; emit(type: string, e?: any): void; closed: boolean })[] = [];
  const slack = makeSlack({
    store, log: () => {}, userToken: 'xoxp-1', appToken: 'xapp-1',
    api: async (method, params, token) => {
      calls.push(`${method} ${token}`);
      if (method === 'auth.test') { if (opts.authError) throw new Error(`slack auth.test: ${opts.authError}`); return { ok: true, user_id: 'U1' }; }
      if (method === 'apps.connections.open') return { ok: true, url: `wss://fake/${sockets.length}` };
      if (method === 'users.info') return { ok: true, user: { id: params.user, name: 'pat', real_name: 'Pat Smith', profile: { real_name: 'Pat Smith', display_name: 'Pat' } } };
      if (method === 'conversations.info') return { ok: true, channel: params.channel.startsWith('D') ? { id: params.channel, is_im: true, user: 'U2' } : { id: params.channel, name: 'support' } };
      throw new Error(`unexpected ${method}`);
    },
    socket: () => {
      const fns: Record<string, ((e: any) => void)[]> = {};
      const s = {
        sent: [] as string[], closed: false,
        send(d: string) { s.sent.push(d); }, close() { s.closed = true; },
        addEventListener(t: string, fn: (e: any) => void) { (fns[t] ??= []).push(fn); },
        emit(t: string, e: any = {}) { for (const fn of fns[t] ?? []) fn(e); },
      };
      sockets.push(s);
      return s;
    },
    onMatch: (line, _r, v, sum) => matches.push({ line, urgent: v.urgent, summary: sum }),
    setTimeout: ((fn: () => void) => { timers.push(fn); return 0; }) as any,
  });
  const settle = () => new Promise(r => setImmediate(r));
  const event = (envelope: string, ev: Record<string, unknown>) =>
    sockets.at(-1)!.emit('message', { data: JSON.stringify({ type: 'events_api', envelope_id: envelope, payload: { event: { type: 'message', ts: '1.1', ...ev } } }) });
  return { store, slack, calls, matches, timers, sockets, settle, event };
}

test('the client connects, acks every envelope, and sends only matches to the brain', async () => {
  const f = fakeSlack();
  f.slack.start();
  await f.settle();
  assert.deepEqual(f.calls.slice(0, 2), ['auth.test xoxp-1', 'apps.connections.open xapp-1']);
  f.sockets[0].emit('message', { data: JSON.stringify({ type: 'hello' }) });
  assert.equal(f.slack.status().state, 'connected');

  f.event('e1', { channel: 'C5', channel_type: 'channel', user: 'U2', text: 'nobody asked' });
  await f.settle();
  assert.deepEqual(f.matches, []);
  assert.equal(readCounts(f.store).dropped, 1);

  add(f.store, 'notify', 'channel', 'support');
  f.event('e2', { channel: 'C5', channel_type: 'channel', user: 'U2', text: 'Site down, ASAP', ts: '2.2' });
  await f.settle();
  assert.equal(f.matches.length, 1);
  assert.equal(f.matches[0].line, '- [slack] from="Pat Smith" where="#support" urgent=true summary="Site down, ASAP"');
  assert.equal(f.matches[0].summary, 'Site down, ASAP');

  f.event('e3', { channel: 'C5', channel_type: 'channel', user: 'U2', text: 'Site down, ASAP', ts: '2.2' }); // a redelivery
  f.event('e4', { channel: 'C5', channel_type: 'channel', user: 'U1', text: 'my own', ts: '3.3' });
  await f.settle();
  assert.equal(f.matches.length, 1);
  assert.deepEqual(f.sockets[0].sent.map(s => JSON.parse(s).envelope_id), ['e1', 'e2', 'e3', 'e4']);
  assert.deepEqual({ ...readCounts(f.store), since: '' }, { matched: 1, dropped: 1, muted: 0, since: '' });
  assert.equal(f.calls.filter(c => c.startsWith('users.info')).length, 1, 'names are read once');
});

test('a DM matches dm * and names the place DM', async () => {
  const f = fakeSlack();
  add(f.store, 'notify', 'dm', '*');
  f.slack.start();
  await f.settle();
  f.event('e1', { channel: 'D7', channel_type: 'im', user: 'U2', text: 'got a minute?' });
  await f.settle();
  assert.equal(f.matches[0].line, '- [slack] from="Pat Smith" where="DM" urgent=false summary="got a minute?"');
});

test('a disconnect or a closed socket opens a new connection, and stop ends it', async () => {
  const f = fakeSlack();
  f.slack.start();
  await f.settle();
  f.sockets[0].emit('message', { data: JSON.stringify({ type: 'disconnect', reason: 'refresh_requested' }) });
  assert.equal(f.sockets[0].closed, true);
  assert.equal(f.timers.length, 1);
  f.timers.shift()!();
  await f.settle();
  assert.equal(f.sockets.length, 2);
  f.sockets[1].emit('close');
  f.timers.shift()!();
  await f.settle();
  assert.equal(f.sockets.length, 3);
  f.slack.stop();
  f.sockets[2].emit('close');
  assert.equal(f.timers.length, 0);
  assert.equal(f.slack.status().state, 'off');
});

test('a bad token stops the client instead of retrying forever', async () => {
  const f = fakeSlack({ authError: 'invalid_auth' });
  f.slack.start();
  await f.settle();
  assert.equal(f.slack.status().state, 'failed');
  assert.match(f.slack.status().detail!, /auth failed/);
  assert.equal(f.timers.length, 0);
  assert.equal(f.sockets.length, 0);
});

test('the rule routes refuse bad input and duplicates', () => {
  const store = openStore(':memory:');
  assert.equal(add(store, 'notify', 'channel', '#Support').status, 200);
  assert.equal(store.slackRules()[0].target, 'support');
  assert.equal(add(store, 'notify', 'channel', 'support').status, 409);
  assert.equal(add(store, 'shout', 'channel', 'x').status, 400);
  assert.equal(add(store, 'notify', 'team', 'x').status, 400);
  assert.equal(add(store, 'notify', 'channel', ' ').status, 400);
  assert.equal(add(store, 'notify', 'channel', '*').status, 400);
  assert.equal(add(store, 'mute', 'channel', 'random', true).status, 400);
  assert.equal(store.slackRules().length, 1);
  assert.equal(route(store, 'POST', '/api/internal/slack/rules/99/remove').status, 404);
  assert.equal(route(store, 'GET', '/api/internal/slack/nope'), undefined);
});

/** Runs the real CLI against the real routes on a test port. */
async function cli(store: ReturnType<typeof openStore>, ...args: string[]) {
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const r = slackRoute(store, () => {}, off, req.method!, req.url!, raw ? JSON.parse(raw) : {});
    res.writeHead(r?.status ?? 404);
    res.end(JSON.stringify(r?.body ?? {}));
  });
  await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok));
  const port = (server.address() as { port: number }).port;
  const bin = fileURLToPath(new URL('../bin/jarvis-slack', import.meta.url));
  try {
    return await new Promise<{ code: number; out: string; err: string }>(ok =>
      execFile(process.execPath, [bin, ...args], { env: { ...process.env, JARVIS_URL: `http://127.0.0.1:${port}` } }, (e, out, err) => ok({ code: e ? Number(e.code) : 0, out, err })));
  } finally { server.close(); }
}

test('jarvis-slack adds, lists and removes rules through the routes', async () => {
  const store = openStore(':memory:');
  const a = await cli(store, 'add', 'notify', 'person', '@Pat', '--urgent');
  assert.equal(a.code, 0);
  const rule = JSON.parse(a.out);
  assert.deepEqual([rule.kind, rule.target, rule.action, rule.urgent], ['person', 'pat', 'notify', 1]);
  assert.equal((await cli(store, 'add', 'notify', 'dm', '*')).code, 0);
  const list = JSON.parse((await cli(store, 'list')).out);
  assert.equal(list.rules.length, 2);
  assert.equal(list.slack.state, 'off');
  assert.deepEqual(list.counts, { matched: 0, dropped: 0, muted: 0, since: '' });
  assert.equal(JSON.parse((await cli(store, 'remove', String(rule.id))).out).id, rule.id);
  assert.equal(store.slackRules().length, 1);
});

test('jarvis-slack refuses bad input and fails plainly when jarvisd is down', async () => {
  const store = openStore(':memory:');
  assert.equal((await cli(store)).code, 2);
  assert.equal((await cli(store, 'add', 'notify', 'channel')).code, 2);
  assert.equal((await cli(store, 'remove', 'abc')).code, 2);
  const bad = await cli(store, 'add', 'mute', 'channel', 'random', '--urgent');
  assert.equal(bad.code, 1);
  assert.match(bad.err, /notify only|works only with notify/);
  assert.equal((await cli(store, 'remove', '5')).code, 1);
  const bin = fileURLToPath(new URL('../bin/jarvis-slack', import.meta.url));
  const down = await new Promise<{ code: number; err: string }>(ok =>
    execFile(process.execPath, [bin, 'list'], { env: { ...process.env, JARVIS_URL: 'http://127.0.0.1:9' } }, (e, _o, err) => ok({ code: e ? Number(e.code) : 0, err })));
  assert.equal(down.code, 1);
  assert.match(down.err, /jarvisd unreachable/);
});
