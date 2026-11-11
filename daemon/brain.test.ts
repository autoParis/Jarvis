import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { Brain, brainArgs, peerMessage, readSavedSession, staleReason, gateFailed, type SavedSession } from './brain.ts';
import { readFileSync } from 'node:fs';

// A stand-in for `claude`: one result per line, exit on "die", SILENT on "quiet", an error on "fail".
const FAKE = `#!/usr/bin/env node
require('readline').createInterface({ input: process.stdin }).on('line', line => {
  const text = JSON.parse(line).message.content;
  if (text.includes('die')) process.exit(1);
  if (text.includes('tools') || text.includes('hang')) {
    console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Looking.' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } }));
    console.log(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'a.txt' }] } }));
    if (text.includes('hang')) process.exit(1);
    console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } }));
  }
  const result = text.includes('quiet') ? 'SILENT' : 'ok';
  console.log(JSON.stringify({ type: 'result', result, is_error: text.includes('fail'), usage: {} }));
});
`;

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-brain-'));
  writeFileSync(join(dir, 'claude'), FAKE);
  chmodSync(join(dir, 'claude'), 0o755);
  const brain = new Brain({ cwd: dir, env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, systemPrompt: () => '', brief: () => '[session start] brief' });
  const logs: { msg: string; fields?: any }[] = [];
  brain.on('log', (msg: string, fields?: any) => logs.push({ msg, fields }));
  brain.on('notice', () => {});
  return { brain, logs };
}
const reply = async (brain: Brain) => { const [text, usage, turns] = await once(brain, 'reply'); return { text, usage, turns }; };

test('a reply carries the turns it answers, SILENT included, and both ends go to the log', async () => {
  const { brain, logs } = setup();
  try {
    let r = reply(brain);
    brain.send('[The owner, in English: answer in English] hello there', 5);
    assert.deepEqual((await r).turns, [5]);
    r = reply(brain);
    brain.send('[The owner, in English: answer in English] quiet', 6);
    assert.deepEqual(await r.then(x => [x.text, x.turns]), ['SILENT', [6]]);
    const handed = logs.filter(l => l.msg === 'brain handed');
    assert.deepEqual(handed.map(l => l.fields.turns), [[5], [6]]);
    assert.deepEqual(logs.filter(l => l.msg === 'brain answered').map(l => l.fields.turns), [[5], [6]]);
    assert.doesNotMatch(JSON.stringify(handed), /hello there/);
  } finally { brain.stop(); }
});

test('events carry no turn, and a failed turn reports its error', async () => {
  const { brain } = setup();
  try {
    let r = reply(brain);
    brain.send('[worker event] New');
    assert.deepEqual((await r).turns, []);
    r = reply(brain);
    brain.send('fail', 7);
    const x = await r;
    assert.equal(x.usage.is_error, true);
    assert.deepEqual(x.turns, [7]);
  } finally { brain.stop(); }
});

test('a brain that dies mid-turn never answers that turn, logs the gap, and takes the next message', async () => {
  const { brain, logs } = setup();
  const answered: number[] = [];
  brain.on('reply', (_t: string, _u: unknown, turns: number[]) => answered.push(...turns));
  try {
    brain.send('die', 8);
    await once(brain, 'notice');
    assert.deepEqual(logs.find(l => l.msg === 'brain lost a running turn')?.fields.turns, [8]);
    brain.send('hello', 9);
    while (!answered.includes(9)) await once(brain, 'reply');
    assert.deepEqual(answered, [9]);
  } finally { brain.stop(); }
});

test('a turn reports working, then its steps without the reply, then the reply; a turn with no steps reports none', async () => {
  const { brain } = setup();
  const seen: string[] = [];
  let worked: any;
  brain.on('working', (on: boolean) => seen.push(on ? 'on' : 'off'));
  brain.on('worked', (w: any) => { seen.push('worked'); worked = w; });
  brain.on('reply', () => seen.push('reply'));
  try {
    brain.send('tools please', 1);
    await reply(brain);
    assert.deepEqual(seen.slice(-4), ['on', 'worked', 'off', 'reply']);
    assert.deepEqual(worked.steps, [{ kind: 'note', text: 'Looking.' }, { kind: 'tool', name: 'Bash', input: 'ls', output: 'a.txt' }]);
    assert.ok(worked.ms >= 0);
    seen.length = 0;
    brain.send('hello', 2);
    await reply(brain);
    assert.deepEqual(seen, ['on', 'off', 'reply']);
  } finally { brain.stop(); }
});

