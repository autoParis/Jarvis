// The new-session picker the header's plus opens (option A of docs/screens/artifacts/new-session-picker-v2-01-a-two-rows-one-start.png):
// a kind row, a project row, a Worktree switch and Start. It opens on the last choice, and Cmd+Return starts it.
// Claude starts a side chat; Codex and Terminal open a tmux session in the center (web/terminal.js).

// Codex has no background mode Jarvis can drive the way it drives Claude (hooks, `claude agents`, replies), so a Codex
// session is a project terminal that runs `codex` (daemon/terminal.ts). Both open in the center and need Touch ID on the Mac.
export const KINDS = [
  { id: 'claude', label: 'Claude', wired: true },
  { id: 'codex', label: 'Codex', wired: true },
  { id: 'terminal', label: 'Terminal', wired: true },
];
const LABELS = { jarvis: 'Jarvis', acmeapp: 'AcmeApp', fbm: 'FBM' };
const ORDER = ['jarvis', 'acmeapp', 'fbm'];
/** Projects in the order the owner reads them: Jarvis, AcmeApp, FBM, then any other card by name. */
export const orderRepos = repos => [...repos].sort((a, b) => ((ORDER.indexOf(a.name) + 1) || 99) - ((ORDER.indexOf(b.name) + 1) || 99) || a.name.localeCompare(b.name));
export const projectLabel = name => LABELS[name] ?? name.charAt(0).toUpperCase() + name.slice(1);

const kindOf = id => KINDS.find(k => k.id === id);

/** The saved choice, checked against what exists now. A missing or stale value falls back to the first option. */
export function restore(saved, repos) {
  let s = {};
  try { s = JSON.parse(saved || '{}') || {}; } catch { s = {}; }
  return {
    kind: kindOf(s.kind) ? s.kind : KINDS[0].id,
    repo: repos.some(r => r.path === s.repo) ? s.repo : repos[0]?.path ?? '',
    worktree: s.worktree === true,
  };
}

/** What the controls show for a choice: the switch goes away for a terminal, and an unwired kind cannot start. */
export function view(choice) {
  const k = kindOf(choice.kind) ?? KINDS[0];
  return { showWorktree: k.id !== 'terminal', canStart: k.wired && !!choice.repo, why: k.wired ? '' : k.why ?? '' };
}

/** The side chat route's body for a Claude choice. The first message is typed in the conversation once it opens. */
export const startBody = choice => ({ repo: choice.repo, ...(choice.worktree ? { worktree: true } : {}) });

/** The terminal route's body for a Codex or Terminal choice. Only Codex takes the Worktree switch. */
export const termStart = choice => ({ repo: choice.repo, kind: choice.kind === 'codex' ? 'codex' : 'terminal', ...(choice.kind === 'codex' && choice.worktree ? { worktree: true } : {}) });

/** The new row's id from the route's reply (the gate's result JSON), so the page can open its conversation. */
export function startedRow(reply) {
  try { const r = JSON.parse(reply?.result ?? ''); return typeof r.worker === 'string' ? r.worker : typeof r.dispatchId === 'string' ? r.dispatchId : null; }
  catch { return null; }
}

/** One segmented row: radio buttons with a roving tab stop, the picked one carrying the sliding mark's index. */
export function segHtml(options, picked, esc) {
  return options.map(o => {
    const on = o.value === picked;
    return `<button type="button" role="radio" aria-checked="${on}" tabindex="${on ? 0 : -1}" data-v="${esc(o.value)}">${esc(o.label)}</button>`;
  }).join('');
}

/** Next radio for an arrow key, wrapping. */
export function stepRadio(values, current, key) {
  const i = values.indexOf(current);
  const d = key === 'ArrowRight' || key === 'ArrowDown' ? 1 : key === 'ArrowLeft' || key === 'ArrowUp' ? -1 : 0;
  if (!d) return key === 'Home' ? values[0] : key === 'End' ? values[values.length - 1] : null;
  return values[(i + d + values.length) % values.length];
}
