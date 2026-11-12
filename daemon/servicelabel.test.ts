// The launchd label comes from one setting, read in daemon/config.ts, and bin/jarvis-restart and bin/install-service use it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
/** SERVICE_LABEL and LAUNCHD_PREFIXES as a fresh Node reads them with this environment. */
function read(env: Record<string, string>): { label: string; prefixes: string[] } {
  const out = execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e',
    "import { SERVICE_LABEL, LAUNCHD_PREFIXES } from './daemon/config.ts'; console.log(JSON.stringify({ label: SERVICE_LABEL, prefixes: LAUNCHD_PREFIXES }));"],
    { cwd: root, env: { PATH: process.env.PATH ?? '', ...env } }).toString();
  return JSON.parse(out);
}

test('the label defaults to local.jarvis, takes JARVIS_SERVICE_LABEL, and refuses a value that is not a label', () => {
  assert.deepEqual(read({}), { label: 'local.jarvis', prefixes: ['local.'] });
  assert.deepEqual(read({ JARVIS_SERVICE_LABEL: 'io.example.jarvis' }), { label: 'io.example.jarvis', prefixes: ['io.example.'] });
  assert.deepEqual(read({ JARVIS_SERVICE_LABEL: 'x; rm -rf /' }).label, 'local.jarvis');
  assert.deepEqual(read({ JARVIS_LAUNCHD_PREFIXES: 'io.example., com.other.' }).prefixes, ['io.example.', 'com.other.']);
});

test('bin/jarvis-restart prints the configured label, and bin/install-service installs the job under it', () => {
  const label = execFileSync(`${root}bin/jarvis-restart`, ['--label'], { cwd: '/', env: { PATH: process.env.PATH ?? '', JARVIS_SERVICE_LABEL: 'io.example.jarvis' } }).toString().trim();
  assert.equal(label, 'io.example.jarvis');
  const install = readFileSync(`${root}bin/install-service`, 'utf8');
  assert.match(install, /LABEL="\$\("\$ROOT\/bin\/jarvis-restart" --label\)"/);
  assert.match(install, /^agent "\$LABEL" /m);
  assert.doesNotMatch(install, /agent local\.jarvis/);
});

test('the vault restarts jarvisd with bin/jarvis-restart, not a hand-written label', () => {
  const card = readFileSync(`${root}vault/projects/jarvis.md`, 'utf8');
  assert.match(card, /bin\/jarvis-restart/);
  assert.doesNotMatch(card, /launchctl kickstart/);
});
