import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { openStore, type Item } from './store.ts';
import { askCard, answerAsk } from './asks.ts';
import { duplicateStopNotices } from './work.ts';
import { makeGate } from './gate.ts';
import { readPrompt, readStopNotice, stillAt, promptKey, gonePromptNotices, cleanOutput, readPromptContext, fillPromptContexts, storedContext } from './prompt.ts';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.txt`, import.meta.url), 'utf8');
// The exact bodies Orca sent, copied from the items table.
const HOOK = fixture('stop-hook-prompt'), AUTO = fixture('stop-auto-mode-prompt'), STOPPED = fixture('stop-no-report'), CREDENTIAL = fixture('stop-credential-prompt');
const TERMINAL = 'term_00000000-0000-4000-a000-000000000001';

const item = (body: string, extra: Partial<Item> = {}): Item => ({
  id: 1, source: 'orca', external_id: 'msg_stop_a', kind: 'escalation', dispatch_id: 'ctx_000000000002', subject: 'Worker is waiting on a prompt', body, options: null,
  status: 'spoken', answer: null, created_at: '2026-11-02 20:09:37', pushes: 0, pushed_at: null, meta: null, ...extra,
});
/** The terminal's current frame: Orca's last output with an agent's transcript above it. */
const frame = (body: string) => ['⏺ Reading the production logs.', ...body.split('Last output:\n')[1].split('\nFull output:')[0].split('\n')];
const screen = (tail: string[], status = 'running') => ({ ok: true, result: { terminal: { handle: TERMINAL, status, tail, source: 'screen' } } });

test('the real hook prompt: task, one sentence on what it asks, the command trimmed, Yes and No in the prompt\'s order', () => {
  const n = readStopNotice(HOOK)!;
  assert.equal(n.kind, 'prompt');
  assert.equal(n.task, 'Posted ad not found, asks for link');
  assert.equal(n.terminal, TERMINAL);
  assert.deepEqual(n.prompt!.options.map(o => [o.key, o.label]), [['1', 'Yes'], ['2', 'No']]);
  assert.equal(n.prompt!.summary, 'This reads or edits a credential file (Tailscale key, Firebase service account, FB passwords). Do you want to proceed?');
  assert.ok(n.prompt!.command!.length <= 170, n.prompt!.command);
  assert.match(n.prompt!.command!, /grep -E "\^\\\.env"/, 'the end of the command is what it is about to run');
});

test('the card for that notice: plain text, status Waiting, real buttons, no noise and no CLI template', () => {
  const c = askCard(item(HOOK), 'a different row title')!;
  assert.equal(c.title, 'Posted ad not found, asks for link');
  assert.equal(c.failed, undefined, 'nothing failed');
  assert.equal(c.proposes, undefined);
  assert.equal(c.prompt, true);
  assert.ok(c.body.includes(c.question!), 'the question sits in the body, as on an ask card');
  assert.deepEqual(c.options.map(o => [o.value, o.label]), [['1', 'Yes'], ['2', 'No']]);
  assert.ok(c.options.every(o => o.detail), 'each option says what it does');
  const all = JSON.stringify(c);
  for (const noise of ['orchestration send', 'worker-read', '<guidance>', 'term_8a7e', 'Last output', 'Esc to cancel', 'settings.json', 'Hook PreToolUse', '│', '╌', '❯'])
    assert.ok(!all.includes(noise), `the card has ${noise}`);
});

test('the page draws it like an ask card, not as a failure, and does not call an option recommended on its own say-so', () => {
  const ctx: any = {};
  runInNewContext(readFileSync(new URL('../web/askcard.js', import.meta.url), 'utf8'), ctx);
  const html: string = ctx.askCardHtml(askCard(item(HOOK))!, (s: string) => `<p>${s}</p>`);
  assert.doesNotMatch(html, /Failed|Recommended|Waiting/);
  assert.match(html, /<span class="l">Yes<span class="d">Lets the whole command run once/);
  assert.match(html, /End of the command \(the start is cut off\)/);
  assert.match(html, /class="ask-cmd"/);
  assert.match(html, /&quot;\^\\\.env&quot;/, 'the command is escaped');
});

test('the auto mode prompt keeps all three options and says what was blocked', () => {
  const n = readStopNotice(AUTO)!;
  assert.deepEqual(n.prompt!.options.map(o => o.label), ['Yes', "Yes, and don't ask again for acmeapp-prod — Marketplace Account Create commands in ~/…", 'No']);
  assert.equal(n.prompt!.summary, 'Auto mode needs your confirmation for this tool. Blocked as: Real-World Transactions. Do you want to proceed?');
  assert.equal(n.prompt!.command, 'acmeapp-prod — Marketplace Account Create');
});

test('a worker that stopped without reporting: a plain headline, its last words, default buttons; not called a failure', () => {
  const c = askCard(item(STOPPED, { subject: 'Worker stopped without reporting' }))!;
  assert.equal(c.title, '#4486 Prefill detected make in review queue');
  assert.equal(c.state, undefined);
  assert.equal(c.failed, undefined);
  assert.equal(c.question, 'It ended its turn without reporting.');
  assert.deepEqual(c.options.map(o => o.label), ['Retry', 'Stop', 'Tell it what to do']);
  assert.equal(c.suggested, true);
  const [head, ...parts] = c.body.split('\n\n');
  assert.equal(head, c.question);
  assert.ok(parts.length >= 2, c.body);
  assert.match(parts[0], /^The worktree is clean/);
  assert.doesNotMatch(c.body, /orchestration|Dispatch is still open|Last output/);
});

test('a prompt Jarvis could not read gets no default buttons: Retry would only be a message to a worker at a menu', () => {
  const c = askCard(item('Worker term_1 is stopped at a prompt for task "T" (task_1).\nLast output:\nnothing like a menu\n'))!;
  assert.deepEqual(c.options, []);
});

test('a stop notice in a wording Jarvis does not know still loses the template and the noise', () => {
  const c = askCard(item('Something new from Orca.\nThe Dispatch is still open. Answer it with your Orca CLI\'s `orchestration send --to dispatch:x`, retry it, or stop the worker.\n\x1b[31m│ red text\x1b[0m\n────────\nFull output: orchestration worker-read --dispatch x'))!;
  assert.equal(c.body, 'Something new from Orca.\nred text');
});

test('cleaning takes out colour codes, frames and control bytes and leaves the words', () => {
  assert.equal(cleanOutput('\x1b[1m│ bold\x1b[0m\n╌╌╌╌╌\n  keep | this\x07'), 'bold\nkeep | this');
});

test('the #1691 card: names the files, says it only looks at details, says what is cut off, and each option says what it does', () => {
  const c = askCard(item(CREDENTIAL))!;
  assert.equal(c.title, '#1691 Photo updates ignore update:false');
  assert.equal(c.question, 'Let it run this? In the part Jarvis can read, it would look at the details of `service-account.json` and `../.env`, without opening them.');
  assert.doesNotMatch(c.body, /reads or edits/, 'the vague words are gone when code can say what it does');
  assert.match(c.body, /^Stopped at a safety prompt while working on this story\. It gave no reason/);
  assert.match(c.body, /`service-account\.json` \(Firebase service account\) and `\.\.\/\.env` \(environment secrets\): only looks/);
  assert.match(c.body, /Also writes `~\/\.fbm\/canary-pr`/);
  assert.match(c.body, /Also runs `node \$S\/nsh\.js \$W`/);
  assert.match(c.body, /Only the end of this command reached Jarvis/);
  assert.equal(c.commandLabel, 'End of the command (the start is cut off)');
  assert.match(c.command!, /^… /);
  assert.match(c.command!, /process\.exit\(1\)\}\)\nEOF\ncd "\$W\/functions"; node .* \.\.\/\.env 2>\/dev\/null \| cut -c30-; .*canary-pr; git rev-parse HEAD$/, 'real line breaks stay, the terminal\'s wrapping goes');
  assert.deepEqual(c.options, [
    { value: '1', label: 'Yes', detail: 'Lets the whole command run once, including the part cut off. It asks again next time.' },
    { value: '2', label: 'No', detail: 'Blocks this and nothing runs. The worker must find another way.' },
  ]);
});

test('the worker\'s log fills in the whole command and its reason, and the card stops saying the start is cut off', () => {
  const meta = JSON.stringify({ promptContext: { command: 'ls -la .env', description: 'Check the env file', said: 'Checking the canary setup. [image: /etc/x.png]' } });
  const c = askCard(item(CREDENTIAL, { meta }))!;
  assert.equal(c.question, 'Let it look at the details of `.env`, without opening it?');
  assert.match(c.body, /It describes this step as "Check the env file"\. It last said: "Checking the canary setup\. "/);
  assert.doesNotMatch(c.body, /\[image:/, 'a worker\'s words cannot put a picture on the card');
  assert.equal(c.command, 'ls -la .env');
  assert.equal(c.commandLabel, 'The whole command');
  assert.equal(c.options[0].detail, 'Lets this run once. It asks again next time.');
});

test('a prompt that is not about credentials shows its own full words and the whole command, never a summary', () => {
  const body = HOOK.replace('This reads or edits a credential file (Tailscale key, Firebase service account, FB passwords).', 'This touches production data.').replace('Approve for a specific need (e.g. creating a client key) and make sure the command captures the', 'Approve only with a ticket number and make sure the').replace('value into a variable rather than printing it.', 'owner agrees.');
  const c = askCard(item(body))!;
  assert.equal(c.question, 'This touches production data. Do you want to proceed?');
  assert.match(c.body, /This touches production data\. Approve only with a ticket number and make sure the owner agrees\./);
  assert.match(c.command!, /^… .*\.claude\/skills/s);
  assert.ok(c.command!.length > 170, 'not the trimmed command');
});

test('the auto mode prompt shows what the tool does and what each answer does', () => {
  const c = askCard(item(AUTO))!;
  assert.equal(c.commandLabel, 'Tool');
  assert.match(c.body, /Marketplace Account Create Tool: Crée un compte/);
  assert.match(c.options[1].detail!, /stops asking/);
  assert.match(c.options[2].detail!, /Blocks this/);
});

test('a question at a menu is no permission prompt: Yes and No keep to the menu\'s own words', () => {
  const c = askCard(item('Worker term_1 is stopped at a prompt for task "T" (task_1).\nLast output:\nShip it today?\n❯ 1. Yes\n  2. No\n'))!;
  assert.deepEqual(c.options, [{ value: '1', label: 'Yes' }, { value: '2', label: 'No' }]);
});

test('a prompt Jarvis could not read shows the raw output, not a vague line', () => {
  const c = askCard(item('Worker term_1 is stopped at a prompt for task "T" (task_1).\nLast output:\nsomething odd here\n'))!;
  assert.equal(c.command, 'something odd here');
  assert.equal(c.commandLabel, 'Last output');
});

const logged = (messages: any[]) => async (args: string[]) => {
  assert.deepEqual(args.slice(0, 2), ['orchestration', 'worker-read']);
  return { ok: true, result: { transcript: { messages } } } as any;
};
const call = (command: string, description?: string) => ({ role: 'assistant', blocks: [{ type: 'tool-call', name: 'Bash', input: { command, description } }] });

test('the log lookup takes the call the prompt shows, with its description and the worker\'s last words', async () => {
  const { prompt } = readStopNotice(CREDENTIAL)!;
  const whole = `cat > a.js <<'EOF'\nvoid 0\n${prompt!.full}`;
  const ctx = await readPromptContext(logged([
    call('ls', 'an older call'),
    { role: 'assistant', blocks: [{ type: 'text', text: 'Checking the canary.' }] },
    call(whole, 'Check the canary'),
    { role: 'tool', blocks: [{ type: 'tool-result', output: 'x' }] },
  ]), 'd', prompt!);
  assert.deepEqual(ctx, { command: whole, description: 'Check the canary', said: 'Checking the canary.' });
});

test('the log lookup borrows nothing from another call, and a clipped log entry does not replace the command', async () => {
  const { prompt } = readStopNotice(CREDENTIAL)!;
  assert.deepEqual(await readPromptContext(logged([call('rm -rf /', 'something else')]), 'd', prompt!), {}, 'no matching call');
  assert.equal(await readPromptContext(async () => ({ ok: false, error: { code: 'x' } }) as any, 'd', prompt!), undefined, 'no answer: try again');
  const said = await readPromptContext(logged([{ role: 'user', blocks: [{ type: 'text', text: 'not the worker' }] }, call(prompt!.full!)]), 'd', prompt!);
  assert.equal(said!.said, undefined, 'a person\'s message is not the worker\'s reason');
});

test('context is looked up once for a prompt notice, kept with its other meta, and left alone for anything else', async () => {
  let reads = 0;
  const orca = async () => { reads++; return { ok: true, result: { transcript: { messages: [] } } } as any; };
  const saved: Record<string, string> = {};
  const open = [item(CREDENTIAL, { meta: '{"outcome":"x"}' }), item(STOPPED, { external_id: 'msg_stop_b' }), item(CREDENTIAL, { external_id: 'q_1', kind: 'question' })];
  assert.deepEqual(await fillPromptContexts(open, orca, (id, m) => { saved[id] = m; }), ['msg_stop_a']);
  assert.deepEqual(JSON.parse(saved.msg_stop_a), { outcome: 'x', promptContext: {} });
  assert.deepEqual(storedContext(saved.msg_stop_a), {});
  assert.equal(reads, 1);
  assert.deepEqual(await fillPromptContexts([item(CREDENTIAL, { meta: saved.msg_stop_a })], orca, () => assert.fail('stored already')), []);
  assert.equal(reads, 1);
  assert.deepEqual(await fillPromptContexts([item(CREDENTIAL)], async () => ({ ok: false }) as any, () => assert.fail('nothing to store')), [], 'no answer: nothing stored, so the next poll tries again');
});

test('a tap on a card with the worker\'s context still types only the digit', async () => {
  const t = tap([screen(frame(CREDENTIAL)), screen(['⏺ Running it', '❯'])]);
  t.store.db.prepare(`INSERT INTO items (source, external_id, kind, dispatch_id, subject, body, meta, status) VALUES ('orca', 'msg_stop_a', 'escalation', 'ctx_000000000003', 'Worker is waiting on a prompt', ?, ?, 'spoken')`).run(CREDENTIAL, JSON.stringify({ promptContext: { command: 'ls .env' } }));
  assert.deepEqual(await t.go('1'), { status: 200 });
  assert.equal(t.typed[0].args.key, '1');
  assert.equal(t.store.item('msg_stop_a')!.answer, '1');
});

test('prompt detection: only a menu with a cursor counts', () => {
  assert.equal(readPrompt('Steps:\n1. Read the code\n2. Fix it\n❯ '), undefined, 'a numbered list in the transcript is not a prompt');
  assert.equal(readPrompt('Do it?\n❯ 1. Yes'), undefined, 'one option is not a menu');
  assert.equal(readPrompt('Pick some?\n❯ 1. [ ] Alpha\n  2. [x] Beta'), undefined, 'a number toggles a multi-select, so a button would not answer it');
  const moved = readPrompt('Do you want to proceed?\n  1. Yes\n❯ 2. No\n Esc to cancel')!;
  assert.deepEqual(moved.options.map(o => o.key), ['1', '2'], 'the cursor may have moved down');
  const asked = readPrompt('Which layout should it use?\n❯ 1. Left\n     Matches the old page\n  2. Right\n     Wider\n Enter to select · Esc to cancel')!;
  assert.equal(asked.summary, 'Which layout should it use?');
  assert.deepEqual(asked.options.map(o => [o.label, o.detail]), [['Left', 'Matches the old page'], ['Right', 'Wider']]);
  const bash = readPrompt('Bash command\n\n  rm -rf build\n  Remove the build folder\n\n Do you want to proceed?\n ❯ 1. Yes\n   2. No')!;
  assert.equal(bash.command, 'rm -rf build');
  assert.equal(bash.summary, 'Remove the build folder. Do you want to proceed?');
});

// A plain Bash prompt as Claude Code 2.1 draws it, read from a live terminal: words, then the command framed by rules.
const LIVE_BASH = `\u276f Use the Bash tool once to run exactly: touch /private/tmp/scratch/key-test-marker . Then say done.
─────────────────────────────────────────────────────────────────────
 Bash command
 Tip: auto mode handles these prompts for you — choose "switch to auto mode" below
 Create the key-test marker file in the scratchpad
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
 │ touch /private/tmp/claude-501/-Users-owner-orca-workspaces-jarvis-rainbowfish/c51d2584-a4fb-
 │ 4d29-9e84-9ac208029b86/scratchpad/key-test-marker
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
 Do you want to proceed?
 \u276f 1. Yes
   2. Yes, and always allow access to /private/tmp/claude-501/-Users-owner-orca-workspaces-jarvi
      s-rainbowfish/00000000-0000-4000-8000-000000000004/scratchpad from this project
   3. Yes, and switch to auto mode · auto mode handles these prompts for you
   4. No
 Esc to cancel · Tab to amend
