import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACTIONS, actionsWith, EVENTS, APPROVAL_STATUSES, REQUEST_STATUSES } from '../web/contract.js';
import { buildCommand, BUTTON_ONLY, WORKER_PERMISSION } from './gate.ts';
import { NAMED_ACTIONS } from './namedactions.ts';
import { PROD_MCP_CALL } from './prodmcp.ts';
import { STATIC } from './webfiles.ts';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const files = (dir: string, ext: string) => readdirSync(join(ROOT, dir)).filter(f => f.endsWith(ext) && !f.endsWith(`.test${ext}`)).map(f => `${dir}/${f}`);

test('the gate knows every action of the catalog, and refuses a name outside it', () => {
  for (const action of Object.keys(ACTIONS)) {
    let error = '';
    try { buildCommand(action, {}); } catch (e) { error = String(e); }
    assert.doesNotMatch(error, /unknown action/, `${action} has a case in buildCommand`);
  }
  assert.throws(() => buildCommand('worker-delete', {}), /unknown action worker-delete/);
  for (const a of [...NAMED_ACTIONS, PROD_MCP_CALL, WORKER_PERMISSION]) assert.ok(BUTTON_ONLY.has(a), `${a} runs only on Approve`);
  for (const a of Object.keys(ACTIONS)) assert.ok(!(actionsWith('pressed').has(a) && actionsWith('buttonOnly').has(a)), `${a} is a button or needs Approve, not both`);
});

test('every live-update event the page reads is in the catalog, and jarvisd sends each one', () => {
  const page = [...files('web', '.js'), 'web/index.html'].map(read).join('\n');
  const read_ = new Set([...page.matchAll(/\be\.type === '([a-z-]+)'/g)].map(m => m[1]));
  for (const t of read_) assert.ok(EVENTS.includes(t), `the page reads a '${t}' event that the catalog does not name`);
  const daemon = files('daemon', '.ts').map(read).join('\n');
  for (const t of EVENTS) {
    assert.ok(read_.has(t), `the page handles '${t}'`);
    assert.match(daemon, new RegExp(`type: '${t}'`), `jarvisd sends '${t}'`);
  }
});

test('the statuses the work list and the Requests sidebar compare against are in the catalog', () => {
  for (const m of read('web/worklist.js').matchAll(/\ba\.status === '([a-z]+)'/g)) assert.ok(APPROVAL_STATUSES.includes(m[1]), m[1]);
  const type = /export type RequestStatus = ([^;]+);/.exec(read('daemon/requests.ts'))![1];
  assert.deepEqual([...type.matchAll(/'([a-z]+)'/g)].map(m => m[1]), REQUEST_STATUSES);
});

test('jarvisd serves every page module', () => {
  for (const f of files('web', '.js')) {
    const name = f.slice('web/'.length);
    assert.equal(STATIC[`/${name}`], name, `${name} is in webfiles.ts STATIC`);
  }
});

/** Every `jarvis-<cli> ...` inside inline code in the vault prompts, with the file it came from. */
function vaultCommands(): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      if (e.isDirectory()) walk(`${dir}/${e.name}`);
      else if (e.name.endsWith('.md')) for (const m of read(`${dir}/${e.name}`).matchAll(/`([^`\n]*\bjarvis-[a-z]+\b[^`\n]*)`/g)) out.push({ file: `${dir}/${e.name}`, text: m[1] });
    }
  };
  walk('vault');
  return out;
}

test('every jarvis-* command, verb and flag the vault tells the brain to run exists in bin/', () => {
  const cmds = vaultCommands();
  assert.ok(cmds.length > 20, 'the vault names its commands in inline code');
  for (const { file, text } of cmds) {
    for (const m of text.matchAll(/(?<!Repos\/)\bjarvis-([a-z]+)((?:\s+[^\s]+)*)/g)) {
      const bin = `bin/jarvis-${m[1]}`;
      assert.ok(existsSync(join(ROOT, bin)), `${file}: ${bin} exists (${text})`);
      const src = read(bin);
      const words = m[2].trim().split(/\s+/).filter(Boolean);
      const verb = words[0];
      if (verb && /^[a-z][a-z-]*$/.test(verb)) assert.match(src, new RegExp(`['"]${verb}['"]|\\b${verb}\\)|\\b${verb}\\|`), `${file}: ${bin} has the verb ${verb} (${text})`);
      for (const f of m[2].matchAll(/--([a-z][a-z-]*)/g)) assert.ok(src.includes(`'${f[1]}'`) || src.includes(`--${f[1]}`), `${file}: ${bin} takes --${f[1]} (${text})`);
      const action = /--action\s+([a-z][a-z-]*)/.exec(m[2]);
      if (action) assert.ok(action[1] in ACTIONS, `${file}: --action ${action[1]} is a gate action (${text})`);
    }
  }
});