test('a turn the brain lost keeps the steps it had and stops showing as working', async () => {
  const { brain } = setup();
  const seen: string[] = [];
  let worked: any;
  brain.on('worked', (w: any) => { worked = w; });
  brain.on('working', (on: boolean) => seen.push(on ? 'on' : 'off'));
  try {
    const noticed = once(brain, 'worked');
    brain.send('hang now', 1);
    await noticed;
    assert.deepEqual(worked.steps.map((s: any) => s.kind), ['note', 'tool']);
    assert.ok(seen.includes('off'));
  } finally { brain.stop(); }
});

test('the brain knows when its running turn holds a message from the owner', async () => {
  const { brain } = setup();
  try {
    assert.equal(brain.answeringOwner, false);
    let r = once(brain, 'reply');
    brain.send('[worker event] a worker stopped');
    assert.equal(brain.answeringOwner, false, 'an event turn is the brain on its own');
    await r;
    r = once(brain, 'reply');
    brain.send('[The owner] keep going', 7);
    assert.equal(brain.answeringOwner, true);
    await r;
    assert.equal(brain.answeringOwner, false, 'the turn ended');
  } finally { brain.stop(); }
});

// A stand-in that records each start's arguments and each message it gets, reports an init with its model and
// session (the --resume id when given), and holds a turn open for 400 ms on "slow".
const RECORDER = `#!/usr/bin/env node
const fs = require('fs');
const log = process.env.FAKE_LOG;
const argv = process.argv.slice(2);
const arg = f => { const i = argv.indexOf(f); return i < 0 ? undefined : argv[i + 1]; };
fs.appendFileSync(log, JSON.stringify({ start: argv }) + '\\n');
if (arg('--resume') === 'gone') process.exit(1); // a session that no longer exists
let first = true;
require('readline').createInterface({ input: process.stdin }).on('line', line => {
  const text = JSON.parse(line).message.content;
  fs.appendFileSync(log, JSON.stringify({ pid: process.pid, text }) + '\\n');
  if (first) { first = false; console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: arg('--resume') ?? 'sess-1', model: process.env.FAKE_MODEL ?? arg('--model') })); }
  const done = () => console.log(JSON.stringify({ type: 'result', result: 'ok', usage: {} }));
  text.includes('slow') ? setTimeout(done, 400) : done();
});
`;

function recorder(env: Record<string, string> = {}, opts: { saved?: SavedSession; save?: (s: SavedSession | null) => void } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-brain-sw-'));
  writeFileSync(join(dir, 'claude'), RECORDER);
  chmodSync(join(dir, 'claude'), 0o755);
  const logFile = join(dir, 'log.jsonl');
  writeFileSync(logFile, '');
  const brain = new Brain({ cwd: dir, env: { ...process.env, ...env, FAKE_LOG: logFile, PATH: `${dir}:${process.env.PATH}` }, systemPrompt: () => '', brief: () => '[session start] brief', ...opts });
  brain.on('log', () => {});
  brain.on('notice', () => {});
  const entries = () => readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  return { brain, starts: () => entries().filter(e => e.start).map(e => e.start as string[]), messages: () => entries().filter(e => e.text) };
}
const argOf = (args: string[], flag: string) => { const i = args.indexOf(flag); return i < 0 ? undefined : args[i + 1]; };

// A stand-in that, on "peer", answers, then 150 ms later prints the lines a real session prints when another
// session's SendMessage starts a turn (shape captured live 2026-11-06, see peerMessage in brain.ts): the turn stays
// open for 300 ms. A stdin line arriving during that turn is answered WRONG, so a message handed too early shows.
const PEER = `#!/usr/bin/env node
let peerTurn = false;
const out = o => console.log(JSON.stringify(o));
const origin = { kind: 'peer', from: 'uds:/tmp/cc-socks/55175.sock', verifiedPeerPid: 55175, msg_id: 'cf5f04e5', name: 'probe-sender', fromMode: 'prompting', body: 'RELAY-OK-77' };
require('readline').createInterface({ input: process.stdin }).on('line', line => {
  const text = JSON.parse(line).message.content;
  if (peerTurn) { out({ type: 'result', result: 'WRONG', usage: {} }); return; }
  out({ type: 'result', result: 'ok', usage: {} });
  if (!text.includes('peer')) return;
  setTimeout(() => {
    peerTurn = true;
    out({ type: 'command_lifecycle', command_uuid: 'e9a4b181', state: 'started', session_id: 'aca69e6c' });
    out({ type: 'system', subtype: 'init', session_id: 'aca69e6c', tools: ['ListAgents', 'SendMessage'], model: 'claude-opus-5-5' });
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'SendMessage', input: { to: 'uds:/tmp/cc-socks/55175.sock', message: 'BACK-RELAY-OK-77' } }] } });
    out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: '{"success":true}' }] }] }, parent_tool_use_id: null });
    setTimeout(() => {
      peerTurn = false;
      out({ type: 'assistant', message: { content: [{ type: 'text', text: 'Sent. TURN-DONE' }] } });
      out({ type: 'result', subtype: 'success', result: 'Sent. TURN-DONE', num_turns: 2, result_index: 1, origin, usage: { output_tokens: 35 }, session_id: 'aca69e6c' });
      out({ type: 'command_lifecycle', command_uuid: 'e9a4b181', state: 'completed', session_id: 'aca69e6c' });
    }, 300);
  }, 150);
});
`;

