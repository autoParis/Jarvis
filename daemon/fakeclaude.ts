import { readFileSync } from 'node:fs';

// The help texts of a real Claude Code (2.1.316, saved 2026-11-09), for the fake `claude` CLIs in the tests: native.ts
// checks them before the first start (missingFeatures).
export const CLAUDE_HELP = readFileSync(new URL('./fixtures/claude-help.txt', import.meta.url), 'utf8');
export const AGENTS_HELP = readFileSync(new URL('./fixtures/claude-agents-help.txt', import.meta.url), 'utf8');

/** A fake `claude`'s answer to `--help` or `agents --help`, else undefined. Call it first, before the fake's own cases. */
export function helpRun(args: string[]): { code: number; out: string; err: string } | undefined {
  if (args[args.length - 1] !== '--help') return undefined;
  return { code: 0, out: args[0] === 'agents' ? AGENTS_HELP : CLAUDE_HELP, err: '' };
}
