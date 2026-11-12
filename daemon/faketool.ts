import { mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// A stand-in for a CLI on PATH in tests: records each call and prints whatever `answer()` last set.
// `answers()` queues one line per call, used up before the `answer()` text.
// Call before importing config.ts or gate.ts, which copy the environment when they load.

/**
 * A queued line starting EXIT1: goes to stderr with exit code 1. A tool that needs its
 * folder (`node`) records it ahead of its arguments.
 */
export function fakeTool(name: string) {
  const dir = mkdtempSync(join(tmpdir(), `jarvis-${name}-`));
  const calls = join(dir, 'calls'), out = join(dir, 'out'), queue = join(dir, 'queue');
  const record = name === 'node' ? 'echo "$(pwd -P) $*"' : 'echo "$*"';
  writeFileSync(join(dir, name), `#!/bin/bash\n${record} >> "${calls}"\nif [ -s "${queue}" ]; then line=$(head -n 1 "${queue}"); tail -n +2 "${queue}" > "${queue}.next"; mv "${queue}.next" "${queue}"; if [[ "$line" == EXIT1:* ]]; then echo "\${line#EXIT1:}" >&2; exit 1; fi; echo "$line"; else cat "${out}"; fi\n`);
  chmodSync(join(dir, name), 0o755);
  writeFileSync(out, '');
  process.env.PATH = `${dir}:${process.env.PATH}`;
  return {
    answer: (stdout: string) => writeFileSync(out, stdout),
    answers: (...lines: string[]) => writeFileSync(queue, lines.map(l => `${l}\n`).join('')),
    calls: (): string[] => existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : [],
  };
}