function peerFake() {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-brain-peer-'));
  writeFileSync(join(dir, 'claude'), PEER);
  chmodSync(join(dir, 'claude'), 0o755);
  const brain = new Brain({ cwd: dir, env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, systemPrompt: () => '', brief: () => '[session start] brief' });
  const logs: { msg: string; fields?: any }[] = [];
  brain.on('log', (msg: string, fields?: any) => logs.push({ msg, fields }));
  brain.on('notice', () => {});
  return { brain, logs };
}

test('a turn the process starts on its own flips busy and working, ends as a worker event, not a reply, and busy returns to false', async () => {
  const { brain, logs } = peerFake();
  const seen: string[] = [];
  brain.on('working', (on: boolean) => seen.push(on ? 'on' : 'off'));
  brain.on('reply', () => seen.push('reply'));
  brain.on('worked', () => seen.push('worked'));
  try {
    const r = reply(brain);
    brain.send('peer', 1);
    await r;
    assert.equal(brain.busy, false);
    seen.length = 0;
    const working = once(brain, 'working');
    const worker = once(brain, 'worker');
    await working;
    assert.equal(brain.busy, true, 'the unrequested turn is running');
    assert.deepEqual(seen, ['on']);
    const [text, usage, peer] = await worker;
    assert.equal(text, 'Sent. TURN-DONE');
    assert.equal(usage.output_tokens, 35);
    assert.deepEqual(peer, { from: 'probe-sender', text: 'RELAY-OK-77' });
    assert.equal(brain.busy, false);
    assert.deepEqual(seen, ['on', 'worked', 'off'], 'no reply event for a worker turn; its steps still fold');
    assert.ok(logs.some(l => l.msg === 'brain started a turn on its own'));
    assert.deepEqual(logs.find(l => l.msg === 'brain answered a worker message')?.fields, { chars: 15, from: 'probe-sender', error: false });
    assert.match(logs.find(l => l.msg === 'brain unrequested turn, first line')?.fields.line, /command_lifecycle/);
  } finally { brain.stop(); }
});

test("The owner's message queued during an unrequested turn goes out after it, as its own turn", async () => {
  const { brain, logs } = peerFake();
  const order: string[] = [];
  brain.on('worker', () => order.push('worker'));
  brain.on('reply', (t: string, _u: unknown, turns: number[]) => order.push(`reply:${t}:${turns.join(',')}`));
  try {
    const r = reply(brain);
    brain.send('peer', 1);
    await r;
    await once(brain, 'working'); // the unrequested turn opened
    const owner = reply(brain);
    brain.send('[The owner] hello', 2);
    assert.equal(brain.busy, true);
    const x = await owner;
    assert.deepEqual(order, ['reply:ok:1', 'worker', 'reply:ok:2'], 'never WRONG: nothing was handed into the worker turn');
    assert.deepEqual(x.turns, [2]);
    assert.deepEqual(logs.filter(l => l.msg === 'brain handed').map(l => l.fields.turns), [[1], [2]]);
  } finally { brain.stop(); }
});

