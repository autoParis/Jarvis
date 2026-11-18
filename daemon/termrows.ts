import type { WorkRow, WorkStatus } from './work.ts';
import { SHELLS, type TermInfo } from './terminal.ts';
import { PRODUCT_KEY, PRODUCT_LABEL } from './config.ts';

const LABELS: Record<string, string> = { jarvis: 'Jarvis', [PRODUCT_KEY]: PRODUCT_LABEL, fbm: 'FBM' };
export const projectName = (p: string) => LABELS[p] ?? (p.charAt(0).toUpperCase() + p.slice(1));

/** A terminal's status: blocked when a screen read found a prompt, idle at a shell prompt, working while a program runs. */
export const terminalStatus = (t: Pick<TermInfo, 'command' | 'block'>): WorkStatus =>
  t.block ? { name: 'blocked', reason: t.block } : !t.command || SHELLS.test(t.command) ? { name: 'idle' } : { name: 'working' };

/** Work-list rows for the project terminals: "Terminal in AcmeApp", in the Terminals group, opened with `t:<name>`. */
export function terminalRows(list: TermInfo[]): WorkRow[] {
  return list.map(t => ({
    id: `t:${t.name}`, kind: 'session', title: `${t.kind === 'codex' ? 'Codex' : 'Terminal'} in ${projectName(t.project)}`,
    group: 'terminal', state: t.block ? 'waiting' : 'idle', status: terminalStatus(t), note: t.name, steer: 'none',
    tmux: { name: t.name, project: t.project, kind: t.kind, cwd: t.cwd, branch: t.branch },
  }));
}