`;

test('the plain Bash prompt: the framed command, the line that says what it does, wrapped labels joined', () => {
  const p = readPrompt(LIVE_BASH)!;
  assert.equal(p.summary, 'Create the key-test marker file in the scratchpad. Do you want to proceed?');
  assert.match(p.command!, /^touch \/private\/tmp.*key-test-marker$/);
  assert.ok(p.command!.length <= 170);
  assert.deepEqual(p.options.map(o => o.key), ['1', '2', '3', '4']);
  assert.ok(p.options[1].label.length <= 90 && p.options[1].label.endsWith('…') && !p.options[1].detail, p.options[1].label);
  assert.deepEqual([p.options[2].label, p.options[2].detail], ['Yes, and switch to auto mode', 'auto mode handles these prompts for you']);
  assert.equal(stillAt(p, LIVE_BASH), true);
  assert.equal(stillAt(p, LIVE_BASH.replace('key-test-marker\n', 'other-file\n')), false);
});

test('stillAt: the same prompt on screen, not a look-alike and not its leftovers', () => {
  const { prompt } = readStopNotice(HOOK)!;
  assert.equal(stillAt(prompt!, frame(HOOK)), true);
  assert.equal(stillAt(prompt!, frame(HOOK).map(l => l.replace('.env', '.envrc'))), false, 'another command with the same Yes and No');
  assert.equal(stillAt(prompt!, frame(HOOK).filter(l => !/\d\. (Yes|No)/.test(l)).concat('❯')), false, 'answered: the words remain in the scrollback, the menu is gone');
  assert.equal(stillAt(prompt!, frame(HOOK).map(l => l.replace('No', 'Never'))), false, 'other options');
  const narrow = frame(HOOK).flatMap(l => l.includes('Tailscale') ? ['│ This reads or edits a credential file', '│ (Tailscale key, Firebase service account, FB passwords).'] : [l]);
  assert.equal(stillAt(prompt!, narrow), true, 'a resized terminal wraps the same words differently');
});

test('a repeat of the same prompt collapses; a new prompt from the same worker gets its own card', () => {
  const ref = (id: string, body: string) => ({ external_id: `msg_stop_${id}`, kind: 'escalation', dispatch_id: 'd', body });
  const other = HOOK.replace('.env', '.envrc');
  assert.notEqual(promptKey(HOOK), promptKey(other));
  assert.deepEqual(duplicateStopNotices([ref('a', HOOK), ref('b', HOOK), ref('c', other), ref('d', STOPPED), ref('e', STOPPED)]), ['msg_stop_b', 'msg_stop_e']);
});

test('the card closes once the worker has left the prompt, and only on proof', async () => {
  const open = [item(HOOK)];
  const gone = (answer: any) => gonePromptNotices(open, async () => answer);
  assert.deepEqual(await gone(screen(frame(HOOK))), [], 'still there');
  assert.deepEqual(await gone(screen(['⏺ Working on it', '❯'])), ['msg_stop_a'], 'answered from Orca: the worker moved on');
  assert.deepEqual(await gone(screen(frame(HOOK).map(l => l.replace('.env', '.envrc')))), ['msg_stop_a'], 'now at a different prompt');
  assert.deepEqual(await gone(screen([], 'exited')), ['msg_stop_a'], 'the terminal ended');
  assert.deepEqual(await gone({ ok: false, error: { code: 'terminal_unsupported_for_agent_session' } }), [], 'Orca cannot show it, so nothing is proven');
  assert.deepEqual(await gone({ ok: true, result: { terminal: { status: 'running', tail: ['x'], source: 'screen-unavailable' } } }), [], 'no rendered screen');
  assert.deepEqual(await gonePromptNotices([item(STOPPED)], async () => screen(['x'])), [], 'no prompt to leave');
  assert.deepEqual(await gonePromptNotices([item(HOOK, { status: 'replying' })], async () => screen(['x'])), [], 'a tap is going out');
});

function tap(reads: any[], send: any = { ok: true, result: { send: { accepted: true } } }) {
  const store = openStore(':memory:');
  const calls: string[][] = [], notes: string[] = [];
  const orca = async (args: string[]) => { calls.push(args); return args[1] === 'read' ? reads.shift() : send; };
  const typed: { args: any }[] = [];
  const gate = { pressed: async (action: string, args: any) => { typed.push({ args }); assert.equal(action, 'prompt-key'); return { status: send.ok ? 'done' : 'failed', result: send.error?.message ?? '' } as any; } };
  const go = (value: string) => answerAsk({ id: 'msg_stop_a', value, run: 'run_j', handle: 'term_j', store, orca, gate, wait: async () => {}, log: () => {}, note: n => notes.push(n) });
  return { store, calls, typed, notes, go };
}
const seed = (s: ReturnType<typeof tap>['store']) => s.db.prepare(`INSERT INTO items (source, external_id, kind, dispatch_id, subject, body, status) VALUES ('orca', 'msg_stop_a', 'escalation', 'ctx_000000000002', 'Worker is waiting on a prompt', ?, 'spoken')`).run(HOOK);

test('a tap checks the prompt is still up, types that key, sees the prompt go, and marks the card answered', async () => {
  const t = tap([screen(frame(HOOK)), screen(['⏺ Running it', '❯'])]);
  seed(t.store);
  assert.deepEqual(await t.go('2'), { status: 200 });
  assert.deepEqual(t.typed.map(x => x.args), [{ terminal: TERMINAL, key: '2' }]);
  assert.equal(t.store.item('msg_stop_a')!.status, 'answered');
  assert.equal(t.store.item('msg_stop_a')!.answer, '2');
  assert.match(t.notes[0], /"No"/);
  assert.equal(askCard(t.store.item('msg_stop_a')!)!.status, 'answered');
  assert.ok(t.calls.every(c => c[1] === 'read'), 'the key goes only through the gate');
});

test('a tap on a prompt that is gone types nothing and closes the card', async () => {
  const t = tap([screen(frame(HOOK).map(l => l.replace('.env', '.envrc')))]);
  seed(t.store);
  const r = await t.go('1');
  assert.equal(r.status, 409);
  assert.match(r.error!, /no longer at that prompt/);
  assert.deepEqual(t.typed, []);
  assert.equal(t.store.item('msg_stop_a')!.status, 'done');
});

test('a tap types nothing when Orca cannot show the screen, and the card stays open', async () => {
  const t = tap([{ ok: false, error: { code: 'terminal_unsupported_for_agent_session', message: 'chat tab' } }]);
  seed(t.store);
  const r = await t.go('1');
  assert.equal(r.status, 502);
  assert.match(r.error!, /Nothing was typed/);
  assert.deepEqual(t.typed, []);
  assert.equal(t.store.item('msg_stop_a')!.status, 'spoken');
});

test('the prompt still showing after the key is reported, not called answered; a refused key reopens the card', async () => {
  const stuck = tap([screen(frame(HOOK)), screen(frame(HOOK))]);
  seed(stuck.store);
  const r = await stuck.go('1');
  assert.equal(r.status, 502);
  assert.match(r.error!, /still showing/);
  assert.equal(stuck.store.item('msg_stop_a')!.status, 'spoken');

  const refused = tap([screen(frame(HOOK))], { ok: false, error: { message: 'no such terminal' } });
  seed(refused.store);
  assert.equal((await refused.go('1')).status, 502);
  assert.equal(refused.store.item('msg_stop_a')!.status, 'spoken');
});

test('a second tap while one is going out types nothing; words that are no option still go as a message', async () => {
  const t = tap([]);
  seed(t.store);
  t.store.claimReply('msg_stop_a');
  assert.equal((await t.go('1')).status, 409);
  assert.deepEqual(t.typed, []);

  const words = tap([]);
  seed(words.store);
  assert.deepEqual(await words.go('please wait for me'), { status: 200 });
  assert.deepEqual(words.typed, []);
  assert.deepEqual(words.calls[0].slice(0, 2), ['orchestration', 'send']);
});

test('the gate types one digit with no Enter, into a real handle, and the brain cannot propose it', async () => {
  const store = openStore(':memory:');
  const gate = makeGate(store, { run: 'run_j', handle: 'term_j' }, () => {});
  await assert.rejects(gate.propose('prompt-key', { terminal: TERMINAL, key: '1' }, 'x'), /only from the owner's button/);
  await assert.rejects(gate.pressed('prompt-key', { terminal: TERMINAL, key: '1\n' }, 'x'), /digit/);
  await assert.rejects(gate.pressed('prompt-key', { terminal: '--help', key: '1' }, 'x'), /not an Orca terminal handle/);
  await assert.rejects(gate.pressed('prompt-key', { terminal: 'term_j', key: '1' }, 'x'), /own terminal/);
});