// The 2026-11-09 21:25:13 order: jarvisd writes a turn, and a worker's message that arrives 170 ms later runs first.
// Claude Code prints the peer turn's result (with `origin`) before the result of jarvisd's turn.
const AHEAD = `#!/usr/bin/env node
const out = o => console.log(JSON.stringify(o));
const origin = { kind: 'peer', from: 'uds:/tmp/cc-socks/34422.sock', verifiedPeerPid: 34422, msg_id: 'f9af417d', name: '4390-sup-1025-page-address-problem-483', fromMode: 'prompting', body: 'QUESTION: ship or wait?' };
require('readline').createInterface({ input: process.stdin }).on('line', line => {
  const text = JSON.parse(line).message.content;
  if (!text.includes('race')) { out({ type: 'result', result: 'ok', usage: {} }); return; }
  out({ type: 'command_lifecycle', command_uuid: 'c1', state: 'started' });
  out({ type: 'result', result: 'Story 4390 asks: ship or wait?', origin, usage: {} });
  out({ type: 'command_lifecycle', command_uuid: 'c1', state: 'completed' });
  setTimeout(() => out({ type: 'result', result: 'PR 5321 is ready.', usage: {} }), 100);
});
`;

test('a worker message that runs ahead of a jarvisd turn is a worker event, and the next result still answers jarvisd', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-brain-ahead-'));
  writeFileSync(join(dir, 'claude'), AHEAD);
  chmodSync(join(dir, 'claude'), 0o755);
  const brain = new Brain({ cwd: dir, env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, systemPrompt: () => '', brief: () => '[session start] brief' });
  const logs: string[] = [];
  brain.on('log', (m: string) => logs.push(m));
  brain.on('notice', () => {});
  const order: string[] = [];
  brain.on('worker', (t: string, _u: unknown, peer: any) => order.push(`worker:${peer?.from}:${t}`));
  brain.on('reply', (t: string, _u: unknown, turns: number[]) => order.push(`reply:${t}:${turns.join(',')}`));
  try {
    const first = reply(brain);
    brain.send('hello', 1);
    await first;
    const mine = new Promise<void>(res => brain.on('reply', (_t: string, _u: unknown, turns: number[]) => { if (turns.includes(2)) res(); }));
    brain.send('[worker event] race', 2);
    await mine;
    assert.deepEqual(order, [
      'reply:ok:1',
      'worker:4390-sup-1025-page-address-problem-483:Story 4390 asks: ship or wait?',
      'reply:PR 5321 is ready.:2',
    ]);
    assert.ok(logs.includes('brain answered a worker message that ran ahead of a jarvisd turn'));
    assert.ok(!logs.includes('brain started a turn on its own'), 'jarvisd\'s own result is not taken for an unrequested turn');
    assert.equal(brain.busy, false);
  } finally { brain.stop(); }
});

test('peerMessage reads the sender and text from the live result shape, and from the transcript form', () => {
  const result = { type: 'result', result: 'x', origin: { kind: 'peer', from: 'uds:/tmp/cc-socks/55175.sock', verifiedPeerPid: 55175, msg_id: 'cf5f04e5', name: 'probe-sender', fromMode: 'prompting', body: 'RELAY-OK-77' } };
  assert.deepEqual(peerMessage(result), { from: 'probe-sender', text: 'RELAY-OK-77' });
  assert.deepEqual(peerMessage({ type: 'result', origin: { kind: 'peer', body: 'no name' } }), { from: undefined, text: 'no name' });
  const user = { type: 'user', message: { role: 'user', content: 'Another Claude session sent a message:\n<cross-session-message from="uds:/tmp/cc-socks/55175.sock" from-name="probe-sender" from-mode="prompting">\nRELAY-OK-77\n</cross-session-message>\n\nThis came from another Claude session' } };
  assert.deepEqual(peerMessage(user), { from: 'probe-sender', text: 'RELAY-OK-77' });
  assert.equal(peerMessage({ type: 'result', result: 'ok', usage: {} }), undefined, 'a turn jarvisd sent has no origin');
  assert.equal(peerMessage({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'a' }] } }), undefined);
});

test('brainArgs names the session, lets it message peers and accepts their messages', () => {
  const a = brainArgs({ model: { model: 'claude-opus-5-5', effort: 'medium' }, systemPrompt: 'x' });
  assert.equal(argOf(a, '--name'), 'jarvis-brain');
  const tools = argOf(a, '--tools')!.split(',');
  assert.ok(tools.includes('SendMessage') && tools.includes('ListAgents'));
  const settings = JSON.parse(argOf(a, '--settings')!);
  assert.equal(settings.crossSessionInbound, 'accept');
  assert.equal(settings.dialogExpiry, 'never');
  assert.equal(settings.enabledPlugins['superpowers@claude-plugins-official'], false, 'the plugin switches stay');
});

