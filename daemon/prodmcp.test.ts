import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { openStore } from './store.ts';
import { makeGate, BUTTON_ONLY } from './gate.ts';
import { makeProdMcp, REFUSED_TOOL_WORDS } from './prodmcp.ts';
import { approvalDetail, approvalOutcomeText, approvalTag } from '../web/worklist.js';
import { PROD_MCP_URL, STAGING_MCP_URL } from './config.ts';

const TOKEN = 'fake-test-token-1234';
const REPLY = { reference: 'TICKET-1039', content: "Bonjour,\nC'est réglé.\nstatus: ferme", status: 'resolu' };
const OK = { content: [{ type: 'text', text: '{"ok":true,"reference":"TICKET-1039","message_id":"m1"}' }] };

type Handler = (req: IncomingMessage, res: ServerResponse) => void;
/** A stand-in MCP server on localhost. `answer` decides each tools/call to a tool under test; `calls` records them. */
async function fakeServer(answer: Handler | { result: any } | { error: any } = { result: OK }, tools = ['support_ticket_reply', 'support_ticket_get', 'dealerships_get', 'inventory_delete'], sse = false) {
  const calls: any[] = [], auth: (string | undefined)[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      auth.push(req.headers.authorization);
      const m = JSON.parse(body);
      const send = (o: object) => {
        const out = JSON.stringify({ jsonrpc: '2.0', id: m.id, ...o });
        if (sse) { res.setHeader('content-type', 'text/event-stream'); res.end(`event: message\ndata: ${out}\n\n`); }
        else { res.setHeader('content-type', 'application/json'); res.end(out); }
      };
      if (m.method === 'initialize') { res.setHeader('mcp-session-id', 's1'); return send({ result: { capabilities: {} } }); }
      if (m.method === 'notifications/initialized') { res.statusCode = 202; return res.end(); }
      if (m.method === 'tools/list') return send({ result: { tools: tools.map(name => ({ name })) } });
      const { name, arguments: args } = m.params;
      if (name === 'support_ticket_get') return send({ result: { content: [{ type: 'text', text: '{"titre":"Photos manquantes"}' }] } });
      if (name === 'dealerships_get') return send({ result: { content: [{ type: 'text', text: '{"name":"Dealer Eleven"}' }] } });
      calls.push({ name, args, session: req.headers['mcp-session-id'] });
      if (typeof answer === 'function') return answer(req, res);
      send(answer);
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/mcp`;
  return { url, calls, auth, close: () => { server.closeAllConnections(); server.close(); } };
}

function setup(url: string, token = () => TOKEN) {
  const store = openStore(':memory:');
  const lines: { msg: string; fields?: any }[] = [];
  const gate = makeGate(store, () => {}, (msg, fields) => lines.push({ msg, fields }), makeProdMcp({ url, token }));
  return { store, gate, lines };
}
const call = (tool = 'support_ticket_reply', args: object = REPLY) => ({ tool, arguments: args });

test('Approve makes the exact call once, and the card shows the tool, the ticket and every argument', async t => {
  const s = await fakeServer();
  t.after(s.close);
  const { gate } = setup(s.url);
  const p = await gate.propose('prod-mcp-call', call(), 'Whatever the brain says');
  assert.equal(s.calls.length, 0, 'nothing runs at the proposal');
  const args = JSON.parse(p.args);
  assert.equal(p.say, 'Run support_ticket_reply on production?');
  assert.equal(approvalTag('prod-mcp-call', args), 'Production: support_ticket_reply');
  assert.equal(approvalDetail(args), `On production AcmeApp. jarvisd makes this one call only when you tap Approve.

Tool: support_ticket_reply

Touches:
Support ticket TICKET-1039, "Photos manquantes"

Arguments, in full:
reference: TICKET-1039
content:
  Bonjour,
  C'est réglé.
  status: ferme
status: resolu

Then it reports what production answers.`);
  const a = await gate.button(p.id, true);
  assert.equal(a.status, 'done');
  assert.match(approvalOutcomeText(a), /^Approved\. Production confirmed support_ticket_reply: .*TICKET-1039/);
  assert.deepEqual(s.calls, [{ name: 'support_ticket_reply', args: REPLY, session: 's1' }]);
  assert.ok(s.auth.every(h => h === `Bearer ${TOKEN}`));
});

test('a spoken or typed yes is refused, so only the button runs it', async t => {
  const s = await fakeServer();
  t.after(s.close);
  const { gate, store } = setup(s.url);
  assert.ok(BUTTON_ONLY.has('prod-mcp-call'));
  const p = await gate.propose('prod-mcp-call', call(), 'Do it?');
  store.addTurn({ role: 'owner', text: 'yes' });
  await assert.rejects(gate.confirm(p.id), /runs only when the owner taps Approve/);
  assert.equal(store.approval(p.id)!.status, 'pending');
  assert.equal(s.calls.length, 0);
  await assert.rejects(gate.pressed('prod-mcp-call', call(), 'x'), /not a work-list button/);
});

test('a double tap runs once', async t => {
  const s = await fakeServer();
  t.after(s.close);
  const { gate } = setup(s.url);
  const p = await gate.propose('prod-mcp-call', call(), 'Do it?');
  const taps = await Promise.allSettled([gate.button(p.id, true), gate.button(p.id, true)]);
  assert.equal(taps.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(s.calls.length, 1);
  assert.equal((await gate.propose('prod-mcp-call', call(), 'Again?')).id, p.id, 'the same call proposed again is the same card');
  assert.equal(s.calls.length, 1);
});

test('refused at entry: delete in the name, a tool production lacks, bad arguments, no credential', async t => {
  const s = await fakeServer();
  t.after(s.close);
  const { gate, store } = setup(s.url);
  assert.deepEqual(REFUSED_TOOL_WORDS, ['delete']);
  const propose = (args: object) => gate.propose('prod-mcp-call', args, 'Do it?');
  await assert.rejects(propose(call('inventory_delete', { id: 1 })), /refused: a tool whose name contains "delete"/);
  await assert.rejects(propose(call('Inventory_DELETE', {})), /contains "delete"/);
  await assert.rejects(propose(call('mcp__acmeapp-prod__users_delete', {})), /contains "delete"/);
  await assert.rejects(propose(call('made_up_tool', {})), /does not exist on the production/);
  await assert.rejects(propose(call('mcp__acmeapp-staging__support_ticket_reply', REPLY)), /does not exist on the production/);
  await assert.rejects(propose(call('--flag', {})), /must be a production/);
  await assert.rejects(propose({ tool: 'support_ticket_reply', arguments: [1] }), /arguments must be a JSON object/);
  await assert.rejects(propose({ tool: 'support_ticket_reply', arguments: '{"a":1}' }), /arguments must be a JSON object/);
  await assert.rejects(propose({ arguments: {} }), /tool is required/);
  const none = setup(s.url, () => '');
  await assert.rejects(none.gate.propose('prod-mcp-call', call(), 'Do it?'), /no production AcmeApp MCP credential/);
  assert.equal(s.calls.length, 0);
  assert.equal(store.pendingApprovals().length, 0);
});

test('the name Claude Code gives a tool works, and what the brain sends as the card is dropped', async t => {
  const s = await fakeServer();
  t.after(s.close);
  const { gate } = setup(s.url);
  const p = await gate.propose('prod-mcp-call', { ...call('mcp__acmeapp-prod__support_ticket_reply'), runs: 'Harmless', touches: 'Nothing', extra: 1 }, 'Do it?');
  const args = JSON.parse(p.args);
  assert.equal(args.tool, 'support_ticket_reply');
  assert.equal(args.extra, undefined);
  assert.doesNotMatch(args.runs, /Harmless/);
  assert.match(args.touches, /TICKET-1039/);
});

test('the card marks hidden characters and names a dealership', async t => {
  const s = await fakeServer();
  t.after(s.close);
  const { gate } = setup(s.url);
  const p = await gate.propose('prod-mcp-call', call('support_ticket_reply', { dealership_id: 12, nested: { a: [1, 'b'] }, note: 'pa​y' }), 'Do it?');
  const shown = approvalDetail(JSON.parse(p.args));
  assert.match(shown, /Dealership 12, Dealer Eleven/);
  assert.match(shown, /note: pa\\u\{200b\}y/);
  assert.match(shown, /nested:\n  \{\n    "a": \[/);
});

test('a card still opens when the name lookups fail or nothing is named', async t => {
  const s = await fakeServer({ result: OK }, ['support_ticket_reply']);
  t.after(s.close);
  const { gate } = setup(s.url);
  assert.match(JSON.parse((await gate.propose('prod-mcp-call', call(), 'x')).args).touches, /^Support ticket TICKET-1039$/);
  assert.match(JSON.parse((await gate.propose('prod-mcp-call', call('support_ticket_reply', { id: 9 }), 'x')).args).touches, /^No ticket or dealership is named/);
});

test('production decides the status: refusals fail, a lost answer is unknown, never done', async t => {
  const outcomes: [string, Parameters<typeof fakeServer>[0], string, RegExp][] = [
    ['a tool error', { result: { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: true, message: 'Not a super admin' }) }] } }, 'failed', /Production refused support_ticket_reply: Not a super admin/],
    ['error:true without the flag', { result: { content: [{ type: 'text', text: '{"error":true,"message":"nope"}' }] } }, 'failed', /nope/],
    ['a JSON-RPC error', { error: { code: -32602, message: 'Invalid arguments' } }, 'failed', /Invalid arguments/],
    ['a 403', (_q, r) => { r.statusCode = 403; r.end(); }, 'failed', /HTTP 403/],
    ['a 500', (_q, r) => { r.statusCode = 500; r.end(); }, 'unknown', /may or may not have run/],
    ['a dropped connection', (q) => { q.socket.destroy(); }, 'unknown', /gave no answer/],
    ['an empty result', { result: {} }, 'unknown', /had no result/],
    ['text that is not JSON', (_q, r) => { r.end('<html>'); }, 'unknown', /had no result/],
    ['a redirect', (_q, r) => { r.statusCode = 302; r.setHeader('location', 'http://127.0.0.1:1/'); r.end(); }, 'unknown', /gave no answer/],
  ];
  for (const [name, answer, status, words] of outcomes) {
    await t.test(name, async () => {
      const s = await fakeServer(answer);
      try {
        const { gate } = setup(s.url);
        const p = await gate.propose('prod-mcp-call', call(), 'Do it?');
        const a = await gate.button(p.id, true);
        assert.equal(a.status, status);
        assert.match(a.result!, words);
        assert.equal(s.calls.length, 1, 'no retry');
      } finally { s.close(); }
    });
  }
});

test('an event-stream answer is read like a JSON one', async t => {
  const s = await fakeServer({ result: OK }, undefined, true);
  t.after(s.close);
  const { gate } = setup(s.url);
  const p = await gate.propose('prod-mcp-call', call(), 'Do it?');
  assert.equal((await gate.button(p.id, true)).status, 'done');
});

test('the log says who, what and the outcome, and the credential stays out of everything', async t => {
  const s = await fakeServer({ result: { content: [{ type: 'text', text: `echoed ${TOKEN}` }] } });
  t.after(s.close);
  const { gate, lines } = setup(s.url);
  const p = await gate.propose('prod-mcp-call', call(), 'Do it?');
  const a = await gate.button(p.id, true);
  const done = lines.find(l => l.msg === 'gate done')!;
  assert.equal(done.fields.who, 'The owner, button');
  assert.equal(done.fields.tool, 'support_ticket_reply');
  assert.deepEqual(done.fields.arguments, REPLY);
  assert.match(done.fields.result, /Production confirmed/);
  assert.ok(!JSON.stringify(lines).includes(TOKEN));
  assert.ok(!a.result!.includes(TOKEN));
  assert.ok(!a.args.includes(TOKEN));
});

test('at the tap: a stored delete tool is refused, and a lost credential or session runs nothing', async t => {
  const s = await fakeServer();
  t.after(s.close);
  const { gate, store } = setup(s.url);
  const p = await gate.propose('prod-mcp-call', call(), 'Do it?');
  store.db.prepare('UPDATE approvals SET args = ? WHERE id = ?').run(JSON.stringify(call('inventory_delete', { id: 1 })), p.id);
  const a = await gate.button(p.id, true);
  assert.equal(a.status, 'failed');
  assert.match(a.result!, /contains "delete"/);
  assert.equal(s.calls.length, 0);

  let token = TOKEN;
  const later = setup(s.url, () => token);
  const q = await later.gate.propose('prod-mcp-call', call(), 'Do it?');
  token = '';
  const b = await later.gate.button(q.id, true);
  assert.equal(b.status, 'failed');
  assert.match(b.result!, /^Nothing ran: jarvisd has no production/);
  assert.equal(s.calls.length, 0);
});

test('without an injected address the target is production, and the brain is still on staging only', () => {
  assert.match(readFileSync(new URL('./prodmcp.ts', import.meta.url), 'utf8'), /const PROD_URL = PROD_MCP_URL;/);
  const brain = readFileSync(new URL('./brain.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(brain, /acmeapp-prod|PROD_MCP_URL/);
  assert.notEqual(PROD_MCP_URL, STAGING_MCP_URL);
  assert.match(brain, /--strict-mcp-config/);
});
