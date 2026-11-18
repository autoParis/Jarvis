import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { bashHooks, gitSelfCheck, gitNotice, throughHooks } from './gitcheck.ts';

/** A repo with one commit, and a folder for hook scripts. */
function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-gitcheck-'));
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' });
  git('init', '-q', '-b', 'master');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.test');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'a.txt'), 'a\n');
  git('add', 'a.txt');
  git('commit', '-q', '-m', 'first');
  return { dir, git };
}

function hook(name: string, body: string) {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-hook-'));
  const file = join(dir, name);
  writeFileSync(file, `#!/bin/bash\ninput=$(cat)\n${body}\n`);
  chmodSync(file, 0o755);
  return { command: file, from: 'test' };
}

// Like the rtk hook before its fix: every git command becomes rtk git.
const RTK = `cmd=$(echo "$input" | jq -r .tool_input.command); jq -n --arg c "rtk $cmd" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"allow",updatedInput:{command:$c}}}'`;

test('hooks that leave git alone let the commit through, and the scratch worktree is gone after', async () => {
  const { dir, git } = repo();
  const r = await gitSelfCheck(dir, { hooks: [hook('pass.sh', 'exit 0')] });
  assert.deepEqual(r, { ok: true });
  assert.equal(readdirSync(join(dir, '.claude', 'worktrees')).length, 0);
  assert.equal(String(git('worktree', 'list')).trim().split('\n').length, 1);
  // Detached: no branch left behind for the ten-minute check to find.
  assert.equal(String(git('branch', '--list')).trim(), '* master');
});

test('a hook that turns git into rtk git fails the check and is named in the notice', async () => {
  const { dir } = repo();
  const rtk = hook('rtk-rewrite.sh', RTK);
  const r = await gitSelfCheck(dir, { hooks: [rtk] });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.hook, rtk.command);
  assert.match(gitNotice(r), /rtk-rewrite\.sh stops it: it changed `git add jarvis-selfcheck\.txt` to `rtk git add/);
  assert.equal(existsSync(join(dir, '.claude', 'worktrees', `jarvis-selfcheck-${process.pid}`)), false);
});

test('a hook that blocks with exit 2 or a deny fails the check with its reason', async () => {
  const exit2 = await throughHooks([hook('block.sh', 'echo "no git here" >&2; exit 2')], 'git add x', tmpdir());
  assert.deepEqual(exit2.ok ? '' : exit2.why, 'it blocked `git add x`: no git here');
  const deny = await throughHooks([hook('deny.sh', `echo '{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"protected"}}'`)], 'git add x', tmpdir());
  assert.match(deny.ok ? '' : deny.why, /blocked .*protected/);
});

test('the hooks are read from the Bash matchers of each settings file, in order', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-settings-'));
  const user = join(dir, 'user.json'), local = join(dir, 'local.json');
  writeFileSync(user, JSON.stringify({ hooks: { PreToolUse: [
    { matcher: 'Bash', hooks: [{ type: 'command', command: 'one' }, { type: 'command', command: 'two' }] },
    { matcher: 'Edit|Write', hooks: [{ type: 'command', command: 'edit-only' }] },
    { matcher: '*', hooks: [{ type: 'command', command: 'all' }] },
  ] } }));
  writeFileSync(local, JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'three' }] }] } }));
  assert.deepEqual(bashHooks([user, join(dir, 'missing.json'), local]).map(h => h.command), ['one', 'two', 'all', 'three']);
});