test('the brain starts on the setting, Opus 5.5 at medium by default, with no --resume', () => {
  const a = brainArgs({ model: { model: 'claude-opus-5-5', effort: 'medium' }, systemPrompt: 'x' });
  assert.equal(argOf(a, '--model'), 'claude-opus-5-5');
  assert.equal(argOf(a, '--effort'), 'medium');
  assert.ok(!a.includes('--resume'));
  const b = brainArgs({ model: { model: 'claude-haiku-5-5', effort: 'max' }, systemPrompt: 'x', resume: 'abc' });
  assert.deepEqual([argOf(b, '--model'), argOf(b, '--effort'), argOf(b, '--resume')], ['claude-haiku-5-5', 'max', 'abc']);
  assert.ok(b.includes('--disallowedTools'), 'the hard denies stay');
});

test('a switch restarts the brain on the new model and effort, resuming the same session without a new brief', async () => {
  const { brain, starts, messages } = recorder();
  try {
    let r = reply(brain);
    brain.send('hello', 1);
    await r;
    assert.deepEqual(brain.status().running, { model: 'claude-opus-5-5', effort: 'medium' });
    assert.equal(await brain.switchModel({ model: 'claude-sonnet-5-5', effort: 'high' }), undefined);
    assert.deepEqual(brain.status().running, { model: 'claude-sonnet-5-5', effort: 'high' });
    assert.equal(brain.sessionId, 'sess-1');
    r = reply(brain);
    brain.send('after', 2);
    assert.deepEqual((await r).turns, [2]);
    const s = starts(); // read once the new process has answered, so its start line is written
    assert.equal(s.length, 2);
    assert.deepEqual([argOf(s[1], '--model'), argOf(s[1], '--effort'), argOf(s[1], '--resume')], ['claude-sonnet-5-5', 'high', 'sess-1']);
    const m = messages();
    assert.equal(m.filter(x => x.text.includes('[session start]')).length, 1, 'the resumed session gets no second brief');
    assert.notEqual(m[0].pid, m[m.length - 1].pid, 'the message after the switch went to the new process');
  } finally { brain.stop(); }
});

test('a switch is refused while a turn runs and changes nothing', async () => {
  const { brain, starts } = recorder();
  try {
    const r = reply(brain);
    brain.send('slow one', 1);
    assert.match((await brain.switchModel({ model: 'claude-haiku-5-5', effort: 'low' }))!, /middle of a turn/);
    assert.deepEqual(brain.setting, { model: 'claude-opus-5-5', effort: 'medium' });
    await r;
    assert.equal(starts().length, 1);
  } finally { brain.stop(); }
});

test('a message sent during the restart is not dropped: it waits and goes to the new process', async () => {
  const { brain, starts, messages } = recorder();
  try {
    let r = reply(brain);
    brain.send('hello', 1);
    await r;
    const switching = brain.switchModel({ model: 'claude-fable-5-1', effort: 'xhigh' });
    assert.equal(brain.status().switching, true);
    r = reply(brain);
    brain.send('during the switch', 2);
    await switching;
    assert.deepEqual((await r).turns, [2]);
    assert.equal(starts().length, 2);
    const during = messages().find(x => x.text === 'during the switch')!;
    assert.equal(messages().filter(x => x.pid === during.pid).length, 1, 'it reached the resumed process only');
  } finally { brain.stop(); }
});

test('the status reports the model the process says it runs, not only what was asked', async () => {
  const { brain } = recorder({ FAKE_MODEL: 'claude-opus-5-5' });
  try {
    await brain.switchModel({ model: 'claude-haiku-5-5', effort: 'low' }); // no process yet: only the setting moves
    assert.equal(brain.status().running, null);
    const r = reply(brain);
    brain.send('hello', 1);
    await r;
    assert.deepEqual(brain.status().running, { model: 'claude-opus-5-5', effort: 'low' });
    assert.deepEqual(brain.status().setting, { model: 'claude-haiku-5-5', effort: 'low' });
  } finally { brain.stop(); }
});

test('a jarvisd restart resumes the saved session with no brief, tells it about the restart, and keeps saving it', async () => {
  const saves: (SavedSession | null)[] = [];
  const { brain, starts, messages } = recorder({}, { saved: { id: 'sess-old', tokens: 40_000, at: Date.now() - 60_000 }, save: s => saves.push(s) });
  try {
    const r = reply(brain);
    brain.send('hello', 1);
    assert.deepEqual((await r).turns, [1]);
    assert.equal(argOf(starts()[0], '--resume'), 'sess-old');
    const m = messages();
    assert.equal(m.length, 1);
    assert.doesNotMatch(m[0].text, /\[session start\]/, 'a resumed session gets no brief');
    assert.match(m[0].text, /^\[held notices, no answer needed\] jarvisd restarted at .*same conversation/);
    assert.match(m[0].text, /hello$/);
    assert.ok(saves.length >= 1 && saves.every(s => s?.id === 'sess-old'), 'nothing reset the saved row');
    assert.equal(saves[saves.length - 1]!.tokens, 0, 'the turn result updates the saved token count');
  } finally { brain.stop(); }
});

test('a saved session past the idle or token limit is not resumed: the brain starts fresh with the brief and clears the row', async () => {
  for (const saved of [{ id: 'sess-old', tokens: 1_000, at: Date.now() - 56 * 60_000 }, { id: 'sess-old', tokens: 151_000, at: Date.now() }]) {
    const saves: (SavedSession | null)[] = [];
    const { brain, starts, messages } = recorder({}, { saved, save: s => saves.push(s) });
    try {
      const r = reply(brain);
      brain.send('hello', 1);
      await r;
      assert.equal(argOf(starts()[0], '--resume'), undefined);
      assert.match(messages()[0].text, /^\[session start\] brief/);
      assert.equal(saves[0], null, 'the stale row is cleared at the fresh start');
      assert.equal(saves[saves.length - 1]!.id, 'sess-1', 'the new session is saved');
    } finally { brain.stop(); }
  }
});

test('a saved session that will not resume falls back to a fresh one with the same batch and no restart notice', async () => {
  const notices: string[] = [];
  const { brain, starts, messages } = recorder({}, { saved: { id: 'gone', tokens: 1_000, at: Date.now() } });
  brain.on('notice', (s: string) => notices.push(s));
  try {
    const r = reply(brain);
    brain.send('hello', 3);
    assert.deepEqual((await r).turns, [3], 'the turn is answered, not lost');
    const s = starts();
    assert.deepEqual(s.map(a => argOf(a, '--resume')), ['gone', undefined]);
    const m = messages();
    assert.equal(m.length, 1);
    assert.match(m[0].text, /^\[session start\] brief/);
    assert.match(m[0].text, /hello$/);
    assert.deepEqual(notices, []);
  } finally { brain.stop(); }
});

test('a held notice starts no turn and rides as one line, after the brief, on the next real turn', async () => {
  const { brain, starts, messages } = recorder();
  try {
    brain.hold('[gate] The owner approved #4 with the button. Reply SILENT.');
    brain.hold('[ask card] The owner tapped "yes"\non ask message_id=m1 in the app. Reply SILENT.');
    assert.equal(brain.busy, false);
    assert.equal(brain.heldCount, 2);
    await new Promise(res => setTimeout(res, 100));
    assert.equal(starts().length, 0, 'no process started for the notices');
    const r = reply(brain);
    brain.send('[worker event] New', undefined);
    await r;
    const m = messages();
    assert.equal(m.length, 1);
    const parts = m[0].text.split('\n\n');
    assert.equal(parts[0], '[session start] brief');
    assert.equal(parts[1], '[held notices, no answer needed] [gate] The owner approved #4 with the button. | [ask card] The owner tapped "yes" on ask message_id=m1 in the app.');
    assert.equal(parts[2], '[worker event] New');
    assert.equal(brain.heldCount, 0);
  } finally { brain.stop(); }
});

test('readSavedSession, staleReason and gateFailed', () => {
  const row = (v?: string) => (k: string) => (k === 'brain_session' ? v : undefined);
  assert.equal(readSavedSession(row(undefined)), undefined);
  assert.equal(readSavedSession(row('')), undefined);
  assert.equal(readSavedSession(row('{bad')), undefined);
  assert.equal(readSavedSession(row('{"id":"","tokens":1,"at":1}')), undefined);
  assert.deepEqual(readSavedSession(row('{"id":"a","tokens":1,"at":2}')), { id: 'a', tokens: 1, at: 2 });
  const now = 10_000_000;
  assert.equal(staleReason({ id: 'a', tokens: 149_000, at: now - 54 * 60_000 }, now), undefined);
  assert.equal(staleReason({ id: 'a', tokens: 1, at: now - 56 * 60_000 }, now), 'idle');
  assert.equal(staleReason({ id: 'a', tokens: 151_000, at: now }, now), 'token limit');
  assert.deepEqual(['done', 'rejected', 'failed', 'unknown', 'approved'].map(gateFailed), [false, false, true, true, true]);
});
